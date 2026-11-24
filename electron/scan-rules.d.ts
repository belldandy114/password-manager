/** 代码体检规则引擎（契约 C-52〜C-54）。纯函数：本模块不 require fs / electron。 */

export type ScanPackId = 'audit' | 'coverage';
export type ScanSeverity = 'high' | 'medium' | 'low';
export type ScanCategory = 'ui' | 'secret' | 'assert' | 'coverage';

export interface ScanRule {
  id: string;
  pack: ScanPackId;
  category: ScanCategory;
  severity: ScanSeverity;
  title: string;
  desc: string;
  /** 'line'（缺省）按行匹配；'file' 整文件判定 */
  kind?: 'line' | 'file';
  pattern?: RegExp;
  /** 命中前置条件（同一行还必须匹配这个） */
  requires?: RegExp;
  /** 命中排除条件（同一行命中即跳过），误报控制用 */
  negative?: RegExp;
  /** 整文件判定 */
  detect?: (code: string) => boolean;
  /** true 时把 pattern 的第 1 个捕获组作为 Finding.key（coverage 包） */
  coverage?: boolean;
}

export interface ScanRulePublic {
  id: string;
  category: ScanCategory;
  severity: ScanSeverity;
  title: string;
  desc: string;
  coverage: boolean;
}

export interface ScanPack {
  id: ScanPackId;
  label: string;
  rules: ScanRulePublic[];
}

export interface ScanHit {
  ruleId: string;
  severity: ScanSeverity;
  category: ScanCategory;
  title: string;
  /** 1-based；整文件级规则为 0 */
  line: number;
  /** 只含命中行原文，≤200 字符（整文件级为空串） */
  snippet: string;
  /** coverage 包：抽取到的路径原文（未归一化） */
  method?: string;
  path?: string;
}

export interface ScanMatchResult {
  ok: true;
  hits: ScanHit[];
  /**
   * 被 `MAX_HITS_PER_RULE`（每规则 3 条）折叠掉、**没有出现在 `hits` 里**的命中条数。
   * 运行时**总会给**（无折叠时为 0，见 `scan-rules.js` 的 `matchRules`）。
   * 声明成可选是为了让**旧的主进程/旧缓存**也能对上这个类型；调用方取值用 `?? 0`。
   * RC-01：折叠必须可见——用户要知道「还有 N 条没展示」。
   */
  suppressed?: number;
}

export declare const RULES: ScanRule[];
export declare const SCAN_PACKS: ScanPack[];
export declare const SEVERITY_ORDER: Record<ScanSeverity, number>;
export declare const MAX_HITS_PER_RULE: number;
export declare const SNIPPET_MAX: number;

export declare function ruleOf(id: string): ScanRule | null;
export declare function rulesOf(pack: string): ScanRulePublic[];

/** 抹掉注释，返回与输入行数一致的「只剩代码」的文本行 */
export declare function stripComments(text: string, filePath?: string): string[];

/** 在单个文件上跑规则；ruleIds 缺省/空 = 跑全部 */
export declare function matchRules(text: string, filePath: string, ruleIds?: string[]): ScanMatchResult;

/** root 归属校验（纯字符串 + path 归一化，不碰 fs） */
export declare function isInsideRoot(rootReal: string, target: string): boolean;