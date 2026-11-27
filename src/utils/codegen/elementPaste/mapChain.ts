/**
 * 三语法共用的**唯一判定器**（契约 [A1-8] (2)(3)）。
 *
 * 分工（契约 §6 落点总表的原话）：
 * - `parsePython.ts` / `parseJava.ts` / `parsePlaywright.ts` 只负责「把本语法的行切成
 *   `{ method, locatorArg, roleName }`」；
 * - **kind 判定 / 元素名建议 / 置信度 / `reason` 文案，只有这一份**（本文件）。
 *
 * 三种写法落到同一个候选的证据：`getByRole('button',{name:'登录'})` /
 * `get_by_role("button", name="登录")` / `getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"))`
 * 都产出 `role` / `button` / `登录`（各语言一条单测逐字断言）。
 *
 * 纯函数：零 IPC、零 window、零 React。
 */

import type { PomLocatorKind } from '../pageobject';
import type { ElementPasteCandidate, PasteConfidence, PasteSource, PasteTarget } from './types';
import { PASTE_TARGET_LABEL, nameHint } from './types';

/* ================================================================
   方法清单（三语法归一后）
   ================================================================ */

/**
 * 定位方法 → 元素库 kind（`[A1-8]` (3) 表的唯一实现）。
 *
 * `locator` 单列成 `'locator'` 占位：它到底落 `css` 还是 `xpath` 要看实参（见 `cssOrXpath`）。
 * **A₀ 之后这 7 个 `getBy*` 都落各自的 kind，不再一律降成 `pw`** —— 不改就等于「库里扩了
 * 5 种定位方式，输入侧永远产不出它们」。
 */
const KIND_OF_METHOD: Record<string, PomLocatorKind | 'locator'> = {
  getByRole: 'role',
  getByText: 'text',
  getByLabel: 'label',
  getByPlaceholder: 'placeholder',
  getByAltText: 'alttext',
  getByTitle: 'title',
  getByTestId: 'testid',
  locator: 'locator',
};

/** 8 个定位方法（归一后驼峰），顺序与契约表一致 */
export const LOCATOR_METHODS: readonly string[] = Object.keys(KIND_OF_METHOD);

/**
 * 链上的「过滤 / 索引」段：出现任意一个 → 整链落 `pw`（`[A1-8]` (3) 最后一行）。
 * 这是**唯一**允许落 `pw` 的情形。
 */
export const INDEX_METHODS: readonly string[] = ['filter', 'nth', 'or', 'and', 'first', 'last'];

/**
 * 动作方法（归一后驼峰）：定位行里**从第一个动作起**全部丢掉，动作行本身导入 0 条。
 *
 * ⚠️ `first` / `last` / `nth` / `filter` **不在这里**：它们是定位链的一部分，
 * 当成动作会把 `getByRole(...).first()` 切成一条错候选。
 */
export const ACTION_METHODS: readonly string[] = [
  'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially', 'hover',
  'check', 'uncheck', 'setChecked', 'selectOption', 'selectText', 'setInputFiles',
  'tap', 'focus', 'blur', 'clear', 'dragTo',
  'scrollIntoViewIfNeeded', 'waitFor', 'waitForSelector', 'waitForLoadState',
  'screenshot', 'evaluate', 'count', 'innerText', 'textContent', 'getAttribute',
  'dispatchEvent', 'isVisible', 'isEnabled', 'isChecked', 'isEditable', 'isHidden',
  'inputValue',
];

const ACTION_SET = new Set(ACTION_METHODS);
const INDEX_SET = new Set(INDEX_METHODS);

/** 是不是动作（三语法在 `scan.ts` 里已归一成驼峰） */
export function isAction(method: string): boolean {
  return ACTION_SET.has(String(method ?? ''));
}

/** 是不是定位方法 */
export function isLocatorMethod(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(KIND_OF_METHOD, String(method ?? ''));
}

/**
 * 这一行到底有没有「定位」内容（用于区分「认不出」与「本来就该忽略」）。
 *
 * - 纯动作行（`page.click('#a')`）→ `false` → 忽略，**不**计入 `skippedLines`；
 * - 含定位方法但转不成候选（f-string / iframe 链 / 未知方法）→ `true` → 计入 `skippedLines`。
 */
