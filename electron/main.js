const { app, BrowserWindow, ipcMain, clipboard, nativeImage, Menu, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const XLSX = require('xlsx');

const IS_DEV = !app.isPackaged;

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
// Key derivation
// ----------------------------------------------------------------
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, KEY_ITERATIONS, KEY_LENGTH, 'sha512');
}

// ----------------------------------------------------------------
// Encryption / Decryption (AES-256-GCM)
// ----------------------------------------------------------------
function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
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
    const key = deriveKey(password, salt);
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
  if (!fs.existsSync(DATA_FILE)) return { entries: [], tags: [] };
  const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
  if (!raw) return { entries: [], tags: [] };
  const json = decrypt(raw, password);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function saveVault(vault, password) {
  const json = JSON.stringify(vault);
  const encrypted = encrypt(json, password);
  fs.writeFileSync(DATA_FILE, encrypted, 'utf8');
}

// ----------------------------------------------------------------
// Trash (recycle bin) I/O
// ----------------------------------------------------------------
function loadTrash(password) {
  if (!fs.existsSync(BIN_FILE)) return [];
  const raw = fs.readFileSync(BIN_FILE, 'utf8').trim();
  if (!raw) return [];
  const json = decrypt(raw, password);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function saveTrash(trash, password) {
  const json = JSON.stringify(trash);
  const encrypted = encrypt(json, password);
  fs.writeFileSync(BIN_FILE, encrypted, 'utf8');
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

// ----------------------------------------------------------------
// Window
// ----------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  // Remove default menu bar (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);

  const appIcon = nativeImage.createFromPath(
    IS_DEV
      ? path.join(__dirname, '..', 'buildResources', 'icon.ico')
      : path.join(process.resourcesPath, 'app.asar.unpacked', 'buildResources', 'icon.ico')
  );

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon: appIcon,
    show: false
  });

  if (IS_DEV) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

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
// IPC Handlers
// ----------------------------------------------------------------
function setupIpcHandlers() {

  // ---- Master password ----
  ipcMain.handle('auth:is-setup', () => {
    const settings = loadSettings();
    return !!(settings && settings.masterPasswordHash);
  });

  ipcMain.handle('auth:setup', (_event, { password, hint }) => {
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
    const settings = loadSettings();
    if (!settings) return { success: false, error: '未初始化' };
    const hash = crypto.pbkdf2Sync(password, settings.salt, KEY_ITERATIONS, 64, 'sha512').toString('hex');
    if (hash !== settings.masterPasswordHash) return { success: false, error: '密码错误' };
    // Verify we can decrypt the vault
    const vault = loadVault(password);
    if (!vault) return { success: false, error: '数据损坏，无法解密' };
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
    return { success: true };
  });

  // ---- Entries ----
  let currentPassword = null;
  let lastActivity = Date.now();

  ipcMain.handle('session:unlock', (_event, { password }) => {
    const vault = loadVault(password);
    if (!vault) return { success: false };
    currentPassword = password;
    lastActivity = Date.now();
    return { success: true, data: vault };
  });

  ipcMain.handle('session:lock', () => {
    currentPassword = null;
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
    vault.entries[idx] = entry;
    // Update tags list
    if (entry.tags) {
      entry.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
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
    const s = loadSettings();
    if (!s) return {};
    return {
      clipboardClearDelay: s.clipboardClearDelay || 30,
      passwordAutoHideDelay: s.passwordAutoHideDelay || 10,
      autoLockDelay: s.autoLockDelay || 5,
      defaultViewMode: s.defaultViewMode || 'card',
      defaultEnvFilter: s.defaultEnvFilter || 'all',
      theme: s.theme || 'dark',
      browserPaths: s.browserPaths || { chrome: '', msedge: '', firefox: '', brave: '', opera: '', vivaldi: '', '360': '', qq: '', quark: '' },
      keybindings: s.keybindings || {
        newEntry: 'Ctrl+N',
        search: 'Ctrl+F',
        settings: 'Ctrl+,',
        lock: 'Ctrl+Shift+L',
        trash: 'Ctrl+Shift+T',
        import: 'Ctrl+Shift+I',
        export: 'Ctrl+Shift+E',
      },
    };
  });

  ipcMain.handle('settings:save', (_event, prefs) => {
    const s = loadSettings() || {};
    Object.assign(s, prefs);
    saveSettings(s);
    return { success: true };
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
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        records = json.map((row) => {
          const obj = {};
          Object.keys(row).forEach(k => { obj[k.toLowerCase()] = String(row[k]); });
          return obj;
        });
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        if (ext === '.json') {
          records = JSON.parse(content);
          if (!Array.isArray(records)) records = [records];
        } else if (ext === '.csv') {
          const lines = content.split('\n').filter(l => l.trim());
          if (lines.length < 2) return { success: false, error: 'CSV文件格式无效' };
          const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
          for (let i = 1; i < lines.length; i++) {
            const vals = lines[i].split(',').map(v => v.trim());
            const obj = {};
            headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
            records.push(obj);
          }
        } else if (ext === '.html' || ext === '.htm') {
          const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
          let match;
          while ((match = linkRegex.exec(content)) !== null) {
            const url = match[1];
            const name = match[2].trim();
            if (url && !url.startsWith('javascript:') && !url.startsWith('place:')) {
              records.push({ name, url, username: '', password: '', notes: '', envType: 'production', tags: [] });
            }
          }
        }
      }
      return { success: true, data: records };
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
}

// ----------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------
app.whenReady().then(() => {
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
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // Global shortcut: Ctrl+Shift+P or Cmd+Shift+P to show/hide the window
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  for (const k of Object.keys(clipboardTimers)) clearTimeout(clipboardTimers[k]);
  clipboard.clear();
  if (process.platform !== 'darwin') app.quit();
});

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function sortByDateDesc(arr) {
  return arr.sort((a, b) => new Date(b.deletedAt || b.createdAt) - new Date(a.deletedAt || a.createdAt));
}
