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
const autologin = require('./autologin');

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 30000;

/** 主密码 / 写入用的密文体积上限（§2.3 入参边界、§2.7 blob ≤ 64 KB） */
const MAX_PASSWORD_LENGTH = 256;

/** 定长时间的哈希比较（别用 `!==` 把「前几位相同」泄漏成时间差） */
function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

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
    // ---- 启动免密（1.37.0 / R2）：safeStorage 与落盘工具全部注入，见契约 §6.2 ----
    safeStorage,
    autologinPath,
    writeFileAtomic,
    getUnlocked,
    getAutoUnlockSuppressed,
    setAutoUnlockSuppressed,
    appendAudit,
    bumpEpoch,
    touchActivity,
    afterAutoUnlock,
  } = deps;

  // Brute-force guard: 5 wrong passwords in a row → 30s cool-down (in-memory, resets on restart).
  let loginFailures = 0;
  let loginLockedUntil = 0;
  /**
   * 启动免密的失败计数**独立**于登录计数（D4）。
   * 「在设置页输错主密码把登录锁 30 秒」是明显的体验事故，所以计数器必须分开。
   */
  let enableFailures = 0;
  let enableLockedUntil = 0;
  /** 同一进程内 `decrypt-failed` 连续次数；≥3 后不再打 DPAPI（§2.5 限流） */
  let autoUnlockAttempts = 0;
  /** 进程内串行化守卫（ipcMain.handle 是同步的，这里只为把「不重入」写成代码） */
  let autoUnlockInFlight = false;
  let autoUnlockLast = null;

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
    /**
     * E1（契约 §2.8）：改密成功后**必须**删掉 autologin.json。
     * 那份 blob 里是 DPAPI 加密的**旧**主密码，留着只会让下次启动拿已作废的密码去解库，
     * 表现为「开机自动解锁失败 + 凭据过期」。用户改过密码本来就该重新决定要不要免密。
     */
    dropAutoUnlockCredential('change-password');
    autoUnlockAttempts = 0;
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
    /** E2（契约 §2.8）：重置成功后旧主密码彻底作废，启动免密凭据必须一起失效 */
    dropAutoUnlockCredential('reset-password');
    autoUnlockAttempts = 0;
    // 旧主密码已作废，剪贴板历史文件再也解不开，直接删掉免得留一堆死数据
    try { wipeClipHistory?.(); } catch { /* 忽略 */ }
    const out = { success: true, attachments };
    if (attachments.failed > 0) {
      out.warning = `密码已重置，但有 ${attachments.failed} 个附件无法用原密码解开，未做重加密（可用「库自检」查看）`;
    }
    return out;
  });

  // ----------------------------------------------------------------
  // 启动免密（R2 / 1.37.0）：4 个 channel + 6 个失效时机
  // 契约：docs/契约-设置细分-免密-卸载.md §2、§2.8、§6.1（S1）
  // ----------------------------------------------------------------
  /**
   * 状态真源只有 `<DATA_DIR>/autologin.json`（D2：**不进** AppSettings，
   * 否则会出现「settings 说开、文件已被失效时机删掉」的双真源漂移）。
   */
  const autoUnlockFile = () => (typeof autologinPath === 'function'
    ? autologinPath(DATA_DIR)
    : require('path').join(DATA_DIR, autologin.AUTOLOGIN_FILE_NAME));

  /** safeStorage 当前是否可用（E6 的唯一判据；异常一律当「不可用」，绝不降级明文） */
  const safeStorageAvailable = () => {
    try {
      return !!safeStorage
        && typeof safeStorage.isEncryptionAvailable === 'function'
        && !!safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  /** 会话是否已解锁（两个来源都要为真：主进程标志位 + 真有主密码） */
  const sessionUnlocked = () => {
    try {
      const byFlag = typeof getUnlocked === 'function' ? !!getUnlocked() : true;
      return byFlag && getPassword() !== null;
    } catch {
      return false;
    }
  };

  const suppressedNow = () => {
    try {
      return typeof getAutoUnlockSuppressed === 'function' ? !!getAutoUnlockSuppressed() : false;
    } catch {
      return false;
    }
  };

  const reasonText = (code) => autologin.reasonText(code);

  /** `unlocked:false` 是**正常态**（D3）：一律 `success:true`，让渲染层安静地落回登录页 */
  const notUnlocked = (reasonCode) => ({
    success: true,
    data: { unlocked: false, reasonCode, reason: reasonText(reasonCode) },
  });

  /**
   * 删除 autologin.json（E1/E2/E5 共用）。
   * 文件不存在不算错（强幂等）；失败只记应用日志，不阻断主流程。
   *
   * 注意：这里**不**重置 `autoUnlockAttempts` —— 解密失败那次自清之后计数要留着，
   * 万一文件删不掉（被占用）也能靠「连续 ≥3 次不再打 DPAPI」止住重试循环。
   * @param {string} why 触发原因（**只写原因名，不写任何密码/密文**）
   * @returns {boolean} 是否真的删掉了
   */
  function dropAutoUnlockCredential(why) {
    let file = '';
    try {
      file = autoUnlockFile();
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      console.log(`[auth] 已清除启动免密凭据（${why}）`);
      return true;
    } catch (e) {
      console.warn(`[auth] 清除启动免密凭据失败（${why}）：${(e && e.message) || e}`);
      return false;
    }
  }

  /**
   * 自动解锁的主流程（§2.5，顺序固定）：
   * 抑制位 → safeStorage → 未初始化 → 读文件/解析 → 解密 → 与 `session:unlock` 同一套副作用。
   *
   * 明文纪律：`password` 只活在这个函数的栈上，**不进返回值、不进日志、不进审计**。
   */
  function doAutoUnlock() {
    // ① E4：本次进程内已手动锁定 → 一个字都不碰文件
    if (suppressedNow()) return notUnlocked('session-locked');

    // ② E6：系统没有安全存储 → 不解密、不删文件（环境恢复后仍可用）、绝不降级明文
    if (!safeStorageAvailable()) return notUnlocked('safe-storage-unavailable');

    // ③ 全新安装：没有库文件时什么都不做（补充表：auth:is-setup 为 false → not-setup，无副作用）
    if (!fs.existsSync(DATA_FILE)) return notUnlocked('not-setup');

    // ④ 读 + 解析（不解密不花时间，纯字符串）
    const file = autoUnlockFile();
    let raw = null;
    if (fs.existsSync(file)) {
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        raw = null;
      }
    }
    const parsed = autologin.parseAutologin(raw);
    if (!parsed.ok) {
      // 版本不认识：停用但**保留文件**（§2.7，降级一次不能把凭据烧掉）
      if (parsed.reasonCode === 'autologin-version-unsupported') {
        return notUnlocked('autologin-version-unsupported');
      }
      // E5：文件损坏 / blob 不是 base64 → 自清，且不卡在启动态
      dropAutoUnlockCredential('autologin-corrupt');
      return notUnlocked('decrypt-failed');
    }

    // ⑤ 限流：连续 3 次解不开就不再打 DPAPI（§2.5）
    if (autoUnlockAttempts >= 3) return notUnlocked('decrypt-failed');

    let password = '';
    try {
      password = safeStorage.decryptString(Buffer.from(parsed.blob, 'base64'));
    } catch {
      password = '';
    }
    if (!password) {
      // E5：DPAPI 解不开（换机器 / 换了 OS 用户 / blob 被改）→ 自清
      autoUnlockAttempts += 1;
      dropAutoUnlockCredential('decrypt-failed');
      return notUnlocked('decrypt-failed');
    }

    // ⑥ 与 session:unlock 完全相同的副作用（顺序也一致，见 ipc-entries.js 的 session:unlock）
    clearCaches();
    const vault = loadVault(password);
    if (!vault) {
      // 密码解开了但库解不开：文件保留、本次不重试（§2.5 的 vault-corrupt）
      password = '';
      return notUnlocked('vault-corrupt');
    }
    setPassword(password);
    setUnlocked(true);
    autoUnlockAttempts = 0;
    try { bumpEpoch?.(); } catch { /* 纪元自增失败不影响解锁 */ }
    try { touchActivity?.(); } catch { /* 忽略 */ }
    // 定时器补跑（禅道提醒 / 未读红点 / 当日备份 / 剪贴板历史）：与 session:unlock 同一批
    try { afterAutoUnlock?.(); } catch { /* 定时器失败不影响解锁 */ }
    const out = { success: true, data: { unlocked: true, vault } };
    password = '';
    return out;
  }

  /** 进程内串行化：并发第二次直接返回上一次结果，避免两次 loadVault + 两批定时器 */
  function runAutoUnlock() {
    if (autoUnlockInFlight) return autoUnlockLast || notUnlocked('decrypt-failed');
    autoUnlockInFlight = true;
    try {
      autoUnlockLast = doAutoUnlock();
      return autoUnlockLast;
    } finally {
      autoUnlockInFlight = false;
    }
  }

  /**
   * `auth:auto-unlock-status`（§2.2）：纯读、不解密、**永远 success:true**
   * （`success:false` 会让启动态卡在错误弹窗）。
   */
  ipcMain.handle('auth:auto-unlock-status', () => {
    const available = safeStorageAvailable();
    try {
      const file = autoUnlockFile();
      const exists = fs.existsSync(file);
      let raw = null;
      if (exists) {
        try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = null; }
      }
      const status = autologin.buildAutoUnlockStatus({ exists, raw, available });
      // §2.2 的「not-setup（未初始化时可选返回）」：没有库文件就是还没初始化
      if (!status.enabled && !status.reasonCode && !fs.existsSync(DATA_FILE)) {
        status.reasonCode = 'not-setup';
        status.reason = reasonText('not-setup');
      }
      return { success: true, data: status };
    } catch {
      return {
        success: true,
        data: {
          enabled: false,
          available,
          reasonCode: 'autologin-corrupt',
          reason: reasonText('autologin-corrupt'),
        },
      };
    }
  });

  /**
   * `auth:enable-auto-unlock`（§2.3）：已解锁 + **再验一次主密码**（D4），
   * 通过后 `safeStorage.encryptString(主密码)` → base64 → 原子写盘。
   * 失败计数与登录限速**分开**。
   */
  ipcMain.handle('auth:enable-auto-unlock', (_event, payload) => {
    const wait = enableLockedUntil - Date.now();
    if (wait > 0) {
      return {
        success: false,
        code: 'rate-limited',
        error: `尝试次数过多，请 ${Math.ceil(wait / 1000)} 秒后再试`,
        retryAfterMs: wait,
      };
    }

    if (!sessionUnlocked()) {
      return { success: false, code: 'locked', error: '请先解锁应用再开启启动免密' };
    }
    if (!fs.existsSync(DATA_FILE)) {
      return { success: false, code: 'not-setup', error: '尚未初始化主密码' };
    }
    // E6：没有安全存储就不许开启（绝不降级成明文落盘）
    if (!safeStorageAvailable()) {
      return {
        success: false,
        code: 'safe-storage-unavailable',
        error: '系统未提供安全存储（DPAPI 不可用），无法安全保存主密码',
      };
    }

    const data = payload && typeof payload === 'object' ? payload : {};
    // 只接受字符串；空白/超长一律 invalid-argument（不回显用户输入的任何内容）
    if (typeof data.password !== 'string' || data.password.length > MAX_PASSWORD_LENGTH || data.password.trim() === '') {
      return { success: false, code: 'invalid-argument', error: '请先输入主密码' };
    }
    const password = data.password;

    const bumpEnableFailure = () => {
      enableFailures += 1;
      if (enableFailures >= LOGIN_MAX_FAILURES) {
        enableFailures = 0;
        enableLockedUntil = Date.now() + LOGIN_LOCK_MS;
        return {
          success: false,
          code: 'rate-limited',
          error: `连续错误 ${LOGIN_MAX_FAILURES} 次，请 ${LOGIN_LOCK_MS / 1000} 秒后再试`,
          retryAfterMs: LOGIN_LOCK_MS,
        };
      }
      return {
        success: false,
        code: 'wrong-password',
        error: `主密码不正确（还可尝试 ${LOGIN_MAX_FAILURES - enableFailures} 次）`,
      };
    };

    /**
     * 双重校验（与 `auth:verify` 同口径）：
     * ① settings 里的 PBKDF2 哈希对得上；② 这个密码真的能解开库。
     * 只验哈希会有「settings 与库不同源」时把错密码加密进去的风险（§2.3）。
     */
    const settings = loadSettings();
    if (settings && settings.masterPasswordHash && settings.salt) {
      const hash = crypto.pbkdf2Sync(password, settings.salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
      if (!hashEquals(hash, settings.masterPasswordHash)) return bumpEnableFailure();
    }
    if (!loadVault(password)) return bumpEnableFailure();

    let blob = '';
    try {
      blob = safeStorage.encryptString(password).toString('base64');
    } catch {
      return {
        success: false,
        code: 'safe-storage-unavailable',
        error: '系统未提供安全存储（DPAPI 不可用），无法安全保存主密码',
      };
    }

    const updatedAt = new Date().toISOString();
    try {
      const text = autologin.serializeAutologin(blob, updatedAt);
      // `writeFileAtomic` 内部会 mkdir -p + 临时文件 + fsync + rename（§2.7）
      writeFileAtomic(autoUnlockFile(), Buffer.from(text, 'utf8'));
    } catch (e) {
      return { success: false, code: 'write-failed', error: `写入启动免密配置失败：${(e && e.message) || '未知错误'}` };
    }

    enableFailures = 0;
    enableLockedUntil = 0;
    autoUnlockAttempts = 0;
    // 审计只记动作名，**不记**任何密码/密文（§2.3 明文禁令）
    try { appendAudit?.({ action: 'auto-unlock-enable' }); } catch { /* 审计失败不影响开启 */ }
    return { success: true, data: { enabled: true, updatedAt } };
  });

  /**
   * `auth:disable-auto-unlock`（§2.4）：强幂等 —— 文件不存在也返回 `enabled:false`。
   * 未解锁时不允许碰文件（防止锁屏态被本地其它进程驱动）。
   */
  ipcMain.handle('auth:disable-auto-unlock', () => {
    if (!sessionUnlocked()) {
      return { success: false, code: 'locked', error: '请先解锁应用再修改启动免密' };
    }
    try {
      const file = autoUnlockFile();
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      return { success: false, code: 'delete-failed', error: `关闭启动免密失败：${(e && e.message) || '未知错误'}` };
    }
    autoUnlockAttempts = 0;
    autoUnlockLast = null;
    try { appendAudit?.({ action: 'auto-unlock-disable' }); } catch { /* 审计失败不影响关闭 */ }
    return { success: true, data: { enabled: false } };
  });

  /**
   * `auth:auto-unlock`（§2.5）：凭据只来自 DPAPI 解密结果，**不接受任何渲染层传入的密码**
   * （多传的参数一律忽略）。`unlocked:false` 是正常态，只有未预期异常才 `success:false`。
   */
  ipcMain.handle('auth:auto-unlock', () => {
    try {
      // 幂等：同一进程内已解锁 → 直接回当前会话的 vault，不重复 bumpEpoch / 不重跑定时器
      if (sessionUnlocked()) {
        const cur = loadVault(getPassword());
        if (cur) return { success: true, data: { unlocked: true, vault: cur } };
      }
      return runAutoUnlock();
    } catch (e) {
      console.warn('[auth] 自动解锁未预期异常：' + ((e && e.stack) || e));
      return { success: false, code: 'internal', error: '操作失败，请重试' };
    }
  });

  return { getPassword };
}

module.exports = { registerAuthIpc };
