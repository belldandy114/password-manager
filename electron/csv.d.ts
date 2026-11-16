/** electron/csv.js 的类型声明（供渲染层单测 import 使用） */

export interface ImportedCustomField {
  id?: string;
  name: string;
  value: string;
  secret?: boolean;
}

export interface ImportedAccount {
  id?: string;
  role: string;
  username: string;
  password: string;
  note?: string;
}

export interface ImportedAttachment {
  id: string;
  name: string;
  size?: number;
  addedAt?: string;
  mime?: string;
  kind?: 'image';
}

export interface ImportedRecord {
  id?: string;
  name: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  envType: string;
  tags: string[];
  totpSecret?: string;
  favorite?: boolean;
  passwordUpdatedAt?: string;
  customFields?: ImportedCustomField[];
  accounts?: ImportedAccount[];
  attachments?: ImportedAttachment[];
  createdAt?: string;
  updatedAt?: string;
}

/** 导出列清单（顺序即列顺序），导出端与导入端共用 */
export declare const CSV_FIELDS: string[];
/** 列名 → 中文表头 */
export declare const CSV_HEADERS: Record<string, string>;
/** 需要 JSON 序列化的结构化字段 */
export declare const JSON_FIELDS: string[];

export declare function parseCsv(text: string): string[][];
export declare function normalizeImportRecords(records: unknown): ImportedRecord[];
export declare function extractTotpSecret(raw: unknown): string;
export declare function serializeField(key: string, value: unknown): string;
export declare function stripSecrets(entry: Record<string, unknown>): Record<string, unknown>;
export declare function parseJsonField(raw: unknown): unknown[] | undefined;
export declare const IMPORT_FIELD_ALIASES: Record<string, string[]>;
