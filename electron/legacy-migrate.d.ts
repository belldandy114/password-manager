/** 声明文件：让渲染层单测可以 import electron/legacy-migrate.js */

export interface MigrationPlan {
  legacyDir: string;
  copy: boolean;
  reason: string;
  found: string[];
}

export declare const LEGACY_NAMES: string[];
export declare const MIGRATE_ITEMS: string[];
export declare function planLegacyMigration(input: {
  appData: string;
  currentUserData: string;
  candidates?: string[];
  isDir: (p: string) => boolean;
  hasVault: (p: string) => boolean;
  currentHasVault: boolean;
}): MigrationPlan;
