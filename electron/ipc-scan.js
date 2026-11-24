'use strict';

/**
 * ipc-scan.js —— 代码体检（模块 3）与接口覆盖取数（模块 4.1）的 IPC 域。
 *
 * 通道与入参/出参/上限/取消语义见 docs/契约-本地测试资产工作站.md §2.2（C-52 ~ C-56）。
 *
 * 三条安全底线（每条都有对应断言，W5 落地）：
 *   1. **只读**：不写文件、不删文件、不执行命令、不发网络请求（C-15）。
 *   2. **不跟随符号链接**：跟随就等于让 root 包含性校验失效（可能链到磁盘任意位置），
 *      所以链接一律跳过并计入 `skippedSymlinks`（C-16 第 1 条 / C-54）。
 *   3. **命中内容不落日志**：`snippet` 是用户私有代码片段（可能含疑似口令）。
 *      本文件里**任何 console 调用都不许带 snippet / text / findings**（C-16 第 3 条同理的克制）。
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell } = require('electron');
const { SCAN_PACKS, rulesOf, matchRules, isInsideRoot } = require('./scan-rules');
const { decodeTextBuffer } = require('./text-encoding');
const {
  FINDINGS_DETAIL_CAP,
  createFindingCollector,
  createScanGuards,
  SKIP_DIRS,
  SCAN_MAX_FILES,
  SCAN_MAX_DEPTH,
  SCAN_TIMEOUT_MS,
} = require('./scan-collect');

/**
 * C-54：后缀白名单（白名单外不进统计）
 *
 * 目录跳过清单 `SKIP_DIRS`（含 v16 新增的 `coverage`）与三个上限已挪到 `electron/scan-collect.js`：
 * 那份是纯函数模块，单测能直接断言「清单里到底有谁」；本文件只做遍历与 IO。
 */
const SCAN_EXTS = new Set([
  '.java', '.kt', '.groovy', '.py', '.js', '.jsx', '.ts', '.tsx',
  '.xml', '.yml', '.yaml', '.json', '.properties', '.txt', '.md', '.sql',
]);

const MAX_FILE_BYTES = 1024 * 1024; // C-53 单文件 1 MB
const MAX_FILES = SCAN_MAX_FILES; // C-53 maxFiles ∈ [1, 2000]，缺省 2000
/**
 * 单次扫描**明细**上限（C-53 v16：2000）。
 *
 * 别和「落库上限」混成一个数：历史记录里每条只留前 300 条明细（渲染层
 * `SCAN_HISTORY_FINDINGS_CAP`，契约 C-29），因为 `scanRuns` 整个集合只有 1536 KB，
 * 2000 × 203 B ≈ 396 KB/条会让 20 条历史只能留 3 条。
 */
const MAX_FINDINGS_DETAIL = FINDINGS_DETAIL_CAP; // 2000
const MAX_DEPTH = SCAN_MAX_DEPTH; // C-53
const TIMEOUT_MS = SCAN_TIMEOUT_MS; // C-53
const YIELD_EVERY = 32; // C-51/C-55：每 32 个文件让出事件循环，取消消息才进得来

const PACKS = ['audit', 'coverage'];

/** `scan:run` 的错误文案唯一真源是契约 C-56，这里只是引用方 */
const ERR = {
  noRoot: '未选择目录',
  noDir: '目录不存在',
  notDir: '不是目录',
  unknownPack: (p) => `未知规则包：${p}`,
  emptyRules: (ids) => `规则集为空：${ids}`,
  escape: '路径越界：只允许扫描所选目录内的文件',
  revealMissing: (f) => `文件不存在：${f}`,
  failed: (m) => `扫描失败：${m}`,
};

/** C-53：maxFiles 由主进程 clamp，缺省 2000 */
function clampMaxFiles(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return MAX_FILES;
  return Math.max(1, Math.min(Math.floor(n), MAX_FILES));
}

/**
 * @param {{ getMainWindow?: () => any }} deps  dialog 的父窗口
 */
