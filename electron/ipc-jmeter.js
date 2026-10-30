'use strict';

/**
 * JMeter 非 GUI 运行的 IPC 层。
 *
 * 关键点（都是踩过才知道的）：
 * 1. Windows 上 .bat 不能直接 spawn（EINVAL），必须走 `cmd.exe /c`；
 * 2. 停任务要杀**进程树**（taskkill /T /F），否则 java 子进程会留着继续吃 CPU；
 * 3. 报告模式 `-o` 要求目录为空或不存在，所以每次都给一个带时间戳的新目录；
 * 4. 输出必须流式转发（按行 + 缓冲上限），否则日志刷爆渲染层。
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ipcMain, dialog, shell, app } = require('electron');
const {
  pickPaths, buildJmeterArgs,
  validateJmxPath, validateOutDir, validateJmeterPath,
  parseSummary, parseJtl,
  decodeOutputLine, validateJavaHome,
} = require('./jmeter-args');

const IS_WIN = process.platform === 'win32';
/** 单次运行最多缓存多少行日志（界面只显示最近这些，完整日志已落盘） */
const MAX_LOG_LINES = 4000;

/** 当前正在跑的任务（同一时间只允许一个） */
let current = null;

function runCmd(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout || '').trim());
    });
  });
}

/** 从 PATH 里找 jmeter（`where jmeter.bat` / `which jmeter`） */
async function detectFromPath() {
  if (IS_WIN) {
    const out = await runCmd('where', ['jmeter.bat']);
    const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
    return '';
  }
  const out = await runCmd('which', ['jmeter']);
  const first = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return first && fs.existsSync(first) ? first : '';
}

/** 扫常见安装位置（apache-jmeter-* 的版本号不固定，所以只扫父目录） */
function detectFromCommonDirs() {
  const candidates = [];
  const roots = [];
  if (IS_WIN) {
    if (process.env.ProgramFiles) roots.push(process.env.ProgramFiles);
    if (process.env['ProgramFiles(x86)']) roots.push(process.env['ProgramFiles(x86)']);
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
    roots.push('C:\\apache-jmeter', 'D:\\apache-jmeter', 'C:\\tools', 'D:\\tools');
  } else {
    roots.push('/usr/local', '/opt', '/usr/local/opt');
  }
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries) {
      if (!/^apache-jmeter/i.test(name)) continue;
      const exe = IS_WIN ? path.join(root, name, 'bin', 'jmeter.bat') : path.join(root, name, 'bin', 'jmeter');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }
  return candidates;
}

/**
 * 找一个**能真正跑起来**的 Java。
 *
 * 坑：`where java` 在装了/卸载过 Oracle JDK 的机器上会留在
 * `C:\Program Files\Common Files\Oracle\Java\javapath\java.exe`（一个转发 shim），
 * 但后面的真实 JDK 可能已被删掉 —— 只看文件存在就会误报「Java 可用」，
 * 然后 jmeter.bat 报 `Not able to find Java executable or version`。
 * 所以这里对每个候选都真的执行一次 `-version`，退出码为 0 才算可用。
 *
 * 另一个坑：用户环境的 `JAVA_HOME` 可能指向已删除的目录（比如 E:\jdk17），
 * jmeter.bat 会**优先**用它，于是即使 PATH 里有能用的 java 也会失败。
 * 所以我们要把「JAVA_HOME 是否有效」单独报出来，运行前再决定是否覆盖它。
 */
async function tryJavaHome(home, source) {
  const check = validateJavaHome(home);
  if (!check.ok) return { ok: false, home: String(home || ''), exe: '', source, error: check.error };
  const ver = await new Promise((resolve) => {
    // Windows 上直接 execFile 一个 .cmd/.bat 会抛 EINVAL，必须走 cmd /c（假 JDK 也是 .cmd）
    const isCmd = IS_WIN && /\.(cmd|bat)$/i.test(check.exe);
    const file = isCmd ? "cmd.exe" : check.exe;
    const argv = isCmd ? ["/c", check.exe, "-version"] : ["-version"];
    try {
      execFile(file, argv, { windowsHide: true, timeout: 8000 }, (err, out, stderr) => {
        resolve({ ok: !err, text: String(stderr || '') || String(out || '') });
      });
    } catch (e) {
      resolve({ ok: false, text: '', thrown: e.message });
    }
  });
  if (!ver.ok) {
    return { ok: false, home: check.home, exe: check.exe, source, error: '执行 java -version 失败（可能已卸载/损坏）' };
  }
  return { ok: true, home: check.home, exe: check.exe, source, version: ver.text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '' };
}

