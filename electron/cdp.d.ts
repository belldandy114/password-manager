/**
 * 声明文件：让渲染层单测可以 import electron/cdp.js（元素库 A₂ 的极简 CDP 客户端）。
 *
 * 只出纯数据类型：不带 Node 类型（tsconfig `types: []`）。
 */

export const DEFAULT_TIMEOUT_MS: number;

/** 允许发出的 CDP 方法（[A2-7] 白名单，多一个即不通过） */
export const CDP_METHODS: string[];

/** 挑 page target 的规则（顺序即优先级；与 scripts/lib/cdp.js 的 pick 逐项相等，单测锁死） */
export const PAGE_TARGET_RULES: string[];

export function isAllowedMethod(method: string): boolean;
export function isClosedError(err: unknown): boolean;
export function cdpError(message: string, code: string, extra?: Record<string, unknown>): Error & { code: string };

export interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * 纯函数：从 `/json/list` 的返回里挑第一个页面 target。
 *
 * `[SEC-03]`：除三条形态规则外还要求 `target.url` 与 `expectedUrl` **同源**（scheme+host+port 全等）；
 * `expectedUrl` 缺失/非法时**一律不选**（返回 null）—— 不许「挑一个先连上再 navigate」。
 */
export function pickPageTarget(list: CdpTarget[] | null | undefined, expectedUrl?: string): CdpTarget | null;

/** `scheme//host:port` 归一；非法/空（含非 http/https）→ '' */
export function originOf(value: unknown): string;

export function discoverPageTarget(
  port: number,
  opts?: { timeout?: number; fetch?: unknown; expectedUrl?: string }
): Promise<
  | { ok: true; target: CdpTarget }
  | { ok: false; error: string; code: string }
>;

export interface CdpClient {
  url: string;
  closed: boolean;
  closeReason: string;
  pendingCount: number;
  send: (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  /** 同一事件同时只允许 1 个等待者（单等待者语义） */
  waitFor: (method: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

export function attach(
  wsUrl: string,
  options?: { timeout?: number; WebSocketImpl?: unknown; onClose?: (reason: string) => void; allow?: string[] }
): Promise<CdpClient>;

export function closeBrowser(
  port: number,
  browserWsPath: string,
  opts?: { timeout?: number; WebSocketImpl?: unknown }
): Promise<{ ok: boolean; maybe?: boolean; error?: string }>;
