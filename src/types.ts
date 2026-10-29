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
  /** 禅道新 Bug 提醒（后台定时检查） */
  zentaoNotify: boolean;
  /** 提醒检查间隔（分钟） */
  zentaoNotifyInterval: number;
  /** 多套禅道配置里当前使用哪一套（id；老数据默认 'zentao'） */
  zentaoActiveId?: string;
  /** 自动备份保留份数（1~60） */
  backupKeep: number;
  /** 异地备份目录（第二目录 / 网盘同步目录），空 = 未启用 */
  backupMirrorDir?: string;
  browserPaths: { [key: string]: string };
  keybindings: Record<KeybindingId, string>;
}

export interface BackupFile {
  name: string;
  size: number;
  mtime: string;
}

/** 数据目录信息（设置页展示用） */
export interface DataLocationInfo {
  dataDir: string;
  defaultDir: string;
  isCustom: boolean;
  vaultFile: string;
  backupDir: string;
  attachDir: string;
  backupCount: number;
  vault: { size: number; mtime: string } | null;
  bak: { size: number; mtime: string } | null;
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
export type WorkspaceKey = 'snippets' | 'notes' | 'checklists' | 'accounts' | 'environments' | 'apiRequests' | 'integrations'
  | 'ztPresets' | 'apiEnvs' | 'apiHistory';

export interface ZentaoConfig {
  id: string;
  baseUrl: string;
  account: string;
  password: string;
  updatedAt?: string;
}

/** 我的 Bug 视图：指派给我 / 我提交的 / 待我验证 */
export type MyBugScope = 'assigned' | 'opened' | 'verify';

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
  /** 解决日期 / 关闭日期（周报统计用） */
  resolvedDate?: string;
  closedDate?: string;
}

/** 禅道 Bug 详情（从 bug-view 页面解析） */
export interface AuditEntry {
  at: string;
  action: string;
  detail?: string;
}

export interface NotifyStatus {
  enabled: boolean;
  interval: number;
  configured: boolean;
  unlocked: boolean;
  lastCheck: { at: string; ok: boolean; total?: number; fresh?: number; error?: string } | null;
}

/** 禅道 Bug 附件（url 是要带登录态才能取的 file-download / file-read 地址） */
export interface ZentaoAttachment {
  name: string;
  url: string;
}

export interface ZentaoBugDetail {
  id: string;
  title: string;
  productName?: string;
  steps: string;
  attachments: ZentaoAttachment[];
  url: string;
  /** 重现步骤里的截图（主进程带登录态取回后转成 dataURL，渲染层才能直接显示） */
  images?: { src: string; name: string; dataUrl: string }[];
  /** 流转记录（谁在什么时候做了什么） */
  history?: { action: string; label: string; time: string; who: string; text: string }[];
  /** 正文里一共几张图 / 其中几张没取到 */
  imageTotal?: number;
  imageFailed?: number;
}

/** 禅道筛选预设 */
export interface ZentaoPreset {
  id: string;
  name: string;
  project?: string;
  status?: string;
  severity?: string;
  query?: string;
  updatedAt: string;
}

/** 接口调试：环境（一组变量） */
export interface ApiEnv {
  id: string;
  name: string;
  /** 每行 key=value */
  vars: string;
  updatedAt: string;
}

/** 接口调试：请求历史 */
export interface ApiHistoryItem {
  id: string;
  method: string;
  url: string;
  status: number;
  timeMs: number;
  at: string;
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
  /** 响应里的原始 Set-Cookie（已被收进会话罐） */
  setCookies?: string[];
}

