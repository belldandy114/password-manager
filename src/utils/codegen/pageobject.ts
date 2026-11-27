/**
 * 1.2 元素列表 → Java Page Object（Playwright，契约 §3.4 / [C-92]–[C-93]）。
 *
 * 纯函数：元素表进、Java 源码出；不读文件、不碰 IPC、不含时间戳（[C-85]）。
 *
 * 几个**写死**的取舍：
 *
 * 1. **每个元素一个 `public Locator <name>()` 方法，不做字段缓存**（[C-93]）。
 *    Playwright 的 `page.locator(...)` 本身是惰性的，但把 Locator 存成字段会让人以为它是
 *    "某个时刻的元素快照"，页面一跳就容易拿去用错地方；方法每次返回新的 Locator，语义最干净。
 * 2. **`open()` 把 baseUrl 落到 `page.navigate(...)`**：输入里 `baseUrl`/`pageName` 若只出现在注释里，
 *    就是死参数；给一个 `open()` 既让 baseUrl 有用，也省掉每个用例手写导航。
 * 3. **`kind` 的映射写死**：**10 种**（契约 [A0-1]）—— css / xpath / text / role / pw 五种既有，
 *    加 label / placeholder / alttext / title / testid 五种（A₀）。role 只认 Playwright `AriaRole`
 *    枚举里存在的名字；映射不上时**不静默**，降级成 `page.locator("role=...")` 并压告警（[Z-2]：
 *    不用 `AriaRole.valueOf`——那是 Java 枚举的**必抛**运行期异常，比兜底文本更难排查）。
 * 4. **名字冲突必须可预期**：元素名重复 → 加数字后缀并压告警（[C-93] 给了固定文案）；
 *    `page` / `open` 这两个方法名先占位，元素叫 `page` 时自动变成 `page2`，否则生成物编不过。
 *
 * 依赖方向：[C-107] 允许 `pageobject.ts → escape.ts`，反向禁止。
 */

import {
  camelCase, javaIdentifier, javaPackageSegment, javaString, pascalCase,
  type GenOk, type GenFail,
} from './escape';

/**
 * 元素种类：**10 种**（契约 [A0-1]，`[Z-1]` 追认）。
 *
 * 5 既有（[C-92] + 1.36.0 B6 的 `pw`）：css / xpath / text / role / pw。
 * 5 新增（A₀）：label / placeholder / alttext / title / testid —— 都是 Playwright 的
 * `getByLabel` / `getByPlaceholder` / `getByAltText` / `getByTitle` / `getByTestId` 一族。
 *
 * **为什么是 10 而不是 9**：参考工程 `1148872017/test-tool` 是 9 种，因为它**没有 `pw`**
 * （它不做「原样存一行 Playwright 链」这件事）；本仓库在 1.36.0 已经多了一个 `pw`，
 * 所以 9 + pw = 10。若将来下线 `pw`，才回到 9，且必须同步删掉 [A0-6]③ 与 [A0-7]。
 *
 * `pw` = 「Playwright 链原样存」：用户在元素库里粘的就是一行 JS（`page.getByRole(...).filter(...)`），
 * 这里只做机械改写（见 `pwChainToJava`）。为什么需要它：css/xpath 表达不了 `hasText` / `hasNotText`
 * 这类**语义过滤**，硬塞进 css 会变成 `:has-text()` 这种非标准写法（Playwright 认、浏览器不认），
 * 而元素库的定位器要同时服务「浏览器内校验」和「生成 Java」两个消费者。
 *
 * ⚠️ 这份联合类型是**单一真源**：界面下拉（`pomModel.ts` 的 `KINDS`）与主进程白名单
 * （`electron/element-args.js` 的 `KINDS`）都必须与 `POM_LOCATOR_KINDS` 逐项同序，
 * 不许再写第二份手写数组（[A0-1] 的证伪形态）。
 */
export type PomLocatorKind =
  | 'css' | 'xpath' | 'text' | 'role' | 'pw'          // 既有 5 种
  | 'label' | 'placeholder' | 'alttext' | 'title' | 'testid';  // A₀ 新增 5 种

/**
 * 有序清单（[A0-1]）：顺序 = 界面下拉顺序 = 文档表格顺序 = 主进程白名单顺序。
 * 改这一份就要同步 `electron/element-args.js` 的 `KINDS`（parity 单测会红）。
 */
