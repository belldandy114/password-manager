/** Allure 结果解析（模块 5.1，契约 C-38/C-39/C-61〜C-64）。纯函数，不 require fs/electron。 */

export type AllureStatus = 'passed' | 'failed' | 'broken' | 'skipped';

export interface AllureCase {
  /** 用例短名（≤300） */
  name: string;
  /** 全名（= 类名.方法名，flaky 判定按它归并） */
  fullName: string;
  /** 最后一次 result 的状态 */
  status: AllureStatus | string;
  durationMs: number;
  retries: number;
  runs: number;
  pass: number;
  /** 不通过次数（failed + broken），分母显示成 fail/runs */
  fail: number;
  flaky: boolean;
  /** ≤500（C-64 截断） */
  message?: string;
}

export interface AllureFlaky {
  name: string;
  fullName: string;
  runs: number;
  pass: number;
  fail: number;
}

export interface AllureCluster {
  /** 归一后的错误 key（≤200，表达**模式**不是实例） */
  key: string;
  count: number;
  /** 该簇里出现次数最多的原文（≤500） */
  sample: string;
  /** 最多 3 条不同原文（每 ≤500），用来对照「同一类不同值」或发现 key 抹过头 */
  samples: string[];
}

/** `truncatedReason` 只允许这 5 个值；**顺序即优先级**（timeout > files > file-size > cases > flaky） */
export declare const TRUNCATED_REASONS: readonly ['timeout', 'files', 'file-size', 'cases', 'flaky'];
/** 按优先级挑一个 reason */
export declare function pickReason(a?: string, b?: string): string;

export type AllureTruncatedReason = 'timeout' | 'files' | 'file-size' | 'cases' | 'flaky';

export interface AllureParseResult {
  ok: boolean;
  error?: string;
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  retries: number;
  cases: AllureCase[];
  flaky: AllureFlaky[];
  environment: Record<string, string>;
  clusters: AllureCluster[];
  skippedFiles: number;
  truncated: boolean;
  truncatedReason?: AllureTruncatedReason;
}

export interface AllureParseOptions {
  maxFiles?: number;
  maxCases?: number;
  /** ipc 层没有传进来的文件数（附件等），会加进返回值 */
  skippedFiles?: number;
}

export declare const MAX_FILE_BYTES: number;
export declare const MAX_FILES: number;
export declare const MAX_CASES: number;
export declare const MAX_CLUSTERS: number;
export declare const MAX_FLAKY: number;
export declare const MAX_KEY: number;
export declare const MAX_SAMPLE: number;
export declare const MAX_SAMPLES_PER_CLUSTER: number;

export declare function isResultFile(name: string): boolean;
export declare function isContainerFile(name: string): boolean;
export declare function isEnvFile(name: string): boolean;

/** 归一条失败消息（聚类 key）：去堆栈、耗时/UUID 归一，保留断言里的业务数值 */
export declare function normalizeMessage(msg: string): string;

/** 解析 properties / xml 两种 environment（不引 XML 解析器） */
export declare function parseEnvironment(name: string, text: string): Record<string, string>;

export declare function parseAllure(files: { name: string; text: string }[], opts?: AllureParseOptions): AllureParseResult;