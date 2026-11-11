/** 声明文件：让渲染层单测可以 `import { normalizeVault } from '../../../electron/vault-schema.js'` */

export declare const VAULT_COLLECTIONS: string[];

/** 当前库结构版本（迁移的终点） */
export declare const VAULT_SCHEMA_VERSION: number;

/** 迁移表：源版本 → 升到下一版的纯函数 */
export declare const MIGRATIONS: Record<number, (v: Record<string, unknown>) => Record<string, unknown>>;

export interface NormalizedVault {
  /** 库结构版本；比 VAULT_SCHEMA_VERSION 大表示库来自更新版本的应用 */
  schemaVersion: number;
  entries: unknown[];
  tags: unknown[];
  history: Record<string, unknown>;
  [collection: string]: unknown;
}

export interface MigrateResult {
  vault: Record<string, unknown>;
  /** 迁移前声明的版本（没写版本号即 1） */
  from: number;
  /** 迁移后的版本 */
  to: number;
  /** 实际执行过的迁移步骤（源版本号列表），空数组表示无需迁移 */
  applied: number[];
  /** 库来自更新版本的应用：不做迁移，保留未知字段 */
  future: boolean;
}

export declare function declaredVersion(v: unknown): number;

export declare function migrateVault(v: unknown): MigrateResult;

export declare function normalizeVault(v: unknown): NormalizedVault;
