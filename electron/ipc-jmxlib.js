/**
 * ipc-jmxlib.js —— 压力测试「脚本库」的 IPC（库根目录 + JMX 文件 + 每脚本默认参数）
 *
 * 与用例库的区别：
 *   - 只收 `.jmx`，复制进库（不引用原路径），两级目录封顶；
 *   - 每个脚本可以存自己的默认参数（输出目录 / 线程 / 循环 / 备注）和最近一次运行结果，
 *     点一下就填进「运行配置」，不用每次重新选。
 *
 * 配置落在 `<数据目录>/jmxlib.json`：`{ root, items: { [rel]: meta } }`。
 * 库目录本身是明文（脚本里可能写死内网地址，但这不是密码库该管的东西）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { safeName, resolveInside, uniqueName, MAX_FOLDER_DEPTH } = require('./cases-paths');
const { inspectJmx, isJmxName, buildJmxTemplate, buildJmxFromPlan, validateCsvTable } = require('./jmx-script');
const { parseCsv } = require('./csv');
const { decodeTextBuffer } = require('./text-encoding');

const CONFIG_NAME = 'jmxlib.json';
const META_KEYS = ['outDir', 'threads', 'loops', 'note', 'params'];
const MAX_RUNS = 20;
/** CSV 参数文件上限（契约 §2.7 通道表：CSV ≤ 50 MB、≤ 1,000,000 行） */
const MAX_CSV_BYTES = 50 * 1024 * 1024;
const MAX_CSV_ROWS = 1000000;

/**
 * buildJmxFromPlan 的 reason → 契约 C-77 的文案（单一映射点；bad-url 复用既有串，不新增措辞）
 */
const PLAN_ERROR_TEXT = {
  'no-interface': () => '至少填一个接口',
  'too-many-interfaces': () => '接口最多 50 个',
  'threads-out-of-range': () => '线程数或循环数超出范围（1–100000）',
  'think-time-out-of-range': () => '思考时间超出范围（0–60000 ms）',
  // S-02：方法不在白名单——文案必须指向真正的原因，不能笼统说「参数不合法」（那样用户会去查地址）
  'bad-method': (d) => `不支持的 HTTP 方法：${d}（只允许 GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS）`,
  'bad-url': (d) => `地址格式不对，例如 https://example.com/api/login（${d || '地址不可解析'}）`,
  'bad-csv-var': (d) => `CSV 变量名不合法：${d || ''}`,
  'bad-assert-code': () => '断言状态码必须是 3 位数字',
};

module.exports = { registerJmxLibIpc };

/**
 * @param {{ ipcMain: import('electron').IpcMain; dialog: import('electron').Dialog; shell: import('electron').Shell; dataDir: string; getWindow: () => import('electron').BrowserWindow | null; }} deps
 */
