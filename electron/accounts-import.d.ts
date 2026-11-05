/** 声明文件：让渲染层单测可以 import electron/accounts-import.js */

export interface ParsedAccount {
  system: string;
  role: string;
  username: string;
  password: string;
  note: string;
}

export declare const DAY_MS: number;
export declare function parseAccountLines(text: string): { rows: ParsedAccount[]; bad: { line: number; text: string }[] };
export declare function daysSince(iso: string, now?: number): number | null;
export declare function needsRotate(iso: string, days?: number, now?: number): boolean;
