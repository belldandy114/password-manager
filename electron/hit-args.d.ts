/**
 * 声明文件：让渲染层单测可以 import electron/hit-args.js（元素库 A₂ · CDP 点验的纯函数层）。
 *
 * 只出**纯数据类型**：不带 Node 类型、不带 electron 类型（tsconfig 设了 `types: []`，
 * 渲染层不引 Node 类型 —— AGENTS.md「纯函数下沉与调用约定」）。
 */

/** 点验支持的定位方式（[A2-7] 全表；与 POM_LOCATOR_KINDS 同一套取值） */
export type HitKind =
  | 'css'
  | 'xpath'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'alttext'
  | 'title'
  | 'testid'
  | 'role'
  | 'pw';

/** 三个合法 op（缺省 verify） */
export type HitOp = 'verify' | 'status' | 'stop';

/** 事实的 7 个 reason（[A2-3]：每个值只对应一种事实） */
export type HitReason =
  | 'ok'
  | 'not-found'
  | 'not-visible'
  | 'iframe-only'
  | 'login-required'
  | 'unsupported'
  | 'timeout';

/** 归一后的事实（[A2-3]） */
export interface HitFacts {
  found: boolean;
  total: number;
  truncated: boolean;
  visible: boolean;
  inIframe: boolean;
  iframes: number;
  reason: HitReason;
  label: string;
  approx: boolean;
  kind: string;
  locator: string;
  roleName?: string;
  source: 'vault' | 'draft';
  pageId?: string;
  elementId?: string;
  ms: number;
}

/** 校验通过后的点验计划 */
export interface HitPlan {
  op: string;
  source: 'vault' | 'draft';
  url: string;
  kind: HitKind;
  locator: string;
  roleName: string;
  pageId?: string;
  elementId?: string;
  timeoutMs: number;
  budget: HitBudget;
}

/** 三段超时预算（[A2-6]） */
export interface HitBudget {
  total: number;
  launch: number;
  attach: number;
  query: number;
}

/** 校验结果：错误一律返回、不抛 */
export type HitValidateResult =
  | { ok: true; op: HitOp; plan: HitPlan | null }
  | { ok: false; error: string; code: string };

/** 入参（与 src/types.ts 的 ElHitTestInput 同形；这里不 import 渲染层类型，保持单向） */
export interface HitTestInput {
  op?: HitOp;
  pageId?: string;
  elementId?: string;
  locator?: string;
  kind?: HitKind | string;
  roleName?: string;
  url?: string;
  timeoutMs?: number;
}

/** 校验上下文（由 ipc 层注入；本文件不碰 vault） */
export interface HitValidateCtx {
  unlocked?: boolean;
  findElement?: (pageId: string, elementId: string) => { kind?: string; locator?: string; role?: string } | null;
}

/** 一条进程快照（`pickKillable` 的入参） */
export interface HitProcSnapshot {
  pid: number;
  name?: string;
  cmd?: string;
  creation?: string;
}

export const HIT_CHANNEL: string;
export const HIT_OPS: HitOp[];
export const HIT_KINDS: HitKind[];
export const HIT_REASONS: HitReason[];
export const HIT_BUDGET: { launch: number; attach: number; query: number; total: number; idleStop: number };
export const HIT_PROFILE_DIR_NAME: string;
export const HIT_PID_FILE_NAME: string;
export const IMPLICIT_ROLE_NAMES: string[];
export const APPROX_KINDS: HitKind[];
export const MAX_LOCATOR_LEN: number;
export const MAX_ROLE_NAME_LEN: number;
export const MAX_TOTAL: number;
export const MAX_LABEL_LEN: number;
export const MAX_NODES: number;
export const PW_HIT_METHODS: string[];
/** visible 判据的**源码**（注入脚本里那一行；单测直接执行它，[A2-3]） */
export const VISIBLE_PREDICATE_SRC: string;
/** 页内固定脚本（`Runtime.callFunctionOn` 的 functionDeclaration，[A2-7]） */
export const HIT_SCRIPT: string;

