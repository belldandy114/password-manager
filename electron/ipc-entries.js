'use strict';
/**
 * 会话 / 条目 / 回收站 / 剪贴板 / 用户设置 IPC。
 *
 * 这些 handler 原本写在 setupIpcHandlers() 里，直接读写 currentPassword、vaultEpoch、
 * clipboardTimers 等模块级状态。搬出来时一律走依赖注入：**状态仍然留在 main.js**，
 * 本模块只做「读 → 改 → 存盘」的流程，避免出现 ipc-files.js 那种看不到 main 变量、
 * 一点按钮就 ReferenceError 的老问题。
 */
const { app, ipcMain, clipboard } = require('electron');

/**
 * @param {object} deps
 * @param {() => string|null} deps.getPassword
 * @param {(pw: string|null) => void} deps.setPassword
 * @param {() => void} deps.bumpEpoch
 * @param {(v: boolean) => void} deps.setUnlocked
 * @param {() => void} deps.touchActivity
 * @param {(pw: string) => any} deps.loadVault
 * @param {(vault: any, pw: string) => void} deps.saveVault
 * @param {(pw: string) => any} deps.loadTrash
 * @param {(trash: any[], pw: string) => void} deps.saveTrash
 * @param {() => void} deps.clearCaches
 * @param {() => void} deps.hideSearchWindow
 * @param {() => void} deps.ztRestartNotify
 * @param {() => void} deps.ztLoadSeen
 * @param {() => void} deps.ztPushUnread
 * @param {() => void} deps.backupVaultOncePerDay
 * @param {() => any} deps.loadSettings
 * @param {(s: any) => void} deps.saveSettings
 * @param {() => any} deps.getWindowPrefs
 * @param {() => void} deps.createTray
 * @param {() => void} deps.destroyTray
 * @param {() => void} deps.restartAutoUpdateCheck
 * @param {() => any} deps.getMainWindow
 * @param {(list: any[]) => any[]} deps.sortByDateDesc
 * @param {number} deps.retentionMs
 * @param {object} deps.defaultSettings
 * @param {(text: string) => void} deps.rememberClipboard
 * @param {(ms: number) => void} deps.clearClipboardAfter
 * @param {() => void} deps.clearClipHistory
 * @param {() => void} deps.wipeClipHistory
 * @param {() => any[]} deps.loadClipHistory
 * @param {() => any[]} deps.getClipHistory
 * @param {() => object} deps.getClipboardTimers
 * @param {() => void} deps.resetClipboardTimers
 * @param {() => void} deps.closePinWindows
 */
