/**
 * 表格按列脱敏（纯函数，无 DOM / 无 IPC）。
 *
 * 场景：接口返回的 CSV、数据库导出的 TSV、同事发来的样例数据，往往只有某一列
 * （手机号列、身份证列）需要打码，整段文本脱敏反而会把 ID、时间戳搞乱。
 * 所以这里做「解析成表格 → 只处理勾选的列 → 还原成同样格式的文本」。
 *
 * 只用两个字符做分隔（逗号 / 制表符 / 分号），按 RFC 4180 处理引号与内嵌换行。
 */

import { redactText, type RedactKind, type RedactStyle, type RedactHit } from './redact';

export type Delimiter = ',' | '\t' | ';';

export interface RedactTable {
  /** 第一行；没有表头时是空数组，数据全在 rows 里 */
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
  /** 原文本是否带表头（首行不像数据时判定为表头） */
  hasHeader: boolean;
}

const CANDIDATES: Delimiter[] = [',', '\t', ';'];

/** 按首行出现次数挑分隔符；都挑不出来按逗号处理 */
export function detectDelimiter(text: string): Delimiter {
  const first = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
  let best: Delimiter = ',';
  let bestCount = 0;
  for (const d of CANDIDATES) {
    // 只看引号外的分隔符，避免把 "a,b",c 里的逗号算进去
    let count = 0;
    let inQuote = false;
    for (let i = 0; i < first.length; i += 1) {
      const ch = first[i];
      if (ch === '"') inQuote = !inQuote;
      else if (!inQuote && ch === d) count += 1;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/** 解析成二维数组；支持引号包裹、双引号转义、字段内换行 */
export function parseDelimited(text: string, delimiter?: Delimiter): string[][] {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const d = delimiter || detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; }
        else inQuote = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') { inQuote = true; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\r') continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // 末尾空行丢掉（文件结尾的换行不算数据）
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

/** 单元格需要引号包裹的情形 */
const needsQuote = (cell: string, d: Delimiter) =>
  cell.includes('"') || cell.includes('\n') || cell.includes('\r') || cell.includes(d);

/** 还原成分隔文本；按需加引号 */
export function toDelimited(rows: string[][], delimiter: Delimiter = ','): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const v = String(cell == null ? '' : cell);
          return needsQuote(v, delimiter) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(delimiter),
    )
    .join('\n');
}

/** 首行是否像表头：全是非纯数字、且至少有一个非空单元格 */
export function looksLikeHeader(first: string[]): boolean {
  const cells = first.map((c) => (c || '').trim()).filter(Boolean);
  if (!cells.length) return false;
  return cells.every((c) => !/^-?\d+(\.\d+)?$/.test(c));
}

/** 文本 → 结构化的表 */
export function readTable(text: string, delimiter?: Delimiter): RedactTable {
  const d = delimiter || detectDelimiter(text);
  const raw = parseDelimited(text, d);
  if (!raw.length) return { headers: [], rows: [], delimiter: d, hasHeader: false };
  const hasHeader = looksLikeHeader(raw[0]);
  return {
    headers: hasHeader ? raw[0] : [],
    rows: hasHeader ? raw.slice(1) : raw,
    delimiter: d,
    hasHeader,
  };
}

export interface ColumnRedactOptions {
  /** 要脱敏的列下标（headers 与 rows 用同一套下标；无表头时也是 0 起） */
  columns: number[];
  kinds: RedactKind[];
  style?: RedactStyle;
  customWords?: string[];
}

export interface ColumnRedactResult {
  rows: string[][];
  /** 每列命中数，下标与 columns 对齐 */
  perColumn: Array<{ column: number; hits: number }>;
  total: number;
  /** token 风格下的合并映射表 */
  mapping: string;
  /** 所有命中明细，便于 UI 展示 */
  hits: RedactHit[];
}

/**
 * 只对指定列做脱敏，其余列原样返回。
 * 列下标越界的直接忽略（文件列数和用户勾选可能对不上）。
 */
export function redactColumns(rows: string[][], opts: ColumnRedactOptions): ColumnRedactResult {
  const cols = Array.from(new Set(opts.columns || []))
    .filter((i) => Number.isInteger(i) && i >= 0)
    .sort((a, b) => a - b);
  const hits: RedactHit[] = [];
  const counts = new Map<number, number>();
  const mappings: string[] = [];

  const out = rows.map((row) =>
    row.map((cell, idx) => {
      if (!cols.includes(idx)) return cell;
      const r = redactText(cell, opts);
      if (!r.hits.length) return cell;
      hits.push(...r.hits);
      counts.set(idx, (counts.get(idx) || 0) + r.hits.length);
      if (r.mapping) mappings.push(r.mapping);
      return r.text;
    }),
  );

  return {
    rows: out,
    perColumn: cols.map((column) => ({ column, hits: counts.get(column) || 0 })),
    total: hits.length,
    mapping: mappings.join('\n'),
    hits,
  };
}

/** 把列下标翻译成表头名（没有表头时用「第 N 列」） */
export function columnLabel(headers: string[], index: number): string {
  const name = (headers[index] || '').trim();
  return name || `第 ${index + 1} 列`;
}
