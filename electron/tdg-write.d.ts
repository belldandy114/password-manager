/** 2.2 流式写盘的纯函数层（契约 C-65 ~ C-69，拆分 S-57〜S-60）。本文件不 require fs / electron。 */

export type TdgFormat = 'csv' | 'json' | 'txt';

export interface TdgLimits {
  maxRowsPerBatch: number;
  maxLineBytes: number;
  maxRows: number;
  maxBytes: number;
}

export interface TdgWriterState {
  format: string;
  columns: string[] | null;
  bom: boolean;
  rows: number;
  bytes: number;
  batches: number;
  closed: boolean;
  limits: TdgLimits;
}

export type TdgRejectReason =
  | 'closed'
  | 'bad-format'
  | 'batch-rows'
  | 'line-bytes'
  | 'rows-cap'
  | 'bytes-cap';

export type TdgEncodeResult =
  | { ok: true; text: string; rows: number; bytes: number }
  | { ok: false; reason: TdgRejectReason };

export declare const TDG_LIMITS: Readonly<TdgLimits>;
export declare const FORMATS: Readonly<string[]>;

/** UTF-8 字节数（不是字符数） */
export declare function textBytes(s: string): number;

export declare function createWriterState(opts?: {
  format?: string;
  columns?: string[];
  bom?: boolean;
  limits?: Partial<TdgLimits>;
}): TdgWriterState;

/** 首块前缀：csv+BOM → \uFEFF；json → '['；txt → '' */
export declare function openChunk(state: TdgWriterState, format?: string): string;

/** 表头行：仅 csv 有内容（列名按 RFC4180 转义 + \r\n） */
export declare function headersOf(columns: string[], format: string): string;

/** 一批行 → 可直接追加的文本；超限返回 reason 且不改 state */
export declare function encodeRows(rows: Array<string | string[]>, state: TdgWriterState): TdgEncodeResult;

/** 收尾：json 给 ']'（有记录时 '\n]'）；csv/txt 空串 */
export declare function closeChunk(state: TdgWriterState): string;