export const ERR_HIT: {
  badOp: (op: string) => string;
  needSource: string;
  notInVault: string;
  locked: string;
  badUrl: string;
  emptyLocator: string;
  longLocator: string;
  roleNeedsName: string;
  longRoleName: string;
  busy: string;
  pwUnsupported: string;
  noBrowser: string;
  launchFailed: string;
  noDevToolsPort: string;
  attachFailed: string;
  noPage: string;
  queryFailed: string;
  timeout: string;
  stopFailed: string;
  reasonText: Record<HitReason, string>;
};

export function normalizeKind(kind: unknown): HitKind;
export function supportsHitTest(kind: unknown): boolean;
export function isApproxKind(kind: unknown): boolean;
export function splitRoleSelector(selector: string): { role: string; name: string };
export function isHttpUrl(value: unknown): boolean;
export function devToolsPortPath(profileDir: string): string;
export function pidFilePath(profileDir: string): string;
/** 只解析第一行（端口）；第二行是 browser 端点，见 `parseBrowserWsPath` */
export function parseDevToolsPort(text: string): number | null;
export function parseBrowserWsPath(text: string): string;
export function buildLaunchArgs(options: { profileDir: string; url?: string }): string[];
export function isInsidePath(base: string, target: string): boolean;
export function hitProfileDirOf(dataDir: string): string;
export function isInsideHitProfile(dataDir: string, target: string): boolean;
export function isBrowserProcessName(name: string): boolean;
export function commandHasProfile(cmd: string, profileDir: string): boolean;
export function isCreationAfter(creation: string, startedAt: string): boolean;
/**
 * 解析 PowerShell 的日期串：ISO（pwsh 7）与 `/Date(ms)/`（Windows PowerShell 5.1）都认。
 * 只认 ISO 会让「回退到 powershell.exe」之后 `isCreationAfter` 恒 false（C-02 的第二个坑）。
 */
export function parsePowerShellDate(value: unknown): number;
/**
 * 挑可用 PowerShell：`pwsh` 优先，没有就 `powershell.exe`（Win10/11 默认没有 pwsh）。
 * @param whichFn 形如 `which(name)`：命中回绝对路径，否则 ''
 */
export function pickProcShell(whichFn?: (name: string) => string): 'pwsh' | 'powershell.exe';
export function pickKillable(
  procs: HitProcSnapshot[],
  ctx: { profileDir: string; startedAt?: string }
): { ours: Array<{ pid: number; name: string }>; skipped: Array<{ pid: unknown; why: string }> };
export function validateHitTestArgs(input: HitTestInput, ctx?: HitValidateCtx): HitValidateResult;
export function computeHitBudget(timeoutMs?: number): HitBudget;
export function normalizeHitFacts(
  raw: object,
  meta: {
    kind?: string;
    locator?: string;
    roleName?: string;
    source?: 'vault' | 'draft';
    pageId?: string;
    elementId?: string;
    ms?: number;
    approx?: boolean;
    reason?: string;
  }
): HitFacts;
export function buildHitScriptArgs(plan: { kind?: string; locator?: string; roleName?: string }, wantElement?: boolean): string;
/**
 * 页内事实里「这次查询根本没做成」的那一类 → 失败回执；正常回 `null`（C-03）。
 *
 * ⚠️ 返回的是**对象**不是字符串：调用方拿 `error`（给人看）与 `code`（进日志/审计）。
 * 队长给的 `string | null` 与实现不符（实现 `electron/hit-args.js` 的 `queryFailureOf` 回
 * `{ error, code } | null`，单测也是 `toEqual({ error, code })` 全等断言），这里按实现写。
 */
export function queryFailureOf(raw: unknown): { error: string; code: string } | null;
export function pwPlanOf(locator: string): { ok: true; plan: Array<{ name: string; args: unknown[] }> } | { ok: false; error: string };
