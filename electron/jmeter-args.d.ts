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

/** 行级解析：表头列下标（缺列为 -1；缺 elapsed/success 由 parseJtlHeader 直接返回 null） */
export interface JtlHeader {
  elapsed: number;
  success: number;
  code: number;
  label: number;
  ts: number;
}

/** 行级解析：一行样本 */
export interface JtlRow {
  elapsed: number;
  ok: boolean;
  code: string;
  label: string;
  /** 时间戳；缺列或脏值统一记 0（聚合时按「没有时间戳」处理） */
  ts: number;
}

export interface JtlParsed {
  header: JtlHeader;
  rows: JtlRow[];
}

/** byLabel 的单接口统计 */
export interface JtlLabelStat {
  label: string;
  samples: number;
  errors: number;
  errorPct: number;
  p90: number;
}

/** 5.2 指标（契约 C-70）：spanMs 与既有 parseJtl 的 wallMs 同义 */
export interface JtlMetrics {
  samples: number;
  errors: number;
  errorPct: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  spanMs: number;
  tps: number;
  byLabel: JtlLabelStat[];
  truncated: boolean;
  truncatedReason?: 'labels';
}

export declare const MAX_BY_LABEL: number;
export declare function parseJtlHeader(line: string): JtlHeader | null;
export declare function parseJtlRow(line: string, header: JtlHeader | null): JtlRow | null;
export declare function parseJtlRows(text: string): JtlParsed | null;
export declare function computeMetrics(rows: JtlRow[], opts?: { maxLabels?: number }): JtlMetrics;

/**
 * `jmeter:analyze-jtl` 通道的 data 形状（契约 §2.6 / C-46 的类型名 `JtlAnalyzeResult`）。
 * 本批（W2-A）先落在 `.d.ts`，`src/types.ts` 的 ElectronAPI 接线需一个独立小任务
 * （W1 已冻结 types.ts，本任务 inScope 不含它）。
 */
export interface JtlAnalyzeResult extends JtlMetrics {
  /** 有效行数（被丢弃的坏行不计入） */
  rows: number;
  truncatedReason?: 'rows' | 'labels';
}

export declare const MODES: string[];
export declare function stamp(d?: Date): string;
export declare function scriptBase(jmxPath: string): string;
export declare function pickPaths(args: { jmxPath: string; outDir: string; mode?: 'log' | 'report'; stampStr?: string }): JmeterPaths;

/**
 * `-j` 引擎日志路径的计算结果（`pickJmeterLogPath` 的返回）。
 * 目录为空/空白 → `{ ok: false, reason: 'no-dir' }`，调用方据此**退化为不传 `-j`**；
 * 正常返回 `{ ok: true, path }`，注意它**不保证目录可写**——能不能写由 `canWriteDir` 单独探。
 */
export type JmeterLogPick = { ok: true; path: string } | { ok: false; reason: 'no-dir' };

export declare function buildJmeterArgs(args: {
  jmxPath: string;
  jtlPath: string;
  mode?: 'log' | 'report';
  reportDir?: string;
  threads?: number | string;
  loops?: number | string;
  extraArgs?: string[];
  /**
   * 可选：JMeter 引擎日志（`-j`）落点。**不传/传空即保持旧行为（不追加 `-j`）**，
   * 传了就追加在 `-l <jtl>` 之后。由 `pickJmeterLogPath` 算出、`canWriteDir` 探过再传。
   */
  logPath?: string;
}): string[];

/** `-j` 日志路径：`<dir>/jmeter-<stampStr || 当前时间戳>-engine.log`（纯函数，不碰磁盘） */
export declare function pickJmeterLogPath(dir: string, stampStr?: string): JmeterLogPick;

/** 目录可写探测（不创建任何文件）；不存在或不可写一律 false —— 调用方据此退化为不传 `-j` */
export declare function canWriteDir(dir: string): boolean;
export declare function validateJmxPath(p: string): CheckResult;
export declare function validateOutDir(p: string): CheckResult;
export declare function validateJmeterPath(p: string): CheckResult;
export declare function parseSummary(text: string): JmeterSummary | null;
export declare function parseJtl(csvText: string): JmeterJtlStats | null;
export declare function splitCsvLine(line: string): string[];