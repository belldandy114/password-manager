/** 声明文件：让渲染层单测可以 `import { normalizeVault } from '../../../electron/vault-schema.js'` */

export declare const VAULT_COLLECTIONS: string[];

export interface NormalizedVault {
  entries: unknown[];
  tags: unknown[];
  history: Record<string, unknown>;
  [collection: string]: unknown;
}

export declare function normalizeVault(v: unknown): NormalizedVault;