export const POM_LOCATOR_KINDS: readonly { id: PomLocatorKind; label: string }[] = [
  { id: 'css', label: 'css 选择器' },
  { id: 'xpath', label: 'xpath' },
  { id: 'text', label: '可见文本' },
  { id: 'role', label: '角色（role）' },
  { id: 'pw', label: 'Playwright 链（原样存）' },
  { id: 'label', label: 'label 文本' },
  { id: 'placeholder', label: 'placeholder 文本' },
  { id: 'alttext', label: 'alt 文本' },
  { id: 'title', label: 'title 属性' },
  { id: 'testid', label: 'data-testid' },
];

/** 10 个 id 的纯字符串视图（归一与白名单判断用，不另建数组语义） */
const KIND_IDS: readonly string[] = POM_LOCATOR_KINDS.map((k) => k.id);

/**
 * kind 归一（[A0-3]）：是清单里的 id（**大小写不敏感、两端空白忽略**）→ 原样返回该 id；
 * 其它一切（`undefined` / `null` / 空串 / 数字 / 对象 / 未收录的字符串）→ `'css'`。
 *
 * 为什么兜底成 css：老库里的 `kind` 缺失是历史数据，拦下来等于「打开老元素就退化到无法保存」；
 * 而 `css` 是唯一能对任意字符串都不崩的解释（最坏是运行期 not found，不会生成非法 Java）。
 */
export function normalizeLocatorKind(raw: unknown): PomLocatorKind {
  const s = String(raw ?? '').trim().toLowerCase();
  return (KIND_IDS.includes(s) ? s : 'css') as PomLocatorKind;
}

export interface PomElement {
  /** 展示名，写在方法注释里；没有 ASCII 时也用作方法名的来源之一 */
  name: string;
  /** 定位器本体：css 选择器 / xpath 表达式 / 可见文本 / 角色名 */
  locator: string;
  kind: PomLocatorKind;
  /**
   * `kind: 'role'` 时的可访问名（`setName(...)` 的值）。
   * 缺省用 `name` —— 元素名通常就是用户看到的按钮名，但对中文界面建议显式给。
   */
  roleName?: string;
  /**
   * 显式指定方法名（英文）。元素名是中文时强烈建议给：
   * `escape.ts` 的 `javaIdentifier` 会把中文整段变成下划线（[C-90] 不许中文标识符），
   * 没有它就只能退化成 `element` / `element2` 这种名字。
   */
  methodName?: string;
}

/** 有没有可用的 ASCII 片段（中文/emoji 名要退到 locator 或显式 methodName） */
function hasAscii(s: string): boolean {
  return /[A-Za-z0-9$]/.test(String(s ?? ''));
}

/**
 * 元素 → 方法名的基名。优先级（写死在单测里）：
 * `methodName` → 元素名里的 ASCII → 定位器里的 ASCII → `element`。
 * 为什么要往下退：中文元素名过 `camelCase` 之后是空串，全变成 `value` / `value2`，
 * 生成物一眼看过去全是 value，等于没命名。
 */
function baseNameOf(el: PomElement, displayName: string): string {
  const explicit = String(el.methodName ?? '').trim();
  if (explicit) return javaIdentifier(camelCase(explicit), 'element');
  if (hasAscii(displayName)) return javaIdentifier(camelCase(displayName), 'element');
  if (hasAscii(el.locator)) return javaIdentifier(camelCase(el.locator), 'element');
  return 'element';
}

export interface PageObjectInput {
  className: string;
  packageName?: string;
  /** 页面地址（写进 open()） */
  baseUrl: string;
  /** 页面名，用于类注释 */
  pageName: string;
  elements: PomElement[];
  lang?: 'java';
}

/* ================================================================
   AriaRole 映射
   ================================================================ */

/**
 * Playwright Java `AriaRole` 枚举的**全部**常量（1.43.0 实测 `AriaRole.values()` 导出）。
 * 写死在这里而不是「拼大写就当地图」：拼错了 javac 过不去，而生成物能编译是硬要求。
 */
