/**
 * 声明文件：让渲染层单测可以 `import` `electron/record-session.js`（契约 `[C-14]`）。
 *
 * 会话管理器是工厂：`createRecordSession(deps)`，`deps` 里可注入 spawn / fs / clock /
 * 进程表 / CDP 连接 / 探针，单测因此不起真 Chrome、不写真盘、不真等 15 秒。
 * 主进程调用时**不传 deps**（走真实实现）。
 */

export interface RecordProcessRow {
  pid: number;
  /** 完整命令行（杀前双校验用：必须含本会话的 `--user-data-dir`） */
  commandLine: string;
  /** 进程创建时间（毫秒时间戳） */
  creationDate: number;
}

export interface RecordValueMetaLength {
  length: number;
  redacted: true;
}

export interface RecordValueMetaIndex {
  selectedIndex: number;
  redacted: true;
}

/** `valueMeta` 只有两种形状（契约 §9.1 / v19 四条不变量之 3），不允许第三种 */
export type RecordValueMeta = RecordValueMetaLength | RecordValueMetaIndex;

export interface RecordEventTarget {
  /** ≤ 32 字符（主进程强制点，超长截断） */
  tag: string;
  /** ≤ 64 字符 */
  role?: string;
  /** ⚠️ 不存在 text 字段：页面上可见文本一律不转发（可能是手机号 / 身份证 / token） */
}

export interface RecordCandidate {
  strategy: 'css' | 'xpath' | 'text' | 'role';
  selector: string;
  count: number | null;
  precise: boolean;
  roleName?: string;
}

/** `record:event` 推送的载荷 */
export interface RecordEvent {
  sessionId: string;
  seq: number;
  action: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'assert' | 'session-ended';
  target: RecordEventTarget;
  candidates: RecordCandidate[];
  ms: number;
  valueMeta?: RecordValueMeta;
}

/** `record:status` 的出参（无活会话时为 `null`） */
export interface RecordStatus {
  sessionId: string;
  state: 'recording';
  startedAt: string;
  /** 只回脱敏后的 origin + path（不带 userinfo / query / fragment） */
  url: string;
}

/**
 * 删 profile 失败的原因（契约 v23）：`code` 是短标识（`EPERM` / `EBUSY` / `NO_DIR` …），
 * `item` 只放 `Default/Cookies` 这类**相对子项**，绝不含绝对路径。
 * 同一形状同时出现在三处：`stop` 出参 `cleaned.profileRemovedError`、
 * **审计条目的可选字段** `profileRemovedError`（仅 `profileRemoved:false` 时出现）、app.log 文本。
 */
export interface RecordProfileRemovedError {
  code: string;
  item: string;
}

export interface RecordCleaned {
  killed: boolean;
  profileRemoved: boolean;
  /**
   * 删 profile 失败时**才出现**的占用原因（t33 / D-2）：Windows 上目录被进程占着时给 `EPERM`/`EBUSY`
   * 与**被占的哪个子项**（相对 profile 目录，不含绝对路径）。
   * ⚠️ 不写进审计：契约 `[C-119]` 第 7 款的字段集是固定的 13 个，多一个键就算改契约。
   */
  profileRemovedError?: {
    code: string;
    /** 相对 profile 目录的子项路径（如 `Default/Cookies`）；取不到时为空串 */
    item: string;
    syscall: string;
    /** 已把 profile 绝对路径替换成 `<profile>` 的原始错误文案 */
    message: string;
  };
}

export interface RecordValidateItem {
  strategy: 'css' | 'xpath' | 'text' | 'role';
  selector: string;
}

export interface RecordValidateResult {
  strategy: string;
  selector: string;
  count: number;
  precise: boolean;
  ms: number;
  invalid?: true;
  error?: string;
}

