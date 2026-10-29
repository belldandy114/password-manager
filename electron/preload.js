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
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  backupMirrorPick: () => ipcRenderer.invoke('backup:mirror-pick'),
  auditLog: (action, detail) => ipcRenderer.invoke('audit:log', { action, detail }),
  auditList: (limit) => ipcRenderer.invoke('audit:list', limit),
  auditClear: () => ipcRenderer.invoke('audit:clear'),
  backupOpenFolder: () => ipcRenderer.invoke('backup:open-folder'),
  backupRestore: (name) => ipcRenderer.invoke('backup:restore', { name }),

  // 数据目录（可见 / 打开 / 迁移）
  dataInfo: () => ipcRenderer.invoke('data:info'),
  dataOpenFolder: (which) => ipcRenderer.invoke('data:open-folder', { which }),
  dataMigrate: () => ipcRenderer.invoke('data:migrate'),
  dataResetLocation: () => ipcRenderer.invoke('data:reset-location'),

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
  apiCookies: (origin) => ipcRenderer.invoke('api:cookies', { origin }),
  apiCookiesClear: (origin) => ipcRenderer.invoke('api:cookies-clear', { origin }),
  zentaoLogin: (cfg) => ipcRenderer.invoke('zentao:login', cfg),
  zentaoMyBugs: (cfg, scope, productIds) => ipcRenderer.invoke('zentao:my-bugs', cfg, scope, productIds),
  zentaoProjects: (cfg) => ipcRenderer.invoke('zentao:projects', cfg),
  zentaoProjectBugs: (cfg, productId) => ipcRenderer.invoke('zentao:project-bugs', { cfg, productId }),
  zentaoAllBugs: (cfg, force) => ipcRenderer.invoke('zentao:all-bugs', cfg, { force: !!force }),
  zentaoBugDetail: (cfg, bugId) => ipcRenderer.invoke('zentao:bug-detail', { cfg, bugId }),
  zentaoAttachment: (cfg, url, name, mode) => ipcRenderer.invoke('zentao:attachment', { cfg, url, name, mode }),
  zentaoNotifyNow: () => ipcRenderer.invoke('zentao:notify-now'),
  zentaoNotifyStatus: () => ipcRenderer.invoke('zentao:notify-status'),
  zentaoUnread: () => ipcRenderer.invoke('zentao:unread'),
  zentaoUnreadClear: () => ipcRenderer.invoke('zentao:unread-clear'),
  onZentaoUnread: (cb) => {
    const h = (_e, n) => cb(n);
    ipcRenderer.on('zentao:unread', h);
    return () => ipcRenderer.removeListener('zentao:unread', h);
  },
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

  // 测试笔记（可选：存到自己选的目录）
  notesList: (dir) => ipcRenderer.invoke('notes:list', { dir }),
  notesRead: (dir, name) => ipcRenderer.invoke('notes:read', { dir, name }),
  notesSave: (dir, name, content, title) => ipcRenderer.invoke('notes:save', { dir, name, content, title }),
  notesRename: (dir, name, nextName) => ipcRenderer.invoke('notes:rename', { dir, name, nextName }),
  notesDelete: (dir, name) => ipcRenderer.invoke('notes:delete', { dir, name }),
  notesPickDir: () => ipcRenderer.invoke('notes:pick-dir'),
  notesReveal: (dir, name) => ipcRenderer.invoke('notes:reveal', { dir, name }),

  // Update check
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (url, useMirror, opts) => ipcRenderer.invoke('update:download', { url, useMirror, ...(opts || {}) }),
  updatePickFile: () => ipcRenderer.invoke('update:pick-file'),
  saveText: (content, defaultName, filters) => ipcRenderer.invoke('file:save-text', { content, defaultName, filters }),
  pickFile: (title, filters) => ipcRenderer.invoke('file:pick', { title, filters }),
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

  // JMeter（非 GUI 运行）
  jmeterDetect: () => ipcRenderer.invoke('jmeter:detect'),
  jmeterPickExe: () => ipcRenderer.invoke('jmeter:pick-exe'),
  jmeterPickScript: () => ipcRenderer.invoke('jmeter:pick-script'),
  jmeterPickOutDir: () => ipcRenderer.invoke('jmeter:pick-out-dir'),
  jmeterDefaults: () => ipcRenderer.invoke('jmeter:defaults'),
  jmeterRemember: (patch) => ipcRenderer.invoke('jmeter:remember', patch),
  jmeterRun: (opts) => ipcRenderer.invoke('jmeter:run', opts),
  jmeterStop: () => ipcRenderer.invoke('jmeter:stop'),
  jmeterStatus: () => ipcRenderer.invoke('jmeter:status'),
  jmeterOpenPath: (p) => ipcRenderer.invoke('jmeter:open-path', p),
  // 运行输出（流式）：返回取消订阅函数
  onJmeterOutput: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('jmeter:output', handler);
    return () => ipcRenderer.removeListener('jmeter:output', handler);
  },
  onJmeterDone: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('jmeter:done', handler);
    return () => ipcRenderer.removeListener('jmeter:done', handler);
  },
});
