export interface CustomField {
  id: string;
  name: string;
  value: string;
  /** true 时按密码字段处理（可复制、默认隐藏） */
  secret?: boolean;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  addedAt: string;
}

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
  /** 密码最后一次修改时间（用于过期提醒） */
  passwordUpdatedAt?: string;
  /** 收藏 / 置顶 */
  favorite?: boolean;
  /** TOTP 密钥（Base32），配置后可直接显示动态验证码 */
  totpSecret?: string;
  /** 自定义字段（安全问题、API Key 等） */
  customFields?: CustomField[];
  /** 附件（加密存储在本地） */
  attachments?: Attachment[];
  deletedAt?: string;
}

/** 密码历史版本 */
export interface PasswordHistoryItem {
  password: string;
  changedAt: string;
}

export interface VaultData {
  entries: PasswordEntry[];
  tags: string[];
}

export type KeybindingId = 'newEntry' | 'search' | 'settings' | 'lock' | 'trash' | 'import' | 'export';

export type ThemeMode = 'dark' | 'light' | 'system';

export type AccentColor = 'indigo' | 'blue' | 'green' | 'orange' | 'rose';

export interface AppSettings {
  clipboardClearDelay: number;
  passwordAutoHideDelay: number;
  autoLockDelay: number;
  defaultViewMode: 'card' | 'list';
  defaultEnvFilter: string;
  theme: ThemeMode;
  /** 主题强调色 */
  accent: AccentColor;
  /** 点最小化时隐藏到系统托盘 */
  minimizeToTray: boolean;
  /** 点关闭按钮时隐藏到托盘（不退出程序） */
  closeToTray: boolean;
  /** 禁止窗口被截图/录屏 */
  contentProtection: boolean;
  /** 开机自启 */
  launchAtLogin: boolean;
  /** 上次停留的页面 */
  lastPage: string;
  browserPaths: { [key: string]: string };
  keybindings: Record<KeybindingId, string>;
}

export interface BackupFile {
  name: string;
  size: number;
  mtime: string;
}

export interface PasswordGenOptions {
  length?: number;
  upper?: boolean;
  lower?: boolean;
  digits?: boolean;
  symbols?: boolean;
  excludeAmbiguous?: boolean;
}

/** 与主进程 VAULT_COLLECTIONS 对应 */
export type WorkspaceKey = 'snippets' | 'notes' | 'checklists' | 'accounts' | 'environments' | 'apiRequests' | 'integrations';

export interface ZentaoConfig {
  id: string;
  baseUrl: string;
  account: string;
  password: string;
  updatedAt?: string;
}

export interface ZentaoBug {
  id: string;
  title: string;
  status?: string;
  severity?: string;
  pri?: string;
  type?: string;
  assignedTo?: string;
  openedBy?: string;
  product?: string;
  productName?: string;
  date?: string;
  deadline?: string;
  resolution?: string;
}

export interface WeeklyFile {
  name: string;
  size: number;
  mtime: string;
}

/** 禅道「项目」（即产品） */
export interface ZentaoProject {
  id: string;
  name: string;
  status?: string;
}

export interface ApiResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  size: number;
  timeMs: number;
}

export interface Snippet {
  id: string;
  title: string;
  sql: string;
  tags: string[];
  updatedAt: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Checklist {
  id: string;
  title: string;
  description: string;
  items: ChecklistItem[];
  updatedAt: string;
}

export interface TestAccount {
  id: string;
  role: string;
  system: string;
  envType: string;
  username: string;
  password: string;
  note: string;
  updatedAt: string;
}

export interface EnvEntry {
  id: string;
  system: string;
  envType: string;
  url: string;
  note: string;
  updatedAt: string;
}

export interface ApiRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  /** KEY=VALUE 每行一个，用于 {{变量}} 替换 */
  variables?: string;
  updatedAt: string;
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
  authVerify: (data: { password: string }) => Promise<{ success: boolean; error?: string; hint?: string; retryAfterMs?: number }>;
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
  /** 托盘菜单「锁定」触发 */
  onLockRequest: (cb: () => void) => () => void;

