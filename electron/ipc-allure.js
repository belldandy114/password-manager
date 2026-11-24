'use strict';

/**
 * ipc-allure.js —— Allure results 解析（模块 5.1）的 IPC 域，**只读**。
 *
 * 通道与上限见 docs/契约-本地测试资产工作站.md §2.4（C-61 ~ C-64）。
 *
 * 分工：本模块只做「目录遍历 + 读文件 + 上限钳制 + 超时」，解析/聚类/flaky 全在
 * `electron/allure-parse.js`（纯函数，可单测）。
 *
 * 安全底线（C-61/C-17）：
 *   - 只读 `*-result.json` / `*-container.json` / `environment.*`；**附件（`*-attachment.*`）不读、不解析、不执行**，
 *     HTML 报告不解析——它们连打开都不打开，只按文件名计入 `skippedFiles`；
 *   - 用例内容（message 等）不进 console、不进 app-log。
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require('electron');
const { parseAllure, isResultFile, isContainerFile, isEnvFile, pickReason, MAX_FILE_BYTES, MAX_FILES } = require('./allure-parse');
const { decodeTextBuffer } = require('./text-encoding');

const TIMEOUT_MS = 30000; // C-62
const YIELD_EVERY = 64; // C-51 同款：按批让出事件循环

/** C-63 错误文案（唯一真源在契约，这里只引用） */
const ERR = {
  noDir: '目录不存在',
  notAllure: '不是 allure-results 目录（未找到 *-result.json）',
  readFailed: (name, msg) => `读取失败：${name}（${msg}）`,
  parseFailed: (name, msg) => `解析失败：${name}（${msg}）`,
};

const clampMaxFiles = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return MAX_FILES;
  return Math.max(1, Math.min(Math.floor(n), MAX_FILES));
};

/**
 * @param {{ getMainWindow?: () => any }} deps  dialog 的父窗口
 */
function registerAllureIpc(deps = {}) {
  const getMainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null;

  /** `allure:pick-dir` → `{ dir }`；取消走 canceled 语义（C-03） */
  ipcMain.handle('allure:pick-dir', async () => {
    const picked = await dialog.showOpenDialog(getMainWindow(), {
      title: '选择 allure-results 目录',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths.length) {
      return { success: false, canceled: true };
    }
    return { success: true, data: { dir: picked.filePaths[0] } };
  });

  /**
   * `allure:parse { dir, maxFiles? }` —— 只读遍历 + 纯函数解析。
   * 坏文件不整体失败（计入 skippedFiles），只有「一个可解析的 result 都没有」才 success:false（C-63）。
   */
  ipcMain.handle('allure:parse', async (_event, payload = {}) => {
    const started = Date.now();
    const p = payload && typeof payload === 'object' ? payload : {};

    const dir = String(p.dir || '').trim();
    if (!dir) return { success: false, error: ERR.noDir };
    let st;
    try { st = fs.statSync(dir); } catch { return { success: false, error: ERR.noDir }; }
    if (!st.isDirectory()) return { success: false, error: ERR.noDir };

    const maxFiles = clampMaxFiles(p.maxFiles);

    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      return { success: false, error: ERR.noDir };
    }
    names.sort();

    const files = [];
    let skippedFiles = 0; // ② 附件/HTML 等「按 C-61 不读」的文件
    let truncated = false;
    let truncatedReason = '';
    const markTruncated = (r) => { truncated = true; truncatedReason = pickReason(truncatedReason, r); };

    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      const abs = path.join(dir, name);

      // 先按文件名过滤：只处理三类，其它一律不打开（附件可能几百 MB）
      const candidate = isResultFile(name) || isContainerFile(name) || isEnvFile(name);
      if (!candidate) {
        let isFile = true;
        try { isFile = fs.statSync(abs).isFile(); } catch { isFile = false; }
        if (isFile) skippedFiles += 1; // 目录不计
        continue;
      }

      let size = 0;
      try {
        const s = fs.statSync(abs);
        if (!s.isFile()) continue;
        size = s.size;
      } catch {
        skippedFiles += 1;
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        // C-62：单文件超 2 MB 跳过并在 truncated 计数（不读进内存）
        if (isResultFile(name)) skippedFiles += 1;
        markTruncated('file-size');
        continue;
      }

      let text;
      try {
        text = decodeTextBuffer(fs.readFileSync(abs)).text;
      } catch (e) {
        // C-63：读取失败的 result 计入 skippedFiles，不整体失败
        if (isResultFile(name)) { skippedFiles += 1; markTruncated('read-error'); continue; }
        return { success: false, error: ERR.readFailed(name, e.message) };
      }
      files.push({ name, text });

      if ((i + 1) % YIELD_EVERY === 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
        if (Date.now() - started > TIMEOUT_MS) { markTruncated('timeout'); break; }
      }
    }

    const parsed = parseAllure(files, { maxFiles, skippedFiles });

    if (!parsed.ok) {
      // 「一个可解析的 result 都没有」：明确报错，不许静默返回 0 条当成成功（C-63）
      return { success: false, error: parsed.error || ERR.notAllure };
    }

    const elapsed = Date.now() - started;
    if (elapsed > TIMEOUT_MS && !parsed.truncated) markTruncated('timeout');

    return {
      success: true,
      data: {
        root: dir,
        total: parsed.total,
        passed: parsed.passed,
        failed: parsed.failed,
        broken: parsed.broken,
        skipped: parsed.skipped,
        retries: parsed.retries,
        skippedFiles: parsed.skippedFiles,
        cases: parsed.cases,
        environment: parsed.environment,
        clusters: parsed.clusters,
        flaky: parsed.flaky,
        truncated: parsed.truncated || truncated,
        ...((parsed.truncatedReason || truncatedReason)
          ? { truncatedReason: pickReason(parsed.truncatedReason, truncatedReason) }
          : {}),
        ms: Date.now() - started,
      },
    };
  });
}

module.exports = {
  registerAllureIpc,
  ALLURE_LIMITS: { TIMEOUT_MS, MAX_FILE_BYTES, MAX_FILES },
};