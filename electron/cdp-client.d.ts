/**
 * 声明文件：让渲染层单测可以 import electron/cdp-client.js（契约 `[C-14]`）。
 *
 * **目标发现是 cdp-client 的唯一职责**（契约 v20）：会话层只给 `port`
 * （来自 `<profile>/DevToolsActivePort` 的**第一行**），由本模块自己
 * `GET http://127.0.0.1:<port>/json/list` 取 **page target** 的 `webSocketDebuggerUrl` 再连
 * ——会话层**不得**自己写 `/json/list`、不得自己拼 `ws://`、不得私有 attach（两处实现必然漂移）。
 *
 * 路线选择：**`/json/list`（不做 attach）**。理由：它是既有真源（`scripts/lib/cdp.js`，28 个回归脚本在用），
 * 一次 HTTP 就拿到 page 目标、不用维护 sessionId 生命周期；`Target.attachToTarget({flatten:true})`
 * 只为未来「多 tab」留口子。
 */

export type CdpMessage =
  | { kind: 'response'; id: number | string; result: any; error: null }
  | { kind: 'response'; id: number | string; result: undefined; error: { code: number; message: string } }
  | { kind: 'event'; method: string; params: Record<string, unknown> }
  | { kind: 'invalid' };

/** 页内异常的**唯一载荷形状**（SEC-R2-05）：只有类型名与长度，**不含任何页面原文** */
export interface CdpPageException {
  /** 白名单化的异常类型名（非白名单归一成 `'Error'`） */
  name: string;
  /** 原始 description 的字符数（数字本身不泄露内容） */
  length: number;
}

export interface CdpCallOptions {
  timeout?: number;
  /**
   * `Session.send` 形态：browser 端点 + `Target.attachToTarget({ flatten:true })` 之后
   * **必须**带，否则 page 作用域方法回 `-32601`。直连 page target 时不需要。
   */
  sessionId?: string;
}

export interface CdpWaitSpec {
  /** 常量函数声明；参数走 `args`（禁止把外部输入拼进源码） */
  fn: string;
  args?: unknown[];
  desc?: string;
  timeout?: number;
  interval?: number;
  throwOnTimeout?: boolean;
}

/** `/json/list` 里的一条调试目标 */
export interface CdpTarget {
  id?: string;
  type: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpSession {
  /** 实际连上的 ws 地址（给了 port 时是 **page target** 的地址） */
  wsUrl: string;
  /** page target 的 id（给了 port 时才有） */
  targetId: string;
  /** 连的是不是 page target 端点：`false` = browser 端点（**不会**自动 enable） */
  pageScoped: boolean;
  /** 页面未捕获异常，**只出 `{ name, length }`**（SEC-R2-05） */
  errors: CdpPageException[];
  send(method: string, params?: object, opts?: CdpCallOptions): Promise<any>;
  evaluate(expression: string, opts?: CdpCallOptions & { throwOnException?: boolean }): Promise<any>;
  callFunctionOn(objectId: string, fnDeclaration: string, args?: unknown[], opts?: CdpCallOptions): Promise<any>;
  callWithArgs(fnDeclaration: string, args?: unknown[], opts?: CdpCallOptions): Promise<any>;
  waitFor(spec: CdpWaitSpec | string, opts?: { timeout?: number; interval?: number; throwOnTimeout?: boolean }): Promise<boolean>;
  close(): void;
}

export declare class CdpTimeoutError extends Error {
  constructor(ms: number, what: string);
  timeoutMs: number;
  what: string;
}

export const COMMAND_TIMEOUT_MS: number;
export const WAIT_POLL_MS: number;
/** `/json/list` 的单次超时（本机回环，超过它就是浏览器没起来） */
export const TARGET_DISCOVERY_TIMEOUT_MS: number;
export const OBJECT_GROUP: string;

export declare function sleep(ms: number): Promise<void>;
export declare function encodeCommand(id: number, method: string, params?: object, sessionId?: string): string;
export declare function decodeMessage(raw: unknown): CdpMessage;
/** `ws://…/devtools/browser/<id>` → true（browser 端点只提供 Browser/Target/SystemInfo 域） */
export declare function isBrowserEndpoint(wsUrl: string): boolean;
export declare function listTargets(port: number, opts?: { fetchImpl?: any; discoveryTimeout?: number }): Promise<CdpTarget[]>;
/** 从 `/json/list` 里挑 page target（排除 devtools 自建页与没有 ws 地址的条目） */
export declare function pickPageTarget(list: unknown): CdpTarget | null;
export declare function resolvePageTarget(opts: { port: number; fetchImpl?: any; discoveryTimeout?: number }): Promise<CdpTarget & { webSocketDebuggerUrl: string }>;

/**
 * 连一个 CDP 会话（两步：`/json/list` → page target → 再 enable）。
 *
 * 给了 `port` 就忽略 `wsUrl`（以 port 为准）；只给 `wsUrl` 是**底层能力**，
 * 连到 browser 端点时不会自动 enable（`pageScoped === false`）。
 */
export declare function connect(opts: {
  /** 生产路径：DevToolsActivePort 第一行的端口，由本模块自己发现 page target */
  port?: number;
  /** 底层能力：直接给 ws 地址（连到 browser 端点时不会自动 enable） */
  wsUrl?: string;
  timeout?: number;
  discoveryTimeout?: number;
  /** 单测注入（默认用运行时自带 fetch） */
  fetchImpl?: any;
  /** 单测注入（默认用运行时自带 WebSocket） */
  WebSocketImpl?: any;
  /** 页面异常回调：**只有 `{ name, length }`**，不带原文 */
  onException?: (exception: CdpPageException) => void;
}): Promise<CdpSession>;
