const { app, BrowserWindow, clipboard, ipcMain, nativeImage, Menu, shell, dialog, globalShortcut, Tray, screen, Notification, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

const IS_DEV = !app.isPackaged;

// ----------------------------------------------------------------
// Single instance
// ----------------------------------------------------------------
// Two instances would each keep their own decrypted copy of the vault in memory and
// overwrite each other's data on save (and fight over the same userData profile).
// A second launch now just surfaces the window that is already running.
let hasSingleInstanceLock = true;
if (!app.requestSingleInstanceLock()) {
  hasSingleInstanceLock = false;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow();
    else app.once('ready', () => showMainWindow());
  });
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
// 数据目录默认是 userData，但允许用户改到别的盘（设置 → 数据目录）。
// 指针文件必须放在 userData 里（不能放数据目录里，否则换了目录就找不到指针）。

/**
 * 应用改名会改变 userData 路径（历史上出现过 测试工具 / 测试工作台 / password-manager），
 * 老用户的密码库会「凭空消失」。这里在当前目录**还没有 vault.enc** 时，把旧目录的数据搬一次。
 *
 * 教训（1.9.0 事故）：不要按目录名猜——旧版实际用的是 %APPDATA%\password-manager，
 * 按名字找 测试工具 直接落空。现在按「目录里有没有 vault.enc」判定。
 */
let legacyMigrateTried = false;

/**
 * 把旧数据目录（可能是 测试工具 / 测试工作台 / password-manager）搬到当前数据目录。
 * 只在**当前目录还没有 vault.enc** 时搬一次，搬完逐个校验是否真的写入磁盘。
 *
 * 为什么不在模块加载时做（1.9.0 教训）：打包版里那一刻路径/权限还没稳定，
 * 会出现「日志说搬了、磁盘上没有」；改在登录页第一次问 auth:is-setup 时做，此时一切就绪。
 */
function migrateLegacyInto(targetDir) {
  const { planLegacyMigration, MIGRATE_ITEMS } = require('./legacy-migrate');
  if (legacyMigrateTried) return { copied: 0, from: '' };
  legacyMigrateTried = true;
  try {
    // 自定义 user-data-dir（测试/多开）不搬；PM_APP_DATA 是回归脚本旁路
    const udArg = process.argv.find((a) => a.startsWith('--user-data-dir'));
    if (udArg && !process.env.PM_APP_DATA) return { copied: 0, from: '' };
    const plan = planLegacyMigration({
      appData: process.env.PM_APP_DATA || app.getPath('appData'),
      currentUserData: targetDir,
      isDir: (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } },
      hasVault: (d) => fs.existsSync(path.join(d, 'vault.enc')),
      currentHasVault: fs.existsSync(path.join(targetDir, 'vault.enc')),
    });
    if (plan.reason === 'no-legacy-vault') return { copied: 0, from: '' };
    if (plan.reason === 'current-already-has-vault') {
      console.log(`[migrate] 发现旧库 ${plan.legacyDir}，但当前目录已有 vault.enc，跳过自动迁移`);
      return { copied: 0, from: plan.legacyDir };
    }
    fs.mkdirSync(targetDir, { recursive: true });
    let copied = 0;
    for (const item of MIGRATE_ITEMS) {
      const src = path.join(plan.legacyDir, item);
      const dst = path.join(targetDir, item);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.cpSync(src, dst, { recursive: true, force: true });
      // 校验真的落盘了（打包版曾出现「报成功但没写」）
      if (fs.existsSync(dst)) copied += 1;
      else console.log(`[migrate] 复制失败（未落盘）：${item}`);
    }
    console.log(`[migrate] 已从 ${plan.legacyDir} 迁移 ${copied} 项到 ${targetDir}`);
    return { copied, from: plan.legacyDir };
  } catch (e) {
    console.log(`[migrate] 迁移旧数据目录失败（不影响启动）：${e.message}`);
    return { copied: 0, from: '' };
  }
}


const USER_DATA_DIR = app.getPath('userData');
// 日志尽早装上（写 userData/logs，不受自定义数据目录影响），迁移与启动阶段的问题都能留痕
const { installFileLogging } = require('./app-log');
process.env.PM_APP_VERSION = app.getVersion();
installFileLogging(path.join(USER_DATA_DIR, 'logs'));

const LOCATION_FILE = path.join(USER_DATA_DIR, 'data-location.json');

function resolveDataDir() {
  // 测试 / 多开隔离（1.24.4）：PM_DATA_DIR 环境变量优先。
  // 必须用它而不是 --user-data-dir：后者只是 Chromium 的开关，影响不到
  // app.getPath('userData')，实测会让自动化测试直接读写用户真实数据。
  const override = process.env.PM_DATA_DIR;
  if (override && path.isAbsolute(override)) return override;
  try {
    if (fs.existsSync(LOCATION_FILE)) {
      const j = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'));
      if (j && j.dir && fs.existsSync(j.dir)) return j.dir;
    }
  } catch { /* 指针文件坏了/目录被删了就回默认 */ }
  return USER_DATA_DIR;
}

const DATA_DIR = resolveDataDir();
// 日志与旧数据迁移已在上面处理（userData/logs + vault.enc 判定）
const DATA_FILE = path.join(DATA_DIR, 'vault.enc');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BIN_FILE = path.join(DATA_DIR, 'trash.enc');
// 文件格式常量与结构自检都在 electron/vault-file.js（带单测）：常量只留这一份定义，
// 否则「恢复前校验」和「解密」会各算各的长度。
const { ALGO, SALT_LENGTH, IV_LENGTH, TAG_LENGTH } = require('./vault-file');
const { createClipHistory } = require('./clip-history');
const KEY_ITERATIONS = 600000;
const KEY_LENGTH = 32;
const BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ----------------------------------------------------------------
// 导航守卫
// ----------------------------------------------------------------
// 主窗口的 will-navigate / setWindowOpenHandler 全在 nav-guard.js（有单测），
// 这里只做事件挂载。只要有一条内容能把 <a href> 或 window.open 送到渲染层
// （Markdown 笔记、周报、导入的 CSV……），就能把应用窗口导航走或开出一个没有
// preload 的空白窗口。1.24.2 起测试数据生成器已并入主应用，webviewTag 关闭，
// 守卫里的 webview 分支作为纵深防御保留（万一以后又嵌了访客内容）。
//
// PM_USE_DIST=1 时虽然仍是开发目录，但主窗口加载的是 file://dist —— 此时不能按
// 「开发态」放行 localhost，否则会把应用自己拦下来。所以开关取同一个表达式。
const USE_DEV_SERVER = IS_DEV && !process.env.PM_USE_DIST;
const APP_DIST_DIR = path.join(__dirname, '..', 'dist');

const { openHttpUrl } = require('./url-open');
const { spawn: spawnForUrlOpen } = require('child_process');
const { installNavigationGuards } = require('./nav-guard');
const { createPinManager } = require('./pin-window');

// 「钉」小窗：一条记录一个窗口，锁屏/退出时统一销毁
const pinManager = createPinManager({
  BrowserWindow,
  ipcMain,
  path,
  screen,
  isDev: USE_DEV_SERVER,
  preloadPath: path.join(__dirname, 'preload.js'),
  distDir: APP_DIST_DIR,
  isContentProtection: () => !!(loadSettings() || {}).contentProtection,
  onLog: (m) => console.log(m)
});

const navGuardOptions = () => ({
  dev: USE_DEV_SERVER,
  distDir: APP_DIST_DIR
});

installNavigationGuards({
  app,
  openExternalUrl: (url) => openHttpUrl(url, { shell, spawn: spawnForUrlOpen }),
  getOptions: navGuardOptions,
  onBlocked: (message) => console.warn('[nav-guard] ' + message)
});

// ----------------------------------------------------------------
// Key derivation
// ----------------------------------------------------------------
// PBKDF2(SHA-512, 600k) costs ~400ms on this hardware. Deriving it on every read *and*
// every write made each CRUD action take ~650-950ms, which the UI showed as lag.
// The derived key is therefore cached for the current master password, and writes reuse
// the same salt/key pair. The on-disk format is unchanged (salt is still stored in the
// file header), so existing vaults keep working and the KDF cost stays the same.
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha512');
}

let keyCache = null; // { password, saltHex, salt, key }

/**
 * 多盐键备忘（password + salt → key），只给 getKey 做查表用。
 *
 * 单槽 keyCache 够用是因为「一次会话只有一个 salt」：vault/trash/附件落盘时都复用
 * 同一个 salt。但**改主密码要重加密整个附件目录**，那里会同时出现多个 salt
 * （历史版本留下的附件、跨会话写入的附件），单槽缓存会让每个不同 salt 都重跑一次
 * 600k 次 PBKDF2（~400ms）—— 100 个附件就是 40 秒的假死。
 * 上限 64 条（每条 32B，共 2KB），超出按插入顺序淘汰最旧的。
 */
const KEY_MEMO_MAX = 64;
const keyMemo = new Map();

function memoKey(password, saltHex) {
  return `${password}\u0000${saltHex}`;
}

function getKey(password, salt) {
  const saltHex = salt.toString('hex');
  if (keyCache && keyCache.password === password && keyCache.saltHex === saltHex) {
    return keyCache.key;
  }
  const mk = memoKey(password, saltHex);
  const memo = keyMemo.get(mk);
  if (memo) {
    keyCache = { password, saltHex, salt: Buffer.from(salt), key: memo };
    return memo;
  }
  const key = deriveKey(password, salt);
  keyCache = { password, saltHex, salt: Buffer.from(salt), key };
  if (keyMemo.size >= KEY_MEMO_MAX) {
    const oldest = keyMemo.keys().next();
    if (!oldest.done) keyMemo.delete(oldest.value);
  }
  keyMemo.set(mk, key);
  return key;
}

// Decrypted data kept in memory for the unlocked session (see loadVault/saveVault).
let vaultCache = { password: null, data: null };
let trashCache = { password: null, data: null };

// Drops every in-memory secret: derived key plus decrypted vault/trash.
function clearCaches() {
  keyCache = null;
  keyMemo.clear();
  vaultCache = { password: null, data: null };
  trashCache = { password: null, data: null };
  clearApiJar();
  closeWsConnections();
  // 锁定即停录（契约 [C-114a]）：锁定后真 Chrome 与其 CDP 通道、被测系统登录态还活着 =
  // 无人值守下继续持有一个带登录态的浏览器。clearCaches 是 session:lock / 改密 / 重置 / 解锁前
  // 共用的清缓存入口，放这里才能四条触发源一处不漏（另三处见 recordLockStop 的调用点）。
  recordLockStop('session-lock');
}

// ----------------------------------------------------------------
// UI 录制器：会话管理器（业务在 electron/record-session.js）
// ----------------------------------------------------------------
/** @type {null|ReturnType<typeof createRecordSession>} 会话管理器；setupIpcHandlers 里创建 */
let recordSession = null;

/**
 * 停录（契约 `[C-114a]` 的**主进程内部动作名**，不是 preload 通道、不计四通道四元组）。
 * 四个触发源：`session:lock`（经 clearCaches）、自动锁超时（渲染层 sessionLock → 同上）、
 * 主窗口关闭、防截屏生效。失败不抛：锁屏流程不能因为停录失败而卡住。
 * @param {string} reason 只进审计与排障，不对外
 */
function recordLockStop(reason) {
  try {
    if (recordSession) recordSession.lockStop(reason);
  } catch { /* 停录失败不影响锁定/退出 */ }
}

