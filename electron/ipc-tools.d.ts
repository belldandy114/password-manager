/** 声明文件：让渲染层单测可以 import electron/ipc-tools.js */

export declare function base32Decode(input: string): Uint8Array;

export declare function totpAt(secret: string, atMs: number, digits?: number, period?: number): string | null;

export declare function generatePassword(opts?: {
  length?: number;
  lower?: boolean;
  upper?: boolean;
  digits?: boolean;
  symbols?: boolean;
  excludeAmbiguous?: boolean;
}): { ok: boolean; password?: string; error?: string };

export declare function registerToolsIpc(): void;
