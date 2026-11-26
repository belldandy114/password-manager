/** 代码体检规则引擎（契约 C-52〜C-54）。纯函数：本模块不 require fs / electron。 */

export type ScanPackId = 'audit';
export type ScanSeverity = 'high' | 'medium' | 'low';
export type ScanCategory = 'ui' | 'secret' | 'assert';

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
  /** 整文件判定；`ctx` 是**每个文件只算一次**的上下文（测试作用域等） */
  detect?: (code: string, ctx: ScanRuleContext) => boolean;
  /**
   * 只在「像测试代码」的文件里跑（`isTestCode` = 内容有 @Test/describe/it… **且** 路径像测试）。
   * W8 那批规则查的是测试代码里的反模式，同一写法在应用代码里往往合法（空 catch 关流、
   * `Math.random()` 生成 id），不加这个就是成片误报。
   */
  testOnly?: boolean;
}

/** 一份文件跑规则时的共享上下文（每个文件只算一次，避免每条规则各扫一遍全文） */
export interface ScanRuleContext {
  /** 这份文件算不算测试代码（见 `isTestCode`） */
  isTest: boolean;
  /** 相对路径（POSIX 分隔符） */
  filePath: string;
}

export interface ScanRulePublic {
  id: string;
  category: ScanCategory;
  severity: ScanSeverity;
  title: string;
  desc: string;
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
  /**
   * 历史字段：`coverage` 包下线后**没有产出方**（规则引擎永不再写它）。
   * 保留声明只为对得上旧 `scanRuns` 记录与 `ScanFinding` 的形状。
   */
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

/**
 * 判定「这份文件是不是测试代码」：内容像测试（@Test / describe( / it( / def test_ …）
 * **且** 路径像测试（`test/`、`tests/`、`__tests__/`、`spec/`、`*.test.*`、`*.spec.*`、`*Test.java`）。
 *
 * W8 那批规则的前置条件；`matchRules` 每个文件只调一次并把结果放进 ctx 共享。
 * 已知取舍：不在测试目录、文件名也不带 Test 的用例文件会漏报（漏报 < 误报）。
 */
export declare function isTestCode(codeText: string, filePath: string): boolean;

/** 在单个文件上跑规则；ruleIds 缺省/空 = 跑全部 */
export declare function matchRules(text: string, filePath: string, ruleIds?: string[]): ScanMatchResult;

/** root 归属校验（纯字符串 + path 归一化，不碰 fs） */
export declare function isInsideRoot(rootReal: string, target: string): boolean;
