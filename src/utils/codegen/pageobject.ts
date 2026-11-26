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
 * 3. **`kind` 的映射写死**（[C-92]）：css / xpath / text / role 四种，role 只认 Playwright
 *    `AriaRole` 枚举里存在的名字；映射不上时**不静默**，降级成 `page.locator("role=...")` 并压告警。
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
 * 元素种类：css / xpath / text / role（[C-92]）+ **1.36.0（B6）新增 `pw`**。
 * 加新的要同时改映射与单测。
 *
 * `pw` = 「Playwright 链原样存」：用户在元素库里粘的就是一行 JS（`page.getByRole(...).filter(...)`），
 * 这里只做机械改写（见 `pwChainToJava`）。为什么需要它：css/xpath 表达不了 `hasText` / `hasNotText`
 * 这类**语义过滤**，硬塞进 css 会变成 `:has-text()` 这种非标准写法（Playwright 认、浏览器不认），
 * 而元素库的定位器要同时服务「浏览器内校验」和「生成 Java」两个消费者。
 */
export type PomLocatorKind = 'css' | 'xpath' | 'text' | 'role' | 'pw';

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
      // 规则⑥
      const commaAt = args.indexOf(',');
      const roleRaw = commaAt >= 0 ? args.slice(0, commaAt) : args;
      const optsRaw = commaAt >= 0 ? args.slice(commaAt + 1) : '';
      const role = ariaRoleOf(unquote(roleRaw));
      if (!role) return fail(`getByRole 的 role「${unquote(roleRaw)}」映射不上 AriaRole`, fallbackCss);
      const nameRaw = optionOf(optsRaw, 'name');
      const call = `getByRole(AriaRole.${role}${nameRaw ? `, new Page.GetByRoleOptions().setName(${javaString(regexToText(nameRaw).text)})` : ''})`;
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
   定位器表达式（[C-92] 的四种映射 + B6 的 pw）
   ================================================================ */

function locatorExpr(el: PomElement, warnings: string[], displayName: string): string {
  const loc = String(el.locator ?? '');
  switch (el.kind) {
    case 'css':
      return `page.locator(${javaString(loc)})`;
    case 'xpath':
      // Playwright 的 xpath 引擎前缀必须带，否则会按 css 解析
      return `page.locator(${javaString(`xpath=${loc}`)})`;
    case 'text':
      return `page.getByText(${javaString(loc)})`;
    case 'role': {
      const role = ariaRoleOf(loc);
      if (!role) {
        // 映射不上不是「失败」：角色选择器还有 `role=<role>` 这种字符串写法可用
        warnings.push(`role 无法映射到 AriaRole：${loc}，已用 page.locator("role=${loc}") 兜底`);
        return `page.locator(${javaString(`role=${loc}`)})`;
      }
      const name = String(el.roleName ?? displayName ?? '');
      return `page.getByRole(AriaRole.${role}, new Page.GetByRoleOptions().setName(${javaString(name)}))`;
    }
    case 'pw': {
      // 1.36.0（B6）：把存下来的 Playwright 链机械改写成 Java。转不出**不抛**，
      // 走既有 warnings 机制 + css 兜底（没有 css 时 `page.locator("body")`，裁定 Z9）。
      const r = pwChainToJava(loc);
      for (const w of r.warnings) warnings.push(w);
      return r.expr;
    }
    default:
      // 未知 kind：当成 css 兜底（类型上不可达，但运行时的脏数据不会让整个生成失败）
      warnings.push(`未知的元素类型：${String(el.kind)}，已按 css 处理`);
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