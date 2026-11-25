/**
 * 录制产物：**本期交付两份** —— Java POM 与 Playwright `*.spec.ts`（契约 `[C-118]`、AC-20）。
 * 第三份零依赖 `.mjs`（产物②）**本期未交付**：AC-10a 六轮未通过，按用户裁定进 P3；
 * 生成逻辑与其用例保留在本文件里（见 `buildMjsScript`），但**不接界面、不进 `buildArtifacts()`**。
 *
 * **本文件的核心不是三个模板，而是中间表示 `stepsToCalls()`**。
 * AC-20 的判据是「三份产物由同一个步骤→调用中间表示 reduce 生成，抽取后数组逐元素相等」——
 * 如果三个模板各自遍历 `steps`，迟早在某个 action 上分叉（一个模板处理了 `select`，
 * 另一个忘了），而那种 bug 的单份产物看起来完全正常。所以：**所有 action 的语义只在这里解释一次**，
 * 三个模板都只是 `calls.map(...)`。
 *
 * 三条边界（`[C-118]`）：
 *
 * 1. **POM 生成器零改动**：`src/utils/codegen/pageobject.ts` 一行不动，本文件只把录制步骤映射成
 *    元素行再**调用**它。`lang` 也不会被本文件碰——录制产物不是 POM 的第三种语言选项。
 * 2. **口令永不进产物**：`.mjs` / `*.spec.ts` 只写 `process.env[<valueRef>]`（环境变量**名**），
 *    Java POM 不含步骤、故不写 `System.getenv`（`[C-119]` 第 4 款）。未填 `valueRef` 的
 *    `fill` / `select` 步骤必须给 `warnings`，不得静默生成空值（`[C-83]` 口径）。
 * 3. **无时间戳**（`[C-85]`）：同一份录制重复生成的产物**逐字相等**，否则 golden 没法比。
 *
 * 依赖方向：`recordScript.ts → codegen/pageobject.ts`（只调用）+ `components/codegen/pomModel.ts`
 * （只为复用 `blankElement()`——`[C-110]` 要求元素 id 在「新建那一刻」就定下来，抄一份工厂等于
 * 造第二个 id 生成口径）。反向（pageobject → recordScript）禁止。
 *
 * @module src/utils/record/recordScript
 */

import { generatePageObject } from '../codegen/pageobject';
import type { PomElement, PomLocatorKind } from '../codegen/pageobject';
import { blankElement } from '../../components/codegen/pomModel';
import type { PomElementRow } from '../../components/codegen/pomModel';
import type { UiLocatorKind, UiRecording, UiStep, UiStepAction } from './recorderModel';

/* ================================================================
   0. 产物元信息（三档前置来自 `01-方案` §5.4）
   ================================================================ */

/** 产物 id（= AC-16 的 `data-artifact="pom|mjs|spec"`） */
export type ArtifactId = 'pom' | 'mjs' | 'spec';

/**
 * 三档执行前置（**文案即判据**：产物上限/前置写进界面与生成的注释里）。
 *
 * 逐条对齐 `01-方案` §5.4：
 * - ① POM 只保证「可编译」，**不**保证「已编译通过」（本机 JDK/jar 只是前置）；
 * - ② `.mjs` 要 Node **≥ 22**——脚本用全局 `WebSocket` 走 CDP，18/20 没有这个全局对象；
 * - ③ `*.spec.ts` 要 `@playwright/test` 与已下载的浏览器，本机缺失时记「未验证」，不得算通过。
 */
export const ARTIFACT_PREREQ: Record<ArtifactId, string> = {
  pom: 'JDK 17+（要 javac，JRE 不够）+ com.microsoft.playwright:playwright jar；产物①只保证「可编译」，不保证「已编译通过」',
  // 场景契约（t44 用户裁定）：.mjs 只声明「浏览器已打开目标页」这一种场景，
  // 干净 about:blank 起步属于本期**不支持**——写进前置里，不能让人以为三份产物等价。
  // 本期未交付（P3）：见 buildMjsScript 的说明；值保留是为了 P3 重做时前置条件不丢
  mjs: '【本期未交付 · P3】Node ≥ 22 + 一个已打开目标页的、带调试端口的 Chrome（AC-10a 六轮未通过）',
  spec: '@playwright/test 与已下载的浏览器（本机缺失时记「未验证」，不得算通过）',
};

/* ================================================================
   1. 中间表示（AC-20 的地基）
   ================================================================ */

/**
 * 一步 → 一条调用。
 *
 * `locatorValue` 的定义**覆盖全部 6 种 action**（这是 AC-20 第 3 条能成立的前提）：
 * - 元素动作（`click` / `fill` / `select` / `press`）：该步骤的定位器（引擎前缀已归一）；
 * - `navigate`：目标地址（导航步骤没有元素，它的「定位器」就是 URL）；
 * - `assert`：断言内容（`contains`），它在产物里同样只出现一次。
 */
export interface ScriptCall {
  /** 步骤序号（= `UiStep.index`；AC-20 第 5 条要求它升序连续） */
  index: number;
  action: UiStepAction;
  /** 该步在 ②③ 产物里逐字出现的那**一个**字符串 */
  locatorValue: string;
  /** 定位器种类（`navigate` / 无定位器时为空串） */
  locatorKind: UiLocatorKind | '';
  roleName?: string;
  /** `select` 的选项序号（只有序号，没有选项文本） */
  selectedIndex?: number;
  /** 环境变量**名**（`fill` 必有；缺了会进 `warnings`） */
  valueRef?: string;
  assert?: { kind: 'url' | 'text' | 'title'; contains: string };
  /** 步骤备注（≤ 200，进产物只作注释、单行化） */
  note?: string;
  /**
   * 这条调用是「**步骤外的前置**」而不是录制里的一步（目前只有起始导航用它）。
   *
   * 为什么要这个标记（t32 / D-1）：浏览器是应用自己拉起来的（`record:start` 把 URL 传给 Chrome），
   * 那次导航**不是录制事件**，所以 `steps` 里永远不会有 `navigate`。产物若不自带起始导航，
   * 干净环境（about:blank）回放第一步就找不到元素。补出来的这条**不能冒充第 1 步**：
   * 它的 `index` 是 `-1`、不计入「录制步骤数」、也不进 POM 的元素集合
   * （J-15 按 `steps[].elementId` 一一对应，多一行就会连带错位）。
   */
  preamble?: true;
  /** 是否「元素动作」——决定它进不进 POM 的元素集合（J-15） */
  elementLike: boolean;
  /** 交给 `pageobject.ts` 的 locator（引擎前缀已剥离、role 归一成 css） */
  pomLocator: string;
  pomKind: PomLocatorKind;
  /** 生成期告警（`[C-83]`：缺 valueRef / 缺选项序号 / 缺定位器都不许静默） */
  warnings: string[];
}