export function hasLocatorSegment(segments: ParsedSegment[]): boolean {
  return (Array.isArray(segments) ? segments : []).some((s) => isLocatorMethod(s.method));
}

/** 链上「本该是定位器」却表达不了的段落（与 `renderPlaywrightJs` / 契约 [A1-8] (3) 同一份清单） */
const NOT_EXPRESSIBLE = new Set(['frameLocator', 'contentFrame', 'or', 'and', 'has', 'hasNot', 'describe']);

/**
 * 认不出的**原因文案**（review-code：不许静默消失，每一条 skipped 行都要能对用户说清楚）。
 *
 * 与 `mapCall`/`mapChain` 的判空条件一一对应；新增判空分支时必须同步这里，否则用户会看到
 * 「1 行未识别」却不知道为什么。
 */
export function skipReasonOf(segments: ParsedSegment[]): string {
  const raw = Array.isArray(segments) ? segments : [];
  // 与 `mapChain` 同一口径：动作段之后的部分本来就会被丢掉，判原因时也必须先切掉，
  // 否则 `getByLabel(f"x{idx}").click()` 会被报成「表达不了 click」而不是「实参不是字面量」
  const cutAt = raw.findIndex((s) => isAction(s.method));
  const list = cutAt >= 0 ? raw.slice(0, cutAt) : raw;
  if (!list.length) return '这行没有可用的定位段';
  const head = list[0];
  if (!isLocatorMethod(head.method)) return `首段不是 page 上的定位方法（${head.method}）`;
  const notExpressible = list.find((s) => NOT_EXPRESSIBLE.has(s.method));
  if (notExpressible) return `链里有元素库表达不了的段落（${notExpressible.method}：iframe / 多候选组合）`;
  const unknownMethod = list.slice(1).find((s) => !INDEX_SET.has(s.method));
  if (unknownMethod) return `链里有元素库表达不了的段落（${unknownMethod.method}）`;
  const missingArg = list.slice(1).find(
    (s) => s.method !== 'first' && s.method !== 'last' && !String(s.locatorArg ?? '').trim(),
  );
  if (!String(head.locatorArg ?? '').trim()) return '定位实参不是字符串字面量（f-string / 变量插值）';
  if (missingArg) return `链上 .${missingArg.method}() 的参数不是字面量`;
  return '定位器参数缺失或无法识别';
}

/* ================================================================
   段落 / 输入
   ================================================================ */

/**
 * 链上的一段（三语法的解析器各产出这一种结构，判定只看它）。
 * 单方法时它就是契约里写的 `{ method, locatorArg, roleName }`。
 */
export interface ParsedSegment {
  /** 归一后的方法名（`getByRole` / `locator` / `filter` / `nth` / `first` …） */
  method: string;
  /** 已解引号的定位实参（`role`→角色名；`filter`→hasText 文本；`nth`→序号原文） */
  locatorArg?: string;
  /** `getByRole` 的可访问名 */
  roleName?: string;
  /** 原写法带 `exact` 选项（JS `{ exact: true }` / PY `exact=True` / Java `setExact(true)`） */
  exact?: boolean;
  /** 原写法带**其它**选项（`level` / `description` / `includeHidden` …）——元素库存不下 */
  extraOptions?: boolean;
}

export interface ParsedLine {
  target: PasteTarget;
  segments: ParsedSegment[];
}

export interface MapContext {
  source: PasteSource;
}

/* ================================================================
   角色写法（两种都要能拆）
   ================================================================ */

/**
 * 角色原文 → `{ role, name? }`。支持四种写法（任务书 §A₁-5）：
 * 1. `button`                          → `{ role: 'button' }`
 * 2. `button:登录`                      → `{ role: 'button', name: '登录' }`
 * 3. `role=button`                      → `{ role: 'button' }`
 * 4. `role=button[name="登录"]`         → `{ role: 'button', name: '登录' }`
 *
 * 为什么单独拆这一步：`role=` 是 Playwright 的**字符串角色引擎**写法，元素库的 `role` kind
 * 存的是**纯角色名**（[A0-2] 第 4 行）。直接把这串存进去，生成物会变成
 * `getByRole(AriaRole.ROLE=BUTTON…)` 这种废代码。
 */
