const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Menu, shell, dialog, globalShortcut, protocol, Tray, screen, Notification, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
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
const { ALGO, SALT_LENGTH, IV_LENGTH, TAG_LENGTH, inspectVaultFile } = require('./vault-file');
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
  apiJar.clear();
}

// ----------------------------------------------------------------
// API 调试的「会话 Cookie 罐」（api:send 用）
// 只放内存、不落盘：这些是别人的登录态 token，落盘就等于把凭证明文写在磁盘上。
// 锁定 / 退出时由 clearCaches() 一并清空，所以重启或锁定后需要重新登录一次。
// ----------------------------------------------------------------
const apiJar = new Map(); // origin -> Map(name -> { value, expiresAt })

function apiJarAbsorb(origin, setCookieList) {
  let jar = apiJar.get(origin);
  if (!jar) { jar = new Map(); apiJar.set(origin, jar); }
  for (const raw of setCookieList || []) {
    const parts = String(raw).split(';');
    const first = parts.shift() || '';
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    let expiresAt = 0; // 0 = 会话级
    let expireFlag = 0; // -1 = 立即删除
    for (const p of parts) {
      const eq = p.indexOf('=');
      const k = (eq > 0 ? p.slice(0, eq) : p).trim().toLowerCase();
      const v = eq > 0 ? p.slice(eq + 1).trim() : '';
      if (k === 'max-age') {
        const n = Number(v);
        if (Number.isFinite(n)) expireFlag = n <= 0 ? -1 : 0, expiresAt = n <= 0 ? 0 : Date.now() + n * 1000;
      } else if (k === 'expires') {
        const t = Date.parse(v);
        if (Number.isFinite(t)) { expiresAt = t; expireFlag = t <= Date.now() ? -1 : 0; }
      }
    }
    if (expireFlag === -1) jar.delete(name);
    else jar.set(name, { value, expiresAt });
  }
  if (!jar.size) apiJar.delete(origin);
}

function apiJarHeader(origin) {
  const jar = apiJar.get(origin);
  if (!jar || !jar.size) return '';
  const out = [];
  for (const [name, v] of jar) {
    if (v.expiresAt > 0 && v.expiresAt <= Date.now()) { jar.delete(name); continue; }
    out.push(`${name}=${v.value}`);
  }
  return out.join('; ');
}

