/**
 * 声明文件：让渲染层单测可以 `import` `electron/record-args.js`（契约 `[C-14]`）。
 *
 * 返回形状统一用「ok + 可选字段」而不是判别式联合：单测里常见
 * `expect(r.ok).toBe(true); expect(r.url).toBe(…)` 的写法，断言不会收窄类型，
 * 写成联合会让 tsc 报「属性不存在」。
 */

export type RecordArgsError = { ok: false; error: string; detail: string };

export interface RecordUrlResult {
  ok: boolean;
  error?: string;
  detail?: string;
  /** 脱敏后的完整 URL（无 userinfo、无 fragment；query 只在「键白名单 + 值过值级校验」时保留，否则整条丢弃） */
  url?: string;
  /** origin + path（`record:status` 与生成物只许用这个） */
  baseUrl?: string;
  origin?: string;
  /** `URL.host`（审计只记这个，见契约 `[C-119]` 第 7 款） */
  host?: string;
  path?: string;
}

export interface UserDataDirResult {
  ok: boolean;
  /** 归一化成正斜杠、去掉尾部斜杠的绝对路径 */
  dir?: string;
  /**
   * 是否真的做了「在数据目录下」的包含性校验：`checked` = 传了 dataDir 且通过；
   * `skipped` = 调用方没给 dataDir，**只做了绝对路径 / UNC / `..` 三项检查**（不假装查过）。
   */
  containment?: 'checked' | 'skipped';
  error?: string;
  detail?: string;
}

export interface ChromeArgsResult {
  ok: boolean;
  /** 只产出数组：调用方必须 `spawn(exe, args, { shell: false })` */
  args?: string[];
  /** 是否真的做了「profile 在数据目录下」的包含性校验（`skipped` = 调用方没给 dataDir） */
  containment?: 'checked' | 'skipped';
  error?: string;
  detail?: string;
}

export interface DevToolsActivePortResult {
  ok: boolean;
  /** **只有第一行的端口**；第二行的 browser 端点绝不回给调用方 */
  port?: number;
  error?: string;
  detail?: string;
}

export interface AllowedFlagSpec {
  name: string;
  /** 带值的 flag 的单测样例值 */
  sample?: string;
  valuePattern?: RegExp;
}

export const MAX_URL_LENGTH: number;
export const ALLOWED_SCHEMES: string[];
export const DENIED_SCHEMES: string[];
export const QUERY_WHITELIST: string[];
/** 白名单键值的长度上限（SEC-R2-01） */
export const MAX_QUERY_VALUE_LENGTH: number;
/** `record:validate` 入参上限：items ≤ 50 / selector ≤ 500 字符 */
export const MAX_VALIDATE_ITEMS: number;
export const MAX_SELECTOR_LENGTH: number;
/** 校验策略枚举：css / xpath / text / role */
export const VALIDATE_STRATEGIES: string[];
export const ALLOWED_FLAGS: AllowedFlagSpec[];

/** 两个用途共用的安全校验段（类型/长度/`-` 开头/控制字符/scheme/主机名），不碰 query 与 fragment */
export declare function checkUrlShape(raw: unknown): { ok: boolean; parsed?: URL; error?: string; detail?: string };
/**
 * **入库用 URL**：剥 userinfo、query 白名单 + 值级校验、丢 fragment。
 * 落库 / 审计 / 三产物 / `record:status` 用它。
 */
export declare function urlForStorage(raw: unknown): RecordUrlResult;
/**
 * **启动用 URL**（RA2-03）：保留业务 query 与 fragment、只剥 userinfo。
 * ⚠️ 返回值只许进 `spawn` 的参数数组：禁止回渲染层 / 入库 / 进日志。
 */
export declare function urlForLaunch(rawUrl: unknown): {
  ok: boolean;
  url?: string;
  origin?: string;
  host?: string;
  error?: string;
  detail?: string;
};
/** `record:validate` 入参校验的唯一真源（RA2-06：从 record-session.js 搬来） */
export declare function validateSelectorItems(items: unknown): {
  ok: boolean;
  items?: Array<{ strategy: string; selector: string }>;
  error?: string;
};
export declare function validateUserDataDir(dir: unknown, opts?: { dataDir?: unknown }): UserDataDirResult;
/** 白名单键的值级校验：长度 ≤200、不含 `://` / `@`、不是 11–19 位纯数字或 18 位身份证（SEC-R2-01） */
export declare function isSafeQueryValue(value: string): boolean;
export declare function matchAllowedFlag(flag: string): AllowedFlagSpec | null;
export declare function buildChromeArgs(input: {
  url: unknown;
  userDataDir: unknown;
  flags?: unknown;
  /** 应用数据目录：给了才做「profile 必须在数据目录下」的包含性校验（SEC-R2-03） */
  dataDir?: unknown;
}): ChromeArgsResult;
/**
 * 只回**第一行的端口**。第二行的 `/devtools/browser/<id>` 是 browser 端点（只挂 Browser/Target/
 * SystemInfo 域），连它再发 `Runtime.enable` 会回 `-32601` —— 本函数**不返回**任何可连接地址，
 * 目标发现（`GET /json/list` → page target）是 `cdp-client` 的唯一职责。
 */
export declare function parseDevToolsActivePort(text: unknown): DevToolsActivePortResult;