function registerEntriesIpc(deps) {
  const {
    getPassword, setPassword, bumpEpoch, setUnlocked, touchActivity,
    loadVault, saveVault, loadTrash, saveTrash,
    clearCaches, hideSearchWindow,
    ztRestartNotify, ztLoadSeen, ztPushUnread, backupVaultOncePerDay,
    loadSettings, saveSettings, getWindowPrefs, createTray, destroyTray,
    restartAutoUpdateCheck, getMainWindow,
    sortByDateDesc, retentionMs, defaultSettings,
    rememberClipboard, clearClipboardAfter, clearClipHistory,
    wipeClipHistory, loadClipHistory,
    getClipHistory, getClipboardTimers, resetClipboardTimers,
    closePinWindows,
  } = deps;

  /** 统一取当前会话密码；未解锁时返回 null（各 handler 据此回「未解锁」） */
  const pw = () => getPassword();

  // ---- Session ----
  ipcMain.handle('session:unlock', (_event, { password }) => {
    clearCaches();
    const vault = loadVault(password);
    if (!vault) return { success: false };
    setPassword(password);
    setUnlocked(true);
    bumpEpoch();   // 搜索小窗的缓存必须失效，否则解锁后还显示「未解锁」
    touchActivity();
    // 解锁后启动禅道新 Bug 提醒（内部会检查开关）
    setTimeout(() => { try { ztRestartNotify(); } catch { /* 提醒失败不影响解锁 */ } }, 0);
    // 侧边栏红点：把上次没看的未读数推给界面
    setTimeout(() => { try { ztLoadSeen(); ztPushUnread(); } catch { /* 忽略 */ } }, 0);
    // 解锁即补一次当日备份：只改密码不改数据的日子也能有快照
    setTimeout(() => { try { backupVaultOncePerDay(); } catch { /* 忽略 */ } }, 400);
    // 剪贴板历史是加密落盘的，解锁后才有主密码可解，这里补读一次
    setTimeout(() => { try { loadClipHistory(); } catch { /* 解不开就当空历史 */ } }, 0);
    return { success: true, data: vault };
  });

  ipcMain.handle('session:lock', () => {
    setPassword(null);
    setUnlocked(false);
    bumpEpoch();   // 锁屏后小窗要立刻切成「未解锁」提示
    clearCaches();
    clearClipHistory();
    try { ztRestartNotify(); } catch { /* 锁定后自动停掉定时器 */ }
    hideSearchWindow();
    // 「钉」出来的小窗里是明文密码，锁屏必须连它们一起关掉
    try { closePinWindows?.(); } catch { /* 忽略 */ }
    return { success: true };
  });

  ipcMain.handle('session:is-unlocked', () => {
    return { unlocked: pw() !== null };
  });

  ipcMain.handle('session:touch', () => {
    touchActivity();
    return { success: true };
  });

  // ---- CRUD ----
  ipcMain.handle('entries:get-all', () => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:add', (_event, entry) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    vault.entries.push(entry);
    // Update tags list
    if (entry.tags) {
      entry.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
    }
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:update', (_event, entry) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
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
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:delete', (_event, { ids, permanent }) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };

    if (permanent) {
      // Permanently delete
      vault.entries = vault.entries.filter(e => !ids.includes(e.id));
    } else {
      // Move to trash
      const trash = loadTrash(pw()) || [];
      const now = new Date().toISOString();
      const toTrash = vault.entries.filter(e => ids.includes(e.id));
      toTrash.forEach(e => { e.deletedAt = now; });
      trash.push(...toTrash);
      saveTrash(trash, pw());
      vault.entries = vault.entries.filter(e => !ids.includes(e.id));
    }
    // Clean up orphaned tags
    const usedTags = new Set(vault.entries.flatMap(e => e.tags || []));
    vault.tags = vault.tags.filter(t => usedTags.has(t));
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:batch-update', (_event, { ids, changes }) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
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
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  // ---- Trash ----
  ipcMain.handle('trash:get-all', () => {
    if (!pw()) return { success: false, error: '未解锁' };
    const trash = loadTrash(pw());
    if (!trash) return { success: false, error: '数据损坏' };
    // Auto-clean expired items
    const now = Date.now();
    const valid = trash.filter(e => {
      return e.deletedAt && (now - new Date(e.deletedAt).getTime() < retentionMs);
    });
    if (valid.length !== trash.length) saveTrash(valid, pw());
    return { success: true, data: sortByDateDesc(valid) };
  });

  ipcMain.handle('trash:restore', (_event, ids) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const trash = loadTrash(pw());
    const vault = loadVault(pw());
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
    saveTrash(remaining, pw());
    saveVault(vault, pw());
    return { success: true, data: { entries: vault.entries, trash: remaining } };
  });

  ipcMain.handle('trash:empty', () => {
    if (!pw()) return { success: false, error: '未解锁' };
    saveTrash([], pw());
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
    data: { enabled: !!(loadSettings() || {}).clipboardHistory, items: getClipHistory().slice() },
  }));

  ipcMain.handle('clipboard:history-clear', () => {
    wipeClipHistory();
    return { success: true };
  });

  ipcMain.handle('clipboard:clear', () => {
    clipboard.clear();
    for (const k of Object.keys(getClipboardTimers())) {
      clearTimeout(getClipboardTimers()[k]);
    }
    resetClipboardTimers();
    return { success: true };
  });

  // ---- Settings (user preferences) ----
  ipcMain.handle('settings:get', () => {
    const s = loadSettings() || {};
    return {
      clipboardClearDelay: s.clipboardClearDelay || defaultSettings.clipboardClearDelay,
      passwordAutoHideDelay: s.passwordAutoHideDelay || defaultSettings.passwordAutoHideDelay,
      autoLockDelay: s.autoLockDelay || defaultSettings.autoLockDelay,
      defaultViewMode: s.defaultViewMode || defaultSettings.defaultViewMode,
      defaultEnvFilter: s.defaultEnvFilter || defaultSettings.defaultEnvFilter,
      theme: s.theme || defaultSettings.theme,
      accent: s.accent || defaultSettings.accent,
      density: s.density || defaultSettings.density,
      minimizeToTray: !!s.minimizeToTray,
      closeToTray: !!s.closeToTray,
      contentProtection: !!s.contentProtection,
      launchAtLogin: !!s.launchAtLogin,
      lastPage: s.lastPage || defaultSettings.lastPage,
      zentaoNotify: !!s.zentaoNotify,
      zentaoNotifyInterval: Number(s.zentaoNotifyInterval) || defaultSettings.zentaoNotifyInterval,
      zentaoStaleOn: !!s.zentaoStaleOn,
      zentaoStaleDays: Math.max(1, Math.min(60, Number(s.zentaoStaleDays) || defaultSettings.zentaoStaleDays)),
      // 多套禅道配置里「当前用哪套」：主进程的定时提醒也要跟着它走
      zentaoActiveId: String(s.zentaoActiveId || 'zentao'),
      backupKeep: Math.min(60, Math.max(1, Number(s.backupKeep) || defaultSettings.backupKeep)),
      // 更新源与检查周期：设置页要能读回当前值，否则保存时会把已有值覆盖掉
      updateMirrorUrl: String(s.updateMirrorUrl || ''),
      updateCheckIntervalHours: Math.min(168, Math.max(0, Number(s.updateCheckIntervalHours) || 0)),
      browserPaths: s.browserPaths || { ...defaultSettings.browserPaths },
      keybindings: s.keybindings || { ...defaultSettings.keybindings },
    };
  });

  ipcMain.handle('settings:save', (_event, prefs) => {
    const s = loadSettings() || {};
    Object.assign(s, prefs);
    saveSettings(s);
    // Keep the tray icon in sync: create it as soon as a tray behaviour is enabled,
    // remove it when both are off so the user is not left with a stray icon.
    if (prefs && (Object.prototype.hasOwnProperty.call(prefs, 'zentaoNotify')
      || Object.prototype.hasOwnProperty.call(prefs, 'zentaoNotifyInterval')
      // 只开「超期提醒」也要把定时器拉起来，否则勾了等于没勾
      || Object.prototype.hasOwnProperty.call(prefs, 'zentaoStaleOn'))) {
      try { ztRestartNotify(); } catch { /* 忽略 */ }
    }
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'updateCheckIntervalHours')) {
      try { restartAutoUpdateCheck(); } catch { /* 忽略 */ }
    }

    const p = getWindowPrefs();
    if (p.minimizeToTray || p.closeToTray) createTray();
    else {
      // Only tear the tray down if the window is visible — otherwise the app would
      // become unreachable while hidden.
      const win = getMainWindow();
      if (win && !win.isDestroyed() && win.isVisible()) destroyTray();
    }

    // Privacy: exclude the window from screenshots / screen recordings.
    const win = getMainWindow();
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'contentProtection')
      && win && !win.isDestroyed()) {
      win.setContentProtection(!!prefs.contentProtection);
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
}

module.exports = { registerEntriesIpc };