const ARIA_ROLES = new Set([
  'ALERT', 'ALERTDIALOG', 'APPLICATION', 'ARTICLE', 'BANNER', 'BLOCKQUOTE', 'BUTTON', 'CAPTION',
  'CELL', 'CHECKBOX', 'CODE', 'COLUMNHEADER', 'COMBOBOX', 'COMPLEMENTARY', 'CONTENTINFO',
  'DEFINITION', 'DELETION', 'DIALOG', 'DIRECTORY', 'DOCUMENT', 'EMPHASIS', 'FEED', 'FIGURE',
  'FORM', 'GENERIC', 'GRID', 'GRIDCELL', 'GROUP', 'HEADING', 'IMG', 'INSERTION', 'LINK', 'LIST',
  'LISTBOX', 'LISTITEM', 'LOG', 'MAIN', 'MARQUEE', 'MATH', 'METER', 'MENU', 'MENUBAR', 'MENUITEM',
  'MENUITEMCHECKBOX', 'MENUITEMRADIO', 'NAVIGATION', 'NONE', 'NOTE', 'OPTION', 'PARAGRAPH',
  'PRESENTATION', 'PROGRESSBAR', 'RADIO', 'RADIOGROUP', 'REGION', 'ROW', 'ROWGROUP', 'ROWHEADER',
  'SCROLLBAR', 'SEARCH', 'SEARCHBOX', 'SEPARATOR', 'SLIDER', 'SPINBUTTON', 'STATUS', 'STRONG',
  'SUBSCRIPT', 'SUPERSCRIPT', 'SWITCH', 'TAB', 'TABLE', 'TABLIST', 'TABPANEL', 'TERM', 'TEXTBOX',
  'TIME', 'TIMER', 'TOOLBAR', 'TOOLTIP', 'TREE', 'TREEGRID', 'TREEITEM',
]);

/** `text box` / `text-box` / `textbox` → `TEXTBOX`；返回 null 表示映射不上 */
function ariaRoleOf(raw: string): string | null {
  const key = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ARIA_ROLES.has(key) ? key : null;
}

/**
 * role 原文 → Java 侧的定位表达式（契约 [A1-2]，`[Z-2]` 定死口径）。
 *
 * - 已知（82 项内）：`{ expr: 'AriaRole.BUTTON', aria: true }`
 * - 未知：`{ expr: 'page.locator("role=fancy-widget")', aria: false }` + 压 1 条告警
 *
 * **永不返回 null、永不抛**，也**永不生成 `AriaRole.valueOf`** ——Java 的 `AriaRole` 是真枚举，
 * `Enum.valueOf` 对不存在的常量名**固定抛** `IllegalArgumentException`，编得过、跑到就 100% 崩，
 * 而 `page.locator("role=x")` 不命中时是超时 + 截图 + 面板高亮（可查）。同样是不工作，一个能定位、一个只能猜。
 */
function ariaRoleExpr(raw: string, warnings: string[]): { expr: string; aria: boolean } {
  const role = ariaRoleOf(raw);
  if (!role) {
    warnings.push(`role 无法映射到 AriaRole：${raw}，已用 page.locator("role=${raw}") 兜底`);
    return { expr: `page.locator(${javaString(`role=${raw}`)})`, aria: false };
  }
  return { expr: `AriaRole.${role}`, aria: true };
}

/* ================================================================
   pw 链：Playwright JS → Java 的机械改写（1.36.0 / B6，方案 §11.4 的 7 条）
   ================================================================ */

/**
 * 链尾的**动作**方法：元素库只存「定位」，所以从第一个动作开始整段丢掉（规则①）。
 * 用集合而不是正则：方法名是有限集，正则会把 `getByText` 里的 `Text` 也当成动作。
 */
const PW_TAIL_ACTIONS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'hover', 'check', 'uncheck', 'selectoption',
  'setinputfiles', 'tap', 'focus', 'blur', 'clear', 'scrollintoviewifneeded', 'waitfor',
  'screenshot', 'evaluate', 'count', 'innertext', 'textcontent', 'getattribute', 'isvisible',
  'isenabled', 'isdisabled', 'inputvalue', 'dispatchevent', 'dragto', 'selecttext', 'setchecked',
]);

/**
 * 转不出的链段（规则⑦）：`filter({has})` / `.or()` / `.and()` / `.nth()`。
 * 为什么不硬转：Java 侧对应的是 `locator.or(other)` / `nth(i)`，语义是「多候选」，而元素库的
 * 一个元素只有**一个**定位器；硬转出来的 Java 与用户在 JS 里看到的不是同一个东西。
 */
const PW_UNSUPPORTED = new Set(['or', 'and', 'nth', 'first', 'last']);