export interface RecordSessionDeps {
  spawn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => any;
  fs?: {
    existsSync(p: string): boolean;
    readFileSync(p: string, enc?: string): string;
    mkdirSync(p: string, opts?: Record<string, unknown>): unknown;
    rmSync(p: string, opts?: Record<string, unknown>): unknown;
  };
  clock?: {
    now(): number;
    sleep(ms: number): Promise<void>;
    /** 同步睡（锁定 / 关窗 / 应用退出这条同步路径用；`Atomics.wait` 实现） */
    sleepSync?(ms: number): void;
    setInterval(fn: () => unknown, ms: number): any;
    clearInterval(id: any): void;
  };
  /** 进程是否还活着（默认 `process.kill(pid, 0)`；**不用进程表**：PowerShell 枚举在 stop 热路径上太慢） */
  isProcessAlive?: (pid: number) => boolean;
  /** 排障日志出口（默认 console.log；app.log 由 main.js 注入） */
  log?: (line: string) => void;
  platform?: string;
  env?: Record<string, string | undefined>;
  which?: (name: string) => string;
  exists?: (p: string) => boolean;
  randomBytes?: (n: number) => { toString(enc: string): string };
  listProcesses?: () => RecordProcessRow[];
  /**
   * CDP 连接工厂。**只传 `{ port }`**（来自 `DevToolsActivePort` 第一行）：
   * 目标发现（`GET /json/list` → page target 的 `webSocketDebuggerUrl`）是 `cdp-client` 的唯一职责，
   * 会话层不拼 `ws://`、不碰 browser 端点（契约 v21）。`wsUrl` 兼容值已于 t20 删除。
   */
  connectCdp?: (opts: { port: number; timeout?: number }) => Promise<any>;
  probeAbilities?: (input?: object) => any;
  getDataDir?: () => string;
  getPassword?: () => string | null;
  getMainWindow?: () => any;
  appendAudit?: (entry: Record<string, unknown>) => void;
  onEvents?: (events: RecordEvent[]) => void;
  limits?: {
    startTimeoutMs?: number;
    flushMs?: number;
    pollBatch?: number;
    maxEvents?: number;
    validateItemMs?: number;
    validateTotalMs?: number;
    /** 停录时等进程树退出的上限（默认 800 ms / 50 ms 轮询） */
    exitWaitMs?: number;
    exitPollMs?: number;
    /** 同步路径（lockStop）愿意阻塞的上限（默认 250 ms） */
    syncExitWaitMs?: number;
    /** 删 profile 的有界重试间隔（默认 [0, 120, 240] ms） */
    profileRetryDelays?: number[];
  };
}

export interface RecordSession {
  start(input: { url?: unknown; pageId?: unknown }): Promise<{
    ok: boolean;
    /**
     * 成功时：`browser` 是**展示名**（`Chrome` / `Edge` / `Brave` / `Chromium` …），
     * **不含任何目录**——本机绝对路径只进 app.log（RA3-07）。字段名保持不变（契约 §9.2 的通道表）。
     */
    data?: { sessionId: string; browser: string; port: number };
    error?: string;
    detail?: string;
  }>;
  /**
   * 停录（幂等）。两种失败语义要分清：
   *
   * - `starting` 窗口内（start 还没走完、`session` 仍为 null）→ **`启动进行中，请稍候重试`**
   *   （契约 §9.2 已有串，不新增），同时置内部 `cancelStart`：这一轮 start 会在下一个检查点
   *   **真中止**（杀进程 + 删目录 + 写审计），**不会出现「回了拒绝、后台继续录」**（R3-04）。
   *   用户看到的是「没停成，稍后再点」，而不是「显示已停止、实际在录」。
   * - 会话 id 不在最近 `RECENT_STOP_LIMIT` 个幂等记录里 → `会话已结束`（有界幂等，见该常量注释）。
   */
  stop(input: { sessionId?: unknown }): Promise<{
    ok: boolean;
    data?: {
      ok: true;
      received: number;
      pushed: number;
      dropped: number;
      truncated: boolean;
      cleaned: RecordCleaned;
    };
    error?: string;
  }>;
  status(): RecordStatus | null;
  validate(input: { sessionId?: unknown; items?: unknown }): Promise<{
    ok: boolean;
    data?: { results: RecordValidateResult[] };
    error?: string;
  }>;
  /** 主进程内部动作名（**不是** preload 通道）：锁定 / 自动锁 / 关窗 / 防截屏即停录 */
  lockStop(reason?: string): { ok: boolean; killed: boolean; profileRemoved: boolean };
  /**
   * 启动扫残留（`[C-117]` 第 3 条）：杀匹配到的残留进程**并删它们的 profile 目录**，
   * 另外清掉「进程早没了但目录还在」的残留（只认 24 位十六进制的 sessionId 目录名）。
   */
  scanOrphans(): Promise<{ scanned: number; killed: number; failed: number; removed: number; errors: string[] }>;
  probe(input?: { workspaceDir?: string; force?: boolean }): any;
  getState(): 'idle' | 'starting' | 'recording' | 'stopping';
  dispose(): void;
}

