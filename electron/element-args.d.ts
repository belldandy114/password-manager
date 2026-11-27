/** 声明文件：让渲染层单测可以 import electron/element-args.js（元素库 · 定位/试跑的纯函数层） */

/**
 * 试跑支持的定位方式。
 *
 * 契约 [A0-5]：取值清单的**唯一真源**是 `src/utils/codegen/pageobject.ts` 的 `POM_LOCATOR_KINDS`（10 值），
 * 这里与 `electron/element-args.js` 的 `KINDS`、本类型三处必须逐项同序（parity 单测锁死）。
 * 这里必须是 10 值：渲染层把 `PomLocatorKind` 原样传进来，类型窄了会让 `ElTrialInputItem[]` 赋值报错。
 */
export type ElKind =
  | 'css'
  | 'xpath'
  | 'text'
  | 'role'
  | 'pw'
  | 'label'
  | 'placeholder'
  | 'alttext'
  | 'title'
  | 'testid';

export interface ElTrialInputItem {
  kind: ElKind;
  locator: string;
  /**
   * `kind==='role'` 必填：**可访问名**（与页面对象元素对象的 `role` 字段同义）。
   *
   * ⚠️ 语义修正（契约 [A0-6]）：以前这里被当成「ARIA role 名」用，于是试跑脚本写成
   * `getByRole(roleName, { name: locator })` —— 两个字段反了，role 元素必然 0 命中。
   * 现在的关系是：**`locator` = 角色**（button / textbox …），**`roleName` = 可访问名**。
   */
  roleName?: string;
  /** 仅用于结果回显的元素名（可选） */
  name?: string;
}

/** 校验后的条目：`pw` 会被解析成结构化计划，解析不出则带 `skipReason`（不抛错、不硬跑） */
export interface ElTrialItemPlan extends ElTrialInputItem {
  pwPlan?: Array<{ name: string; args: Array<string | number | Record<string, string>> }>;
  skipReason?: string;
}

export interface ElBudget {
  launch: number;
  goto: number;
  items: number;
  total: number;
  trialItem: number;
}

export interface ElDepsLamp {
  id: 'node' | 'playwright';
  label: string;
  state: 'green' | 'red';
  detail: string;
  fixHint?: string;
}

export declare const MAX_ITEMS: number;
export declare const MAX_LOCATOR_LEN: number;
export declare const MAX_ROLE_NAME_LEN: number;
export declare const KINDS: ElKind[];
export declare const BUDGET: ElBudget;
export declare const PROFILE_DIR_NAME: string;
export declare const SCRIPT_PREFIX: string;
export declare const RESULT_SENTINEL: string;
export declare const MASK: string;

export declare const ERR: {
  noItems: string;
  tooManyItems: string;
  badUrl: string;
  emptyLocator: string;
  longLocator: string;
  badKind: (k: string) => string;
  roleNeedsName: string;
  longRoleName: string;
  emptyDir: string;
  busy: string;
  noNode: string;
  profileOutside: string;
  profileTarget: string;
  pwUnsupported: string;
};

export declare function pwChainPlan(chain: string):
  | { ok: true; plan: Array<{ name: string; args: Array<string | number | Record<string, string>> }> }
  | { ok: false; reason: string };

export declare function maskPath(workDir: string, target: string): string;
export declare function profileDirOf(workDir: string): string;
export declare function isInsideProfile(workDir: string, target: string): boolean;
/** 通用路径包含性校验（[A2-9]：`isInsideProfile` 是它的薄包装，点验 profile 复用同一算法） */
export declare function isInsidePath(base: string, target: string): boolean;
export declare function computeBudget(timeoutMs?: unknown): ElBudget;

export declare function validateTrialArgs(input: unknown):
  | { ok: true; url: string; dir: string; items: ElTrialItemPlan[]; withStyle: boolean; budget: ElBudget }
  | { ok: false; error: string };

export declare function buildTrialScript(input: {
  url: string;
  items: ElTrialInputItem[];
  withStyle?: boolean;
  budget?: ElBudget;
}): string;

export declare function parseTrialOutput(stdout: string): any | null;

/** 把子进程 stderr 归纳成一句人话（认得出缺包就给可执行提示；盘符路径抹成 `<路径>`） */
export declare function summarizeChildError(stderr: string): string;

export declare function buildDeps(input: {
  workDir: string;
  nodePath?: string | null | boolean;
  playwrightOk?: boolean | null;
  playwrightDetail?: string;
}): { lamps: ElDepsLamp[]; dir: string; ready: boolean };