/** 引擎前缀归一：让 `.mjs` / `*.spec.ts` 里的 `page.locator(<这个值>)` 直接可用 */
function selectorOf(step: UiStep): string {
  const loc = step.locator;
  if (!loc || !loc.value) return '';
  const v = String(loc.value);
  if (loc.kind === 'xpath') return /^(xpath=|\/\/|\.\.|\()/.test(v) ? v : `xpath=${v}`;
  if (loc.kind === 'text') return /^text=/.test(v) ? v : `text=${v}`;
  if (loc.kind === 'role') {
    // 录制器给 role 候选的 selector 本来就是 `[role="x"]`（合法 CSS）；只有裸角色名才需要拼 role= 引擎
    if (/[[\]#.=>]/.test(v)) return v;
    const name = loc.roleName ? `[name="${loc.roleName}"]` : '';
    return `role=${v}${name}`;
  }
  return /^css=/.test(v) ? v.slice(4) : v;
}

/**
 * 交给 `pageobject.ts` 的 locator：**剥掉引擎前缀**。
 *
 * 为什么必须剥：`pageobject.ts` 的 text / role 分支会自己包一层 API
 * （`getByText(裸文本)` / `getByRole(AriaRole.X, setName(可访问名))`），把 `text=保存`
 * 原样喂进去会生成 `getByText("text=保存")`——能编译、但永远定位不到。
 * 这一步是「同一份数据在不同消费方各取所需」，不是第二份真源。
 */
function pomLocatorOf(step: UiStep): string {
  const loc = step.locator;
  if (!loc || !loc.value) return '';
  const v = String(loc.value);
  if (loc.kind === 'text') return v.replace(/^text=/, '');
  if (loc.kind === 'xpath') return v.replace(/^xpath=/, '');
  if (loc.kind === 'role') return /[[\]#.=>]/.test(v) ? v : `[role="${v}"]`;
  return v.replace(/^css=/, '');
}

/** role 在 POM 侧按 css 处理：录制里的 role 候选本身就是 `[role="x"]` 这种合法 CSS */
function pomKindOf(step: UiStep): PomLocatorKind {
  const kind = step.locator ? step.locator.kind : 'css';
  return kind === 'role' ? 'css' : kind;
}

/** 环境变量名归一（`[A-Za-z_][A-Za-z0-9_]*`），非法字符换下划线；空则给空串 */
function envNameOf(raw: string): string {
  const s = String(raw || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!s) return '';
  return /^[0-9]/.test(s) ? `V_${s}` : s;
}

/** 单行化备注：换行/制表符压成空格，≤ 200 字符（`[C-119]` 第 6 款） */
function oneLine(s: string, max = 200): string {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 取 `select` 的选项序号（`UiValueMeta` 是判别联合，必须先窄化；`length` 分支没有这个字段） */
function selectedIndexOf(step: UiStep): number | null {
  const vm = step.valueMeta;
  if (!vm || !('selectedIndex' in vm)) return null;
  const n = (vm as { selectedIndex: number }).selectedIndex;
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/**
 * 录制的步骤 → 调用数组（**唯一**解释 action 语义的地方）。
 *
 * 每个 action 只在这里解释一次，三个模板都从 `calls` 派生——这正是 AC-20「同源」的可证明形态。
 */
export function stepsToCalls(rec: UiRecording): ScriptCall[] {
  const steps = rec && Array.isArray(rec.steps) ? rec.steps : [];
  const baseUrl = String((rec && rec.baseUrl) || '');
  const calls: ScriptCall[] = [];

  steps.forEach((step, i) => {
    const index = typeof step.index === 'number' ? step.index : i;
    const label = `第 ${index + 1} 步`;
    const warnings: string[] = [];
    const hasLocator = !!(step.locator && step.locator.value);
    const action = step.action;

    let locatorValue = '';
    let elementLike = false;

    if (action === 'navigate') {
      locatorValue = hasLocator ? selectorOf(step) : baseUrl;
      if (!locatorValue) warnings.push(`${label} navigate 没有目标地址（录制缺 baseUrl），产物里不会有这一步`);
    } else if (action === 'assert') {
      const hit = step.assert;
      if (hit && typeof hit.contains === 'string' && hit.contains) {
        locatorValue = hit.contains;
      } else if (hasLocator) {
        locatorValue = selectorOf(step);
        warnings.push(`${label} assert 没有断言内容（kind/contains），已按定位器兜底`);
      } else {
        warnings.push(`${label} assert 既没有断言内容也没有定位器，产物里不会有这一步`);
      }
    } else {
      elementLike = true;
      if (hasLocator) {
        locatorValue = selectorOf(step);
      } else {
        warnings.push(`${label} ${action} 没有定位器，产物里不会有这一步（先在元素库里补一条）`);
      }
      if (action === 'fill' && !envNameOf(step.valueRef || '')) {
        // 占位名必须可检索：用户看到 STEP_n_VALUE 才知道要在产物里改哪里
        warnings.push(
          `${label} fill 没填环境变量名（valueRef），已用占位名 STEP_${index + 1}_VALUE；`
          + '口令只从环境变量读，产物里不会有明文',
        );
      }
      if (action === 'select' && !envNameOf(step.valueRef || '')) {
        // ⚠️ select 不需要环境变量也能回放（只按选项序号），所以这里**不造占位名**——
        // 造了就是一个永远没人设的假环境变量。但契约 `[C-119]` 第 4 款要求「未填 valueRef 的
        // fill / select 必须给 warnings」，所以照给，只是措辞说清「不会生成空值」。
        warnings.push(
          `${label} select 没填环境变量名（valueRef）；回放按选项序号 ${selectedIndexOf(step) ?? 0} 选，`
          + '不会生成空值（需要传值请在录制页补 valueRef）',
        );
      }
      if (action === 'select' && selectedIndexOf(step) === null) {
        warnings.push(`${label} select 没有记录选项序号，回放时按 0 处理（请手工确认）`);
      }
    }

    const envName = action === 'fill'
      ? (envNameOf(step.valueRef || '') || `STEP_${index + 1}_VALUE`)
      // select 只在**显式给了** valueRef 时才要环境变量；没给就按选项序号回放，不造假变量
      : action === 'select'
        ? envNameOf(step.valueRef || '')
        : '';

    const call: ScriptCall = {
      index,
      action,
      locatorValue,
      locatorKind: hasLocator && step.locator ? step.locator.kind : '',
      elementLike,
      pomLocator: pomLocatorOf(step),
      pomKind: pomKindOf(step),
      warnings,
    };
    if (step.locator && step.locator.roleName) call.roleName = String(step.locator.roleName);
    if (action === 'select') call.selectedIndex = selectedIndexOf(step) ?? 0;
    if (envName) call.valueRef = envName;
    if (step.assert) call.assert = { kind: step.assert.kind, contains: String(step.assert.contains) };
    if (step.note) call.note = oneLine(step.note);
    calls.push(call);
  });

  return withStartNavigation(rec, calls);
}

/** `http(s)://` 开头的绝对地址才算「能导航」（`location.href` 不接受别的 scheme） */
function isNavigableUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(String(url || ''));
}

/**
 * 补起始导航（t32 / S7-D-1 的修法落点）。
 *
 * **在生成侧补，不在录制侧补**：
 * - 录制侧补要往 `uiRecordings` 里塞一条假的 `UiStep` —— 那会把 `steps[i].index` 与
 *   J-15 的 `elementId` 一一对应一起打乱（还污染 AC-20 的「步骤数」）；
 * - 生成侧补只是往**调用序列**最前加一条 `preamble` 调用，`rec.steps` 一个字节都不动。
 *
 * 三种情形（都不编造）：
 * 1. 首条已经是 `navigate` → 原样返回（不重复）；
 * 2. 首条不是 `navigate` 且 `baseUrl` 是 http(s) 绝对地址 → 最前插 `navigate(baseUrl)`；
 * 3. `baseUrl` 为空/不是 http(s) → **不插**，并在第一条真实步骤上留一条可读告警
 *    （宁可让产物少一步导航，也不要生成 `location.href = ''` 这种一定失败的第一步）。
 */
function withStartNavigation(rec: UiRecording, calls: ScriptCall[]): ScriptCall[] {
  if (calls.length === 0) return calls; // 空录制：不造导航（否则「空录制产出空调用」这条不变量就破了）
  if (calls[0].action === 'navigate') return calls;

  const baseUrl = String((rec && rec.baseUrl) || '');
  if (!isNavigableUrl(baseUrl)) {
    calls[0].warnings.push(
      `录制没有可用的 baseUrl（当前「${baseUrl || '空'}」），产物里不会有起始导航；`
      + '回放前请先手工打开目标页，或重新录一次',
    );
    return calls;
  }

  const preamble: ScriptCall = {
    index: -1,
    action: 'navigate',
    locatorValue: baseUrl,
    locatorKind: '',
    elementLike: false,
    pomLocator: '',
    pomKind: 'css',
    warnings: [],
    preamble: true,
  };
  return [preamble, ...calls];
}

/** 产物里出现的环境变量名（去重、按首现顺序）——`.mjs` 启动时逐条检查 */
export function envRefsOf(calls: ScriptCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    if (c.valueRef && out.indexOf(c.valueRef) < 0) out.push(c.valueRef);
  }
  return out;
}

/* ================================================================
   2. 产物容器
   ================================================================ */

/** 一份产物（预览/复制/保存都用它；`code` 是**原文**，不是 innerHTML） */
export interface ScriptArtifact {
  id: ArtifactId;
  ok: boolean;
  /** 建议文件名（确定性：同一份录制永远同一个名字） */
  filename: string;
  code: string;
  /** 交给 `<CodeBlock>` 的语言（复用既有高亮器，不新写） */
  lang: 'java' | 'js' | 'ts';
  /** 一键复制到终端跑的命令（POM 给的是编译命令，它在产物①里只是骨架） */
  runCommand: string;
  /** 三档前置（展示用，与 `ARTIFACT_PREREQ` 同源） */
  prereq: string;
  warnings: string[];
  error?: string;
}

/** 文件名基名：`<域名>-<日期>`，字符集收成 `[a-z0-9-]`（确定性、无时间戳） */
function fileBaseOf(rec: UiRecording): string {
  let host = '';
  try {
    host = new URL(String(rec.baseUrl || '')).host;
  } catch { host = ''; }
  const slug = (host || 'recording')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'recording';
  const day = String(rec.startedAt || '').slice(0, 10).replace(/-/g, '') || 'nodate';
  return `${slug}-${day}`;
}

/** `example-com-20261126` → `ExampleComPage`（合法 Java 标识符） */
function classNameOf(rec: UiRecording): string {
  let host = '';
  try {
    host = new URL(String(rec.baseUrl || '')).host;
  } catch { host = ''; }
  const words = (host || 'recorded').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  const name = `${pascal || 'Recorded'}Page`;
  return /^[A-Za-z_$]/.test(name) ? name : `P${name}`;
}

/** 汇总告警（逐调用收集，保持步骤顺序；去重） */
function collectWarnings(calls: ScriptCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    for (const w of c.warnings) if (out.indexOf(w) < 0) out.push(w);
  }
  return out;
}

/** JSON 字符串字面量（`.mjs` / `*.spec.ts` 的转义一律走它，不原样拼接） */
function js(value: string): string {
  return JSON.stringify(String(value ?? ''));
}

/** 单引号字符串（`.mjs` 里的环境变量名，形如 `'ACCOUNT'`） */
function sq(value: string): string {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** RegExp 字面量的内容转义（`contains` 是「包含」语义，不是正则） */
function reEscape(value: string): string {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ================================================================
   3. 零依赖 .mjs（Node ≥ 22）
   ================================================================ */

/**
 * 生成的 `.mjs` 里那段**页内执行器**（`Runtime.evaluate` 注入）。
 *
 * 为什么是一段字符串：CDP 只能执行表达式；把它写成常量而不是「拼进每个步骤」，
 * 是为了让步骤表保持纯数据（参数化，不拼代码——SEC-02 的同一条纪律）。
 */
/**
 * 产物的**运行期助手**（t40 / D-1 续）：超时、上下文失效识别、等就绪、失效重试。
 *
 * 为什么单独导出：这四段逻辑是「不挂死」的全部依据，必须能被单测**真跑**（不是只看字符串），
 * 所以测试里 `new Function(RUNTIME_HELPERS + ...)` 直接执行它们；产物也原样内联同一份，
 * 保证「测的那份 = 发出去的那份」。
 */
export const RUNTIME_HELPERS = `/**
 * 用法错误/超时一律走这里：**任何终止路径都必须有输出**（t40：S7 观测到 180s 被 SIGTERM 杀掉且零输出）。
 */
function fatal(消息) {
  try { console.error(String(消息)); } catch (e) { /* 连 stderr 都写不进去时也没别的办法 */ }
  process.exit(1);
}

/** 把「上下文已失效」这一类错误与真正的业务失败区分开 */
function isContextLost(e) {
  var msg = String((e && (e.message || e.stack)) || e || '');
  return /Execution context was destroyed|Cannot find context|Inspected target navigated|Target closed|has been closed|CDP .* 超时/.test(msg);
}

/** 给任意 promise 套一个有界等待：超时返回 { timedOut: true }，不当场抛（方便上层决定怎么报） */
function withTimeout(promise, ms, note) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve({ timedOut: true, note: note || '' });
    }, ms);
    promise.then(
      function (v) { if (!done) { done = true; clearTimeout(timer); resolve({ timedOut: false, value: v, note: note || '' }); } },
      function (e) { if (!done) { done = true; clearTimeout(timer); resolve({ timedOut: false, error: e, note: note || '' }); } }
    );
  });
}

/**
 * 等页面就绪：轮询 document.readyState === 'complete'，有界（默认 10s）。
 * 导航提交期间 Runtime.evaluate 可能**根本拿不到回包**（旧上下文已销毁、新上下文还没好），
 * 这种「上下文切换中」按「还没就绪」处理、继续等，而不是当成失败。
 */
async function waitReady(evaluate, timeoutMs, sleepFn) {
  var sleep = sleepFn || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var t0 = Date.now();
  var lastState = '(未取到)';
  for (;;) {
    try {
      var s = await evaluate('document.readyState');
      if (typeof s === 'string' && s) lastState = s;
      if (s === 'complete') return { ready: true, lastState: lastState };
    } catch (e) {
      if (!isContextLost(e)) throw e;
      lastState = '(上下文切换中)';
    }
    if (Date.now() - t0 >= timeoutMs) return { ready: false, lastState: lastState };
    await sleep(120);
  }
}

/** 上下文失效 → 重试（最多 2 次）；其他错误立刻上抛，不掩盖真实失败 */
async function evaluateWithRetry(fn, attempts, sleepFn) {
  var max = typeof attempts === 'number' ? attempts : 2;
  var sleep = sleepFn || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var retries = 0;
  for (;;) {
    try {
      return { value: await fn(), retries: retries };
    } catch (e) {
      if (!isContextLost(e) || retries >= max) throw e;
      retries += 1;
      await sleep(150);
    }
  }
}`;

/**
 * target 选择与「上下文」相关的运行期助手（t47 / D-1 第四次）。
 *
 * 为什么单独导出：这三段是「连哪个标签页」「等什么才算就绪」「上下文丢了怎么办」的判据，
 * 必须能被单测**真跑**（不是只看字符串）。产物原样内联同一份。
 *
 * 三处修复的根因（A 场景实测）：
 * 1) target 选择太弱：只按 `url.indexOf(BASE_URL) === 0` 前缀匹配，录制 URL 带
 *    `?projectCode=` 时就匹配不上；而 Chrome 带 URL 启动时常同时存在 `about:blank`。
 *    → 改成「同源+同路径 > 同源 > 任意非空白」，并对「暂时只有空白」给**有界等待**。
 * 2) 就绪判据看错了对象：`about:blank` 这个**旧文档**本身就是 `complete`，
 *    只判 `readyState === 'complete'` 会在新页面还没 commit 时就放行 →
 *    第 1 步落在 about:blank 上找不到元素。→ 必须同时要求「URL 已经变成目标页」。
 * 3) 上下文丢失后不重取：导航把旧 executionContext 销毁后 evaluate 拿不到回包/报
 *    `Cannot find context`，原来只能干等 10s。→ 捕获后重取上下文再试（≤2 次）。
 */
export const RUNTIME_TARGETING = `/** 上下文重取的**最大次数**（t52：无界重取 = 静默挂死） */
const MAX_CONTEXT_RETRY = 2;

function parseUrlSafe(u) {
  try { return new URL(String(u || '')); } catch (e) { return null; }
}

/** 空白/内部页面一律不算「可回放的目标页」 */
function isBlankUrl(u) {
  var s = String(u || '').trim().toLowerCase();
  return s === '' || s === 'about:blank'
    || s.indexOf('chrome://') === 0 || s.indexOf('devtools://') === 0 || s.indexOf('edge://') === 0;
}

/** 0=空白/非 page，1=任意非空白页，2=同源，3=同源且同路径（忽略查询串） */
function targetScore(t, baseUrl) {
  if (!t || t.type !== 'page') return 0;
  var url = String(t.url || '');
  if (isBlankUrl(url)) return 0;
  var bu = parseUrlSafe(baseUrl);
  var tu = parseUrlSafe(url);
  if (bu && tu) {
    if (tu.origin === bu.origin && tu.pathname === bu.pathname) return 3;
    if (tu.origin === bu.origin) return 2;
  }
  if (baseUrl && url.indexOf(baseUrl) === 0) return 3;
  return 1;
}

/** 从一次 /json/list 结果里挑一个：分高的在前，同分保留原顺序（Chrome 把最近活跃的排前面 = 最新优先） */
function pickTarget(list, baseUrl) {
  var pages = (list || []).filter(function (t) { return t && t.type === 'page'; });
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < pages.length; i += 1) {
    var s = targetScore(pages[i], baseUrl);
    if (s > bestScore) { best = pages[i]; bestScore = s; }
  }
  return best;
}

/**
 * 有界等待一个可用 target（≤ timeoutMs）。
 * 为什么必须有这一步：Chrome 带 URL 启动时，目标页的第一个 commit 可能比调试端口晚，
 * 这一刻 /json/list 里只有 about:blank —— 立刻退出会把「马上就好」误判成「没打开目标页」。
 */
async function pickTargetWithWait(listFn, baseUrl, timeoutMs, sleepFn) {
  var sleep = sleepFn || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var t0 = Date.now();
  for (;;) {
    var list = await listFn();
    var hit = pickTarget(list, baseUrl);
    if (hit) return hit;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(200);
  }
}

/**
 * 导航后「真的进到目标页了」才算就绪：
 * **URL 已切换**（同源+同路径）**且** readyState === 'complete'。
 * 只判 readyState 会被旧文档骗过（about:blank 天生 complete）。
 */
async function waitForUrlReady(evaluate, expectUrl, timeoutMs, sleepFn, onLost) {
  var sleep = sleepFn || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var t0 = Date.now();
  var last = { url: '', state: '' };
  var bu = parseUrlSafe(expectUrl);
  var lostCount = 0;
  for (;;) {
    try {
      var raw = await evaluate('JSON.stringify({url: String(location.href), state: document.readyState})');
      var parsed = null;
      try { parsed = JSON.parse(String(raw || '{}')); } catch (e) { parsed = null; }
      if (parsed && parsed.url) {
        last = { url: String(parsed.url || ''), state: String(parsed.state || '') };
      }
      var tu = parseUrlSafe(last.url);
      var sameUrl = false;
      if (last.url && !isBlankUrl(last.url)) {
        if (bu && tu) sameUrl = (tu.origin === bu.origin && tu.pathname === bu.pathname);
        else if (expectUrl) sameUrl = last.url.indexOf(expectUrl) === 0;
        else sameUrl = true;
      }
      if (sameUrl && last.state === 'complete') return { ready: true, url: last.url, state: last.state, reason: 'ok' };
    } catch (e) {
      if (!isContextLost(e)) throw e;
      last = { url: last.url, state: '(上下文切换中)' };
      // t50/t52：上下文不可用时主动重取，但**额度必须有限**。
      // t51 的「60s 被杀 + stdout 全空」就是这里没有出口：每次 onLost 都要发 2 条 CDP（各 4s 超时）
      // + 等新上下文，continue 又跳过了下面的时限检查 → 上层一直等不到结论，外部只能杀进程。
      // 现在：额度用完就**立刻返回 not-ready**，由上层打印中文诊断并 exit 1（保证有输出）。
      if (onLost && lostCount < MAX_CONTEXT_RETRY) {
        lostCount += 1;
        try { await onLost(); } catch (e2) { /* 重取失败也继续，别掩盖原始错误 */ }
        if (lostCount >= MAX_CONTEXT_RETRY) {
          return { ready: false, url: last.url, state: last.state, reason: 'context-lost' };
        }
        continue;
      }
      return { ready: false, url: last.url, state: last.state, reason: 'context-lost' };
    }
    if (Date.now() - t0 >= timeoutMs) return { ready: false, url: last.url, state: last.state, reason: 'timeout' };
    await sleep(150);
  }
}

/**
 * 带上下文重取的重试：只对「上下文没了」这类错误重试，业务失败（找不到元素）立刻上抛。
 * onReacquire 由调用方提供（重新 Runtime.enable + 等新 executionContextCreated）。
 */
async function evaluateWithContext(send, opts) {
  var o = opts || {};
  var max = typeof o.attempts === 'number' ? o.attempts : 2;
  var sleep = o.sleepFn || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var retries = 0;
  var reacquired = 0;
  for (;;) {
    try {
      return { value: await send(), retries: retries, reacquired: reacquired };
    } catch (e) {
      var msg = String((e && (e.message || e.stack)) || e || '');
      var lost = /Execution context was destroyed|Cannot find context|Inspected target navigated|Target closed|has been closed/.test(msg);
      if (!lost || retries >= max) throw e;
      retries += 1;
      if (o.onReacquire) {
        reacquired += 1;
        try { await o.onReacquire(); } catch (e2) { /* 重取失败也再试一次，避免掩盖真实错误 */ }
      }
      await sleep(150);
    }
  }
}`;

const PAGE_RUNNER = [
  'async function dshStep(step, value) {',
  '  // 防御纵深（t32）：载荷被 JSON.stringify 两次时这里收到的是字符串，',
  '  // 若不拦，step.action / step.selector 全是 undefined，报错会变成「找不到元素：undefined」——',
  '  // 那种提示对排障毫无用处，所以宁可当场说清是载荷格式问题。',
  '  if (!step || typeof step !== \'object\') return \'步骤载荷格式不对（应为对象，实际收到 \' + typeof step + \'）\';',
  '  function find(sel) {',
  '    if (!sel) return null;',
  '    if (sel.slice(0, 5) === \'text=\') {',
  '      var want = sel.slice(5).replace(/\\s+/g, \' \').trim();',
  '      var all = document.querySelectorAll(\'body *\');',
  '      for (var i = all.length - 1; i >= 0; i -= 1) {',
  '        var el = all[i];',
  '        var t = (el.textContent || \'\').replace(/\\s+/g, \' \').trim();',
  '        if (t && t.indexOf(want) >= 0) return el;',
  '      }',
  '      return null;',
  '    }',
  '    if (sel.slice(0, 7) === \'xpath=\') {',
  '      try { return document.evaluate(sel.slice(7), document, null, 9, null).singleNodeValue; }',
  '      catch (e) { return null; }',
  '    }',
  '    if (sel.slice(0, 5) === \'role=\') {',
  '      var m = sel.slice(5).match(/^([A-Za-z]+)(?:\\[name="(.*)"\\])?$/);',
  '      if (!m) return null;',
  '      var nodes = document.querySelectorAll(\'[role="\' + m[1] + \'"]\');',
  '      if (!m[2]) return nodes[0] || null;',
  '      for (var j = 0; j < nodes.length; j += 1) {',
  '        var a = (nodes[j].getAttribute(\'aria-label\') || nodes[j].textContent || \'\').replace(/\\s+/g, \' \').trim();',
  '        if (a === m[2]) return nodes[j];',
  '      }',
  '      return null;',
  '    }',
  '    return document.querySelector(sel);',
  '  }',
  '  function setValue(el, text) {',
  '    if (el.isContentEditable) {',
  '      el.textContent = text;',
  '    } else {',
  '      var proto = el.tagName === \'TEXTAREA\' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;',
  '      var desc = Object.getOwnPropertyDescriptor(proto, \'value\');',
  '      if (desc && desc.set) desc.set.call(el, text); else el.value = text;',
  '    }',
  '    el.dispatchEvent(new Event(\'input\', { bubbles: true }));',
  '    el.dispatchEvent(new Event(\'change\', { bubbles: true }));',
  '  }',
  '  if (step.action === \'navigate\') {',
  '    location.href = step.selector;',
  '    return \'navigated\';',
  '  }',
  '  if (step.action === \'assert\') {',
  '    var body = document.body ? document.body.innerText : \'\';',
  '    if (step.assertKind === \'url\') return location.href.indexOf(step.expected) >= 0 ? \'ok\' : \'url 不含 \' + step.expected + \'（当前 \' + location.href + \'）\';',
  '    if (step.assertKind === \'title\') return String(document.title).indexOf(step.expected) >= 0 ? \'ok\' : \'标题不含 \' + step.expected + \'（当前 \' + document.title + \'）\';',
  '    return body.indexOf(step.expected) >= 0 ? \'ok\' : \'页面文本不含 \' + step.expected;',
  '  }',
  '  var el = find(step.selector);',
  '  if (!el) return \'找不到元素：\' + step.selector;',
  '  if (step.action === \'click\') { el.scrollIntoView({ block: \'center\' }); el.click(); return \'ok\'; }',
  '  if (step.action === \'fill\') { el.focus(); setValue(el, value); return \'ok\'; }',
  '  if (step.action === \'select\') {',
  '    var idx = typeof step.index === \'number\' ? step.index : 0;',
  '    if (idx >= el.options.length) return \'选项序号越界：\' + idx;',
  '    el.selectedIndex = idx;',
  '    el.dispatchEvent(new Event(\'change\', { bubbles: true }));',
  '    return \'ok\';',
  '  }',
  '  if (step.action === \'press\') {',
  '    el.dispatchEvent(new KeyboardEvent(\'keydown\', { key: step.key || \'Enter\', bubbles: true }));',
  '    el.dispatchEvent(new KeyboardEvent(\'keyup\', { key: step.key || \'Enter\', bubbles: true }));',
  '    return \'ok\';',
  '  }',
  '  return \'未知动作：\' + step.action;',
  '}',
].join('\n');

/** 步骤表里的一行（纯数据，参数化交给页内执行器） */
function mjsStepRow(c: ScriptCall): string {
  // `no` = 录制里的第几步（1 起）；起始导航这类前置是 0 —— 失败提示用它，不用循环下标凑数
  // （t32：补了前置之后，循环下标 `i+1` 会把第 1 步报成「第 2 步」）
  const parts: string[] = [`no: ${c.preamble ? 0 : c.index + 1}`, `action: ${sq(c.action)}`];
  if (c.action === 'assert') {
    // 断言行只放断言内容（不再塞一个空的 selector：空串是噪音，也让抽取器多一条空路径）
    parts.push(`assertKind: ${sq(c.assert ? c.assert.kind : 'text')}`);
    parts.push(`expected: ${js(c.assert ? c.assert.contains : c.locatorValue)}`);
  } else {
    parts.push(`selector: ${js(c.locatorValue)}`);
  }
  if (c.valueRef && (c.action === 'fill' || c.action === 'select')) parts.push(`env: ${sq(c.valueRef)}`);
  if (c.action === 'select') parts.push(`index: ${c.selectedIndex ?? 0}`);
  if (c.action === 'press') parts.push("key: 'Enter'");
  if (c.preamble) parts.push('preamble: true');
  return `  { ${parts.join(', ')} },`;
}

/**
 * 零依赖 `.mjs`（单文件、Node ≥ 22）。
 *
 * 为什么是「步骤表 + 通用执行器」而不是「每步一段代码」：
 * 1. 单文件里唯一需要写逻辑的地方是 CDP 连接与页内找元素，那段逻辑**只写一次**；
 * 2. 步骤表是纯数据 ⇒ 每个定位器字面量在产物里**只出现一次**，AC-20 的抽取不会歧义；
 * 3. 用户改一条定位器只需改一处，不用在 300 行脚本里找。
 */
/**
 * ② 零依赖 .mjs 回放脚本 —— **本期未交付（P3）**。
 *
 * 状态：AC-10a（「一条命令跑通 + 两个明示前置」）**六轮未通过**，末轮失败形态为
 * Page.navigate 4 s 超时 + eadyFor 上下文重取无界（已在本轮改为有界，但仍未跑通）。
 * 按用户裁定：产物② 从交付中拿掉，进 P3 重做。
 *
 * 铁律：**不要**把它重新接回 ArtifactPicker 或 uildArtifacts()，
 * 除非先在本机把 AC-10a 真跑成 exit 0（两个场景：浏览器已开目标页 / 干净起步按降级契约）。
 * 本函数与其用例保留，是为了 P3 有起点，不是因为它可用。
 */
export function buildMjsScript(rec: UiRecording): ScriptArtifact {
  const calls = stepsToCalls(rec);
  const envRefs = envRefsOf(calls);
  const warnings = collectWarnings(calls);
  const filename = `${fileBaseOf(rec)}.mjs`;
  const name = oneLine(rec.name || '未命名录制', 60);

  const lines: string[] = [
    '#!/usr/bin/env node',
    '/**',
    ` * ${name} —— UI 录制回放脚本（零依赖、单文件，由「测试中台 · UI 录制器」生成）。`,
    ` * 录制步骤：${rec.steps.length} 步；baseUrl：${oneLine(rec.baseUrl || '', 200)}`,
    ' *',
    ' * 【场景契约｜先读这一段】',
    ' *   本脚本支持的回放场景是「浏览器**已经打开了目标页**」——也就是录制的正常路径：',
    ' *   你先在 Chrome 里打开被测系统，再回应用里点开始录制。回放时请照样先用**同一个** Chrome',
    ' *   把上面的 baseUrl 打开，再运行本脚本。',
    ' *   本期**不支持**从干净的 about:blank 起步：那种情况下脚本连上后会打印一条可照做的提示并',
    ' *   以 exit 1 结束（不会静默失败，也不会假装跑通）。',
    ' *',
    ' * 前置（三条，缺一条都跑不起来；已按前置校验，结果以你实际运行为准）：',
    ' *   1) Node ≥ 22 —— 本脚本用全局 WebSocket 走 CDP，Node 18/20 没有这个全局对象；',
    ' *   2) 一个带调试端口、且**已经打开目标页**的 Chrome（用临时 profile，别用日常那份）：',
    ' *      chrome --remote-debugging-port=9222 --user-data-dir=%TEMP%\\rec-play --no-first-run <baseUrl>',
    ' *      CDP_ENDPOINT 可选，默认 http://127.0.0.1:9222；',
    ' *   3) 环境变量（缺任何一个都会 exit 2，绝不拿空值去回放）：',
    ` *      ${envRefs.length ? `${envRefs[0]}=xxx ` : ''}node ${filename}`,
    ' *',
    ' * 口径：口令只从环境变量读，**脚本里没有明文**；本脚本不写文件、不落日志。',
    ' * 本文件是「按录制逐步回放」的参考实现，**不在任何环境承诺结果**（能不能跑通取决于被测站点',
    ' * 与你给的前置），不要把它当成已验收的结论。',
    ' */',
    '',
    "const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';",
    '/** 录制时的目标页地址：干净起步时用它给出「请先打开哪个页」这类可照做的提示 */',
    `const BASE_URL = ${js(String(rec.baseUrl || ''))};`,
    // 录制步骤数：**不含**起始导航这类前置（AC-10a 的判据是「打印步骤数 = 录制步骤数」）
    `const RECORDED_STEPS = ${rec.steps.length};`,
    '',
    '/** 步骤表：与录制一一对应（顺序不变）；`no` = 录制里的第几步（起始导航是 0）。selector 是该步唯一的那串定位器。 */',
    'const STEPS = [',
    ...calls.map(mjsStepRow),
    '];',
    '',
    '/** 需要的环境变量（缺一个就退出，绝不拿空值去回放） */',
    `const ENV_REFS = [${envRefs.map(sq).join(', ')}];`,
    '',
    'function exitWith(消息) {',
    '  console.error(消息);',
    '  process.exit(1);',
    '}',
    '',
    'const missing = ENV_REFS.filter(function (name) { return !process.env[name]; });',
    'if (missing.length > 0) {',
    "  console.error('缺少环境变量：' + missing.join('、') + '；口令只从环境变量读取，脚本里不会有明文。');",
    '  process.exit(2);',
    '}',
    '',
    PAGE_RUNNER,
    '',
    ...RUNTIME_HELPERS.split('\n'),
    '',
    ...RUNTIME_TARGETING.split('\n'),
    '',
    '// PM_DEBUG=1 时把定位用的三样打到 stderr（候选列表 / 选中的 target / 每次 evaluate 的 contextId）',
    "const DEBUG = String(process.env.PM_DEBUG || '') === '1';",
    'function dbg(消息) { if (DEBUG) console.error(\'[pm-debug] \' + String(消息)); }',
    '// 三条时限（t40）：单条 CDP 命令 / 每步整体 / 导航后等就绪。',
    '// 刻意都远小于 S7 观测到的 180s —— 那不是「调大超时让它看起来不挂」，而是把挂死变成有诊断的失败。',
    'const CDP_TIMEOUT_MS = 4000;',
    'const STEP_TIMEOUT_MS = 5000;',
    'const READY_TIMEOUT_MS = 10000;',
    'const READY_PROBE_MS = 1500;',
    '// 等「出现一个可用 page target」的上限（Chrome 带 URL 启动时首帧可能晚于调试端口）',
    'const TARGET_WAIT_MS = 10000;',
    '// 导航后等 Page.loadEventFired 的上限（等不到不算致命，后面还有 URL+readyState 兜底）',
    'const NAV_TIMEOUT_MS = 8000;',
    '// 上下文重取的单次预算（t52：原来每次重取 ~10s，重取无界就把进程拖死）',
    'const REACQUIRE_TIMEOUT_MS = 1500;',
    'const REACQUIRE_WAIT_MS = 1200;',
    '// 单个导航步的总预算（导航 + 等就绪 + 重取），超了就带诊断退出 —— 不允许静默拖到被外部杀',
    'const NAV_STEP_BUDGET_MS = 15000;',
    '// 总看门狗：任何没被上面三条覆盖的挂死，到点也会打印并退出（绝不允许零输出）',
    'const TOTAL_WATCHDOG_MS = 120000;',
    "let LAST_URL = '(尚未取到)';",
    'const watchdog = setTimeout(function () {',
    "  fatal('总时长超过 ' + TOTAL_WATCHDOG_MS + 'ms，回放已中止；最后已知 URL：' + LAST_URL);",
    '}, TOTAL_WATCHDOG_MS);',
    'if (watchdog && watchdog.unref) watchdog.unref();',
    '',
    "process.on('uncaughtException', function (e) { fatal('未捕获异常：' + (e && e.stack ? e.stack : String(e))); });",
    "process.on('unhandledRejection', function (e) { fatal('未处理的 Promise 拒绝：' + (e && e.stack ? e.stack : String(e))); });",
    "process.on('SIGTERM', function () { fatal('收到 SIGTERM（被外部终止，常见于调用方的超时上限）：回放已中止；最后已知 URL：' + LAST_URL); });",
    "process.on('SIGINT', function () { fatal('收到 SIGINT（Ctrl+C）：回放已中止；最后已知 URL：' + LAST_URL); });",
    '',
    '/** 取一遍 /json/list（连不上就带诊断退出） */',
    'async function listTargets() {',
    '  let res;',
    '  try {',
    "    res = await fetch(CDP_ENDPOINT + '/json/list');",
    '  } catch (e) {',
    "    throw new Error('连不上 Chrome（CDP_ENDPOINT=' + CDP_ENDPOINT + '）：先用 --remote-debugging-port=9222 起一个带临时 profile 的 Chrome，再跑本脚本');",
    '  }',
    '  if (!res.ok) {',
    "    throw new Error('连不上 Chrome（CDP_ENDPOINT=' + CDP_ENDPOINT + '）：HTTP ' + res.status + '，请确认调试端口已开');",
    '  }',
    '  const targets = await res.json();',
    '  return Array.isArray(targets) ? targets.filter(function (t) { return t && t.webSocketDebuggerUrl; }) : [];',
    '}',
    '',
    '/** 一遍 target 选择：候选列表与最终选中都按 PM_DEBUG 打点（qa 定位用） */',
    'async function chooseTarget() {',
    '  const hit = await pickTargetWithWait(async function () {',
    '    const list = await listTargets();',
    "    dbg('/json/list 候选：' + list.map(function (t) { return t.id + ' | ' + t.type + ' | ' + t.url; }).join(' ;; '));",
    '    return list;',
    '  }, BASE_URL, TARGET_WAIT_MS);',
    '  if (hit) dbg(\'选中 target：\' + hit.id + \' | \' + hit.url);',
    "  else dbg('选中 target：（无）—— 等满 ' + TARGET_WAIT_MS + 'ms 仍没有可用的 page target');",
    '  return hit;',
    '}',
    '',
    'async function connect() {',
    "  if (!BASE_URL) dbg('录制没有 baseUrl：target 选择将退化为「任意非空白页」');",
    '  let page;',
    '  try {',
    '    page = await chooseTarget();',
    '  } catch (e) {',
    "    exitWith('连不上 Chrome（CDP_ENDPOINT=' + CDP_ENDPOINT + '）：' + (e && e.message ? e.message : String(e)) + '。先用 --remote-debugging-port=9222 起一个带临时 profile 的 Chrome');",
    '    return null;',
    '  }',
    '  if (!page) {',
    "    exitWith('当前调试端口上没有打开目标页。请先用同一个 Chrome 打开 ' + (BASE_URL || '录制时的目标页') + ' 再运行本脚本；本期的 .mjs 只支持「浏览器已打开目标页」的场景，干净 about:blank 起步不在支持范围。');",
    '    return null;',
    '  }',
    '  if (BASE_URL) LAST_URL = String(page.url || BASE_URL);',
    '  const ws = new WebSocket(page.webSocketDebuggerUrl);',
    '  await new Promise(function (resolve, reject) {',
    "    ws.addEventListener('open', resolve, { once: true });",
    "    ws.addEventListener('error', function () { reject(new Error('CDP WebSocket 连接失败')); }, { once: true });",
    '  });',
    '  let nextId = 0;',
    '  const pending = new Map();',
    "  ws.addEventListener('message', function (ev) {",
    '    let msg;',
    '    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }',
    '    const p = pending.get(msg.id);',
    '    if (!p) return;',
    '    pending.delete(msg.id);',
    "    if (msg.error) {",
    "      const err = new Error(msg.error.message || 'CDP 调用失败');",
    '      err.code = msg.error.code;',
    "      dbg('CDP ← error id=' + String(msg.id) + ' code=' + String(msg.error.code) + ' message=' + String(msg.error.message || ''));",
    '      p.reject(err);',
    '    }',
    '    else p.resolve(msg.result);',
    '  });',
    '  function send(method, params, timeoutMs) {',
    '    return new Promise(function (resolve, reject) {',
    '      const id = ++nextId;',
    '      let done = false;',
    '      const timer = setTimeout(function () {',
    '        if (done) return;',
    '        done = true;',
    '        pending.delete(id);',
    "        reject(new Error('CDP ' + method + ' 超时（' + (timeoutMs || CDP_TIMEOUT_MS) + 'ms）：页面可能正在导航或渲染进程卡住'));",
    '      }, timeoutMs || CDP_TIMEOUT_MS);',
    '      pending.set(id, {',
    '        resolve: function (v) { if (done) return; done = true; clearTimeout(timer); resolve(v); },',
    '        reject: function (e) { if (done) return; done = true; clearTimeout(timer); reject(e); },',
    '      });',
    '      try {',
    '        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));',
    '      } catch (e) {',
    '        pending.delete(id);',
    "        if (!done) { done = true; clearTimeout(timer); reject(new Error('CDP 发送失败：' + (e && e.message ? e.message : String(e)))); }",
    '      }',
    '    });',
    '  }',
    "  // 连接断了必须把在途命令全部 reject —— 否则 promise 永远不 settle，进程静默挂死（t40 的 180s 零输出）",
    "  ws.addEventListener('close', function () {",
    '    pending.forEach(function (p) {',
    "      try { p.reject(new Error('CDP 连接已关闭（页面或浏览器可能已退出）')); } catch (e) { /* 忽略 */ }",
    '    });',
    '    pending.clear();',
    '  });',
    '  // ── 执行上下文跟踪（t47）：导航会销毁旧 context，拿住最新的那个 id 才算真连上了新文档 ──',
    '  let ctxId = null;',
    '  let ctxSeq = 0;',
    '  // 事件总线容器**必须先于监听器声明**（const 有 TDZ：早到的事件会撞上未初始化）',
    '  const eventWaiters = new Map();',
    '  // 页面级事件在这里分发（Page.loadEventFired / Page.frameNavigated …）',
    "  ws.addEventListener('message', function (ev) {",
    '    let msg;',
    '    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }',
    '    if (msg.method) dispatchEvent(msg.method);',
    '  });',
    "  ws.addEventListener('message', function (ev) {",
    '    let msg;',
    '    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }',
    "    if (msg.method === 'Runtime.executionContextCreated' && msg.params && msg.params.context) {",
    '      const c = msg.params.context;',
    "      if (c.auxData && c.auxData.isDefault === false) return;",
    '      const before = ctxId;',
    '      ctxId = c.id;',
    '      ctxSeq += 1;',
    "      dbg('executionContextId: ' + String(before) + ' → ' + String(ctxId) + '（' + String(c.origin || '') + ' ' + String(c.name || '') + '）');",
    '    }',
    "    if (msg.method === 'Runtime.executionContextDestroyed' && msg.params) {",
    '      if (ctxId !== null && msg.params.executionContextId === ctxId) {',
    "        dbg('executionContextId ' + String(ctxId) + ' 已销毁（导航）→ 置空，稍后重取');",
    '        ctxId = null;',
    '      }',
    '    }',
    '  });',
    '  // 一上来就开启 Runtime 域：这样能拿到真实的 executionContextId（打点要用），',
    '  // 也能收到上下文销毁事件 —— 否则只能靠 evaluate 报错才发现「上下文没了」。',
    '  try {',
    '    await send(\'Runtime.enable\', {}, CDP_TIMEOUT_MS);',
    '    // Page 域也要开：导航后等 Page.loadEventFired 靠它（浏览器级事件，不依赖页面上下文）',
    '    await send(\'Page.enable\', {}, CDP_TIMEOUT_MS);',
    '    const c0 = Date.now();',
    '    while (ctxId === null && Date.now() - c0 < 1000) {',
    '      await new Promise(function (r) { setTimeout(r, 50); });',
    '    }',
    '  } catch (e) {',
    "    dbg('Runtime.enable 失败（将按默认上下文执行）：' + (e && e.message ? e.message : String(e)));",
    '  }',
    "  dbg('初始 executionContextId=' + String(ctxId) + ' | target=' + String(page.id));",
    '  // ── 事件总线（t50）：等 Page.loadEventFired 这类**浏览器级**事件，不依赖页面上下文 ──',
    '  function waitEvent(method, timeoutMs) {',
    '    return new Promise(function (resolve) {',
    '      const arr = eventWaiters.get(method) || [];',
    '      let done = false;',
    '      const fire = function (ok) { if (done) return; done = true; resolve(ok); };',
    '      const timer = setTimeout(function () { fire(false); }, timeoutMs);',
    "      if (timer && timer.unref) timer.unref();",
    '      arr.push(function () { clearTimeout(timer); fire(true); });',
    '      eventWaiters.set(method, arr);',
    '    });',
    '  }',
    '  function dispatchEvent(method) {',
    '    const arr = eventWaiters.get(method);',
    '    if (!arr || !arr.length) return;',
    '    eventWaiters.set(method, []);',
    '    arr.forEach(function (fn) { try { fn(); } catch (e) { /* 忽略 */ } });',
    '  }',
    '  /** 重发 enable：导航后必须再发一次，否则收不到新上下文的 executionContextCreated（t50 的定位结论） */',
    '  async function enableDomains(why, timeoutMs) {',
    "    const to = timeoutMs || CDP_TIMEOUT_MS;",
    "    try { await send('Page.enable', {}, to); } catch (e) { dbg('Page.enable 失败(' + why + ')：' + (e && e.code ? e.code + ' ' : '') + (e && e.message ? e.message : String(e))); }",
    "    try { await send('Runtime.enable', {}, to); } catch (e) { dbg('Runtime.enable 失败(' + why + ')：' + (e && e.code ? e.code + ' ' : '') + (e && e.message ? e.message : String(e))); }",
    "    dbg('已重发 Page.enable + Runtime.enable（' + why + '）');",
    '  }',
    '  /** 等一个「比 seqBefore 更新」的默认上下文：导航后旧 context 已销毁，必须等到新的那个 */',
    '  async function waitNewContext(seqBefore, timeoutMs) {',
    '    const t0 = Date.now();',
    '    while (Date.now() - t0 < timeoutMs) {',
    '      if (ctxSeq > seqBefore && ctxId !== null) return true;',
    '      await new Promise(function (r) { setTimeout(r, 100); });',
    '    }',
    '    return false;',
    '  }',
    '  /**',
    '   * 用 CDP 的 Page.navigate 发起导航（**浏览器级方法，不在页面上下文里执行**）。',
    '   * 旧做法是 evaluate(\"location.href=…\")：等于让旧上下文执行一条「销毁自己」的命令，',
    '   * 回包与后续事件都可能丢（qa 的 t49 定位）。这里改成：Page.navigate → 等 loadEventFired',
    '   * → 重发 enable → 等新 executionContextId。',
    '   */',
    '  async function navigate(url) {',
    '    const seqBefore = ctxSeq;',
    "    const loaded = waitEvent('Page.loadEventFired', NAV_TIMEOUT_MS);",
    '    let res = null;',
    '    try {',
    "      res = await send('Page.navigate', { url: String(url) }, CDP_TIMEOUT_MS);",
    '    } catch (e) {',
    "      dbg('Page.navigate 调用失败：' + (e && e.code ? 'code=' + e.code + ' ' : '') + (e && e.message ? e.message : String(e)));",
    '    }',
    "    dbg('Page.navigate 返回 frameId=' + String(res && res.frameId) + ' loaderId=' + String(res && res.loaderId) + ' errorText=' + String((res && res.errorText) || ''));",
    '    const gotLoad = await loaded;',
    "    dbg(gotLoad ? '收到 Page.loadEventFired' : ('Page.loadEventFired 未在 ' + NAV_TIMEOUT_MS + 'ms 内到达'));",
    "    await enableDomains('导航后');",
    '    const gotCtx = await waitNewContext(seqBefore, READY_TIMEOUT_MS);',
    "    dbg('导航后新 executionContextId=' + String(ctxId) + '（' + (gotCtx ? '已取到' : '未取到') + '，ctxSeq=' + String(ctxSeq) + '）');",
    '    return { loaded: gotLoad, context: gotCtx };',
    '  }',
    '  /** 重新取上下文：Runtime.enable 会让浏览器把 executionContextCreated 全量推一遍 */',
    '  async function reacquireContext() {',
    '    try { await send(\'Runtime.enable\', {}, CDP_TIMEOUT_MS); } catch (e) { dbg(\'Runtime.enable 失败：\' + (e && e.message ? e.message : String(e))); }',
    "    if (ctxId === null) dbg('executionContextId 重取后仍为空：下一次 evaluate 会按默认上下文执行');",
    '  }',
    '  async function evaluateOnce(expression) {',
    '    const params = { expression: expression, awaitPromise: true, returnByValue: true };',
    '    if (ctxId !== null) params.contextId = ctxId;',
    "    dbg('evaluate ctx=' + String(ctxId) + ' 表达式=' + String(expression).slice(0, 60).replace(/\\\\s+/g, ' '));",
    '    const r = await send(\'Runtime.evaluate\', params, CDP_TIMEOUT_MS);',
    "    if (r && r.exceptionDetails) throw new Error('页内脚本报错：' + String(r.exceptionDetails.text || ''));",
    '    return r && r.result ? r.result.value : undefined;',
    '  }',
    '  /** 上下文失效（导航把旧上下文销毁了）→ 重取上下文再试，最多 2 次 */',
    '  async function evaluate(expression) {',
    '    const out = await evaluateWithContext(function () { return evaluateOnce(expression); }, { attempts: 2, onReacquire: reacquireContext });',
    "    if (out.reacquired > 0) dbg('evaluate 上下文重取 ' + out.reacquired + ' 次后成功');",
    '    return out.value;',
    '  }',
    '  /** 失败提示要带「当时 URL」：取不到也不能让错误路径再挂一次 */',
    '  async function currentUrl() {',
    "    try { const u = await evaluateOnce('String(location.href)'); if (u) LAST_URL = String(u); return LAST_URL; }",
    '    catch (e) { return LAST_URL; }',
    '  }',
    '  /**',
    '   * 等就绪用的短探测：单次只给它 READY_PROBE_MS。',
    '   * 用 CDP_TIMEOUT_MS 当探测超时会让「10s 等就绪」实际跑到 16s（每次探测耗满 4s），',
    '   * 那和报告出来的 10000ms 对不上 —— 提示里的数字必须与真实时限一致。',
    '   */',
    '  async function evaluateProbe(expression) {',
    "    const r = await send('Runtime.evaluate', { expression: expression, returnByValue: true }, READY_PROBE_MS);",
    '    return r && r.result ? r.result.value : undefined;',
    '  }',
    '  return {',
    '    close: function () { try { ws.close(); } catch (e) { /* 已关 */ } },',
    '    evaluate: evaluate,',
    '    currentUrl: currentUrl,',
    '    ready: function (timeoutMs) { return waitReady(evaluateProbe, timeoutMs || READY_TIMEOUT_MS); },',
    '    /** 导航后：等「URL 真的变成目标页 + complete」，只判 readyState 会被旧的 about:blank 骗过 */',
    '    readyFor: function (expectUrl, timeoutMs) {',
    '      return waitForUrlReady(evaluateProbe, expectUrl, timeoutMs || READY_TIMEOUT_MS, null, async function () {',
    "        dbg('readyFor：上下文不可用 → 主动重发 enable 并重取上下文');",
    "        await enableDomains('readyFor 兜底', REACQUIRE_TIMEOUT_MS);",
    '        await waitNewContext(ctxSeq, REACQUIRE_WAIT_MS);',
    '      });',
    '    },',
    '    navigate: navigate,',
    '  };',
    '}',
    '',
    '/**',
    " * 失败提示用：带上**步骤序号**与**真实 selector**。",
    " * t32 之前这里只有循环下标、页内还拿到 undefined —— 屏幕上只剩「找不到元素：undefined」。",
    ' */',
    'function stepLabel(step) {',
    "  const pos = step.preamble ? '起始导航' : '第 ' + step.no + ' 步';",
    "  return pos + '（' + step.action + '，' + (step.selector || '无定位器') + '）';",
    '}',
    '',
    'async function main() {',
    '  const client = await connect();',
    '  let done = 0;',
    '  for (let i = 0; i < STEPS.length; i += 1) {',
    '    const step = STEPS[i];',
    "    const value = step.env ? String(process.env[step.env] || '') : '';",
    '    const payload = {',
    '      action: step.action,',
    "      selector: step.selector || '',",
    '      index: step.index,',
    "      key: step.key || 'Enter',",
    "      assertKind: step.assertKind || '',",
    "      expected: step.expected || '',",
    '    };',
    '    const label = stepLabel(step);',
    "    if (step.action === 'navigate') LAST_URL = String(step.selector || LAST_URL);",
    "    if (step.action === 'navigate') {",
    '      // t50：导航改用 CDP 的 Page.navigate（浏览器级方法），不再 evaluate(location.href=…) ——',
    '      // 那等于让旧上下文执行一条「销毁自己」的命令，回包与后续事件都会丢。',
    '      // t52：整步（导航 + 等就绪 + 上下文重取）套一个**总预算**，超了就带诊断退出，',
    '      // 不再出现 t51 那种「60s 被外部杀掉、stdout 全空」。',
    '      const navStep = await withTimeout((async function () {',
    '        const nav = await client.navigate(step.selector);',
    '        const ready = await client.readyFor(step.selector, READY_TIMEOUT_MS);',
    '        return { nav: nav, ready: ready };',
    '      })(), NAV_STEP_BUDGET_MS, label);',
    '      if (navStep.timedOut) {',
    '        const where = await client.currentUrl();',
    "        exitWith(label + '超时（' + NAV_STEP_BUDGET_MS + 'ms）：导航与就绪在预算内未完成（站点太慢不响应、或调试端口那个标签页卡住）；当前 URL：' + where);",
    '        return;',
    '      }',
    '      if (navStep.error) {',
    '        const where = await client.currentUrl();',
    "        exitWith(label + '执行失败：' + (navStep.error && navStep.error.message ? navStep.error.message : String(navStep.error)) + '；当前 URL：' + where);",
    '        return;',
    '      }',
    '      const nav = navStep.value.nav;',
    '      const ready = navStep.value.ready;',
    '      if (!ready.ready) {',
    "        exitWith(label + ' 导航后 ' + READY_TIMEOUT_MS + 'ms 页面仍未就绪（当前 URL=' + (ready.url || '?') + '，readyState=' + ready.state + '，loadEvent=' + String(nav.loaded) + '，新context=' + String(nav.context) + '，reason=' + String(ready.reason || '?') + '）：站点太慢或永远加载不完，或那个标签页不是录制时的那一页；当前 URL：' + LAST_URL);",
    '        return;',
    '      }',
    "      if (nav.context) dbg(label + ' 已在新上下文里就绪');",
    '      // 前置（起始导航）不计进「回放了几步」：AC-10a 要的是「打印步骤数 = 录制步骤数」',
    '      if (!step.preamble) done += 1;',
    '      continue;',
    '    }',
    '    // 非导航步：照旧在页内执行（此时上下文已是新文档的那个）',
    '    const outcome = await withTimeout(',
    '      client.evaluate(\'(\' + dshStep.toString() + \')(\' + JSON.stringify(payload) + \', \' + JSON.stringify(value) + \')\'),',
    '      STEP_TIMEOUT_MS,',
    '      label,',
    '    );',
    '    if (outcome.timedOut) {',
    '      const where = await client.currentUrl();',
    "      exitWith(label + '超时（' + STEP_TIMEOUT_MS + 'ms）：没有在时限内完成；当前 URL：' + where);",
    '      return;',
    '    }',
    '    if (outcome.error) {',
    '      const where = await client.currentUrl();',
    "      exitWith(label + '执行失败：' + (outcome.error && outcome.error.message ? outcome.error.message : String(outcome.error)) + '；当前 URL：' + where);",
    '      return;',
    '    }',
    '    const result = outcome.value;',
    "    if (result !== 'ok' && result !== 'navigated') {",
    '      const where = await client.currentUrl();',
    "      exitWith(label + '未通过：' + String(result) + '；当前 URL：' + where);",
    '      return;',
    '    }',
    '    // 后续步骤可能落在新文档上：取一次真实 URL 记下来（失败提示与看门狗都要用）',
    '    const nowUrl = await client.currentUrl();',
    '    if (nowUrl) LAST_URL = nowUrl;',
    '    // 前置（起始导航）不计进「回放了几步」：AC-10a 要的是「打印步骤数 = 录制步骤数」',
    '    if (!step.preamble) done += 1;',
    '  }',
    '  client.close();',
    "  console.log('回放完成：' + done + ' 步（录制 ' + RECORDED_STEPS + ' 步）');",
    '}',
    '',
    'main().catch(function (e) {',
    "  exitWith('回放失败：' + (e && e.message ? e.message : String(e)));",
    '});',
    '',
  ];

  return {
    id: 'mjs',
    ok: true,
    filename,
    code: lines.join('\n'),
    lang: 'js',
    runCommand: `node ${filename}`,
    prereq: ARTIFACT_PREREQ.mjs,
    warnings,
  };
}

/* ================================================================
   4. Playwright *.spec.ts
   ================================================================ */

/** 环境变量取值表达式（缺变量不抛错、传空串——spec 侧的口径就是 `?? ''`） */
function envExpr(name: string): string {
  return `process.env[${sq(name)}] ?? ''`;
}

/** 一条调用的 Playwright 语句（**所有 action 的写法只在这里出现一次**） */
function specLineOf(c: ScriptCall): string {
  const sel = js(c.locatorValue);
  switch (c.action) {
    case 'navigate':
      return `  await page.goto(${sel});`;
    case 'click':
      return `  await page.locator(${sel}).click();`;
    case 'fill':
      return `  await page.locator(${sel}).fill(${envExpr(c.valueRef || '')});`;
    case 'select':
      return `  await page.locator(${sel}).selectOption({ index: ${c.selectedIndex ?? 0} });`;
    case 'press':
      return `  await page.locator(${sel}).press('Enter');`;
    case 'assert': {
      const kind = c.assert ? c.assert.kind : 'text';
      const re = js(reEscape(c.assert ? c.assert.contains : c.locatorValue));
      if (kind === 'url') return `  await expect(page).toHaveURL(new RegExp(${re}));`;
      if (kind === 'title') return `  await expect(page).toHaveTitle(new RegExp(${re}));`;
      return `  await expect(page.getByText(${js(c.assert ? c.assert.contains : c.locatorValue)})).toBeVisible();`;
    }
    default:
      return '';
  }
}

/**
 * Playwright `*.spec.ts`。
 *
 * `test.use({ baseURL })` 是硬要求：录制的 baseUrl 是脱敏后的 `origin + path`，
 * 用例内部用相对路径或 `page.goto(baseUrl)` 都成立，换环境只改这一行。
 */
export function buildSpecTs(rec: UiRecording): ScriptArtifact {
  const calls = stepsToCalls(rec);
  const warnings = collectWarnings(calls);
  const filename = `${fileBaseOf(rec)}.spec.ts`;
  const name = oneLine(rec.name || '未命名录制', 60);
  const body = calls
    .filter((c) => c.locatorValue || c.action === 'assert' || c.action === 'navigate')
    .map(specLineOf)
    .filter(Boolean);

  const lines: string[] = [
    '/**',
    ` * ${name} —— Playwright 用例（由「测试中台 · UI 录制器」从一份录制生成）。`,
    ` * 录制步骤：${rec.steps.length} 步（另含起始导航 ${calls.length - rec.steps.length} 条前置）；baseUrl：${oneLine(rec.baseUrl || '', 200)}`,
    ' *',
    ' * 前置：@playwright/test 与已下载的浏览器（本机缺失时记「未验证」，不得算通过）。',
    ` * 运行：npx playwright test ${filename}`,
    ' *',
    ' * 口径：口令只从环境变量读（process.env[...]），产物里没有明文；',
    ' * 应用内只校验元素级命中数，它「通过」不等于 CI「通过」。',
    ' */',
    "import { test, expect } from '@playwright/test';",
    '',
    `test.use({ baseURL: ${js(String(rec.baseUrl || ''))} });`,
    '',
    `test(${js(`回放录制：${name}（${rec.steps.length} 步）`)}, async ({ page }) => {`,
    ...(body.length ? body : ['  // 这份录制没有可回放的步骤：先在录制页录几步再导出']),
    '});',
    '',
  ];

  return {
    id: 'spec',
    ok: true,
    filename,
    code: lines.join('\n'),
    lang: 'ts',
    runCommand: `npx playwright test ${filename}`,
    prereq: ARTIFACT_PREREQ.spec,
    warnings,
  };
}

/* ================================================================
   5. Java POM 适配（只调用 pageobject.ts，不改它）
   ================================================================ */

/**
 * 元素名：`动作 + 元素标识`（≤ 60 字符，与元素库的名称上限一致）。
 *
 * 刻意**不带步骤号**：步骤号进了名字就会被 `camelCase` 拼成 `clickLogin2` 这种像是
 * 「重名兜底」的方法名；步骤号放在 `note` 里（`录制第 N 步`），既不影响 Java 方法名，
 * 也不丢溯源信息。
 */
function elementNameOf(c: ScriptCall): string {
  const tag = c.pomKind === 'text' ? c.pomLocator : c.pomLocator;
  return `${c.action} ${tag}`.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * 录制 → 元素库行（**POM 的输入**）。
 *
 * - 只有「元素动作」进 POM（`navigate` / `assert` 不是元素——POM 结构里没有步骤，J-15）；
 * - 每行从 `blankElement()` 起步：`[C-110]` 要求 id 在「新建那一刻」就定下来，
 *   再顺手把 `step.elementId` 覆盖上去——这样生成的 POM 元素与录制步骤**按 id 一一对应**；
 * - 行本身是 `PomElementRow`（元素库的形状），不是 `pageobject.ts` 的 `PomElement`：
 *   两者形状不同，转换在 `toPomElement()` 一处完成。
 */
export function pomRowsFromRecording(rec: UiRecording): PomElementRow[] {
  const rows: PomElementRow[] = [];
  for (const call of stepsToCalls(rec)) {
    if (!call.elementLike || !call.locatorValue) continue;
    const base = blankElement();
    const row: PomElementRow = {
      ...base,
      id: String(base.id || ''),
      name: elementNameOf(call),
      locator: call.pomLocator,
      kind: call.pomKind,
    };
    if (call.roleName) row.role = call.roleName;
    row.note = `录制第 ${call.index + 1} 步`;
    rows.push(row);
  }
  // elementId 覆盖必须在 blankElement 之后：先有 id 才有「稳定」可言
  const steps = rec && Array.isArray(rec.steps) ? rec.steps : [];
  const elementSteps = steps.filter((s) => s.locator && s.locator.value && s.action !== 'navigate' && s.action !== 'assert');
  rows.forEach((row, i) => {
    const step = elementSteps[i];
    if (step && step.elementId) row.id = String(step.elementId);
  });
  return rows;
}

/** `PomElementRow` → `pageobject.ts` 的 `PomElement`（两处形状不同的唯一转换点） */
function toPomElement(row: PomElementRow): PomElement {
  const el: PomElement = {
    name: row.name,
    locator: row.locator,
    // role 行在录制侧已归一成 css；这里保持 kind 原样，让生成器自己决定 API
    kind: row.kind as PomLocatorKind,
  };
  if (row.kind === 'role' && row.role) el.roleName = row.role;
  return el;
}

/**
 * Java POM 产物。
 *
 * `[C-118]` 的三条边界都在这里：**只调用** `generatePageObject()`，不传 `lang`
 * （录制产物不是 POM 的语言选项），POM 不含步骤所以**不写 `System.getenv`**
 * （`[C-119]` 第 4 款：口令占位只属于自带步骤的 Java 测试类）。
 */
export function buildPomArtifact(
  rec: UiRecording,
  opts: { className?: string; packageName?: string; pageName?: string } = {},
): ScriptArtifact {
  const rows = pomRowsFromRecording(rec);
  const className = String(opts.className || '').trim() || classNameOf(rec);
  const calls = stepsToCalls(rec);
  const warnings = collectWarnings(calls);

  const res = generatePageObject({
    className,
    packageName: String(opts.packageName || 'pages'),
    baseUrl: String(rec.baseUrl || ''),
    pageName: String(opts.pageName || rec.name || className),
    elements: rows.map(toPomElement),
  });

  if (!res.ok) {
    return {
      id: 'pom',
      ok: false,
      filename: `${className}.java`,
      code: '',
      lang: 'java',
      runCommand: '',
      prereq: ARTIFACT_PREREQ.pom,
      warnings,
      error: res.error,
    };
  }

  const file = res.files[0];
  const filename = file ? file.path.split('/').pop() || `${className}.java` : `${className}.java`;
  return {
    id: 'pom',
    ok: true,
    filename,
    code: file ? file.content : '',
    lang: 'java',
    // POM 是被测试类 import 的骨架，不是可执行命令；给一条「编译得过」的最低验证命令
    runCommand: `javac -encoding UTF-8 ${filename}`,
    prereq: ARTIFACT_PREREQ.pom,
    warnings: warnings.concat(res.warnings),
  };
}

/* ================================================================
   6. 批量 + AC-20 的抽取器（给单测与 S7 的验收脚本共用）
   ================================================================ */

/** 一次生成多份产物（顺序固定，界面按它渲染） */
/**
 * 产物生成入口。**本期只交付两份**：① Java POM、③ Playwright .spec.ts。
 *
 * ⚠️ .mjs（②）已按用户裁定从交付中拿掉（AC-10a 六轮未通过 → 进 P3）：
 * - **UI 断**：ArtifactPicker 不再提供该选项；
 * - **导出断**：本函数即便被调用方要求 'mjs' 也**不会产出**（不能只隐藏 UI 留个没有入口的坏功能）；
 * - 生成逻辑（uildMjsScript）保留在文件里，供 P3 重做；重新接回界面/导出前必须先通过 AC-10a。
 */
export function buildArtifacts(rec: UiRecording, ids: ArtifactId[]): ScriptArtifact[] {
  // mjs 不进 order：调用方传了也会被过滤掉（导出路径同步断）
  const order: ArtifactId[] = ['pom', 'spec'];
  const want = (Array.isArray(ids) && ids.length ? ids : order).filter((id) => order.indexOf(id) >= 0);
  return order
    .filter((id) => want.indexOf(id) >= 0)
    .map((id) => (id === 'pom' ? buildPomArtifact(rec) : buildSpecTs(rec)));
}

/**
 * `.spec.ts` 里的「步骤操作数」序列（按源码出现顺序）。
 *
 * 覆盖 ② 里全部五种写法（`goto` / `locator(...).X` / `toHaveURL` / `toHaveTitle` /
 * `getByText(...)`）——**这是 AC-20 第 3 条能对 ② 成立的关键**：只抽 `page.locator(...)`
 * 会把 `navigate` 与 `assert` 两步漏掉，于是数组长度永远比步骤数短，看起来像「模板少了一步」。
 */
export function extractSpecLocators(code: string): string[] {
  const out: string[] = [];
  const lines = String(code || '').split('\n');
  const patterns = [
    /^\s*await page\.goto\(("(?:[^"\\]|\\.)*")\);/,                                  // navigate
    /^\s*await page\.locator\(("(?:[^"\\]|\\.)*")\)\./,                              // click / fill / select / press
    /^\s*await expect\(page\)\.toHave(?:URL|Title)\(new RegExp\(("(?:[^"\\]|\\.)*")\)\);/, // assert(url|title)
    /^\s*await expect\(page\.getByText\(("(?:[^"\\]|\\.)*")\)\)\.toBeVisible\(\);/,  // assert(text)
  ];
  for (const line of lines) {
    for (const re of patterns) {
      const m = re.exec(line);
      if (!m) continue;
      const raw = String(JSON.parse(m[1]) as string);
      // toHaveURL / toHaveTitle 里放的是 RegExp 源串（已转义），还原成断言原文
      out.push(re.test(line) && /toHave(?:URL|Title)/.test(line) ? unescapeRegex(raw) : raw);
      break;
    }
  }
  return out;
}

/** `reEscape` 的逆运算：把 `\.` `\[` 这类还原成原字符 */
function unescapeRegex(source: string): string {
  return String(source || '').replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}

/**
 * `.mjs` 步骤表里的定位器序列：逐行解析 `STEPS` 数组里的 `selector:` / `contains:`。
 *
 * ⚠️ 这不是「再实现一遍模板」：它读的是**产物文本**，所以能证伪「模板自己写了一版 locator」。
 */
export function extractMjsSelectors(code: string): string[] {
  const out: string[] = [];
  const lines = String(code || '').split('\n');
  // 行首是 `{ no: <n>, action: '<action>'`（t32 起每行带步骤号，`no` 可缺省以兼容旧产物）
  const rowRe = /^\s*\{ (?:no: -?\d+, )?action: '(?:navigate|click|fill|select|press|assert)'/;
  const selRe = /selector:\s*("(?:[^"\\]|\\.)*")/;
  const expRe = /expected:\s*("(?:[^"\\]|\\.)*")/;
  for (const line of lines) {
    if (!rowRe.test(line)) continue;
    const sel = selRe.exec(line);
    const exp = expRe.exec(line);
    const hit = exp || sel;
    if (!hit) continue;
    const value = JSON.parse(hit[1]) as string;
    // navigate/assert 行可能同时有 selector:""（空串），空串不算定位器
    if (value === '') continue;
    out.push(value);
  }
  return out;
}