  // Settings
  settingsGet: () => Promise<AppSettings>;
  settingsSave: (data: Partial<AppSettings>) => Promise<{ success: boolean }>;

  // Password generator
  passwordGenerate: (opts?: PasswordGenOptions) => Promise<{ success: boolean; data?: string; error?: string }>;

  // Backups
  backupList: () => Promise<{ success: boolean; data: BackupFile[]; dir: string }>;
  backupOpenFolder: () => Promise<{ success: boolean; error?: string }>;

  // Generic collection storage
  wsGet: (key: WorkspaceKey) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  wsSet: (key: WorkspaceKey, value: any[]) => Promise<{ success: boolean; data?: any[]; error?: string }>;

  // Password history
  historyGet: (entryId: string) => Promise<{ success: boolean; data?: PasswordHistoryItem[]; error?: string }>;

  // TOTP
  totpCode: (data: { secret: string; digits?: number; period?: number }) =>
    Promise<{ success: boolean; data?: { code: string; remain: number; period: number }; error?: string }>;

  // Attachments
  attachmentPick: () => Promise<{ success?: boolean; canceled?: boolean; data?: Attachment; error?: string }>;
  attachmentOpen: (data: { id: string; name: string }) => Promise<{ success: boolean; error?: string }>;
  attachmentDelete: (data: { id: string }) => Promise<{ success: boolean; error?: string }>;

  // API debugger / Zentao
  apiSend: (data: { method: string; url: string; headers?: string; body?: string }) =>
    Promise<{ success: boolean; data?: ApiResponseData; error?: string }>;
  zentaoLogin: (cfg: ZentaoConfig) => Promise<{ success: boolean; error?: string }>;
  zentaoMyBugs: (cfg: ZentaoConfig) => Promise<{ success: boolean; data?: ZentaoBug[]; total?: number; error?: string }>;
  zentaoProjects: (cfg: ZentaoConfig) => Promise<{ success: boolean; data?: ZentaoProject[]; error?: string }>;
  zentaoProjectBugs: (cfg: ZentaoConfig, productId: string) =>
    Promise<{ success: boolean; data?: ZentaoBug[]; total?: number; error?: string }>;
  zentaoAllBugs: (cfg: ZentaoConfig) =>
    Promise<{ success: boolean; data?: ZentaoBug[]; total?: number; products?: number; error?: string }>;

  // 周报（本地 Markdown 目录，只读）
  weeklyList: (dir: string) => Promise<{ success: boolean; data?: WeeklyFile[]; error?: string }>;
  weeklyRead: (dir: string, name: string) =>
    Promise<{ success: boolean; data?: { name: string; content: string; mtime: string; size: number }; error?: string }>;
  weeklyPickDir: () => Promise<{ success: boolean; data?: string | null; error?: string }>;
  weeklyReveal: (dir: string, name: string) => Promise<{ success: boolean; error?: string }>;
  weeklySave: (dir: string, name: string, content: string) =>
    Promise<{ success: boolean; data?: WeeklyFile; error?: string }>;
  weeklyRename: (dir: string, name: string, nextName: string) =>
    Promise<{ success: boolean; data?: { name: string }; error?: string }>;
  weeklyDelete: (dir: string, name: string) => Promise<{ success: boolean; error?: string }>;

  // Update
  updateCheck: () => Promise<{
    success: boolean;
    data?: { current: string; latest: string; hasUpdate: boolean; url: string; notes: string };
    error?: string;
  }>;

  // Import
  importCsvJson: (data: { filePath: string }) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  importEncrypted: (data: { filePath: string; importPassword: string }) => Promise<{ success: boolean; data?: any[]; error?: string }>;
  importConfirm: (data: { entries: any[]; conflictStrategy: ConflictStrategy }) => Promise<{ success: boolean; data?: VaultData; error?: string; importedCount?: number }>;
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
