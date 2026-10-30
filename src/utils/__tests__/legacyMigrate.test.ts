import { describe, it, expect } from 'vitest';
import { planLegacyMigration, LEGACY_NAMES } from '../../../electron/legacy-migrate.js';

const APPDATA = 'C:\\Users\\u\\AppData\\Roaming';
const CUR = APPDATA + '\\测试中台';

/** 造一个假的文件系统：只有列出的目录存在且「有 vault」 */
function fakeFs(dirsWithVault: string[], dirs: string[] = []) {
  const withVault = new Set(dirsWithVault);
  const all = new Set([...dirsWithVault, ...dirs]);
  return {
    isDir: (p: string) => all.has(p),
    hasVault: (p: string) => withVault.has(p),
  };
}

describe('legacy-migrate：按「有 vault.enc」判定旧目录', () => {
  it('真库在 password-manager 时也能找到（1.9.0 事故场景）', () => {
    const fs = fakeFs([APPDATA + '\\password-manager'], [APPDATA + '\\测试工具']);
    const plan = planLegacyMigration({ appData: APPDATA, currentUserData: CUR, currentHasVault: false, ...fs });
    expect(plan.copy).toBe(true);
    expect(plan.legacyDir).toBe(APPDATA + '\\password-manager');
    expect(plan.reason).toBe('current-empty');
  });

  it('新目录已经有 vault 时不覆盖（交给人手动恢复）', () => {
    const fs = fakeFs([APPDATA + '\\测试工具']);
    const plan = planLegacyMigration({ appData: APPDATA, currentUserData: CUR, currentHasVault: true, ...fs });
    expect(plan.copy).toBe(false);
    expect(plan.reason).toBe('current-already-has-vault');
    expect(plan.legacyDir).toBe(APPDATA + '\\测试工具');
  });

  it('只有空壳旧目录（没有 vault.enc）时什么都不做', () => {
    const fs = fakeFs([], [APPDATA + '\\测试工具', APPDATA + '\\测试工作台']);
    const plan = planLegacyMigration({ appData: APPDATA, currentUserData: CUR, currentHasVault: false, ...fs });
    expect(plan.copy).toBe(false);
    expect(plan.reason).toBe('no-legacy-vault');
    expect(plan.found).toEqual([]);
  });

  it('不会把当前目录当成旧目录', () => {
    const fs = fakeFs([CUR]);
    const plan = planLegacyMigration({ appData: APPDATA, currentUserData: CUR, currentHasVault: false, ...fs });
    expect(plan.copy).toBe(false);
  });

  it('多个旧库都找到时按候选顺序取第一个，并列出全部', () => {
    const fs = fakeFs([APPDATA + '\\password-manager', APPDATA + '\\测试工具']);
    const plan = planLegacyMigration({ appData: APPDATA, currentUserData: CUR, currentHasVault: false, ...fs });
    expect(plan.legacyDir).toBe(APPDATA + '\\测试工具');
    expect(plan.found.length).toBe(2);
  });

  it('候选名覆盖历史上的三种命名', () => {
    expect(LEGACY_NAMES).toContain('测试工具');
    expect(LEGACY_NAMES).toContain('测试工作台');
    expect(LEGACY_NAMES).toContain('password-manager');
  });
});