/** 常见 JDK 安装位置的候选目录（取父目录下第一层） */
function javaHomeCandidates() {
  const out = [];
  const roots = [];
  if (IS_WIN) {
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'Java'));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'Eclipse Adoptium'));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'Microsoft'));
    if (process.env.ProgramFiles) roots.push(path.join(process.env.ProgramFiles, 'Zulu'));
    if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'Java'));
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'));
    roots.push('C:\\Java', 'D:\\Java', 'E:\\Java', 'D:\\', 'E:\\', 'G:\\');
  } else {
    roots.push('/usr/lib/jvm', '/Library/Java/JavaVirtualMachines', '/opt/java');
  }
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 只认名字像 JDK 的目录：否则 D:\ 下几十个目录每个都要跑一次 java -version，探测会卡住
      if (/^(jdk|jre|java|zulu|openjdk)/i.test(e.name)) out.push(path.join(root, e.name));
    }
  }
  return out.slice(0, 12);
}

/** 汇总 Java 情况：配置项 → JAVA_HOME 环境变量 → PATH → 常见目录 */
async function detectJava(settingsJavaHome) {
  const envHome = String(process.env.JAVA_HOME || '').trim();
  const tried = [];

  const ordered = [];
  if (settingsJavaHome) ordered.push([settingsJavaHome, 'settings']);
  if (envHome) ordered.push([envHome, 'env']);
  for (const h of javaHomeCandidates()) ordered.push([h, 'scan']);

  for (const [home, source] of ordered) {
    const r = await tryJavaHome(home, source);
    tried.push(r);
    if (r.ok) {
      return {
        ok: true, home: r.home, exe: r.exe, version: r.version || '', source,
        envHome, envHomeOk: envHome ? tried.some(t => t.source === 'env' && t.ok) : false,
        candidates: tried.filter(t => !t.ok).map(t => ({ home: t.home, source: t.source, error: t.error })),
      };
    }
  }

  // 最后再试 PATH 上的 java（可能是 shim，也要真的跑一次）
  const out = await runCmd(IS_WIN ? 'where' : 'which', ['java']);
  const pathExe = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
  if (pathExe && fs.existsSync(pathExe)) {
    const ok = await new Promise((resolve) => {
      execFile(pathExe, ['-version'], { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
    });
    if (ok) {
      // PATH 上的 java 也能用；但它不在某个 JDK 目录里，只能把 bin 的上一级当 home
      const home = path.dirname(path.dirname(pathExe));
      return {
        ok: true, home, exe: pathExe, version: '', source: 'path',
        envHome, envHomeOk: false,
        candidates: tried.map(t => ({ home: t.home, source: t.source, error: t.error })),
      };
    }
    tried.push({ ok: false, home: path.dirname(path.dirname(pathExe)), exe: pathExe, source: 'path', error: 'PATH 上的 java 跑不起来（多为卸载后残留的 javapath shim）' });
  }

  return {
    ok: false, home: '', exe: '', version: '', source: '',
    envHome, envHomeOk: false,
    candidates: tried.map(t => ({ home: t.home, source: t.source, error: t.error })),
  };
}

/**
 * 读 .jmx 判断它是否支持用 -J 覆盖线程数/循环次数。
 * 脚本里必须写成 ${__P(threads,默认值)} 才会读 -Jthreads=N；写死数字的话覆盖不生效，
 * 但界面上填了值会让人以为生效了 —— 所以先在界面上说清楚。
 */
function inspectScript(jmxPath) {
  const out = { supportsThreads: false, supportsLoops: false, ok: false, error: "" };
  try {
    const st = fs.statSync(jmxPath);
    // 只读前 4MB：正常 jmx 远小于此，避免极大文件拖慢界面
    const fd = fs.openSync(jmxPath, "r");
    const len = Math.min(st.size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    out.supportsThreads = /__P\(\s*threads\b/i.test(text) || /\$\{__threads\b/i.test(text);
    out.supportsLoops = /__P\(\s*loops\b/i.test(text) || /\$\{__loops\b/i.test(text);
    out.ok = true;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** 杀掉进程树：Windows 用 taskkill /T，其他平台用进程组 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

function registerJmeterIpc({ loadSettings, saveSettings, getWindow, dataDir }) {
  const histDir = dataDir || app.getPath('userData');
  /** 探测：优先设置里的路径 → PATH → 常见目录 */
  ipcMain.handle('jmeter:detect', async () => {
    const s = loadSettings() || {};
    const configured = String(s.jmeterPath || '').trim();
    const java = await detectJava(String(s.javaHome || "").trim());

    if (configured && fs.existsSync(configured)) {
      return { success: true, data: { jmeterPath: configured, from: 'settings', java, candidates: [] } };
    }
    const fromPath = await detectFromPath();
    if (fromPath) {
      return { success: true, data: { jmeterPath: fromPath, from: 'path', java, candidates: [] } };
    }
    const candidates = detectFromCommonDirs();
    if (candidates.length) {
      return { success: true, data: { jmeterPath: candidates[0], from: 'scan', java, candidates } };
    }
    return { success: true, data: { jmeterPath: '', from: '', java, candidates: [] } };
  });

  /** 选 jmeter.bat（选完顺手存进设置） */
  ipcMain.handle('jmeter:pick-exe', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '选择 jmeter.bat（Windows）或 jmeter（macOS/Linux）',
      properties: ['openFile'],
      filters: IS_WIN ? [{ name: 'JMeter 启动脚本', extensions: ['bat', 'cmd'] }] : [],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
    const exe = r.filePaths[0];
    const check = validateJmeterPath(exe);
    if (!check.ok) return { success: false, error: check.error };
    saveSettings({ ...(loadSettings() || {}), jmeterPath: exe });
    return { success: true, data: { jmeterPath: exe } };
  });

  /** 选 JDK 目录（JAVA_HOME 那种目录，里面有 bin\\java.exe） */
  ipcMain.handle('jmeter:pick-java-home', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '选择 JDK 目录（内含 bin\\java.exe）',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
    const home = r.filePaths[0];
    const check = validateJavaHome(home);
    if (!check.ok) return { success: false, error: check.error };
    const probe = await detectJava(home);
    if (!probe.ok) return { success: false, error: `这个目录里的 java 跑不起来：${(probe.candidates[0] || {}).error || "未知原因"}` };
    saveSettings({ ...(loadSettings() || {}), javaHome: home });
    return { success: true, data: { javaHome: home, version: probe.version || "" } };
  });

  /** 预检脚本是否支持 -J 覆盖线程/循环 */
  ipcMain.handle('jmeter:inspect-script', async (_e, jmxPath) => {
    const check = validateJmxPath(jmxPath);
    if (!check.ok) return { success: false, error: check.error };
    return { success: true, data: inspectScript(jmxPath) };
  });

  /** 选 .jmx */
  ipcMain.handle('jmeter:pick-script', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '选择 JMeter 脚本',
      properties: ['openFile'],
      filters: [{ name: 'JMeter 脚本', extensions: ['jmx'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
    const jmx = r.filePaths[0];
    const check = validateJmxPath(jmx);
    if (!check.ok) return { success: false, error: check.error };
    return { success: true, data: { jmxPath: jmx, name: path.basename(jmx) } };
  });

  /** 选输出目录 */
  ipcMain.handle('jmeter:pick-out-dir', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '选择结果输出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
    const dir = r.filePaths[0];
    const check = validateOutDir(dir);
    if (!check.ok) return { success: false, error: check.error };
    return { success: true, data: { outDir: dir } };
  });

  /** 开始运行 */
  ipcMain.handle('jmeter:run', async (_event, opts = {}) => {
    if (current) return { success: false, error: '已有一个 JMeter 任务在运行，先停止它' };

    const s = loadSettings() || {};
    const jmeterPath = String(opts.jmeterPath || s.jmeterPath || '').trim();
    const exeCheck = validateJmeterPath(jmeterPath);
    if (!exeCheck.ok) return { success: false, error: exeCheck.error };

    const jmxCheck = validateJmxPath(opts.jmxPath);
    if (!jmxCheck.ok) return { success: false, error: jmxCheck.error };

    const mode = opts.mode === 'report' ? 'report' : 'log';
    const outDir = String(opts.outDir || '').trim();
    if (mode === 'report' || outDir) {
      const outCheck = validateOutDir(outDir);
      if (!outCheck.ok) return { success: false, error: outCheck.error };
    }

    let paths;
    try {
      paths = pickPaths({ jmxPath: opts.jmxPath, outDir, mode });
    } catch (e) {
      return { success: false, error: e.message };
    }
    if (!outDir) return { success: false, error: '请选择输出目录' };

    try {
      if (mode === 'report') fs.mkdirSync(paths.reportDir, { recursive: true });
    } catch (e) {
      return { success: false, error: `无法创建报告目录：${e.message}` };
    }

    let args;
    try {
      args = buildJmeterArgs({
        jmxPath: opts.jmxPath,
        jtlPath: paths.jtlPath,
        mode,
        reportDir: paths.reportDir,
        threads: opts.threads,
        loops: opts.loops,
        extraArgs: opts.extraArgs,
      });
    } catch (e) {
      return { success: false, error: e.message };
    }

    // ---- Java 自检：jmeter.bat 找不到可用的 java 时只会吐一句英文错误，这里提前拦住 ----
    const java = await detectJava(String(opts.javaHome || s.javaHome || '').trim());
    if (!java.ok) {
      const envNote = java.envHome ? `；环境变量 JAVA_HOME=${java.envHome} 也无效（已忽略）` : '';
      return {
        success: false,
        error: `没有找到能用的 Java，JMeter 需要 JDK/JRE 才能启动${envNote}。请点「选择 JDK 目录」指定 JDK 的根目录（里面有 bin\\java.exe）。`,
        java,
      };
    }

    const runId = String(Date.now());
    const lines = [];
    // 子进程环境：把 JAVA_HOME/JRE_HOME 指向**实测可用**的那个 JDK。
    // 不这么做的话，用户环境里失效的 JAVA_HOME（如 E:\\jdk17）会盖掉正确路径。
    const childEnv = { ...process.env, JAVA_HOME: java.home, JRE_HOME: java.home };
    let child;
    try {
      // Windows 的 .bat 必须经 cmd.exe 启动，否则 spawn 直接 EINVAL
      const isScript = IS_WIN && /\.(bat|cmd)$/i.test(jmeterPath);
      child = isScript
        ? spawn('cmd.exe', ['/c', jmeterPath, ...args], { windowsHide: true, cwd: path.dirname(jmeterPath), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(jmeterPath, args, { windowsHide: true, cwd: path.dirname(jmeterPath), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return { success: false, error: `启动 JMeter 失败：${e.message}` };
    }

    const win = getWindow();
    const pushLine = (stream, line) => {
      if (lines.length >= MAX_LOG_LINES) lines.shift();
      lines.push(line);
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('jmeter:output', { runId, stream, line }); } catch { /* 窗口已关 */ }
      }
    };

    const wire = (stream, readable) => {
      if (!readable) return;
      // 不 setEncoding：先按字节切行，再决定用 UTF-8 还是 GBK 解（中文 Windows 上是 GBK）
      let buf = Buffer.alloc(0);
      readable.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let nl;
        while ((nl = buf.indexOf(0x0a)) >= 0) {
          const line = decodeOutputLine(buf.subarray(0, nl));
          buf = buf.subarray(nl + 1);
          if (line.trim()) pushLine(stream, line);
        }
      });
      readable.on('end', () => { const rest = decodeOutputLine(buf); if (rest.trim()) pushLine(stream, rest); });
    };
    wire('out', child.stdout);
    wire('err', child.stderr);

    current = { runId, child, jtlPath: paths.jtlPath, reportDir: paths.reportDir };

    // 覆盖参数是否真的生效，取决于脚本里有没有 __P(...)：不生效就明说，别让人以为填了就有用
    const caps = inspectScript(opts.jmxPath);
    const askThreads = Number(opts.threads) > 0;
    const askLoops = Number(opts.loops) > 0;
    if (askThreads && !caps.supportsThreads) {
      pushLine("warn", "[警告] 脚本里没有 ${__P(threads,默认值)}，线程数覆盖不会生效（脚本里线程组是写死的）");
    }
    if (askLoops && !caps.supportsLoops) {
      pushLine("warn", "[警告] 脚本里没有 ${__P(loops,默认值)}，循环次数覆盖不会生效（脚本里循环是写死的）");
    }

    // 把「即将执行的命令」也推给界面，方便对照 cmd 里的写法
    pushLine('cmd', `${jmeterPath} ${args.join(' ')}`);
    if (String(process.env.JAVA_HOME || '').trim() !== java.home) {
      pushLine('cmd', `[env] JAVA_HOME=${java.home}（覆盖${process.env.JAVA_HOME ? `无效的 ${process.env.JAVA_HOME}` : '未设置'}）`);
    }

    child.on('error', (err) => {
      console.error('[jmeter] spawn failed: ' + err.message);
      pushLine('err', `进程启动失败：${err.message}`);
    });

    child.on('close', (code) => {
      const text = lines.join('\n');
      let stats = null;
      let fromFile = false;
      try {
        if (fs.existsSync(paths.jtlPath)) {
          stats = parseJtl(fs.readFileSync(paths.jtlPath, 'utf8'));
          fromFile = !!stats;
        }
      } catch { /* jtl 解析失败就用控制台 summary */ }
      if (!stats) {
        const sum = parseSummary(text);
        if (sum) stats = { ...sum, fromConsole: true };
      }

      // 顺手把完整日志落盘，方便出问题后回看
      let logPath = '';
      try {
        logPath = path.join(outDir, `jmeter-${runId}.log`);
        fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
      } catch { /* 写日志失败不影响结果 */ }

      console.log('[jmeter] done runId=' + runId + ' code=' + code + ' jtl=' + (fs.existsSync(paths.jtlPath) ? paths.jtlPath : 'none') + ' report=' + (paths.reportDir || 'none'));
      const done = {
        runId,
        code,
        ok: code === 0,
        stats,
        statsFrom: fromFile ? 'jtl' : (stats ? 'console' : ''),
        jtlPath: fs.existsSync(paths.jtlPath) ? paths.jtlPath : '',
        reportDir: mode === 'report' && fs.existsSync(path.join(paths.reportDir, 'index.html')) ? paths.reportDir : '',
        logPath,
      };
      // 记一条运行历史（只存路径与统计，不含任何密钥）
      try {
        const { recordFromRun, pushRecord, loadHistory, saveHistory } = require("./jmeter-history");
        const rec = recordFromRun(done, { jmxPath: opts.jmxPath, mode, threads: opts.threads, loops: opts.loops });
        saveHistory(histDir, pushRecord(loadHistory(histDir), rec));
      } catch (e) {
        console.warn("[jmeter] 写运行历史失败：" + e.message);
      }

      current = null;
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('jmeter:done', done); } catch { /* 窗口已关 */ }
      }
    });

    return { success: true, data: { runId, jtlPath: paths.jtlPath, reportDir: paths.reportDir, args } };
  });

  /** 停止（杀进程树） */
  ipcMain.handle('jmeter:stop', async () => {
    if (!current) return { success: false, error: '当前没有正在运行的任务' };
    killTree(current.child);
    return { success: true };
  });

  /** 运行历史 */
  ipcMain.handle('jmeter:history', async () => {
    const { loadHistory } = require("./jmeter-history");
    return { success: true, data: loadHistory(histDir) };
  });
  ipcMain.handle('jmeter:history-clear', async () => {
    const { saveHistory } = require("./jmeter-history");
    saveHistory(histDir, []);
    return { success: true };
  });

  /** 是否正在运行（页面切回来时恢复状态） */
  ipcMain.handle('jmeter:status', async () => {
    if (!current) return { success: true, data: null };
    return { success: true, data: { runId: current.runId, jtlPath: current.jtlPath, reportDir: current.reportDir } };
  });

  /** 打开文件/目录（jtl、报告目录、日志） */
  ipcMain.handle('jmeter:open-path', async (_event, target) => {
    const p = String(target || '').trim();
    if (!p) return { success: false, error: '路径为空' };
    if (!fs.existsSync(p)) return { success: false, error: `路径不存在：${p}` };
    const err = await shell.openPath(p);
    return err ? { success: false, error: err } : { success: true };
  });

  /** 选中的默认输出目录（记住上次用的） */
  ipcMain.handle('jmeter:defaults', async () => {
    const s = loadSettings() || {};
    return {
      success: true,
      data: {
        jmeterPath: String(s.jmeterPath || ''),
        javaHome: String(s.javaHome || ''),
        outDir: String(s.jmeterOutDir || ''),
        jmxPath: String(s.jmeterLastJmx || ''),
        appVersion: app.getVersion(),
      },
    };
  });

  /** 记住上次的选择（脚本/输出目录），下次进来直接带出来 */
  ipcMain.handle('jmeter:remember', async (_event, patch = {}) => {
    const s = loadSettings() || {};
    if (patch.jmxPath !== undefined) s.jmeterLastJmx = String(patch.jmxPath || '');
    if (patch.outDir !== undefined) s.jmeterOutDir = String(patch.outDir || '');
    saveSettings(s);
    return { success: true };
  });
}

module.exports = { registerJmeterIpc };