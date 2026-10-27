const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Menu, shell, dialog, globalShortcut, protocol, Tray, screen } = require('electron');
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
const DATA_DIR = app.getPath('userData');
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
function loadVault(password) {
  if (vaultCache.password === password && vaultCache.data) return vaultCache.data;
  let result;
  if (!fs.existsSync(DATA_FILE)) {
    result = normalizeVault(null);
  } else {
    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
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
const BACKUP_KEEP = 7;

function backupVaultOncePerDay() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const day = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `vault-${day}.enc`);
    if (fs.existsSync(target)) return; // already backed up today
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DATA_FILE, target);

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
      .sort();
    while (files.length > BACKUP_KEEP) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch { /* ignore */ }
    }
  } catch { /* a failed backup must never block the save path */ }
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
  fs.writeFileSync(DATA_FILE, encrypted, 'utf8');
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
    const raw = fs.readFileSync(BIN_FILE, 'utf8').trim();
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
  fs.writeFileSync(BIN_FILE, encrypted, 'utf8');
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

  if (IS_DEV) {
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

  mainWindow.once('ready-to-show', () => mainWindow.show());
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
// Import helpers: CSV parsing + field normalisation
// ----------------------------------------------------------------
// RFC 4180 parser: quoted fields, "" as an escaped quote, commas and newlines inside
// quotes. The previous implementation used split(',') which silently mangled any
// password containing a comma or quote.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^\uFEFF/, '');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// Column aliases: exports use Chinese headers, JSON backups use the internal names.
// Also covers Chrome / Edge (`name,url,username,password,note`), Bitwarden
// (`folder,favorite,type,name,login_uri,login_username,login_password,login_totp`)
// and 1Password (`Title,Url,Username,Password,OTPAuth,...`) exports.
const IMPORT_FIELD_ALIASES = {
  name: ['name', '名称', '标题', 'title'],
  url: ['url', '网址', '地址', '链接', 'link', 'login_uri', 'website'],
  username: ['username', '账号', '用户名', '账户', 'user', 'account', 'login', 'login_username'],
  password: ['password', '密码', 'pwd', 'pass', 'login_password'],
  notes: ['notes', '备注', '说明', 'note', 'remark', 'comment'],
  tags: ['tags', '标签', 'tag', 'folder'],
  envType: ['envtype', '环境类型', '环境', 'env'],
  totp: ['totp', 'login_totp', 'otpauth', 'otp'],
  favorite: ['favorite', 'starred'],
  createdAt: ['createdat', '创建时间'],
  updatedAt: ['updatedat', '修改时间'],
};

/** 从 otpauth:// 链接或纯密钥里取出 Base32 secret */
function extractTotpSecret(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const m = value.match(/[?&]secret=([A-Za-z2-7]+)/i);
  if (m) return m[1].toUpperCase();
  if (/^[A-Za-z2-7\s]{16,}$/.test(value)) return value.replace(/\s/g, '').toUpperCase();
  return '';
}

const ENV_ALIASES = {
  production: 'production', prod: 'production', '正式': 'production', '生产': 'production',
  testing: 'testing', test: 'testing', '测试': 'testing',
  development: 'development', dev: 'development', '开发': 'development',
  staging: 'staging', '预发布': 'staging', '预发': 'staging',
};

function normalizeImportRecords(records) {
  if (!Array.isArray(records)) return [];

  // Excel writes dates as serial numbers (days since 1899-12-30); CSV users type text.
  const toIso = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const raw = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) > 20000 && Number(raw) < 100000) {
      const ms = Date.UTC(1899, 11, 30) + Number(raw) * 86400000;
      return new Date(ms).toISOString();
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  };

  return records.map(raw => {
    if (!raw || typeof raw !== 'object') return null;
    const flat = {};
    for (const [k, v] of Object.entries(raw)) {
      flat[String(k).trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
    }
    const pick = (key) => {
      for (const alias of IMPORT_FIELD_ALIASES[key]) {
        const v = flat[alias];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };

    const tagsRaw = flat.tags !== undefined ? String(flat.tags) : pick('tags');
    const tags = tagsRaw
      ? tagsRaw.split(/[;,、|]/).map(t => t.trim()).filter(Boolean)
      : [];

    const envRaw = pick('envType');
    const envType = envRaw ? (ENV_ALIASES[envRaw.toLowerCase()] || ENV_ALIASES[envRaw] || envRaw) : 'production';

    const name = pick('name');
    const url = pick('url');
    if (!name && !url) return null;

    return {
      // Keep original ids/timestamps when re-importing an exported JSON file.
      ...(raw.id ? { id: String(raw.id) } : {}),
      name,
      url,
      username: pick('username'),
      password: pick('password'),
      notes: pick('notes'),
      envType,
      tags,
      ...(extractTotpSecret(pick('totp')) ? { totpSecret: extractTotpSecret(pick('totp')) } : {}),
      ...(/^(true|1|yes|是)$/i.test(pick('favorite')) ? { favorite: true } : {}),
      ...(toIso(pick('createdAt')) ? { createdAt: toIso(pick('createdAt')) } : {}),
      ...(toIso(pick('updatedAt')) ? { updatedAt: toIso(pick('updatedAt')) } : {}),
    };
  }).filter(Boolean);
}

// ----------------------------------------------------------------
// Vault shape (1.2.0 expanded from { entries, tags })
// ----------------------------------------------------------------
// 新增模块（SQL 片段 / 笔记 / 检查清单 / 账号池 / 环境总览 / 接口调试）都放在同一个
// 加密文件里，随密码库一起加密，不额外增加新的密码。旧数据缺少这些字段时补空数组。
const VAULT_COLLECTIONS = ['snippets', 'notes', 'checklists', 'accounts', 'environments', 'apiRequests', 'integrations'];

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
    if (!vault) return { success: false, error: '数据损坏，无法解密' };
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
    return { success: true, data: vault };
  });

  ipcMain.handle('session:lock', () => {
    currentPassword = null;
    clearCaches();
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
        app.setLoginItemSettings({ openAtLogin: !!prefs.launchAtLogin, args: [] });
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
  ipcMain.handle('backup:list', () => ({ success: true, data: listBackups(), dir: BACKUP_DIR }));
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
          notes: (json.body || '').slice(0, 2000),
        },
      };
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
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
  ipcMain.handle('api:send', async (_event, { method = 'GET', url, headers = '', body = '' }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { success: false, error: 'URL 必须以 http:// 或 https:// 开头' };
    }
    const started = Date.now();
    try {
      const hdrs = {};
      String(headers || '').split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) hdrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      const init = { method: method.toUpperCase(), headers: hdrs };
      if (!['GET', 'HEAD'].includes(init.method) && body) init.body = body;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      init.signal = controller.signal;

      const res = await fetch(url, init);
      clearTimeout(timer);
      const text = await res.text();
      const resHeaders = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      return {
        success: true,
        data: {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
          body: text.length > 500000 ? text.slice(0, 500000) + '\n...（响应过大，已截断）' : text,
          size: Buffer.byteLength(text),
          timeMs: Date.now() - started,
        },
      };
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '请求超时（30 秒）' : e.message };
    }
  });

  // ---- Zentao (禅道) ----
  // 登录采用禅道标准的「随机盐」流程：GET refreshRandom 拿 rand，
  // password = md5(md5(明文) + rand)。会话 cookie 保存在内存里。
  let zentaoCookie = '';

  async function zentaoRequest(cfg, pathAndQuery, options = {}) {
    const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
    const url = `${base}/index.php?${pathAndQuery}`;
    const headers = { ...(options.headers || {}) };
    if (zentaoCookie) headers.Cookie = zentaoCookie;
    const res = await fetch(url, { ...options, headers, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length) {
      const sid = setCookie.map(c => c.split(';')[0]).find(c => /zentaosid/i.test(c));
      if (sid) zentaoCookie = sid;
    }
    const text = await res.text();
    return { status: res.status, text };
  }

  ipcMain.handle('zentao:login', async (_event, cfg) => {
    if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
      return { success: false, error: '请先填写地址、账号和密码' };
    }
    zentaoCookie = '';
    try {
      // 1) 建立会话
      await zentaoRequest(cfg, 'm=user&f=login');
      // 2) 取随机盐（部分版本无此接口，失败则退回明文 md5）
      let rand = '';
      try {
        const r = await zentaoRequest(cfg, 'm=user&f=refreshRandom');
        const parsed = JSON.parse(r.text);
        rand = String(parsed.rand || parsed.data || '');
      } catch { /* 忽略，走无盐流程 */ }

      const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
      const hashed = rand ? md5(md5(cfg.password) + rand) : md5(cfg.password);
      const form = new URLSearchParams({
        account: cfg.account,
        password: hashed,
        passwordStrength: '1',
        referer: '/',
        keepLogin: '1',
      });
      const res = await zentaoRequest(cfg, 'm=user&f=login&t=json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      let ok = false;
      let message = '';
      try {
        const json = JSON.parse(res.text);
        ok = json.status === 'success' || json.result === 'success';
        message = json.message || json.reason || '';
      } catch {
        ok = /我的地盘|my-bug|退出|logout/i.test(res.text);
      }
      if (!ok) return { success: false, error: message || `登录失败（HTTP ${res.status}），请检查账号密码或地址` };
      return { success: true, data: { cookie: true } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('zentao:my-bugs', async (_event, cfg) => {
    if (!zentaoCookie) return { success: false, error: '尚未登录禅道' };
    try {
      // 先试 JSON 接口（禅道 18+），失败再解析 HTML 表格
      let list = [];
      try {
        const r = await zentaoRequest(cfg, 'm=my&f=bug&t=json&type=assignedTo&orderBy=id_desc&recPerPage=100');
        const json = JSON.parse(r.text);
        const rows = json.data || json.bugs || json.bugList;
        if (Array.isArray(rows)) {
          list = rows.map(b => ({
            id: b.id, title: b.title || b.name, status: b.status, severity: b.severity,
            pri: b.pri, assignedTo: b.assignedTo, openedBy: b.openedBy,
            product: b.productName || b.product, date: b.openedDate || b.date,
          }));
        }
      } catch { /* 走 HTML 解析 */ }

      if (list.length === 0) {
        const r = await zentaoRequest(cfg, 'm=my&f=bug&type=assignedTo&orderBy=id_desc&recPerPage=100');
        const re = /<tr[^>]*data-id="(\d+)"[\s\S]*?<\/tr>/g;
        const rows = r.text.match(re) || [];
        for (const row of rows) {
          const id = (row.match(/data-id="(\d+)"/) || [])[1];
          const title = ((row.match(/class="text-left"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '')
            .replace(/<[^>]+>/g, '').trim();
          if (id && title) list.push({ id, title, status: '', severity: '', pri: '', date: '' });
        }
      }
      return { success: true, data: list.slice(0, 200) };
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

    const existingUrls = new Map();
    vault.entries.forEach(e => existingUrls.set(e.url, e));

    const now = new Date().toISOString();
    let importedCount = 0;

    entries.forEach(entry => {
      const existing = existingUrls.get(entry.url);
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
