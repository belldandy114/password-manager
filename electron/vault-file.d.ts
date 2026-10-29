/** 声明文件：让渲染层单测可以直接 import electron/vault-file.js */

export declare const ALGO: string;
export declare const SALT_LENGTH: number;
export declare const IV_LENGTH: number;
export declare const TAG_LENGTH: number;
export declare const MIN_BYTES: number;

export interface VaultFileInspection {
  ok: boolean;
  bytes: number;
  error?: string;
}

export declare function inspectVaultFile(text: string): VaultFileInspection;
