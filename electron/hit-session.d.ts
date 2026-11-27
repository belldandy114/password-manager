/**
 * 声明文件：让渲染层单测可以 import electron/hit-session.js（元素库 A₂ 的会话状态机）。
 *
 * 只出纯数据类型：不带 Node 类型、不带 electron 类型（tsconfig `types: []`）。
 */

import type { HitFacts, HitProcSnapshot } from './hit-args';

export interface HitSessionError {
  success: false;
  error: string;
  code?: string;
}

export interface HitSessionStatus {
  open: boolean;
  sessionId: string;
  browserId: 'chrome' | 'msedge' | '';
  port: number;
  url: string;
  startedAt: string;
  lastHitAt: string;
  idleStopInMs: number;
}

export interface HitHandleResult {
  success: boolean;
  data?: { op: 'verify' | 'status' | 'stop'; hit?: HitFacts; session: HitSessionStatus; stopped?: boolean; killed?: boolean; alreadyStopped?: boolean };
  error?: string;
  code?: string;
}

export function configure(deps: Record<string, unknown>): void;
export function handle(input: unknown): Promise<HitHandleResult>;
export function verify(plan: unknown): Promise<HitHandleResult>;
export function status(): HitSessionStatus;
export function stopSession(reason: string): Promise<HitHandleResult>;
export function stopSessionSync(reason: string): void;

/** 三项校验（进程名 + 命令行含 profile + 创建时间）；任一不取就 ok:false */
export function verifyProcess(
  pid: number,
  profileDir: string,
  startedAt?: string
): { ok: boolean; why?: string; name?: string };

/** 只杀校验通过的 pid：未通过的绝不进 kill（[A2-10]） */
export function killOurs(
  procs: HitProcSnapshot[],
  ctx: { profileDir: string; startedAt?: string },
  kill: (pid: number) => void
): { killed: number[]; skipped: Array<{ pid: unknown; why: string }> };

export function parseTasklistName(stdout: string): string;
export function parseCimJson(stdout: string): { cmd: string; creation: string } | null;

/** 审计一条（[A2-13]：恰好 8 个键；只留 host，不记完整 URL / query / label） */
export function auditHitSession(
  session: {
    sessionId?: string;
    browserId?: string;
    url?: string;
    startedAt?: string;
    hits?: number;
  } | null,
  extra?: { killed?: boolean; ok?: boolean }
): void;
export function pickBrowserExe(findBrowser: (id: string) => string | null): string;
export function safeUrl(value: string): string;
export function safeHost(value: string): string;
export function writePidFile(profileDir: string, info: Record<string, unknown>): { ok: boolean; file?: string; message?: string };
export function readPidFile(profileDir: string): { pid: number; sessionId: string; exe: string; startedAt: string } | null;
export function clearPidFile(profileDir: string): void;
export function clearStaleDevToolsPort(profileDir: string): void;
/** 清理前的包含性校验（[A2-9]）：profile 必须落在数据目录下的固定名子目录，否则跳过清理 */
export function guardProfileForCleanup(dataDir: string, profileDir: string): boolean;
export function isPidAlive(pid: number): boolean;
export function waitPidGone(pid: number, timeoutMs?: number): Promise<boolean>;
export function peek(): Record<string, unknown> | null;
export function _reset(): void;
/** 测试用：种一个假会话（验证 stop 收尾语义用；生产路径不调用） */
export function __setSessionForTest(next: Record<string, unknown> | null): Record<string, unknown> | null;