function registerJmxLibIpc(deps) {
  const { ipcMain, dialog, shell, dataDir } = deps;
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;
  const cfgFile = path.join(dataDir, CONFIG_NAME);

  const readConfig = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      return {
        root: typeof raw.root === 'string' ? raw.root : '',
        items: raw.items && typeof raw.items === 'object' ? raw.items : {},
      };
    } catch {
      return { root: '', items: {} };
    }
  };

  const writeConfig = (cfg) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${cfgFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ root: cfg.root || '', items: cfg.items || {} }, null, 2), 'utf8');
    fs.renameSync(tmp, cfgFile);
  };

  const cleanMeta = (meta) => {
    const out = {};
    for (const k of META_KEYS) {
      if (meta && meta[k] !== undefined && meta[k] !== null && meta[k] !== '') out[k] = meta[k];
    }
    if (out.threads !== undefined) out.threads = Math.max(1, Math.min(Number(out.threads) || 1, 100000));
    if (out.loops !== undefined) out.loops = Math.max(1, Math.min(Number(out.loops) || 1, 100000));
    if (out.note !== undefined) out.note = String(out.note).slice(0, 500);
    if (meta && meta.params && typeof meta.params === 'object') {
      const p = {};
      for (const [k, v] of Object.entries(meta.params)) {
        const key = String(k || '').trim().slice(0, 60);
        if (!key) continue;
        p[key] = String(v == null ? '' : v).slice(0, 200);
      }
      if (Object.keys(p).length) out.params = p;
    }
    return out;
  };

  ipcMain.handle('jmxlib:config', async () => {
    const cfg = readConfig();
    const exists = !!cfg.root && fs.existsSync(cfg.root);
    return { success: true, data: { configured: exists, root: cfg.root, items: cfg.items } };
  });

  ipcMain.handle('jmxlib:choose-root', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择脚本库目录（放 .jmx 脚本）',
        buttonLabel: '使用这个目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { success: false, canceled: true };
      const root = r.filePaths[0];
      fs.mkdirSync(root, { recursive: true });
      const cfg = readConfig();
      writeConfig({ root, items: cfg.items });
      return { success: true, data: { root } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 默认输出目录：<数据目录>/jmeter-reports（每次运行仍会建 report-<时间戳> 子目录） */
  ipcMain.handle('jmxlib:default-out', async () => {
    const dir = path.join(dataDir, 'jmeter-reports');
    try {
      fs.mkdirSync(dir, { recursive: true });
      return { success: true, data: { outDir: dir } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择输出目录（每次运行会在下面建 report-时间戳）',
        buttonLabel: '使用这个目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { success: false, canceled: true };
      return { success: true, data: { dir: r.filePaths[0] } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  ipcMain.handle('jmxlib:list', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: true, data: { configured: false, root: '', rel: '', dirs: [], files: [] } };
      if (!fs.existsSync(cfg.root)) {
        return { success: false, error: '脚本库目录不存在（可能被移动或删除了），请重新选择' };
      }
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '目录不存在' };

      const dirs = [];
      const files = [];
      for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(target, e.name);
        const childRel = path.relative(cfg.root, full).split(path.sep).join('/');
        let st = null;
        try { st = fs.statSync(full); } catch { continue; }
        if (e.isDirectory()) {
          let jmxCount = 0;
          try { jmxCount = fs.readdirSync(full, { withFileTypes: true }).filter(x => x.isFile() && isJmxName(x.name)).length; } catch { /* 权限 */ }
          dirs.push({ name: e.name, rel: childRel, mtime: st.mtime.toISOString(), jmxCount });
        } else if (isJmxName(e.name)) {
          files.push({
            name: e.name,
            rel: childRel,
            size: st.size,
            mtime: st.mtime.toISOString(),
            meta: cfg.items[childRel] || {},
          });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return { success: true, data: { configured: true, root: cfg.root, rel: String(rel || ''), dirs, files } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:pick-files', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择 .jmx 脚本导入',
        buttonLabel: '导入',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'JMeter 脚本', extensions: ['jmx'] }],
      });
      if (r.canceled || !r.filePaths?.length) return { success: false, canceled: true };
      return { success: true, data: r.filePaths };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:import', async (_event, { rel, paths } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const { target: destDir, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(destDir)) return { success: false, error: '目标目录不存在' };
      const list = Array.isArray(paths) ? paths : [];
      if (!list.length) return { success: false, error: '没有要导入的文件' };

      const imported = [];
      const failed = [];
      const existing = fs.readdirSync(destDir);
      for (const p of list) {
        try {
          const src = path.resolve(String(p));
          if (!fs.existsSync(src) || !fs.statSync(src).isFile()) { failed.push(`${path.basename(src)}（不存在）`); continue; }
          if (!isJmxName(src)) { failed.push(`${path.basename(src)}（不是 .jmx）`); continue; }
          if (fs.statSync(src).size > 50 * 1024 * 1024) { failed.push(`${path.basename(src)}（超过 50MB）`); continue; }
          const name = uniqueName(existing.concat(imported), path.basename(src));
          fs.copyFileSync(src, path.join(destDir, name));
          imported.push(name);
        } catch (e) {
          failed.push(`${path.basename(String(p))}（${e.message}）`);
        }
      }
      return { success: true, data: { imported, failed } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:mkdir', async (_event, { rel, name } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const depth = String(rel || '').split('/').filter(Boolean).length;
      if (depth >= MAX_FOLDER_DEPTH) {
        return { success: false, error: `最多 ${MAX_FOLDER_DEPTH} 级文件夹：请在根目录或一级目录新建` };
      }
      const { target: parent, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(parent)) return { success: false, error: '上级目录不存在' };
      const checked = safeName(name);
      if (checked.error) return { success: false, error: checked.error };
      const finalName = uniqueName(fs.readdirSync(parent), checked.name);
      fs.mkdirSync(path.join(parent, finalName));
      return { success: true, data: { name: finalName } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:rename', async (_event, { rel, name } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      const isDir = fs.statSync(target).isDirectory();
      const checked = safeName(name);
      if (checked.error) return { success: false, error: checked.error };
      // 文件必须保留 .jmx 后缀，否则下次就不在库里了
      let safe = checked.name;
      if (!isDir && !isJmxName(safe)) safe = `${safe}.jmx`;
      const parent = path.dirname(target);
      const finalName = uniqueName(fs.readdirSync(parent).filter(n => n !== path.basename(target)), safe);
      const nextPath = path.join(parent, finalName);
      fs.renameSync(target, nextPath);

      // meta 跟着改名走（目录则搬整棵子树）
      const nextRel = path.relative(cfg.root, nextPath).split(path.sep).join('/');
      const oldRel = String(rel || '');
      const items = {};
      for (const [k, v] of Object.entries(cfg.items)) {
        if (k === oldRel) items[nextRel] = v;
        else if (k.startsWith(oldRel + '/')) items[nextRel + k.slice(oldRel.length)] = v;
        else items[k] = v;
      }
      writeConfig({ root: cfg.root, items });
      return { success: true, data: { rel: nextRel, name: finalName } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:delete', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      await shell.trashItem(target);
      const oldRel = String(rel || '');
      const items = {};
      for (const [k, v] of Object.entries(cfg.items)) {
        if (k === oldRel || k.startsWith(oldRel + '/')) continue;
        items[k] = v;
      }
      writeConfig({ root: cfg.root, items });
      return { success: true, data: { rel: oldRel } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:reveal', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      shell.showItemInFolder(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 用系统关联程序打开（装了 JMeter 的话就是 JMeter GUI） */
  ipcMain.handle('jmxlib:open', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      const msg = await shell.openPath(target);
      if (!msg) return { success: true, data: { how: 'default' } };
      if (process.platform === 'win32') {
        spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return { success: true, data: { how: 'open-with' } };
      }
      return { success: false, error: `没有可用的默认应用：${msg}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('jmxlib:meta-set', async (_event, { rel, meta } = {}) => {
    try {
      const cfg = readConfig();
      const key = String(rel || '');
      if (!key) return { success: false, error: '缺少脚本路径' };
      const clean = cleanMeta(meta);
      const next = { ...(cfg.items[key] || {}), ...clean };
      // 空值表示清掉该字段
      for (const k of META_KEYS) {
        if (meta && meta[k] === '' || meta && meta[k] === null) delete next[k];
      }
      const items = { ...cfg.items };
      if (Object.keys(next).length === 0) delete items[key];
      else items[key] = next;
      writeConfig({ root: cfg.root, items });
      return { success: true, data: { meta: next } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 从模板新建一个最小可跑的 HTTP 脚本 */
  ipcMain.handle('jmxlib:create-template', async (_event, { rel, name, url, method, threads, loops } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const depth = String(rel || '').split('/').filter(Boolean).length;
      if (depth >= MAX_FOLDER_DEPTH) return { success: false, error: '最多两级：请在根目录或一级目录新建脚本' };
      const { target: dir, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(dir)) return { success: false, error: '目标目录不存在' };
      const built = buildJmxTemplate({ name, url, method, threads, loops });
      if (!built.ok) return { success: false, error: built.error };

      const checked = safeName(name || `${built.domain}${(built.path || '').replace(/[\\/?&=]+/g, '-')}` || '新建脚本');
      if (checked.error) return { success: false, error: checked.error };
      const withExt = isJmxName(checked.name) ? checked.name : `${checked.name}.jmx`;
      const finalName = uniqueName(fs.readdirSync(dir), withExt);
      fs.writeFileSync(path.join(dir, finalName), built.xml, 'utf8');
      const relOut = path.relative(cfg.root, path.join(dir, finalName)).split(path.sep).join('/');
      return { success: true, data: { name: finalName, rel: relOut } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 结构检查（不跑 JMeter）：是否像 JMX、几个线程组、参数、引用的数据文件是否存在 */
  ipcMain.handle('jmxlib:validate', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return { success: false, error: '脚本不存在' };
      if (fs.statSync(target).size > 50 * 1024 * 1024) return { success: false, error: '文件太大（超过 50MB）' };
      const xml = fs.readFileSync(target, 'utf8');
      const info = inspectJmx(xml);

      // 数据文件预检：是否存在、多大、多少行（行数少于线程数时多线程会重复读同一批数据）
      const scriptDir = path.dirname(target);
      const files = [];
      const missing = [];
      for (const f of info.dataFiles) {
        const abs = path.isAbsolute(f) ? f : path.join(scriptDir, f);
        const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
        if (!exists) { missing.push(f); files.push({ path: f, abs, exists: false, bytes: 0, lines: 0 }); continue; }
        let bytes = 0;
        let lines = 0;
        try {
          bytes = fs.statSync(abs).size;
          // 只读前 8MB 数行，防止有人挂了个几百 MB 的文件
          const fd = fs.openSync(abs, 'r');
          const buf = Buffer.alloc(Math.min(bytes, 8 * 1024 * 1024));
          const read = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const text = buf.subarray(0, read).toString('utf8');
          if (text.length) lines = text.split(/\r?\n/).filter((l, i, arr) => i < arr.length - 1 || l !== '').length;
        } catch { /* 读不了就只报存在 */ }
        files.push({ path: f, abs, exists: true, bytes, lines });
      }
      return { success: true, data: { ...info, files, missingFiles: missing } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 记录一次运行结果：脚本库显示「最近运行」，并留最近 20 次做趋势 */
  ipcMain.handle('jmxlib:mark-run', async (_event, { rel, ok, reportDir, durationMs, threads, loops, stats } = {}) => {
    try {
      const cfg = readConfig();
      const key = String(rel || '');
      if (!key) return { success: false, error: '缺少脚本路径' };
      const items = { ...cfg.items };
      const prev = items[key] || {};
      const at = new Date().toISOString();
      const ms = Number(durationMs) || 0;
      const s = stats && typeof stats === 'object' ? stats : {};
      const samples = Number(s.samples) || 0;
      const errors = Number(s.errors) || 0;
      // stats.errorPct 已经是百分比（0~100），保留 1 位小数
      const errorPct = typeof s.errorPct === 'number' ? Math.round(s.errorPct * 10) / 10 : (samples ? Math.round((errors / samples) * 1000) / 10 : 0);
      const avg = Number(s.avg) || 0;
      const tps = ms > 0 && samples > 0 ? Math.round((samples / (ms / 1000)) * 10) / 10 : 0;
      const run = { at, ok: !!ok, samples, errors, errorPct, avg, tps, durationMs: ms, reportDir: String(reportDir || '') };
      const runs = [...(Array.isArray(prev.runs) ? prev.runs : []), run].slice(-MAX_RUNS);
      items[key] = {
        ...prev,
        lastRun: {
          at,
          ok: !!ok,
          reportDir: String(reportDir || ''),
          durationMs: ms,
          threads: threads ? Number(threads) : undefined,
          loops: loops ? Number(loops) : undefined,
          samples,
          errorPct,
          tps,
        },
        runs,
      };
      writeConfig({ root: cfg.root, items });
      return { success: true, data: { lastRun: items[key].lastRun } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 接口集合 → 批量 `.jmx`（契约 §2.7 / C-75〜C-77）。
   *
   * 落盘顺序**写死，不许调换**（C-75 第 2 条：任一步失败磁盘零新增）：
   *   ① build（纯函数，不碰盘）→ ② inspectJmx 结构检查 → ③ CSV 校验（存在/大小/parseCsv/列与行）
   *   → ④ 定最终文件名（uniqueName）→ 需要时用最终 CSV 名重建并复检 → ⑤ 复制 CSV → ⑥ 临时文件 + rename
   *
   * CSV 相对路径（C-75 四条）：JMX 内只写**文件名**；源文件只在生成时读一次；
   * 复制进脚本库同目录；`csv.copied` 与 JMX 里写的文件名逐字一致。
   *
   * @returns {Promise<{success: boolean, data?: { rel: string, name: string, path: string, interfaces: number,
   *   bytes: number, csv?: { source: string, copied: string, rows: number } }, error?: string }> }
   */
  ipcMain.handle('jmxlib:create-batch', async (_event, { rel, plan } = {}) => {
    /** 本次已落盘的文件；失败时逐个删掉，保证「任一步失败磁盘零新增」 */
    const created = [];
    const cleanup = () => {
      for (const f of created.splice(0).reverse()) {
        try { fs.unlinkSync(f); } catch { /* 已经不在了 */ }
      }
    };
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置脚本库目录' };
      const depth = String(rel || '').split('/').filter(Boolean).length;
      if (depth >= MAX_FOLDER_DEPTH) return { success: false, error: '最多两级：请在根目录或一级目录新建脚本' };
      const { target: dir, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { success: false, error: '目标目录不存在' };

      const p = plan && typeof plan === 'object' ? plan : {};

      // ① build（纯函数：先把结构算出来，一个字节都不写）
      let built = buildJmxFromPlan(p);
      if (!built.ok) return { success: false, error: (PLAN_ERROR_TEXT[built.reason] || (() => '参数不合法'))(built.detail) };

      // ② 结构检查（不合格直接返回，磁盘零新增）
      const checked = inspectJmx(built.xml);
      if (!checked.ok) return { success: false, error: `生成的 JMX 未通过结构检查：${checked.error}` };

      // ③ CSV 校验：存在 → 大小 → parseCsv → 列与数据行（全在写盘之前）
      let csvInfo = null;
      const csvSource = String(p.csvFile || '').trim();
      if (built.csvFileName && csvSource) {
        if (!fs.existsSync(csvSource) || !fs.statSync(csvSource).isFile()) return { success: false, error: `CSV 文件不存在：${csvSource}` };
        const csvSize = fs.statSync(csvSource).size;
        if (csvSize > MAX_CSV_BYTES) return { success: false, error: 'CSV 太大（> 50 MB）' };
        let table;
        try {
          table = parseCsv(decodeTextBuffer(fs.readFileSync(csvSource)).text);
        } catch (e) {
          return { success: false, error: `CSV 无法解析：${e.message}` };
        }
        const v = validateCsvTable(table, p.csvVars);
        if (!v.ok) return { success: false, error: v.reason === 'missing-column' ? `CSV 缺少列：${v.detail}` : 'CSV 没有数据行' };
        if (v.rows > MAX_CSV_ROWS) return { success: false, error: 'CSV 太大（> 50 MB）' };
        csvInfo = { table, rows: v.rows };
      }

      // ④ 最终文件名：.jmx 与 CSV 各走 uniqueName（C-76：禁止覆盖已有脚本）
      const checkedName = safeName(p.name || built.name || '批量脚本');
      if (checkedName.error) return { success: false, error: checkedName.error };
      const withExt = isJmxName(checkedName.name) ? checkedName.name : `${checkedName.name}.jmx`;
      const existing = fs.readdirSync(dir);
      const jmxName = uniqueName(existing, withExt);

      let csvCopied = '';
      if (built.csvFileName) {
        csvCopied = uniqueName([...existing, jmxName], built.csvFileName);
        if (csvCopied !== built.csvFileName) {
          // 重名加了后缀：JMX 里写的文件名必须跟着改，否则「脚本能跑但读错文件」（C-76）
          built = buildJmxFromPlan({ ...p, csvFile: csvCopied });
          if (!built.ok) return { success: false, error: (PLAN_ERROR_TEXT[built.reason] || (() => '参数不合法'))(built.detail) };
          const recheck = inspectJmx(built.xml);
          if (!recheck.ok) return { success: false, error: `生成的 JMX 未通过结构检查：${recheck.error}` };
        }
      }

      // ⑤ 复制 CSV（第一个真正落盘的动作；失败也不留 .jmx）
      if (csvInfo) {
        const csvTarget = path.join(dir, csvCopied);
        try {
          fs.copyFileSync(csvSource, csvTarget);
          created.push(csvTarget);
        } catch (e) {
          cleanup();
          return { success: false, error: `CSV 复制失败：${e.message}` };
        }
      }

      // ⑥ 原子写 .jmx：临时文件 + rename（写完才出现在库里）
      const jmxTarget = path.join(dir, jmxName);
      const tmp = `${jmxTarget}.tmp`;
      try {
        fs.writeFileSync(tmp, built.xml, 'utf8');
        created.push(tmp);
        fs.renameSync(tmp, jmxTarget);
        created.splice(created.indexOf(tmp), 1); // tmp 已经变成正式文件，不再是残留
      } catch (e) {
        cleanup(); // 删掉 tmp 与已复制的 CSV
        return { success: false, error: `磁盘写入失败：${e.message}` };
      }

      const relOut = path.relative(cfg.root, jmxTarget).split(path.sep).join('/');
      created.length = 0; // 成功：产物保留
      return {
        success: true,
        data: {
          rel: relOut,
          name: jmxName,
          path: jmxTarget,
          interfaces: built.interfaces,
          bytes: Buffer.byteLength(built.xml, 'utf8'),
          ...(csvInfo ? { csv: { source: csvSource, copied: csvCopied, rows: csvInfo.rows } } : {}),
        },
      };
    } catch (e) {
      cleanup();
      return { success: false, error: e.message };
    }
  });
}




