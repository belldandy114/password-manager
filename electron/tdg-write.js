'use strict';

/**
 * tdg-write.js —— 十万级造数「流式写盘」的纯函数层（模块 2.2 / 契约 C-65 ~ C-69，拆分 S-57〜S-60）。
 *
 * 为什么单独成模块：**跨批的分隔符与转义最容易错**——
 * 第 1 批末尾和第 2 批开头拼起来多一个逗号、少一个行尾、JSON 中间冒出 `,,`，
 * 这些在界面上完全看不出来（文件"看起来有内容"），只有把三批拼回去反解才会暴露。
 * 所以分隔符/首尾字符/转义/四项上限判定全部收在这里，能用 vitest 直接 import，
 * 不塞进 `ipc-tdg.js`（那里 `require('electron')`，一塞就只能在 Electron 里跑）。
 *
 * 分工（契约 §4.1 矩阵 + C-68）：
 *   - 造数算法在渲染层（`src/utils/tdg/`，W3）；
 *   - **本模块**：行内转义（RFC4180）、行尾、批间连接符、BOM/首尾字符、累计上限；
 *   - `ipc-tdg.js`：只做 fd 生命周期（open/write/fsync/rename/unlink）与 reason→文案映射。
 *
 * 本模块**不 require fs / electron / child_process**，纯字符串运算 + TextEncoder。
 */

/** 四项硬上限（契约 §2.5 + C-67）；测试可用 opts.limits 覆盖小值来构造边界 */
const TDG_LIMITS = Object.freeze({
  /** 单批最多多少行 */
  maxRowsPerBatch: 5000,
  /** 单行最多多少字节（转义后的行内容，不含行尾） */
  maxLineBytes: 64 * 1024,
  /** 单个文件累计最多多少行 */
  maxRows: 1000000,
  /** 单个文件累计最多多少字节 */
  maxBytes: 512 * 1024 * 1024,
});

const FORMATS = Object.freeze(['csv', 'json', 'txt']);

const encoder = new TextEncoder();

/**
 * UTF-8 字节数。**不能用 `s.length`**：中文一个字 3 字节、emoji 4 字节，
 * 用字符数算上限会把「5000 行中文」当成远小于实际的字节量，512 MB 的上限形同虚设。
 * @param {string} s
 * @returns {number}
 */
function textBytes(s) {
  return encoder.encode(String(s == null ? '' : s)).length;
}

/**
 * 建一个 writer 的状态。计数全为 0；`limits` 可覆盖（默认 TDG_LIMITS，测试用来造边界）。
 * @param {{ format?: string, columns?: string[], bom?: boolean, limits?: Partial<typeof TDG_LIMITS> }} [opts]
 */
function createWriterState(opts = {}) {
  const o = opts || {};
  return {
    format: String(o.format || ''),
    columns: Array.isArray(o.columns) ? o.columns.map((c) => String(c)) : null,
    bom: !!o.bom,
    rows: 0,
    bytes: 0,
    batches: 0,
    closed: false,
    limits: { ...TDG_LIMITS, ...(o.limits || {}) },
  };
}

/**
 * 首块前缀：csv 带 BOM 时给 `\uFEFF`；json 给 `[`；txt 空串。
 * @param {ReturnType<typeof createWriterState>} state
 * @param {string} [format] 显式指定格式（缺省用 state.format）
 * @returns {string}
 */
function openChunk(state, format) {
  const fmt = String(format || (state && state.format) || '');
  if (fmt === 'json') return '[';
  if (fmt === 'csv') return state && state.bom ? '\uFEFF' : '';
  return '';
}

/** CSV 单元格转义（RFC4180：含逗号/双引号/CR/LF 才加引号，内部引号翻倍） */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 表头行（只对 csv 有内容）：列名按 CSV 规则转义后以 `\r\n` 结尾。
 * @param {string[]} columns
 * @param {string} format
 * @returns {string}
 */
function headersOf(columns, format) {
  if (String(format || '') !== 'csv') return '';
  if (!Array.isArray(columns) || !columns.length) return '';
  return `${columns.map(csvCell).join(',')}\r\n`;
}

