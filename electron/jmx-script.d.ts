/** JMX 脚本静态检查 + 生成（纯函数，主进程与渲染层单测共用） */

export interface JmxParam {
  name: string;
  value: string;
}

export interface JmxInspect {
  ok: boolean;
  error: string;
  /** 测试计划名（<TestPlan testname>） */
  testName: string;
  /** 线程组数量（含 setUp / tearDown / 并发线程组） */
  threadGroups: number;
  /** ThreadGroup.num_threads 的默认值 */
  threadsDefault: number | null;
  /** LoopController.loops 的默认值 */
  loopsDefault: number | null;
  /** 脚本里声明可被 -J 覆盖的参数：${__P(name,default)} */
  params: JmxParam[];
  /** CSV Data Set 等引用的外部文件 */
  dataFiles: string[];
}

export const JMX_EXTS: Set<string>;
export interface JmxTemplateOptions {
  name?: string;
  url: string;
  method?: string;
  threads?: number;
  loops?: number;
}
export interface JmxTemplateResult {
  ok: boolean;
  error?: string;
  xml?: string;
  domain?: string;
  path?: string;
}
export function buildJmxTemplate(opts: JmxTemplateOptions): JmxTemplateResult;
export function inspectJmx(xml: string): JmxInspect;
export function isJmxName(name: string): boolean;

/* ---------------- 2.1 接口集合 → 批量 .jmx（契约 C-75〜C-77） ---------------- */

export interface JmxPlanInterface {
  name?: string;
  method?: string;
  url: string;
  /** "K: V" 每行一个 */
  headers?: string;
  /** 请求体（POST 时按 raw body 落盘） */
  body?: string;
}

export interface JmxCsvVar {
  /** JMeter 变量名，须匹配 ^[A-Za-z_][A-Za-z0-9_]*$ */
  name: string;
  /** CSV 表头里的列名 */
  column: string;
}

export interface JmxPlan {
  name?: string;
  interfaces: JmxPlanInterface[];
  threads?: number;
  loops?: number;
  thinkTimeMs?: number;
  /** 源 CSV 绝对路径：只在生成时读一次，**绝不写进 JMX** */
  csvFile?: string;
  csvVars?: JmxCsvVar[];
  /** 期望响应码，默认 '200'，必须 3 位数字 */
  assertCode?: string;
}

export type JmxPlanReason =
  | 'no-interface'
  | 'too-many-interfaces'
  | 'threads-out-of-range'
  | 'think-time-out-of-range'
  | 'bad-url'
  | 'bad-csv-var'
  | 'bad-assert-code';

export interface JmxFromPlanOk {
  ok: true;
  xml: string;
  name: string;
  /** 接口数（= HTTPSamplerProxy 数） */
  interfaces: number;
  /** JMX 里写的 CSV 文件名（无 CSV 时为空串） */
  csvFileName: string;
}
export type JmxFromPlanResult = JmxFromPlanOk | { ok: false; reason: JmxPlanReason; detail?: string };

export declare const MAX_INTERFACES: number;
export declare function buildJmxFromPlan(plan: JmxPlan): JmxFromPlanResult;

/** 落盘前校验 CSV 表（parseCsv 的输出，含表头行） */
export type CsvTableCheck =
  | { ok: true; rows: number }
  | { ok: false; reason: 'no-rows' | 'missing-column'; detail?: string };
export declare function validateCsvTable(table: string[][], csvVars?: JmxCsvVar[]): CsvTableCheck;