/** 会话 Cookie 罐里的一条（只在内存，锁定即清） */
export interface ApiJarCookie {
  origin: string;
  name: string;
  /** 0 = 会话级 */
  expiresAt: number;
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

/** 断言的检查类型 */
export type AssertOp = 'status' | 'time' | 'json' | 'body' | 'header' | 'jsonValid';

/** 响应结构快照：只记类型不记值，用来发现「字段被删/改名/换类型」 */
export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'mixed';

export interface ApiSchemaNode {
  t: SchemaType;
  /** t=object 时：字段名 → 子节点 */
  fields?: Record<string, ApiSchemaNode>;
  /** t=array 时：元素节点 */
  item?: ApiSchemaNode;
}

export interface ApiSnapshot {
  at: string;
  schema: ApiSchemaNode;
}

export interface SchemaDiff {
  added: string[];
  removed: string[];
  changed: { path: string; from: SchemaType; to: SchemaType }[];
  comparable: boolean;
}

/** 一条断言（1.6.0 起断言是可加可减的行列表，不再局限于 5 个固定槽位） */
export interface AssertRule {
  id: string;
  op: AssertOp;
  /** json 路径 / 响应头名；status、time、body、jsonValid 不用 */
  target?: string;
  /** 期望值：状态码(200/2xx)、耗时上限、JSON 期望值、包含文本 */
  value?: string;
  /** 取反：不等于 / 不包含 / 路径不存在 / 响应头不存在 */
  negate?: boolean;
}

/** 断言配置：规则列表 + 1.5.x 旧字段（只读兼容，保存时统一写 rules） */
export interface ApiAssertions {
  rules?: AssertRule[];
  /** @deprecated 旧数据兼容：期望状态码 */
  status?: string;
  /** @deprecated 旧数据兼容：响应时间上限（ms） */
  maxMs?: string;
  /** @deprecated 旧数据兼容：JSON 取值路径 */
  jsonPath?: string;
  /** @deprecated 旧数据兼容：路径值需包含的内容 */
  jsonValue?: string;
  /** @deprecated 旧数据兼容：正文必须包含的关键字 */
  contains?: string;
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
  /** Cookie（旧字段，读取时会合并进 headers.Cookie，不再单独展示） */
  cookies?: string;
  /** 请求体类型：json / form / multipart / raw / none */
  bodyType?: 'json' | 'form' | 'multipart' | 'raw' | 'none';
  /** raw 时的 Content-Type */
  rawContentType?: string;
  /** 断言配置 */
  assertions?: ApiAssertions;
  /** 响应结构快照（存一次，以后每次发送都跟它比结构有没有变） */
  snapshot?: ApiSnapshot;
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
  authVerify: (data: { password: string }) => Promise<{ success: boolean; error?: string; hint?: string; retryAfterMs?: number; code?: 'vault-corrupt' }>;
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
  backupList: () => Promise<{ success: boolean; data: BackupFile[]; dir: string; keep?: number; lastAt?: string }>;
  backupStatus: () => Promise<{ success: boolean; data?: { local: { dir: string; files: BackupFile[]; keep: number }; mirror: { dir: string; files: BackupFile[]; lastAt: string; error?: string } }; error?: string }>;
  backupNow: () => Promise<{ success: boolean; data?: { file: string; day: string; mirror: { ok: boolean; skipped?: boolean; dir?: string; path?: string; error?: string } }; error?: string }>;
  backupMirrorPick: () => Promise<{ success: boolean; data?: string; canceled?: boolean; error?: string }>;
  /** 写一条审计日志（复制密码/导出等） */
  auditLog: (action: string, detail?: string) => Promise<{ success: boolean }>;
  auditList: (limit?: number) => Promise<{ success: boolean; data?: AuditEntry[] }>;
  auditClear: () => Promise<{ success: boolean; error?: string }>;
  backupOpenFolder: () => Promise<{ success: boolean; error?: string }>;
  /** 用指定备份覆盖当前库；恢复前会自动留一份 pre-restore 快照 */
  backupRestore: (name: string) => Promise<{ success: boolean; preRestore?: string; error?: string }>;

