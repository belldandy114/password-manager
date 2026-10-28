const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Auth
  authIsSetup: () => ipcRenderer.invoke('auth:is-setup'),
  authSetup: (data) => ipcRenderer.invoke('auth:setup', data),
  authVerify: (data) => ipcRenderer.invoke('auth:verify', data),
  authGetHint: () => ipcRenderer.invoke('auth:get-hint'),
  authChangePassword: (data) => ipcRenderer.invoke('auth:change-password', data),
  authSetSecurityWord: (data) => ipcRenderer.invoke('auth:set-security-word', data),
  authVerifySecurityWord: (data) => ipcRenderer.invoke('auth:verify-security-word', data),
  authHasSecurityWord: () => ipcRenderer.invoke('auth:has-security-word'),
  authResetPassword: (data) => ipcRenderer.invoke('auth:reset-password', data),

  // Session
  sessionUnlock: (data) => ipcRenderer.invoke('session:unlock', data),
  sessionLock: () => ipcRenderer.invoke('session:lock'),
  sessionIsUnlocked: () => ipcRenderer.invoke('session:is-unlocked'),
  sessionTouch: () => ipcRenderer.invoke('session:touch'),

  // Entries
  entriesGetAll: () => ipcRenderer.invoke('entries:get-all'),
  entriesAdd: (data) => ipcRenderer.invoke('entries:add', data),
  entriesUpdate: (data) => ipcRenderer.invoke('entries:update', data),
  entriesDelete: (data) => ipcRenderer.invoke('entries:delete', data),
  entriesBatchUpdate: (data) => ipcRenderer.invoke('entries:batch-update', data),

  // Trash
  trashGetAll: () => ipcRenderer.invoke('trash:get-all'),
  trashRestore: (data) => ipcRenderer.invoke('trash:restore', data),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),

  // Clipboard
  clipboardCopy: (data) => ipcRenderer.invoke('clipboard:copy', data),
  clipboardClear: () => ipcRenderer.invoke('clipboard:clear'),
  onClipboardCleared: (cb) => {
    ipcRenderer.on('clipboard-cleared', () => cb());
    return () => ipcRenderer.removeAllListeners('clipboard-cleared');
  },

  // Tray menu → "锁定"
  onLockRequest: (cb) => {
    ipcRenderer.on('lock-request', () => cb());
    return () => ipcRenderer.removeAllListeners('lock-request');
  },

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (data) => ipcRenderer.invoke('settings:save', data),

  // Password generator
  passwordGenerate: (opts) => ipcRenderer.invoke('password:generate', opts),

  // Backups
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupOpenFolder: () => ipcRenderer.invoke('backup:open-folder'),

  // Generic collection storage (snippets / notes / checklists / accounts / environments / apiRequests)
  wsGet: (key) => ipcRenderer.invoke('ws:get', key),
  wsSet: (key, value) => ipcRenderer.invoke('ws:set', { key, value }),

  // Password history
  historyGet: (entryId) => ipcRenderer.invoke('history:get', entryId),

  // TOTP
  totpCode: (data) => ipcRenderer.invoke('totp:code', data),

  // Attachments
  attachmentPick: () => ipcRenderer.invoke('attachment:pick'),
  attachmentOpen: (data) => ipcRenderer.invoke('attachment:open', data),
  attachmentDelete: (data) => ipcRenderer.invoke('attachment:delete', data),

  // API debugger / Zentao
  apiSend: (data) => ipcRenderer.invoke('api:send', data),
  zentaoLogin: (cfg) => ipcRenderer.invoke('zentao:login', cfg),
  zentaoMyBugs: (cfg) => ipcRenderer.invoke('zentao:my-bugs', cfg),
  zentaoProjects: (cfg) => ipcRenderer.invoke('zentao:projects', cfg),
  zentaoProjectBugs: (cfg, productId) => ipcRenderer.invoke('zentao:project-bugs', { cfg, productId }),
  zentaoAllBugs: (cfg) => ipcRenderer.invoke('zentao:all-bugs', cfg),
  zentaoBugDetail: (cfg, bugId) => ipcRenderer.invoke('zentao:bug-detail', { cfg, bugId }),
  zentaoNotifyNow: () => ipcRenderer.invoke('zentao:notify-now'),
  onZentaoOpen: (cb) => {
    const h = () => cb();
    ipcRenderer.on('zentao:open', h);
    return () => ipcRenderer.removeListener('zentao:open', h);
  },

  // 周报（本地 Markdown 目录）
  weeklyList: (dir) => ipcRenderer.invoke('weekly:list', { dir }),
  weeklyRead: (dir, name) => ipcRenderer.invoke('weekly:read', { dir, name }),
  weeklyPickDir: () => ipcRenderer.invoke('weekly:pick-dir'),
  weeklyReveal: (dir, name) => ipcRenderer.invoke('weekly:reveal', { dir, name }),
  weeklySave: (dir, name, content) => ipcRenderer.invoke('weekly:save', { dir, name, content }),
  weeklyRename: (dir, name, nextName) => ipcRenderer.invoke('weekly:rename', { dir, name, nextName }),
  weeklyDelete: (dir, name) => ipcRenderer.invoke('weekly:delete', { dir, name }),

  // Update check
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (url, useMirror) => ipcRenderer.invoke('update:download', { url, useMirror }),
  updatePickFile: () => ipcRenderer.invoke('update:pick-file'),
  updateInstall: (file) => ipcRenderer.invoke('update:install', { file }),
  onUpdateProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('update:progress', h);
    return () => ipcRenderer.removeListener('update:progress', h);
  },

  // Import/Export
  importCsvJson: (data) => ipcRenderer.invoke('import:csv-json', data),
  importEncrypted: (data) => ipcRenderer.invoke('import:encrypted', data),
  importConfirm: (data) => ipcRenderer.invoke('import:confirm', data),
  importDownloadTemplate: () => ipcRenderer.invoke('import:download-template'),
  exportEncrypted: (data) => ipcRenderer.invoke('export:encrypted', data),
  exportPlain: (data) => ipcRenderer.invoke('export:plain', data),
  exportSelectedEncrypted: (data) => ipcRenderer.invoke('export:selected-encrypted', data),
  exportSelectedPlain: (data) => ipcRenderer.invoke('export:selected-plain', data),

  // File dialogs
  dialogOpenFile: (data) => ipcRenderer.invoke('dialog:open-file', data),
  dialogSaveFile: (data) => ipcRenderer.invoke('dialog:save-file', data),
  fileWrite: (data) => ipcRenderer.invoke('file:write', data),

  // App
  appGetPath: (name) => ipcRenderer.invoke('app:get-path', name),

  // Browser
  browserDetect: () => ipcRenderer.invoke('browser:detect'),
  browserGetKnown: () => ipcRenderer.invoke('browser:get-known'),
  browserOpen: (data) => ipcRenderer.invoke('browser:open', data),

  // Test Data Generator sub-app
  tdgGetPath: () => ipcRenderer.invoke('tdg:get-path'),
});
