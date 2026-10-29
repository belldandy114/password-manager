/** 声明文件：让渲染层单测可以 import electron/jmeter-args.js */

export interface JmeterPaths {
  mode: 'log' | 'report';
  jtlPath: string;
  reportDir: string;
}

export interface JmeterSummary {
  samples: number;
  duration: string;
  tps: number;
  avg: number;
  min: number;
  max: number;
  errors: number;
  errorPct: number;
}

export interface JmeterJtlStats {
  samples: number;
  errors: number;
  errorPct: number;
  avg: number;
  min: number;
  max: number;
  p90: number;
  p95: number;
  p99: number;
  wallMs: number;
  tps: number;
  topErrorCode: { code: string; count: number } | null;
}

export interface CheckResult { ok: boolean; error?: string }

export declare const MODES: string[];
export declare function stamp(d?: Date): string;
export declare function scriptBase(jmxPath: string): string;
export declare function pickPaths(args: { jmxPath: string; outDir: string; mode?: 'log' | 'report'; stampStr?: string }): JmeterPaths;
export declare function buildJmeterArgs(args: {
  jmxPath: string;
  jtlPath: string;
  mode?: 'log' | 'report';
  reportDir?: string;
  threads?: number | string;
  loops?: number | string;
  extraArgs?: string[];
}): string[];
export declare function validateJmxPath(p: string): CheckResult;
export declare function validateOutDir(p: string): CheckResult;
export declare function validateJmeterPath(p: string): CheckResult;
export declare function parseSummary(text: string): JmeterSummary | null;
export declare function parseJtl(csvText: string): JmeterJtlStats | null;
export declare function splitCsvLine(line: string): string[];