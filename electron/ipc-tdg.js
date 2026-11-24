'use strict';

/**
 * ipc-tdg.js —— 测试数据生成器的十万级流式落盘（模块 2.2）IPC 域。**写盘**。
 *
 * 通道与上限见 docs/契约-本地测试资产工作站.md §2.5（C-65 ~ C-69），施工单见 docs/拆分-主进程.md S-94〜S-99。
 *
 * 分工：本模块**只做 fd 生命周期与 reason→文案映射**——
 *   - `.part` 三态：openSync / writeSync / fsyncSync + rename；取消时 unlink（C-65）
 *   - writerId 一次性；finish/abort 之后一律 `写入会话不存在或已结束：<writerId>`（C-66）
 *   - 残留清理两处：write-abort、app.on('will-quit')（施工单 S-95）
 * 分隔符、BOM、首尾字符、行内转义与四项上限**全在 electron/tdg-write.js**（纯函数，可单测）。
 *
 * 安全底线：任何时刻正式文件都不存在，所以取消后不会留半成品 CSV 给 JMeter 当参数文件。
 * 多 writer：本实现允许并存（团队验收要求「同时打开两个 writer 互不干扰」）；
 * 契约 C-66 原写「同时只允许 1 个、新 start 先 abort 旧的」，二者冲突时按验收执行，已在回执里标注。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, app } = require('electron');
const {
  textBytes, createWriterState, openChunk, headersOf, encodeRows, closeChunk,
} = require('./tdg-write');

const FORMATS = ['csv', 'json', 'txt'];

/** reason → 契约 C-69 的文案（单一映射点；文案原文见契约，不在这里另写第二份口径） */
const REASON_TEXT = {
  'batch-rows': '单批最多 5000 行',
  'line-bytes': '单行超过 64 KB，已拒绝',
  'rows-cap': '已达单文件上限（1,000,000 行）',
  'bytes-cap': '已达单文件上限（512 MB）',
  closed: '写入会话不存在或已结束',
  'bad-format': '未知格式',
};

/**
 * @param {{ getMainWindow?: () => any }} deps  showSaveDialog 的父窗口
 */
function registerTdgIpc(deps = {}) {
  const getMainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null;

  /** writerId → { fd, target, part, state, startMs } */
  const writers = new Map();

  const closedError = (writerId) => ({ success: false, error: `写入会话不存在或已结束：${String(writerId || '')}` });

  /** 结束一个 writer：关 fd、删 .part。返回 .part 之前是否存在 */
  const discardWriter = (writerId) => {
    const w = writers.get(writerId);
    if (!w) return null;
    writers.delete(writerId);
    w.state.closed = true;
    try { fs.closeSync(w.fd); } catch { /* 已经关了就算了 */ }
    let removed = false;
    try { removed = fs.existsSync(w.part); fs.unlinkSync(w.part); } catch { /* 残留已经不在了 */ }
    return { removed, path: w.target };
  };

  // 进程退出时兜底清理未结束的 writer（同步执行，不能 await）
  app.on('will-quit', () => {
    for (const id of [...writers.keys()]) discardWriter(id);
  });

  /**
   * 建写入会话：弹保存框（可选）→ 建 `.part` → 写前缀（BOM / `[` / CSV 表头）。
   * data: { writerId, path }
   */
  ipcMain.handle('tdg:write-start', async (_event, payload = {}) => {
    try {
      const opts = payload && typeof payload === 'object' ? payload : {};
      const format = String(opts.format || '');
      if (!FORMATS.includes(format)) return { success: false, error: `未知格式：${format}` };

      let target = String(opts.savePath || '').trim();
      if (!target) {
        const picked = await dialog.showSaveDialog(getMainWindow(), {
          title: '选择导出文件保存位置',
          defaultPath: `tdg-export.${format}`,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (picked.canceled || !picked.filePath) return { success: false, canceled: true };
        target = picked.filePath;
      }

      const dir = path.dirname(target);
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) return { success: false, error: `目标目录不存在：${dir}` };

      const part = `${target}.part`;
      try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch { /* 删不掉就让 open 'w' 覆盖 */ }

      const state = createWriterState({
        format, columns: Array.isArray(opts.columns) ? opts.columns : null, bom: !!opts.bom,
      });
      const fd = fs.openSync(part, 'w');
      const prefix = openChunk(state, format) + headersOf(state.columns, format);
      if (prefix) {
        fs.writeSync(fd, prefix, null, 'utf8');
        state.bytes = textBytes(prefix);
      }

      const writerId = crypto.randomUUID();
      writers.set(writerId, { fd, target, part, state, startMs: Date.now() });
      return { success: true, data: { writerId, path: target } };
    } catch (e) {
      return { success: false, error: `磁盘写入失败：${e.message}` };
    }
  });

  /**
   * 追加一批：编码（含转义/分隔符）→ writeSync。
   * data: { rows, bytes }；被上限拒绝时 data 不落一个字节（tdg-write 先判后拼）。
   */
  ipcMain.handle('tdg:write-append', async (_event, payload = {}) => {
    const writerId = String((payload && payload.writerId) || '');
    const w = writers.get(writerId);
    if (!w) return closedError(writerId);
    const r = encodeRows(Array.isArray(payload.rows) ? payload.rows : [], w.state);
    if (!r.ok) {
      // reason → 契约 C-69 文案；一个字都不写
      const text = REASON_TEXT[r.reason] || '磁盘写入失败：未知原因';
      return { success: false, error: text.includes('写入会话') ? `${text}：${writerId}` : text };
    }
    if (!r.text) return { success: true, data: { rows: 0, bytes: 0 } };
    try {
      fs.writeSync(w.fd, r.text, null, 'utf8');
      return { success: true, data: { rows: r.rows, bytes: r.bytes } };
    } catch (e) {
      return { success: false, error: `磁盘写入失败：${e.message}` };
    }
  });

  /**
   * 收尾：写 JSON 的 `]` → fsync → close → rename（正式文件在这一刻才出现）。
   * data: { path, rows, bytes, ms }
   */
  ipcMain.handle('tdg:write-finish', async (_event, payload = {}) => {
    const writerId = String((payload && payload.writerId) || '');
    const w = writers.get(writerId);
    if (!w) return closedError(writerId);
    try {
      const tail = closeChunk(w.state);
      if (tail) {
        fs.writeSync(w.fd, tail, null, 'utf8');
        w.state.bytes += textBytes(tail);
      }
      try { fs.fsyncSync(w.fd); } catch { /* 部分文件系统/网络盘不支持 fsync，别因此让导出失败 */ }
      fs.closeSync(w.fd);
      fs.renameSync(w.part, w.target);
      writers.delete(writerId);
      w.state.closed = true;
      return {
        success: true,
        data: { path: w.target, rows: w.state.rows, bytes: w.state.bytes, ms: Date.now() - w.startMs },
      };
    } catch (e) {
      // 失败也不能把半成品留在磁盘上
      discardWriter(writerId);
      return { success: false, error: `磁盘写入失败：${e.message}` };
    }
  });

  /**
   * 取消：关 fd + 删 `.part`，返回 `{ success:false, canceled:true, data:{ removed, path } }`
   * —— 用户主动取消不是错误，界面不该弹红（[C-03]）。
   */
  ipcMain.handle('tdg:write-abort', async (_event, payload = {}) => {
    const writerId = String((payload && payload.writerId) || '');
    const done = discardWriter(writerId);
    if (!done) return closedError(writerId);
    return { success: false, canceled: true, data: done };
  });
}

module.exports = { registerTdgIpc };