// ----------------------------------------------------------------
// Encryption / Decryption (AES-256-GCM)
// ----------------------------------------------------------------
function encrypt(plaintext, password) {
  // Reuse the cached salt/key when the password matches: a fresh random salt on every
  // write would force another ~400ms PBKDF2 round on each save.
  const reuse = keyCache && keyCache.password === password;
  const salt = reuse ? keyCache.salt : crypto.randomBytes(SALT_LENGTH);
  const key = reuse ? keyCache.key : getKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function decrypt(ciphertextB64, password) {
  try {
    const buf = Buffer.from(ciphertextB64, 'base64');
    const salt = buf.subarray(0, SALT_LENGTH);
    const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const key = getKey(password, salt);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------
// Vault I/O
// ----------------------------------------------------------------
// 原子写：先写 <file>.tmp 并 fsync，再 rename 覆盖正式文件。
// 直接 writeFileSync(正式文件) 时如果中途崩溃/断电/杀进程，正式库就是半截密文 —— 只能等下一次
// 解锁失败才发现，而备份只有「每天一份」，白天写坏最多回到当天早上。这里顺手留一份 .bak。
function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 部分文件系统/网络盘不支持 fsync */ }
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* 备份失败不影响写入 */ }
  }
  fs.renameSync(tmp, file);
}

/**
 * 写一个文件并 fsync（**不 rename、不留 .bak**）。
 *
 * 给「先写 .new、全部成功后再统一 rename」的两阶段场景用：`.new` 本身就是临时文件，
 * 再套一层 writeFileAtomic 只会多一次 rename 和一份 .bak（附件动辄几十 MB，
 * 一份 .bak 就是让附件目录体积翻倍，而 readAttachment 并没有 .bak 回退，留着纯属浪费）。
 */
function writeFileSynced(file, content) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 部分文件系统/网络盘不支持 fsync */ }
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取并解密；解不开时尝试 <file>.bak，成功则自动把 .bak 提升回正式文件 */
function readEncryptedWithBak(file, password) {
  if (!fs.existsSync(file)) return { raw: null, recovered: false };
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return { raw: '', recovered: false };
  if (decrypt(raw, password)) return { raw, recovered: false };
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    const rawBak = fs.readFileSync(bak, 'utf8').trim();
    if (rawBak && decrypt(rawBak, password)) {
      try { writeFileAtomic(file, rawBak); } catch { /* 回写失败也不影响本次解密结果 */ }
      appendAudit({ action: 'vault-recover-bak', target: path.basename(file) });
      return { raw: rawBak, recovered: true };
    }
  }
  return { raw, recovered: false };
}

/**
 * 读库后的统一升级关口：先按 schemaVersion 迁移，再归一化结构。
 *
 * - 迁移过的库立即落盘（顺带留一条审计），否则每次解锁都要重算一遍；
 * - 落盘失败只影响下次再迁，不影响本次可用性 —— 内存里已经是新结构；
 * - 库版本比应用新（用户降级过）时不动它，只记一条审计，
 *   normalizeVault 会把不认识的字段原样带回去，避免一保存就把新字段洗掉。
 */
function migrateAndNormalize(parsed, password) {
  const { vault, from, to, applied, future } = migrateVault(parsed);
  const result = normalizeVault(vault);
  if (future) {
    appendAudit({ action: 'vault-newer-version', from });
    console.warn(`[vault] 库版本 v${from} 高于当前应用支持的 v${VAULT_SCHEMA_VERSION}，已保留未知字段`);
    return result;
  }
  if (applied.length) {
    try {
      saveVault(result, password);
      appendAudit({ action: 'vault-migrate', from, to });
    } catch { /* 下次解锁再迁 */ }
  }
  return result;
}

function loadVault(password) {
  if (vaultCache.password === password && vaultCache.data) return vaultCache.data;
  let result;
  if (!fs.existsSync(DATA_FILE)) {
    result = normalizeVault(null);
  } else {
    const { raw } = readEncryptedWithBak(DATA_FILE, password);
    if (!raw) {
      result = normalizeVault(null);
    } else {
      const json = decrypt(raw, password);
      if (!json) return null;
      try {
        result = migrateAndNormalize(JSON.parse(json), password);
      } catch {
        return null;
      }
    }
  }
  vaultCache = { password, data: result };
  return result;
}

// ----------------------------------------------------------------
// Automatic backups (one encrypted copy per day, keep the newest N)
// ----------------------------------------------------------------
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP_DEFAULT = 7;

/** 备份里的附件目录：和 vault-YYYY-MM-DD.enc 同一天，单独一个文件夹 */
function attachmentsBackupDir(day) {
  return path.join(BACKUP_DIR, `attachments-${day}`);
}

/**
 * 复制 .enc 文件：优先硬链接（同盘零拷贝），跨盘/权限不允许时退回真复制。
 * 附件一天一份全量备份，几百张图时硬链接能省下大量空间。
 */
function copyOrLink(from, to) {
  try {
    fs.linkSync(from, to);
    return 'link';
  } catch {
    fs.copyFileSync(from, to);
    return 'copy';
  }
}

/** 把 srcDir 里的 .enc 补进 dstDir（已存在的不覆盖）；返回补了多少 */
function copyEncFiles(srcDir, dstDir) {
  let copied = 0;
  let skipped = 0;
  if (!srcDir || !fs.existsSync(srcDir)) return { copied, skipped };
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.enc')) continue;
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    try {
      if (fs.existsSync(to)) { skipped += 1; continue; }
      copyOrLink(from, to);
      copied += 1;
    } catch { /* 单个附件失败不影响其它 */ }
  }
  return { copied, skipped };
}

/**
 * 附件备份是否落后于源目录：只在新增过附件时才需要再补一次。
 * 1.25.1：笔记附件目录（`<笔记目录>/attachments`）也算源目录之一，任一落后就要补。
 */
function attachmentsBackupStale(day) {
  const dst = attachmentsBackupDir(day);
  try {
    if (!fs.existsSync(dst)) return true;
    const dstMs = fs.statSync(dst).mtimeMs;
    for (const src of attachmentDirs()) {
      if (!fs.existsSync(src)) continue;
      // 附件文件不可变（id 唯一），目录 mtime 只会在新增文件时更新，一次 stat 就够
      if (fs.statSync(src).mtimeMs > dstMs) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * 把当前附件目录补进今天的备份。
 * 1.25.1：全局目录 + 笔记目录都补（附件 id 是 uuid，两个目录不会撞名）。
 */
function backupAttachments(day) {
  try {
    const dst = attachmentsBackupDir(day);
    let copied = 0;
    let skipped = 0;
    let found = false;
    for (const src of attachmentDirs()) {
      if (!fs.existsSync(src)) continue;
      found = true;
      const one = copyEncFiles(src, dst);
      copied += one.copied;
      skipped += one.skipped;
    }
    if (!found) return { copied: 0, skipped: 0, dir: dst };
    return { copied, skipped, dir: dst };
  } catch (e) {
    return { copied: 0, skipped: 0, error: e.message };
  }
}

/**
 * 恢复备份时把附件合并回当前附件目录（绝不覆盖现有文件）。
 *
 * 备份里两个目录的 .enc 是混在一起的（id 唯一，不会冲突），统一补回**全局**目录：
 * 读取顺序是「笔记目录 → 全局」，补到全局仍然能被找到，不会出现「恢复了却显示图片失效」。
 */
function restoreAttachments(day) {
  try {
    const src = attachmentsBackupDir(day);
    if (!fs.existsSync(src)) return { copied: 0, skipped: 0, found: false };
    return { ...copyEncFiles(src, currentAttachDir()), found: true };
  } catch (e) {
    return { copied: 0, skipped: 0, found: true, error: e.message };
  }
}

function removeAttachmentBackup(day) {
  try { fs.rmSync(attachmentsBackupDir(day), { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 从 vault-YYYY-MM-DD.enc 取出日期部分 */
function dayOfBackup(name) {
  const m = /^vault-(\d{4}-\d{2}-\d{2})\.enc$/.exec(String(name || ''));
  return m ? m[1] : '';
}


/** 保留份数来自设置（1~60），设置读不到就用默认 7 */
function backupKeepCount() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const n = Number(s && s.backupKeep);
    return Number.isFinite(n) && n >= 1 && n <= 60 ? Math.floor(n) : BACKUP_KEEP_DEFAULT;
  } catch {
    return BACKUP_KEEP_DEFAULT;
  }
}

/** 异地备份目录（第二目录 / 网盘同步盘）：读设置里的 backupMirrorDir */
function backupMirrorDir() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return String((s && s.backupMirrorDir) || '').trim();
  } catch {
    return '';
  }
}

/**
 * 把备份复制到异地目录（可以是 OneDrive/坚果云 这类同步盘的本地路径）。
 * 失败只返回结果、绝不抛：备份不能阻断保存主流程。
 */
function mirrorBackupFile(srcFile, day) {
  const dir = backupMirrorDir();
  if (!dir) return { ok: false, skipped: true };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `vault-${day}.enc`);
    fs.copyFileSync(srcFile, target);
    // 附件跟着走：异地备份是为了「换机器能恢复」，只搬 vault 会让所有图片引用失效
    // 1.25.1：笔记附件目录（<笔记目录>/attachments）也要搬，否则换机器后目录笔记的截图全丢
    const mirrorAttachDir = path.join(dir, `attachments-${day}`);
    for (const src of attachmentDirs()) copyEncFiles(src, mirrorAttachDir);
    // 与本地用同一套保留份数
    const keep = backupKeepCount();
    const files = fs.readdirSync(dir)
      .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
      .sort();
    while (files.length > keep) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* ignore */ }
      try { fs.rmSync(path.join(dir, `attachments-${dayOfBackup(oldest)}`), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { ok: true, dir, path: target };
  } catch (e) {
    return { ok: false, dir, error: e.message };
  }
}

function backupVaultOncePerDay() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `vault-${day}.enc`);
    if (fs.existsSync(target)) {
      // 本地今天已有：只补齐异地（用户可能是今天才配的第二目录）与新增的附件
      const dir = backupMirrorDir();
      if (dir && !fs.existsSync(path.join(dir, `vault-${day}.enc`))) mirrorBackupFile(target, day);
      // 这里在每次 saveVault 的热路径上：附件没变就别遍历目录（几百个附件会明显拖慢保存）
      if (attachmentsBackupStale(day)) backupAttachments(day);
      return false; // already backed up today
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DATA_FILE, target);
    backupAttachments(day);
    mirrorBackupFile(target, day);

    const keep = backupKeepCount();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
      .sort();
    while (files.length > keep) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch { /* ignore */ }
      removeAttachmentBackup(dayOfBackup(oldest));
    }
    return true;
  } catch {
    // a failed backup must never block the save path
    return false;
  }
}

// ----------------------------------------------------------------
// Audit log（本地 JSONL：谁在什么时候复制了密码 / 导出 / 删除）
// ----------------------------------------------------------------
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const AUDIT_MAX = 2000;

function appendAudit(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line, 'utf8');
    // 太大就截断到最近 1000 条，避免无限增长
    const st = fs.statSync(AUDIT_FILE);
    if (st.size > 512 * 1024) {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean).slice(-AUDIT_MAX);
      fs.writeFileSync(AUDIT_FILE, lines.join('\n') + '\n', 'utf8');
    }
  } catch { /* 审计失败不影响主流程 */ }
}

