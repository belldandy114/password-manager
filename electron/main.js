const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Menu, shell, dialog, globalShortcut, protocol, Tray, screen, Notification, net } = require('electron');
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
const USER_DATA_DIR = app.getPath('userData');
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
const DATA_FILE = path.join(DATA_DIR, 'vault.enc');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BIN_FILE = path.join(DATA_DIR, 'trash.enc');
const ALGO = 'aes-256-gcm';
const KEY_ITERATIONS = 600000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
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

function backupVaultOncePerDay() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `vault-${day}.enc`);
    if (fs.existsSync(target)) return false; // already backed up today
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DATA_FILE, target);

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
  accent: 'indigo',
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
  tray.setToolTip('测试工具');
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
    { label: '显示主窗口', click: () => showMainWindow() },
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
      sandbox: false,
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
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ----------------------------------------------------------------
// Clipboard auto-clear helpers
// ----------------------------------------------------------------
let clipboardTimers = {};

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

// ----------------------------------------------------------------
// Vault shape (1.2.0 expanded from { entries, tags })
// ----------------------------------------------------------------
// 新增模块（SQL 片段 / 笔记 / 检查清单 / 账号池 / 环境总览 / 接口调试）都放在同一个
// 加密文件里，随密码库一起加密，不额外增加新的密码。旧数据缺少这些字段时补空数组。
const VAULT_COLLECTIONS = ['snippets', 'notes', 'checklists', 'accounts', 'environments', 'apiRequests', 'integrations',
  'ztPresets', 'apiEnvs', 'apiHistory'];

function normalizeVault(v) {
  const src = v && typeof v === 'object' ? v : {};
  const out = {
    entries: Array.isArray(src.entries) ? src.entries : [],
    tags: Array.isArray(src.tags) ? src.tags : [],
    history: (src.history && typeof src.history === 'object' && !Array.isArray(src.history)) ? src.history : {},
  };
  for (const key of VAULT_COLLECTIONS) {
    out[key] = Array.isArray(src[key]) ? src[key] : [];
  }
  return out;
}

