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

/** 元素种类：本批只支持这四种（[C-92]），加新的要同时改映射与单测 */
export type PomLocatorKind = 'css' | 'xpath' | 'text' | 'role';

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
   定位器表达式（[C-92] 的四种映射）
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