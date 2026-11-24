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

/** C-54：遍历必须跳过的目录名 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', 'build', 'target', '.venv', 'vendor', 'out']);

/** C-54：后缀白名单（白名单外不进统计） */
const SCAN_EXTS = new Set([
  '.java', '.kt', '.groovy', '.py', '.js', '.jsx', '.ts', '.tsx',
  '.xml', '.yml', '.yaml', '.json', '.properties', '.txt', '.md', '.sql',
]);

const MAX_FILE_BYTES = 1024 * 1024; // C-53 单文件 1 MB
const MAX_FILES = 2000; // C-53 maxFiles ∈ [1, 2000]，缺省 2000
const MAX_FINDINGS = 300; // C-53
const MAX_DEPTH = 12; // C-53
const TIMEOUT_MS = 60000; // C-53
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
   * data: `{ root, pack, files, fileList, bytes, skippedSymlinks, truncated, truncatedReason?, counts, findings, ms }`
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
      const findings = [];
      const counts = { high: 0, medium: 0, low: 0 };
      let bytes = 0;
      let skippedSymlinks = 0;
    let suppressed = 0; // RC-01：被每规则上限折掉的命中总数
      let truncated = false;
      let truncatedReason = '';
      const markTruncated = (reason) => { truncated = true; if (!truncatedReason) truncatedReason = reason; };

      const stack = [{ dir: rootReal, depth: 0 }];
      let filesRead = 0;
      let stop = false;

      while (stack.length && !stop) {
        if (state && state.canceled) return { success: false, canceled: true };
        if (Date.now() - started > TIMEOUT_MS) { markTruncated('timeout'); break; }

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
            if (SKIP_DIRS.has(ent.name)) continue;
            if (cur.depth + 1 > MAX_DEPTH) { markTruncated('depth'); continue; }
            stack.push({ dir: abs, depth: cur.depth + 1 });
            continue;
          }
          if (!ent.isFile()) continue;
          if (!SCAN_EXTS.has(path.extname(ent.name).toLowerCase())) continue;

          // root 归属再校一次（防御联接点绕过 isSymbolicLink 的实现差异）
          let real;
          try { real = fs.realpathSync(abs); } catch { continue; }
          if (!isInsideRoot(rootReal, real)) return { success: false, error: ERR.escape };

          if (filesRead >= maxFiles) { markTruncated('max-files'); stop = true; break; }

          let size = 0;
          try { size = fs.statSync(abs).size; } catch { continue; }
          let buf;
          try {
            const r = readCapped(abs, size);
            buf = r.buf;
            if (r.capped) markTruncated('file-size');
          } catch {
            continue; // 单个文件读不了就跳过，不整单失败
          }

          filesRead += 1;
          bytes += buf.length;
          const rel = path.relative(rootReal, abs).split(path.sep).join('/');
          fileList.push(rel);

          const text = decodeTextBuffer(buf).text;
          const { hits, suppressed: perFileSuppressed } = matchRules(text, rel, ruleIds);
          // RC-01：每规则上限折掉的命中要**可见**——计数回传 + 置 truncated，
          // 否则用户以为看到的是全部（这正是这轮反复打的「静默折叠」）。
          if (perFileSuppressed > 0) {
            suppressed += perFileSuppressed;
            if (!truncatedReason) markTruncated('findings');
            else truncated = true;
          }
          for (const h of hits) {
            if (findings.length >= MAX_FINDINGS) { markTruncated('findings'); stop = true; break; } // RC-02：外层也要停，不能继续扫完
            const finding = {
              ruleId: h.ruleId,
              severity: h.severity,
              title: h.title,
              file: rel,
              line: h.line,
              snippet: h.snippet,
            };
            if (h.method) finding.method = h.method;
            if (h.path) finding.path = h.path;
            findings.push(finding);
            if (counts[h.severity] != null) counts[h.severity] += 1;
          }

          // 按批让出事件循环：取消/超时才进得来（C-51/C-55）
          if (filesRead % YIELD_EVERY === 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setImmediate(r));
            if (state && state.canceled) return { success: false, canceled: true };
          }
        }
      }

      if (state && state.canceled) return { success: false, canceled: true };
      if (Date.now() - started > TIMEOUT_MS) markTruncated('timeout');

      return {
        success: true,
        data: {
          root: rootReal,
          pack,
          files: fileList.length,
          fileList,
          bytes,
          skippedSymlinks,
          truncated,
          ...(truncatedReason ? { truncatedReason } : {}),
          counts,
          // RC-01：被每规则上限折掉的命中总数（配合 truncated/truncatedReason 一起看）
          suppressed,
          findings,
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
   * `scan:reveal { file, line? }` —— C-16 第 3 条的**唯一豁免**通道：
   * 不传 root、不做包含性校验；主进程只做 ① 非空 + 存在性校验 ② `shell.showItemInFolder`
   * ③ 返回 `{}`。**禁止**读内容、解析、执行、把路径写进日志（所以这里没有 console）。
   * `line` 只留给 UI 侧提示，不传给系统。
   */
  ipcMain.handle('scan:reveal', async (_event, payload = {}) => {
    const file = String((payload && payload.file) || '').trim();
    if (!file) return { success: false, error: ERR.revealMissing(file) };
    if (!fs.existsSync(file)) return { success: false, error: ERR.revealMissing(file) };
    shell.showItemInFolder(file);
    return { success: true, data: {} };
  });
}

module.exports = {
  registerScanIpc,
  // 供体检/回归脚本复用的常量（不是通道）
  SCAN_LIMITS: { MAX_FILE_BYTES, MAX_FILES, MAX_FINDINGS, MAX_DEPTH, TIMEOUT_MS, SKIP_DIRS, SCAN_EXTS },
};