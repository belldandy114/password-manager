const { app, BrowserWindow, clipboard, ipcMain, nativeImage, Menu, shell, dialog, globalShortcut, protocol, Tray, screen, Notification, net, session } = require('electron');
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
// Test Data Generator sub-app paths
// ----------------------------------------------------------------
const TDG_DIST_PATH = IS_DEV
  ? path.join(__dirname, '..', 'dist-tdg')
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-tdg');
const TDG_PRELOAD_PATH = path.join(__dirname, 'preload-tdg.cjs');

// ----------------------------------------------------------------
// 导航守卫
// ----------------------------------------------------------------
// 主窗口开着 webviewTag，但此前没有任何 will-navigate / setWindowOpenHandler /
// will-attach-webview。只要有一条内容能把 <a href> 或 window.open 送到渲染层
// （Markdown 笔记、周报、导入的 CSV……），就能把应用窗口导航走或开出一个没有 preload
// 的空白窗口。判断逻辑全在 electron/nav-guard.js（有单测），这里只做事件挂载。
//
// PM_USE_DIST=1 时虽然仍是开发目录，但主窗口加载的是 file://dist —— 此时不能按
// 「开发态」放行 localhost，否则会把应用自己拦下来。所以开关取同一个表达式。
const USE_DEV_SERVER = IS_DEV && !process.env.PM_USE_DIST;
const APP_DIST_DIR = path.join(__dirname, '..', 'dist');

const { openHttpUrl } = require('./url-open');
const { spawn: spawnForUrlOpen } = require('child_process');
const { installNavigationGuards, guardWebviews } = require('./nav-guard');
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
  distDir: APP_DIST_DIR,
  tdgDistDir: TDG_DIST_PATH,
  tdgPreloadPath: TDG_PRELOAD_PATH
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

function getKey(password, salt) {
  const saltHex = salt.toString('hex');
  if (keyCache && keyCache.password === password && keyCache.saltHex === saltHex) {
    return keyCache.key;
  }
  const key = deriveKey(password, salt);
  keyCache = { password, saltHex, salt: Buffer.from(salt), key };
  return key;
}

// Decrypted data kept in memory for the unlocked session (see loadVault/saveVault).
let vaultCache = { password: null, data: null };
let trashCache = { password: null, data: null };

