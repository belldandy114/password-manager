/** JMX 脚本静态检查（纯函数，主进程与测试共用） */

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