export const AUDIT_ACTION: string;
export const MAX_EVENTS: number;
export const FLUSH_MS: number;
export const POLL_BATCH: number;
/**
 * 取页内事件的**常量**表达式（含 `__dshQueueTake` 被替换检测，SEC-R3-07）：
 * 标记不符时返回 {@link TAKE_TAMPERED} 哨兵串，由会话层收敛停录。
 */
export const POLL_EXPR: string;
/** 取事件通道被页面换掉时的哨兵串（不是数组 → 会话层判定篡改并收敛） */
export const TAKE_TAMPERED: string;
/**
 * 页内注入物**整个不见了**时的哨兵串（D-4）：`typeof !== 'function'` 或标记缺失。
 *
 * 与 {@link TAKE_TAMPERED} 是两件事：**不见了 = 文档换了（导航）→ 重新注入继续录**；
 * **还在但标记不符 = 真被换掉 → 收敛停录 + 写审计**。
 */
export const TAKE_MISSING: string;
/** 每会话最多重新注入几次（页面每次导航重注入一次是正常的；超限则收敛） */
export const MAX_REINSTALL: number;
/** 探「页面就绪」的常量表达式（注入前必须等到目标文档，D-4 根因修法） */
export const PAGE_READY_EXPR: string;
/** 停止前排空页内队列的预算（≤200 ms，RA3-02） */
export const DRAIN_BUDGET_MS: number;
/** 排空最多轮数（与预算双保险，防死循环） */
export const MAX_DRAIN_ROUNDS: number;
export const PROFILE_ROOT_NAME: string;
export const START_TIMEOUT_MS: number;
/**
 * 幂等 stop 的窗口：**进程生命周期内、最近 N 个 sessionId**（默认 5，R3-09）。
 * 超出窗口的老 id 回 `会话已结束`；这是已知取舍（不把幂等状态写进盘），契约侧由 t37 标注。
 */
export const RECENT_STOP_LIMIT: number;
export const PORT_POLL_MS: number;
/** 停录时等进程树退出的上限（D-2：删目录必须发生在进程真的消失之后） */
export const EXIT_WAIT_MS: number;
/** 删 profile 的有界重试间隔（0 / 120 / 240 ms；不是「无限重试」） */
export const PROFILE_RETRY_DELAYS: number[];
export const VALIDATE_ITEM_TIMEOUT_MS: number;
export const VALIDATE_TOTAL_TIMEOUT_MS: number;
export const MAX_VALIDATE_ITEMS: number;
export const MAX_SELECTOR_LENGTH: number;
export const VALIDATE_STRATEGIES: string[];
export const PAGE_ACTIONS: string[];
export const MAX_CANDIDATES: number;
export const QUEUE_FN_SRC: string;

export declare function parseProcessList(text: unknown): RecordProcessRow[];
export declare function sanitizeValueMeta(input: unknown): RecordValueMeta | undefined;
/** 审计 `profileRemovedError.code` 的清洗（只留 `[A-Za-z0-9_-]`，≤32） */
export declare function sanitizeAuditCode(raw: unknown): string;
/** 审计 `profileRemovedError.item` 的清洗（相对子项；含盘符/绝对路径/`..` 一律清空） */
export declare function sanitizeAuditItem(raw: unknown): string;
export declare function sanitizeCandidates(list: unknown): RecordCandidate[];
export declare function sanitizeTarget(input: unknown): RecordEventTarget | null;
export declare function normalizeEvent(raw: unknown): Omit<RecordEvent, 'sessionId' | 'seq'> | null;
export declare function nonceOf(sessionId: string): string;
/**
 * 「本机可能装在哪」的候选清单：**真源是 `ipc-browser.js` 的 `KNOWN_BROWSERS`**（R3-10），
 * 本函数只按注入的 `deps.env` / `platform` 重新生根，不再自己维护一份路径表。
 */
export declare function browserCandidates(deps: { platform?: string; env?: Record<string, string | undefined> }): string[];
export declare function findBrowser(deps: RecordSessionDeps): string;
/**
 * 浏览器可执行文件 → **展示名**（RA3-07）。`record:start` 的出参只用它，
 * 绝对路径不出主进程；认不出时回可执行文件名（仍不含目录）。
 */
export declare function browserLabel(exePath: unknown): string;
/**
 * tick 守卫（R3-07）：同时兜住「同步抛」与「promise reject」，把异常交给 `onError`；
 * `onError` 自己抛错也不会冒泡出去。
 */
export declare function guardTick(run: () => unknown, onError: (err: unknown) => void): void;
export declare function createRecordSession(deps?: RecordSessionDeps): RecordSession;