// Drops every in-memory secret: derived key plus decrypted vault/trash.
function clearCaches() {
  keyCache = null;
  vaultCache = { password: null, data: null };
  trashCache = { password: null, data: null };
  clearApiJar();
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
    // 与本地用同一套保留份数
    const keep = backupKeepCount();
    const files = fs.readdirSync(dir)
      .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
      .sort();
    while (files.length > keep) {
      try { fs.unlinkSync(path.join(dir, files.shift())); } catch { /* ignore */ }
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
      // 本地今天已有：只补齐异地（用户可能是今天才配的第二目录）
      const dir = backupMirrorDir();
      if (dir && !fs.existsSync(path.join(dir, `vault-${day}.enc`))) mirrorBackupFile(target, day);
      return false; // already backed up today
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DATA_FILE, target);
    mirrorBackupFile(target, day);

    const keep = backupKeepCount();
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
      .sort();
    while (files.length > keep) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch { /* ignore */ }
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
  // 环境巡检定时执行（分钟，0 = 关）；只在状态翻转时弹通知
  envProbeInterval: 0,
  envProbeNotifyOnFlip: true,
  backupKeep: 7,
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
  // Show first, then restore: a window that was hidden *while minimized* reports
  // isMinimized() === false until it is visible again, so restoring up-front would be
  // skipped and the user would get a taskbar-minimized window back from the tray.
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function hideToTray() {
  createTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function createTray() {
  if (tray) return;
  let icon = nativeImage.createFromPath(appIconPath());
  if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', 'buildResources', 'icon.ico'));

  tray = new Tray(icon);
  tray.setToolTip('测试中台');
  buildTrayMenu();
  // Left click / double click on the icon restores the window (Windows convention).
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
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
      sandbox: true,
      webviewTag: true
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

  // webview 的 src / preload 白名单（测试数据生成器）
  guardWebviews(mainWindow.webContents, navGuardOptions);

  // "最小化到托盘": hide instead of sitting in the taskbar.
  mainWindow.on('minimize', (event) => {
    if (!getWindowPrefs().minimizeToTray) return;
    event.preventDefault();
    hideToTray();
  });

  // "关闭时最小化到托盘": the window keeps running in the background.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (!getWindowPrefs().closeToTray) return;
    event.preventDefault();
    hideToTray();
  });

  // Persist size/position (debounced) and remember it on the way out.
  ['resize', 'move', 'maximize', 'unmaximize'].forEach(ev => mainWindow.on(ev, scheduleSaveWindowState));
  mainWindow.on('close', () => saveWindowState());

  // Privacy: keep the vault out of screen captures/recordings when enabled.
  if ((loadSettings() || {}).contentProtection) mainWindow.setContentProtection(true);

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
const { registerToolsIpc } = require('./ipc-tools');
const { registerBrowserIpc } = require('./ipc-browser');
const { registerJmeterIpc } = require('./ipc-jmeter');
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
const { registerUpdateIpc } = require('./ipc-update');
const { registerApiIpc, clearApiJar } = require('./ipc-api');

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
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');

function attachmentFile(id) {
  return path.join(ATTACH_DIR, `${String(id).replace(/[^a-zA-Z0-9-]/g, '')}.enc`);
}

function readAttachment(id, password) {
  const file = attachmentFile(id);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return null;
  return decrypt(raw, password);
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
    ATTACH_DIR,
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
    attachmentFile,
    decrypt,
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
    attachDir: ATTACH_DIR,
    vaultCollections: VAULT_COLLECTIONS,
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
  registerSystemIpc({ getWindow: () => mainWindow, tdgPaths: { distPath: TDG_DIST_PATH, preloadPath: TDG_PRELOAD_PATH } });
  registerCodelabIpc({ getWindow: () => mainWindow });
  // HTML 预览走独立来源的自定义协议：srcdoc 会继承主窗口 CSP，内联脚本不执行
  registerPreviewIpc();
  // 目录型文件 IPC（周报 / 笔记）已拆到 electron/ipc-files.js
  registerFileIpc({ getWindow: () => mainWindow });
  registerToolsIpc();
  // 粘贴截图 → 加密附件（#5）：与会话密钥共用同一套加解密与目录
  registerAttachIpc({
    getPassword: () => currentPassword,
    attachDir: ATTACH_DIR,
    fileOf: attachmentFile,
    encrypt,
    readAttachment,
  });
  registerBrowserIpc({ loadSettings });
  // 环境巡检（#3）：用 Chromium 网络栈探地址，尊重系统代理与证书
  registerEnvIpc({ loadSettings });
  // JMeter 非 GUI 运行：需要窗口引用（推送流式日志）与设置读写
  registerJmeterIpc({ loadSettings, saveSettings, getWindow: () => mainWindow, dataDir: DATA_DIR });

}

// ---- Custom protocol for sub-app ----
function setupTdgProtocol() {
  protocol.registerFileProtocol('tdg', (request, callback) => {
    let filePath = request.url.replace('tdg://', '');
    // Default to index.html for directory requests
    if (!filePath || filePath.endsWith('/')) filePath += 'index.html';
    callback({ path: path.join(TDG_DIST_PATH, decodeURIComponent(filePath)) });
  }, (error) => {
    if (error) console.error('Failed to register tdg protocol:', error);
  });
}
// 预览协议必须在 app ready 之前登记特权，否则 registerSchemesAsPrivileged 无效
registerPreviewScheme();

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  // Register custom protocol for test-data-generator sub-app
  setupTdgProtocol();
  registerPreviewProtocol();
  // Set app-level icon for Windows taskbar
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.passwordmanager.app');
  }
  // Clean up stale vault data on fresh install (no master password set up)
  const existingSettings = loadSettings();
  if (!existingSettings || !existingSettings.masterPasswordHash) {
    [DATA_FILE, BIN_FILE, SETTINGS_FILE].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
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