function readAudit(limit = 200) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function listBackups() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.enc'))
      .map(f => {
        const full = path.join(BACKUP_DIR, f);
        const st = fs.statSync(full);
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

/**
 * 密码库数据版本号：每次落盘 +1（解锁/锁定也 +1）。
 * 快速搜索小窗用它判断上一次拼好的 1,600 条命令还能不能复用 ——
 * 只多花一次极轻的 IPC，就不用每次弹出都 Promise.all 取 7 类数据。
 */
let vaultEpoch = 1;

function saveVault(vault, password) {
  const json = JSON.stringify(vault);
  const encrypted = encrypt(json, password);
  // Snapshot yesterday's file before it is overwritten (once per day).
  backupVaultOncePerDay();
  writeFileAtomic(DATA_FILE, encrypted);
  vaultCache = { password, data: vault };
  vaultEpoch += 1;
  scheduleTrayRefresh();
}

// ----------------------------------------------------------------
// Trash (recycle bin) I/O
// ----------------------------------------------------------------
function loadTrash(password) {
  if (trashCache.password === password && trashCache.data) return trashCache.data;
  let result;
  if (!fs.existsSync(BIN_FILE)) {
    result = [];
  } else {
    const { raw } = readEncryptedWithBak(BIN_FILE, password);
    if (!raw) {
      result = [];
    } else {
      const json = decrypt(raw, password);
      if (!json) return null;
      try {
        result = JSON.parse(json);
      } catch {
        return null;
      }
    }
  }
  trashCache = { password, data: result };
  return result;
}

function saveTrash(trash, password) {
  const json = JSON.stringify(trash);
  const encrypted = encrypt(json, password);
  writeFileAtomic(BIN_FILE, encrypted);
  trashCache = { password, data: trash };
}

// ----------------------------------------------------------------
// Settings (plain JSON, no secrets)
// ----------------------------------------------------------------
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 读设置并**区分「没有」和「坏了」**。
 *
 * `loadSettings()` 把「文件不存在」「读不出来」「JSON 坏了」统统返回 null，
 * 启动清理逻辑据此判断就会把「设置文件损坏」误当成「从未初始化」——
 * 2026-11 实测：settings.json 被写坏一次，下次启动直接把 vault.enc / trash.enc
 * 一起 unlink，整个密码库凭空消失，且没有任何提示。
 *
 * @returns {{ state: 'ok'|'missing'|'corrupt'|'unreadable', settings: any, error: string }}
 */
function loadSettingsState() {
  if (!fs.existsSync(SETTINGS_FILE)) return { state: 'missing', settings: null, error: '' };
  let raw = '';
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (e) {
    return { state: 'unreadable', settings: null, error: e.message };
  }
  if (!raw.trim()) return { state: 'corrupt', settings: null, error: '文件为空' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'corrupt', settings: null, error: '内容不是 JSON 对象' };
    }
    return { state: 'ok', settings: parsed, error: '' };
  } catch (e) {
    return { state: 'corrupt', settings: null, error: e.message };
  }
}

/**
 * 启动期清理：**只在确实从未初始化时**动文件，绝不因为「设置读不出来」就删密码库。
 *
 * 判定口径（按危险程度从高到低）：
 *   1. 三个文件都不存在 → 全新安装，无事可做；
 *   2. settings 存在但解析失败 → 改名成 `settings.json.corrupt-<时间戳>` 留证 + 审计，
 *      **vault.enc / trash.enc 原样保留**（用户还能用旧密码打开，或从备份恢复）；
 *   3. settings 正常但没有 masterPasswordHash 而 vault 存在 → 保留库，只记日志
 *      （设置文件被外部改过 / 旧格式，库本身是真的）；
 *   4. settings 缺失但 vault 存在 → 保留库，只记日志（用户手动删了 settings，或写盘失败）；
 *   5. 只有一份没初始化的 settings、没有库 → 删掉这份设置（它没有任何价值）。
 *
 * 必须放模块作用域：`app.whenReady()` 里要调用它，写在 setupIpcHandlers 内部会 ReferenceError。
 *
 * @returns {{ action: string, file?: string, reason?: string, error?: string }}
 */