export function parseRoleSpec(raw: string, fallbackName?: string): { role: string; name?: string } {
  const s = String(raw ?? '').trim();
  const withName = /^role=([^[\]]+)\[name\s*=\s*["']([\s\S]*)["']\]$/.exec(s);
  if (withName) return { role: withName[1].trim().toLowerCase(), name: withName[2] };
  const roleEq = /^role=([\s\S]+)$/.exec(s);
  if (roleEq) return { role: roleEq[1].trim().toLowerCase(), ...(fallbackName ? { name: fallbackName } : {}) };
  const colon = /^([A-Za-z][\w-]*)\s*:\s*([\s\S]+)$/.exec(s);
  if (colon) return { role: colon[1].trim().toLowerCase(), name: colon[2].trim() };
  return { role: s.toLowerCase(), ...(fallbackName ? { name: fallbackName } : {}) };
}

/* ================================================================
   置信度（三语法同一口径；`exact` 的唯一判据见下）
   ================================================================ */

/**
 * `exact` 的判据只有一条：**元素库存的 `(kind, locator, roleName)` 生成/试跑出来，
 * 与 codegen 那一行语义逐字等价**。凡是元素库模型存不下的信息，一律 `guess` + 一句人话。
 */
function cssConfidence(css: string): { confidence: PasteConfidence; reason: string } {
  const s = String(css ?? '').trim();
  if (!s) return { confidence: 'unknown', reason: '空选择器' };
  if (/:[a-z-]+\(|:(nth|first|last)/i.test(s)) {
    return { confidence: 'guess', reason: 'css 带结构性伪类，列表顺序一变就指错行' };
  }
  if (/^#[\w-]+$/.test(s)) return { confidence: 'exact', reason: '按 id 定位' };
  if (/^\[[^\]]+="[^"]*"\]$/.test(s)) return { confidence: 'exact', reason: '按属性精确定位' };
  if (/^\.[\w-]+$/.test(s) || /^[a-z][\w-]*\.[\w-]+/i.test(s)) {
    return { confidence: 'guess', reason: '按 class 定位，样式改名或同类多行时会失配' };
  }
  if (/^[a-z][\w-]*$/i.test(s)) return { confidence: 'guess', reason: '只有标签名，页面上通常不止一个' };
  return { confidence: 'exact', reason: 'codegen 记录的 css 选择器（含 id/属性组合，通常唯一）' };
}

/** xpath：带 id / data-* / aria-* / name / title / href 之类稳定属性 → exact；纯结构路径 → guess */
function xpathConfidence(xp: string): { confidence: PasteConfidence; reason: string } {
  if (/\[@(id|data-|aria-|name|title|href)\s*=/.test(xp)) {
    return { confidence: 'exact', reason: 'xpath 里带 id/属性约束，结构变动通常不影响' };
  }
  return { confidence: 'guess', reason: 'xpath 是纯结构路径，页面改版易失配' };
}

/** 文本类（text/label/placeholder/alttext/title/testid）的把握度 */
function textKeyConfidence(
  method: string,
  exact: boolean | undefined,
  extraOptions: boolean | undefined,
): { confidence: PasteConfidence; reason: string } {
  if (exact) {
    return method === 'getByTestId'
      ? { confidence: 'guess', reason: '原写法带 exact 选项，元素库不存该选项' }
      : { confidence: 'guess', reason: '原写法是 exact 匹配，元素库按默认（子串、忽略大小写）生成，可能多命中' };
  }
  if (extraOptions) return { confidence: 'guess', reason: '原写法带附加选项，元素库不存，可能多命中' };
  return { confidence: 'exact', reason: '就是这一种语义，元素库逐字等价生成' };
}

/* ================================================================
   元素名建议（三语法同一优先级）
   ================================================================ */

/**
 * 名字建议的优先级：`hasText` → `placeholder` → 可见文本 → 角色可访问名 → 定位器实参 → 未命名元素。
 *
 * 三语法必须**同一顺序**，否则同一行 JS/Python 会得到不同名字（去重与命名都不可复现）。
 * 截断统一走 `nameHint`（`NAME_HINT_MAX = 30`）。
 */
function suggestName(segments: ParsedSegment[], roleName?: string, locator?: string): string {
  for (const seg of segments) {
    if (seg.method === 'filter' && seg.locatorArg) return nameHint(seg.locatorArg);
  }
  const byMethod = (m: string) => segments.find((s) => s.method === m && s.locatorArg)?.locatorArg;
  const ph = byMethod('getByPlaceholder');
  if (ph) return nameHint(ph);
  const text = byMethod('getByText');
  if (text) return nameHint(text);
  if (roleName) return nameHint(roleName);
  if (locator) return nameHint(locator);
  return '未命名元素';
}

/* ================================================================
   `locator()` 的实参 → kind（顺序固定，先命中先赢）
   ================================================================ */

/**
 * `locator(...)` 的 body 分流。顺序**不许换**：
 * `xpath=` / `css=` 是引擎前缀；以 `/` 或 `(` 开头只能是 xpath（CSS 选择器不可能这样开头）；
 * `role=` 走角色（`role=button` 写法）；`text=` / `aria-ref=` / `internal:` 是**别的东西**，不认。
 */
type LocatorBody =
  | { kind: 'css' | 'xpath'; body: string }
  | { kind: 'role'; role: string; name?: string }
  | null;

export function cssOrXpath(raw: string, fallbackName?: string): LocatorBody {
  const body = String(raw ?? '').trim();
  if (!body) return null;
  const xp = /^xpath=([\s\S]*)$/.exec(body);
  if (xp) return { kind: 'xpath', body: xp[1] };
  const cssEngine = /^css=([\s\S]*)$/.exec(body);
  if (cssEngine) return { kind: 'css', body: cssEngine[1] };
  if (/^[(/]/.test(body)) return { kind: 'xpath', body };
  const roleEngine = /^role=([\s\S]+)$/.exec(body);
  if (roleEngine) {
    const spec = parseRoleSpec(body, fallbackName);
    return { kind: 'role', role: spec.role, ...(spec.name ? { name: spec.name } : {}) };
  }
  if (/^(text=|aria-ref=|internal:)/.test(body)) return null;
  return { kind: 'css', body };
}

/* ================================================================
   入口：一段 → 候选
   ================================================================ */

/**
 * 单个定位方法 → 候选（契约 [A1-8] 里写的入参形态 `{ method, locatorArg, roleName }`）。
 *
 * 返回 `null` = 这一行**认不出**（调用方跳过并计数，不许硬塞成「未命名元素」）。
 */
export function mapCall(
  seg: ParsedSegment,
  ctx: MapContext,
  opts: { target?: PasteTarget; segments?: ParsedSegment[] } = {},
): ElementPasteCandidate | null {
  const target = opts.target;
  const prefix = target ? `Playwright codegen（${PASTE_TARGET_LABEL[target]}）：` : 'Playwright codegen：';
  const mapped = KIND_OF_METHOD[seg.method];
  if (!mapped) return null;

  const arg = String(seg.locatorArg ?? '');
  if (!arg.trim()) return null;

  if (mapped === 'role') {
    const spec = parseRoleSpec(arg, seg.roleName);
    const extraOptions = Boolean(seg.extraOptions);
    const exactOption = Boolean(seg.exact);
    // C-01（review-code）：`exact` 也要参与判定 —— 元素库的 `role` 只存 `(locator, roleName)`，
    // 生成出来是**默认**匹配（子串 + 忽略大小写）；原写法带 `exact: true` 时语义更严，两者不等价。
    // 把不确定性报成 `exact` 比不认识更坏：用户会以为这条能直接用。
    const confidence: PasteConfidence = spec.name && !extraOptions && !exactOption ? 'exact' : 'guess';
    const why = !spec.name
      ? (extraOptions
        ? '只有角色名 + 附加选项，元素库只存 name（保存前必须补 role 名称）'
        : '只有角色名，没有可访问名（保存前必须补 role 名称）')
      : exactOption
        ? '原写法带 exact 选项（精确 + 大小写敏感），元素库按默认（子串、忽略大小写）生成，可能多命中'
        : (extraOptions
          ? '角色带附加选项（level/description 等），元素库只存 name，可能多命中'
          : '角色 + 可访问名，语义稳定');
    return {
      name: suggestName(opts.segments ?? [seg], spec.name, spec.role),
      locator: spec.role,
      kind: 'role',
      ...(spec.name ? { role: spec.name } : {}),
      confidence,
      reason: `${prefix}${why}`,
      source: ctx.source,
      ...(target ? { target } : {}),
    };
  }

  if (mapped === 'locator') {
    const parsed = cssOrXpath(arg, seg.roleName);
    if (!parsed) return null;
    if (parsed.kind === 'role') {
      const confidence: PasteConfidence = parsed.name ? 'exact' : 'guess';
      return {
        name: suggestName(opts.segments ?? [seg], parsed.name, parsed.role),
        locator: parsed.role,
        kind: 'role',
        ...(parsed.name ? { role: parsed.name } : {}),
        confidence,
        reason: `${prefix}${parsed.name ? 'role= 写法已拆成角色名 + 可访问名' : 'role= 写法只有角色名，没有可访问名'}`,
        source: ctx.source,
        ...(target ? { target } : {}),
      };
    }
    const c = parsed.kind === 'xpath' ? xpathConfidence(parsed.body) : cssConfidence(parsed.body);
    return {
      name: suggestName(opts.segments ?? [seg], seg.roleName, parsed.body),
      locator: parsed.body,
      kind: parsed.kind,
      confidence: c.confidence,
      reason: `${prefix}${c.reason}`,
      source: ctx.source,
      ...(target ? { target } : {}),
    };
  }

  const c = textKeyConfidence(seg.method, seg.exact, seg.extraOptions);
  return {
    name: suggestName(opts.segments ?? [seg], seg.roleName, arg),
    locator: arg,
    kind: mapped,
    confidence: c.confidence,
    reason: `${prefix}${c.reason}`,
    source: ctx.source,
    ...(target ? { target } : {}),
  };
}

/* ================================================================
   `pw`：链 → 一行 Playwright **JS** 链（三语法统一渲染）
   ================================================================ */

function jsString(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * 把归一后的段落渲染成一**行 Playwright JS 链**（元素库 `pw` 的 locator 语义，[A0-2] 第 5 行）。
 *
 * 为什么必须渲染成 JS：`pwChainToJava`（生成侧）与 `pwChainPlan`（试跑侧）都只吃 JS 写法。
 * 把 Python/Java 链原样存进 `pw` = 生成不出 Java、点验也标 `skip`，等于「导入成功但永远不能验」。
 *
 * 渲染不出来（未知段 / 缺参数）→ `null`，调用方按「认不出」跳过并计数。
 */
export function renderPlaywrightJs(segments: ParsedSegment[]): string | null {
  const parts: string[] = [];
  for (const seg of segments) {
    const arg = String(seg.locatorArg ?? '');
    switch (seg.method) {
      case 'locator':
        if (!arg) return null;
        parts.push(`locator(${jsString(arg)})`);
        break;
      case 'getByRole': {
        const spec = parseRoleSpec(arg, seg.roleName);
        if (!spec.role) return null;
        parts.push(`getByRole(${jsString(spec.role)}${spec.name ? `, { name: ${jsString(spec.name)} }` : ''})`);
        break;
      }
      case 'getByText':
      case 'getByLabel':
      case 'getByPlaceholder':
      case 'getByTestId':
      case 'getByAltText':
      case 'getByTitle':
        if (!arg) return null;
        parts.push(`${seg.method}(${jsString(arg)}${seg.exact ? ', { exact: true }' : ''})`);
        break;
      case 'filter':
        if (!arg) return null;
        parts.push(`filter({ hasText: ${jsString(arg)} })`);
        break;
      case 'nth':
        if (!/^-?\d+$/.test(arg.trim())) return null;
        parts.push(`nth(${arg.trim()})`);
        break;
      case 'first':
        parts.push('first()');
        break;
      case 'last':
        parts.push('last()');
        break;
      default:
        return null;
    }
  }
  return parts.length ? `page.${parts.join('.')}` : null;
}

/* ================================================================
   去重（D-2 修复：键里必须有 roleName）
   ================================================================ */

/** 文本类 kind 的归一：折叠空白（getByText 系列本就"规范化空白"，折叠不改变语义） */
function normText(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 去重键（D-2）：`kind | 归一化 locator | (role 时) 归一化 roleName`。
 *
 * 为什么必须带 `roleName`：老键是 `kind|locator`，于是
 * `getByRole('button', { name: '登录' })` 与 `{ name: '取消' }` 会被并成一条 —— 那不是"重复"，
 * 是两个不同元素。这条已经写成单测钉住。
 *
 * 为什么 css/xpath/pw 只 trim：空白在 css 里可能是后代选择器的分隔符，折叠会改语义；
 * 而 pw 链是我们**自己**渲染出来的（三语法同一渲染器），格式确定，跨语言才能逐字相等。
 */
export function dedupeKey(candidate: ElementPasteCandidate): string {
  const kind = String(candidate.kind);
  const textish = kind === 'text' || kind === 'label' || kind === 'placeholder'
    || kind === 'alttext' || kind === 'title' || kind === 'testid';
  const locator = textish || kind === 'role' ? normText(candidate.locator) : String(candidate.locator ?? '').trim();
  const role = kind === 'role' ? normText(candidate.role) : '';
  return `${kind}|${locator}|${role}`;
}

/**
 * 同一元素重复粘贴只留一条（顺序 = 首次出现顺序）。
 *
 * 冲突时**保留 confidence 高者**（`guess` 被 `exact` 顶掉）；同档保留先出现的。
 * 被顶掉的行不新增、也不额外产行 —— 所以"重复粘贴条数不变"是可断言的。
 * `unknown` 行（HTML 解析器产的）不参与去重：它们的 `locator` 是空串，合并会把两个不同元素并成一条。
 */
export function dedupeCandidates(list: ElementPasteCandidate[]): ElementPasteCandidate[] {
  const out: ElementPasteCandidate[] = [];
  const index = new Map<string, number>();
  for (const candidate of Array.isArray(list) ? list : []) {
    if (candidate.confidence === 'unknown') {
      out.push(candidate);
      continue;
    }
    const key = dedupeKey(candidate);
    const prevAt = index.get(key);
    if (prevAt === undefined) {
      index.set(key, out.length);
      out.push(candidate);
      continue;
    }
    if (out[prevAt].confidence === 'guess' && candidate.confidence === 'exact') out[prevAt] = candidate;
  }
  return out;
}

/* ================================================================
   入口：整条链 → 候选
   ================================================================ */

/**
 * 一整条定位链 → 候选。
 *
 * - 首段不是定位方法 → `null`（动作行 / 非定位行，调用方当「忽略」而非「未识别」）；
 * - 中间出现过滤/索引段（`filter`/`nth`/`or`/`and`/`first`/`last`）→ 整链落 `pw`；
 * - 否则按单方法判定（`mapCall`）。
 */
export function mapChain(line: ParsedLine, ctx: MapContext): ElementPasteCandidate | null {
  const raw = Array.isArray(line.segments) ? line.segments : [];
  // 从第一个动作段起全部丢掉（元素库只存定位，不存动作）：`getByRole(...).click()` → `getByRole(...)`
  const cutAt = raw.findIndex((s) => isAction(s.method));
  const segments = cutAt >= 0 ? raw.slice(0, cutAt) : raw;
  if (!segments.length) return null;
  const head = segments[0];
  if (!isLocatorMethod(head.method)) return null;

  const hasIndex = segments.some((s) => INDEX_SET.has(s.method));
  if (hasIndex) {
    const chain = renderPlaywrightJs(segments);
    if (!chain) return null;
    return {
      name: suggestName(segments),
      locator: chain,
      kind: 'pw',
      confidence: 'guess',
      reason: `Playwright codegen（${PASTE_TARGET_LABEL[line.target]}）：这是「定位器 + 过滤/索引」的整条链，元素库只能原样存成 Playwright 链`,
      source: ctx.source,
      target: line.target,
    };
  }

  const single = segments.length === 1 ? head : null;
  if (!single) return null;
  return mapCall(head, ctx, { target: line.target, segments });
}
