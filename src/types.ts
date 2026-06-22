export interface PasswordEntry {
  id: string;
  name: string;
  envType: string; // 'production' | 'testing' | custom
  url: string;
  username: string;
  password: string;
  notes: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface VaultData {
  entries: PasswordEntry[];
  tags: string[];
}

export type KeybindingId = 'newEntry' | 'search' | 'settings' | 'lock' | 'trash' | 'import' | 'export';

export interface AppSettings {
  clipboardClearDelay: number;
  passwordAutoHideDelay: number;
  autoLockDelay: number;
  defaultViewMode: 'card' | 'list';
  defaultEnvFilter: string;
  theme: 'dark' | 'light';
  browserPaths: { [key: string]: string };
  keybindings: Record<KeybindingId, string>;
}

export type ViewMode = 'card' | 'list';
export type SearchField = 'all' | 'name' | 'url' | 'username' | 'tags';
/** 排序字段 */
export type SortField = 'updatedAt' | 'createdAt' | 'name';
/** 排序方向 */
export type SortOrder = 'desc' | 'asc';
/** 旧版合并排序，兼容 */
export type SortOption = 'updatedAt-desc' | 'updatedAt-asc' | 'createdAt-desc' | 'createdAt-asc' | 'name-asc' | 'name-desc';
export type ConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

export interface ElectronAPI {
  // Auth
  authIsSetup: () => Promise<boolean>;
  authSetup: (data: { password: string; hint: string }) => Promise<{ success: boolean; error?: string }>;
  authVerify: (data: { password: string }) => Promise<{ success: boolean; error?: string; hint?: string }>;
  authGetHint: () => Promise<string>;
  authChangePassword: (data: { oldPassword: string; newPassword: string }) => Promise<{ success: boolean; error?: string }>;
  authSetSecurityWord: (data: { password: string; securityWord: string }) => Promise<{ success: boolean; error?: string }>;
  authVerifySecurityWord: (data: { securityWord: string }) => Promise<{ success: boolean; error?: string }>;
  authHasSecurityWord: () => Promise<boolean>;
  authResetPassword: (data: { securityWord: string; newPassword: string }) => Promise<{ success: boolean; error?: string }>;

  // Session
  sessionUnlock: (data: { password: string }) => Promise<{ success: boolean; data?: VaultData }>;
  sessionLock: () => Promise<{ success: boolean }>;
  sessionIsUnlocked: () => Promise<{ unlocked: boolean }>;
  sessionTouch: () => Promise<{ success: boolean }>;

  // Entries
  entriesGetAll: () => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  entriesAdd: (entry: PasswordEntry) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  entriesUpdate: (entry: PasswordEntry) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  entriesDelete: (data: { ids: string[]; permanent?: boolean }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  entriesBatchUpdate: (data: { ids: string[]; changes: Partial<PasswordEntry> }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;

  // Trash
  trashGetAll: () => Promise<{ success: boolean; data?: PasswordEntry[]; error?: string }>;
  trashRestore: (ids: string[]) => Promise<{ success: boolean; data?: any; error?: string }>;
  trashEmpty: () => Promise<{ success: boolean; error?: string }>;

  // Clipboard
  clipboardCopy: (data: { text: string; delay: number }) => Promise<{ success: boolean }>;
  clipboardClear: () => Promise<{ success: boolean }>;
  onClipboardCleared: (cb: () => void) => () => void;

  // Settings
  settingsGet: () => Promise<AppSettings>;
  settingsSave: (data: Partial<AppSettings>) => Promise<{ success: boolean }>;

  // Import
  importCsvJson: (data: { filePath: string }) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  importEncrypted: (data: { filePath: string; importPassword: string }) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  importConfirm: (data: { entries: any[]; conflictStrategy: ConflictStrategy }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  importDownloadTemplate: () => Promise<{ success?: boolean; canceled?: boolean; error?: string }>;

  // Export
  exportEncrypted: (data: { exportPassword: string; filter: string }) => Promise<{ success: boolean; data?: string; error?: string }>;
  exportPlain: (data: { format: string; includePasswords: boolean; filter: string }) => Promise<{ success: boolean; data?: string; count?: number; error?: string }>;
  exportSelectedEncrypted: (data: { ids: string[]; exportPassword: string }) => Promise<{ success: boolean; data?: string; count?: number; error?: string }>;
  exportSelectedPlain: (data: { ids: string[]; format: string; includePasswords: boolean }) => Promise<{ success: boolean; data?: string; count?: number; error?: string }>;

  // File dialogs
  dialogOpenFile: (data?: any) => Promise<{ canceled: boolean; filePath?: string }>;
  dialogSaveFile: (data?: any) => Promise<{ canceled: boolean; filePath?: string }>;
  fileWrite: (data: { filePath: string; content: string; encoding?: string }) => Promise<{ success: boolean; error?: string }>;

  // App
  appGetPath: (name: string) => Promise<string>;

  // Browser
  browserDetect: () => Promise<{ id: string; name: string }[]>;
  browserGetKnown: () => Promise<{ id: string; name: string }[]>;
  browserOpen: (data: { browser: string; url: string }) => Promise<{ success: boolean; error?: string }>;

  // Test Data Generator sub-app
  tdgGetPath: () => Promise<{ distPath: string; preloadPath: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
