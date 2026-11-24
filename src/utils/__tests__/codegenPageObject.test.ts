import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { generatePageObject, type PageObjectInput, type PomElement } from '../codegen/pageobject';

/**
 * 1.2 Page Object 生成器的 golden 测试（契约 §3.4 / §3.7 / [C-92]–[C-93]、[C-100]–[C-105]）。
 *
 * 3 组 golden，覆盖 [C-105] 要求的「含 role 与 text 定位器」：
 *   ① pom-login-page  css + text + role（映射到 AriaRole.BUTTON，带 roleName）
 *   ② pom-admin-table  xpath + css + role（默认用元素名当可访问名）
 *   ③ pom-escape-backslash  定位器里有反斜杠与双引号（[C-105] 的转义 golden）+ 元素重名
 *
 * 比对口径 [C-102]：换行归一后 `toBe` 逐字符相等。
 * 更新 golden：`UPDATE_GOLDEN=1 npx vitest run src/utils/__tests__/codegenPageObject.test.ts`。
 * 编译取证：`EMIT_JAVA_DIR=<临时目录> npx vitest run ...`（见回执的 javac 输出）。
 */

const GOLDEN_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__golden__', 'pom');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const EMIT = process.env.EMIT_JAVA_DIR || '';

function readText(file: string): string {
  return fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
}

function norm(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

const loginElements: PomElement[] = [
  { name: 'Username', locator: '#user', kind: 'css' },
  // 中文展示名 + 显式英文 methodName：不给 methodName 时只能退化成 element（见下方专测）
  { name: '密码', methodName: 'password', locator: 'input[name=password]', kind: 'css' },
  { name: '登录按钮', methodName: 'loginButton', locator: 'button', kind: 'role', roleName: '登录' },
  { name: '忘记密码链接', methodName: 'forgotPassword', locator: '忘记密码？', kind: 'text' },
];

const adminElements: PomElement[] = [
  { name: 'Rows', locator: '//table/tbody/tr', kind: 'xpath' },
  { name: 'SearchBox', locator: '#search', kind: 'css' },
  // role 的可访问名显式给中文：setName 用 roleName 而不是元素名
  { name: '详情链接', methodName: 'detailLink', locator: 'link', kind: 'role', roleName: '查看详情' },
];

const escapeElements: PomElement[] = [
  // 文本里有双引号与反斜杠：拼进 Java 字面量必须转义，否则源码直接编不过
  { name: 'PathHint', locator: 'C:\\temp\\logs "raw"', kind: 'text' },
  { name: 'PathHint', locator: '#dup', kind: 'css' },
];

interface Case {
  name: string;
  input: PageObjectInput;
}

const CASES: Case[] = [
  {
    name: 'pom-login-page',
    input: {
      className: 'loginPage',
      packageName: 'pages.petstore',
      baseUrl: 'https://petstore.example.com/login',
      pageName: '登录页',
      elements: loginElements,
    },
  },
  {
    name: 'pom-admin-table',
    input: {
      className: 'AdminTablePage',
      baseUrl: 'https://admin.example.com/users',
      pageName: '用户管理列表页',
      elements: adminElements,
    },
  },
  {
    name: 'pom-escape-backslash',
    input: {
      className: 'EscapePage',
      baseUrl: 'https://escape.example.com/',
      pageName: '转义样例页',
      elements: escapeElements,
    },
  },
];

function emit(emitRoot: string, files: Array<{ path: string; content: string }>): void {
  if (!emitRoot) return;
  for (const f of files) {
    const abs = path.join(emitRoot, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
  }
}

describe('generatePageObject：3 组 golden 逐字比对（[C-92]/[C-93]/[C-102]）', () => {
  for (const c of CASES) {
    it(`${c.name} 零差异`, () => {
      const r = generatePageObject(c.input);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);

      emit(EMIT, r.files);

      expect(r.files).toHaveLength(1);
      const actual = norm(r.files[0].content);
      if (UPDATE) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(path.join(GOLDEN_DIR, `${c.name}.java`), actual, 'utf8');
      }
      expect(actual).toBe(norm(readText(`${c.name}.java`)));
    });
  }
});

