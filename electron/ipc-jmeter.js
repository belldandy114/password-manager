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

/** java 是否可用（jmeter.bat 依赖它；没有 java 时给出明确提示而不是让子进程报一堆错） */
async function detectJava() {
  const out = await runCmd(IS_WIN ? 'where' : 'which', ['java']);
  const p = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  if (!p || !fs.existsSync(p)) return { ok: false, path: '' };
  const ver = await runCmd('java', ['-version']);
  return { ok: true, path: p, version: ver.split(/\r?\n/)[0] || '' };
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

function registerJmeterIpc({ loadSettings, saveSettings, getWindow }) {
  /** 探测：优先设置里的路径 → PATH → 常见目录 */
  ipcMain.handle('jmeter:detect', async () => {
    const s = loadSettings() || {};
    const configured = String(s.jmeterPath || '').trim();
    const java = await detectJava();

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

    const runId = String(Date.now());
    const lines = [];
    let child;
    try {
      // Windows 的 .bat 必须经 cmd.exe 启动，否则 spawn 直接 EINVAL
      const isScript = IS_WIN && /\.(bat|cmd)$/i.test(jmeterPath);
      child = isScript
        ? spawn('cmd.exe', ['/c', jmeterPath, ...args], { windowsHide: true, cwd: path.dirname(jmeterPath) })
        : spawn(jmeterPath, args, { windowsHide: true, cwd: path.dirname(jmeterPath) });
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
      let buf = '';
      readable.setEncoding('utf8');
      readable.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.trim()) pushLine(stream, line);
        }
      });
      readable.on('end', () => { if (buf.trim()) pushLine(stream, buf.trim()); });
    };
    wire('out', child.stdout);
    wire('err', child.stderr);

    current = { runId, child, jtlPath: paths.jtlPath, reportDir: paths.reportDir };

    // 把「即将执行的命令」也推给界面，方便对照 cmd 里的写法
    pushLine('cmd', `${jmeterPath} ${args.join(' ')}`);

    child.on('error', (err) => {
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