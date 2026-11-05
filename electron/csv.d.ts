/** electron/csv.js 的类型声明（供渲染层单测 import 使用） */

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
  createdAt?: string;
  updatedAt?: string;
}

export declare function parseCsv(text: string): string[][];
export declare function normalizeImportRecords(records: unknown): ImportedRecord[];
export declare function extractTotpSecret(raw: unknown): string;
export declare const IMPORT_FIELD_ALIASES: Record<string, string[]>;