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
  /** 粘贴进来的图片附件会带 mime 与 kind */
  mime?: string;
  kind?: 'image';
  /**
   * 落点（1.25.1）：`note` = 笔记目录下的 attachments（目录模式笔记的截图），
   * `entry` = 全局附件目录。读取时主进程会先找笔记目录再回退全局，所以老附件不受影响。
   */
  scope?: 'note' | 'entry';
  /** 实际落盘目录（排障 / 界面展示用） */
  dir?: string;
}

/** 附件目录里的一个文件（附件集中管理页用；不含内容） */
export interface AttachmentFileMeta {
  id: string;
  /** 加密后文件大小（不是原图大小） */
  size: number;
  updatedAt: string;
  /** 所在目录 / 加密文件的绝对路径（附件管理页展示与定位用） */
  dir?: string;
  file?: string;
  /**
   * 附件来源（1.25.1）：
   * - `note`  = 笔记目录下的 `<笔记目录>/attachments`（目录模式笔记的截图）；
   * - `entry` = 全局附件目录（网址条目附件 / 随手记 / 老附件）。
   */
  scope?: 'note' | 'entry';
}

/**
 * 条目下的「其他角色账号」。
 *
 * 主账号仍是 `entry.username` / `entry.password`（沿用所有现有逻辑：卡片、钉窗、复制、搜索），
 * 这里只放「同一个地址下的其它角色」—— 一个系统往往有 admin / 普通用户 / 只读 三套。
 * 以前这些存在独立的「测试账号」集合里，同一个系统的地址和账号要在两个页面之间对。
 */
export interface EntryAccount {
  id: string;
  /** 管理员 / 普通用户 / 只读 …… */
  role: string;
  username: string;
  password: string;
  note?: string;
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
  /** 其他角色账号（v3 起由「测试账号」集合合并而来） */
  accounts?: EntryAccount[];
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

export type AccentColor = 'teal' | 'indigo' | 'blue' | 'green' | 'orange' | 'rose';

/** 界面密度三档 */
export type Density = 'compact' | 'standard' | 'cozy';

export interface AppSettings {
  clipboardClearDelay: number;
  /** 附件（截图/证书/密钥）存放目录；空 = 数据目录下的 attachments */
  attachDir?: string;
  /** 目录模式测试笔记的存放目录（.md 一篇一个文件）；空 = 未启用目录模式 */
  notesDir?: string;
  /** 周报目录；空 = 用默认（未选择） */
  weeklyDir?: string;
  /** 记录最近 10 条敏感复制（仅内存，锁屏即清空）；默认关闭 */
  clipboardHistory?: boolean;
  /** 全局搜索快捷键（Electron 加速键，如 CommandOrControl+Space）；空 = 用默认 */
  hotkeySearch?: string;
  /** 显示/隐藏窗口的全局快捷键；空 = 用默认 */
  hotkeyToggle?: string;
  /**
   * 随手记小窗的全局快捷键（1.25.0 补）。
   * 主进程一直在写这个键（`main.js` 的 `applyHotkeys`），但 `settings:get` 不返回、
   * 类型里也没有 —— 任何「按 settings 回填」的路径都拿不到它。
   */
  hotkeyQuickNote?: string;
  /** 可选的更新下载源前缀（国内直链）；留空则只走 GitHub */
  updateMirrorUrl?: string;
  /** 周期检查更新间隔（小时）；0 = 仅启动时查一次 */
  updateCheckIntervalHours?: number;
  passwordAutoHideDelay: number;
  autoLockDelay: number;
  defaultViewMode: 'card' | 'list' | 'system';
  defaultEnvFilter: string;
  theme: ThemeMode;
  /** 主题强调色 */
  accent: AccentColor;
  /** 界面密度（紧凑/标准/宽松） */
  density: Density;
  /** 点最小化时隐藏到系统托盘 */
  minimizeToTray: boolean;
  /** 点关闭按钮时隐藏到托盘（不退出程序） */
  closeToTray: boolean;
  /** 禁止窗口被截图/录屏 */
  contentProtection: boolean;
  /** 开机自启 */
  launchAtLogin: boolean;
  /** 启动时静默检查更新（默认 true）；关掉后只有手动点「检查更新」才联网 */
  updateCheckOnStart?: boolean;
  // ---- 压力测试（JMeter）：只记路径，脚本本身不复制进来 ----
  /** 本机 jmeter.bat / jmeter 路径（设置页或压力测试页选择） */
  jmeterPath?: string;
  /** 上次使用的输出目录 */
  jmeterOutDir?: string;
  /** 上次使用的 .jmx 路径 */
  jmeterLastJmx?: string;
  /** 上次弹过更新提示的版本号（内部字段，避免每次启动都弹） */
  updateNotifiedVersion?: string;
  /** 上次停留的页面 */
  lastPage: string;

