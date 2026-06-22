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

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (data) => ipcRenderer.invoke('settings:save', data),

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