function cleanupStaleVaultOnBoot() {
  const hasVault = fs.existsSync(DATA_FILE);
  const hasTrash = fs.existsSync(BIN_FILE);
  const hasSettings = fs.existsSync(SETTINGS_FILE);

  // 1) 全新安装：没有任何文件需要处理
  if (!hasVault && !hasTrash && !hasSettings) return { action: 'none' };

  const st = loadSettingsState();

  // 2) 设置文件损坏：隔离留证，密码库一个字节都不动
  if (st.state === 'corrupt' || st.state === 'unreadable') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${SETTINGS_FILE}.corrupt-${ts}`;
    let moved = false;
    try {
      fs.renameSync(SETTINGS_FILE, quarantine);
      moved = true;
    } catch (e) {
      console.warn(`[boot] settings.json 损坏且无法改名：${e.message}`);
    }
    appendAudit({
      action: 'settings-corrupt',
      entry: moved ? path.basename(quarantine) : '',
      detail: st.error,
    });
    console.warn(
      `[boot] settings.json 解析失败（${st.error}），已${moved ? `改名保留为 ${path.basename(quarantine)}` : '无法改名'}；` +
      `密码库原样保留（vault.enc ${hasVault ? '存在' : '不存在'}）`
    );
    return { action: 'quarantine', file: moved ? quarantine : '', error: st.error };
  }

  // 3) 设置正常但没有主密码哈希
  if (st.state === 'ok' && !st.settings.masterPasswordHash) {
    if (hasVault) {
      appendAudit({ action: 'settings-no-master-hash', detail: 'vault 保留' });
      console.warn('[boot] settings.json 里没有 masterPasswordHash，但 vault.enc 存在：保留密码库，不删除');
      return { action: 'keep', reason: 'no-master-hash' };
    }
    // 没有库、只有一份没初始化的设置 → 这份设置没有任何价值，清掉让用户重新初始化
    try {
      fs.unlinkSync(SETTINGS_FILE);
      console.log('[boot] 清理未初始化的 settings.json（无密码库）');
    } catch { /* 删不掉也不影响启动 */ }
    return { action: 'clean-settings' };
  }

  // 4) 设置缺失但库存在：保留库
  if (st.state === 'missing' && (hasVault || hasTrash)) {
    appendAudit({ action: 'settings-missing', detail: 'vault 保留' });
    console.warn('[boot] settings.json 不存在但 vault.enc 存在：保留密码库，不删除');
    return { action: 'keep', reason: 'settings-missing' };
  }

  return { action: 'none' };
}

function saveSettings(settings) {
  // 与密码库一样走原子写：直接覆盖时崩溃/断电会留下半截 JSON，用户设置就全丢了。
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Single source of truth for defaults. settings:get always returns a complete object —
// returning {} used to overwrite the renderer store with an empty object and crash the
// auto-lock timer (`settings.autoLockDelay * 60000` → NaN).
const DEFAULT_SETTINGS = {
  clipboardClearDelay: 30,
  passwordAutoHideDelay: 10,
  autoLockDelay: 5,
  defaultViewMode: 'card',
  defaultEnvFilter: 'all',
  theme: 'dark',
  accent: 'teal',
  density: 'standard',
  minimizeToTray: false,
  closeToTray: false,
  contentProtection: false,
  launchAtLogin: false,
  lastPage: 'passwordManager',
  zentaoNotify: false,
  zentaoNotifyInterval: 10,
  // 超期未动提醒（待验证 / 待处理挂太久）
  zentaoStaleOn: false,
  zentaoStaleDays: 3,
  // 环境巡检定时执行（分钟，0 = 关）；只在状态翻转时弹通知
  envProbeInterval: 0,
  envProbeNotifyOnFlip: true,
  /** 环境巡检超时（毫秒）；1.25.0 起落盘，定时巡检也读它 */
  envProbeTimeoutMs: 8000,
  backupKeep: 7,
  // ---- 自定义存储位置（空 = 用数据目录下的默认路径）----
  /** 附件（截图 / 证书 / 密钥）目录：所有图片与文件附件都存这里，含随手记粘贴的图 */
  attachDir: '',
  /** 目录模式测试笔记的存放目录（.md 一篇一个文件） */
  notesDir: '',
  /** 周报目录 */
  weeklyDir: '',
  // 应用内更新：自定义国内直链前缀（空 = 只走 GitHub）；周期检查小时数（0 = 仅启动查一次）
  updateMirrorUrl: '',
  updateCheckIntervalHours: 0,
  browserPaths: { chrome: '', msedge: '', firefox: '', brave: '', opera: '', vivaldi: '', '360': '', qq: '', quark: '' },
  keybindings: {
    newEntry: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
    lock: 'Ctrl+Shift+L',
    trash: 'Ctrl+Shift+T',
    import: 'Ctrl+Shift+I',
    export: 'Ctrl+Shift+E',
  },
};

// ----------------------------------------------------------------
// Window / Tray
// ----------------------------------------------------------------
let mainWindow = null;
let tray = null;
let isQuitting = false;

function getWindowPrefs() {
  const s = loadSettings() || {};
  return {
    minimizeToTray: !!s.minimizeToTray,
    closeToTray: !!s.closeToTray,
  };
}

function appIconPath() {
  return IS_DEV
    ? path.join(__dirname, '..', 'buildResources', 'icon.ico')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'buildResources', 'icon.ico');
}

/**
 * 全局快捷键：两个动作拆开注册（显隐 / 搜索），都支持在设置里自定义。
 * PM_HOTKEY_SEARCH / PM_HOTKEY_TOGGLE 仅供本地回归脚本临时换键（正常启动不会设置）。
 */
const DEFAULT_HOTKEY_SEARCH = 'CommandOrControl+Space';
const DEFAULT_HOTKEY_TOGGLE = 'CommandOrControl+Shift+P';
/** 随手记小窗：不弹主窗口，直接出来一个小记事本 */
const DEFAULT_HOTKEY_QUICKNOTE = 'CommandOrControl+Shift+N';
/**
 * 默认搜索键被别的程序占走时的兜底。只在「没自定义过」时生效，
 * 用户自己改的键冲突就如实报错，不做静默替换。
 */
const SEARCH_HOTKEY_FALLBACKS = ['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+F'];

/** 每个动作「实际注册成功」的加速键，'' 表示没注册上 */
const hotkeys = { search: '', toggle: '', quicknote: '' };
/** 本应用当前占用的加速键，改动前要全部注销 */
const registeredAccels = new Set();

/** 快捷键显示名：CommandOrControl → Ctrl、Space → 空格 */
function accelLabel(accel) {
  return String(accel || '')
    .replace(/CommandOrControl|Control/g, 'Ctrl')
    .replace(/Space/g, '空格');
}

/** 规范化加速键（去空格、统一大小写太麻烦，只做 trim） */
function normAccel(v) {
  return String(v == null ? '' : v).trim();
}

/** 设置里「想要」的键位：入参 > 环境变量 > 设置 > 默认 */
function desiredHotkeys(override) {
  const s = loadSettings() || {};
  const o = override || {};
  const envSearch = normAccel(process.env.PM_HOTKEY_SEARCH);
  const envToggle = normAccel(process.env.PM_HOTKEY_TOGGLE);
  const envQuick = normAccel(process.env.PM_HOTKEY_QUICKNOTE);
  const sSearch = normAccel(o.search) || envSearch || normAccel(s.hotkeySearch);
  const sToggle = normAccel(o.toggle) || envToggle || normAccel(s.hotkeyToggle);
  const sQuick = normAccel(o.quicknote) || envQuick || normAccel(s.hotkeyQuickNote);
  return {
    search: sSearch || DEFAULT_HOTKEY_SEARCH,
    toggle: sToggle || DEFAULT_HOTKEY_TOGGLE,
    quicknote: sQuick || DEFAULT_HOTKEY_QUICKNOTE,
    // 自定义过就不走兜底，冲突要如实报出来
    searchCustom: !!(normAccel(s.hotkeySearch) || envSearch || normAccel(o.search)),
    toggleCustom: !!(normAccel(s.hotkeyToggle) || envToggle || normAccel(o.toggle)),
    quicknoteCustom: !!(normAccel(s.hotkeyQuickNote) || envQuick || normAccel(o.quicknote)),
    // 回归脚本用环境变量临时换键，不能写进用户设置
    searchFromEnv: !normAccel(o.search) && !!envSearch,
    toggleFromEnv: !normAccel(o.toggle) && !!envToggle,
    quicknoteFromEnv: !normAccel(o.quicknote) && !!envQuick,
  };
}

function unregisterHotkeys() {
  if (process.env.PM_DEBUG_HOTKEY && registeredAccels.size) console.log('[dbg] unregister ' + [...registeredAccels].join(','));
  for (const acc of registeredAccels) {
    try { globalShortcut.unregister(acc); } catch { /* 忽略 */ }
  }
  registeredAccels.clear();
  hotkeys.search = '';
  hotkeys.toggle = '';
  hotkeys.quicknote = '';
}

/** 注册单个键；非法或已被占用都返回 false，不抛 */
function tryRegister(accel, handler) {
  try {
    if (globalShortcut.register(accel, () => {
      if (process.env.PM_DEBUG_HOTKEY) console.log('[hotkey] fired ' + accel);
      return handler();
    })) {
      registeredAccels.add(accel);
      return true;
    }
  } catch { /* 非法加速键 */ }
  return false;
}

function hotkeyInfo() {
  const want = desiredHotkeys();
  return {
    search: accelLabel(hotkeys.search),
    toggle: accelLabel(hotkeys.toggle),
    searchOk: !!hotkeys.search,
    toggleOk: !!hotkeys.toggle,
    searchAccel: hotkeys.search,
    toggleAccel: hotkeys.toggle,
    searchDefault: accelLabel(DEFAULT_HOTKEY_SEARCH),
    toggleDefault: accelLabel(DEFAULT_HOTKEY_TOGGLE),
    searchDefaultAccel: DEFAULT_HOTKEY_SEARCH,
    toggleDefaultAccel: DEFAULT_HOTKEY_TOGGLE,
    searchIsDefault: !want.searchCustom,
    toggleIsDefault: !want.toggleCustom,
    quicknote: accelLabel(hotkeys.quicknote),
    quicknoteOk: !!hotkeys.quicknote,
    quicknoteAccel: hotkeys.quicknote,
    quicknoteDefault: accelLabel(DEFAULT_HOTKEY_QUICKNOTE),
    quicknoteDefaultAccel: DEFAULT_HOTKEY_QUICKNOTE,
    quicknoteIsDefault: !want.quicknoteCustom,
  };
}

/**
 * 应用键位。任一键注册失败则整体回滚到上一次可用的组合，并把失败原因带回去，
 * 这样设置页能直接提示「Ctrl+X 被占用」，而不会把原本能用的键弄丢。
 */
function applyHotkeys(override, { persist = false } = {}) {
  const want = desiredHotkeys(override);
  const res = {
    search: { want: want.search, label: accelLabel(want.search), ok: false, accel: '', reason: '', fallback: false },
    toggle: { want: want.toggle, label: accelLabel(want.toggle), ok: false, accel: '', reason: '' },
    quicknote: { want: want.quicknote, label: accelLabel(want.quicknote), ok: false, accel: '', reason: '' },
  };
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  if (eq(want.search, want.toggle)) {
    res.search.reason = 'same';
    res.toggle.reason = 'same';
    res.quicknote.reason = 'same';
    return { ok: false, data: res };
  }
  // 随手记键撞上另外两个键时只废掉它自己：它失败了不该把搜索/窗口键一起拖下水
  if (eq(want.quicknote, want.search) || eq(want.quicknote, want.toggle)) {
    res.quicknote.reason = 'same';
  }

  const prev = { search: hotkeys.search, toggle: hotkeys.toggle, quicknote: hotkeys.quicknote };
  // 搜索候选：自定义的只试一次；默认键失败才走兜底
  const searchList = want.searchCustom ? [want.search] : [want.search, ...SEARCH_HOTKEY_FALLBACKS];

  unregisterHotkeys();
  for (const acc of searchList) {
    if (tryRegister(acc, () => openSearchPalette())) {
      hotkeys.search = acc;
      res.search.ok = true;
      res.search.accel = acc;
      res.search.label = accelLabel(acc);
      res.search.fallback = acc !== want.search;
      break;
    }
  }
  if (!hotkeys.search) res.search.reason = 'conflict';

  if (tryRegister(want.toggle, () => toggleMainWindow())) {
    hotkeys.toggle = want.toggle;
    res.toggle.ok = true;
    res.toggle.accel = want.toggle;
    res.toggle.label = accelLabel(want.toggle);
  } else {
    res.toggle.reason = 'conflict';
  }

  if (res.quicknote.reason !== 'same' && tryRegister(want.quicknote, () => toggleQuickNote())) {
    hotkeys.quicknote = want.quicknote;
    res.quicknote.ok = true;
    res.quicknote.accel = want.quicknote;
    res.quicknote.label = accelLabel(want.quicknote);
  } else if (res.quicknote.reason !== 'same') {
    res.quicknote.reason = 'conflict';
  }

  const allOk = res.search.ok && res.toggle.ok;
  if (!allOk) {
    // 整体回滚：不把用户原来能用的键弄丢
    unregisterHotkeys();
    if (prev.search && tryRegister(prev.search, () => openSearchPalette())) hotkeys.search = prev.search;
    if (prev.toggle && tryRegister(prev.toggle, () => toggleMainWindow())) hotkeys.toggle = prev.toggle;
    if (prev.quicknote && tryRegister(prev.quicknote, () => toggleQuickNote())) hotkeys.quicknote = prev.quicknote;
    // 随手记是非关键键：搜索/窗口键被别的程序占着时，它自己还能用就该留着，
    // 否则用户会遇到「搜索键冲突 → 连随手记也一起没了」这种莫名其妙的连带损失。
    if (!hotkeys.quicknote && res.quicknote.ok) {
      if (tryRegister(want.quicknote, () => toggleQuickNote())) {
        hotkeys.quicknote = want.quicknote;
      } else {
        res.quicknote.ok = false;
        res.quicknote.reason = 'conflict';
      }
    }
    return { ok: false, data: res, rolledBack: true };
  }

  if (persist) {
    const s = loadSettings() || {};
    // 和默认值一致（或是默认键的兜底）就不写盘，避免以后默认键变化时用户被钉在旧值上
    const write = (slot, def, key) => {
      if (!slot.accel || slot.fallback || slot.accel === def) delete s[key];
      else s[key] = slot.accel;
    };
    // 环境变量临时覆盖的键位不落盘
    if (!want.searchFromEnv) write(res.search, DEFAULT_HOTKEY_SEARCH, 'hotkeySearch');
    if (!want.toggleFromEnv) write(res.toggle, DEFAULT_HOTKEY_TOGGLE, 'hotkeyToggle');
    if (!want.quicknoteFromEnv) write(res.quicknote, DEFAULT_HOTKEY_QUICKNOTE, 'hotkeyQuickNote');
    saveSettings(s);
  }
  if (tray) buildTrayMenu();
  return { ok: true, data: res };
}


/**
 * 独立的「快速搜索」小窗：按搜索键只弹出这个面板，不把主窗口拉到前台。
 * 窗口里跑的是同一个渲染层（?window=palette），数据通过 IPC 现取，不需要解锁状态留在主窗口。
 */
let searchWin = null;
/** 主进程视角的解锁状态（给全局搜索键用：没解锁就别弹数据小窗，直接出主窗口） */
let appUnlocked = false;
/**
 * 当前会话主密码。提到模块级是因为剪贴板历史（electron/clip-history.js）在
 * setupIpcHandlers() 之外创建，需要用它加解密落盘文件。
 */
let currentPassword = null;

function createSearchWindow() {
  searchWin = new BrowserWindow({
    width: 720,
    height: 68,
    minWidth: 560,
    minHeight: 68,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  searchWin.setAlwaysOnTop(true, 'screen-saver');
  if ((loadSettings() || {}).contentProtection) searchWin.setContentProtection(true);
  attachCrashGuard(searchWin, '搜索小窗');
  if (IS_DEV && !process.env.PM_USE_DIST) {
    searchWin.loadURL('http://localhost:5173?window=palette');
  } else {
    searchWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { search: 'window=palette' });
  }
  // 点到面板外面就收起；真正的退出走 hide，窗口留着下次秒开
  searchWin.on('blur', () => {
    try { if (searchWin && !searchWin.isDestroyed() && searchWin.isVisible()) searchWin.hide(); } catch { /* 忽略 */ }
  });
  searchWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      try { searchWin.hide(); } catch { /* 忽略 */ }
    }
  });
  searchWin.on('closed', () => { searchWin = null; });
}

/**
 * 改小窗高度。⚠️ Windows 上透明无边框窗「先变大再变小」时 setSize() 会被忽略，
 * 必须用 setBounds()（实测 setContentSize 也行）。同时保留 x/y，避免窗口跳位。
 */
function setSearchWindowHeight(height) {
  if (!searchWin || searchWin.isDestroyed()) return;
  try {
    const b = searchWin.getBounds();
    // 68 = 空态卡片（搜索行 48.8）+ 上下 10px 透明留白（留给卡片阴影）。
    // 数值要和渲染层实测结果对得上，否则窗口底部会空出一条缝。
    const h = Math.min(540, Math.max(68, Math.round(Number(height) || 68)));
    if (Math.abs(b.height - h) <= 1) return;
    searchWin.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
    if (process.env.PM_DEBUG_HOTKEY) console.log('[palette] height -> ' + h + ' now=' + JSON.stringify(searchWin.getSize()));
  } catch { /* 忽略 */ }
}

/** 摆到鼠标所在屏幕的中上部，像 Spotlight */
function placeSearchWindow() {
  if (!searchWin || searchWin.isDestroyed()) return;
  try {
    const pt = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(pt);
    const wa = disp.workArea;
    const [w] = searchWin.getSize();
    searchWin.setPosition(
      Math.round(wa.x + (wa.width - w) / 2),
      Math.round(wa.y + Math.max(12, wa.height * 0.16)),
    );
  } catch { /* 摆不好就留在原地 */ }
}

function showSearchWindow() {
  if (!searchWin || searchWin.isDestroyed()) createSearchWindow();
  if (!searchWin || searchWin.isDestroyed()) return;
  if (!searchWin.isVisible()) {
    // 每次弹出先收成「只有搜索框」的高度，避免闪一下上一次的结果列表。
    // 隐藏状态下改尺寸可能被系统忽略，show() 之后再收一次。
    setSearchWindowHeight(68);
    placeSearchWindow();
    searchWin.show();
    setSearchWindowHeight(68);
    searchWin.focus();
    // 每次弹出都让窗口重取一遍数据（网址/片段/笔记可能刚在主窗口里改过）
    try { searchWin.webContents.send('palette:refresh'); } catch { /* 忽略 */ }
  } else {
    searchWin.focus();
  }
  if (process.env.PM_DEBUG_HOTKEY) console.log('[palette] shown, url=' + (searchWin && !searchWin.isDestroyed() ? searchWin.webContents.getURL() : '?'));
}

function hideSearchWindow() {
  try {
    if (searchWin && !searchWin.isDestroyed() && searchWin.isVisible()) searchWin.hide();
  } catch { /* 忽略 */ }
}

/**
 * 「随手记」小窗：不弹主窗口、不用切页，按全局键直接写一条笔记进测试笔记集合。
 * 和搜索小窗共用同一个渲染层产物（?window=quicknote），收藏/隐藏逻辑也照抄一份：
 * 关掉只是 hide，输入到一半的内容不会丢；真正落盘由渲染层调 ws:set 完成。
 */
let quickNoteWin = null;

function createQuickNoteWindow() {
  quickNoteWin = new BrowserWindow({
    width: 520,
    height: 340,
    minWidth: 380,
    minHeight: 240,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  quickNoteWin.setAlwaysOnTop(true, 'screen-saver');
  if ((loadSettings() || {}).contentProtection) quickNoteWin.setContentProtection(true);
  attachCrashGuard(quickNoteWin, '随手记小窗');
  if (IS_DEV && !process.env.PM_USE_DIST) {
    quickNoteWin.loadURL('http://localhost:5173?window=quicknote');
  } else {
    quickNoteWin.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { search: 'window=quicknote' });
  }
  // 点到别处就收起（内容留在窗口里，下次按快捷键接着写）
  quickNoteWin.on('blur', () => {
    try { if (quickNoteWin && !quickNoteWin.isDestroyed() && quickNoteWin.isVisible()) quickNoteWin.hide(); } catch { /* 忽略 */ }
  });
  quickNoteWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      try { quickNoteWin.hide(); } catch { /* 忽略 */ }
    }
  });
  quickNoteWin.on('closed', () => { quickNoteWin = null; });
}

/** 摆到鼠标所在屏幕的右上角，别挡住正在看的东西 */
function placeQuickNoteWindow() {
  if (!quickNoteWin || quickNoteWin.isDestroyed()) return;
  try {
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;
    const [w] = quickNoteWin.getSize();
    quickNoteWin.setPosition(
      Math.round(wa.x + wa.width - w - 24),
      Math.round(wa.y + Math.max(16, wa.height * 0.14)),
    );
  } catch { /* 摆不好就留在原地 */ }
}

function showQuickNote() {
  if (!quickNoteWin || quickNoteWin.isDestroyed()) createQuickNoteWindow();
  if (!quickNoteWin || quickNoteWin.isDestroyed()) return;
  if (!quickNoteWin.isVisible()) {
    placeQuickNoteWindow();
    quickNoteWin.show();
  }
  quickNoteWin.focus();
  try { quickNoteWin.webContents.send('quicknote:focus'); } catch { /* 忽略 */ }
}

function hideQuickNote() {
  try {
    if (quickNoteWin && !quickNoteWin.isDestroyed() && quickNoteWin.isVisible()) quickNoteWin.hide();
  } catch { /* 忽略 */ }
}

/** 全局随手记键：没解锁就先让人去解锁，否则写进去的笔记没地方存 */
function toggleQuickNote() {
  if (!appUnlocked) {
    showMainWindow();
    return;
  }
  if (quickNoteWin && !quickNoteWin.isDestroyed() && quickNoteWin.isVisible()) hideQuickNote();
  else showQuickNote();
}

/**
 * 全局搜索键的入口：已解锁就弹独立搜索小窗；没解锁时数据取不出来，
 * 直接把主窗口带到前台去解锁。
 */
function openSearchPalette() {
  if (process.env.PM_DEBUG_HOTKEY) console.log('[palette] open, unlocked=' + appUnlocked);
  if (!appUnlocked) {
    showMainWindow();
    return;
  }
  if (searchWin && !searchWin.isDestroyed() && searchWin.isVisible()) {
    hideSearchWindow();
  } else {
    showSearchWindow();
  }
}

/** 只切换显示/隐藏，不弹搜索 */
function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (process.env.PM_DEBUG_HOTKEY) console.log('[toggle] before visible=' + mainWindow.isVisible() + ' min=' + mainWindow.isMinimized());
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
  if (process.env.PM_DEBUG_HOTKEY) console.log('[toggle] after  visible=' + mainWindow.isVisible());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  // 单实例模式下的救命逻辑：如果占着锁的那个窗口其实是块白板（渲染进程早崩了），
  // 只 show 出来还是白屏。先重载，再显示。
  try {
    if (mainWindow.webContents.isCrashed()) {
      console.warn('[crash] 检测到白屏窗口（渲染进程已崩溃），重新加载后再显示');
      mainWindow.webContents.reload();
    }
  } catch { /* 忽略：老版本 Electron 没有 isCrashed 也不影响主流程 */ }
  // Show first, then restore: a window that was hidden *while minimized* reports
  // isMinimized() === false until it is visible again, so restoring up-front would be
  // skipped and the user would get a taskbar-minimized window back from the tray.
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function hideToTray() {
  // 托盘建不起来时不能 hide：窗口一藏就只剩快捷键能找回，用户会以为程序没了
  if (!createTray()) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function createTray() {
  if (tray) return true;
  let icon = nativeImage.createFromPath(appIconPath());
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'buildResources', 'icon.ico'));

  try {
    tray = new Tray(icon);
    tray.setToolTip('测试中台');
    buildTrayMenu();
    // Left click / double click on the icon restores the window (Windows convention).
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    return true;
  } catch (e) {
    // 某些机器上 Windows 不给建通知区图标（Explorer 重启后未恢复等），这时返回 false，
    // 由调用方退化成「正常最小化 / 真的关闭」，不要留下一个找不回来的隐藏窗口。
    console.warn('[tray] 创建托盘图标失败：' + (e && e.message));
    tray = null;
    return false;
  }
}

// Rebuilt whenever the vault changes so "最近条目" stays current.
function buildTrayMenu() {
  if (!tray) return;

  const settings = loadSettings() || {};
  const delay = Number(settings.clipboardClearDelay) || 30;
  const entries = (vaultCache.data && Array.isArray(vaultCache.data.entries))
    ? [...vaultCache.data.entries]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 5)
    : [];

  const template = [];
  if (entries.length > 0) {
    template.push({
      label: '最近条目（点击复制密码）',
      submenu: entries.map(e => ({
        label: `${e.name || e.url || '未命名'}${e.username ? ' — ' + e.username : ''}`.slice(0, 48),
        click: () => {
          clipboard.writeText(e.password || '');
          if (delay > 0) clearClipboardAfter(delay * 1000);
          if (tray) tray.displayBalloon({ title: '已复制密码', content: `${e.name || '条目'}（${delay} 秒后自动清空）` });
        },
      })),
    });
    template.push({ type: 'separator' });
  }

  template.push(
    { label: `显示 / 隐藏主窗口（${accelLabel(hotkeys.toggle) || '未设置'}）`, click: () => toggleMainWindow() },
    { label: `搜索（${accelLabel(hotkeys.search) || '未设置'}）`, click: () => openSearchPalette() },
    { label: `随手记（${accelLabel(hotkeys.quicknote) || '未设置'}）`, click: () => toggleQuickNote() },
    {
      label: '锁定', click: () => {
        showMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lock-request');
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

let trayRefreshTimer = null;
function scheduleTrayRefresh() {
  if (!tray) return;
  if (trayRefreshTimer) clearTimeout(trayRefreshTimer);
  trayRefreshTimer = setTimeout(() => { trayRefreshTimer = null; buildTrayMenu(); }, 400);
}

function destroyTray() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

// ----------------------------------------------------------------
// Window state (size / position / maximized)
// ----------------------------------------------------------------
const WINDOW_STATE_FILE = path.join(DATA_DIR, 'window-state.json');

function loadWindowState() {
  try {
    const b = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8'));
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
    // Reject bounds that no longer land on a connected display (monitor unplugged).
    const onScreen = screen.getAllDisplays().some(d => {
      const wa = d.workArea;
      return b.x < wa.x + wa.width - 80 && b.x + b.width > wa.x + 80
        && b.y < wa.y + wa.height - 40 && b.y + b.height > wa.y + 40;
    });
    return onScreen ? b : null;
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    const bounds = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE,
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }), 'utf8');
  } catch { /* ignore */ }
}

let windowStateTimer = null;
function scheduleSaveWindowState() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => { windowStateTimer = null; saveWindowState(); }, 600);
}

/**
 * 渲染进程崩溃兜底。
 *
 * 事故（1.24.0 → 1.24.1）：渲染进程挂掉后，窗口留在白板状态，但主进程还活着、
 * 继续占着单实例锁。用户再双击 exe 只会走 second-instance，把这块白板重新 show 出来，
 * 于是「关掉再开」永远是白屏，只能去任务管理器杀进程。
 *
 * 这里做三件事：崩了自动重载（限次）、连续崩改成可点的重试页、把原因写进 app.log。
 */
const CRASH_RELOAD_LIMIT = 2;

function crashFallbackPage(label) {
  const safe = String(label || '窗口').replace(/[<>&]/g, '');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safe}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#f5f6f8;
       color:#1f2328;font:14px/1.7 "Microsoft YaHei",system-ui,sans-serif}
  .box{max-width:420px;padding:28px 32px;background:#fff;border:1px solid #e3e5e9;border-radius:12px;
       box-shadow:0 6px 24px rgba(20,30,50,.08);text-align:center}
  h1{margin:0 0 8px;font-size:16px}
  p{margin:0 0 18px;color:#5b6472;font-size:13px}
  button{padding:7px 18px;border:0;border-radius:8px;background:#2f6fed;color:#fff;
         font-size:13px;cursor:pointer}
  button:hover{background:#255cc7}
</style></head><body><div class="box">
  <h1>${safe}连续崩溃了</h1>
  <p>渲染进程起不来，通常是显卡驱动或内存不足。点下面重试一次；还是不行就关掉窗口重新打开。</p>
  <button onclick="location.reload()">重新加载</button>
</div></body></html>`;
}