/** 一行 → 该格式的行内文本（不含行尾/批间连接符） */
function rowBody(row, state) {
  if (state.format === 'csv') {
    return Array.isArray(row) ? row.map(csvCell).join(',') : csvCell(row);
  }
  if (state.format === 'txt') {
    return Array.isArray(row) ? row.map((v) => String(v == null ? '' : v)).join('\t') : String(row == null ? '' : row);
  }
  // json：有列名给对象，没有给数组（调用方自己保证记录形状一致）
  if (Array.isArray(row) && Array.isArray(state.columns)) {
    const o = {};
    state.columns.forEach((k, i) => { o[k] = row[i] == null ? '' : row[i]; });
    return JSON.stringify(o);
  }
  return JSON.stringify(Array.isArray(row) ? row : String(row == null ? '' : row));
}

/**
 * 把一批行编码成「可直接追加到文件」的文本，并推进累计计数。
 *
 * **返回前一定先判定再提交**：任何一项超限都返回 `{ok:false, reason}` 且**不改 state**，
 * 这样超限之后 writer 仍然可用、累计计数也不会算错（契约 §2.5 / 验收第 2 条）。
 *
 * @param {(string|string[])[]} rows 一批行；行内字段请传数组（由本函数按 RFC4180 转义），
 *                                   已拼好的整行可传字符串（原样使用，不二次转义）
 * @param {ReturnType<typeof createWriterState>} state
 * @returns {{ok:true,text:string,rows:number,bytes:number}
 *          |{ok:false,reason:'closed'|'bad-format'|'batch-rows'|'line-bytes'|'rows-cap'|'bytes-cap'}}
 */
function encodeRows(rows, state) {
  if (!state || typeof state !== 'object') return { ok: false, reason: 'closed' };
  if (state.closed) return { ok: false, reason: 'closed' };
  if (!FORMATS.includes(String(state.format))) return { ok: false, reason: 'bad-format' };

  const list = Array.isArray(rows) ? rows : [];
  const limits = state.limits || TDG_LIMITS;
  if (list.length > limits.maxRowsPerBatch) return { ok: false, reason: 'batch-rows' };
  if (!list.length) return { ok: true, text: '', rows: 0, bytes: 0 };

  const bodies = [];
  for (const row of list) {
    const body = rowBody(row, state);
    // 单行上限按「转义后的行内容」算，不含行尾——行尾是格式开销，不该吃掉单行预算
    if (textBytes(body) > limits.maxLineBytes) return { ok: false, reason: 'line-bytes' };
    bodies.push(body);
  }

  let text;
  if (state.format === 'json') {
    // 批间恰好一个逗号 + 换行：第一批不加前缀，之后每批都加
    const prefix = state.batches > 0 ? ',\n' : '';
    text = prefix + bodies.join(',\n');
  } else if (state.format === 'csv') {
    text = bodies.map((b) => `${b}\r\n`).join('');
  } else {
    text = bodies.map((b) => `${b}\n`).join('');
  }

  const bytes = textBytes(text);
  if (state.rows + list.length > limits.maxRows) return { ok: false, reason: 'rows-cap' };
  if (state.bytes + bytes > limits.maxBytes) return { ok: false, reason: 'bytes-cap' };

  state.rows += list.length;
  state.bytes += bytes;
  state.batches += 1;
  return { ok: true, text, rows: list.length, bytes };
}

/**
 * 收尾文本：json 给 `]`（有记录时前面补换行）；csv/txt 给空串（末行行尾已经在 encodeRows 里给了）。
 * @param {ReturnType<typeof createWriterState>} state
 * @returns {string}
 */
function closeChunk(state) {
  if (!state || typeof state !== 'object') return '';
  if (state.format !== 'json') return '';
  return state.batches > 0 ? '\n]' : ']';
}

module.exports = {
  TDG_LIMITS, FORMATS, textBytes, createWriterState, openChunk, headersOf, encodeRows, closeChunk,
};