function apiJarList(origin) {
  const rows = [];
  for (const [o, jar] of apiJar) {
    if (origin && o !== origin) continue;
    for (const [name, v] of jar) {
      if (v.expiresAt > 0 && v.expiresAt <= Date.now()) continue;
      rows.push({ origin: o, name, expiresAt: v.expiresAt });
    }
  }
  return rows;
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
        result = normalizeVault(JSON.parse(json));
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

function saveVault(vault, password) {
  const json = JSON.stringify(vault);
  const encrypted = encrypt(json, password);
  // Snapshot yesterday's file before it is overwritten (once per day).
  backupVaultOncePerDay();
  writeFileAtomic(DATA_FILE, encrypted);
  vaultCache = { password, data: vault };
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
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
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
  backupKeep: 7,
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
/**
 * 默认搜索键被别的程序占走时的兜底。只在「没自定义过」时生效，
 * 用户自己改的键冲突就如实报错，不做静默替换。
 */
const SEARCH_HOTKEY_FALLBACKS = ['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+F'];

/** 每个动作「实际注册成功」的加速键，'' 表示没注册上 */
const hotkeys = { search: '', toggle: '' };
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
  const sSearch = normAccel(o.search) || envSearch || normAccel(s.hotkeySearch);
  const sToggle = normAccel(o.toggle) || envToggle || normAccel(s.hotkeyToggle);
  return {
    search: sSearch || DEFAULT_HOTKEY_SEARCH,
    toggle: sToggle || DEFAULT_HOTKEY_TOGGLE,
    // 自定义过就不走兜底，冲突要如实报出来
    searchCustom: !!(normAccel(s.hotkeySearch) || envSearch || normAccel(o.search)),
    toggleCustom: !!(normAccel(s.hotkeyToggle) || envToggle || normAccel(o.toggle)),
    // 回归脚本用环境变量临时换键，不能写进用户设置
    searchFromEnv: !normAccel(o.search) && !!envSearch,
    toggleFromEnv: !normAccel(o.toggle) && !!envToggle,
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
  };

  if (want.search.toLowerCase() === want.toggle.toLowerCase()) {
    res.search.reason = 'same';
    res.toggle.reason = 'same';
    return { ok: false, data: res };
  }

  const prev = { search: hotkeys.search, toggle: hotkeys.toggle };
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

  const allOk = res.search.ok && res.toggle.ok;
  if (!allOk) {
    // 整体回滚：不把用户原来能用的键弄丢
    unregisterHotkeys();
    if (prev.search && tryRegister(prev.search, () => openSearchPalette())) hotkeys.search = prev.search;
    if (prev.toggle && tryRegister(prev.toggle, () => toggleMainWindow())) hotkeys.toggle = prev.toggle;
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
  if (IS_DEV && !process.env.PM_USE_DIST) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

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
 * 敏感复制历史（内存级，最多 10 条）。
 * 只在设置里显式开启才记录；锁屏、退出、点「清空」都会清掉，不落盘。
 */
const CLIP_HISTORY_MAX = 10;
const clipHistory = [];

function rememberClipboard(text) {
  try {
    if (!(loadSettings() || {}).clipboardHistory) return;
    const t = String(text || '');
    if (!t) return;
    if (clipHistory[0] && clipHistory[0].text === t) return;
    clipHistory.unshift({ text: t, at: new Date().toISOString() });
    while (clipHistory.length > CLIP_HISTORY_MAX) clipHistory.pop();
  } catch { /* 记录失败不影响复制 */ }
}

function clearClipHistory() {
  clipHistory.length = 0;
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
const { ztDecodeEntities, ztStripTags, ztTableRows } = require('./zentao-parse');
const { cmpVersion, shouldNotifyUpdate } = require('./update-check');
const { registerFileIpc } = require('./ipc-files');
const { registerToolsIpc } = require('./ipc-tools');
const { registerBrowserIpc } = require('./ipc-browser');
const { registerJmeterIpc } = require('./ipc-jmeter');
const { registerSystemIpc } = require('./ipc-system');
const { registerCodelabIpc } = require('./ipc-codelab');
const { filterMineBugs } = require('./zentao-filter');
const { parseMultipartLine } = require('./multipart');
const { logPath, tail: logTail } = require('./app-log');

// ----------------------------------------------------------------
// Vault shape (1.2.0 expanded from { entries, tags })
// ----------------------------------------------------------------
// 新增模块（SQL 片段 / 笔记 / 检查清单 / 账号池 / 环境总览 / 接口调试）都放在同一个
// 加密文件里，随密码库一起加密，不额外增加新的密码。旧数据缺少这些字段时补空数组。
// 结构归一化抽到 electron/vault-schema.js（带单测）：它是旧库升级的唯一关口，不能靠肉眼保证
const { VAULT_COLLECTIONS, normalizeVault } = require('./vault-schema');

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

async function fetchLatestRelease() {
  try {
    // PM_UPDATE_API 仅供本地回归脚本指向桩服务（视觉验证更新弹窗用），正常启动不会设置
    const apiUrl = process.env.PM_UPDATE_API
      || 'https://api.github.com/repos/belldandy114/password-manager/releases/latest';
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
// ---- 旧版本数据恢复（改名后「新库已建、旧库还在」时手动搬）----
function legacyInfo() {
  const { planLegacyMigration } = require('./legacy-migrate');
  const current = app.getPath('userData');
  const plan = planLegacyMigration({
    appData: process.env.PM_APP_DATA || app.getPath('appData'),
    currentUserData: current,
    isDir: (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } },
    hasVault: (d) => fs.existsSync(path.join(d, 'vault.enc')),
    currentHasVault: fs.existsSync(path.join(current, 'vault.enc')),
  });
  return {
    legacyDir: plan.legacyDir || '',
    found: plan.found || [],
    currentHasVault: fs.existsSync(path.join(current, 'vault.enc')),
  };
}

ipcMain.handle('data:legacy-info', async () => ({ success: true, data: legacyInfo() }));

ipcMain.handle('data:recover-legacy', async () => {
  try {
    const info = legacyInfo();
    if (!info.legacyDir) return { success: false, error: '没有找到可恢复的旧数据' };
    const current = app.getPath('userData');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // 现有库先备份，绝不直接覆盖
    const curVault = path.join(current, 'vault.enc');
    if (fs.existsSync(curVault)) {
      fs.copyFileSync(curVault, path.join(current, `vault.enc.before-recover-${ts}`));
    }
    let copied = 0;
    for (const item of ['vault.enc', 'vault.enc.bak', 'settings.json']) {
      const src = path.join(info.legacyDir, item);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(current, item));
      copied += 1;
    }
    console.log(`[recover] 已从 ${info.legacyDir} 恢复 ${copied} 个文件（原库已备份）`);
    return { success: true, data: { from: info.legacyDir, copied, backup: ts } };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('app:relaunch', async () => {
  app.relaunch();
  app.exit(0);
  return { success: true };
});

/** 设置页显示真实生效的全局快捷键（自定义或回退后都不能写死） */
ipcMain.handle('app:hotkeys', async () => ({ success: true, data: hotkeyInfo() }));

/**
 * 改全局快捷键：先试着注册，成功才落盘；失败会把原因（conflict / same）带回去，
 * 并回滚到原来能用的组合。
 */
ipcMain.handle('app:hotkeys-apply', async (_event, payload) => {
  try {
    const r = applyHotkeys({ search: payload && payload.search, toggle: payload && payload.toggle }, { persist: true });
    return {
      success: r.ok,
      data: r.data,
      rolledBack: !!r.rolledBack,
      error: r.ok ? '' : (r.data.search.reason || r.data.toggle.reason || 'conflict'),
      info: hotkeyInfo(),
    };
  } catch (e) {
    return { success: false, error: e.message, info: hotkeyInfo() };
  }
});

// ---- 独立快速搜索小窗 ----
ipcMain.handle('palette:hide', () => {
  hideSearchWindow();
  return { success: true };
});

/** 与全局快捷键等价的入口（托盘/回归脚本用；未解锁时只把主窗口带出来） */
ipcMain.handle('palette:show', () => {
  if (!appUnlocked) { showMainWindow(); return { success: false, error: 'locked' }; }
  showSearchWindow();
  return { success: true };
});

/** 按结果条数调整小窗高度：没输入时只留一个搜索框 */
ipcMain.handle('palette:resize', (_event, height) => {
  setSearchWindowHeight(height);
  return { success: true };
});

/** 网址条目：补上协议后交给系统默认浏览器，不要把应用窗口拉出来 */
function openEntryInBrowser(raw) {
  let url = String(raw || '').trim();
  if (!url) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  // 只允许 http(s)，避免把奇怪的 scheme 丢给系统
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    shell.openExternal(url);
    if (process.env.PM_DEBUG_HOTKEY) console.log('[palette] open-url ' + url);
    return true;
  } catch (e) {
    console.warn('[palette] 打开网址失败: ' + e.message);
    return false;
  }
}

/** 选中一条命令：网址 → 默认浏览器；其它 → 收起小窗并让主窗口执行 */
ipcMain.handle('palette:run', (_event, item) => {
  hideSearchWindow();
  // 网址类：直接开浏览器，应用保持原样（不用跳转、不用弹出主窗口）
  if (item && typeof item.id === 'string' && item.id.startsWith('entry:') && item.url) {
    if (openEntryInBrowser(item.url)) return { success: true };
  }
  if (item && item.id === 'action:lock') {
    // 锁定不需要把窗口提前拉出来，原地锁就行
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('palette:run', item); } catch { /* 忽略 */ }
    return { success: true };
  }
  showMainWindow();
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('palette:run', item || {}); } catch { /* 忽略 */ }
  return { success: true };
});

/** 小窗里发现还没解锁：收起小窗，把主窗口叫出来解锁 */
ipcMain.handle('palette:unlock', () => {
  hideSearchWindow();
  showMainWindow();
  return { success: true };
});

ipcMain.handle('log:info', async () => ({ success: true, data: { path: logPath() || '' } }));
ipcMain.handle('log:open', async () => {
  const f = logPath();
  if (!f || !fs.existsSync(f)) return { success: false, error: '还没有日志文件' };
  const err = await shell.openPath(path.dirname(f));
  return err ? { success: false, error: err } : { success: true, data: { path: f } };
});
ipcMain.handle('log:tail', async (_e, lines = 200) => ({
  success: true,
  data: { path: logPath() || "", text: String(logTail(Number(lines) || 200) || "") },
}));

/** 渲染层错误/警告转写到主进程 app.log（app-log.js 已劫持 console.warn/error） */
ipcMain.handle('log:renderer', async (_e, payload = {}) => {
  const level = payload.level === 'error' ? 'error' : 'warn';
  const line = '[renderer] ' + String(payload.message || '').slice(0, 600);
  if (level === 'error') console.error(line);
  else console.warn(line);
  return { success: true };
});

ipcMain.handle('update:check', async () => {
  try {
    const rel = await fetchLatestRelease();
    const current = app.getVersion();
    return {
      success: true,
      data: {
        current,
        latest: rel.latest,
        hasUpdate: !!rel.latest && cmpVersion(rel.latest, current) > 0,
        url: rel.htmlUrl,
        downloadUrl: rel.downloadUrl,
        assetName: rel.assetName,
        digest: rel.digest,
        notes: rel.notes,
      },
    };
  } catch (e) {
    return { success: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
  }
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
function setupIpcHandlers() {

  // Brute-force guard: 5 wrong passwords in a row → 30s cool-down (in-memory, resets on restart).
  const LOGIN_MAX_FAILURES = 5;
  const LOGIN_LOCK_MS = 30000;
  let loginFailures = 0;
  let loginLockedUntil = 0;

  // ---- Master password ----
  ipcMain.handle('auth:is-setup', () => {
    // 首次启动时把旧版本数据搬过来（只在还没有 vault.enc 时）
    const migrated = migrateLegacyInto(DATA_DIR);
    if (migrated.copied > 0) clearCaches();
    const settings = loadSettings();
    return !!(settings && settings.masterPasswordHash);
  });

  ipcMain.handle('auth:setup', (_event, { password, hint }) => {
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

  ipcMain.handle('auth:verify', (_event, { password }) => {
    const wait = loginLockedUntil - Date.now();
    if (wait > 0) {
      return { success: false, error: `密码错误次数过多，请 ${Math.ceil(wait / 1000)} 秒后再试`, retryAfterMs: wait };
    }
    const settings = loadSettings();
    if (!settings) return { success: false, error: '未初始化' };
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
    // The session now belongs to the new password — cached key/vault still hold the old
    // one, so drop them and continue the session under the new password.
    clearCaches();
    currentPassword = newPassword;
    return { success: true };
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
    // Password reset always ends the session: the user must unlock with the new password.
    clearCaches();
    currentPassword = null;
    appUnlocked = false;
    return { success: true };
  });

  // ---- Entries ----
  let currentPassword = null;
  let lastActivity = Date.now();

ipcMain.handle('session:unlock', (_event, { password }) => {
  clearCaches();
  const vault = loadVault(password);
  if (!vault) return { success: false };
  currentPassword = password;
  appUnlocked = true;
  lastActivity = Date.now();
    // 解锁后启动禅道新 Bug 提醒（内部会检查开关）
    setTimeout(() => { try { ztRestartNotify(); } catch { /* 提醒失败不影响解锁 */ } }, 0);
    // 侧边栏红点：把上次没看的未读数推给界面
    setTimeout(() => { try { ztLoadSeen(); ztPushUnread(); } catch { /* 忽略 */ } }, 0);
    // 解锁即补一次当日备份：只改密码不改数据的日子也能有快照
    setTimeout(() => { try { backupVaultOncePerDay(); } catch { /* 忽略 */ } }, 400);
    return { success: true, data: vault };
  });

  ipcMain.handle('session:lock', () => {
    currentPassword = null;
    appUnlocked = false;
    clearCaches();
    clearClipHistory();
    try { ztRestartNotify(); } catch { /* 锁定后自动停掉定时器 */ }
    hideSearchWindow();
    return { success: true };
  });

  ipcMain.handle('session:is-unlocked', () => {
    return { unlocked: currentPassword !== null };
  });

  ipcMain.handle('session:touch', () => {
    lastActivity = Date.now();
    return { success: true };
  });

  // ---- CRUD ----
  ipcMain.handle('entries:get-all', () => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:add', (_event, entry) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    vault.entries.push(entry);
    // Update tags list
    if (entry.tags) {
      entry.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
    }
    saveVault(vault, currentPassword);
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:update', (_event, entry) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    const idx = vault.entries.findIndex(e => e.id === entry.id);
    if (idx === -1) return { success: false, error: '网址不存在' };
    const prev = vault.entries[idx];

    // 密码变更时留一份历史（最多 10 条），改错了还能翻回来
    let next = entry;
    if (prev.password && entry.password && prev.password !== entry.password) {
      const list = Array.isArray(vault.history[entry.id]) ? vault.history[entry.id] : [];
      list.unshift({ password: prev.password, changedAt: new Date().toISOString() });
      vault.history[entry.id] = list.slice(0, 10);
      next = { ...entry, passwordUpdatedAt: new Date().toISOString() };
    } else if (!entry.passwordUpdatedAt && prev.passwordUpdatedAt) {
      next = { ...entry, passwordUpdatedAt: prev.passwordUpdatedAt };
    }

    vault.entries[idx] = next;
    // Update tags list
    if (next.tags) {
      next.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
    }
    // Clean up orphaned tags
    const usedTags = new Set(vault.entries.flatMap(e => e.tags || []));
    vault.tags = vault.tags.filter(t => usedTags.has(t));
    saveVault(vault, currentPassword);
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:delete', (_event, { ids, permanent }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };

    if (permanent) {
      // Permanently delete
      vault.entries = vault.entries.filter(e => !ids.includes(e.id));
    } else {
      // Move to trash
      const trash = loadTrash(currentPassword) || [];
      const now = new Date().toISOString();
      const toTrash = vault.entries.filter(e => ids.includes(e.id));
      toTrash.forEach(e => { e.deletedAt = now; });
      trash.push(...toTrash);
      saveTrash(trash, currentPassword);
      vault.entries = vault.entries.filter(e => !ids.includes(e.id));
    }
    // Clean up orphaned tags
    const usedTags = new Set(vault.entries.flatMap(e => e.tags || []));
    vault.tags = vault.tags.filter(t => usedTags.has(t));
    saveVault(vault, currentPassword);
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:batch-update', (_event, { ids, changes }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    vault.entries.forEach(e => {
      if (ids.includes(e.id)) {
        Object.assign(e, changes);
        e.updatedAt = new Date().toISOString();
      }
    });
    // Clean up orphaned tags
    const usedTags = new Set(vault.entries.flatMap(e => e.tags || []));
    vault.tags = vault.tags.filter(t => usedTags.has(t));
    saveVault(vault, currentPassword);
    return { success: true, data: vault };
  });

  // ---- Trash ----
  ipcMain.handle('trash:get-all', () => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const trash = loadTrash(currentPassword);
    if (!trash) return { success: false, error: '数据损坏' };
    // Auto-clean expired items
    const now = Date.now();
    const valid = trash.filter(e => {
      return e.deletedAt && (now - new Date(e.deletedAt).getTime() < BIN_RETENTION_MS);
    });
    if (valid.length !== trash.length) saveTrash(valid, currentPassword);
    return { success: true, data: sortByDateDesc(valid) };
  });

  ipcMain.handle('trash:restore', (_event, ids) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const trash = loadTrash(currentPassword);
    const vault = loadVault(currentPassword);
    if (!trash || !vault) return { success: false, error: '数据损坏' };
    const toRestore = [];
    const remaining = trash.filter(e => {
      if (ids.includes(e.id)) {
        delete e.deletedAt;
        e.updatedAt = new Date().toISOString();
        toRestore.push(e);
        return false;
      }
      return true;
    });
    vault.entries.push(...toRestore);
    saveTrash(remaining, currentPassword);
    saveVault(vault, currentPassword);
    return { success: true, data: { entries: vault.entries, trash: remaining } };
  });

  ipcMain.handle('trash:empty', () => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    saveTrash([], currentPassword);
    return { success: true };
  });

  // ---- Clipboard ----
  ipcMain.handle('clipboard:copy', (_event, { text, delay }) => {
    clipboard.writeText(text);
    if (delay > 0) {
      rememberClipboard(text);
      clearClipboardAfter(delay);
    }
    return { success: true };
  });

  /** 敏感复制历史（设置页展示；默认关闭时不记录） */
  ipcMain.handle('clipboard:history', () => ({
    success: true,
    data: { enabled: !!(loadSettings() || {}).clipboardHistory, items: clipHistory.slice() },
  }));

  ipcMain.handle('clipboard:history-clear', () => {
    clearClipHistory();
    return { success: true };
  });

  ipcMain.handle('clipboard:clear', () => {
    clipboard.clear();
    for (const k of Object.keys(clipboardTimers)) {
      clearTimeout(clipboardTimers[k]);
    }
    clipboardTimers = {};
    return { success: true };
  });

  // ---- Settings (user preferences) ----
  ipcMain.handle('settings:get', () => {
    const s = loadSettings() || {};
    return {
      clipboardClearDelay: s.clipboardClearDelay || DEFAULT_SETTINGS.clipboardClearDelay,
      passwordAutoHideDelay: s.passwordAutoHideDelay || DEFAULT_SETTINGS.passwordAutoHideDelay,
      autoLockDelay: s.autoLockDelay || DEFAULT_SETTINGS.autoLockDelay,
      defaultViewMode: s.defaultViewMode || DEFAULT_SETTINGS.defaultViewMode,
      defaultEnvFilter: s.defaultEnvFilter || DEFAULT_SETTINGS.defaultEnvFilter,
      theme: s.theme || DEFAULT_SETTINGS.theme,
      accent: s.accent || DEFAULT_SETTINGS.accent,
      density: s.density || DEFAULT_SETTINGS.density,
      minimizeToTray: !!s.minimizeToTray,
      closeToTray: !!s.closeToTray,
      contentProtection: !!s.contentProtection,
      launchAtLogin: !!s.launchAtLogin,
      lastPage: s.lastPage || DEFAULT_SETTINGS.lastPage,
      zentaoNotify: !!s.zentaoNotify,
      zentaoNotifyInterval: Number(s.zentaoNotifyInterval) || DEFAULT_SETTINGS.zentaoNotifyInterval,
      // 多套禅道配置里「当前用哪套」：主进程的定时提醒也要跟着它走
      zentaoActiveId: String(s.zentaoActiveId || 'zentao'),
      backupKeep: Math.min(60, Math.max(1, Number(s.backupKeep) || DEFAULT_SETTINGS.backupKeep)),
      browserPaths: s.browserPaths || { ...DEFAULT_SETTINGS.browserPaths },
      keybindings: s.keybindings || { ...DEFAULT_SETTINGS.keybindings },
    };
  });

  ipcMain.handle('settings:save', (_event, prefs) => {
    const s = loadSettings() || {};
    Object.assign(s, prefs);
    saveSettings(s);
    // Keep the tray icon in sync: create it as soon as a tray behaviour is enabled,
    // remove it when both are off so the user is not left with a stray icon.
    if (prefs && (Object.prototype.hasOwnProperty.call(prefs, 'zentaoNotify')
      || Object.prototype.hasOwnProperty.call(prefs, 'zentaoNotifyInterval'))) {
      try { ztRestartNotify(); } catch { /* 忽略 */ }
    }

    const p = getWindowPrefs();
    if (p.minimizeToTray || p.closeToTray) createTray();
    else {
      // Only tear the tray down if the window is visible — otherwise the app would
      // become unreachable while hidden.
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) destroyTray();
    }

    // Privacy: exclude the window from screenshots / screen recordings.
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'contentProtection')
      && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(!!prefs.contentProtection);
    }

    // Start with Windows (only meaningful for the installed app).
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'launchAtLogin') && app.isPackaged) {
      try {
        // 带 --hidden：开机启动时不弹窗，直接驻留托盘（否则每次开机都蹦一个窗口）
        app.setLoginItemSettings({
          openAtLogin: !!prefs.launchAtLogin,
          path: process.execPath,
          args: ['--hidden'],
        });
      } catch { /* ignore */ }
    }
    return { success: true };
  });

  // ---- Backups ----
  ipcMain.handle('backup:list', () => ({
    success: true,
    data: listBackups(),
    dir: BACKUP_DIR,
    keep: backupKeepCount(),
    lastAt: (listBackups()[0] || {}).mtime || '',
  }));

  /** 备份状态：本地目录 + 异地目录（设置里配的第二目录/网盘） */
  ipcMain.handle('backup:status', () => {
    const local = listBackups();
    const mirrorDir = backupMirrorDir();
    let mirror = { dir: mirrorDir, files: [], lastAt: '' };
    if (mirrorDir) {
      try {
        const files = fs.readdirSync(mirrorDir)
          .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
          .sort()
          .reverse()
          .map(name => {
            const st = fs.statSync(path.join(mirrorDir, name));
            return { name, size: st.size, mtime: st.mtime.toISOString() };
          });
        mirror = { dir: mirrorDir, files, lastAt: (files[0] || {}).mtime || '' };
      } catch (e) {
        mirror = { dir: mirrorDir, files: [], lastAt: '', error: e.message };
      }
    }
    return {
      success: true,
      data: { local: { dir: BACKUP_DIR, files: local, keep: backupKeepCount() }, mirror },
    };
  });

  /** 选异地备份目录（可选同步盘里的文件夹） */
  ipcMain.handle('backup:mirror-pick', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择异地备份目录（可以是 OneDrive / 坚果云 等同步盘的文件夹）',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 立即备份一次（不等「每天一次」）：本地 + 异地，返回两边路径 */
  ipcMain.handle('backup:now', async () => {
    try {
      if (!fs.existsSync(DATA_FILE)) return { success: false, error: '还没有密码库可备份' };
      const day = new Date().toISOString().slice(0, 10);
      const target = path.join(BACKUP_DIR, `vault-${day}.enc`);
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.copyFileSync(DATA_FILE, target);
      const mirror = mirrorBackupFile(target, day);
      appendAudit({ action: 'vault-backup', entry: path.basename(target) });
      return { success: true, data: { file: target, day, mirror } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 备份恢复：把指定备份原子写回正式库。
   * 恢复前先把当前库另存为 vault-prerestore-<时间>.enc（后悔药），恢复后清缓存并退回登录页
   * —— 备份可能是旧主密码加密的，必须重新走一次解锁来验证。
   */
  ipcMain.handle('backup:restore', async (_event, { name } = {}) => {
    try {
      const safe = path.basename(String(name || ''));
      if (!/^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(safe)) {
        return { success: false, error: '备份文件名不合法' };
      }
      const src = path.join(BACKUP_DIR, safe);
      if (!fs.existsSync(src)) return { success: false, error: '备份文件不存在' };

      // 恢复是「直接写回主库」：先做结构自检，半截/选错的文件一律不覆盖现有密码库。
      // 少了这一步，损坏的备份会把好库盖掉，用户只能靠 pre-restore 快照救回来。
      const inspection = inspectVaultFile(fs.readFileSync(src, 'utf8'));
      if (!inspection.ok) {
        return { success: false, error: `备份文件损坏，已取消恢复（${inspection.error}）` };
      }

      let preRestore = '';
      if (fs.existsSync(DATA_FILE)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
        preRestore = `vault-prerestore-${ts}.enc`;
        fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, preRestore));
        // 反悔用的快照只留最近 5 份，避免无限增长
        const pres = fs.readdirSync(BACKUP_DIR)
          .filter(f => /^vault-prerestore-.*\.enc$/.test(f))
          .sort();
        while (pres.length > 5) {
          try { fs.unlinkSync(path.join(BACKUP_DIR, pres.shift())); } catch { /* ignore */ }
        }
      }

      writeFileAtomic(DATA_FILE, fs.readFileSync(src, 'utf8'));
      clearCaches();
      appendAudit({ action: 'vault-restore', entry: safe });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lock-request');
      return { success: true, preRestore };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- 数据目录：看清楚在哪 / 打开 / 迁移到别的盘 ----
  ipcMain.handle('data:info', () => {
    const stat = (f) => {
      try { const s = fs.statSync(f); return { size: s.size, mtime: s.mtime.toISOString() }; } catch { return null; }
    };
    return {
      success: true,
      data: {
        dataDir: DATA_DIR,
        defaultDir: USER_DATA_DIR,
        isCustom: path.resolve(DATA_DIR) !== path.resolve(USER_DATA_DIR),
        vaultFile: DATA_FILE,
        backupDir: BACKUP_DIR,
        attachDir: ATTACH_DIR,
        backupCount: listBackups().length,
        vault: stat(DATA_FILE),
        bak: stat(`${DATA_FILE}.bak`),
      },
    };
  });

  ipcMain.handle('data:open-folder', async (_event, { which } = {}) => {
    const target = which === 'backups' ? BACKUP_DIR : DATA_DIR;
    try {
      fs.mkdirSync(target, { recursive: true });
      await shell.openPath(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 迁移：只复制不删除，旧目录原样保留；写指针文件后需要重启才生效 */
  ipcMain.handle('data:migrate', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择新的数据目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      const target = r.filePaths[0];
      if (path.resolve(target) === path.resolve(DATA_DIR)) return { success: false, error: '这就是当前数据目录' };

      const copied = [];
      for (const f of ['vault.enc', 'vault.enc.bak', 'trash.enc', 'trash.enc.bak', 'settings.json', 'audit.log', 'window-state.json']) {
        const src = path.join(DATA_DIR, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(target, f));
          copied.push(f);
        }
      }
      for (const d of ['backups', 'attachments']) {
        const src = path.join(DATA_DIR, d);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.join(target, d), { recursive: true });
          copied.push(`${d}/`);
        }
      }
      fs.writeFileSync(LOCATION_FILE, JSON.stringify({ dir: target, from: DATA_DIR, at: new Date().toISOString() }, null, 2), 'utf8');
      appendAudit({ action: 'data-migrate', entry: target });
      return { success: true, data: { dir: target, copied } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 改回默认目录（userData） */
  ipcMain.handle('data:reset-location', () => {
    try {
      if (fs.existsSync(LOCATION_FILE)) fs.unlinkSync(LOCATION_FILE);
      return { success: true, data: { dir: USER_DATA_DIR } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('audit:log', (_event, entry) => {
    if (!entry || !entry.action) return { success: false };
    appendAudit({ action: String(entry.action).slice(0, 40), detail: String(entry.detail || '').slice(0, 200) });
    return { success: true };
  });

  ipcMain.handle('audit:list', (_event, limit) => ({ success: true, data: readAudit(Number(limit) || 200) }));

  ipcMain.handle('audit:clear', () => {
    try { fs.writeFileSync(AUDIT_FILE, '', 'utf8'); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('backup:open-folder', async () => {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      await shell.openPath(BACKUP_DIR);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 拉取最新 Release 元数据（update:check 与启动时自动检查共用） */

  /** 应用内更新：下载安装包并重启安装 ---- */
  /**
   * ⚠️ 不再内置 ghfast.top / gh-proxy.com 这类公共免费代理：2026-11 实测
   * ghfast.top 走代理直接连不上、gh-proxy.com 只有 1.6 KB/s，直连也只有 50~173 KB/s，
   * 点「换镜像」只会更慢。改成「可选的自定义源」：用户/IT 可以在设置里填自己的
   * 国内直链前缀（updateMirrorUrl），或用 PM_UPDATE_MIRROR 环境变量指定；没配就只走 GitHub。
   */
  function updateMirrorBase() {
    try {
      const fromEnv = String(process.env.PM_UPDATE_MIRROR || '').trim();
      const s = loadSettings() || {};
      return (fromEnv || String(s.updateMirrorUrl || '').trim()).replace(/\/+$/, '');
    } catch { return ''; }
  }

  /**
   * 用 Chromium 网络栈下载（Electron net）：
   * Node 的 fetch(undici) 不读系统代理，遇到代理/证书拦截就只报一句 "fetch failed"；
   * net 走 Chromium，能跟随系统代理设置，也能拿到更具体的错误。
   */
  /**
   * 单连接下载（默认行为，和 1.21.3 一致）。
   * ⚠️ 默认不做任何慢速 / 无数据中止：1.21.4 曾用「60 秒无数据自动切 6 分片」，
   * 结果把公司环境里只是中途停顿的正常下载误杀，分片目录又触发杀软导致 ENOENT。
   * 只有调用方显式传 slowSwitchAfterMs / stallMs 时才抛 code=SLOW 供上层决定重试。
   */
  function netDownload(url, file, onProgress, opts = {}) {
    const slowMs = Number(opts.slowSwitchAfterMs) || 0;
    const slowBelow = Number(opts.slowBelow) || 150 * 1024;
    const slowMaxBytes = Number(opts.slowMaxBytes) || 4 * 1024 * 1024;
    // ⚠️ 默认关闭「无数据超时」：1.21.4 曾设 60 秒并自动切分片，结果把公司环境里
    // 只是中途停顿的正常下载误杀，分片目录触发杀软后又 ENOENT，完全下不了。
    // 现在只在调用方显式传 stallMs 时启用，且不再自动切分片。
    const stallMs = Number(opts.stallMs) || 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let stallTimer = null;
      let responseRef = null;
      let outRef = null;
      let lastByteAt = Date.now();
      let slowSince = 0;
      const fin = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (stallTimer) clearInterval(stallTimer);
        fn(arg);
      };
      const failSlow = (why) => {
        try { responseRef?.pause?.(); } catch { /* 忽略 */ }
        try { request.abort(); } catch { /* 忽略 */ }
        try { outRef?.destroy?.(); } catch { /* 忽略 */ }
        const e = new Error(why);
        e.code = 'SLOW';
        fin(reject, e);
      };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch (e) {
        reject(e);
        return;
      }
      timer = setTimeout(() => {
        try { request.abort(); } catch { /* 忽略 */ }
        fin(reject, new Error('下载超时（30 分钟无响应）'));
      }, 30 * 60 * 1000);
      if (stallMs > 0) {
        stallTimer = setInterval(() => {
          if (!settled && Date.now() - lastByteAt > stallMs) failSlow('长时间没有收到数据');
        }, 5000);
      }

      request.setHeader('User-Agent', 'password-manager-app');
      request.on('response', (response) => {
        responseRef = response;
        const status = response.statusCode;
        if (status >= 400) {
          try { response.resume(); } catch { /* 忽略 */ }
          fin(reject, new Error(`HTTP ${status}`));
          return;
        }
        const total = Number(response.headers['content-length'] || 0);
        const out = fs.createWriteStream(file);
        outRef = out;
        let received = 0;
        let lastEmit = 0;
        let windowBytes = 0;
        let windowAt = Date.now();
        let speed = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          windowBytes += chunk.length;
          lastByteAt = Date.now();
          if (!out.write(chunk)) {
            try {
              response.pause();
              out.once('drain', () => response.resume());
            } catch { /* 忽略 */ }
          }
          const now = Date.now();
          if (now - lastEmit >= 200) {
            const dt = (now - windowAt) / 1000;
            if (dt >= 0.5) { speed = windowBytes / dt; windowBytes = 0; windowAt = now; }
            lastEmit = now;
            if (slowMs && speed > 0 && speed < slowBelow && received < slowMaxBytes) {
              if (!slowSince) slowSince = now;
              else if (now - slowSince >= slowMs) { failSlow('单连接过慢'); return; }
            } else {
              slowSince = 0;
            }
            onProgress(received, total, speed);
          }
        });
        response.on('end', () => {
          out.end(() => fin(resolve, { size: received, total, speed, threads: 1 }));
        });
        response.on('error', (e) => {
          out.destroy();
          fin(reject, e);
        });
      });
      request.on('error', (e) => fin(reject, e));
      request.end();
    });
  }

  /**
   * 单段 Range 下载（并行下载的一个分片）。
   * 返回实际写入的字节数；中途断线由调用方决定是否重试。
   */
  function netDownloadRange(url, start, end, dest, onChunk) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fin = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* 忽略 */ }
        fin(reject, new Error(`分片 ${start}-${end} 超时`));
      }, 15 * 60 * 1000);

      request.setHeader('User-Agent', 'password-manager-app');
      request.setHeader('Range', `bytes=${start}-${end}`);
      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          clearTimeout(timer);
          try { response.resume(); } catch { /* 忽略 */ }
          fin(reject, new Error(`HTTP ${response.statusCode}`));
          return;
        }
        // 分片目录可能被杀软整个隔离/删除，写之前重建一次；写流错误也要接住，
        // 否则 fs.createWriteStream 的 ENOENT 会变成未处理异常把整次下载打挂。
        try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* 忽略 */ }
        const out = fs.createWriteStream(dest);
        out.on('error', (e) => {
          clearTimeout(timer);
          fin(reject, e);
        });
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          onChunk(chunk.length);
          if (!out.write(chunk)) {
            try {
              response.pause();
              out.once('drain', () => response.resume());
            } catch { /* 忽略 */ }
          }
        });
        response.on('end', () => {
          clearTimeout(timer);
          out.end(() => fin(resolve, received));
        });
        response.on('error', (e) => {
          clearTimeout(timer);
          out.destroy();
          fin(reject, e);
        });
      });
      request.on('error', (e) => { clearTimeout(timer); fin(reject, e); });
      request.end();
    });
  }

  /** 探测文件大小与是否支持 Range（用 0-0 的 GET，比 HEAD 靠谱） */
  function netProbe(url) {
    return new Promise((resolve) => {
      let settled = false;
      const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch {
        fin({ ok: false });
        return;
      }
      const timer = setTimeout(() => { try { request.abort(); } catch { /* 忽略 */ } fin({ ok: false }); }, 20000);
      request.setHeader('User-Agent', 'password-manager-app');
      request.setHeader('Range', 'bytes=0-0');
      request.on('response', (response) => {
        clearTimeout(timer);
        const cr = String(response.headers['content-range'] || '');
        const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
        const total = m ? Number(m[1]) : 0;
        try { response.resume(); } catch { /* 忽略 */ }
        fin({ ok: response.statusCode === 206 && total > 0, total });
      });
      request.on('error', () => { clearTimeout(timer); fin({ ok: false }); });
      request.end();
    });
  }

  /** 顺序拼片 */
  function concatFiles(parts, dest) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let i = 0;
      const next = () => {
        if (i >= parts.length) {
          out.end(() => resolve());
          return;
        }
        const rs = fs.createReadStream(parts[i++]);
        rs.on('error', (e) => { out.destroy(); reject(e); });
        rs.on('end', next);
        rs.pipe(out, { end: false });
      };
      out.on('error', reject);
      next();
    });
  }

  /**
   * 多线程分段下载：GitHub 的 CDN 单连接常被限速（几十 KB/s），
   * 而它支持 Range —— 拆成 N 段并发，速度大致线性提升。
   * 任何一段失败都会重试该段（最多 2 次），整体不支持 Range 时由调用方回退单连接。
   */
  async function netDownloadParallel(url, file, onProgress, threads = 6, partsDir = '') {
    const probe = await netProbe(url);
    if (!probe.ok || probe.total < 4 * 1024 * 1024) {
      return { fallback: true };
    }
    const total = probe.total;
    const n = Math.max(2, Math.min(8, threads));
    const chunk = Math.ceil(total / n);
    const parts = [];
    const ranges = [];
    // 分片放独立目录、用 .bin 后缀：不要叫 xxx.exe.part0 —— 那等于在告诉杀软「这是 exe 的一段」
    const dir = partsDir || path.dirname(file);
    // 目录可能不存在（或已被杀软删掉），先重建，避免 chunk-0.bin ENOENT
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      if (start >= total) break;
      const end = Math.min(total - 1, start + chunk - 1);
      const part = path.join(dir, `chunk-${i}.bin`);
      ranges.push({ start, end, part });
      parts.push(part);
    }

    let received = 0;
    let lastEmit = 0;
    let windowBytes = 0;
    let windowAt = Date.now();
    let speed = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 150) return;
      const dt = (now - windowAt) / 1000;
      if (dt >= 0.5) {
        speed = windowBytes / dt;
        windowBytes = 0;
        windowAt = now;
      }
      lastEmit = now;
      onProgress(received, total, speed);
    };

    const results = await Promise.all(ranges.map(async (r) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let written = 0;
        try {
          written = await netDownloadRange(url, r.start, r.end, r.part, (len) => {
            received += len;
            windowBytes += len;
            emit();
          });
        } catch (e) {
          lastErr = e;
          received -= written;
          windowBytes -= written;
          try { fs.unlinkSync(r.part); } catch { /* 忽略 */ }
          continue;
        }
        const expect = r.end - r.start + 1;
        if (written !== expect) {
          lastErr = new Error(`分片大小不符（${written}/${expect}）`);
          received -= written;
          windowBytes -= written;
          try { fs.unlinkSync(r.part); } catch { /* 忽略 */ }
          continue;
        }
        return true;
      }
      throw lastErr || new Error('分片下载失败');
    }));

    if (results.every(Boolean)) {
      await concatFiles(parts, file);
      parts.forEach(p => { try { fs.unlinkSync(p); } catch { /* 忽略 */ } });
      emit(true);
      return { size: total, total, threads: n, speed };
    }
    parts.forEach(p => { try { fs.unlinkSync(p); } catch { /* 忽略 */ } });
    return { fallback: true };
  }

  /**
   * 更新包落盘目录。
   * ⚠️ 不要用 %TEMP%：杀软对「非浏览器进程在临时目录里生成/改写 exe」的启发式很强，
   * 360/火绒会直接判 Trojan/Injector 并删文件（2026-10-29 实测）。
   * 放到应用自己的目录，并且用 GitHub 上的真实文件名，行为跟普通下载器一致。
   */
  function updateDir() {
    const dir = path.join(app.getPath('userData'), 'update');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    return dir;
  }

  /** 从下载地址取官方资产名（取不到就用兜底名），只保留安全字符 */
  function assetFileName(url, fallback) {
    let name = '';
    try {
      name = decodeURIComponent(path.basename(new URL(url).pathname));
    } catch { /* 非法地址，用兜底名 */ }
    name = String(name || '').replace(/[^\w.\-]+/g, '_');
    if (!/\.exe$/i.test(name)) name = fallback;
    return name;
  }

  /** 文件的 SHA-256（流式，96MB 也不吃内存） */
  function sha256File(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(file);
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    });
  }

  ipcMain.handle('update:download', async (event, { url, useMirror, expectedSha256, threads } = {}) => {
    if (!url) return { success: false, error: '没有可用的下载地址' };

    const dir = updateDir();
    const name = assetFileName(url, `PasswordManager-Setup-${app.getVersion()}-new.exe`);
    const finalFile = path.join(dir, name);
    // 先写到 .partial 再改名：避免"边写边被扫"时留下半成品，也让最终文件出现在磁盘上是完整的
    const partial = `${finalFile}.partial`;
    const partsDir = path.join(dir, `parts-${Date.now()}`);
    try { fs.mkdirSync(partsDir, { recursive: true }); } catch { /* 忽略 */ }
    const cleanup = () => {
      try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* 忽略 */ }
      try { fs.rmSync(partsDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    };

    // 先诊断链路：这个下载地址在 Chromium 里到底是走代理还是直连。
    // 家里「开了 VPN 还是很慢」多半就是这里显示「直连」——分流规则没命中 githubusercontent。
    let proxy = '';
    try { proxy = String(await session.defaultSession.resolveProxy(url) || '').trim(); } catch { /* 忽略 */ }
    const link = proxyLabel(proxy);
    const sendProgress = (received, total, speed, th) => {
      try { event.sender.send('update:progress', { received, total, speed, threads: th, proxy, link }); }
      catch { /* 窗口已关 */ }
    };
    sendProgress(0, 0, 0, 0);

    // 默认只走 GitHub；只有配置了自定义国内源（设置 updateMirrorUrl / PM_UPDATE_MIRROR）才多一个候选。
    // ghfast.top / gh-proxy.com 已移除：实测 0 B/s 与 1.6 KB/s，点了只会更慢。
    const mirror = updateMirrorBase();
    const targets = mirror
      ? [{ label: '自定义源', url: `${mirror}/${url}` }, { label: 'GitHub', url }]
      : [{ label: 'GitHub', url }];

    const errors = [];
    // useMirror 现在表示「加速重试」；threads 是设置页里的多线程开关。两者都直接启用 6 分片并行。
    const accelerate = useMirror === true || threads === true;

    for (const t of targets) {
      try {
        let r = null;
        if (accelerate) {
          // 只有用户显式点「加速重试」/ 勾多线程才并行；失败必须能回退单连接
          try {
            const p = await netDownloadParallel(t.url, partial, (received, total, speed) => sendProgress(received, total, speed, 6), 6, partsDir);
            if (!p.fallback) r = { size: p.total, threads: p.threads };
          } catch (e) {
            errors.push(`${t.label}：多线程失败（${e.message || '连接被中断'}），改用单连接`);
          }
        }
        if (!r) {
          try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* 忽略 */ }
          // 默认纯单连接（回到 1.21.3 的行为）：1.21.4 的「60 秒无数据自动切 6 分片」
          // 会把公司环境里只是中途停顿的正常下载误杀，分片目录又容易触发杀软导致 ENOENT。
          // 慢速时由用户在界面上点「太慢？多线程加速」自行决定，不自动切。
          r = await netDownload(t.url, partial, (received, total, speed) => sendProgress(received, total, speed, 1));
        }

        if (!r || r.size < 1024 * 1024) {
          cleanup();
          errors.push(`${t.label}：文件过小（${Math.round((r ? r.size : 0) / 1024)} KB）`);
          continue;
        }

        try { if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile); } catch { /* 忽略 */ }
        fs.renameSync(partial, finalFile);

        // 官方 SHA-256 校验：镜像站/代理有可能改包，校验不过就不用
        const sha256 = await sha256File(finalFile);
        let verified = false;
        if (expectedSha256) {
          const want = String(expectedSha256).replace(/^sha256:/i, '').trim().toLowerCase();
          if (sha256 !== want) {
            try { fs.unlinkSync(finalFile); } catch { /* 忽略 */ }
            cleanup();
            errors.push(`${t.label}：SHA-256 校验不通过（下载 ${sha256.slice(0, 12)}…，预期 ${want.slice(0, 12)}…）`);
            continue;
          }
          verified = true;
        }

        cleanup();
        return {
          success: true,
          data: { file: finalFile, name, size: r.size, via: t.label, threads: r.threads || 1, sha256, verified },
        };
      } catch (e) {
        errors.push(`${t.label}：${e.message || '连接被中断'}`);
        cleanup();
      }
    }

    cleanup();
    return {
      success: false,
      error: [
        '下载失败。',
        '可以：①点「浏览器下载」到发布页手动下；②已经下好了就点「选择安装包」；' + (accelerate ? '③换个网络再试。' : '③点「加速重试」（多线程并行）。'),
        `当前链路：${link}。若显示「直连」，请检查 VPN 分流规则是否放行 github.com 与 *.githubusercontent.com。`,
        '如果杀软弹了拦截（Trojan/Injector 之类），那是把「下载安装包」误判成释放器：添加信任或手动下载即可。',
        `（${errors.join('；')}）`,
      ].join(' '),
      canMirror: !accelerate,
      detail: errors.join('；'),
    };
  });

  /** 手动选已下载的安装包：网络实在下不动时的兜底 */
  ipcMain.handle('update:pick-file', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择下载好的安装包',
        properties: ['openFile'],
        filters: [{ name: '安装包', extensions: ['exe'] }],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      const f = r.filePaths[0];
      const st = fs.statSync(f);
      if (st.size < 10 * 1024 * 1024) {
        return { success: false, error: '这个文件不像是安装包（体积过小）' };
      }
      return { success: true, data: { file: f, size: st.size } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update:install', async (_event, { file, silent } = {}) => {
    try {
      if (!file || !fs.existsSync(file)) return { success: false, error: '安装包不存在，请重新下载' };
      // 自动化脚本用：只校验流程，不真的拉起安装程序、也不退出（否则截图跑一半应用就没了）
      if (process.env.PM_UPDATE_NO_INSTALL === '1') {
        return { success: true, data: { silent: false, skipped: true } };
      }
      // 默认走安装向导：能看清进度、能选目录。
      // ⚠️ 不要默认 /S 静默安装 —— 它会装到默认目录，跟用户自定义的安装路径变成两份。
      const args = silent ? ['/S', `/D=${path.dirname(app.getPath('exe'))}`] : [];
      spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 1200);
      return { success: true, data: { silent: !!silent } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 选任意文件（接口调试上传附件用） */
  ipcMain.handle('file:pick', async (_event, { title, filters } = {}) => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: title || '选择文件',
        properties: ['openFile'],
        filters: filters || undefined,
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      return { success: true, data: { file: r.filePaths[0], name: path.basename(r.filePaths[0]) } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 保存文本文件（导出 CSV 等）：带 UTF-8 BOM，Excel 打开不乱码 */
  ipcMain.handle('file:save-text', async (_event, { content, defaultName, filters } = {}) => {
    try {
      const r = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName || 'export.csv',
        filters: filters || [{ name: 'CSV 文件', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };
      fs.writeFileSync(r.filePath, '\uFEFF' + String(content ?? ''), 'utf8');
      return { success: true, data: { file: r.filePath } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- Generic storage for the extra modules (snippets/notes/checklists/…) ----
  ipcMain.handle('ws:get', (_event, key) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    if (!VAULT_COLLECTIONS.includes(key)) return { success: false, error: '无效的数据类型' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault[key] };
  });

  ipcMain.handle('ws:set', (_event, { key, value }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    if (!VAULT_COLLECTIONS.includes(key)) return { success: false, error: '无效的数据类型' };
    if (!Array.isArray(value)) return { success: false, error: '数据格式错误' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    vault[key] = value;
    saveVault(vault, currentPassword);
    return { success: true, data: value };
  });

  // ---- Password history ----
  ipcMain.handle('history:get', (_event, entryId) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault.history[entryId] || [] };
  });

  // ---- Attachments (encrypted with the session key) ----
  ipcMain.handle('attachment:pick', async () => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    try {
      const filePath = result.filePaths[0];
      const st = fs.statSync(filePath);
      if (st.size > 20 * 1024 * 1024) return { success: false, error: '附件不能超过 20MB' };
      const buf = fs.readFileSync(filePath);
      const id = crypto.randomUUID();
      fs.mkdirSync(ATTACH_DIR, { recursive: true });
      fs.writeFileSync(attachmentFile(id), encrypt(buf.toString('base64'), currentPassword), 'utf8');
      return {
        success: true,
        data: { id, name: path.basename(filePath), size: st.size, addedAt: new Date().toISOString() },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('attachment:open', async (_event, { id, name }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    try {
      const b64 = readAttachment(id, currentPassword);
      if (!b64) return { success: false, error: '附件不存在或已损坏' };
      const dir = path.join(app.getPath('temp'), 'pm-attachments');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name || `${id}.bin`);
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
      await shell.openPath(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('attachment:delete', async (_event, { id }) => {
    try {
      const file = attachmentFile(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- HTTP client for the API debugger ----
  ipcMain.handle('api:send', async (_event, {
    method = 'GET', url, headers = '', body = '', bodyType = 'json', rawContentType = '', autoSession = true,
  }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { success: false, error: 'URL 必须以 http:// 或 https:// 开头' };
    }
    const started = Date.now();
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* 上面已校验过 */ }
    try {
      const hdrs = {};
      String(headers || '').split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) hdrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      // 会话保持：把 Cookie 罐里该站点的 cookie 合并进请求头。
      // 用户手写的 Cookie 优先级更高（同名不覆盖），并且手写时整体不注入，避免意外改动请求。
      if (autoSession) {
        const jar = apiJarHeader(origin);
        const ckKey = Object.keys(hdrs).find(k => k.toLowerCase() === 'cookie');
        if (!ckKey && jar) hdrs['Cookie'] = jar;
      }
      // 用户自己写了 Content-Type 就不覆盖
      const hasCT = () => Object.keys(hdrs).some(k => k.toLowerCase() === 'content-type');
      const setCT = (v) => { if (!hasCT()) hdrs['Content-Type'] = v; };

      const init = { method: method.toUpperCase(), headers: hdrs };
      const canHaveBody = !['GET', 'HEAD'].includes(init.method);
      if (canHaveBody && bodyType !== 'none' && body) {
        if (bodyType === 'form') {
          // key=value 每行一个 → x-www-form-urlencoded
          const params = new URLSearchParams();
          String(body).split('\n').forEach(line => {
            const i = line.indexOf('=');
            if (i > 0) params.append(line.slice(0, i).trim(), line.slice(i + 1));
          });
          init.body = params.toString();
          setCT('application/x-www-form-urlencoded; charset=UTF-8');
        } else if (bodyType === 'multipart') {
          // key=value 每行一个；value 以 @ 开头视为文件路径（支持 curl 的 ;type= / ;filename= 语法）
          const fd = new FormData();
          const lines = String(body).split('\n').filter(l => l.trim());
          for (const line of lines) {
            const p = parseMultipartLine(line);
            if (!p.ok) continue;
            if (p.isFile) {
              if (!p.filePath || !fs.existsSync(p.filePath)) {
                // cURL 导入的文件字段只有文件名、没有内容，必须让用户重新选一次
                return {
                  success: false,
                  error: `上传文件不存在：${p.filePath || '(空)'}。如果是从 cURL 导入的文件字段，请点「选择文件」重新指定本地文件。`,
                };
              }
              // 带上 MIME：不少服务端会校验 part 的 Content-Type，缺省 octet-stream 会被拒
              const mime = p.mime || 'application/octet-stream';
              const name = p.filename || path.basename(p.filePath);
              fd.append(p.key, new Blob([fs.readFileSync(p.filePath)], { type: mime }), name);
            } else {
              fd.append(p.key, p.value);
            }
          }
          // 不要手动设 Content-Type：fetch 会按 FormData 自动带 boundary。
          // 用户如果自己写了 Content-Type（常见从别处粘过来的 multipart/form-data 无 boundary），
          // 会让请求体解析失败，这里直接去掉，交给 fetch 生成。
          Object.keys(hdrs).forEach(k => { if (k.toLowerCase() === 'content-type') delete hdrs[k]; });
          init.body = fd;
        } else if (bodyType === 'raw') {
          init.body = body;
          setCT(rawContentType || 'text/plain; charset=UTF-8');
        } else {
          init.body = body;
          setCT('application/json; charset=UTF-8');
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      init.signal = controller.signal;

      const res = await fetch(url, init);
      clearTimeout(timer);
      const text = await res.text();
      const resHeaders = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      // undici 的 getSetCookie() 才能拿到「一条一条」的 Set-Cookie；
      // forEach 会把多个 Set-Cookie 用逗号拼成一条，Expires 里的逗号会让解析全乱。
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (resHeaders['set-cookie'] ? [resHeaders['set-cookie']] : []);
      if (autoSession && setCookies.length && origin) apiJarAbsorb(origin, setCookies);
      return {
        success: true,
        data: {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
          setCookies,
          body: text.length > 500000 ? text.slice(0, 500000) + '\n...（响应过大，已截断）' : text,
          size: Buffer.byteLength(text),
          timeMs: Date.now() - started,
        },
      };
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '请求超时（30 秒）' : e.message };
    }
  });

  // ---- 会话 Cookie 罐（接口调试用） ----
  ipcMain.handle('api:cookies', (_event, { origin } = {}) => ({ success: true, data: apiJarList(origin) }));

  ipcMain.handle('api:cookies-clear', (_event, { origin } = {}) => {
    if (origin) apiJar.delete(origin);
    else apiJar.clear();
    return { success: true, data: apiJarList() };
  });

  // ---- Zentao (禅道) ----
  // 禅道 18+ / 20.x 的登录流程（与浏览器一致）：
  //   1. GET  user-login.html          建立会话，取表单里的 referer
  //   2. GET  user-refreshRandom.html  返回【纯文本】随机盐（不是 JSON）
  //   3. POST user-login.html          password = md5(md5(明文) + rand)，并必须带上 verifyRand
  // 注意：index.php?m=user&f=login 这种老式地址在本实例会 302 到 PATH_INFO 地址，
  // 直接请求会拿到空 body —— 这是之前误报「登录失败（HTTP 302）」的原因。
  // 禅道 20.6 的「我的地盘」里 my-bug 无权限，但 my-work-bug 可访问，优先用它。
  let ztCookies = new Map();
  let ztLoggedInBase = '';

  const ztCookieHeader = () => [...ztCookies].map(([k, v]) => `${k}=${v}`).join('; ');

  /** 允许用户只填 host:port/zentao，自动补协议、去掉尾部斜杠 */
  function ztNormalizeCfg(cfg) {
    let base = String(cfg.baseUrl || '').trim();
    if (base && !/^https?:\/\//i.test(base)) base = `http://${base}`;
    return { ...cfg, baseUrl: base.replace(/\/+$/, '') };
  }

  function ztAbsorbCookies(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const kv = String(c).split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) ztCookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  /** 请求禅道；GET 自动跟随 302，POST 不跟随（重定向即代表失败） */
  async function ztFetch(cfg, pathOrUrl, options = {}) {
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${base}/${String(pathOrUrl).replace(/^\/+/, '')}`;
    const isPost = String(options.method || 'GET').toUpperCase() !== 'GET';
    for (let hop = 0; hop < 6; hop++) {
      const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json,*/*', ...(options.headers || {}) };
      const cookie = ztCookieHeader();
      if (cookie) headers.Cookie = cookie;
      let res;
      try {
        res = await fetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      } catch (e) {
        const reason = e.name === 'TimeoutError' ? '请求超时（20 秒）'
          : e.name === 'AbortError' ? '请求超时'
            : '无法连接禅道（网络不通或地址填错了）';
        throw new Error(`${reason}${/^https?:\/\//i.test(base) ? '' : '：地址需以 http:// 或 https:// 开头'}`);
      }
      ztAbsorbCookies(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        if (isPost) return { status: res.status, loc, text: '', url };
        url = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString();
        continue;
      }
      const text = await res.text();
      return { status: res.status, loc: null, text, url };
    }
    return { status: 0, loc: null, text: '', url };
  }

  /** 抓二进制（Bug 重现步骤里的截图）：带登录 cookie，跟随跳转 */
  async function ztFetchBinary(cfg, pathOrUrl, maxBytes = 8 * 1024 * 1024) {
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${base}/${String(pathOrUrl).replace(/^\/+/, '')}`;
    for (let hop = 0; hop < 6; hop++) {
      const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' };
      const cookie = ztCookieHeader();
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      ztAbsorbCookies(res);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString();
        continue;
      }
      if (!res.ok) return { status: res.status, buffer: null, contentType: '' };
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) return { status: 200, buffer: null, contentType: '', tooLarge: true };
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buffer, contentType: String(res.headers.get('content-type') || '') };
    }
    return { status: 0, buffer: null, contentType: '' };
  }

  /**
   * 把重现步骤里的图片取回来转成 dataURL：
   * 渲染层直接 <img src=".../file-read-x.png"> 带不上禅道登录 cookie，只会显示裂图。
   */
  async function ztLoadDetailImages(cfg, images) {
    const list = Array.isArray(images) ? images.slice(0, 12) : [];
    const out = [];
    let failed = 0;
    await Promise.all(list.map(async (img) => {
      try {
        const r = await ztFetchBinary(cfg, img.src, 8 * 1024 * 1024);
        if (!r.buffer || r.buffer.length < 64) { failed++; return; }
        const ct = /^image\//i.test(r.contentType) ? r.contentType : 'image/png';
        out.push({ src: img.src, name: String(img.src.split('/').pop() || ''), dataUrl: `data:${ct};base64,${r.buffer.toString('base64')}` });
      } catch {
        failed++;
      }
    }));
    // 保持与正文 [图N] 一致的顺序
    const order = new Map(list.map((x, i) => [x.src, i]));
    out.sort((a, b) => (order.get(a.src) ?? 99) - (order.get(b.src) ?? 99));
    return { images: out, failed, total: list.length };
  }

  function ztParseJson(text) {
    if (!text) return null;
    const t = String(text).trim();
    if (!t) return null;
    if (t.startsWith('{')) {
      try { return JSON.parse(t); } catch { /* 继续抠 */ }
    }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* ignore */ }
    }
    return null;
  }

  /** 富文本 HTML → 纯文本（保留换行，图片留占位） */
  function ztHtmlToText(html, imgTag) {
    let t = String(html || '');
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
    t = t.replace(/<li[^>]*>/gi, '· ');
    t = t.replace(/<img[^>]*>/gi, (tag) => (typeof imgTag === 'function' ? imgTag(tag) : '[图片]'));
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  const ZT_ACTION_LABEL = {
    opened: '创建', edited: '编辑', assigned: '指派', resolved: '解决',
    closed: '关闭', activated: '激活', commented: '备注', confirmed: '确认',
    deleted: '删除', undeleted: '还原', moved: '移动', duplicated: '重复',
    postponed: '延期', restored: '还原',
  };

  /** 从 zui-create-historyPanel 属性里取流转记录（禅道把 JSON 塞在属性里） */
  function ztParseBugHistory(html) {
    const m = html.match(/zui-create-historyPanel="([^"]*)"/);
    if (!m) return [];
    let json;
    try {
      const raw = m[1]
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      json = JSON.parse(raw);
    } catch {
      return [];
    }
    const actions = Array.isArray(json.actions) ? json.actions : [];
    return actions.map(a => {
      const text = ztHtmlToText(a.content || '').replace(/\s+/g, ' ').trim();
      // 内容形如「2026-10-27 17:36:32, 由 张三 创建。」，把时间与「由 X」拆出来做结构化展示
      const tm = text.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)[,，]?\s*(.*)$/);
      const who = (text.match(/由\s*([^\s，,。]{1,20})/) || [])[1] || '';
      return {
        action: String(a.action || ''),
        label: ZT_ACTION_LABEL[String(a.action || '')] || String(a.action || '变更'),
        time: tm ? tm[1] : '',
        who,
        text: tm ? tm[2] : text,
      };
    });
  }

  /** 解析 bug-view 页面：标题、产品、重现步骤、附件；列表里没有的字段在这里补 */
  function ztParseBugDetail(html, bugId, base) {
    const titleTag = ztStripTags((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    let title = titleTag;
    let productName = '';
    const m = titleTag.match(/^BUG\s*#\d+\s*([\s\S]*?)\s+-\s+(.+?)\s+-\s+禅道$/);
    if (m) { title = m[1].trim(); productName = m[2].trim(); }

    // 「重现步骤」区块：从标题到下一个 section 之间
    let steps = '';
    // 正文里内嵌的图片（禅道存在 file-read-*.png，需要带登录态才能取）
    const images = [];
    const abs = (raw) => {
      if (!raw) return '';
      if (/^data:/i.test(raw)) return '';
      try {
        return new URL(raw, `${String(base || '').replace(/\/+$/, '')}/`).toString();
      } catch {
        return '';
      }
    };
    const idx = html.indexOf('zui-key="重现步骤"');
    if (idx > 0) {
      const cls = html.indexOf('detail-section-content', idx);
      if (cls > 0) {
        // 从该标签的 > 之后开始，别把 class 属性当正文
        const gt = html.indexOf('>', cls);
        const from = gt > 0 ? gt + 1 : cls;
        const nextSec = html.indexOf('zui-key="historyWrapper"', from);
        const to = nextSec > from ? html.lastIndexOf('<', nextSec) : Math.min(html.length, from + 30000);
        const chunk = html.slice(from, to > from ? to : from + 30000);

        // 先按出现顺序收集图片（同一张只留一次），正文里用 [图N] 对应
        const imgRe = /<img[^>]*>/gi;
        let im;
        while ((im = imgRe.exec(chunk)) !== null) {
          const sm = im[0].match(/src=["']([^"']+)["']/i);
          const src = abs(sm && sm[1]);
          if (src && !images.some(x => x.src === src)) images.push({ src });
        }
        const numOf = (src) => {
          const i = images.findIndex(x => x.src === src);
          return i >= 0 ? i + 1 : 0;
        };
        steps = ztHtmlToText(chunk, (tag) => {
          const sm = tag.match(/src=["']([^"']+)["']/i);
          const n = numOf(abs(sm && sm[1]));
          return n ? `[图${n}]` : '[图片]';
        });
      }
    }

    // 附件（保存 href，渲染层才能点开下载；只留名字时没法取文件）
    const attachments = [];
    const re = /href="([^"]*file-(?:download|read)[^"]*)"[^>]*>([^<]{1,120})</g;
    let fm;
    while ((fm = re.exec(html)) !== null) {
      const name = ztStripTags(fm[2]);
      const url = abs(fm[1]);
      if (name && url && !attachments.some(a => a.url === url)) attachments.push({ name, url });
    }

    return {
      id: String(bugId),
      title: title || `BUG #${bugId}`,
      productName,
      steps: steps || '（该 Bug 没有填写重现步骤）',
      attachments,
      images,
      history: ztParseBugHistory(html),
      url: `${String(base || '').replace(/\/+$/, '')}/bug-view-${bugId}.html`,
    };
  }

  function ztMapBug(b) {
    return {
      id: String(b.id || ''),
      title: ztStripTags(b.title || b.name || ''),
      status: String(b.status || ''),
      severity: String(b.severity || ''),
      pri: String(b.pri || ''),
      type: String(b.type || ''),
      product: String(b.product || ''),
      productName: ztStripTags(b.productName || ''),
      assignedTo: String(b.assignedTo || ''),
      openedBy: String(b.openedBy || ''),
      date: String(b.openedDate || '').slice(0, 10),
      deadline: /^0{4}-0{2}-0{2}/.test(String(b.deadline || '')) ? '' : String(b.deadline || ''),
      resolution: String(b.resolution || ''),
      resolvedDate: /^0{4}-0{2}-0{2}/.test(String(b.resolvedDate || '')) ? '' : String(b.resolvedDate || '').slice(0, 10),
      closedDate: /^0{4}-0{2}-0{2}/.test(String(b.closedDate || '')) ? '' : String(b.closedDate || '').slice(0, 10),
    };
  }

  /** 执行一次登录；style: 'path' = 20.x 的 user-login.html，'query' = 老版本 index.php?m= */
  async function ztLoginAttempt(cfg, style) {
    ztCookies = new Map();
    const urls = style === 'path'
      ? { login: 'user-login.html', rand: 'user-refreshRandom.html' }
      : { login: 'index.php?m=user&f=login', rand: 'index.php?m=user&f=refreshRandom' };

    const page = await ztFetch(cfg, urls.login);
    if (!page.text) return { ok: false, error: `无法打开登录页（HTTP ${page.status}）` };
    if (page.status !== 200) return { ok: false, error: `登录页返回 HTTP ${page.status}` };

    const referer = (page.text.match(/name="referer"\s+value="([^"]*)"/) || [])[1] || '/';

    // 随机盐：20.x 返回纯文本；个别版本返回 JSON
    const rr = await ztFetch(cfg, urls.rand);
    let rand = String(rr.text || '').trim();
    if (!/^\d+$/.test(rand)) {
      const j = ztParseJson(rand);
      rand = j ? String(j.rand || j.data || '') : '';
    }
    if (!rand) return { ok: false, error: '没能从禅道取到登录随机盐（user-refreshRandom），请确认地址指向禅道根目录' };

    const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
    const ztBase = String(cfg.baseUrl).replace(/\/+$/, '');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: style === 'path' ? `${ztBase}/user-login.html` : `${ztBase}/${urls.login}`,
    };

    const rc = await ztFetch(cfg, urls.login, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        account: cfg.account,
        password: md5(md5(cfg.password) + rand),
        passwordStrength: '1',
        referer,
        verifyRand: rand,
        keepLogin: '1',
        captcha: '',
      }).toString(),
    });

    const json = ztParseJson(rc.text);
    if (json) {
      const ok = json.result === 'success' || json.status === 'success' || (!json.result && !json.status && json.locate);
      if (ok) return { ok: true };
      const msg = String(json.message || json.reason || '').trim();
      return { ok: false, error: msg || '账号或密码不正确' };
    }
    if (rc.status >= 300 && rc.status < 400) {
      // POST 被重定向 = 登录没通过
      return { ok: false, error: `登录未通过（HTTP ${rc.status} → ${rc.loc}）` };
    }
    if (/退出|logout|我的地盘|my-work/i.test(rc.text)) return { ok: true };
    return { ok: false, error: `登录失败（HTTP ${rc.status}），未返回预期的响应` };
  }

  async function ztEnsureLogin(cfg) {
    if (ztCookies.size > 0 && ztLoggedInBase === String(cfg.baseUrl || '').replace(/\/+$/, '')) {
      return { ok: true };
    }
    let last = { ok: false, error: '登录失败' };
    for (const style of ['path', 'query']) {
      try {
        const r = await ztLoginAttempt(cfg, style);
        if (r.ok) {
          ztLoggedInBase = String(cfg.baseUrl || '').replace(/\/+$/, '');
          return { ok: true };
        }
        last = r;
        // 账号密码错误就没必要再试另一种地址风格
        if (/密码|用户名|账号/.test(r.error || '')) break;
      } catch (e) {
        last = { ok: false, error: e.message };
      }
    }
    return last;
  }

  ipcMain.handle('zentao:login', async (_event, cfg) => {
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    cfg = ztNormalizeCfg(cfg);
    try {
      // 手动点「登录」时强制走一次完整校验，避免复用已建立的会话导致错误密码也显示成功
      ztCookies = new Map();
      ztLoggedInBase = '';
      const r = await ztEnsureLogin(cfg);
      if (!r.ok) return { success: false, error: r.error };
      // 用「我的地盘」探一次会话，顺便验证权限
      const probe = await ztFetch(cfg, 'my-work.html');
      if (probe.status >= 300 && probe.status < 400 && /user-login/i.test(probe.loc || '')) {
        ztCookies = new Map();
        return { success: false, error: '登录成功但会话未建立，请重试' };
      }
      return { success: true, data: { cookie: true } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 拉「我的 Bug」：页面抓取（定时提醒也复用这个） */
  async function ztLoadMyBugs(cfg) {
    if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
    cfg = ztNormalizeCfg(cfg);
    try {
      const login = await ztEnsureLogin(cfg);
      if (!login.ok) return { success: false, error: login.error };

      let rows = [];
      let total = 0;

      // 1) 我的地盘 → 我的 Bug（禅道 20.x 可用，my-bug 可能无权限）
      const first = await ztFetch(cfg, 'my-work-bug.html');
      if (first.status === 200) {
        rows = ztTableRows(first.text);
        const tpl = first.text.match(/my-work-bug-assignedTo-0-id_desc-(\d+)-\{recPerPage\}-\{page\}\.html/);
        if (tpl) total = Number(tpl[1]) || rows.length;
        // 一次拉满：复用页面里的分页链接模板，每页 100 条
        if (total > rows.length) {
          const perPage = 100;
          const pages = Math.min(5, Math.ceil(total / perPage));
          const collected = [];
          for (let p = 1; p <= pages; p++) {
            const r = await ztFetch(cfg, `my-work-bug-assignedTo-0-id_desc-${total}-${perPage}-${p}.html`);
            const pageRows = ztTableRows(r.text);
            if (pageRows.length === 0) break;
            collected.push(...pageRows);
            if (pageRows.length < perPage) break;
          }
          if (collected.length > rows.length) rows = collected;
        }
      }

      // 2) 老版本：my-bug.html
      if (rows.length === 0) {
        const legacy = await ztFetch(cfg, 'my-bug.html');
        if (legacy.status === 200) rows = ztTableRows(legacy.text);
      }

      // 3) 再退一步：解析 HTML 表格里的 data-id 行
      if (rows.length === 0) {
        const html = await ztFetch(cfg, 'my-work-bug.html');
        const trs = (html.text.match(/<tr[^>]*data-id="\d+"[\s\S]*?<\/tr>/g) || []);
        for (const tr of trs) {
          const id = (tr.match(/data-id="(\d+)"/) || [])[1];
          const title = ztStripTags((tr.match(/class="[^"]*text-left[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
          if (id) rows.push({ id, title });
        }
      }

      if (rows.length === 0) {
        const probe = await ztFetch(cfg, 'my-work-bug.html');
        if (probe.status >= 300 && probe.status < 400) {
          return {
            success: false,
            error: `没有访问「我的地盘」的权限（HTTP ${probe.status} → ${probe.loc}）。请用上方快捷入口在浏览器中查看。`,
          };
        }
        return { success: false, error: '未取到 Bug 数据，可能是该禅道版本页面结构不同，可先用快捷入口查看' };
      }

      const list = rows.map(ztMapBug).filter(b => b.id);
      return { success: true, data: list.slice(0, 500), total: total || list.length };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 「我提交的 / 待我验证」走 REST（api.php/v1）。
   *
   * ⚠️ 禅道 20.x 的 `GET /bugs` 强制要求 `product`，不带就返回
   * `{"result":"fail","message":"Need product id."}`（用户实测报过）。
   * 所以先取项目列表，再按项目逐个查、按 id 去重合并；
   * 并发 4 个 worker，既压住耗时，也不至于把禅道打满。
   */
  async function ztLoadMyBugsScoped(cfg, scope, productIds) {
    cfg = ztNormalizeCfg(cfg);
    if (!cfg.account || !cfg.password) return { success: false, error: '请先填写账号和密码' };
    try {
      const products = await ztApiProducts(cfg).catch(() => []);
      if (!products.length) {
        return { success: false, error: '没有取到项目列表（禅道 REST 要求按项目查询），请先点一次「登录并保存」再试' };
      }
      const nameMap = {};
      for (const p of products) nameMap[String(p.id)] = p.name;

      const filter = () => {
        const params = new URLSearchParams();
        params.set('limit', '1000');
        params.set('page', '1');
        // 服务端对 openedBy / assignedTo / status 都可能静默忽略，所以这里只当「缩小范围」用，
        // 真正的过滤在 filterMineBugs 里按账号 + 状态做（status 统一取 all，避免漏数据）。
        params.set('status', 'all');
        if (scope === 'opened') params.set('openedBy', cfg.account);
        else params.set('assignedTo', cfg.account);
        return params;
      };

      // 只查用户选中的项目：31 个项目全量遍历要好几秒，而且大多数项目跟当前测试无关。
      const wanted = Array.isArray(productIds) ? productIds.map(String).filter(Boolean) : [];
      const queue = wanted.length ? products.filter(p => wanted.includes(String(p.id))) : products.slice();
      if (!queue.length) {
        return { success: false, error: `所选项目不在项目列表里（选了 ${wanted.join(", ")}），请重新载入项目后再试` };
      }
      const queueSize = queue.length;
      const seen = new Set();
      const all = [];
      let okCount = 0;
      let lastError = '';

      const worker = async () => {
        for (;;) {
          const p = queue.shift();
          if (!p) return;
          const params = filter();
          params.set('product', String(p.id));
          let json = null;
          try {
            json = await ztApiGet(cfg, `api.php/v1/bugs?${params.toString()}`);
            okCount++;
          } catch (e) {
            lastError = e.message || String(e);
            continue;
          }
          for (const b of (Array.isArray(json && json.bugs) ? json.bugs : [])) {
            // ⚠️ 这里必须留原始行：ztMapApiBug 之后 openedBy/assignedTo 变成了**显示名**，
            // 拿去跟账号比较会把所有人的数据都滤掉（1.7.4 就是这么错的）。
            const rawId = String((b && b.id) || '');
            if (!rawId || seen.has(rawId)) continue;
            seen.add(rawId);
            all.push(b);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(4, queueSize) }, () => worker()));

      if (!okCount) {
        return { success: false, error: `按项目查询失败：${lastError || '全部请求都未成功'}` };
      }
      // 服务端对 openedBy / assignedTo 可能直接忽略（实测会返回整个项目的 Bug），
      // 所以这里再按账号本地过滤一次；若返回里没有账号字段则不过滤，避免误杀成 0 条。
      const mine = filterMineBugs(all, cfg.account, scope);
      const rows = mine.rows.map(b => ztMapApiBug(b, nameMap)).filter(b => b.id);
      return {
        success: true,
        data: rows,
        total: rows.length,
        scope,
        account: cfg.account,
        filteredByAccount: mine.filtered,
        dropped: mine.dropped,
        // 诊断用：服务端到底返回了几条、其中几条带账号字段
        scanned: all.length,
        withAccount: mine.withAccount,
        products: products.length,
        queried: wanted.length ? wanted : products.map(p => String(p.id)),
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  ipcMain.handle('zentao:my-bugs', async (_event, cfg, scope = 'assigned', productIds) => {
    if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
    // 三个视图统一走 REST + 本地按账号过滤：旧的 HTML 抓取分支拿不到账号字段，
    // 界面会一直显示「未按账号复核」，而且和另外两个视图的口径不一致。
    return ztLoadMyBugsScoped(cfg, scope, productIds);
  });

  ipcMain.handle('zentao:bug-detail', async (_event, { cfg, bugId } = {}) => {
    if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
    if (!bugId) return { success: false, error: '缺少 Bug ID' };
    cfg = ztNormalizeCfg(cfg);
    try {
      const login = await ztEnsureLogin(cfg);
      if (!login.ok) return { success: false, error: login.error };
      const res = await ztFetch(cfg, `bug-view-${bugId}.html`);
      if (res.status >= 300 && res.status < 400) {
        return { success: false, error: `打开 Bug #${bugId} 失败（HTTP ${res.status}），可能没有查看权限` };
      }
      if (!res.text || res.text.length < 500) {
        return { success: false, error: `Bug #${bugId} 页面内容异常` };
      }
      const detail = ztParseBugDetail(res.text, bugId, cfg.baseUrl);
      if (detail.images && detail.images.length > 0) {
        const loaded = await ztLoadDetailImages(cfg, detail.images);
        detail.images = loaded.images;
        detail.imageTotal = loaded.total;
        detail.imageFailed = loaded.failed;
      } else {
        detail.images = [];
        detail.imageTotal = 0;
        detail.imageFailed = 0;
      }
      return { success: true, data: detail };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 下载 Bug 附件：禅道的 file-download 与 file-read 链接必须带登录 Cookie，
   * 渲染层的 <a href> 点了只会 302 到登录页，所以由主进程带 Cookie 取二进制。
   * mode=open → 存临时文件并直接打开；mode=save → 让用户选保存路径。
   */
  ipcMain.handle('zentao:attachment', async (_event, { cfg, url, name, mode = 'open' } = {}) => {
    if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
    if (!url) return { success: false, error: '缺少附件地址' };
    cfg = ztNormalizeCfg(cfg);
    try {
      const login = await ztEnsureLogin(cfg);
      if (!login.ok) return { success: false, error: login.error };
      const res = await ztFetchBinary(cfg, url, 100 * 1024 * 1024);
      if (!res.buffer) {
        return { success: false, error: res.tooLarge ? '附件超过 100MB，请到浏览器里下载' : `附件取回失败（HTTP ${res.status}）` };
      }
      const safeName = String(name || path.basename(String(url).split('?')[0]) || 'attachment')
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 120);
      let target = '';
      if (mode === 'save') {
        const r = await dialog.showSaveDialog(mainWindow, { title: '保存附件', defaultPath: safeName });
        if (r.canceled || !r.filePath) return { success: false, canceled: true };
        target = r.filePath;
      } else {
        const dir = path.join(app.getPath('temp'), 'pm-zt-attach');
        fs.mkdirSync(dir, { recursive: true });
        target = path.join(dir, safeName);
        // 同名文件加序号，别互相覆盖
        if (fs.existsSync(target)) {
          const dot = safeName.lastIndexOf('.');
          const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
          const ext = dot > 0 ? safeName.slice(dot) : '';
          let i = 2;
          while (fs.existsSync(target)) target = path.join(dir, `${stem}-${i++}${ext}`);
        }
      }
      fs.writeFileSync(target, res.buffer);
      if (mode === 'save') {
        shell.showItemInFolder(target);
      } else {
        const err = await shell.openPath(target);
        if (err) return { success: false, error: `文件已保存到 ${target}，但打开失败：${err}`, data: { path: target } };
      }
      return { success: true, data: { path: target, size: res.buffer.length, name: safeName } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- 新 Bug 提醒（后台定时检查「我的 Bug」） ----
  let ztNotifyTimer = null;
  let ztNotifyBusy = false;
  let ztSeenIds = null;
  /** 未读数（侧边栏红点）：新 Bug 累加，打开禅道页清零 */
  let ztUnread = 0;

  const ztNotifyStateFile = () => path.join(DATA_DIR, 'zentao-notify-state.json');

  function ztLoadSeen() {
    if (ztSeenIds) return ztSeenIds;
    try {
      const j = JSON.parse(fs.readFileSync(ztNotifyStateFile(), 'utf8'));
      ztSeenIds = new Set(Array.isArray(j.ids) ? j.ids.map(String) : []);
      ztUnread = Number(j.unread) || 0;
    } catch {
      ztSeenIds = new Set();
    }
    return ztSeenIds;
  }

  function ztSaveSeen() {
    try {
      fs.writeFileSync(ztNotifyStateFile(), JSON.stringify({
        ids: [...(ztSeenIds || [])], unread: ztUnread, at: new Date().toISOString(),
      }), 'utf8');
    } catch { /* 忽略 */ }
  }

  /** 把未读数推给渲染层（侧边栏红点） */
  function ztPushUnread() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zentao:unread', ztUnread);
  }

  ipcMain.handle('zentao:unread', () => ({ success: true, data: ztUnread }));

  ipcMain.handle('zentao:unread-clear', () => {
    ztUnread = 0;
    ztSaveSeen();
    ztPushUnread();
    return { success: true, data: 0 };
  });

  // 启动就读一次：上次退出时还没看的未读数要能在侧边栏立刻显示
  try { ztLoadSeen(); } catch { /* 忽略 */ }

  /** 从 vault 里取禅道配置（只有解锁后才有） */
  function ztCfgFromVault() {
    if (!currentPassword) return null;
    const vault = loadVault(currentPassword);
    const list = vault && Array.isArray(vault.integrations) ? vault.integrations : [];
    const settings = loadSettings() || {};
    const activeId = String(settings.zentaoActiveId || 'zentao');
    const complete = (c) => c && c.baseUrl && c.account && c.password;
    // 优先用「当前选中的那套」；它被删了就退回老的单配置，最后退回任意一套填全的
    const active = list.find(i => i && i.id === activeId);
    if (complete(active)) return active;
    const legacy = list.find(i => i && i.id === 'zentao');
    if (complete(legacy)) return legacy;
    const any = list.find(complete);
    return any || null;
  }

  /** 最近一次提醒检查的结果（设置页展示，避免「开了但不知道有没有跑」） */
  let ztLastCheck = null;

  async function ztCheckNewBugs() {
    if (ztNotifyBusy || !currentPassword) return;
    const settings = loadSettings() || {};
    if (!settings.zentaoNotify) return;
    const cfg = ztCfgFromVault();
    if (!cfg) {
      ztLastCheck = { at: new Date().toISOString(), ok: false, error: '还没在禅道页保存账号密码' };
      return;
    }
    ztNotifyBusy = true;
    try {
      const r = await ztLoadMyBugs(cfg);
      if (!r || !r.success || !Array.isArray(r.data)) {
        ztLastCheck = { at: new Date().toISOString(), ok: false, error: (r && r.error) || '拉取失败' };
        return;
      }
      const ids = new Set(r.data.map(b => String(b.id)));
      const seen = ztLoadSeen();
      const isFirstRun = seen.size === 0;
      const fresh = r.data.filter(b => !seen.has(String(b.id)));
      // 首次只记录基线，不弹一堆通知
      if (!isFirstRun && fresh.length > 0) {
        const body = fresh.slice(0, 3).map(b => `#${b.id} ${b.title}`).join('\n')
          + (fresh.length > 3 ? `\n…还有 ${fresh.length - 3} 条` : '');
        try {
          const n = new Notification({ title: `禅道：${fresh.length} 个新 Bug`, body });
          n.on('click', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.send('zentao:open');
            }
          });
          n.show();
        } catch { /* 系统不支持通知时忽略 */ }
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
        // 侧边栏红点：未读数累加并推给渲染层
        ztUnread += fresh.length;
        ztSaveSeen();
        ztPushUnread();
      }
      ztLastCheck = { at: new Date().toISOString(), ok: true, total: r.data.length, fresh: fresh.length };
      ztSeenIds = ids;
      ztSaveSeen();
    } catch { /* 提醒失败不打扰用户 */ } finally {
      ztNotifyBusy = false;
    }
  }

  /** 按设置启停定时器；锁定后 currentPassword 为空自然不再拉取 */
  function ztRestartNotify() {
    if (ztNotifyTimer) {
      clearInterval(ztNotifyTimer);
      ztNotifyTimer = null;
    }
    const settings = loadSettings() || {};
    if (!settings.zentaoNotify || !currentPassword) return;
    const min = Math.max(2, Number(settings.zentaoNotifyInterval) || 10);
    ztNotifyTimer = setInterval(ztCheckNewBugs, min * 60 * 1000);
    setTimeout(ztCheckNewBugs, 8000);
  }

  ipcMain.handle('zentao:notify-now', async () => {
    await ztCheckNewBugs();
    return { success: true, data: ztLastCheck };
  });

  ipcMain.handle('zentao:notify-status', () => {
    const settings = loadSettings() || {};
    const cfg = ztCfgFromVault();
    return {
      success: true,
      data: {
        enabled: !!settings.zentaoNotify,
        interval: Number(settings.zentaoNotifyInterval) || 10,
        configured: !!cfg,
        unlocked: !!currentPassword,
        lastCheck: ztLastCheck,
      },
    };
  });

  // ---- 禅道 REST API（api.php/v1）----
  // 用来取「整个项目（产品）」的全部 Bug —— 网页版只给「我的 Bug」，REST 能按产品拉全量。
  // 认证：POST api.php/v1/tokens {account,password} → {token}，之后每个请求带 Token 头。
  let ztApiToken = '';
  let ztApiTokenKey = '';
  const ztProductCache = new Map();   // base|account → { [productId]: name }

  const ztApiCacheKey = (cfg) => `${String(cfg.baseUrl || '').replace(/\/+$/, '')}|${cfg.account || ''}`;

  async function ztApiTokenGet(cfg, force = false) {
    const key = ztApiCacheKey(cfg);
    if (!force && ztApiToken && ztApiTokenKey === key) return ztApiToken;
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api.php/v1/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: cfg.account, password: cfg.password }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? '连接禅道 API 超时（20 秒）' : '无法连接禅道 API，请检查地址');
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    if (!json || !json.token) {
      const msg = (json && (json.error || json.message)) || '';
      if (/unauthor|denied|password|account/i.test(msg) || res.status === 401 || res.status === 400) {
        throw new Error('禅道 API 认证失败，请检查账号密码');
      }
      throw new Error(msg || `获取禅道 API Token 失败（HTTP ${res.status}）`);
    }
    ztApiToken = json.token;
    ztApiTokenKey = key;
    return ztApiToken;
  }

  async function ztApiGet(cfg, apiPath) {
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await ztApiTokenGet(cfg, attempt > 0);
      let res;
      try {
        res = await fetch(`${base}/${String(apiPath).replace(/^\/+/, '')}`, {
          headers: { Token: token, Accept: 'application/json' },
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        throw new Error(e.name === 'TimeoutError' ? '禅道 API 请求超时（30 秒）' : '无法连接禅道 API');
      }
      // token 过期：换一个再试一次
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      if (!json) throw new Error(`禅道 API 返回异常（HTTP ${res.status}）`);
      if (res.status >= 400) throw new Error(json.error || `禅道 API 返回 HTTP ${res.status}`);
      return json;
    }
    throw new Error('禅道 API 认证失败，请重试');
  }

  /** REST 里 assignedTo / openedBy 是对象 {account, realname}：显示名与登录账号分别保留 */
  const ztUserName = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return String(v.realname || v.account || '');
  };
  const ztUserAccount = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return String(v.account || '');
  };

  /** 拉产品清单（禅道里「产品」就是大家口中的项目，如「某业务系统-管理后台 V2.0」） */
  /** 项目集（programs）：产品只给 program id，重名项目靠项目集名区分 */
  async function ztApiPrograms(cfg) {
    const key = 'programs|' + ztApiCacheKey(cfg);
    const hit = ztProductCache.get(key);
    if (hit && hit.map && Date.now() - hit.at < 10 * 60 * 1000) return hit.map;
    const map = {};
    try {
      const json = await ztApiGet(cfg, 'api.php/v1/programs?limit=1000');
      const list = Array.isArray(json.programs) ? json.programs : [];
      for (const pr of list) map[String(pr.id)] = ztStripTags(pr.name || '');
    } catch { /* 旧版禅道/无项目集权限：降级为只显示项目名 */ }
    ztProductCache.set(key, { at: Date.now(), map });
    return map;
  }

  async function ztApiProducts(cfg) {
    const key = ztApiCacheKey(cfg);
    const programs = await ztApiPrograms(cfg).catch(() => ({}));
    const json = await ztApiGet(cfg, 'api.php/v1/products?limit=1000');
    const list = Array.isArray(json.products) ? json.products : [];
    const map = {};
    for (const p of list) map[String(p.id)] = ztStripTags(p.name || '');
    ztProductCache.set(key, map);
    return list.map(p => ({
      id: String(p.id),
      name: ztStripTags(p.name || ''),
      status: String(p.status || ''),
      program: String(p.program || ''),
      programName: programs[String(p.program || '')] || '',
    })).filter(p => p.name);
  }

  /**
   * REST 的 bug → 渲染层结构。
   * moduleMap 是「模块 id → 模块路径」，只有汇总统计需要（禅道 REST 不返回模块名，
   * 得另外从 tree-ajaxGetOptionMenu 拿），普通列表不传就是空字符串。
   */
  function ztMapApiBug(b, nameMap, moduleMap) {
    const mid = String(b.module == null ? '' : b.module);
    return {
      id: String(b.id || ''),
      title: ztStripTags(b.title || ''),
      status: String(b.status || ''),
      severity: String(b.severity || ''),
      pri: String(b.pri || ''),
      type: String(b.type || ''),
      product: String(b.product || ''),
      productName: nameMap[String(b.product)] || '',
      assignedTo: ztUserName(b.assignedTo),
      openedBy: ztUserName(b.openedBy),
      assignedToAccount: ztUserAccount(b.assignedTo),
      openedByAccount: ztUserAccount(b.openedBy),
      date: ztApiLocalTime(b.openedDate).slice(0, 10),
      deadline: b.deadline ? String(b.deadline).slice(0, 10) : '',
      resolution: String(b.resolution || ''),
      module: mid,
      moduleName: (moduleMap && moduleMap[mid]) || '',
      // 汇总里的「近 7 天新增 / 修复」要用到（REST 给的是 UTC，这里统一转本地时间）
      openedDate: ztApiLocalTime(b.openedDate),
      resolvedDate: ztApiLocalTime(b.resolvedDate),
      closedDate: ztApiLocalTime(b.closedDate),
    };
  }

  /** 禅道 REST 的时间是 ISO（带 Z），转成本地 YYYY-MM-DD HH:mm；空值返回空串 */
  function ztApiLocalTime(v) {
    if (!v) return '';
    const s = String(v);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.slice(0, 19).replace('T', ' ');
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }


  /** 模块 id → 模块路径（取项目下 bug 模块树；需要 HTML 会话，失败只返回空表） */
  async function ztFetchModuleNames(cfg, productId) {
    const out = {};
    try {
      const login = await ztEnsureLogin(cfg);
      if (!login.ok) return out;
      const page = await ztFetch(cfg, `tree-ajaxGetOptionMenu-${encodeURIComponent(productId)}-bug.html`);
      if (page.status !== 200 || !page.text) return out;
      const json = ztParseJson(page.text);
      const items = (json && Array.isArray(json.items)) ? json.items : [];
      for (const it of items) {
        const id = String(it.value == null ? '' : it.value);
        const text = String(it.text || '').replace(/^\//, '').trim();
        if (id && text && text !== '/') out[id] = text;
      }
    } catch { /* 模块名拿不到不影响统计主流程 */ }
    return out;
  }

  ipcMain.handle('zentao:projects', async (_event, cfg) => {
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    cfg = ztNormalizeCfg(cfg);
    try {
      const data = await ztApiProducts(cfg);
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 某个产品（项目）下的全部 Bug，不分指派人。
   * 与 zentao:all-bugs 保持同一套缓存策略（10 分钟 + force 绕过），
   * 否则「单项目」每次实时拉、「全部项目」命中缓存，两个视图的数字会不一致。
   */
  const ztProjectBugsCache = new Map();
  const ZT_PROJ_TTL = 10 * 60 * 1000;

  ipcMain.handle('zentao:project-bugs', async (_event, payload = {}) => {
    let { cfg, productId, force } = payload || {};
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    if (!productId) return { success: false, error: '请选择项目' };
    cfg = ztNormalizeCfg(cfg);

    const cacheKey = `${cfg.baseUrl}|${cfg.account}|${productId}`;
    const hit = ztProjectBugsCache.get(cacheKey);
    if (!force && hit && Date.now() - hit.at < ZT_PROJ_TTL) {
      return { success: true, ...hit.value, cached: true, ageMs: Date.now() - hit.at };
    }

    try {
      const key = ztApiCacheKey(cfg);
      let nameMap = ztProductCache.get(key);
      if (!nameMap) {
        await ztApiProducts(cfg);
        nameMap = ztProductCache.get(key) || {};
      }
      // 模块名与 Bug 并行取：模块接口要 HTML 会话，失败只影响「模块」列显示
      const modPromise = ztFetchModuleNames(cfg, productId);
      // ⚠️ 不带 status=all 时 REST 只返回「未关闭」的，含已关闭必须显式传 all
      const first = await ztApiGet(cfg, `api.php/v1/bugs?product=${encodeURIComponent(productId)}&status=all&limit=1000&page=1`);
      let bugs = Array.isArray(first.bugs) ? first.bugs.slice() : [];
      const total = Number(first.total || bugs.length);
      // 超过 1000 条时继续翻页（最多 5 页，够用且不至于把内存打爆）
      if (total > bugs.length) {
        const pages = Math.min(5, Math.ceil(total / 1000));
        for (let p = 2; p <= pages; p++) {
          const more = await ztApiGet(cfg, `api.php/v1/bugs?product=${encodeURIComponent(productId)}&status=all&limit=1000&page=${p}`);
          const arr = Array.isArray(more.bugs) ? more.bugs : [];
          if (arr.length === 0) break;
          bugs = bugs.concat(arr);
          if (arr.length < 1000) break;
        }
      }
      const modules = await modPromise;
      const data = bugs.map(b => ztMapApiBug(b, nameMap, modules)).filter(b => b.id);
      const value = { data, total, fetchedAt: new Date().toISOString() };
      ztProjectBugsCache.set(cacheKey, { at: Date.now(), value });
      // 项目多时缓存会攒不少，只留最近 6 份
      if (ztProjectBugsCache.size > 6) {
        const oldest = [...ztProjectBugsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) ztProjectBugsCache.delete(oldest[0]);
      }
      return { success: true, ...value, cached: false, ageMs: 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 所有项目（产品）的全部 Bug —— 用于「全部」视图看总数与跨项目统计 */
  // 全量 Bug 缓存：切项目/切页回来不必重新拉 31 个产品（TTL 10 分钟，force 可绕过）
  const ztAllBugsCache = new Map();
  const ZT_ALL_TTL = 10 * 60 * 1000;

  ipcMain.handle('zentao:all-bugs', async (_event, cfg, opts = {}) => {
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    cfg = ztNormalizeCfg(cfg);
    const cacheKey = `${cfg.baseUrl}|${cfg.account}`;
    const hit = ztAllBugsCache.get(cacheKey);
    if (!(opts && opts.force) && hit && Date.now() - hit.at < ZT_ALL_TTL) {
      return { success: true, ...hit.value, cached: true, ageMs: Date.now() - hit.at };
    }
    try {
      const key = ztApiCacheKey(cfg);
      const products = await ztApiProducts(cfg);
      const nameMap = ztProductCache.get(key) || {};
      const perPage = 1000;
      // 与 zentao:project-bugs 保持一致（都 5 页 = 5000 条），否则「全部项目」视图
      // 会在大项目上悄悄少数据，而单项目视图是全的
      const maxPages = 5;
      const queue = products.slice();
      const collected = [];
      let reported = 0;

      const worker = async () => {
        for (;;) {
          const p = queue.shift();
          if (!p) return;
          const first = await ztApiGet(cfg, `api.php/v1/bugs?product=${encodeURIComponent(p.id)}&status=all&limit=${perPage}&page=1`);
          const total = Number(first.total || 0);
          reported += total;
          let bugs = Array.isArray(first.bugs) ? first.bugs : [];
          const pages = Math.min(maxPages, Math.ceil(total / perPage));
          for (let pg = 2; pg <= pages; pg++) {
            const more = await ztApiGet(cfg, `api.php/v1/bugs?product=${encodeURIComponent(p.id)}&status=all&limit=${perPage}&page=${pg}`);
            const arr = Array.isArray(more.bugs) ? more.bugs : [];
            if (!arr.length) break;
            bugs = bugs.concat(arr);
            if (arr.length < perPage) break;
          }
          for (const b of bugs) collected.push(b);
        }
      };
      // 6 个并发：31 个产品大约 3~5 秒
      await Promise.all(Array.from({ length: 6 }, worker));

      const seen = new Map();
      for (const b of collected) {
        const id = String(b.id || '');
        if (id && !seen.has(id)) seen.set(id, b);
      }
      const data = [...seen.values()]
        .map(b => ztMapApiBug(b, nameMap))
        .filter(b => b.id)
        .sort((a, b) => Number(b.id) - Number(a.id));
      // total 用去重后的实际条数，避免和表格行数不一致（reported 仅作参考）
      const value = {
        data, total: data.length, reported, products: products.length,
        fetchedAt: new Date().toISOString(),
      };
      ztAllBugsCache.set(cacheKey, { at: Date.now(), value });
      return { success: true, ...value, cached: false, ageMs: 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });



  /**
   * 多项目缺陷汇总：一次拉取选中项目的全部 Bug（含已关闭）+ 每个项目的模块名。
   * 统计口径放在渲染层做（排除人员可随时改，不用重新拉数据）。
   */
  const ztSummaryCache = new Map();
  const ZT_SUM_TTL = 10 * 60 * 1000;
  // 一次汇总可能几百 KB～几 MB（全量 Bug 数组），条目不能无限堆：
  // 只留最近 4 份，顺手清掉过期项（用户反复换项目组合时 Map 会一直长）。
  const ZT_SUM_MAX = 4;
  function ztSummaryPrune() {
    const now = Date.now();
    for (const [k, v] of ztSummaryCache) {
      if (now - v.at >= ZT_SUM_TTL) ztSummaryCache.delete(k);
    }
    while (ztSummaryCache.size > ZT_SUM_MAX) {
      const oldest = [...ztSummaryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      ztSummaryCache.delete(oldest[0]);
    }
  }

  ipcMain.handle('zentao:summary', async (_event, cfg, productIds = [], opts = {}) => {
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    cfg = ztNormalizeCfg(cfg);
    const ids = (Array.isArray(productIds) ? productIds : []).map(x => String(x)).filter(Boolean);
    if (ids.length === 0) return { success: false, error: '请先选择要汇总的项目' };

    const cacheKey = `${cfg.baseUrl}|${cfg.account}|${ids.slice().sort().join(',')}`;
    const hit = ztSummaryCache.get(cacheKey);
    if (!(opts && opts.force) && hit && Date.now() - hit.at < ZT_SUM_TTL) {
      return { success: true, ...hit.value, cached: true, ageMs: Date.now() - hit.at };
    }

    try {
      const key = ztApiCacheKey(cfg);
      let nameMap = ztProductCache.get(key);
      if (!nameMap) {
        await ztApiProducts(cfg);
        nameMap = ztProductCache.get(key) || {};
      }

      const queue = ids.slice();
      const collected = [];
      const modules = {};
      const perPage = 1000;
      const maxPages = 5;
      const errors = [];

      const worker = async () => {
        for (;;) {
          const pid = queue.shift();
          if (!pid) return;
          // 单个产品失败重试一次：偶发超时不该让整个汇总缺一个项目
          for (let attempt = 0; attempt < 2; attempt++) {
          try {
            // 模块名与 Bug 并行取：模块接口失败不影响 Bug
            const modPromise = ztFetchModuleNames(cfg, pid);
            let first = await ztApiGet(cfg, `api.php/v1/bugs?product=${encodeURIComponent(pid)}&status=all&limit=${perPage}&page=1`);
            let bugs = Array.isArray(first.bugs) ? first.bugs.slice() : [];
            const total = Number(first.total || bugs.length);
            const pages = Math.min(maxPages, Math.ceil(total / perPage));
            for (let pg = 2; pg <= pages; pg++) {
              const more = await ztApiGet(cfg, `api.php/v1/bugs?product=${encodeURIComponent(pid)}&status=all&limit=${perPage}&page=${pg}`);
              const arr = Array.isArray(more.bugs) ? more.bugs : [];
              if (!arr.length) break;
              bugs = bugs.concat(arr);
              if (arr.length < perPage) break;
            }
            modules[pid] = await modPromise;
            for (const b of bugs) collected.push(b);
            break;
          } catch (e) {
            if (attempt === 0) {
              await new Promise(r => setTimeout(r, 500));
              continue;
            }
            errors.push(`${pid}: ${e.message}`);
          }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));

      // 同一个 Bug 可能因为跨项目关联被重复返回，按 id 去重
      const seen = new Map();
      for (const b of collected) {
        const id = String(b.id || '');
        if (id && !seen.has(id)) seen.set(id, b);
      }
      const data = [...seen.values()]
        .map(b => ztMapApiBug(b, nameMap, modules[String(b.product)] || {}))
        .filter(b => b.id)
        .sort((a, b) => Number(b.id) - Number(a.id));

      const value = {
        data,
        total: data.length,
        modules,
        productIds: ids,
        fetchedAt: new Date().toISOString(),
        errors,
      };
      ztSummaryCache.set(cacheKey, { at: Date.now(), value });
      ztSummaryPrune();
      return { success: true, ...value, cached: false, ageMs: 0 };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- Import ----
  ipcMain.handle('import:csv-json', async (_event, { filePath, password }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    try {
      const ext = path.extname(filePath).toLowerCase();
      let records = [];

      if (ext === '.xlsx' || ext === '.xls') {
        const workbook = XLSX.readFile(filePath, { raw: false });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) return { success: false, error: 'Excel文件为空' };
        const sheet = workbook.Sheets[sheetName];
        records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        if (ext === '.json') {
          records = JSON.parse(content);
          if (!Array.isArray(records)) records = [records];
        } else if (ext === '.csv' || ext === '.txt') {
          const rows = parseCsv(content);
          if (rows.length < 2) return { success: false, error: 'CSV文件格式无效' };
          const headers = rows[0].map(h => h.trim());
          for (let i = 1; i < rows.length; i++) {
            if (rows[i].every(v => !String(v).trim())) continue;
            const obj = {};
            headers.forEach((h, idx) => { obj[h] = rows[i][idx] === undefined ? '' : rows[i][idx]; });
            records.push(obj);
          }
          // CSV has no way to keep the original timestamps apart from these columns;
          // they are mapped by normalizeImportRecords like any other field.
        } else if (ext === '.html' || ext === '.htm') {
          const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
          let match;
          while ((match = linkRegex.exec(content)) !== null) {
            const url = match[1];
            const name = match[2].trim();
            if (url && !url.startsWith('javascript:') && !url.startsWith('place:')) {
              records.push({ name, url, username: '', password: '', notes: '', envType: 'production', tags: '' });
            }
          }
        }
      }
      const normalized = normalizeImportRecords(records);
      // 一列都没认出来（比如用户的表头是自定义中文）时，把原始记录交回去，
      // 让界面上的手动字段映射派上用场，而不是直接报「没有可导入的数据」。
      if (normalized.length === 0 && records.length > 0) {
        return { success: true, data: records, raw: true };
      }
      return { success: true, data: normalized };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- Import encrypted backup ----
  ipcMain.handle('import:encrypted', async (_event, { filePath, importPassword }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    try {
      // Try reading as text (base64 string format from this app's export)
      let rawContent = fs.readFileSync(filePath, 'utf8').trim();
      // Strip UTF-8 BOM if present
      if (rawContent.charCodeAt(0) === 0xFEFF) rawContent = rawContent.slice(1).trim();

      let decrypted = decrypt(rawContent, importPassword);

      // If text decryption failed, try reading as binary and convert to base64
      if (!decrypted) {
        const binaryBuf = fs.readFileSync(filePath);
        const b64Content = binaryBuf.toString('base64');
        decrypted = decrypt(b64Content, importPassword);
      }

      if (!decrypted) return { success: false, error: '密码错误或文件损坏' };
      const data = JSON.parse(decrypted);
      if (!data.entries || !Array.isArray(data.entries)) {
        return { success: false, error: '无效的加密备份文件' };
      }
      return { success: true, data: data.entries };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('import:confirm', (_event, { entries, conflictStrategy, password }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };

    // 判重键：url + 用户名（同一网址不同账号不算重复；没有 url 时退回 name + 用户名）
    const dupKey = (e) => {
      const url = String(e && e.url || '').trim().toLowerCase().replace(/\/+$/, '');
      const user = String(e && e.username || '').trim().toLowerCase();
      const name = String(e && e.name || '').trim().toLowerCase();
      return url ? `${url}||${user}` : `name||${name}||${user}`;
    };
    const existingMap = new Map();
    vault.entries.forEach(e => existingMap.set(dupKey(e), e));

    const now = new Date().toISOString();
    let importedCount = 0;

    entries.forEach(entry => {
      const existing = existingMap.get(dupKey(entry));
      if (existing) {
        if (conflictStrategy === 'skip') return;
        if (conflictStrategy === 'overwrite') {
          Object.assign(existing, entry);
          existing.updatedAt = now;
          importedCount++;
          return;
        }
        if (conflictStrategy === 'duplicate') {
          // fall through to add
        } else {
          return; // unknown strategy, skip
        }
      }
      vault.entries.push({
        ...entry,
        id: entry.id || crypto.randomUUID(),
        createdAt: entry.createdAt || now,
        updatedAt: now
      });
      importedCount++;
      if (entry.tags) {
        entry.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
      }
    });

    saveVault(vault, currentPassword);
    return { success: true, data: vault, importedCount };
  });

  // ---- Import template ----
  ipcMain.handle('import:download-template', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: '导入模板.xlsx',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const wb = XLSX.utils.book_new();
    const ws_data = XLSX.utils.aoa_to_sheet([
      ['名称', 'URL', '账号', '密码', '备注', '标签', '环境类型'],
      ['示例网站', 'https://example.com', 'admin', 'P@ssw0rd', '备注信息', '工作;重要', 'production'],
    ]);
    ws_data['!cols'] = [{ wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 15 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws_data, '密码网址');
    XLSX.writeFile(wb, result.filePath);
    return { success: true };
  });

  // ---- Export ----
  ipcMain.handle('export:encrypted', (_event, { exportPassword, filter }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    let entries = vault.entries;
    if (filter === 'production') entries = entries.filter(e => e.envType === 'production');
    else if (filter === 'testing') entries = entries.filter(e => e.envType === 'testing');
    else if (filter.startsWith('tag:')) {
      const tag = filter.slice(4);
      entries = entries.filter(e => e.tags && e.tags.includes(tag));
    }
    const exportData = { entries, tags: vault.tags, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(exportData);
    const encrypted = encrypt(json, exportPassword);
    return { success: true, data: encrypted };
  });

  ipcMain.handle('export:plain', (_event, { format, includePasswords, filter }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    let entries = vault.entries;
    if (filter === 'production') entries = entries.filter(e => e.envType === 'production');
    else if (filter === 'testing') entries = entries.filter(e => e.envType === 'testing');
    else if (filter.startsWith('tag:')) {
      const tag = filter.slice(4);
      entries = entries.filter(e => e.tags && e.tags.includes(tag));
    }
    if (!includePasswords) {
      entries = entries.map(e => ({ ...e, password: undefined }));
    }
    let output;
    if (format === 'json') {
      output = JSON.stringify(entries, null, 2);
    } else if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(entries);
      const colWidths = Object.keys(entries[0] || {}).map(k => ({ wch: Math.max(k.length * 2, 15) }));
      ws['!cols'] = colWidths;
      XLSX.utils.book_append_sheet(wb, ws, '密码网址');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      output = buf.toString('base64');
    } else {
      const headerMap = {
        name: '名称', envType: '环境类型', url: '网址', username: '账号',
        password: '密码', notes: '备注', tags: '标签', createdAt: '创建时间', updatedAt: '修改时间'
      };
      const keys = ['name', 'envType', 'url', 'username', 'password', 'notes', 'tags', 'createdAt', 'updatedAt'];
      output = keys.map(k => headerMap[k] || k).join(',') + '\n';
      entries.forEach(e => {
        output += keys.map(k => {
          const v = e[k];
          if (Array.isArray(v)) return `"${v.join(';')}"`;
          return `"${(v || '').toString().replace(/"/g, '""')}"`;
        }).join(',') + '\n';
      });
    }
    return { success: true, data: output, count: entries.length };
  });

  // ---- Export selected entries by IDs ----
  ipcMain.handle('export:selected-encrypted', (_event, { ids, exportPassword }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    const entries = vault.entries.filter(e => ids.includes(e.id));
    const exportData = { entries, tags: vault.tags, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(exportData);
    const encrypted = encrypt(json, exportPassword);
    return { success: true, data: encrypted, count: entries.length };
  });

  ipcMain.handle('export:selected-plain', (_event, { ids, format, includePasswords }) => {
    if (!currentPassword) return { success: false, error: '未解锁' };
    const vault = loadVault(currentPassword);
    if (!vault) return { success: false, error: '数据损坏' };
    let entries = vault.entries.filter(e => ids.includes(e.id));
    if (!includePasswords) {
      entries = entries.map(e => ({ ...e, password: undefined }));
    }
    let output;
    if (format === 'json') {
      output = JSON.stringify(entries, null, 2);
    } else if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(entries);
      const colWidths = Object.keys(entries[0] || {}).map(k => ({ wch: Math.max(k.length * 2, 15) }));
      ws['!cols'] = colWidths;
      XLSX.utils.book_append_sheet(wb, ws, '密码网址');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      output = buf.toString('base64');
    } else {
      const headerMap = {
        name: '名称', envType: '环境类型', url: '网址', username: '账号',
        password: '密码', notes: '备注', tags: '标签', createdAt: '创建时间', updatedAt: '修改时间'
      };
      const keys = ['name', 'envType', 'url', 'username', 'password', 'notes', 'tags', 'createdAt', 'updatedAt'];
      output = keys.map(k => headerMap[k] || k).join(',') + '\n';
      entries.forEach(e => {
        output += keys.map(k => {
          const v = e[k];
          if (Array.isArray(v)) return `"${v.join(';')}"`;
          return `"${(v || '').toString().replace(/"/g, '""')}"`;
        }).join(',') + '\n';
      });
    }
    return { success: true, data: output, count: entries.length };
  });

  // 目录型文件 IPC（周报 / 笔记）已拆到 electron/ipc-files.js
  registerSystemIpc({ getWindow: () => mainWindow, tdgPaths: { distPath: TDG_DIST_PATH, preloadPath: TDG_PRELOAD_PATH } });
  registerCodelabIpc({ getWindow: () => mainWindow });
  registerFileIpc({ getWindow: () => mainWindow });
  registerToolsIpc();
  registerBrowserIpc({ loadSettings });
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
app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  // Register custom protocol for test-data-generator sub-app
  setupTdgProtocol();
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