  // 数据目录
  dataInfo: () => Promise<{ success: boolean; data?: DataLocationInfo; error?: string }>;
  dataOpenFolder: (which?: 'data' | 'backups') => Promise<{ success: boolean; error?: string }>;
  dataMigrate: () => Promise<{ success: boolean; canceled?: boolean; data?: { dir: string; copied: string[] }; error?: string }>;
  dataResetLocation: () => Promise<{ success: boolean; data?: { dir: string }; error?: string }>;

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
  apiSend: (data: {
    method: string; url: string; headers?: string; body?: string;
    bodyType?: 'json' | 'form' | 'multipart' | 'raw' | 'none';
    rawContentType?: string;
    /** 默认 true：自动收 Set-Cookie，并在后续请求里补 Cookie 头 */
    autoSession?: boolean;
  }) => Promise<{ success: boolean; data?: ApiResponseData; error?: string }>;
  /** 会话 Cookie 罐（仅内存） */
  apiCookies: (origin?: string) => Promise<{ success: boolean; data?: ApiJarCookie[] }>;
  apiCookiesClear: (origin?: string) => Promise<{ success: boolean; data?: ApiJarCookie[] }>;
  zentaoLogin: (cfg: ZentaoConfig) => Promise<{ success: boolean; error?: string }>;
  zentaoMyBugs: (cfg: ZentaoConfig, scope?: MyBugScope) => Promise<{ success: boolean; data?: ZentaoBug[]; total?: number; error?: string }>;
  zentaoProjects: (cfg: ZentaoConfig) => Promise<{ success: boolean; data?: ZentaoProject[]; error?: string }>;
  zentaoProjectBugs: (cfg: ZentaoConfig, productId: string) =>
    Promise<{
      success: boolean;
      data?: ZentaoBug[];
      total?: number;
      error?: string;
      cached?: boolean;
      ageMs?: number;
      fetchedAt?: string;
    }>;
  zentaoAllBugs: (cfg: ZentaoConfig, force?: boolean) =>
    Promise<{
      success: boolean;
      data?: ZentaoBug[];
      total?: number;
      products?: number;
      error?: string;
      /** 命中了主进程 10 分钟缓存 */
      cached?: boolean;
      ageMs?: number;
      fetchedAt?: string;
    }>;
  zentaoBugDetail: (cfg: ZentaoConfig, bugId: string) =>
    Promise<{ success: boolean; data?: ZentaoBugDetail; error?: string }>;
  /** 下载 Bug 附件（主进程带登录态取二进制）；mode=open 直接打开，save 另存为 */
  zentaoAttachment: (cfg: ZentaoConfig, url: string, name: string, mode?: 'open' | 'save') =>
    Promise<{ success: boolean; canceled?: boolean; data?: { path: string; size: number; name: string }; error?: string }>;
  /** 立即检查一次新 Bug（设置页「立即检查」） */
  zentaoNotifyNow: () => Promise<{ success: boolean; data?: NotifyStatus['lastCheck'] }>;
  /** 提醒运行状态：是否开启/已配置/解锁中/上次检查结果 */
  zentaoNotifyStatus: () => Promise<{ success: boolean; data?: NotifyStatus }>;
  /** 点系统通知 → 跳到禅道页 */
  onZentaoOpen: (cb: () => void) => () => void;
  /** 禅道未读数（侧边栏红点） */
  zentaoUnread: () => Promise<{ success: boolean; data?: number }>;
  zentaoUnreadClear: () => Promise<{ success: boolean; data?: number }>;
  /** 主进程发现新 Bug 时推送未读数 */
  onZentaoUnread: (cb: (n: number) => void) => () => void;

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

  // 测试笔记（可选：存到自己选的目录）
  notesList: (dir: string) => Promise<{ success: boolean; data?: WeeklyFile[]; error?: string }>;
  notesRead: (dir: string, name: string) =>
    Promise<{ success: boolean; data?: { name: string; content: string; mtime: string; size: number }; error?: string }>;
  notesSave: (dir: string, name: string, content: string, title?: string) =>
    Promise<{ success: boolean; data?: WeeklyFile; error?: string }>;
  notesRename: (dir: string, name: string, nextName: string) =>
    Promise<{ success: boolean; data?: { name: string }; error?: string }>;
  notesDelete: (dir: string, name: string) => Promise<{ success: boolean; error?: string }>;
  notesPickDir: () => Promise<{ success: boolean; data?: string | null; error?: string }>;
  notesReveal: (dir: string, name?: string) => Promise<{ success: boolean; error?: string }>;

  // Update
  updateCheck: () => Promise<{
    success: boolean;
    data?: { current: string; latest: string; hasUpdate: boolean; url: string; notes: string; downloadUrl?: string; assetName?: string; digest?: string };
    error?: string;
  }>;
  /** 下载新版本安装包（进度通过 onUpdateProgress 推送）；useMirror=true 时走第三方加速 */
  updateDownload: (url: string, useMirror?: boolean, opts?: { expectedSha256?: string; threads?: boolean }) => Promise<{
    success: boolean;
    data?: { file: string; name?: string; size: number; via?: string; threads?: number; sha256?: string; verified?: boolean };
    error?: string;
    canMirror?: boolean;
    detail?: string;
  }>;
  /** 选任意文件（上传附件） */
  pickFile: (title?: string, filters?: { name: string; extensions: string[] }[]) =>
    Promise<{ success: boolean; data?: { file: string; name: string }; error?: string; canceled?: boolean }>;
  /** 保存文本到文件（导出 CSV 等），自动加 BOM */
  saveText: (content: string, defaultName: string, filters?: { name: string; extensions: string[] }[]) =>
    Promise<{ success: boolean; data?: { file: string }; error?: string; canceled?: boolean }>;
  /** 手动选择已下载的安装包（网络下不动时的兜底） */
  updatePickFile: () => Promise<{ success: boolean; data?: { file: string; size: number }; error?: string; canceled?: boolean }>;
  /** 启动静默安装并退出应用 */
  updateInstall: (file: string) => Promise<{ success: boolean; error?: string }>;
  onUpdateProgress: (cb: (p: { received: number; total: number; speed?: number; threads?: number }) => void) => () => void;

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