describe('generatePageObject：结构约定（[C-92]/[C-93]）', () => {
  it('构造注入 page + 每个元素一个 public Locator 方法（不做字段缓存）', () => {
    const r = generatePageObject(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;

    expect(src).toContain('private final Page page;');
    expect(src).toContain('public LoginPage(Page page) {');
    expect(src).toContain('this.page = page;');

    // [C-93]：方法每次返回新的 Locator（不做字段缓存），方法体只一行 return
    for (const name of ['username', 'password', 'loginButton', 'forgotPassword']) {
      expect(src).toMatch(new RegExp(`public Locator ${name}\\(\\) \\{\\n {8}return [^\\n]+;\\n {4}\\}`));
    }
    // 元素名不进字段（只有 page 一个字段）
    expect((src.match(/private final /g) || [])).toHaveLength(1);
  });

  it('kind → 定位器映射写死：css / xpath / text / role（[C-92]）', () => {
    const r = generatePageObject(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;

    expect(src).toContain('return page.locator("#user");');
    expect(src).toContain('return page.getByText("忘记密码？");');
    expect(src).toContain('return page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"));');
    expect(src).toContain('import com.microsoft.playwright.options.AriaRole;');
    // 没有 xpath 元素时不该出现 xpath= 前缀
    expect(src).not.toContain('xpath=');
  });

  it('xpath 加 `xpath=` 前缀；role 的可访问名优先用 roleName', () => {
    const r = generatePageObject(CASES[1].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;

    expect(src).toContain('return page.locator("xpath=//table/tbody/tr");');
    // 显式给了 roleName 就用它（'查看详情'），不是元素名（'详情链接'）
    expect(src).toContain('new Page.GetByRoleOptions().setName("查看详情")');
    expect(src).toContain('AriaRole.LINK');
  });

  it('元素名是纯中文且没给 methodName → 退到定位器里的 ASCII，再不行才用 element', () => {
    const fromLocator = generatePageObject({
      className: 'FallbackPage',
      baseUrl: 'https://x.example.com',
      pageName: '兜底页',
      elements: [
        { name: '用户名', locator: '#user', kind: 'css' },
        { name: '确定按钮', locator: '确定', kind: 'text' },
      ],
    });
    expect(fromLocator.ok).toBe(true);
    if (!fromLocator.ok) return;
    const src = fromLocator.files[0].content;
    // '#user' 里有 ASCII → userName 之类由 locator 派生？不：locator 只有 'user' 一词
    expect(src).toContain('public Locator user() {');
    // '确定' 既无 ASCII 名也无 ASCII 定位器 → element（并带注释说明是哪个元素）
    expect(src).toContain('public Locator element() {');
    expect(src).toContain('元素：确定按钮（text=确定）');
  });

  it('open() 把 baseUrl 落到 navigate（baseUrl 不是死参数）', () => {
    const r = generatePageObject(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('page.navigate("https://petstore.example.com/login");');
  });

  it('类名 / 包名归一：`loginPage` → LoginPage，包缺省 pages → path 落到 src/test/java/pages/', () => {
    const r = generatePageObject(CASES[1].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].path).toBe('src/test/java/pages/AdminTablePage.java');
    expect(r.files[0].content).toContain('public class AdminTablePage {');
    expect(r.files[0].content).toContain('package pages;');
  });

  it('转义：定位器里的双引号与反斜杠按 escape 规则处理（引号 \\"、反斜杠 \\\\）', () => {
    const r = generatePageObject(CASES[2].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    expect(src).toContain('page.getByText("C:\\\\temp\\\\logs \\"raw\\"")');
  });
});

describe('generatePageObject：重名 / 兜底 / 边界', () => {
  it('元素名重复 → 后者加数字后缀并压固定文案的告警（[C-93]）', () => {
    const r = generatePageObject(CASES[2].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('public Locator pathHint2() {');
    expect(r.warnings).toContain('元素名重复：PathHint，已改为 pathHint2');
  });

  it('role 映射不上 AriaRole → 降级 page.locator("role=...") 并告警（不静默）', () => {
    const r = generatePageObject({
      className: 'WeirdPage',
      baseUrl: 'https://x.example.com',
      pageName: '怪页面',
      elements: [{ name: '怪角色', locator: 'fancy-widget', kind: 'role', roleName: '怪' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    expect(src).toContain('return page.locator("role=fancy-widget");');
    expect(src).not.toContain('AriaRole');
    expect(r.warnings.join('\n')).toContain('role 无法映射到 AriaRole：fancy-widget');
  });

  it('元素名撞上生成器自己的方法名（page / open / url）→ 自动改名，不产出重复定义', () => {
    const r = generatePageObject({
      className: 'CollidePage',
      baseUrl: 'https://x.example.com',
      pageName: '冲突页',
      elements: [
        { name: 'page', locator: '#a', kind: 'css' },
        { name: 'open', locator: '#b', kind: 'css' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    expect(src).toContain('public Locator page2() {');
    expect(src).toContain('public Locator open2() {');
    // 只允许一个 open()
    expect((src.match(/public void open\(\)/g) || [])).toHaveLength(1);
  });

  it('元素为空也能生成（只有 open），且不 import 用不到的 Locator', () => {
    const r = generatePageObject({
      className: 'EmptyPage',
      baseUrl: 'https://x.example.com',
      pageName: '空页',
      elements: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    expect(src).toContain('public void open() {');
    expect(src).not.toContain('import com.microsoft.playwright.Locator;');
    expect(src).not.toContain('AriaRole');
  });

  it('lang 非 java → ok:false（[C-82]：本批只有 Java）', () => {
    const r = generatePageObject({ ...CASES[0].input, lang: 'python' as unknown as 'java' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('暂只支持 Java');
  });

  it('文件规范：LF、末尾恰好一个换行、无行尾空格、两次生成一致（[C-102]/[C-85]）', () => {
    const a = generatePageObject(CASES[0].input);
    const b = generatePageObject(CASES[0].input);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.files[0].content).toEqual(b.files[0].content);
    const src = a.files[0].content;
    expect(src).not.toContain('\r');
    expect(src.endsWith('\n')).toBe(true);
    expect(src.endsWith('\n\n')).toBe(false);
    expect(src.split('\n').every((l) => l === l.replace(/[ \t]+$/, ''))).toBe(true);
  });
});