export interface PwChainResult {
  /** 转出来了没有（false 时 `expr` 是 css 兜底，`warnings` 非空） */
  ok: boolean;
  /** Java 侧的定位器表达式（一定以 `page.` 开头，可直接接在 `return` 后面） */
  expr: string;
  /** 链里第一个 `locator("css")` 的 css；没有就是空串 */
  fallbackCss: string;
  warnings: string[];
}

/** 去掉一层字符串引号并解转义（`\"` → `"`） */
function unquote(raw: string): string {
  const s = String(raw ?? '').trim();
  const q = s[0];
  if ((q === '"' || q === "'" || q === '`') && s.length >= 2 && s.endsWith(q)) {
    return s.slice(1, -1).replace(/\\(["'`\\])/g, '$1');
  }
  return s;
}

/** 参数是不是正则字面量（`/^全部$/i`）；是则返回「去锚点后的字符串 + 是否真的去过锚点」 */
function regexToText(raw: string): { text: string; stripped: boolean; isRegex: boolean } {
  const s = String(raw ?? '').trim();
  const m = s.match(/^\/([\s\S]*)\/([a-z]*)$/);
  if (!m) return { text: unquote(s), stripped: false, isRegex: false };
  let body = m[1];
  const stripped = /^\^/.test(body) || /\$$/.test(body);
  body = body.replace(/^\^/, '').replace(/\$$/, '');
  // 正则里的转义在字符串里没有意义，这里只把常见的 `\/` 还原
  return { text: body.replace(/\\\//g, '/'), stripped, isRegex: true };
}

/** 按「顶层 `.`」把链切成段（引号/括号内的点不切） */
function splitChain(src: string): { name: string; args: string }[] {
  const out: { name: string; args: string }[] = [];
  let i = 0;
  const n = src.length;
  const skipSpace = () => { while (i < n && /\s/.test(src[i])) i += 1; };
  skipSpace();
  // 允许整条链带 `page.` 前缀；不带也能解析（规则②会补）
  if (src.startsWith('page.')) i = 'page.'.length;
  while (i < n) {
    skipSpace();
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!nameMatch) break;
    const name = nameMatch[0];
    i += name.length;
    skipSpace();
    let args = '';
    if (src[i] === '(') {
      let depth = 0;
      let quote = '';
      const start = i + 1;
      for (; i < n; i += 1) {
        const ch = src[i];
        if (quote) {
          if (ch === '\\') { i += 1; continue; }
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '(') depth += 1;
        if (ch === ')') {
          depth -= 1;
          if (depth === 0) { args = src.slice(start, i); i += 1; break; }
        }
      }
    }
    out.push({ name, args });
    skipSpace();
    if (src[i] === '.') { i += 1; continue; }
    // 后面还有 `;` 之类 → 结束
    if (src[i] === ';') break;
    if (i < n && !/^\s*\./.test(src.slice(i))) break;
  }
  return out;
}

/** 取对象字面量里的某个键的原始值（`{ name: '提交' }` → `'提交'`） */
function optionOf(args: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\/(?:[^\\/\\\\]|\\\\.)*\\/[a-z]*|[^,}]+)`);
  const m = args.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Playwright JS 链 → Java 表达式（纯函数、不抛）。
 *
 * 7 条规则（方案 §11.4，逐条有单测）：
 * ① 去前置 `await` 与尾部动作（`.click()` / `.fill(...)` …）；
 * ② `locator("css")` → `page.locator("css")`；
 * ③ `filter({ hasText })` → `.filter(new Locator.FilterOptions().setHasText(...))`（正则去锚点转字符串 + 告警）；
 * ④ `filter({ hasNotText })` → `setHasNotText(...)`；
 * ⑤ `getByPlaceholder` 等同名方法 → 名字不变、补 `page.` 前缀；
 * ⑥ `getByRole(role, { name })` → `getByRole(AriaRole.X, new Page.GetByRoleOptions().setName("name"))`；
 * ⑦ `filter({ has })` / `.or()` / `.and()` / `.nth()` **转不出** → 告警 + 链里第一个 css 兜底；
 *    连 css 都没有时按裁定 Z9 兜底成 `page.locator("body")` 并明说「请手改」。
 *
 * ⚠️ 本模块是**单向**的（JS → Java），不做 Java → JS 回转；也不静默降级（转不出一律告警）。
 */
export function pwChainToJava(chain: string): PwChainResult {
  const warnings: string[] = [];
  let src = String(chain ?? '').trim().replace(/;$/, '').trim();
  // 规则①：去 `await`
  src = src.replace(/^await\s+/, '').trim();

  const fail = (reason: string, fallbackCss: string): PwChainResult => {
    if (fallbackCss) {
      warnings.push(`Playwright 链转不出 Java（${reason}），已用链里的 css 兜底：${fallbackCss}`);
      return { ok: false, expr: `page.locator(${javaString(fallbackCss)})`, fallbackCss, warnings };
    }
    warnings.push(`Playwright 链转不出 Java（${reason}），且链里没有 css 兜底 —— 已生成 page.locator("body")，请手改`);
    return { ok: false, expr: 'page.locator("body")', fallbackCss: '', warnings };
  };

  if (!src) return fail('空串', '');

  const segs = splitChain(src);
  if (!segs.length) return fail('无法解析成方法调用', '');

  // 先找出链里第一个 css（兜底要用），哪怕它出现在后面
  let fallbackCss = '';
  for (const s of segs) {
    if (s.name === 'locator') {
      const v = regexToText(s.args);
      if (v.text) { fallbackCss = v.text; break; }
    }
  }

  const parts: string[] = [];
  for (let idx = 0; idx < segs.length; idx += 1) {
    const { name, args } = segs[idx];
    const lower = name.toLowerCase();

    // 规则①：尾部动作（从第一个动作起，后面全丢）
    if (PW_TAIL_ACTIONS.has(lower)) {
      if (!parts.length) return fail(`链以动作 .${name}() 开头，没有定位器`, fallbackCss);
      break;
    }
    if (PW_UNSUPPORTED.has(lower)) return fail(`.${name}() 转不出`, fallbackCss);

    if (lower === 'filter') {
      // 规则③/④：hasText / hasNotText 能转；has 转不出（规则⑦）
      const has = optionOf(args, 'has');
      if (has) return fail('filter({ has }) 转不出', fallbackCss);
      const key = optionOf(args, 'hasNotText') ? 'hasNotText' : (optionOf(args, 'hasText') ? 'hasText' : '');
      if (!key) return fail('filter(...) 的参数里没有 hasText / hasNotText', fallbackCss);
      const raw = optionOf(args, key) as string;
      const t = regexToText(raw);
      if (t.isRegex && t.stripped) {
        warnings.push(`filter(${key}) 的正则锚点（^ / $）已去掉，按「包含」匹配："${t.text}"`);
      }
      const setter = key === 'hasText' ? 'setHasText' : 'setHasNotText';
      parts.push(`filter(new Locator.FilterOptions().${setter}(${javaString(t.text)}))`);
      continue;
    }

    if (lower === 'locator') {
      // 规则②：补 page 前缀只在第一段做；后续 `locator()` 属于嵌套（如 `.locator("#x")`），同样同名可用
      const css = regexToText(args).text;
      if (!css) return fail('locator() 没有 css 参数', fallbackCss);
      const call = `locator(${javaString(css)})`;
      parts.push(parts.length ? call : `page.${call}`);
      continue;
    }

    if (lower === 'getbyrole') {
      // 规则⑥ —— **与 `locatorExpr` 的 role 分支同一个入口**（契约 [A1-2]，review AR-1）：
      // 已知角色 → `AriaRole.<KEY>`；未知角色 → `page.locator("role=<raw>")` 兜底（**不再 fail 整链**）。
      // 两条路径行为一致是硬要求：同一个未知角色，走 kind=role 与走 pw 链必须得到同一条表达式 + 同一条告警。
      const commaAt = args.indexOf(',');
      const roleRaw = commaAt >= 0 ? args.slice(0, commaAt) : args;
      const optsRaw = commaAt >= 0 ? args.slice(commaAt + 1) : '';
      const r = ariaRoleExpr(unquote(roleRaw), warnings);
      if (!r.aria) {
        // `r.expr` 形如 `page.locator("role=x")`：首段整条用它；非首段去掉 `page.` 前缀，
        // 变成链上的一段 `locator("role=x")`（`Locator.locator(selector)` 合法，语义等价兜底）
        parts.push(parts.length ? r.expr.replace(/^page\./, '') : r.expr);
        continue;
      }
      const nameRaw = optionOf(optsRaw, 'name');
      // AR-4：roleName 一律 trim（与 `locatorExpr` 的 setName 同一口径）——
      // 不 trim 会生成 `setName(" 提交 ")`，可访问名匹配不上
      const roleName = nameRaw ? regexToText(nameRaw).text.trim() : '';
      const call = `getByRole(${r.expr}${roleName ? `, new Page.GetByRoleOptions().setName(${javaString(roleName)})` : ''})`;
      parts.push(parts.length ? call : `page.${call}`);
      continue;
    }

    // 规则⑤家族：Java 侧同名的方法，参数是字符串
    const SAME_NAME = new Set(['getbytext', 'getbyplaceholder', 'getbylabel', 'getbytitle', 'getbytestid', 'getbyalttext']);
    if (SAME_NAME.has(lower)) {
      const call = `${name}(${javaString(regexToText(args.split(',')[0]).text)})`;
      parts.push(parts.length ? call : `page.${call}`);
      continue;
    }

    return fail(`不认识的方法 .${name}()`, fallbackCss);
  }

  if (!parts.length) return fail('没有可转的定位器段', fallbackCss);
  // 第一段没有 `page.` 前缀（例如链从 `.filter(...)` 开头）→ 无法构成表达式
  if (!parts[0].startsWith('page.')) return fail('链不是从 page.xxx / locator(...) 开头', fallbackCss);
  return { ok: true, expr: parts.join('.'), fallbackCss, warnings };
}

/* ================================================================
   定位器表达式（[A0-2] 的 10 种映射）
   ================================================================ */

/**
 * 脏 kind 在告警里的**显示值**（review AR-8）。
 *
 * 老库里有 `kind` 字段缺失的元素（1.34.0 及以前），告警原本会拼成
 * `未知的元素类型：，已按 css 处理` —— 冒号后面是空的，读的人根本不知道是"没填"还是"填了个看不见的东西"。
 * 口径：拿实际值（两端空白去掉）；空 / 只有空白 → 固定文案 `（空）`；**任何情况下都不出现 `undefined`**。
 */
function rawKindText(raw: string): string {
  return String(raw ?? '').trim() || '（空）';
}

function locatorExpr(el: PomElement, warnings: string[], displayName: string): string {
  const loc = String(el.locator ?? '');
  // 调用点 ①（[A0-3]）：先把 kind 归一，脏值一律当 css；同时保留既有告警文案（不静默）
  const rawKind = String(el.kind ?? '');
  const kind = normalizeLocatorKind(el.kind);
  if (rawKind !== kind) {
    warnings.push(`未知的元素类型：${rawKindText(rawKind)}，已按 css 处理`);
  }
  switch (kind) {
    case 'css':
      return `page.locator(${javaString(loc)})`;
    case 'xpath':
      // Playwright 的 xpath 引擎前缀必须带，否则会按 css 解析；库里存的是**不带前缀**的表达式（[A0-2] 第 2 行）
      return `page.locator(${javaString(`xpath=${loc}`)})`;
    case 'text':
      return `page.getByText(${javaString(loc)})`;
    case 'role': {
      const r = ariaRoleExpr(loc, warnings);
      // 未知角色：`expr` 已经是整条 `page.locator("role=...")`，不能再包 setName（[A1-2]）
      if (!r.aria) return r.expr;
      // AR-4：roleName 一律 `String(...).trim()`（与 `pwChainToJava` 规则⑥ 同一口径）；
      // trim 后为空视为「没填」，退回元素展示名 —— 免得生成 `setName("")`（[C-28] 的失效形态）
      const name = String(el.roleName ?? '').trim() || String(displayName ?? '').trim();
      return `page.getByRole(${r.expr}, new Page.GetByRoleOptions().setName(${javaString(name)}))`;
    }
    case 'pw': {
      // 1.36.0（B6）：把存下来的 Playwright 链机械改写成 Java。转不出**不抛**，
      // 走既有 warnings 机制 + css 兜底（没有 css 时 `page.locator("body")`，裁定 Z9）。
      const r = pwChainToJava(loc);
      for (const w of r.warnings) warnings.push(w);
      return r.expr;
    }
    // A₀ 新增 5 种：与 Playwright Java 的同名方法**逐字一致**，不带 setName / 不带 options（[A0-2]）
    case 'label':
      return `page.getByLabel(${javaString(loc)})`;
    case 'placeholder':
      return `page.getByPlaceholder(${javaString(loc)})`;
    case 'alttext':
      return `page.getByAltText(${javaString(loc)})`;
    case 'title':
      return `page.getByTitle(${javaString(loc)})`;
    case 'testid':
      return `page.getByTestId(${javaString(loc)})`;
    default:
      // 类型上不可达（normalizeLocatorKind 已收口），运行时脏数据仍不许让整个生成失败
      warnings.push(`未知的元素类型：${rawKindText(rawKind)}，已按 css 处理`);
      return `page.locator(${javaString(loc)})`;
  }
}

/* ================================================================
   文件规范（[C-102]）
   ================================================================ */

/** UTF-8 无 BOM、LF、末尾恰好一个换行、行尾无空格 */
export function normalizeJava(text: string): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  return `${body}\n`;
}

function normalizePackage(packageName: string | undefined, fallback: string): string {
  const raw = String(packageName ?? '').trim() || fallback;
  const segs = raw.split('.').map((seg) => javaPackageSegment(seg)).filter(Boolean);
  return segs.length ? segs.join('.') : fallback;
}

/* ================================================================
   入口
   ================================================================ */

export function generatePageObject(input: PageObjectInput): GenOk | GenFail {
  if (input.lang && input.lang !== 'java') {
    return { ok: false, error: '暂只支持 Java（lang=java）' };
  }

  const className = javaIdentifier(pascalCase(input.className) || 'Page', 'Page');
  const pkg = normalizePackage(input.packageName, 'pages');
  const pkgPath = pkg.split('.').join('/');
  const baseUrl = String(input.baseUrl ?? '').trim();
  const pageName = String(input.pageName ?? '').trim() || className;
  const elements = Array.isArray(input.elements) ? input.elements : [];

  const warnings: string[] = [];

  // `page` 是构造注入的字段名，`open` 是本生成器自己的方法 —— 先占位，
  // 否则元素叫 page 时会生成两个同名字段/方法，javac 直接报重复定义
  const used = new Set<string>(['page', 'open', 'url']);

  const methods: string[] = [];
  let firstMethod = '';
  for (const el of elements) {
    const displayName = String(el.name ?? '').trim() || 'element';
    const base = baseNameOf(el, displayName);
    let methodName = base;
    if (used.has(base)) {
      let i = 2;
      while (used.has(`${base}${i}`)) i++;
      methodName = `${base}${i}`;
      warnings.push(`元素名重复：${displayName}，已改为 ${methodName}`);
    }
    used.add(methodName);
    if (!firstMethod) firstMethod = methodName;

    const expr = locatorExpr(el, warnings, displayName);
    methods.push(
      [
        `    /** 元素：${displayName}（${el.kind}=${String(el.locator ?? '')}） */`,
        `    public Locator ${methodName}() {`,
        `        return ${expr};`,
        '    }',
      ].join('\n'),
    );
  }

  /* ---- 组装类文件 ---- */
  const hasLocatorMethod = methods.length > 0;
  const usesAria = methods.some((m) => m.includes('AriaRole.'));

  const lines: string[] = [
    `package ${pkg};`,
    '',
  ];
  if (hasLocatorMethod) lines.push('import com.microsoft.playwright.Locator;');
  lines.push('import com.microsoft.playwright.Page;');
  if (usesAria) lines.push('import com.microsoft.playwright.options.AriaRole;');
  lines.push(
    '',
    '/**',
    ` * ${className}：${pageName} 的 Page Object（由「测试中台」从元素库生成）。`,
    ' *',
    ' * <p>用法：',
    ' * <pre>',
    ` * ${className} page = new ${className}(playwrightPage);`,
    ' * page.open();',
    firstMethod ? ` * page.${firstMethod}().click();` : ' * // 还没有元素：在元素库里加一条再重新生成',
    ' * </pre>',
    ' */',
    `public class ${className} {`,
    '',
    '    private final Page page;',
    '',
    `    public ${className}(Page page) {`,
    '        this.page = page;',
    '    }',
    '',
    '    /** 打开页面（baseUrl 由生成时填写，改地址只改这一处） */',
    '    public void open() {',
    `        page.navigate(${javaString(baseUrl)});`,
    '    }',
  );

  if (methods.length) {
    lines.push('', methods.join('\n\n'));
  }
  lines.push('}', '');

  return {
    ok: true,
    files: [{
      path: `src/test/java/${pkgPath}/${className}.java`,
      content: normalizeJava(lines.join('\n')),
    }],
    warnings,
  };
}