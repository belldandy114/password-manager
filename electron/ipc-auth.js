'use strict';

/**
 * 主密码 / 安全词 / 找回密码相关 IPC（auth:* 共 9 个）。
 *
 * 从 main.js 的 setupIpcHandlers() 里搬出来，逐行保持原逻辑不变，只把
 * 「会话状态」与「加解密/读写」换成注入的 getter/setter：
 *   - currentPassword / appUnlocked 仍住在 main.js（别处也在用），这里只读写；
 *   - 登录失败计数与冷却窗口是纯本模块状态，跟着搬进来。
 *
 * 注意：crypto 必须在本文件 require —— 第 4 步搬禅道时漏过一次，
 * 结果 ztLoginAttempt 抛 ReferenceError 被 catch 吞掉，表现成「登录页返回 HTTP 404」。
 */

const crypto = require('crypto');
const fs = require('fs');
const { ipcMain } = require('electron');

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 30000;

function registerAuthIpc(deps) {
  const {
    DATA_DIR,
    DATA_FILE,
    KEY_ITERATIONS,
    migrateLegacyInto,
    clearCaches,
    loadSettings,
    saveSettings,
    loadVault,
    saveVault,
    loadTrash,
    saveTrash,
    encrypt,
    decrypt,
    getPassword,
    setPassword,
    setUnlocked,
    repersistClipHistory,
    wipeClipHistory,
    reencryptAttachments,
  } = deps;

  // Brute-force guard: 5 wrong passwords in a row → 30s cool-down (in-memory, resets on restart).
  let loginFailures = 0;
  let loginLockedUntil = 0;

  // ---- Master password ----
  ipcMain.handle('auth:is-setup', () => {
    // 首次启动时把旧版本数据搬过来（只在还没有 vault.enc 时）
    const migrated = migrateLegacyInto(DATA_DIR);
    if (migrated.copied > 0) clearCaches();
    const settings = loadSettings();
    if (settings && settings.masterPasswordHash) return true;
    /**
     * settings 读不出来但**库文件还在** → 仍然算「已初始化」。
     *
     * 否则会走进一条死路：settings.json 损坏 → 启动清理隔离它、保留 vault.enc →
     * 这里返回 false → 登录页进「初始化」模式 → 用户设新密码 → 老库被空库覆盖。
     * 库文件才是「有没有初始化过」的唯一可信依据；settings 只是可重建的元数据
     * （salt / hash / hint），`auth:verify` 会用「能否解开库」来验证密码并顺手重建它。
     */
    return fs.existsSync(DATA_FILE);
  });

  ipcMain.handle('auth:setup', (_event, { password, hint }) => {
    /**
     * 防「重新初始化把老库盖掉」。
     *
     * 触发路径（2026-11 实测）：settings.json 损坏 → 启动清理把它隔离成
     * `settings.json.corrupt-<ts>` 并**保留 vault.enc**（这是对的，库不能删）→
     * 但 `auth:is-setup` 读不到 settings 就返回 false → 登录页进入「初始化」模式 →
     * 用户设一个新主密码 → 这里 `saveVault({entries:[],tags:[]})` 直接把老库覆盖成空库。
     * 老库文件还在磁盘上，但已经被空库替换，等于静默丢数据。
     *
     * 所以：**库文件已存在时拒绝初始化**，让用户走「用原主密码解锁」（会自动重建 settings）
     * 或「从备份恢复」。只有确实没有库文件时才允许初始化。
     */
    if (fs.existsSync(DATA_FILE)) {
      return {
        success: false,
        code: 'vault-exists',
        error: '检测到已有密码库文件，不能重新初始化（会覆盖原有数据）。请用原主密码解锁，或从备份恢复。',
      };
    }
    clearCaches();
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    const settings = { masterPasswordHash: hash, salt, hint: hint || '', createdAt: new Date().toISOString() };
    // Store the data encryption password (derived from master password)
    const dataKey = crypto.createHash('sha256').update(password + salt).digest('hex');
    settings.dataKeyEncrypted = encrypt(dataKey, password);
    saveSettings(settings);
    // Init empty vault
    saveVault({ entries: [], tags: [] }, password);
    return { success: true };
  });

  /**
   * settings 丢失/损坏时，用「能否解开库」验证主密码并重建 settings。
   *
   * 为什么可以这样：vault.enc 的 AES-GCM 认证标签本身就是密码正确性的证明 ——
   * 密码错了 `decrypt` 返回 null，不存在「蒙对」的可能。而 settings 里的
   * masterPasswordHash 只是同一件事的另一种存法，丢了不影响安全性。
   *
   * @returns {{ ok: boolean, settings?: any, error?: string }}
   */
  function rebuildSettingsFromVault(password) {
    if (!fs.existsSync(DATA_FILE)) return { ok: false, error: '没有密码库文件' };
    const vault = loadVault(password);
    if (!vault) return { ok: false, error: '密码错误' };
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    const settings = {
      masterPasswordHash: hash,
      salt,
      hint: '',
      createdAt: new Date().toISOString(),
      rebuiltAt: new Date().toISOString(),
    };
    const dataKey = crypto.createHash('sha256').update(password + salt).digest('hex');
    settings.dataKeyEncrypted = encrypt(dataKey, password);
    saveSettings(settings);
    return { ok: true, settings };
  }

  ipcMain.handle('auth:verify', (_event, { password }) => {
    const wait = loginLockedUntil - Date.now();
    if (wait > 0) {
      return { success: false, error: `密码错误次数过多，请 ${Math.ceil(wait / 1000)} 秒后再试`, retryAfterMs: wait };
    }
    const settings = loadSettings();
    /**
     * settings 缺失/损坏但库还在：走「解密即验证」并重建 settings。
     * 这是 settings.json 损坏后用户唯一的自助出口 —— 否则登录页会一直停在
     * 「未初始化」，而初始化又被 vault-exists 挡住，等于把用户锁在门外。
     */
    if (!settings || !settings.masterPasswordHash) {
      if (!fs.existsSync(DATA_FILE)) return { success: false, error: '未初始化' };
      const rebuilt = rebuildSettingsFromVault(password);
      if (!rebuilt.ok) {
        loginFailures++;
        if (loginFailures >= LOGIN_MAX_FAILURES) {
          loginFailures = 0;
          loginLockedUntil = Date.now() + LOGIN_LOCK_MS;
          return { success: false, error: `连续错误 ${LOGIN_MAX_FAILURES} 次，请 ${LOGIN_LOCK_MS / 1000} 秒后再试`, retryAfterMs: LOGIN_LOCK_MS };
        }
        return { success: false, error: `密码错误（还可尝试 ${LOGIN_MAX_FAILURES - loginFailures} 次）` };
      }
      loginFailures = 0;
      loginLockedUntil = 0;
      console.warn('[auth] settings.json 缺失或损坏，已用主密码验证并重建（库内容未改动）');
      return { success: true, hint: '', rebuilt: true };
    }
    const hash = crypto.pbkdf2Sync(password, settings.salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    if (hash !== settings.masterPasswordHash) {
      loginFailures++;
      if (loginFailures >= LOGIN_MAX_FAILURES) {
        loginFailures = 0;
        loginLockedUntil = Date.now() + LOGIN_LOCK_MS;
        return { success: false, error: `连续错误 ${LOGIN_MAX_FAILURES} 次，请 ${LOGIN_LOCK_MS / 1000} 秒后再试`, retryAfterMs: LOGIN_LOCK_MS };
      }
      return { success: false, error: `密码错误（还可尝试 ${LOGIN_MAX_FAILURES - loginFailures} 次）` };
    }
    // Verify we can decrypt the vault
    const vault = loadVault(password);
    if (!vault) return { success: false, error: '数据损坏，无法解密（可尝试从备份恢复）', code: 'vault-corrupt' };
    loginFailures = 0;
    loginLockedUntil = 0;
    return { success: true, hint: settings.hint || '' };
  });

  ipcMain.handle('auth:get-hint', () => {
    const settings = loadSettings();
    return settings ? (settings.hint || '') : '';
  });

  ipcMain.handle('auth:change-password', (_event, { oldPassword, newPassword }) => {
    const settings = loadSettings();
    if (!settings) return { success: false, error: '未初始化' };
    const hash = crypto.pbkdf2Sync(oldPassword, settings.salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    if (hash !== settings.masterPasswordHash) return { success: false, error: '原密码错误' };
    // Re-encrypt data with new password
    const vault = loadVault(oldPassword);
    if (!vault) return { success: false, error: '数据解密失败' };
    // Update settings
    const newSalt = crypto.randomBytes(32).toString('hex');
    const newHash = crypto.pbkdf2Sync(newPassword, newSalt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    settings.masterPasswordHash = newHash;
    settings.salt = newSalt;
    const dataKey = crypto.createHash('sha256').update(newPassword + newSalt).digest('hex');
    settings.dataKeyEncrypted = encrypt(dataKey, newPassword);
    // Re-encrypt recovery data with new password if security word exists
    if (settings.securityWordHash && settings.recoveryData) {
      const decryptedRecovery = decrypt(settings.recoveryData, oldPassword);
      if (decryptedRecovery) {
        settings.recoveryData = encrypt(decryptedRecovery, newPassword);
      }
    }
    saveSettings(settings);
    // Re-save vault with new password
    saveVault(vault, newPassword);
    // Re-save trash with new password
    const trash = loadTrash(oldPassword);
    if (trash) saveTrash(trash, newPassword);
    /**
     * 附件也是用会话主密码加密落盘的（attachments/<id>.enc），必须一起重加密。
     * 漏掉这一步的后果是「改密后所有附件永久失效」：文件还在、大小也对，
     * 但 AES-GCM 认证失败，界面统一显示「附件不存在或已损坏」。
     *
     * 必须在 clearCaches() **之前**做：那时旧密码的派生 key 还在缓存里，
     * 解密整批附件不用重新跑 600k 次 PBKDF2。
     *
     * 失败不阻断改密（密码确实已经换了，返回 false 会让用户以为没改成而反复重试）：
     * 附件重加密是「全有或全无」的，失败时一个文件都没动，把数量回传给界面提示即可。
     */
    let attachments = { total: 0, ok: 0, failed: 0 };
    try {
      if (typeof reencryptAttachments === 'function') {
        attachments = reencryptAttachments(oldPassword, newPassword);
      }
    } catch (e) {
      attachments = { total: 0, ok: 0, failed: 0, errors: [e.message] };
    }
    // The session now belongs to the new password — cached key/vault still hold the old
    // one, so drop them and continue the session under the new password.
    clearCaches();
    setPassword(newPassword);
    // 剪贴板历史是加密落盘的，主密码换了必须用新密码重写一次，否则下次解不开
    try { repersistClipHistory?.(newPassword); } catch { /* 重写失败不影响改密 */ }
    const out = { success: true, attachments };
    if (attachments.failed > 0) {
      out.warning = `主密码已修改，但有 ${attachments.failed} 个附件无法用原密码解开，未做重加密（可用「库自检」查看）`;
    }
    return out;
  });

  // ---- Security word (for password recovery) ----
  ipcMain.handle('auth:set-security-word', (_event, { password, securityWord }) => {
    const settings = loadSettings();
    if (!settings) return { success: false, error: '未初始化' };
    // Verify master password
    const hash = crypto.pbkdf2Sync(password, settings.salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    if (hash !== settings.masterPasswordHash) return { success: false, error: '主密码错误' };
    if (!securityWord || securityWord.length < 2) return { success: false, error: '安全词至少2个字符' };
    // Store salted hash of security word for verification
    const swSalt = crypto.randomBytes(32).toString('hex');
    const swHash = crypto.pbkdf2Sync(securityWord, swSalt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    settings.securityWordHash = swHash;
    settings.securityWordSalt = swSalt;
    // Store master password encrypted with security word for recovery
    settings.recoveryData = encrypt(password, securityWord);
    saveSettings(settings);
    return { success: true };
  });

  ipcMain.handle('auth:verify-security-word', (_event, { securityWord }) => {
    const settings = loadSettings();
    if (!settings) return { success: false, error: '未初始化' };
    if (!settings.securityWordHash || !settings.securityWordSalt) {
      return { success: false, error: '未设置安全词' };
    }
    const swHash = crypto.pbkdf2Sync(securityWord, settings.securityWordSalt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    if (swHash !== settings.securityWordHash) return { success: false, error: '安全词错误' };
    return { success: true };
  });

  ipcMain.handle('auth:has-security-word', () => {
    const settings = loadSettings();
    return !!(settings && settings.securityWordHash);
  });

  ipcMain.handle('auth:reset-password', (_event, { securityWord, newPassword }) => {
    const settings = loadSettings();
    if (!settings) return { success: false, error: '未初始化' };
    if (!settings.securityWordHash || !settings.securityWordSalt || !settings.recoveryData) {
      return { success: false, error: '未设置安全词，无法重置' };
    }
    // Verify security word
    const swHash = crypto.pbkdf2Sync(securityWord, settings.securityWordSalt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    if (swHash !== settings.securityWordHash) return { success: false, error: '安全词错误' };
    // Decrypt the master password using the security word
    const masterPassword = decrypt(settings.recoveryData, securityWord);
    if (!masterPassword) return { success: false, error: '恢复数据损坏' };
    // Decrypt vault with the recovered master password
    const vault = loadVault(masterPassword);
    if (!vault) return { success: false, error: '保险库解密失败' };
    // Re-encrypt vault with new password
    const newSalt = crypto.randomBytes(32).toString('hex');
    const newHash = crypto.pbkdf2Sync(newPassword, newSalt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    settings.masterPasswordHash = newHash;
    settings.salt = newSalt;
    const dataKey = crypto.createHash('sha256').update(newPassword + newSalt).digest('hex');
    settings.dataKeyEncrypted = encrypt(dataKey, newPassword);
    // Update recovery data with new password
    settings.recoveryData = encrypt(newPassword, securityWord);
    saveSettings(settings);
    saveVault(vault, newPassword);
    // Re-save trash with new password
    const trash = loadTrash(masterPassword);
    if (trash) saveTrash(trash, newPassword);
    // 附件同样要用新密码重加密（旧密码是刚从安全词恢复出来的 masterPassword）。
    // 与改密一样必须在 clearCaches() 之前：那时旧密码的派生 key 还在缓存里。
    let attachments = { total: 0, ok: 0, failed: 0 };
    try {
      if (typeof reencryptAttachments === 'function') {
        attachments = reencryptAttachments(masterPassword, newPassword);
      }
    } catch (e) {
      attachments = { total: 0, ok: 0, failed: 0, errors: [e.message] };
    }
    // Password reset always ends the session: the user must unlock with the new password.
    clearCaches();
    setPassword(null);
    setUnlocked(false);
    // 旧主密码已作废，剪贴板历史文件再也解不开，直接删掉免得留一堆死数据
    try { wipeClipHistory?.(); } catch { /* 忽略 */ }
    const out = { success: true, attachments };
    if (attachments.failed > 0) {
      out.warning = `密码已重置，但有 ${attachments.failed} 个附件无法用原密码解开，未做重加密（可用「库自检」查看）`;
    }
    return out;
  });

  return { getPassword };
}

module.exports = { registerAuthIpc };