function registerScanIpc(deps = {}) {
  const getMainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null;

  /** C-55：只维护取消标志位，结束/取消时删除 */
  const tokens = new Map();

  /** 读前 1 MB（C-53：超出只读前 1 MB 并置 truncated/file-size，不是报错） */
  function readCapped(abs, size) {
    if (size <= MAX_FILE_BYTES) return { buf: fs.readFileSync(abs), capped: false };
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      const n = fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
      return { buf: buf.subarray(0, n), capped: true };
    } finally {
      try { fs.closeSync(fd); } catch { /* 关不掉就让 GC */ }
    }
  }

  /** `scan:pick-root` → `{ dir }`；取消走 canceled 语义（C-03） */
  ipcMain.handle('scan:pick-root', async () => {
    const picked = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择要体检的目录',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths.length) {
      return { success: false, canceled: true };
    }
    return { success: true, data: { dir: picked.filePaths[0] } };
  });

  /** `scan:rules` → 规则表（纯静态，不触盘） */
  ipcMain.handle('scan:rules', async () => ({ success: true, data: { packs: SCAN_PACKS } }));

  /**
   * `scan:run` —— 阻塞式 invoke（C-55），只读遍历 + 匹配。
   * data: `{ root, pack, files, fileList, bytes, skippedSymlinks, skippedByGuard, truncated,
   *          truncatedReason?, counts, suppressed, totalFindings, findings, ms }`
   *       （v16：`totalFindings` 必给、明细上限 2000；v17：`skippedByGuard` 必给，S-03）
   */
  ipcMain.handle('scan:run', async (_event, payload = {}) => {
    const started = Date.now();
    const opts = payload && typeof payload === 'object' ? payload : {};
    const token = String(opts.token || '');
    const state = token ? { canceled: false } : null;
    if (state) tokens.set(token, state);

    try {
      const root = String(opts.root || '').trim();
      if (!root) return { success: false, error: ERR.noRoot };
      let st;
      try { st = fs.statSync(root); } catch { return { success: false, error: ERR.noDir }; }
      if (!st.isDirectory()) return { success: false, error: ERR.notDir };
      const rootReal = fs.realpathSync(root);

      const pack = String(opts.pack || 'audit');
      if (!PACKS.includes(pack)) return { success: false, error: ERR.unknownPack(pack) };

      const packIds = rulesOf(pack).map((r) => r.id);
      const asked = Array.isArray(opts.ruleIds) ? opts.ruleIds.map(String) : [];
      const ruleIds = asked.length ? asked.filter((id) => packIds.includes(id)) : packIds;
      if (!ruleIds.length) return { success: false, error: ERR.emptyRules(asked.join(',')) };

      const maxFiles = clampMaxFiles(opts.maxFiles);

      const fileList = [];
      // v16：命中收集 / 总数计数 / 截断原因分流全部交给纯函数模块（可单测），这里只做遍历与 IO
      const collector = createFindingCollector({ maxFindings: MAX_FINDINGS_DETAIL });
      // S-03：v16 的两个守卫（coverage 目录 / 产物路径）当时是静默丢文件的，用户读到「0 命中」会误判干净。
      // 这个计数器把「被守卫挡掉多少」如实回传（照 skippedSymlinks 的做法）。
      const guards = createScanGuards();
      let bytes = 0;
      let skippedSymlinks = 0;
      let filesRead = 0;
      let stop = false;

      const stack = [{ dir: rootReal, depth: 0 }];
      while (stack.length && !stop) {
        if (state && state.canceled) return { success: false, canceled: true };
        if (Date.now() - started > TIMEOUT_MS) { collector.markTruncated('timeout'); break; }

        const cur = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(cur.dir, { withFileTypes: true });
        } catch {
          continue; // 无权限/读不到的目录跳过，不整单失败
        }

        for (const ent of entries) {
          if (stop) break;
          const abs = path.join(cur.dir, ent.name);

          // C-16 第 1 条：符号链接一律不跟随，只计数（不并入 files、不计入 truncated）
          if (ent.isSymbolicLink()) { skippedSymlinks += 1; continue; }

          if (ent.isDirectory()) {
            // C-54：目录守卫（含 coverage）——被跳过的目录计入 skippedByGuard，不再静默
            if (guards.skipDir(ent.name)) continue;
            if (cur.depth + 1 > MAX_DEPTH) { collector.markTruncated('depth'); continue; }
            stack.push({ dir: abs, depth: cur.depth + 1 });
            continue;
          }
          if (!ent.isFile()) continue;
          if (!SCAN_EXTS.has(path.extname(ent.name).toLowerCase())) continue;

          // root 归属再校一次（防御联接点绕过 isSymbolicLink 的实现差异）
          let real;
          try { real = fs.realpathSync(abs); } catch { continue; }
          if (!isInsideRoot(rootReal, real)) return { success: false, error: ERR.escape };

          const rel = path.relative(rootReal, abs).split(path.sep).join('/');
          // C-54 v16：压缩/打包产物**不进统计**——既不占 maxFiles 预算、不进 fileList、不跑规则。
          // 这些命中的 snippet 是压缩后的一行，用户读到也没法下手（本仓库 run/ 下的 exceljs.min-*.js）；
          // S-03：挡掉多少要回传（skippedByGuard），否则「0 命中」会被当成仓库干净。
          if (guards.skipFile(rel)) continue;

          if (filesRead >= maxFiles) { collector.markTruncated('max-files'); stop = true; break; }

          let size = 0;
          try { size = fs.statSync(abs).size; } catch { continue; }
          let buf;
          try {
            const r = readCapped(abs, size);
            buf = r.buf;
            if (r.capped) collector.markTruncated('file-size');
          } catch {
            continue; // 单个文件读不了就跳过，不整单失败
          }

          filesRead += 1;
          bytes += buf.length;
          fileList.push(rel);

          const text = decodeTextBuffer(buf).text;
          const { hits, suppressed: perFileSuppressed } = matchRules(text, rel, ruleIds);
          // RC-01：每规则上限折掉的命中要**可见**——计数回传。
          // v16：折叠只置 `suppressed` 原因，**不再**冒充 `findings`（折叠 ≠ 明细被砍）。
          if (perFileSuppressed > 0) collector.addSuppressed(perFileSuppressed);
          // v16：明细到 2000 条后**不停止扫描**——collector 继续计数 `totalFindings` 与 `counts`，
          // 所以「到底命中多少」是算得出来的真数，不是「物理上不可知」。
          collector.addHits(hits, rel);

          // 按批让出事件循环：取消/超时才进得来（C-51/C-55）
          if (filesRead % YIELD_EVERY === 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setImmediate(r));
            if (state && state.canceled) return { success: false, canceled: true };
          }
        }
      }

      if (state && state.canceled) return { success: false, canceled: true };
      if (Date.now() - started > TIMEOUT_MS) collector.markTruncated('timeout');

      const snap = collector.snapshot();
      return {
        success: true,
        data: {
          root: rootReal,
          pack,
          files: fileList.length,
          fileList,
          bytes,
          skippedSymlinks,
          // S-03：被目录守卫与产物 negative 挡掉的条目数（目录按 1 计；不递归数内部文件）
          ...guards.snapshot(),
          truncated: snap.truncated,
          ...(snap.truncatedReason ? { truncatedReason: snap.truncatedReason } : {}),
          // counts 覆盖**全量**命中（含明细已满后只计数的那些），与 totalFindings 同源：
          // counts.high+medium+low === totalFindings（契约 C-30 v16 的可断言不变量）
          counts: snap.counts,
          // RC-01：被每规则上限折掉的命中总数（v16：只挂在 suppressed 原因上，不再冒充 findings）
          suppressed: snap.suppressed,
          // v16：全仓命中总数（明细被砍也照样算得出来）；未到明细上限时 === findings.length
          totalFindings: snap.totalFindings,
          findings: snap.findings,
          ms: Date.now() - started,
        },
      };
    } catch (e) {
      return { success: false, error: ERR.failed(e && e.message ? e.message : String(e)) };
    } finally {
      if (token) tokens.delete(token);
    }
  });

  /** `scan:cancel { token }` → `{ canceled: boolean }`；token 不存在/已完成 → canceled:false（C-55 幂等） */
  ipcMain.handle('scan:cancel', async (_event, payload = {}) => {
    const token = String((payload && payload.token) || '');
    const state = token ? tokens.get(token) : null;
    if (!state) return { success: true, data: { canceled: false } };
    state.canceled = true;
    return { success: true, data: { canceled: true } };
  });

  /**
   * `scan:reveal { root, file, line? }` —— 在文件管理器里定位一条命中。
   *
   * **必须传 root**（本次扫描的根）：`file` 是**相对 root 的路径**，主进程拼成绝对路径后再校验。
   * 早期版本直接拿 `file` 做 `fs.existsSync`，等于按**主进程自己的 cwd** 解析：
   * dev 下 cwd 恰好是仓库根，所以「碰巧能用」；**打包版的 cwd 是应用安装目录**，
   * 于是「定位」按钮必然报「文件不存在」——S-06 就是这个 bug（dev 能过、打包必挂）。
   * 所以这里**不再有 cwd 兜底**：没给 root 就明确报错，给了就只认 root。
   *
   * 安全边界（C-16 第 3 条的唯一豁免通道）：只做 ① root 必填 + 包含性校验（`../` 越界拒绝，
   * 沿 C-56 的「路径越界」文案）② 存在性校验 ③ `shell.showItemInFolder`
   * ④ 返回 `{}`。**禁止**读内容、解析、执行、把路径写进日志（所以这里没有 console）。
   * `line` 只留给 UI 侧提示，不传给系统。
   */
  ipcMain.handle('scan:reveal', async (_event, payload = {}) => {
    const root = String((payload && payload.root) || '').trim();
    const file = String((payload && payload.file) || '').trim();
    // 缺 root = 调用方没按契约传参 → 明确报错，绝不退回 cwd（那正是 S-06 的成因）
    if (!root) return { success: false, error: '缺少扫描根目录：请重新扫描后再定位（定位需要扫描时的目录）' };
    if (!file) return { success: false, error: ERR.revealMissing(file) };
    const rootAbs = path.resolve(root);
    const full = path.isAbsolute(file) ? path.resolve(file) : path.resolve(rootAbs, file);
    // 越界拒绝：`../../etc/passwd` 之类一律不认（C-56）
    if (!isInsideRoot(rootAbs, full)) return { success: false, error: ERR.escape };
    if (!fs.existsSync(full)) return { success: false, error: ERR.revealMissing(file) };
    shell.showItemInFolder(full);
    return { success: true, data: {} };
  });
}

module.exports = {
  registerScanIpc,
  // 供体检/回归脚本复用的常量（不是通道）
  SCAN_LIMITS: {
    MAX_FILE_BYTES,
    MAX_FILES,
    // v16：这是**明细**上限（2000）；落库上限是渲染层的 SCAN_HISTORY_FINDINGS_CAP = 300
    MAX_FINDINGS: MAX_FINDINGS_DETAIL,
    MAX_DEPTH,
    TIMEOUT_MS,
    SKIP_DIRS,
    SCAN_EXTS,
  },
};
