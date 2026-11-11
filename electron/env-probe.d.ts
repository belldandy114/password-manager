/** 声明文件：让渲染层单测可以直接 import electron/env-probe.js */

export declare const MAX_URLS: number;
export declare const DEFAULT_CONCURRENCY: number;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const MIN_TIMEOUT_MS: number;
export declare const MAX_TIMEOUT_MS: number;
export declare const SLOW_MS: number;

export interface ProbeResult {
  url: string;
  ok: boolean;
  /** HTTP 状态码；网络错误时没有 */
  status?: number;
  ms: number;
  error?: string;
}

export interface ProbeSummary {
  total: number;
  ok: number;
  fail: number;
  slow: number;
  avgMs: number;
  slowest: string;
}

export declare function normalizeProbeUrl(raw: string | null | undefined): string;
export declare function clampTimeout(ms: unknown): number;
export declare function runProbes(
  urls: string[],
  probeOne: (url: string, index: number) => Promise<Partial<ProbeResult>> | Partial<ProbeResult>,
  options?: { concurrency?: number },
): Promise<ProbeResult[]>;
export declare function summarizeProbes(results: Array<Partial<ProbeResult>>): ProbeSummary;