function attachCrashGuard(win, label = '窗口') {
  const wc = win.webContents;
  let reloads = 0;
  let aliveTimer = null;

  wc.on('render-process-gone', (_e, details) => {
    const reason = (details && details.reason) || 'unknown';
    const code = (details && details.exitCode) || 0;
    console.error(`[crash] ${label} 渲染进程退出 reason=${reason} exitCode=${code}`);
    if (reason === 'clean-exit') return;
    if (reloads >= CRASH_RELOAD_LIMIT) {
      console.error(`[crash] ${label} 连续崩溃，改为显示重试页`);
      try { void wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(crashFallbackPage(label))); } catch { /* 忽略 */ }
      return;
    }
    reloads += 1;
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      console.warn(`[crash] ${label} 自动重载（第 ${reloads} 次）`);
      try { wc.reload(); } catch { /* 忽略 */ }
    }, 400);
  });

  wc.on('unresponsive', () => console.warn(`[crash] ${label} 无响应`));

  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[load] ${label} 加载失败 code=${code} ${desc} ${String(url || '').slice(0, 120)}`);
  });

  wc.on('did-finish-load', () => {
    if (aliveTimer) clearTimeout(aliveTimer);
    // 稳定跑满 20 秒才清零，避免「崩溃 → 重载 → 又崩」的死循环
    aliveTimer = setTimeout(() => { reloads = 0; }, 20000);
  });
}

function createWindow() {
  // Remove default menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);

  const appIcon = nativeImage.createFromPath(appIconPath());
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedState ? Math.max(900, savedState.width) : 1400,
    height: savedState ? Math.max(600, savedState.height) : 800,
    ...(savedState ? { x: savedState.x, y: savedState.y } : {}),
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true —— 主窗口的 preload 只用 contextBridge + ipcRenderer（不碰 Node API），
      // 因此可以开启沙箱提升隔离；改动 preload 时若引入 fs/path 等 Node 模块，这里会直接报错，必须同步调整。
      // 1.24.2：测试数据生成器已并入主应用，全站不再使用 <webview>，关掉这个能力面。
      sandbox: true
    },
    icon: appIcon,
    show: false
  });

  if (savedState && savedState.maximized) mainWindow.maximize();

  // PM_USE_DIST=1：开发目录下也直接加载已构建的 dist（用于跑 UI 回归，省一次打包）
  if (USE_DEV_SERVER) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(APP_DIST_DIR, 'index.html'));
  }

  // 渲染进程崩了不要留白板（详见 attachCrashGuard 的注释）
  attachCrashGuard(mainWindow, '主窗口');

  // "最小化到托盘": hide instead of sitting in the taskbar.
  // 托盘建不起来时不做拦截，退化成普通最小化（否则窗口永远找不回来）。
  mainWindow.on('minimize', (event) => {
    if (!getWindowPrefs().minimizeToTray) return;
    if (!createTray()) return;
    event.preventDefault();
    hideToTray();
  });

  // "关闭时最小化到托盘": the window keeps running in the background.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (!getWindowPrefs().closeToTray) return;
    if (!createTray()) return;
    event.preventDefault();
    hideToTray();
  });

  // Persist size/position (debounced) and remember it on the way out.
  ['resize', 'move', 'maximize', 'unmaximize'].forEach(ev => mainWindow.on(ev, scheduleSaveWindowState));
  mainWindow.on('close', () => {
    saveWindowState();
    // 主窗口关闭（含「关闭到托盘」：窗口已不可见，录制属于无人看管）→ 同步停录（契约 [C-114a]）
    recordLockStop('window-close');
  });

  // Privacy: keep the vault out of screen captures/recordings when enabled.
  if ((loadSettings() || {}).contentProtection) {
    mainWindow.setContentProtection(true);
    // 防截屏生效 = 第 4 条停录触发源（启动时通常没有活会话，是幂等空操作）
    recordLockStop('device-lock');
  }

  mainWindow.once('ready-to-show', () => {
    // 开机自启（--hidden）：不弹窗，直接驻留托盘；点托盘图标再显示
    if (process.argv.includes('--hidden') && (getWindowPrefs().minimizeToTray || getWindowPrefs().closeToTray)) {
      createTray();
      return;
    }
    mainWindow.show();
  });
  // 窗口被隐藏（托盘 / 快捷键 / 最小化到托盘）时把命令面板收起来，
  // 否则下次唤起会看到一个「上次没关」的搜索框。
  mainWindow.on('hide', () => {
    try { mainWindow.webContents.send('app:cmd-palette-close'); } catch { /* 窗口已关 */ }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ----------------------------------------------------------------
// Clipboard auto-clear helpers
// ----------------------------------------------------------------
let clipboardTimers = {};

/**
 * 敏感复制历史（本地加密落盘，滚动 30 条）。
 * 只在设置里显式开启才记录；锁屏只清内存、文件留着，下次解锁用同一主密码读回来；
 * 点「清空」才真正删文件。实现见 electron/clip-history.js。
 */
const clipHistory = createClipHistory({
  dir: DATA_DIR,
  encrypt,
  decrypt,
  writeFileAtomic,
  getPassword: () => currentPassword,
  isEnabled: () => !!(loadSettings() || {}).clipboardHistory,
});

function rememberClipboard(text) {
  clipHistory.remember(text);
}

function clearClipHistory() {
  clipHistory.forget();
}

function wipeClipHistory() {
  clipHistory.wipe();
}

function clearClipboardAfter(delayMs) {
  const type = 'clipboard';
  if (clipboardTimers[type]) clearTimeout(clipboardTimers[type]);
  clipboardTimers[type] = setTimeout(() => {
    clipboard.clear();
    delete clipboardTimers[type];
    if (mainWindow) mainWindow.webContents.send('clipboard-cleared');
  }, delayMs);
}

// ----------------------------------------------------------------
// Import helpers: CSV 解析 + 字段归一化（实现见 electron/csv.js，纯函数、可单测）
// ----------------------------------------------------------------
const { parseCsv, normalizeImportRecords } = require('./csv');
const { shouldNotifyUpdate } = require('./update-check');
const { registerFileIpc } = require('./ipc-files');
const { registerCasesIpc } = require('./ipc-cases');
const { registerToolsIpc } = require('./ipc-tools');
const { registerBrowserIpc } = require('./ipc-browser');
const { registerJmeterIpc } = require('./ipc-jmeter');
const { registerJmxLibIpc } = require('./ipc-jmxlib');
const { registerScanIpc } = require('./ipc-scan');   // 本地测试资产工作站（13 项）：4 个新 IPC 域，W1 只接线
const { registerGitIpc } = require('./ipc-git');
const { registerAllureIpc } = require('./ipc-allure');
const { registerTdgIpc } = require('./ipc-tdg');
const { registerSystemIpc } = require('./ipc-system');
const { registerCodelabIpc } = require('./ipc-codelab');
const { registerPreviewScheme, registerPreviewProtocol, registerPreviewIpc } = require('./codelab-preview');
const { registerEnvIpc } = require('./ipc-env');
const { registerAttachIpc } = require('./ipc-attach');
const { registerShellIpc, registerShellSessionIpc } = require('./ipc-shell');
const { registerEntriesIpc } = require('./ipc-entries');
const { registerVaultIoIpc } = require('./ipc-vault-io');
const { registerZentaoIpc } = require('./ipc-zentao');
const { registerAuthIpc } = require('./ipc-auth');
const { registerDataIpc } = require('./ipc-data');
const { registerBgIpc } = require('./ipc-bg');
const { registerUpdateIpc } = require('./ipc-update');
const { registerApiIpc, clearApiJar } = require('./ipc-api');
const { registerWsIpc, closeAll: closeWsConnections } = require('./ipc-ws');
// UI 录制器（v1.35.0 / 契约 §9）：会话管理器 + 5 invoke + 1 推送。
// 业务全在 record-session.js，这里只做「创建 + 注册 + 四个停录触发源接线」。
const { createRecordSession } = require('./record-session');
const { registerRecordIpc, recordEventSender } = require('./ipc-record');

// ----------------------------------------------------------------
// Vault shape (1.2.0 expanded from { entries, tags })
// ----------------------------------------------------------------
// 新增模块（SQL 片段 / 笔记 / 检查清单 / 账号池 / 环境总览 / 接口调试）都放在同一个
// 加密文件里，随密码库一起加密，不额外增加新的密码。旧数据缺少这些字段时补空数组。
// 结构归一化抽到 electron/vault-schema.js（带单测）：它是旧库升级的唯一关口，不能靠肉眼保证
// 结构归一化与版本迁移抽到 electron/vault-schema.js（带单测）：它是旧库升级的唯一关口，不能靠肉眼保证
const {
  VAULT_COLLECTIONS, VAULT_SCHEMA_VERSION, migrateVault, normalizeVault,
} = require('./vault-schema');

// TOTP 辅助函数与 password:generate 已拆到 electron/ipc-tools.js（带 RFC 6238 向量单测）

// ----------------------------------------------------------------
// Attachments (encrypted at rest with the session key)
// ----------------------------------------------------------------
/** 附件目录默认位置（数据目录下） */
const DEFAULT_ATTACH_DIR = path.join(DATA_DIR, 'attachments');

/**
 * 自定义附件目录（settings.attachDir）。
 *
 * 1.24.7：原来这里是模块级常量，改目录只能靠「整库迁移 + 重启」；现在抽成
 * 运行时可变的函数，设置页改完立刻生效，随手记/笔记粘贴的图片也跟着走。
 * 目录不可用（移动硬盘没插）时**不回退默认** —— 回退会让用户以为附件全丢了，
 * 保持原路径至少能在界面上看到「目录不存在」。
 */
let attachDirOverride = '';
try {
  const s = loadSettings() || {};
  const custom = String(s.attachDir || '').trim();
  if (custom && path.isAbsolute(custom)) attachDirOverride = custom;
} catch { /* 设置读不到就用默认 */ }

function currentAttachDir() {
  return attachDirOverride || DEFAULT_ATTACH_DIR;
}

function setAttachDirOverride(dir) {
  attachDirOverride = String(dir || '').trim();
}

/**
 * 笔记附件目录：`<笔记目录>/attachments`（1.25.1）。
 *
 * 用户反馈「切到目录模式后附件和 .md 混在一起」——他期望的是**笔记的截图跟着笔记目录走**，
 * 而不是把全局附件目录也搬过去（那会让网址条目的附件一起消失）。
 * 所以这里只派生一个**额外的**目录，全局 `currentAttachDir()` 保持原样：
 *   - 写入：`attachment:save-image` 带 `scope: 'note'` 时写这里；
 *   - 读取：先找这里，找不到再回退全局（老附件还在全局，不能破坏）。
 *
 * 目录不存在时返回空串（未启用目录模式 / 设置里没选目录），调用方回退全局。
 * 路径来自设置（用户选的绝对路径），仍然做一次「必须是绝对路径」的校验。
 *
 * 性能：这个函数在「按 id 找附件」的热路径上（自检/导出会按附件数量调用几百次），
 * 每次都 `loadSettings()` 等于几百次读盘 + JSON.parse。用 settings.json 的
 * mtime+size 做缓存键：设置一改（settings:save 走 writeFileAtomic）键就变，自动失效。
 */
let notesAttachCache = { key: '\u0000', dir: '' };
function notesAttachDir() {
  let key = 'missing';
  try {
    const st = fs.statSync(SETTINGS_FILE);
    key = `${st.mtimeMs}:${st.size}`;
  } catch { /* 设置文件不存在：按「未启用目录模式」处理 */ }
  if (notesAttachCache.key === key) return notesAttachCache.dir;
  let dir = '';
  try {
    const s = loadSettings() || {};
    const nd = String(s.notesDir || '').trim();
    if (nd && path.isAbsolute(nd)) dir = path.join(nd, 'attachments');
  } catch { /* 设置读不到就当没启用 */ }
  notesAttachCache = { key, dir };
  return dir;
}

/** 附件查找顺序：笔记目录 → 全局目录（去重，笔记目录未启用时只有全局） */
function attachmentDirs() {
  const out = [];
  const seen = new Set();
  for (const dir of [notesAttachDir(), currentAttachDir()]) {
    if (!dir) continue;
    let key = dir;
    try { key = path.resolve(dir).toLowerCase(); } catch { /* 用原串去重 */ }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * 按 id 找到**实际存在**的 .enc 文件：先笔记目录，再全局目录。
 * 找不到返回空串（调用方自己决定是「不存在」还是「按写入路径处理」）。
 */
function resolveAttachmentFile(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) return '';
  for (const dir of attachmentDirs()) {
    const file = path.join(dir, `${safe}.enc`);
    try {
      if (fs.existsSync(file)) return file;
    } catch { /* 目录不可用（移动硬盘没插）就试下一个 */ }
  }
  return '';
}

/**
 * 附件的「规范路径」。
 *
 * 语义是「这个 id 的附件在哪」：已存在就返回它实际所在的目录（笔记目录或全局），
 * 不存在就返回全局目录下的写入路径。这样：
 *   - `attachment:pick` 写入（新 uuid，必然不存在）→ 全局目录，行为不变；
 *   - `attachment:delete` / `attachment:reveal` / 自检的存在性判断 → 自动命中笔记目录；
 *   - 老的全局附件 → 仍然命中全局目录，一个字节都不动。
 */
function attachmentFile(id) {
  const found = resolveAttachmentFile(id);
  if (found) return found;
  return path.join(currentAttachDir(), `${String(id || '').replace(/[^a-zA-Z0-9-]/g, '')}.enc`);
}

function readAttachment(id, password) {
  const file = attachmentFile(id);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  return decrypt(raw, password);
}

/**
 * 改主密码后把附件目录里的 `.enc` 全部用新密码重新加密。
 *
 * 为什么必须有这一步：附件是用**会话主密码**加密落盘的（`attachment:pick` /
 * `attachment:save-image`），而改密只重写了 vault / trash / recoveryData / 剪贴板历史。
 * 结果就是改密之后所有附件都解不开，界面统一显示「附件不存在或已损坏」——
 * 文件还在、大小也对，但 AES-GCM 认证失败，等于永久失效。
 *
 * 三阶段，任何一步失败都不留半新半旧的库：
 *   1. **全部解密**（只读）：任何一个解不开就整体放弃，一个文件都不动；
 *   2. **全部写成 `<file>.new`**：此时正式文件仍未改动，失败就删掉临时文件退出；
 *   3. **逐个 rename 覆盖**：rename 是原子的，单个失败只影响那一个。
 *
 * 用 `.new` + rename 而不是 writeFileAtomic：附件动辄几十 MB，writeFileAtomic 会额外
 * 留一份 `.bak`（附件目录体积翻倍），而 `readAttachment` 并没有 `.bak` 回退，留着没用。
 *
 * 性能：解密阶段全用旧密码、加密阶段全用新密码，且加密前先预热 keyCache 定一个 salt，
 * 所以整批附件只多两次 PBKDF2（~800ms），不会变成「每个附件 400ms」。
 * 历史遗留的附件可能带着不同的 salt（不同会话写入），那部分靠 keyMemo 查表，
 * 最多 64 个不同 salt 各派生一次，不会随附件数量线性增长。
 *
 * @param {string} oldPassword 旧主密码
 * @param {string} newPassword 新主密码
 * @returns {{ total: number, ok: number, failed: number, errors: string[] }}
 */
function reencryptAttachments(oldPassword, newPassword) {
  const result = { total: 0, ok: 0, failed: 0, errors: [] };
  if (!oldPassword || !newPassword) return result;
  // 1.25.1：笔记附件在 `<笔记目录>/attachments`，**必须一起重加密** ——
  // 只处理全局目录的话，改密后目录模式笔记里的截图会全部永久失效（文件在、解不开）。
  // 两个目录各自独立走「全解密 → 全写 .new → 逐个 rename」，一个目录失败不影响另一个。
  for (const dir of attachmentDirs()) {
    const one = reencryptAttachDir(dir, oldPassword, newPassword);
    result.total += one.total;
    result.ok += one.ok;
    result.failed += one.failed;
    for (const e of one.errors) {
      if (result.errors.length < 10) result.errors.push(one.dir ? `${path.basename(path.dirname(one.dir))}/${path.basename(one.dir)}: ${e}` : e);
    }
  }
  return result;
}

/**
 * 单个附件目录的重加密（三阶段，见 reencryptAttachments 的说明）。
 * @param {string} dir
 * @param {string} oldPassword
 * @param {string} newPassword
 */
function reencryptAttachDir(dir, oldPassword, newPassword) {
  const result = { dir, total: 0, ok: 0, failed: 0, errors: [] };
  let names = [];
  try {
    if (!dir || !fs.existsSync(dir)) return result;
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.enc'));
    // 上一次改密中途崩溃留下的临时文件：正式文件没动过，直接清掉
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith('.enc.new')) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* 忽略 */ } }
    }
  } catch (e) {
    result.errors.push(`读取附件目录失败：${e.message}`);
    return result;
  }
  result.total = names.length;
  if (!names.length) return result;

  // ---- 阶段一：全部解密（只读，不动任何文件）----
  const plain = [];
  const bad = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8').trim();
    } catch (e) {
      bad.push(`${name}（读取失败：${e.message}）`);
      continue;
    }
    if (!raw) { bad.push(`${name}（空文件）`); continue; }
    const text = decrypt(raw, oldPassword);
    if (text === null) { bad.push(name); continue; }
    plain.push({ name, file, text });
  }
  if (bad.length) {
    // 整体放弃：宁可一个都不改，也不要留下「一半新密码一半旧密码」的附件目录
    result.failed = bad.length;
    result.errors = bad.slice(0, 10);
    return result;
  }

  // ---- 阶段二：全部写成 .new（正式文件仍未改动）----
  // 预热 keyCache：encrypt() 只在 keyCache.password 匹配时复用 salt/key，不预热的话
  // 每个附件都会生成新 salt → 每个都重跑一次 600k PBKDF2（100 个附件 = 40 秒假死）。
  // 改密流程里 saveVault/saveTrash 已经用新密码写过一次，这里通常直接命中、零额外开销。
  if (!keyCache || keyCache.password !== newPassword) {
    getKey(newPassword, crypto.randomBytes(SALT_LENGTH));
  }
  const staged = [];
  try {
    for (const item of plain) {
      const tmp = `${item.file}.new`;
      writeFileSynced(tmp, encrypt(item.text, newPassword));
      staged.push({ ...item, tmp });
    }
  } catch (e) {
    for (const s of staged) { try { fs.unlinkSync(s.tmp); } catch { /* 忽略 */ } }
    result.failed = plain.length;
    result.errors.push(`写入临时文件失败，已放弃（原附件未改动）：${e.message}`);
    return result;
  }

  // ---- 阶段三：逐个 rename 覆盖 ----
  for (const s of staged) {
    try {
      fs.renameSync(s.tmp, s.file);
      result.ok += 1;
    } catch (e) {
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push(`${s.name}（替换失败：${e.message}）`);
      try { fs.unlinkSync(s.tmp); } catch { /* 忽略 */ }
    }
  }
  return result;
}

// ----------------------------------------------------------------
// IPC Handlers
// ----------------------------------------------------------------
// 启动时的更新检查必须在模块作用域：whenReady 里的定时器访问不到 setupIpcHandlers 内部的函数。
/**
 * 用 Chromium 网络栈取 JSON。⚠️ 不能用 Node 的 fetch(undici)：它不读 Windows 系统代理，
 * 家里/公司只配了系统代理（或规则分流）时 api.github.com 会直接连不上，表现为
 * 「检查更新」转圈 10 秒。net.request 走 Chromium，跟随系统代理设置。
 */
function netFetchJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const fin = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    let request;
    try { request = net.request({ url, redirect: 'follow' }); }
    catch (e) { reject(e); return; }
    timer = setTimeout(() => {
      try { request.abort(); } catch { /* 忽略 */ }
      fin(reject, new Error('请求超时'));
    }, timeoutMs);
    request.setHeader('User-Agent', 'password-manager-app');
    request.setHeader('Accept', 'application/vnd.github+json');
    request.on('response', (response) => {
      if (response.statusCode >= 400) {
        try { response.resume(); } catch { /* 忽略 */ }
        fin(reject, new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.on('data', (c) => { body += c.toString(); });
      response.on('end', () => {
        try { fin(resolve, JSON.parse(body)); }
        catch { fin(reject, new Error('更新信息解析失败')); }
      });
      response.on('error', (e) => fin(reject, e));
    });
    request.on('error', (e) => fin(reject, e));
    request.end();
  });
}

/** 把 resolveProxy 的结果说成人话，给更新弹窗显示「当前走没走代理」 */
function proxyLabel(p) {
  const s = String(p || '').trim();
  if (!s || /^DIRECT/i.test(s)) return '直连';
  const m = s.match(/^(PROXY|SOCKS5?|HTTPS)\s+([^\s;]+)/i);
  return m ? `经代理 ${m[2]}` : s;
}

const GITHUB_RELEASE_API = 'https://api.github.com/repos/belldandy114/password-manager/releases/latest';

/**
 * 回归脚本用 PM_UPDATE_API 指向本地桩服务。它是「版本信息 + 安装包地址 + digest」的信任根，
 * 打包版只放行 127.0.0.1 / localhost，避免任何环境变量把 Release 元数据换成外部地址。
 */
function localStubOverride(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (!app.isPackaged) return s;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(s) ? s : '';
}

async function fetchLatestRelease() {
  try {
    const apiUrl = localStubOverride(process.env.PM_UPDATE_API) || GITHUB_RELEASE_API;
    const json = await netFetchJson(apiUrl, 10000);
    const latest = String(json.tag_name || '').replace(/^v/, '');
    const asset = Array.isArray(json.assets) ? json.assets.find(a => /\.exe$/i.test(a.name || '')) : null;
    return {
      latest,
      htmlUrl: json.html_url || '',
      // 优先给安装包直链 + 官方 SHA-256（下载后校验，防止镜像/代理改包）
      downloadUrl: asset?.browser_download_url || '',
      assetName: asset?.name || '',
      digest: asset?.digest || '',
      notes: (json.body || '').slice(0, 2000),
    };
  } catch (e) {
    // 保留 AbortError 的语义，update:check 会把它显示成「请求超时」
    throw e;
  }
}

// ---- 应用日志（排障用）----

// 壳层 IPC（应用命令 / 搜索小窗 / 随手记 / 日志 / 检查更新）已拆到 electron/ipc-shell.js
registerShellIpc({
  getMainWindow: () => mainWindow,
  isUnlocked: () => appUnlocked,
  hotkeyInfo,
  applyHotkeys,
  showMainWindow,
  showSearchWindow,
  hideSearchWindow,
  setSearchWindowHeight,
  showQuickNote,
  hideQuickNote,
  fetchLatestRelease,
});

/**
 * 启动时静默检查更新：有新版就**在应用内**提示（不弹系统通知），同一版本只提示一次。
 * 完全后台执行且吞掉所有异常——网络不通不该影响启动。
 */
async function autoCheckUpdate() {
  // PM_DEBUG_AUTO_UPDATE=1 时打印阶段日志：回归脚本靠它确认「定时器真的执行到了」
  // （这个函数曾经被误写在 setupIpcHandlers 内部，导致启动 8 秒后 ReferenceError 崩溃）
  const debug = process.env.PM_DEBUG_AUTO_UPDATE === '1';
  try {
    if (debug) console.log('[auto-update] start');
    const s = loadSettings() || {};
    if (s.updateCheckOnStart === false) { if (debug) console.log('[auto-update] disabled by settings'); return; }
    const rel = await fetchLatestRelease();
    if (debug) console.log('[auto-update] latest=' + rel.latest);
    const current = app.getVersion();
    if (!shouldNotifyUpdate({ current, latest: rel.latest, lastNotified: s.updateNotifiedVersion })) {
      if (debug) console.log('[auto-update] no notify');
      return;
    }
    // 只在应用内提示：推给渲染层显示横幅/弹窗，用户点了再打开发布页。
    // （以前用 new Notification 弹 Windows 通知，容易和其他软件的通知混在一起被忽略）
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('update:available', {
          current,
          latest: rel.latest,
          url: rel.htmlUrl || '',
          // 带上更新说明与安装包直链：横幅「去更新」点开弹窗即可展示内容并直接下载，
          // 不用再等一次 update:check 往返
          notes: rel.notes || '',
          downloadUrl: rel.downloadUrl || '',
          assetName: rel.assetName || '',
          digest: rel.digest || '',
        });
      } catch { /* 窗口已关 */ }
    }
    if (debug) console.log('[auto-update] notified ' + rel.latest);
    saveSettings({ ...(loadSettings() || {}), updateNotifiedVersion: rel.latest });
  } catch (e) {
    // 静默：启动检查失败不影响任何功能；但调试模式下要能看到原因
    if (debug) console.log('[auto-update] failed: ' + (e && e.message));
  }
}
/**
 * 允许交给安装程序执行的文件：应用自己下载的（在 update/ 内）+ 用户经文件对话框选中的。
 * ⚠️ 已随 update 域搬到 electron/ipc-update.js（模块内维护），这里不再保留。
 */

/**
 * 可选的周期检查更新定时器。默认 0 = 只在启动后 8 秒查一次（保持旧行为）。
 * ⚠️ 放模块作用域：settings:save 的回调和 whenReady 都要访问，曾经因为写错作用域
 * 在快捷键回调里静默抛 ReferenceError。
 */
let autoUpdateTimer = null;
function restartAutoUpdateCheck() {
  if (autoUpdateTimer) { clearInterval(autoUpdateTimer); autoUpdateTimer = null; }
  const s = loadSettings() || {};
  const hours = Math.min(168, Math.max(0, Number(s.updateCheckIntervalHours) || 0));
  if (hours > 0) {
    autoUpdateTimer = setInterval(() => { void autoCheckUpdate(); }, hours * 3600 * 1000);
    try { autoUpdateTimer.unref?.(); } catch { /* 忽略 */ }
  }
}
function setupIpcHandlers() {

  // ---- 会话状态（auth / entries / zentao 等模块都通过 getter 读写它）----
  let lastActivity = Date.now();

  // ---- 「钉」小窗（实现见 electron/pin-window.js）----
  pinManager.register();

  // ---- 主密码 / 安全词 / 找回密码（实现见 electron/ipc-auth.js）----
  registerAuthIpc({
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
    getPassword: () => currentPassword,
    setPassword: (v) => { currentPassword = v; },
    setUnlocked: (v) => { appUnlocked = v; },
    repersistClipHistory: (pw) => clipHistory.repersist(pw),
    wipeClipHistory: () => clipHistory.wipe(),
    // 改密/重置密码时必须把附件一起重加密，否则改密后所有附件永久失效
    reencryptAttachments,
  });

  // ---- 搜索小窗的会话纪元（palette:epoch）----
  registerShellSessionIpc({
    isUnlocked: () => currentPassword !== null,
    getEpoch: () => vaultEpoch,
  });

  // ---- 备份 / 数据目录 / 审计日志 / 旧版本数据恢复（实现见 electron/ipc-data.js）----
  registerDataIpc({
    DATA_DIR,
    USER_DATA_DIR,
    DATA_FILE,
    BACKUP_DIR,
    getAttachDir: currentAttachDir,
    DEFAULT_ATTACH_DIR,
    backupAttachments,
    restoreAttachments,
    attachmentFile,
    AUDIT_FILE,
    LOCATION_FILE,
    listBackups,
    backupKeepCount,
    backupMirrorDir,
    mirrorBackupFile,
    appendAudit,
    readAudit,
    writeFileAtomic,
    clearCaches,
    getMainWindow: () => mainWindow,
    loadVault,
    getPassword: () => currentPassword,
    loadSettings,
    saveSettings,
    attachmentFile,
    decrypt,
  });

  // ---- 自定义背景图（实现见 electron/ipc-bg.js）----
  registerBgIpc({
    ipcMain,
    dialog,
    nativeImage,
    dataDir: DATA_DIR,
    getWindow: () => mainWindow,
    loadSettings,
    saveSettings,
  });

  // ---- 应用内更新（实现见 electron/ipc-update.js）----
  registerUpdateIpc({
    loadSettings,
    proxyLabel,
    getMainWindow: () => mainWindow,
  });

  // ---- 接口调试 / 通用集合 / 附件 / 密码历史（实现见 electron/ipc-api.js）----
  registerApiIpc({
    getPassword: () => currentPassword,
    getMainWindow: () => mainWindow,
    loadVault,
    saveVault,
    encrypt,
    readAttachment,
    attachmentFile,
    getAttachDir: currentAttachDir,
    vaultCollections: VAULT_COLLECTIONS,
  });

  // ---- 接口调试的 WebSocket / SSE 长连接（实现见 electron/ipc-ws.js）----
  // 连接只活在内存里，锁定/退出时由 clearCaches() 调 closeWsConnections() 全部断开
  registerWsIpc({
    getWindow: () => mainWindow,
    getPassword: () => currentPassword,
  });

  // 禅道 IPC 已拆到 electron/ipc-zentao.js；未读提醒的三个函数从这里取给 ipc-entries.js
  const zentaoIpc = registerZentaoIpc({
    DATA_DIR, loadVault, loadSettings,
    getMainWindow: () => mainWindow,
    getPassword: () => currentPassword,
  });


  // 整库导入 / 导出已拆到 electron/ipc-vault-io.js（两条 plain 导出共用同一套渲染）
  registerVaultIoIpc({
    getPassword: () => currentPassword,
    getMainWindow: () => mainWindow,
    loadVault, saveVault, encrypt, decrypt,
    normalizeImportRecords, parseCsv, dialog, XLSX,
  });

  // 会话 / 条目 / 回收站 / 剪贴板 / 设置 IPC 已拆到 electron/ipc-entries.js
  registerEntriesIpc({
    getPassword: () => currentPassword,
    setPassword: (v) => { currentPassword = v; },
    bumpEpoch: () => { vaultEpoch += 1; },
    setUnlocked: (v) => { appUnlocked = !!v; },
    touchActivity: () => { lastActivity = Date.now(); },
    loadVault, saveVault, loadTrash, saveTrash,
    clearCaches, hideSearchWindow,
    ztRestartNotify: zentaoIpc.restartNotify,
    ztLoadSeen: zentaoIpc.loadSeen,
    ztPushUnread: zentaoIpc.pushUnread,
    backupVaultOncePerDay,
    loadSettings, saveSettings, getWindowPrefs, createTray, destroyTray,
    restartAutoUpdateCheck,
    getMainWindow: () => mainWindow,
    sortByDateDesc, retentionMs: BIN_RETENTION_MS, defaultSettings: DEFAULT_SETTINGS,
    rememberClipboard, clearClipboardAfter, clearClipHistory,
    wipeClipHistory,
    loadClipHistory: () => clipHistory.load(),
    getClipHistory: () => clipHistory.list(),
    getClipboardTimers: () => clipboardTimers,
    resetClipboardTimers: () => { clipboardTimers = {}; },
    closePinWindows: () => pinManager.closeAll(),
  });

  // 系统类 IPC（对话框 / 文件读写 / 应用路径）已拆到 electron/ipc-system.js
  registerSystemIpc({ getWindow: () => mainWindow });
  registerCodelabIpc({ getWindow: () => mainWindow });
  // HTML 预览走独立来源的自定义协议：srcdoc 会继承主窗口 CSP，内联脚本不执行
  registerPreviewIpc();
  // 目录型文件 IPC（周报 / 笔记）已拆到 electron/ipc-files.js
  registerFileIpc({ getWindow: () => mainWindow });
  // 用例库：只做文件管家（收纳/打开/导出），配置存在 <DATA_DIR>/cases.json
  registerCasesIpc({ getWindow: () => mainWindow, dataDir: DATA_DIR });
  registerToolsIpc();
  // 粘贴截图 → 加密附件（#5）：与会话密钥共用同一套加解密与目录
  registerAttachIpc({
    getPassword: () => currentPassword,
    getAttachDir: currentAttachDir,
    defaultAttachDir: DEFAULT_ATTACH_DIR,
    setAttachDirOverride,
    loadSettings,
    saveSettings,
    fileOf: attachmentFile,
    encrypt,
    readAttachment,
    // 1.25.1：笔记附件单独目录（<笔记目录>/attachments），通过 scope:'note' 区分；
    // 读取时先笔记目录再回退全局，老附件不受影响。
    getNotesAttachDir: notesAttachDir,
    resolveFile: resolveAttachmentFile,
    // 批量导出要还原附件原名（原名只存在 vault 的 entry.attachments[].name 里，
    // 磁盘上只有 <uuid>.enc）。不注入也能跑，但导出文件名会退化成 <uuid>.bin。
    loadVault,
  });
  registerBrowserIpc({ loadSettings });
  // 环境巡检（#3）：用 Chromium 网络栈探地址，尊重系统代理与证书
  registerEnvIpc({ loadSettings });
  // JMeter 非 GUI 运行：需要窗口引用（推送流式日志）与设置读写
  registerJmeterIpc({ loadSettings, saveSettings, getWindow: () => mainWindow, dataDir: DATA_DIR });
  registerJmxLibIpc({ ipcMain, dialog, shell, getWindow: () => mainWindow, dataDir: DATA_DIR });
  registerScanIpc({ getMainWindow: () => mainWindow });   // W1 只接线（占位）：业务分别落在 W5 / W6-B / W6-A / W2-B
  registerGitIpc();
  registerAllureIpc({ getMainWindow: () => mainWindow });
  registerTdgIpc({ getMainWindow: () => mainWindow });

  // ---- UI 录制器（契约 [C-114]：5 条 invoke + 1 条推送）----
  // 会话管理器是唯一持有「真 Chrome 子进程 + CDP 连接 + 临时 profile」的地方，
  // 四个停录触发源（session:lock / 自动锁 / 关窗 / 防截屏）都经 recordLockStop 收口。
  recordSession = createRecordSession({
    getDataDir: () => DATA_DIR,
    getPassword: () => currentPassword,
    getMainWindow: () => mainWindow,
    appendAudit,
    // 推送桥：只透传约定键（sessionId / seq / action / target / candidates / ms / valueMeta）
    onEvents: recordEventSender(() => mainWindow),
  });
  registerRecordIpc({ recordSession, getPassword: () => currentPassword });
  // 启动扫残留：只处理命令行前缀匹配本应用 record-profiles 根的进程，先校验再杀；
  // 读不到进程表不重试、写审计后继续（契约 [C-117] 第 3 条）
  setTimeout(() => {
    try { recordSession.scanOrphans(); } catch { /* 扫残留失败不影响启动 */ }
  }, 1500);
  // 退出兜底：窗口已销毁时 'close' 不会再触发，这里再停一次（幂等）
  app.on('before-quit', () => recordLockStop('app-quit'));

}

// 预览协议必须在 app ready 之前登记特权，否则 registerSchemesAsPrivileged 无效
registerPreviewScheme();

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  registerPreviewProtocol();
  // Set app-level icon for Windows taskbar
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.passwordmanager.app');
  }
  // 启动期清理：只在「确实从未初始化」时删文件。
  // ⚠️ 以前这里是 `if (!existingSettings || !existingSettings.masterPasswordHash)` 就
  // unlink vault.enc / trash.enc / settings.json —— settings.json 一旦损坏（半截 JSON、
  // 磁盘满、杀软改写），loadSettings() 返回 null，整个密码库就被当成「残留数据」删掉。
  // 现在判定逻辑在 cleanupStaleVaultOnBoot()（模块作用域，带审计与隔离留证）。
  try {
    const boot = cleanupStaleVaultOnBoot();
    if (boot.action !== 'none') console.log(`[boot] 启动清理：${boot.action}${boot.reason ? ` (${boot.reason})` : ''}`);
  } catch (e) {
    console.warn(`[boot] 启动清理失败（不影响启动）：${e.message}`);
  }
  setupIpcHandlers();
  createWindow();
  // Restore the tray icon when a tray behaviour was enabled in a previous session.
  const prefs = getWindowPrefs();
  if (prefs.minimizeToTray || prefs.closeToTray) createTray();
  // Keep the Windows "start with system" entry in sync with the saved preference.
  if (app.isPackaged) {
    try {
      const s = loadSettings() || {};
      app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, args: [] });
    } catch { /* ignore */ }
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // 启动 8 秒后静默查一次新版本（有新版弹系统通知，同版本只弹一次）。
  // 放最后 + setTimeout：网络请求绝不能影响启动速度。
  setTimeout(() => { autoCheckUpdate(); }, 8000);
  // 设置里开启「周期检查」后按小时重复；autoCheckUpdate 自带版本去重，不会反复弹同一个版本
  restartAutoUpdateCheck();

  // 全局快捷键拆成两个，别让一个键同时管两件事：
  //   显隐 → 只显示/隐藏窗口；搜索 → 只打开搜索（隐藏时按下去直接是搜索框，不先闪主页面）
  // 键位来自设置（可自定义），注册失败会回滚并在设置页提示。
  const boot = applyHotkeys(null, { persist: false });
  if (process.env.PM_DEBUG_HOTKEY) {
    setInterval(() => {
      console.log(`[dbg] search=${hotkeys.search} reg=${globalShortcut.isRegistered(hotkeys.search)} toggle=${hotkeys.toggle} reg=${globalShortcut.isRegistered(hotkeys.toggle)}`);
    }, 2000);
  }
  if (boot.data.search.ok && boot.data.toggle.ok) {
    console.log(`[hotkey] 搜索 ${boot.data.search.label} / 显隐 ${boot.data.toggle.label}`);
    if (boot.data.search.fallback) console.log(`[hotkey] 默认搜索键被占用，暂用 ${boot.data.search.label}`);
  } else {
    console.warn('[hotkey] 注册失败：' + JSON.stringify({
      search: boot.data.search.reason || boot.data.search.label,
      toggle: boot.data.toggle.reason || boot.data.toggle.label,
    }));
  }
});

app.on('before-quit', () => { isQuitting = true; });

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyTray();
});

app.on('window-all-closed', () => {
  for (const k of Object.keys(clipboardTimers)) clearTimeout(clipboardTimers[k]);
  clipboard.clear();
  // If a window was closed while "close to tray" is on, the window is only hidden and
  // never reaches this handler; this path means the app is really shutting down.
  if (process.platform !== 'darwin') app.quit();
});

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sortByDateDesc(arr) {
  return arr.sort((a, b) => new Date(b.deletedAt || b.createdAt) - new Date(a.deletedAt || a.createdAt));
}