// ----------------------------------------------------------------
// TOTP (two-factor codes stored next to the entry)
// ----------------------------------------------------------------
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, atMs, digits = 6, period = 30) {
  const key = base32Decode(secret);
  if (!key.length) return null;
  const counter = BigInt(Math.floor(atMs / 1000 / period));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

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
function setupIpcHandlers() {

  // Brute-force guard: 5 wrong passwords in a row → 30s cool-down (in-memory, resets on restart).
  const LOGIN_MAX_FAILURES = 5;
  const LOGIN_LOCK_MS = 30000;
  let loginFailures = 0;
  let loginLockedUntil = 0;

  // ---- Master password ----
  ipcMain.handle('auth:is-setup', () => {
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
    clearCaches();
    try { ztRestartNotify(); } catch { /* 锁定后自动停掉定时器 */ }
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
      clearClipboardAfter(delay);
    }
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

  // ---- Password generator ----
  ipcMain.handle('password:generate', (_event, opts = {}) => {
    const length = Math.min(128, Math.max(6, Number(opts.length) || 16));
    const sets = [];
    const AMBIGUOUS = 'Il1O0o';
    const clean = (s) => opts.excludeAmbiguous ? s.split('').filter(c => !AMBIGUOUS.includes(c)).join('') : s;

    if (opts.lower !== false) sets.push(clean('abcdefghijklmnopqrstuvwxyz'));
    if (opts.upper !== false) sets.push(clean('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    if (opts.digits !== false) sets.push(clean('0123456789'));
    if (opts.symbols) sets.push(clean('!@#$%^&*()-_=+[]{};:,.?/'));

    const usable = sets.filter(s => s.length > 0);
    if (usable.length === 0) return { success: false, error: '请至少选择一种字符类型' };

    const chars = [];
    // Guarantee at least one character from every selected set.
    for (const set of usable) chars.push(set[crypto.randomInt(set.length)]);
    const all = usable.join('');
    while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
    // Fisher–Yates with crypto randomness so the guaranteed characters are not stuck at the front.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return { success: true, data: chars.join('') };
  });

  // ---- Backups ----
  ipcMain.handle('backup:list', () => ({
    success: true,
    data: listBackups(),
    dir: BACKUP_DIR,
    keep: backupKeepCount(),
    lastAt: (listBackups()[0] || {}).mtime || '',
  }));

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

  // ---- Update check (GitHub Releases) ----
  ipcMain.handle('update:check', async () => {
    const cmpVersion = (a, b) => {
      const pa = String(a).split('.').map(Number);
      const pb = String(b).split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x > y ? 1 : -1;
      }
      return 0;
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch('https://api.github.com/repos/belldandy114/password-manager/releases/latest', {
        headers: { 'User-Agent': 'password-manager-app', Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const json = await res.json();
      const latest = String(json.tag_name || '').replace(/^v/, '');
      const current = app.getVersion();
      return {
        success: true,
        data: {
          current,
          latest,
          hasUpdate: !!latest && cmpVersion(latest, current) > 0,
          url: json.html_url || '',
          // 优先给安装包直链，供「下载并安装」用
          downloadUrl: (Array.isArray(json.assets) ? json.assets.find(a => /\.exe$/i.test(a.name || '')) : null)?.browser_download_url || '',
          notes: (json.body || '').slice(0, 2000),
        },
      };
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
    }
  });

  // ---- 应用内更新：下载安装包并重启安装 ----
  /** GitHub 大文件走 CDN（objects.githubusercontent.com），不少公司网络会直接重置连接 */
  const UPDATE_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/'];

  /**
   * 用 Chromium 网络栈下载（Electron net）：
   * Node 的 fetch(undici) 不读系统代理，遇到代理/证书拦截就只报一句 "fetch failed"；
   * net 走 Chromium，能跟随系统代理设置，也能拿到更具体的错误。
   */
  function netDownload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fin = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* 忽略 */ }
        fin(reject, new Error('下载超时（30 分钟无响应）'));
      }, 30 * 60 * 1000);

      request.setHeader('User-Agent', 'password-manager-app');
      request.on('response', (response) => {
        const status = response.statusCode;
        if (status >= 400) {
          clearTimeout(timer);
          try { response.resume(); } catch { /* 忽略 */ }
          fin(reject, new Error(`HTTP ${status}`));
          return;
        }
        const total = Number(response.headers['content-length'] || 0);
        const out = fs.createWriteStream(file);
        let received = 0;
        let lastEmit = 0;
        let windowBytes = 0;
        let windowAt = Date.now();
        let speed = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          windowBytes += chunk.length;
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
            onProgress(received, total, speed);
          }
        });
        response.on('end', () => {
          clearTimeout(timer);
          out.end(() => fin(resolve, { size: received, total, speed, threads: 1 }));
        });
        response.on('error', (e) => {
          clearTimeout(timer);
          out.destroy();
          fin(reject, e);
        });
      });
      request.on('error', (e) => {
        clearTimeout(timer);
        fin(reject, e);
      });
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
        const out = fs.createWriteStream(dest);
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
  async function netDownloadParallel(url, file, onProgress, threads = 6) {
    const probe = await netProbe(url);
    if (!probe.ok || probe.total < 4 * 1024 * 1024) {
      return { fallback: true };
    }
    const total = probe.total;
    const n = Math.max(2, Math.min(8, threads));
    const chunk = Math.ceil(total / n);
    const parts = [];
    const ranges = [];
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      if (start >= total) break;
      const end = Math.min(total - 1, start + chunk - 1);
      ranges.push({ start, end, part: `${file}.part${i}` });
      parts.push(`${file}.part${i}`);
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

  ipcMain.handle('update:download', async (event, { url, useMirror } = {}) => {
    if (!url) return { success: false, error: '没有可用的下载地址' };
    const dir = path.join(app.getPath('temp'), 'pm-update');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    const file = path.join(dir, `PasswordManager-Setup-${Date.now()}.exe`);

    // 直连优先；只有用户主动点「用加速镜像」才走第三方代理（安装包是 exe，默认不代下载）
    const targets = useMirror
      ? UPDATE_MIRRORS.map(m => ({ label: m.replace(/^https?:\/\//, '').replace(/\/+$/, ''), url: `${m.replace(/\/+$/, '')}/${url}` }))
      : [{ label: 'GitHub', url }];

    const errors = [];
    for (const t of targets) {
      try {
        // 先试多线程分段（CDN 单连接常被限速），不支持 Range 再退回单连接
        let r = await netDownloadParallel(t.url, file, (received, total, speed) => {
          try { event.sender.send('update:progress', { received, total, speed, threads: 6 }); } catch { /* 窗口已关 */ }
        });
        if (r.fallback) {
          try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* 忽略 */ }
          r = await netDownload(t.url, file, (received, total, speed) => {
            try { event.sender.send('update:progress', { received, total, speed, threads: 1 }); } catch { /* 窗口已关 */ }
          });
        }
        if (r.size < 1024 * 1024) {
          try { fs.unlinkSync(file); } catch { /* 忽略 */ }
          errors.push(`${t.label}：文件过小（${Math.round(r.size / 1024)} KB）`);
          continue;
        }
        return { success: true, data: { file, size: r.size, via: t.label, threads: r.threads || 1 } };
      } catch (e) {
        errors.push(`${t.label}：${e.message || '连接被中断'}`);
        try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* 忽略 */ }
      }
    }

    return {
      success: false,
      error: [
        '下载失败，网络访问不了 GitHub 的下载节点（公司网络常见）。',
        '可以：①点「浏览器下载」到发布页手动下；②已经下好了就点「选择安装包」；' + (useMirror ? '③换个网络再试。' : '③点「加速镜像重试」。'),
        `（${errors.join('；')}）`,
      ].join(' '),
      canMirror: !useMirror,
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

  // ---- TOTP ----
  ipcMain.handle('totp:code', (_event, { secret, digits = 6, period = 30 } = {}) => {
    if (!secret) return { success: false, error: '未配置密钥' };
    const now = Date.now();
    const code = totpAt(secret, now, digits, period);
    if (!code) return { success: false, error: '密钥格式无效' };
    const remain = period - Math.floor((now / 1000) % period);
    return { success: true, data: { code, remain, period } };
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
            if (i > 0) params.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
          });
          init.body = params.toString();
          setCT('application/x-www-form-urlencoded; charset=UTF-8');
        } else if (bodyType === 'multipart') {
          // key=value 每行一个；value 以 @ 开头视为文件路径
          const fd = new FormData();
          const lines = String(body).split('\n').filter(l => l.trim());
          for (const line of lines) {
            const i = line.indexOf('=');
            if (i <= 0) continue;
            const key = line.slice(0, i).trim();
            const val = line.slice(i + 1).trim();
            if (val.startsWith('@')) {
              const file = val.slice(1);
              if (!fs.existsSync(file)) {
                return { success: false, error: `上传文件不存在：${file}` };
              }
              fd.append(key, new Blob([fs.readFileSync(file)]), path.basename(file));
            } else {
              fd.append(key, val);
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

  const ztDecodeEntities = (s) => String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#x2F;/g, '/');

  /**
   * 禅道 20.x 把表格数据写在 zui-create-dtable 属性里，但整体不是合法 JSON
   * （混了 JS 函数体），所以只按括号配平截取 "data": [...] 再解析。
   */
  function ztTableRows(html) {
    if (!html) return [];
    const attr = html.match(/zui-create-dtable="([^"]*)"/);
    if (!attr) return [];
    const raw = ztDecodeEntities(attr[1]);
    const marker = '"data":';
    const at = raw.indexOf(marker);
    if (at < 0) return [];
    let i = at + marker.length;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== '[') return [];
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < raw.length; j++) {
      const c = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) return [];
    try {
      const arr = JSON.parse(raw.slice(i, end));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  const ztStripTags = (s) => String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
      // 内容形如「2026-10-27 17:36:32, 由 梁金龙 创建。」，把时间与「由 X」拆出来做结构化展示
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
   * 「我提交的 / 待我验证」走 REST（api.php/v1）：
   * 页面抓取那套只认 assignedTo 的分页模板，openedBy 与「待验证」没有现成模板可用。
   */
  async function ztLoadMyBugsScoped(cfg, scope) {
    cfg = ztNormalizeCfg(cfg);
    if (!cfg.account || !cfg.password) return { success: false, error: '请先填写账号和密码' };
    try {
      const products = await ztApiProducts(cfg).catch(() => []);
      const nameMap = {};
      for (const p of products) nameMap[String(p.id)] = p.name;

      const build = (page) => {
        const params = new URLSearchParams();
        params.set('limit', '1000');
        params.set('page', String(page));
        if (scope === 'opened') {
          params.set('openedBy', cfg.account);
          params.set('status', 'all');        // 我提交的：含已关闭，能看整体履约情况
        } else {
          params.set('assignedTo', cfg.account);
          params.set('status', 'resolved');   // 待我验证：已解决、还没关闭
        }
        return `api.php/v1/bugs?${params.toString()}`;
      };

      const first = await ztApiGet(cfg, build(1));
      const all = (Array.isArray(first.bugs) ? first.bugs : []).map(b => ztMapApiBug(b, nameMap));
      const total = Number(first.total) || all.length;

      // 超过一页继续翻（最多 5 页，别把禅道打崩）
      for (let page = 2; page <= Math.min(5, Math.ceil(total / 1000)); page++) {
        const next = await ztApiGet(cfg, build(page));
        const rows = (Array.isArray(next.bugs) ? next.bugs : []).map(b => ztMapApiBug(b, nameMap));
        if (!rows.length) break;
        all.push(...rows);
      }

      return { success: true, data: all, total, scope };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  ipcMain.handle('zentao:my-bugs', async (_event, cfg, scope = 'assigned') => {
    if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
    if (scope === 'opened' || scope === 'verify') return ztLoadMyBugsScoped(cfg, scope);
    return ztLoadMyBugs(cfg);
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

  /** REST 里 assignedTo / openedBy 是对象 {account, realname} */
  const ztUserName = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    return String(v.realname || v.account || '');
  };

  /** 拉产品清单（禅道里「产品」就是大家口中的项目，如「资产管理系统-管理后台V2.0.0」） */
  async function ztApiProducts(cfg) {
    const key = ztApiCacheKey(cfg);
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
    })).filter(p => p.name);
  }

  function ztMapApiBug(b, nameMap) {
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
      date: String(b.openedDate || '').slice(0, 10),
      deadline: b.deadline ? String(b.deadline).slice(0, 10) : '',
      resolution: String(b.resolution || ''),
    };
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

  /** 某个产品（项目）下的全部 Bug，不分指派人 */
  ipcMain.handle('zentao:project-bugs', async (_event, { cfg, productId } = {}) => {
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    if (!productId) return { success: false, error: '请选择项目' };
    cfg = ztNormalizeCfg(cfg);
    try {
      const key = ztApiCacheKey(cfg);
      let nameMap = ztProductCache.get(key);
      if (!nameMap) {
        await ztApiProducts(cfg);
        nameMap = ztProductCache.get(key) || {};
      }
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
      const data = bugs.map(b => ztMapApiBug(b, nameMap)).filter(b => b.id);
      return { success: true, data, total };
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
      const maxPages = 3;               // 单个项目最多翻 3 页，避免异常数据把内存打爆
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

  // ---- 周报（本地 Markdown 目录） ----
  // 列表/读取/写入/删除都限制在指定目录内，删除走系统回收站（可恢复）。
  const WEEKLY_EXTS = ['.md', '.markdown', '.txt'];

  const weeklyResolve = (dir, name) => {
    const root = path.resolve(String(dir || ''));
    const file = path.resolve(root, String(name || ''));
    // 目录穿越保护：拼出来的路径必须还在目录里
    if (!file.startsWith(root + path.sep) && file !== root) {
      return { error: '非法文件路径' };
    }
    return { file };
  };

  ipcMain.handle('weekly:list', async (_event, { dir } = {}) => {
    try {
      if (!dir) return { success: false, error: '未指定周报目录' };
      if (!fs.existsSync(dir)) return { success: false, error: `目录不存在：${dir}` };
      if (!fs.statSync(dir).isDirectory()) return { success: false, error: `不是目录：${dir}` };
      const files = fs.readdirSync(dir)
        .filter(n => WEEKLY_EXTS.includes(path.extname(n).toLowerCase()))
        .map(n => {
          const st = fs.statSync(path.join(dir, n));
          return { name: n, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      return { success: true, data: files };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('weekly:read', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = weeklyResolve(dir, name);
      if (error) return { success: false, error };
      if (!fs.existsSync(file)) return { success: false, error: '文件不存在' };
      const content = fs.readFileSync(file, 'utf8');
      const st = fs.statSync(file);
      return { success: true, data: { name, content, mtime: st.mtime.toISOString(), size: st.size } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('weekly:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, data: null };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('weekly:reveal', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = weeklyResolve(dir, name);
      if (error) return { success: false, error };
      shell.showItemInFolder(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 新建 / 修改：直接写 .md 文件（UTF-8，不覆盖非 md 文件） */
  ipcMain.handle('weekly:save', async (_event, { dir, name, content } = {}) => {
    try {
      if (!dir) return { success: false, error: '未指定周报目录' };
      let fileName = String(name || '').trim();
      if (!fileName) return { success: false, error: '请填写文件名（例如 2026-10-28.md）' };
      if (!/\.(md|markdown|txt)$/i.test(fileName)) fileName += '.md';
      if (/[\\/:*?"<>|]/.test(fileName)) return { success: false, error: '文件名不能包含 \\ / : * ? " < > |' };
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const { file, error } = weeklyResolve(dir, fileName);
      if (error) return { success: false, error };
      fs.writeFileSync(file, String(content == null ? '' : content), 'utf8');
      const st = fs.statSync(file);
      return { success: true, data: { name: fileName, size: st.size, mtime: st.mtime.toISOString() } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 重命名（改日期/文件名） */
  ipcMain.handle('weekly:rename', async (_event, { dir, name, nextName } = {}) => {
    try {
      let target = String(nextName || '').trim();
      if (!target) return { success: false, error: '请填写新的文件名' };
      if (!/\.(md|markdown|txt)$/i.test(target)) target += '.md';
      if (/[\\/:*?"<>|]/.test(target)) return { success: false, error: '文件名不能包含 \\ / : * ? " < > |' };
      const a = weeklyResolve(dir, name);
      const b = weeklyResolve(dir, target);
      if (a.error) return { success: false, error: a.error };
      if (b.error) return { success: false, error: b.error };
      if (!fs.existsSync(a.file)) return { success: false, error: '原文件不存在' };
      if (a.file !== b.file && fs.existsSync(b.file)) return { success: false, error: '同名文件已存在' };
      fs.renameSync(a.file, b.file);
      return { success: true, data: { name: target } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 删除：走系统回收站，误删可从回收站找回 */
  ipcMain.handle('weekly:delete', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = weeklyResolve(dir, name);
      if (error) return { success: false, error };
      if (!fs.existsSync(file)) return { success: false, error: '文件已不存在' };
      await shell.trashItem(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- 测试笔记（可选：存到自己选的目录里，一篇一个 .md） ----
  const NOTE_EXTS = ['.md', '.markdown', '.txt'];

  const notesResolve = (dir, name) => {
    const root = path.resolve(String(dir || ''));
    const file = path.resolve(root, String(name || ''));
    if (!file.startsWith(root + path.sep) && file !== root) return { error: '非法文件路径' };
    return { file };
  };

  /** 文件名安全化：去掉非法字符，保证 .md 结尾，且不与已有文件重名 */
  const notesFileName = (title, dir) => {
    let base = String(title || '').trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!base) base = '未命名笔记';
    if (!/\.(md|markdown|txt)$/i.test(base)) base += '.md';
    if (!dir) return base;
    let name = base;
    let i = 2;
    while (fs.existsSync(path.join(dir, name))) {
      const dot = base.lastIndexOf('.');
      name = `${base.slice(0, dot)}-${i}${base.slice(dot)}`;
      i += 1;
    }
    return name;
  };

  ipcMain.handle('notes:list', async (_event, { dir } = {}) => {
    try {
      if (!dir) return { success: false, error: '未指定笔记目录' };
      if (!fs.existsSync(dir)) return { success: false, error: `目录不存在：${dir}` };
      if (!fs.statSync(dir).isDirectory()) return { success: false, error: `不是目录：${dir}` };
      const files = fs.readdirSync(dir)
        .filter(n => NOTE_EXTS.includes(path.extname(n).toLowerCase()))
        .map(n => {
          const st = fs.statSync(path.join(dir, n));
          return { name: n, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
      return { success: true, data: files };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:read', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = notesResolve(dir, name);
      if (error) return { success: false, error };
      if (!fs.existsSync(file)) return { success: false, error: '文件不存在' };
      const st = fs.statSync(file);
      return {
        success: true,
        data: { name, content: fs.readFileSync(file, 'utf8'), mtime: st.mtime.toISOString(), size: st.size },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:save', async (_event, { dir, name, content, title } = {}) => {
    try {
      if (!dir) return { success: false, error: '未指定笔记目录' };
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 没给文件名时用标题生成；给了就沿用（改名由 rename 处理）
      const fileName = String(name || '').trim() || notesFileName(title, dir);
      const { file, error } = notesResolve(dir, fileName);
      if (error) return { success: false, error };
      fs.writeFileSync(file, String(content == null ? '' : content), 'utf8');
      const st = fs.statSync(file);
      return { success: true, data: { name: fileName, size: st.size, mtime: st.mtime.toISOString() } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:rename', async (_event, { dir, name, nextName } = {}) => {
    try {
      let target = String(nextName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
      if (!target) return { success: false, error: '请填写文件名' };
      if (!/\.(md|markdown|txt)$/i.test(target)) target += '.md';
      const a = notesResolve(dir, name);
      const b = notesResolve(dir, target);
      if (a.error) return { success: false, error: a.error };
      if (b.error) return { success: false, error: b.error };
      if (!fs.existsSync(a.file)) return { success: false, error: '原文件不存在' };
      if (a.file !== b.file && fs.existsSync(b.file)) return { success: false, error: '同名文件已存在' };
      fs.renameSync(a.file, b.file);
      return { success: true, data: { name: target } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:delete', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = notesResolve(dir, name);
      if (error) return { success: false, error };
      if (!fs.existsSync(file)) return { success: false, error: '文件已不存在' };
      await shell.trashItem(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择存放测试笔记的目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, data: null };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 在资源管理器里打开（打开目录 / 定位某个文件） */
  ipcMain.handle('notes:reveal', async (_event, { dir, name } = {}) => {
    try {
      if (name) {
        const { file, error } = notesResolve(dir, name);
        if (error) return { success: false, error };
        shell.showItemInFolder(file);
      } else if (dir && fs.existsSync(dir)) {
        shell.openPath(dir);
      }
      return { success: true };
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
        } else if (ext === '.csv') {
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
      return { success: true, data: normalizeImportRecords(records) };
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

  // ---- File dialogs ----
  ipcMain.handle('dialog:open-file', async (_event, { filters }) => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
  });

  ipcMain.handle('dialog:save-file', async (_event, { defaultName, filters }) => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled) return { canceled: true };
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('file:write', (_event, { filePath, content, encoding }) => {
    try {
      if (encoding === 'base64') {
        const buf = Buffer.from(content, 'base64');
        fs.writeFileSync(filePath, buf);
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- App info ----
  ipcMain.handle('app:get-path', (_event, name) => {
    return app.getPath(name);
  });

  // ---- Browser ----
  const KNOWN_BROWSERS = [
    { id: 'chrome', name: 'Chrome', paths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]},
    { id: 'msedge', name: 'Edge', paths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]},
    { id: 'firefox', name: 'Firefox', paths: [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    ]},
    { id: 'brave', name: 'Brave', paths: [
      path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]},
    { id: 'opera', name: 'Opera', paths: [
      path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera\\opera.exe'),
      'C:\\Program Files\\Opera\\opera.exe',
    ]},
    { id: 'vivaldi', name: 'Vivaldi', paths: [
      path.join(process.env.LOCALAPPDATA || '', 'Vivaldi\\Application\\vivaldi.exe'),
      'C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe',
    ]},
    { id: '360', name: '360 浏览器', paths: [
      'C:\\Program Files\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
      'C:\\Program Files (x86)\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', '360\\360Chrome\\Chrome\\Application\\360chrome.exe'),
    ]},
    { id: 'qq', name: 'QQ 浏览器', paths: [
      'C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe',
      'C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Tencent\\QQBrowser\\QQBrowser.exe'),
    ]},
    { id: 'quark', name: '夸克', paths: [
      path.join(process.env.LOCALAPPDATA || '', 'Quark\\Quark\\Application\\quark.exe'),
      'C:\\Program Files\\Quark\\Quark\\Application\\quark.exe',
      'C:\\Program Files (x86)\\Quark\\Quark\\Application\\quark.exe',
    ]},
  ];

  function findBrowser(id, configuredPath) {
    if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
    const info = KNOWN_BROWSERS.find(b => b.id === id);
    if (!info) return null;
    for (const p of info.paths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  ipcMain.handle('browser:detect', async () => {
    const settings = loadSettings();
    const paths = (settings && settings.browserPaths) || {};
    const browsers = [{ id: 'default', name: '默认浏览器' }];
    for (const b of KNOWN_BROWSERS) {
      if (findBrowser(b.id, paths[b.id])) browsers.push({ id: b.id, name: b.name });
    }
    return browsers;
  });

  ipcMain.handle('browser:get-known', async () => {
    return KNOWN_BROWSERS.map(b => ({ id: b.id, name: b.name }));
  });

  ipcMain.handle('browser:open', async (_event, { browser, url }) => {
    try {
      if (!url || !url.trim()) return { success: false, error: 'URL 为空' };
      let trimmedUrl = url.trim();
      // Auto-prepend https:// if no protocol specified
      if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmedUrl)) {
        trimmedUrl = 'https://' + trimmedUrl;
      }

      if (browser === 'default') {
        await shell.openExternal(trimmedUrl);
      } else {
        const settings = loadSettings();
        const paths = (settings && settings.browserPaths) || {};
        const configuredPath = paths[browser] || '';
        const exePath = findBrowser(browser, configuredPath);
        if (exePath) {
          await new Promise((resolve, reject) => {
            const child = spawn(exePath, [trimmedUrl], { shell: false, detached: true, stdio: 'ignore' });
            child.on('error', () => {
              // If spawn fails (e.g. exe not found), fall back to default browser
              shell.openExternal(trimmedUrl).then(resolve).catch(reject);
            });
            child.on('close', (code) => {
              if (code === 0) resolve();
              else resolve(); // Browser may exit with non-zero even on success, still consider it ok
            });
            child.unref();
          });
        } else {
          await shell.openExternal(trimmedUrl);
        }
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  // ---- Test Data Generator IPC handlers ----
  ipcMain.handle('dialog:saveFile', async (_event, { defaultName, filters }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('fs:writeFile', async (_event, { filePath, content, encoding }) => {
    try {
      fs.writeFileSync(filePath, content, encoding || 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // IPC handler for renderer to get the TDG paths
  ipcMain.handle('tdg:get-path', () => {
    return {
      distPath: TDG_DIST_PATH,
      preloadPath: TDG_PRELOAD_PATH,
    };
  });
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

  // Global shortcut: Ctrl+Shift+P or Cmd+Shift+P to show/hide the window
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
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