  /** 自定义背景图文件名（存在数据目录 background/ 下） */
  backgroundImage?: string;
  /** 背景不透明度 0~0.9 */
  backgroundOpacity?: number;
  /** 背景模糊 px */
  backgroundBlur?: number;
  /** 压暗遮罩 0~0.9 */
  backgroundDim?: number;
  /** 从图片提取的强调色 #rrggbb */
  backgroundAccent?: string;
  /** 是否用图片主色替换强调色 */
  backgroundAutoAccent?: boolean;
  /** 上一次「手动备份」的时间（自动每日备份不更新它，工作台用它算天数） */
  lastBackupAt?: string;
  /** 禅道新 Bug 提醒（后台定时检查） */
  zentaoNotify: boolean;
  /** 提醒检查间隔（分钟） */
  zentaoNotifyInterval: number;
  /** 超期未动提醒：待验证 / 待处理挂太久时也提醒（依赖本地状态快照） */
  zentaoStaleOn: boolean;
  /** 超期天数阈值 */
  zentaoStaleDays: number;
  /** 环境巡检：定时执行（分钟，0 = 关） */
  envProbeInterval: number;
  /** 环境巡检：只在可达性/耗时发生翻转时弹系统通知 */
  envProbeNotifyOnFlip: boolean;
  /**
   * 环境巡检超时（毫秒，1.25.0）。
   * 以前页面上的选择只存在 useState 里，定时巡检写死 8000 —— 慢环境永远超时。
   */
  envProbeTimeoutMs?: number;
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

/** 库自检里的一条问题（electron/vault-audit.js 的返回结构） */
export interface VaultAuditIssue {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  count: number;
  samples: string[];
}

/** 库自检报告：只读体检结果，不含任何条目内容 */
export interface VaultAuditReport {
  ok: boolean;
  checkedAt: string;
  schemaVersion: number;
  stats: Record<string, number>;
  counts: { error: number; warn: number; info: number };
  issues: VaultAuditIssue[];
}

/** 恢复演练结果：stage 说明卡在哪一步 */
export interface RestoreDrillResult {
  name: string;
  ok: boolean;
  stage: 'format' | 'decrypt' | 'parse' | 'done';
  error?: string;
  bytes?: number;
  report?: VaultAuditReport;
}

/** 数据目录信息（设置页展示用） */
export interface DataLocationInfo {
  dataDir: string;
  defaultDir: string;
  isCustom: boolean;
  vaultFile: string;
  backupDir: string;
  attachDir: string;
  /** 附件目录的默认位置（数据目录/attachments） */
  attachDefaultDir?: string;
  /** 附件目录是否被改到别处 */
  attachIsCustom?: boolean;
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
export type WorkspaceKey = 'snippets' | 'notes' | 'checklists' | 'accounts' | 'environments' | 'apiRequests' | 'integrations' | 'codeSnippets'
  | 'ztPresets' | 'apiEnvs' | 'apiHistory'
  /** 接口回归：回归集与运行历史（类型见 utils/regression.ts） */
  | 'regressionSets' | 'regressionRuns'
  /** 环境巡检历史（1.25.0：从 localStorage 迁进加密库） */
  | 'envProbes'
  /** 测试数据生成器的数据集（1.25.0） */
  | 'tdgDatasets';

export interface ZentaoConfig {
  id: string;
  /** 这套配置属于哪家公司/客户（同名项目多，靠它区分） */
  company?: string;
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
  /** 禅道登录账号（非显示名）：用于在同一份项目数据里本地派生「我的 Bug」 */
  assignedToAccount?: string;
  openedByAccount?: string;
  product?: string;
  productName?: string;
  date?: string;
  deadline?: string;
  resolution?: string;
  /** 提交 / 解决 / 关闭日期：本地时间 YYYY-MM-DD HH:mm（REST 给的是 UTC，主进程已转换） */
  openedDate?: string;
  resolvedDate?: string;
  closedDate?: string;
  /** 所属模块 id（禅道 REST 只给数字 id） */
  module?: string;
  /** 模块路径（由 tree-ajaxGetOptionMenu 解析，汇总统计用） */
  moduleName?: string;
  /* ---- 以下三个字段只在「跨实例汇总」时由主进程补上 ---- */
  /** 来源禅道配置 id（vault.integrations[].id） */
  instanceId?: string;
  /** 来源禅道显示名（公司/环境） */
  instanceName?: string;
  /** `实例id::产品id`：不同禅道的产品 id 会重名，跨实例必须用它区分 */
  key?: string;
}

/** 跨实例汇总的一个目标（一套禅道配置 + 要拉的项目） */
export interface ZentaoDigestTarget {
  id: string;
  name: string;
  cfg: ZentaoConfig;
  /** 空数组 = 该实例下的全部项目 */
  productIds: string[];
}

/** 跨实例汇总：单个实例的拉取结果 */
export interface ZentaoDigestGroup {
  instanceId: string;
  name: string;
  baseUrl: string;
  ok: boolean;
  error: string;
  bugs: ZentaoBug[];
  /** 产品 id → { 模块 id: 模块路径 } */
  modules: Record<string, Record<string, string>>;
  productIds: string[];
  /** 部分产品失败（重试后仍失败），不影响其它产品 */
  errors?: string[];
}

export interface ZentaoDigestProgress {
  phase: 'fetch';
  index: number;
  total: number;
  name: string;
}

/** 禅道 Bug 详情（从 bug-view 页面解析） */
export interface AuditEntry {
  at: string;
  action: string;
  detail?: string;
}

/** 剪贴板历史的一条（内容只在内存与加密文件里，界面默认只显示长度） */
export interface ClipHistoryItem {
  text: string;
  at: string;
}

export interface NotifyStatus {
  enabled: boolean;
  interval: number;
  configured: boolean;
  unlocked: boolean;
  lastCheck: {
    at: string; ok: boolean; total?: number; fresh?: number; error?: string;
    /** 超期提醒是否开启（快照里记录当次口径） */
    staleOn?: boolean;
    staleDays?: number;
    /** 当次统计到的超期数：待验证 / 待处理 */
    stale?: { verify: number; handle: number };
    /** 超期明细（通知中心展示，主进程截断到 20 条） */
    staleRows?: {
      verify: Array<{ id: string; title: string; days: number; status: string }>;
      handle: Array<{ id: string; title: string; days: number; status: string }>;
    };
  } | null;
  /** 超期提醒开关与阈值（setting 项，随状态一起回给界面） */
  staleOn?: boolean;
  staleDays?: number;
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
  /** 请求名称（保存过就有；没有则界面显示「未命名」） */
  name?: string;
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

/** 用例库：文件夹（一级 = 系统，二级 = 模块） */
export interface CasesDir {
  name: string;
  /** 相对用例库根的路径，POSIX 分隔符 */
  rel: string;
  mtime: string;
  /** 该文件夹顶层文件数（不递归） */
  fileCount: number;
  /** 该文件夹下的一级子文件夹数（系统节点用它显示「模块数」） */
  dirCount: number;
}

/** 用例库：用例文件（xmind / md / csv / xlsx … 应用内不解析） */
export interface CasesFile {
  name: string;
  rel: string;
  size: number;
  mtime: string;
  ext: string;
}

/** 用例库：一次目录列表 */
export interface CasesListing {
  configured: boolean;
  root: string;
  rel: string;
  dirs: CasesDir[];
  files: CasesFile[];
}

/** 禅道「项目」（即产品） */
export interface ZentaoProject {
  id: string;
  name: string;
  status?: string;
  /** 所属项目集 id（禅道 products 的 program 字段） */
  program?: string;
  /** 项目集名称（重名项目靠它区分） */
  programName?: string;
  /** 用户手动补进来的项目（接口没返回，靠 id 单查或占位） */
  manual?: boolean;
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

/** WebSocket / SSE 长连接推回来的事件（1.23.0） */
export interface WsEvent {
  /** 连接 id（wsConnect / sseConnect 返回的那个） */
  id: string;
  type: 'open' | 'message' | 'close' | 'error';
  /** 文本内容；open/close/error 时是给人看的一句话 */
  data: string;
  /** SSE 的 event: 名（默认 message） */
  event?: string;
  /** WebSocket 二进制帧 */
  binary?: boolean;
  /** 收到的字节数 */
  bytes?: number;
  at: string;
}

export interface Snippet {
  id: string;
  title: string;
  sql: string;
  tags: string[];
  updatedAt: string;
}

/**
 * 笔记的关联对象（1.25.0）。
 *
 * 用途：踩坑记录往往对应「某个系统的某个地址」「某条缺陷」「某个环境」，
 * 以前只能在正文里手写「#1234 那个 bug」，靠人肉搜索关联。
 * 这里只存引用（kind + id），不复制内容 —— 被引用对象改名/删除时笔记不会跟着变脏，
 * 反查时由界面按 id 去对应集合里取，取不到就显示「已删除」。
 *
 * **纯本地**：不写回禅道、不修改禅道任何数据，只是本地笔记上的一个标记。
 */
export interface NoteLink {
  kind: 'entry' | 'bug' | 'env' | 'checklist';
  /** 对应集合里的 id；bug 用禅道 bug id（纯数字字符串） */
  id: string;
  /** 冗余一份标题，被引用对象删了也能看出原来指的是什么 */
  label?: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
  /**
   * 1.24.3：原来有「SQL 片段」和「测试笔记」两个独立菜单，底层都是
   * 标题 + 正文 + 标签 + 时间的加密集合，只是渲染方式不同。现在合并为一个页面，
   * 用这个字段区分 SQL 语句（等宽 / 一键复制）和 Markdown 笔记。
   * 老数据没有这个字段，一律按 'note' 处理。
   */
  /**
   * 1.25.0：新增 'weekly' —— 周报句式片段也存在 notes 集合里（不额外建集合），
   * 靠这个值区分。笔记页要把 weekly 过滤掉，否则片段会污染笔记列表。
   */
  kind?: 'note' | 'sql' | 'weekly';
  /** 关联的条目 / 缺陷 / 环境 / 用例（1.25.0）；老数据没有 = 无关联 */
  links?: NoteLink[];
}

/**
 * 周报句式片段（1.25.0）。
 *
 * 「下周工作计划」「本周总结」这类段落每周都要重写一遍，实际只是换几个数字。
 * 片段存在 notes 集合里（`kind: 'weekly'`），跟着加密库走，不额外建集合。
 */
export interface WeeklySnippet {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
}

/**
 * 测试数据生成器的「数据集」（1.25.0）。
 *
 * 每次造数都要把类型、条数、各类型参数重填一遍。数据集把整份 GenerateConfig
 * 存进加密库，下次一键载入。存的是配置而不是生成结果 —— 结果可能上万条，
 * 存进 vault 会让每次保存都变慢。
 */
export interface TdgDataset {
  id: string;
  name: string;
  /** 生成配置（结构见 utils/tdg/types.ts 的 GenerateConfig，这里用 unknown 避免循环依赖） */
  config: unknown;
  createdAt: string;
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

/** 单条巡检结果 */
export interface EnvProbeResult {
  /** 巡检目标 id（环境条目 id），用于回填到表格行 */
  id?: string;
  url: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

export interface EnvProbeData {
  results: EnvProbeResult[];
  summary: { total: number; ok: number; fail: number; slow: number; avgMs: number; slowest: string };
  timeoutMs: number;
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

/** 提取变量的规则：从响应里按路径取值，存进批量运行的变量池 */
export interface ApiExtractRule {
  name: string;
  /** 响应 JSON 路径，如 data.token / data.list[0].id */
  path: string;
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
  /** 来源分组（从 Postman / Apifox 集合导入时保留文件夹路径） */
  group?: string;
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
  /**
   * 变量提取：从这次响应里取一个值，存进批量运行的变量池，
   * 后面的请求用 {{name}} 就能拿到（登录拿 token 再调业务接口）。
   */
  extract?: ApiExtractRule[];
  /** 响应结构快照（存一次，以后每次发送都跟它比结构有没有变） */
  snapshot?: ApiSnapshot;
  updatedAt: string;
}

export type ViewMode = 'card' | 'list' | 'system';
export type SearchField = 'all' | 'name' | 'url' | 'username' | 'tags';
/** 排序字段 */
/**
 * 列表排序字段（1.25.0 扩展）。
 *
 * 原来只有 updatedAt / createdAt / name 三个，而列表视图的表头有 环境 / URL / 账号 列。
 * 那几列以前靠 `EntryList` 内部的本地排序，但 Dashboard 是「先 slice(0,120) 再传进去」，
 * 所以点表头只对已渲染的 120 条生效 —— 第 121 条起顺序是乱的。
 * 现在把这几列也纳入 store 的全局排序，表头点击只改 store。
 */
export type SortField = 'updatedAt' | 'createdAt' | 'name' | 'envType' | 'url' | 'username';
/** 排序方向 */
export type SortOrder = 'desc' | 'asc';
/** 旧版合并排序，兼容 */
export type SortOption = 'updatedAt-desc' | 'updatedAt-asc' | 'createdAt-desc' | 'createdAt-asc' | 'name-asc' | 'name-desc';
export type ConflictStrategy = 'skip' | 'overwrite' | 'duplicate';

/** JMeter 运行输出（流式） */
export interface JmeterLogLine {
  runId: string;
  stream: 'out' | 'err' | 'cmd';
  line: string;
}

/** JMeter 运行结果 */
export interface JmeterDone {
  runId: string;
  code: number | null;
  ok: boolean;
  stats: {
    samples: number;
    errors: number;
    errorPct: number;
    avg: number;
    min: number;
    max: number;
    p90?: number;
    p95?: number;
    p99?: number;
    wallMs?: number;
    tps: number;
    topErrorCode?: { code: string; count: number } | null;
  } | null;
  statsFrom: string;
  jtlPath: string;
  reportDir: string;
  logPath: string;
}

export interface JmeterHistoryRecord {
  id: string;
  at: string;
  jmx: string;
  jmxName: string;
  mode: string;
  threads: number;
  loops: number;
  ok: boolean;
  code: number | null;
  samples: number;
  errors: number;
  errorPct: number;
  avg: number;
  max: number;
  tps: number;
  jtlPath: string;
  reportDir: string;
  logPath: string;
}

export interface CodelabDetect {
  node: { ok: boolean; path: string };
  python: { ok: boolean; path: string };
  java: { ok: boolean; java: string; javac: string };
  supported: string[];
}

export interface CodelabDone {
  runId: string;
  ok: boolean;
  code: number;
  timedOut: boolean;
  ms: number;
  dir: string;
  phase?: string;
}

/** 代码调试的片段库条目（存在 vault 的 codeSnippets 集合里，跟着加密库走） */
export interface CodelabSnippet {
  id: string;
  name: string;
  lang: string;
  code: string;
  createdAt: string;
  updatedAt: string;
}

/** JMeter 运行参数 */
export interface JmeterRunOptions {
  jmeterPath?: string;
  jmxPath: string;
  mode: 'log' | 'report';
  outDir: string;
  threads?: number;
  loops?: number;
  extraArgs?: string[];
}

export interface JmeterDetectInfo {
  jmeterPath: string;
  from: string;
  java: {
    ok: boolean;
    /** JDK 根目录（JAVA_HOME 那种），可能为空 */
    home: string;
    /** 实际使用的 java 可执行文件 */
    exe: string;
    version?: string;
    /** settings / env / scan / path */
    source?: string;
    /** 环境变量 JAVA_HOME 的值（可能已失效） */
    envHome?: string;
    envHomeOk?: boolean;
    candidates?: { home: string; source: string; error?: string }[];
  };
  candidates: string[];
}

/** 单个全局快捷键的注册结果 */
export interface HotkeySlotResult {
  /** 想注册的加速键，如 CommandOrControl+Space */
  want: string;
  /** 展示名，如 Ctrl+空格 */
  label: string;
  ok: boolean;
  accel: string;
  /** conflict=被占用 / same=和另一个键重复 / '' */
  reason: '' | 'conflict' | 'same';
  /** 默认键被占用后自动换成了兜底键 */
  fallback?: boolean;
}

export interface HotkeyApplyResult {
  success: boolean;
  error?: string;
  rolledBack?: boolean;
  data?: { search: HotkeySlotResult; toggle: HotkeySlotResult; quicknote: HotkeySlotResult };
  /** 应用后的实际状态（失败时是回滚后的状态） */
  info?: HotkeyInfo;
}

/** 实际生效的全局快捷键 */
export interface HotkeyInfo {
  search: string;
  toggle: string;
  searchOk: boolean;
  toggleOk: boolean;
  searchAccel: string;
  toggleAccel: string;
  searchDefault: string;
  toggleDefault: string;
  /** 默认键的加速键原值（「恢复默认」时直接发给主进程） */
  searchDefaultAccel: string;
  toggleDefaultAccel: string;
  searchIsDefault: boolean;
  toggleIsDefault: boolean;
  /** 随手记小窗（全局键直接出小记事本，不弹主窗口） */
  quicknote: string;
  quicknoteOk: boolean;
  quicknoteAccel: string;
  quicknoteDefault: string;
  quicknoteDefaultAccel: string;
  quicknoteIsDefault: boolean;
}

export interface ElectronAPI {
  // Auth
  authIsSetup: () => Promise<boolean>;
  authSetup: (data: { password: string; hint: string }) => Promise<{ success: boolean; error?: string }>;
  authVerify: (data: { password: string }) => Promise<{ success: boolean; error?: string; hint?: string; retryAfterMs?: number; code?: 'vault-corrupt' }>;
  authGetHint: () => Promise<string>;
  /**
   * 修改主密码。1.25.0 起主进程会把所有附件用新密码重新加密，
   * 并回报 `attachments` 统计（有失败时 `warning` 说明原因）。
   */
  authChangePassword: (data: { oldPassword: string; newPassword: string }) => Promise<{
    success: boolean;
    error?: string;
    /** 附件重加密统计；total=0 表示没有附件 */
    attachments?: { total: number; ok: number; failed: number };
    /** 附件重加密失败时的补充说明 */
    warning?: string;
  }>;
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
  /**
   * 批量「追加」标签（1.25.0）。
   * 与 entriesBatchUpdate 的区别：那边是 Object.assign 整体替换 tags，
   * 用「添加标签」的语义去调会把原有标签全冲掉。这里只做并集。
   */
  entriesAddTag: (data: { ids: string[]; tag: string }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  /** 标签重命名（同时改所有条目上的引用）；1.25.0 起标签操作必须落盘 */
  entriesRenameTag: (data: { from: string; to: string }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  /** 删除标签（同时从所有条目上摘掉） */
  entriesDeleteTag: (data: { tag: string }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;
  /** 保存标签顺序（拖拽排序后调用） */
  entriesReorderTags: (data: { tags: string[] }) => Promise<{ success: boolean; data?: VaultData; error?: string }>;

  // Trash
  trashGetAll: () => Promise<{ success: boolean; data?: PasswordEntry[]; error?: string }>;
  trashRestore: (ids: string[]) => Promise<{ success: boolean; data?: any; error?: string }>;
  trashEmpty: () => Promise<{ success: boolean; error?: string }>;
  /** 从回收站里彻底删除指定条目（1.25.0；trashEmpty 是整站清空） */
  trashDelete: (ids: string[]) => Promise<{ success: boolean; data?: PasswordEntry[]; error?: string }>;

  // Clipboard
  clipboardCopy: (data: { text: string; delay: number }) => Promise<{ success: boolean }>;  /** 敏感复制历史（内存级，最多 10 条；锁屏/清空即失效） */
  clipboardHistory: () => Promise<{ success: boolean; data?: { enabled: boolean; items: ClipHistoryItem[] } }>;
  clipboardHistoryClear: () => Promise<{ success: boolean }>;
  /** 实际生效的全局快捷键（搜索键被占用时主进程会回退，显示用） */
  hotkeyInfo: () => Promise<{ success: boolean; data?: HotkeyInfo }>;
  /** 修改全局快捷键；冲突时 success:false + error（conflict / same），并回滚到原来能用的键 */
  hotkeyApply: (payload: { search?: string; toggle?: string; quicknote?: string }) => Promise<HotkeyApplyResult>;
  /**
   * 「钉」成独立小窗（一条记录一个置顶窗口）。
   * 传字符串钉网址记录；传 `{ id, kind: 'note' }` 钉测试笔记。
   */
  pinOpen: (payload: string | { id: string; kind?: 'entry' | 'note' }) => Promise<{ success: boolean; error?: string }>;
  /** 小窗关闭自己 */
  pinClose: () => Promise<{ success: boolean; error?: string }>;
  /** 小窗拖拽缩放：透明 frameless 窗口必须走 setBounds，setSize 会被忽略 */
  pinResize: (payload: { w: number; h: number }) => Promise<{ success: boolean; error?: string }>;
  /** 系统通知（点击可跳转到某个页面） */
  appNotify: (payload: { title: string; body?: string; page?: string; silent?: boolean }) => Promise<{ success: boolean; error?: string }>;
  /** 主进程要求跳页（点系统通知时） */
  onAppNavigate: (cb: (payload: { page?: string }) => void) => () => void;
  /** 窗口隐藏时要求关闭命令面板 */
  onCloseCommandPalette: (cb: () => void) => () => void;
  /** 独立搜索小窗每次弹出时要求重取数据 */
  onPaletteRefresh: (cb: () => void) => () => void;
  /** 小窗收起自己 */
  paletteHide: () => Promise<{ success: boolean }>;
  /** 弹出/聚焦小窗（与全局快捷键等价） */
  paletteShow: () => Promise<{ success: boolean; error?: string }>;
  /** 小窗把选中的命令交给主进程（网址带 url → 直接用默认浏览器打开） */
  paletteRun: (item: { id: string; title?: string; url?: string; text?: string }) => Promise<{ success: boolean }>;
  /** 小窗按结果条数调整自身高度 */
  paletteResize: (height: number) => Promise<{ success: boolean }>;
  /** 密码库数据版本：epoch 未变即可复用上次拼好的命令列表 */
  paletteEpoch: () => Promise<{ epoch: number; unlocked: boolean }>;
  /** 小窗里未解锁：让主窗口出来解锁 */
  paletteUnlock: () => Promise<{ success: boolean }>;
  /** 主窗口接收小窗转发的命令 */
  onPaletteRun: (cb: (item: { id: string; title?: string; url?: string; text?: string }) => void) => () => void;
  /** 收起随手记小窗 */
  quicknoteHide: () => Promise<{ success: boolean }>;
  /** 弹出随手记小窗（与全局快捷键等价） */
  quicknoteShow: () => Promise<{ success: boolean; error?: string }>;
  /** 小窗每次弹出时复位临时提示 */
  onQuickNoteFocus: (cb: () => void) => () => void;
  /** 渲染层错误/警告写入主进程 app.log */
  logRenderer: (level: 'warn' | 'error', message: string) => Promise<{ success: boolean }>;
  clipboardClear: () => Promise<{ success: boolean }>;
  onClipboardCleared: (cb: () => void) => () => void;
  /** 托盘菜单「锁定」触发 */
  onLockRequest: (cb: () => void) => () => void;

  // Settings
  /** 自定义背景图：读取当前图（base64） */
  bgGet: () => Promise<{ success: boolean; data?: BgImageInfo; error?: string }>;
  /** 选择一张图片作为背景（主进程压缩后返回 base64） */
  bgChoose: () => Promise<{ success: boolean; data?: BgImageInfo; error?: string; canceled?: boolean }>;
  /** 移除背景图 */
  bgClear: () => Promise<{ success: boolean; error?: string }>;
  settingsGet: () => Promise<AppSettings>;
  settingsSave: (data: Partial<AppSettings>) => Promise<{ success: boolean }>;

  // Password generator
  passwordGenerate: (opts?: PasswordGenOptions) => Promise<{ success: boolean; data?: string; error?: string }>;

  // Backups
  backupList: () => Promise<{ success: boolean; data: BackupFile[]; dir: string; keep?: number; lastAt?: string }>;
  backupStatus: () => Promise<{ success: boolean; data?: { local: { dir: string; files: BackupFile[]; keep: number }; mirror: { dir: string; files: BackupFile[]; lastAt: string; error?: string } }; error?: string }>;
  backupNow: () => Promise<{ success: boolean; data?: { file: string; day: string; mirror: { ok: boolean; skipped?: boolean; dir?: string; path?: string; error?: string }; attachments?: { copied: number; skipped: number; dir?: string } }; error?: string }>;
  backupMirrorPick: () => Promise<{ success: boolean; data?: string; canceled?: boolean; error?: string }>;
  /** 写一条审计日志（复制密码/导出等） */
  auditLog: (action: string, detail?: string) => Promise<{ success: boolean }>;
  auditList: (limit?: number) => Promise<{ success: boolean; data?: AuditEntry[] }>;
  auditClear: () => Promise<{ success: boolean; error?: string }>;
  backupOpenFolder: () => Promise<{ success: boolean; error?: string }>;
  /** 用指定备份覆盖当前库；恢复前会自动留一份 pre-restore 快照 */
  backupRestore: (name: string) => Promise<{ success: boolean; preRestore?: string; attachments?: { copied: number; skipped: number; found: boolean }; error?: string }>;

  // 库自检 / 恢复演练 / 诊断包
  /** 只读体检当前库：结构、悬空标签、丢失附件、孤儿历史 */
  vaultAudit: () => Promise<{ success: boolean; data?: VaultAuditReport; error?: string }>;
  /** 拿一份备份试解 + 体检，不碰正式库 */
  vaultRestoreDrill: (name: string) => Promise<{ success: boolean; data?: RestoreDrillResult; error?: string }>;
  /** 导出诊断包（日志 + 环境 + 自检结果，不含密码与条目内容） */
  logExportDiagnostic: () => Promise<{ success: boolean; canceled?: boolean; data?: { file: string }; error?: string }>;

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
  /** 粘贴截图：把剪贴板里的 dataURL 加密存成附件，返回元数据 */
  attachmentSaveImage: (data: { dataUrl: string; name?: string; scope?: 'note' | 'entry' }) =>
    Promise<{ success: boolean; data?: Attachment; error?: string }>;
  /** 读回图片附件（dataURL），给 <img> 直接显示 */
  attachmentReadImage: (data: { id: string }) =>
    Promise<{ success: boolean; code?: 'missing' | 'not-image'; data?: { dataUrl: string; mime?: string }; error?: string }>;
  /**
   * 附件集中管理：列出附件目录里的全部文件（只有元数据，不含内容）。
   * 1.25.1 起同时列「笔记目录 / 全局目录」两个来源，每条带 `scope`。
   */
  attachmentList: () => Promise<{
    success: boolean;
    data?: AttachmentFileMeta[];
    dir?: string;
    dirExists?: boolean;
    /** 笔记附件目录（`<笔记目录>/attachments`）；未启用目录模式时为空串 */
    notesDir?: string;
    notesDirExists?: boolean;
    error?: string;
  }>;
  /** 解密后另存到用户选的位置 */
  attachmentExport: (data: { id: string; name?: string }) =>
    Promise<{ success: boolean; data?: { file: string }; canceled?: boolean; error?: string }>;
  /**
   * 批量导出到用户选的目录（1.25.0）。
   * 换机/交接时一个个点太慢；主进程按 id 逐个解密后写到目标目录，
   * 重名自动加 -2/-3 后缀，绝不覆盖已有文件。
   */
  attachmentExportMany: (data: { ids: string[] }) => Promise<{
    success: boolean;
    canceled?: boolean;
    data?: { dir: string; exported: number; skipped: number; failed: number; files: string[] };
    error?: string;
  }>;
  /** 在资源管理器里定位附件（不传 id 时打开附件目录） */
  attachmentReveal: (data?: { id?: string }) =>
    Promise<{ success: boolean; data?: { dir: string; file: string }; error?: string }>;
  /** 当前附件目录：是否自定义 / 默认位置 / 是否存在 */
  attachmentDirInfo: () => Promise<{
    success: boolean;
    data?: {
      dir: string;
      defaultDir: string;
      isCustom: boolean;
      exists: boolean;
      /** 笔记附件目录（`<笔记目录>/attachments`）；未启用目录模式时为空串 */
      notesDir?: string;
      notesDirExists?: boolean;
    };
    error?: string;
  }>;
  /** 选一个目录（不立即切换，交给 attachmentSetDir） */
  attachmentPickDir: () => Promise<{ success: boolean; canceled?: boolean; data?: { dir: string }; error?: string }>;
  /**
   * 确保笔记附件目录（`<笔记目录>/attachments`）存在（1.25.1）。
   * 切换笔记目录后由渲染层调一次，用户去资源管理器就能看到 attachments 文件夹。
   */
  attachmentEnsureNoteDir: () => Promise<{
    success: boolean;
    data?: { dir: string; created: boolean; reason?: string };
    error?: string;
  }>;
  /** 切换附件目录（空 dir = 改回默认）：先复制已有附件，成功才切换 */
  attachmentSetDir: (data: { dir?: string }) => Promise<{
    success: boolean;
    data?: { dir: string; from: string; copied: number; skipped: number; reset: boolean };
    error?: string;
  }>;
  /** 非图片附件的文本预览（证书 / 密钥 / 配置） */
  attachmentTextPreview: (data: { id: string }) => Promise<{
    success: boolean;
    code?: 'missing' | 'binary';
    data?: { text: string; size: number; truncated: boolean };
    error?: string;
  }>;

  // 环境巡检（#3）
  envProbe: (data: { targets: Array<{ id: string; url: string }>; timeoutMs?: number }) =>
    Promise<{ success: boolean; data?: EnvProbeData; error?: string }>;
  envOpen: (data: { url: string }) => Promise<{ success: boolean; error?: string }>;

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
  /** WebSocket 连接（1.23.0）：事件从 onWsEvent 推回来 */
  wsConnect: (data: { url: string; headers?: string; insecure?: boolean }) =>
    Promise<{ success: boolean; data?: { id: string }; error?: string }>;
  wsSend: (data: { id: string; data: string }) =>
    Promise<{ success: boolean; data?: { bytes: number }; error?: string }>;
  wsClose: (data: { id: string }) => Promise<{ success: boolean; error?: string }>;
  /** SSE 连接：事件同样从 onWsEvent 推回来 */
  sseConnect: (data: { url: string; headers?: string }) =>
    Promise<{ success: boolean; data?: { id: string }; error?: string }>;
  onWsEvent: (cb: (payload: WsEvent) => void) => () => void;
  zentaoLogin: (cfg: ZentaoConfig) => Promise<{ success: boolean; error?: string }>;
  /** 我提交的 / 待我验证：必须传选中的项目 id（禅道 REST 强制 product，且全量遍历太慢） */
  zentaoMyBugs: (cfg: ZentaoConfig, scope?: MyBugScope, productIds?: string[]) => Promise<{
    success: boolean; data?: ZentaoBug[]; total?: number; queried?: string[]; error?: string;
    /** 服务端未按账号过滤时，主进程会再做一次本地过滤 */
    account?: string; filteredByAccount?: boolean; dropped?: number; scanned?: number; withAccount?: number;
  }>;
  /** fresh=true 绕过主进程 60 秒短时缓存（用户主动刷新时用），并让补漏扫描重扫一次 */
  zentaoProjects: (cfg: ZentaoConfig, fresh?: boolean) => Promise<{
    success: boolean; data?: ZentaoProject[]; total?: number; warning?: string; error?: string;
    /** 命中 60 秒短时缓存时为 true（自动调用才会有）；ageMs = 缓存有多旧 */
    cached?: boolean; ageMs?: number;
    /** 本次通过「按 id 单查」补回来的项目数；reportedTotal = 禅道列表接口自己报的 total */
    probedAdded?: number; reportedTotal?: number;
  }>;
  /** 手动补项目：按编号单查产品（接口没返回已关闭/私有产品时用） */
  zentaoProductProbe: (cfg: ZentaoConfig, productId: string) => Promise<{ success: boolean; data?: ZentaoProject; error?: string }>;
  zentaoProjectBugs: (cfg: ZentaoConfig, productId: string, force?: boolean) =>
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
  /** 多项目缺陷汇总：一次拉取所选项目的全部 Bug（含已关闭）+ 模块名 */
  zentaoSummary: (cfg: ZentaoConfig, productIds: string[], force?: boolean) =>
    Promise<{
      success: boolean;
      data?: ZentaoBug[];
      total?: number;
      /** 产品 id → { 模块 id: 模块路径 } */
      modules?: Record<string, Record<string, string>>;
      productIds?: string[];
      errors?: string[];
      error?: string;
      cached?: boolean;
      ageMs?: number;
      fetchedAt?: string;
    }>;
  /**
   * 跨实例汇总：一次拉多家公司的禅道，返回按实例分组的合并结果。
   * 每条 Bug 额外带 instanceId / instanceName / key（实例id::产品id 复合键）。
   */
  zentaoSummaryMulti: (targets: ZentaoDigestTarget[], force?: boolean) =>
    Promise<{
      success: boolean;
      groups?: ZentaoDigestGroup[];
      failed?: { instanceId: string; name: string; error: string }[];
      total?: number;
      fetchedAt?: string;
      error?: string;
    }>;
  /** 跨实例拉取的进度（当前正在拉第几家） */
  onZentaoDigestProgress: (cb: (p: ZentaoDigestProgress) => void) => () => void;
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
  weeklyReveal: (dir: string, name?: string) => Promise<{ success: boolean; error?: string }>;
  weeklySave: (dir: string, name: string, content: string) =>
    Promise<{ success: boolean; data?: WeeklyFile; error?: string }>;
  weeklyRename: (dir: string, name: string, nextName: string) =>
    Promise<{ success: boolean; data?: { name: string }; error?: string }>;
  weeklyDelete: (dir: string, name: string) => Promise<{ success: boolean; error?: string }>;

  // 用例库（文件管家：收纳 / 打开 / 导出）
  casesConfig: () => Promise<{ success: boolean; data?: { root: string; configured: boolean; exists: boolean }; error?: string }>;
  casesChooseRoot: () => Promise<{ success: boolean; data?: { root: string }; error?: string; canceled?: boolean }>;
  casesChangeRoot: (next: string) =>
    Promise<{ success: boolean; data?: { root: string; moved: number }; error?: string }>;
  casesList: (rel: string) => Promise<{ success: boolean; data?: CasesListing; error?: string }>;
  casesMkdir: (rel: string, name: string) =>
    Promise<{ success: boolean; data?: { name: string }; error?: string }>;
  casesRename: (rel: string, name: string) =>
    Promise<{ success: boolean; data?: { rel: string; name: string }; error?: string }>;
  casesPickFiles: () => Promise<{ success: boolean; data?: string[]; error?: string; canceled?: boolean }>;
  casesImport: (rel: string, files: string[]) =>
    Promise<{ success: boolean; data?: { imported: string[]; failed: string[] }; error?: string }>;
  casesMove: (rel: string, targetRel: string) =>
    Promise<{ success: boolean; data?: { rel: string; name?: string; unchanged?: boolean }; error?: string }>;
  /* ---- 压力测试脚本库 ---- */
  jmxlibConfig: () => Promise<{ success: boolean; data?: { configured: boolean; root: string; items: Record<string, JmxLibMeta> }; error?: string }>;
  jmxlibChooseRoot: () => Promise<{ success: boolean; data?: { root: string }; error?: string; canceled?: boolean }>;
  jmxlibDefaultOut: () => Promise<{ success: boolean; data?: { outDir: string }; error?: string }>;
  jmxlibPickDir: () => Promise<{ success: boolean; data?: { dir: string }; error?: string; canceled?: boolean }>;
  jmxlibCreateTemplate: (rel: string, payload: { name?: string; url: string; method?: string; threads?: number; loops?: number }) =>
    Promise<{ success: boolean; data?: { name: string; rel: string }; error?: string }>;
  jmxlibList: (rel: string) => Promise<{ success: boolean; data?: JmxLibListing; error?: string }>;
  jmxlibPickFiles: () => Promise<{ success: boolean; data?: string[]; error?: string; canceled?: boolean }>;
  jmxlibImport: (rel: string, paths: string[]) =>
    Promise<{ success: boolean; data?: { imported: string[]; failed: string[] }; error?: string }>;
  jmxlibMkdir: (rel: string, name: string) => Promise<{ success: boolean; data?: { name: string }; error?: string }>;
  jmxlibRename: (rel: string, name: string) => Promise<{ success: boolean; data?: { rel: string; name: string }; error?: string }>;
  jmxlibDelete: (rel: string) => Promise<{ success: boolean; error?: string }>;
  jmxlibReveal: (rel: string) => Promise<{ success: boolean; error?: string }>;
  jmxlibOpen: (rel: string) => Promise<{ success: boolean; data?: { how: 'default' | 'open-with' }; error?: string }>;
  jmxlibMetaSet: (rel: string, meta: Partial<JmxLibMeta>) =>
    Promise<{ success: boolean; data?: { meta: JmxLibMeta }; error?: string }>;
  jmxlibValidate: (rel: string) => Promise<{ success: boolean; data?: JmxInspectResult; error?: string }>;
  jmxlibMarkRun: (rel: string, payload: { ok: boolean; reportDir?: string; durationMs?: number; threads?: number; loops?: number; stats?: { samples: number; errors: number; errorPct: number; avg: number } | null }) =>
    Promise<{ success: boolean; error?: string }>;
  casesPreview: (rel: string) => Promise<{ success: boolean; data?: CasesPreview; error?: string }>;
  casesSearch: (q: string, limit?: number) =>
    Promise<{ success: boolean; data?: { hits: CasesSearchHit[] }; error?: string }>;
  casesPickImportDir: () => Promise<{ success: boolean; data?: string; error?: string; canceled?: boolean }>;
  casesImportFolder: (rel: string, dir: string) =>
    Promise<{ success: boolean; data?: { name: string; files: number }; error?: string }>;
  /** 用例库文件变更（外部新增/改名/编辑），返回取消订阅函数 */
  onCasesChanged: (cb: () => void) => () => void;
  casesDelete: (rel: string) => Promise<{ success: boolean; error?: string }>;
  casesOpen: (rel: string) =>
    Promise<{ success: boolean; data?: { how: 'default' | 'open-with' }; error?: string }>;
  casesOpenWith: (rel: string) =>
    Promise<{ success: boolean; data?: { how: 'open-with' }; error?: string }>;
  casesReveal: (rel: string) => Promise<{ success: boolean; error?: string }>;
  casesPickDir: () => Promise<{ success: boolean; data?: string; error?: string; canceled?: boolean }>;
  casesPickExportDir: () => Promise<{ success: boolean; data?: string; error?: string; canceled?: boolean }>;
  casesExport: (rels: string[], dest: string) =>
    Promise<{ success: boolean; data?: { exported: string[]; failed: string[]; dest: string }; error?: string }>;

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
  /** 下载新版本安装包（进度通过 onUpdateProgress 推送）；第 2 个参数 true = 多线程加速重试 */
  updateDownload: (url: string, accelerate?: boolean, opts?: { expectedSha256?: string; threads?: boolean }) => Promise<{
    success: boolean;
    data?: { file: string; name?: string; size: number; via?: string; threads?: number; sha256?: string; verified?: boolean };
    error?: string;
    canMirror?: boolean;
    detail?: string;
  }>;
  /** 选任意文件（上传附件） */
  pickFile: (title?: string, filters?: { name: string; extensions: string[] }[]) =>
    Promise<{ success: boolean; data?: { file: string; name: string }; error?: string; canceled?: boolean }>;
  /** 读文本文件（脱敏工具按列处理；只允许 csv/tsv/txt/json/log/md/sql，上限 8MB；自动嗅探 UTF-8 / GBK） */
  readTextFile: (file: string, maxBytes?: number) =>
    Promise<{
      success: boolean;
      data?: { text: string; name: string; size: number; encoding?: string; encodingLabel?: string };
      error?: string;
    }>;
  // JMeter（非 GUI 运行）
  jmeterDetect: () => Promise<{ success: boolean; data?: JmeterDetectInfo; error?: string }>;
  jmeterPickExe: () => Promise<{ success: boolean; data?: { jmeterPath: string }; error?: string; canceled?: boolean }>;
  jmeterPickScript: () => Promise<{ success: boolean; data?: { jmxPath: string; name: string }; error?: string; canceled?: boolean }>;
  jmeterPickJavaHome: () => Promise<{ success: boolean; data?: { javaHome: string; version: string }; error?: string; canceled?: boolean }>;
  /** 预检 .jmx 是否支持 -J 覆盖线程数/循环次数 */
  jmeterInspectScript: (jmxPath: string) => Promise<{ success: boolean; data?: { supportsThreads: boolean; supportsLoops: boolean; ok: boolean; error?: string }; error?: string }>;
  /** JMeter 运行历史（最近的在前） */
  /* ---- 在线代码调试（本机执行） ---- */
  codelabDetect: () => Promise<{ success: boolean; data?: CodelabDetect }>;
  codelabRun: (payload: { lang: string; code: string; timeoutMs?: number }) => Promise<{ success: boolean; data?: CodelabDone; error?: string }>;
  codelabStop: () => Promise<{ success: boolean; data?: { stopped: boolean; pid?: number } }>;
  /** HTML 预览：把 HTML 交给主进程，换回一个 codelab:// 地址给 iframe 用 */
  codelabPreview: (html: string) => Promise<{ success: boolean; data?: { url: string; id: string }; error?: string }>;
  onCodelabOutput: (cb: (line: { runId: string; stream: string; line: string }) => void) => () => void;
  onCodelabMeta: (cb: (d: { runId: string; file: string }) => void) => () => void;
  onCodelabDone: (cb: (d: CodelabDone) => void) => () => void;
  jmeterHistory: () => Promise<{ success: boolean; data?: JmeterHistoryRecord[] }>;
  jmeterHistoryClear: () => Promise<{ success: boolean }>;
  jmeterPickOutDir: () => Promise<{ success: boolean; data?: { outDir: string }; error?: string; canceled?: boolean }>;
  jmeterDefaults: () => Promise<{ success: boolean; data?: { jmeterPath: string; javaHome?: string; outDir: string; jmxPath: string; appVersion: string } }>;
  jmeterRemember: (patch: { jmxPath?: string; outDir?: string }) => Promise<{ success: boolean }>;
  jmeterRun: (opts: JmeterRunOptions) => Promise<{ success: boolean; data?: { runId: string; jtlPath: string; reportDir: string; args: string[] }; error?: string }>;
  jmeterStop: () => Promise<{ success: boolean; error?: string }>;
  jmeterStatus: () => Promise<{ success: boolean; data?: { runId: string } | null }>;
  jmeterOpenPath: (target: string) => Promise<{ success: boolean; error?: string }>;
  // 应用日志（排障用：出问题让用户点「打开日志」即可）
  /** 旧版本数据恢复（改名后新库已建、旧库仍在时用） */
  dataLegacyInfo: () => Promise<{ success: boolean; data?: { legacyDir: string; found: string[]; currentHasVault: boolean } }>;
  dataRecoverLegacy: () => Promise<{ success: boolean; data?: { from: string; copied: number; backup: string }; error?: string }>;
  appRelaunch: () => Promise<{ success: boolean }>;
  logInfo: () => Promise<{ success: boolean; data?: { path: string } }>;
  logOpen: () => Promise<{ success: boolean; data?: { path: string }; error?: string }>;
  logTail: (lines?: number) => Promise<{ success: boolean; data?: { path: string; text: string } }>;
  /** 启动检查发现新版本时主进程推过来（应用内提示用，不发系统通知） */
  onUpdateAvailable: (cb: (payload: { current: string; latest: string; url: string; downloadUrl: string; notes?: string; assetName?: string; digest?: string }) => void) => () => void;
  onJmeterOutput: (cb: (payload: JmeterLogLine) => void) => () => void;
  onJmeterDone: (cb: (payload: JmeterDone) => void) => () => void;
  /** 保存文本到文件（导出 CSV 等），自动加 BOM */
  saveText: (content: string, defaultName: string, filters?: { name: string; extensions: string[] }[]) =>
    Promise<{ success: boolean; data?: { file: string }; error?: string; canceled?: boolean }>;
  /** 手动选择已下载的安装包（网络下不动时的兜底） */
  updatePickFile: () => Promise<{ success: boolean; data?: { file: string; size: number }; error?: string; canceled?: boolean }>;
  /** 启动静默安装并退出应用 */
  updateInstall: (file: string) => Promise<{ success: boolean; error?: string }>;
  onUpdateProgress: (cb: (p: { received: number; total: number; speed?: number; threads?: number; proxy?: string; link?: string }) => void) => () => void;

  // Import
  importCsvJson: (data: { filePath: string }) => Promise<{ success: boolean; data?: any[]; error?: string; raw?: boolean }>;
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
  /** 拖入文件的真实路径（Electron 32+ 不再提供 File.path，需经 webUtils 转换） */
  filePathFor?: (file: File) => string;
  fileWrite: (data: { filePath: string; content: string; encoding?: string }) => Promise<{ success: boolean; error?: string }>;

  // App
  appGetPath: (name: string) => Promise<string>;

  // Browser
  browserDetect: () => Promise<{ id: string; name: string }[]>;
  browserGetKnown: () => Promise<{ id: string; name: string }[]>;
  browserOpen: (data: { browser: string; url: string }) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}



/** 用例库：全库搜索结果 */
export interface CasesSearchHit {
  name: string;
  rel: string;
  size: number;
  mtime: string;
  ext: string;
  /** 所在目录（相对库根） */
  dir: string;
}

/** 用例库：预览结果 */
export type CasesPreview =
  | { kind: 'text' | 'markdown'; text: string; encoding: string; size: number; name: string }
  | { kind: 'csv'; text: string; rows: string[][]; encoding: string; size: number; name: string }
  | { kind: 'table'; sheets: { name: string; rows: string[][]; more: boolean }[]; size: number; name: string }
  | { kind: 'image'; dataUrl: string; size: number; name: string }
  | { kind: 'binary'; size: number; ext: string; name: string }
  | { kind: 'too-large'; size: number; name: string };




/** 压力测试脚本库：目录 */
export interface JmxLibDir {
  name: string;
  rel: string;
  mtime: string;
  /** 该目录下的 .jmx 数量 */
  jmxCount: number;
}

/** 压力测试脚本库：一次运行记录 */
export interface JmxLastRun {
  at: string;
  ok: boolean;
  reportDir: string;
  durationMs: number;
  threads?: number;
  loops?: number;
}

/** 压力测试脚本库：每个脚本记住的默认参数 */
export interface JmxRun {
  at: string;
  ok: boolean;
  samples: number;
  errors: number;
  /** 错误率（百分比，保留 1 位） */
  errorPct: number;
  /** 平均响应时间（ms） */
  avg: number;
  /** 吞吐量（样本数 / 秒） */
  tps: number;
  durationMs: number;
  reportDir: string;
}
export interface JmxLibMeta {
  /** 脚本里  的值 */
  params?: Record<string, string>;
  /** 最近 20 次运行（趋势图用） */
  runs?: JmxRun[];
  /** 输出目录（运行时会在这下面建 report-<时间戳>） */
  outDir?: string;
  threads?: number;
  loops?: number;
  note?: string;
  lastRun?: JmxLastRun;
}

/** 压力测试脚本库：脚本文件 */
export interface JmxLibFile {
  name: string;
  rel: string;
  size: number;
  mtime: string;
  meta: JmxLibMeta;
}

export interface JmxLibListing {
  configured: boolean;
  root: string;
  rel: string;
  dirs: JmxLibDir[];
  files: JmxLibFile[];
}

/** 脚本静态检查结果 */
export interface JmxDataFile {
  path: string;
  abs: string;
  exists: boolean;
  bytes: number;
  /** 行数（只读前 8MB） */
  lines: number;
}
export interface JmxInspectResult {
  files: JmxDataFile[];
  ok: boolean;
  error: string;
  testName: string;
  threadGroups: number;
  threadsDefault: number | null;
  loopsDefault: number | null;
  params: { name: string; value: string }[];
  dataFiles: string[];
  missingFiles: string[];
}






/** 背景图信息（主进程压缩后返回） */
export interface BgImageInfo {
  configured: boolean;
  name?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
  bytes?: number;
  original?: { width: number; height: number };
}
