'use strict';

/**
 * 应用改名后的旧数据目录探测（纯逻辑，便于单测）。
 *
 * 背景（1.9.0 事故）：1.8.0 把应用名从「测试工具」改成「测试中台」，
 * 假设旧 userData 是 `%APPDATA%\测试工具`；实际历史上还出现过
 * `%APPDATA%\password-manager`（package.json 的 name，没配 productName 时用这个）
 * 和 `%APPDATA%\测试工作台`。结果真库在 password-manager 里没被搬走，
 * 用户装完看到的是空库。
 *
 * 结论：**不要按名字猜，按「里面有没有 vault.enc」判定**。
 */

const LEGACY_NAMES = ['测试工具', '测试工作台', 'password-manager', 'testtool', 'TestTool'];

/**
 * @param {{
 *   appData: string,
 *   currentUserData: string,
 *   candidates?: string[],
 *   isDir: (p: string) => boolean,
 *   hasVault: (p: string) => boolean,
 *   currentHasVault: boolean,
 * }} input
 * @returns {{ legacyDir: string, copy: boolean, reason: string, found: string[] }}
 */
function planLegacyMigration(input) {
  const join = (a, b) => `${String(a).replace(/[\\/]+$/, '')}\\${b}`;
  const names = input.candidates && input.candidates.length ? input.candidates : LEGACY_NAMES;
  const found = [];
  for (const name of names) {
    const dir = join(input.appData, name);
    if (!input.isDir(dir)) continue;
    if (String(dir).toLowerCase() === String(input.currentUserData).toLowerCase()) continue;
    if (!input.hasVault(dir)) continue;
    found.push(dir);
  }
  if (found.length === 0) return { legacyDir: '', copy: false, reason: 'no-legacy-vault', found };
  // 多个旧库时取「最近修改」的那个由调用方决定顺序，这里按候选顺序取第一个
  const legacyDir = found[0];
  if (input.currentHasVault) return { legacyDir, copy: false, reason: 'current-already-has-vault', found };
  return { legacyDir, copy: true, reason: 'current-empty', found };
}

/** 迁移要搬的文件/目录（Chromium 缓存目录不搬） */
const MIGRATE_ITEMS = [
  'vault.enc',
  'vault.enc.bak',
  'data-location.json',
  'settings.json',
  'zentao-notify-state.json',
  'audit.log',
  'backups',
  'attachments',
];

module.exports = { LEGACY_NAMES, MIGRATE_ITEMS, planLegacyMigration };
