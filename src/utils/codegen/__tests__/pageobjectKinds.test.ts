/**
 * A₀：定位方式 5 → 10（契约 [A0-1]–[A0-3]、[A1-1]–[A1-6]）。
 *
 * 这个文件只做 A₀/A₁ **输出侧**的验收，不碰既有 `codegenPageObject.test.ts`（[A1-6] 要求它
 * 逐字零改动），所以既有 golden 与既有断言在这里也不再重复。
 *
 * 更新 golden：`UPDATE_GOLDEN=1 npx vitest run src/utils/codegen/__tests__/pageobjectKinds.test.ts`
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  generatePageObject, POM_LOCATOR_KINDS, normalizeLocatorKind,
  type PageObjectInput, type PomElement, type PomLocatorKind,
} from '../pageobject';

const GOLDEN_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__golden__', 'pom');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Playwright Java `AriaRole` 的 82 个常量（[A1-1] 的真源，这里作为**断言样本**逐项自反） */
const ROLE_KEYS = [
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
];

function inputOf(elements: PomElement[], over: Partial<PageObjectInput> = {}): PageObjectInput {
  return {
    className: 'KindPage',
    baseUrl: 'https://kind.example.com/page',
    pageName: '类型样例页',
    elements,
    ...over,
  };
}

function srcOf(elements: PomElement[], over: Partial<PageObjectInput> = {}): string {
  const r = generatePageObject(inputOf(elements, over));
  if (!r.ok) throw new Error(r.error);
  return r.files[0].content;
}

function warningsOf(elements: PomElement[]): string[] {
  const r = generatePageObject(inputOf(elements));
  if (!r.ok) throw new Error(r.error);
  return r.warnings;
}

/* ================================================================
   [A0-1] 取值清单：10 个，顺序稳定
   ================================================================ */

describe('[A0-1] PomLocatorKind = 10 个取值，清单逐项相等且顺序稳定', () => {
  it('有序清单逐项相等（顺序 = 界面下拉 = 主进程白名单）', () => {
    expect(POM_LOCATOR_KINDS.map((k) => k.id)).toEqual([
      'css', 'xpath', 'text', 'role', 'pw', 'label', 'placeholder', 'alttext', 'title', 'testid',
    ]);
  });

  it('取值数 = 10（[Z-1]：9 = test-tool 口径，因为那边没有 pw）', () => {
    const ids = POM_LOCATOR_KINDS.map((k) => k.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    // 5 既有 + 5 新增，两段都逐项核，避免"少一种"被数字掩盖
    expect(ids).toEqual(expect.arrayContaining(['css', 'xpath', 'text', 'role', 'pw']));
    expect(ids).toEqual(expect.arrayContaining(['label', 'placeholder', 'alttext', 'title', 'testid']));
  });

  it('每个 id 都有非空中文文案（下拉直接用，[A0-8]）', () => {
    for (const k of POM_LOCATOR_KINDS) {
      expect(k.label.trim().length).toBeGreaterThan(0);
    }
  });
});

/**
 * **parity 单测**（验收第 2 条）：`POM_LOCATOR_KINDS` 必须与 `PomLocatorKind` 的取值集合
 * **完全一致**。两个方向都由类型系统兜住，运行时再断言顺序稳定：
 * - 联合类型里有的、这里少写一个 → `Record<PomLocatorKind, true>` **缺键**，tsc 报错；
 * - 这里多写一个联合类型里没有的 → **多余属性**，tsc 也报错。
 *
 * 这样 S3 的下拉与任何新代码都只能从这一份清单取，不必也没有第二份手写数组。
 */
const KIND_MEMBERS: Record<PomLocatorKind, true> = {
  css: true, xpath: true, text: true, role: true, pw: true,
  label: true, placeholder: true, alttext: true, title: true, testid: true,
};

describe('[A0-1] parity：清单 ↔ 联合类型逐项一致、顺序稳定', () => {
  it('Object.keys(联合类型全量) 与 POM_LOCATOR_KINDS 的 id 序列逐项相等', () => {
    expect(Object.keys(KIND_MEMBERS)).toEqual(POM_LOCATOR_KINDS.map((k) => k.id));
    expect(Object.keys(KIND_MEMBERS)).toHaveLength(10);
  });

  it('顺序稳定：连续两次读到的 id 序列相同（不是 Set/Map 的偶然顺序）', () => {
    const a = POM_LOCATOR_KINDS.map((k) => k.id);
    const b = [...POM_LOCATOR_KINDS].map((k) => k.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe('css');
    expect(a[9]).toBe('testid');
  });
});

/* ================================================================
   [A0-2] 逐 kind 的 Java 表达式（9 个非 pw 分支 + pw 单列）
   ================================================================ */

describe('[A0-2] 10 种 kind 的 Java 表达式逐字正确', () => {
  it('css → page.locator("<loc>")', () => {
    expect(srcOf([{ name: 'Row', locator: '#row', kind: 'css' }])).toContain('return page.locator("#row");');
  });

  it('xpath → page.locator("xpath=<loc>")（前缀由生成器加，库里不带）', () => {
    expect(srcOf([{ name: 'Cell', locator: '//table/tr[1]', kind: 'xpath' }]))
      .toContain('return page.locator("xpath=//table/tr[1]");');
  });

  it('text → page.getByText("<loc>")', () => {
    expect(srcOf([{ name: 'All', locator: '全部', kind: 'text' }])).toContain('return page.getByText("全部");');
  });

  it('role → page.getByRole(AriaRole.X, new Page.GetByRoleOptions().setName("<roleName>"))', () => {
    const src = srcOf([{ name: '登录按钮', methodName: 'loginButton', locator: 'button', kind: 'role', roleName: '登录' }]);
    expect(src).toContain('return page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"));');
    expect(src).toContain('import com.microsoft.playwright.options.AriaRole;');
  });

  it('role 没给 roleName → 退回元素名当可访问名（既有语义不变）', () => {
    const src = srcOf([{ name: 'Login', locator: 'button', kind: 'role' }]);
    expect(src).toContain('new Page.GetByRoleOptions().setName("Login")');
  });

  it('label → page.getByLabel("<loc>")（不带 setName、不带 options）', () => {
    const src = srcOf([{ name: '用户名', methodName: 'usernameLabel', locator: '用户名', kind: 'label' }]);
    expect(src).toContain('return page.getByLabel("用户名");');
    expect(src).not.toContain('setName');
  });

  it('placeholder → page.getByPlaceholder("<loc>")', () => {
    const src = srcOf([{ name: '账号框', methodName: 'accountInput', locator: '请输入账号', kind: 'placeholder' }]);
    expect(src).toContain('return page.getByPlaceholder("请输入账号");');
    expect(src).not.toContain('setName');
  });

  it('alttext → page.getByAltText("<loc>")', () => {
    const src = srcOf([{ name: '头像', methodName: 'avatar', locator: '用户头像', kind: 'alttext' }]);
    expect(src).toContain('return page.getByAltText("用户头像");');
    expect(src).not.toContain('setName');
  });

  it('title → page.getByTitle("<loc>")', () => {
    const src = srcOf([{ name: '提示', methodName: 'tip', locator: '鼠标悬停提示', kind: 'title' }]);
    expect(src).toContain('return page.getByTitle("鼠标悬停提示");');
    expect(src).not.toContain('setName');
  });

  it('testid → page.getByTestId("<loc>")', () => {
    const src = srcOf([{ name: 'SubmitBtn', methodName: 'submitBtn', locator: 'submit', kind: 'testid' }]);
    expect(src).toContain('return page.getByTestId("submit");');
    expect(src).not.toContain('setName');
  });

  it('pw → 机械改写成 Java 链（既有行为不变）', () => {
    const src = srcOf([{ name: 'Filter', methodName: 'filtered', locator: "page.getByRole('listitem').filter({ hasText: '审核' })", kind: 'pw' }]);
    expect(src).toContain('return page.getByRole(AriaRole.LISTITEM).filter(new Locator.FilterOptions().setHasText("审核"));');
  });

  it('5 种新 kind 生成物里不出现 AriaRole（它们不需要角色枚举）', () => {
    const src = srcOf([
      { name: 'A', methodName: 'a1', locator: '用户名', kind: 'label' },
      { name: 'B', methodName: 'b1', locator: '请输入', kind: 'placeholder' },
      { name: 'C', methodName: 'c1', locator: '头像', kind: 'alttext' },
      { name: 'D', methodName: 'd1', locator: '提示', kind: 'title' },
      { name: 'E', methodName: 'e1', locator: 'submit', kind: 'testid' },
    ]);
    expect(src).not.toContain('AriaRole');
    expect(src).not.toContain('import com.microsoft.playwright.options.AriaRole;');
  });
});

/* ================================================================
   [A1-1]/[A1-2] AriaRole 映射与兜底
   ================================================================ */

describe('[A1-1] AriaRole 命名 = 大写 + 删分隔符（不是插下划线）', () => {
  it('内置角色表 ≥ 80 项，且 82 项逐项自反（清单内每个都能映射到自己）', () => {
    expect(ROLE_KEYS.length).toBeGreaterThanOrEqual(80);
    for (const key of ROLE_KEYS) {
      const src = srcOf([{ name: 'X', methodName: 'x', locator: key.toLowerCase(), kind: 'role', roleName: 'n' }]);
      expect(src).toContain(`AriaRole.${key}`);
    }
  });

  it('menuitem → AriaRole.MENUITEM、alertdialog → AriaRole.ALERTDIALOG（删分隔符，不插下划线）', () => {
    const src = srcOf([
      { name: 'A', methodName: 'a1', locator: 'menuitem', kind: 'role', roleName: '菜单项' },
      { name: 'B', methodName: 'b1', locator: 'alertdialog', kind: 'role', roleName: '警告框' },
    ]);
    expect(src).toContain('AriaRole.MENUITEM,');
    expect(src).toContain('AriaRole.ALERTDIALOG,');
    expect(src).not.toContain('MENU_ITEM');
    expect(src).not.toContain('ALERT_DIALOG');
  });

  it('分隔符写法归一：`menu item checkbox` / `menu-item-checkbox` → MENUITEMCHECKBOX', () => {
    for (const raw of ['menu item checkbox', 'menu-item-checkbox', 'Menu_Item_Checkbox']) {
      const src = srcOf([{ name: 'X', methodName: 'x', locator: raw, kind: 'role', roleName: 'n' }]);
      expect(src).toContain('AriaRole.MENUITEMCHECKBOX');
    }
  });
});

describe('[A1-2] 认不出的角色：兜底 page.locator("role=<role>") + warning（不用 valueOf）', () => {
  it('未知角色 → role= 兜底、ok:true、不抛、不含 AriaRole', () => {
    const r = generatePageObject(inputOf([{ name: '怪角色', locator: 'fancy-widget', kind: 'role', roleName: '怪' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    expect(src).toContain('return page.locator("role=fancy-widget");');
    expect(src).not.toContain('AriaRole');
    expect(src).not.toContain('valueOf');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toBe('role 无法映射到 AriaRole：fancy-widget，已用 page.locator("role=fancy-widget") 兜底');
  });

  it('空 role（历史脏数据）→ 同一兜底分支，不另造文案', () => {
    const r = generatePageObject(inputOf([{ name: '空角色', locator: '', kind: 'role', roleName: '' }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('return page.locator("role=");');
    expect(r.warnings.join('\n')).toContain('role 无法映射到 AriaRole：，已用 page.locator("role=") 兜底');
  });

  it('未知角色与已知角色混排 → 只有未知那条告警，import 仍按已知角色出现', () => {
    const r = generatePageObject(inputOf([
      { name: 'A', methodName: 'a1', locator: 'button', kind: 'role', roleName: '登录' },
      { name: 'B', methodName: 'b1', locator: 'fancy-widget', kind: 'role', roleName: '怪' },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(1);
    expect(r.files[0].content).toContain('AriaRole.BUTTON');
    expect(r.files[0].content).toContain('page.locator("role=fancy-widget")');
  });
});

/* ================================================================
   [A0-3] 老数据 / 脏 kind 兜底
   ================================================================ */

describe('[A0-3] 脏 kind 一律按 css 生成并压告警（三种脏值各一条）', () => {
  /** [AR-8] 告警里显示的「原值」：空 / 只有空白 → 固定文案 `（空）`，绝不出现 `undefined` */
  const dirty: Array<[string, string | undefined, string]> = [
    ['无 kind（undefined）', undefined, '（空）'],
    ['空串', '', '（空）'],
    ['大写 CSS', 'CSS', 'CSS'],
    ['未知值 foo', 'foo', 'foo'],
  ];

  for (const [label, rawKind, shown] of dirty) {
    it(`${label} → return page.locator("#a") 且告警里有原始值`, () => {
      const el = { name: 'Legacy', locator: '#a', kind: rawKind as PomLocatorKind };
      const r = generatePageObject(inputOf([el]));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.files[0].content).toContain('return page.locator("#a");');
      const joined = r.warnings.join('\n');
      expect(joined).toContain(`未知的元素类型：${shown}，已按 css 处理`);
      // AR-8：空 kind 不许把 `undefined` 拼进用户可见的告警
      expect(joined).not.toContain('undefined');
    });
  }

  it('正常 kind 不产生「未知的元素类型」告警（不误报）', () => {
    const w = warningsOf([{ name: 'Row', locator: '#row', kind: 'css' }]);
    expect(w.join('\n')).not.toContain('未知的元素类型');
  });

  it('normalizeLocatorKind：清单内原样、脏值/大小写/空串一律 css', () => {
    expect(normalizeLocatorKind(undefined)).toBe('css');
    expect(normalizeLocatorKind(null)).toBe('css');
    expect(normalizeLocatorKind(' CSS ')).toBe('css');
    expect(normalizeLocatorKind('bogus')).toBe('css');
    expect(normalizeLocatorKind(42)).toBe('css');
    expect(normalizeLocatorKind({})).toBe('css');
    expect(normalizeLocatorKind('label')).toBe('label');
    expect(normalizeLocatorKind('TestId')).toBe('testid');
  });
});

/* ================================================================
   golden：[A1-6] 既有 3 份零改动；本批只新增 3 份（role+name / label / testid）
   ================================================================ */

interface GoldenCase { name: string; elements: PomElement[]; over?: Partial<PageObjectInput> }

const NEW_GOLDEN: GoldenCase[] = [
  {
    name: 'pom-role-name',
    elements: [{ name: '登录按钮', methodName: 'loginButton', locator: 'button', kind: 'role', roleName: '登录' }],
    over: { className: 'RoleNamePage', baseUrl: 'https://role.example.com/login', pageName: '角色样例页' },
  },
  {
    name: 'pom-label',
    elements: [{ name: '用户名标签', methodName: 'usernameLabel', locator: '用户名', kind: 'label' }],
    over: { className: 'LabelPage', baseUrl: 'https://label.example.com/form', pageName: 'label 样例页' },
  },
  {
    name: 'pom-testid',
    elements: [{ name: '提交按钮', methodName: 'submitBtn', locator: 'submit', kind: 'testid' }],
    over: { className: 'TestIdPage', baseUrl: 'https://testid.example.com/form', pageName: 'testid 样例页' },
  },
];

describe('[A1-6] 新增 3 份 golden：role+name / label / testid 逐字节通过', () => {
  for (const c of NEW_GOLDEN) {
    it(`${c.name} 零差异`, () => {
      const r = generatePageObject(inputOf(c.elements, c.over));
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      const actual = r.files[0].content.replace(/\r\n/g, '\n');
      const file = path.join(GOLDEN_DIR, `${c.name}.java`);
      if (UPDATE) {
        fs.mkdirSync(GOLDEN_DIR, { recursive: true });
        fs.writeFileSync(file, actual, 'utf8');
      }
      const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      expect(actual).toBe(expected);
    });
  }

  it('golden 目录里既有 3 份仍在（本批不许删既有 golden）', () => {
    for (const f of ['pom-login-page.java', 'pom-admin-table.java', 'pom-escape-backslash.java']) {
      expect(fs.existsSync(path.join(GOLDEN_DIR, f))).toBe(true);
    }
  });
});

/* ================================================================
   [C-102] 文件规范（normalizeJava 的四条约束）
   ================================================================ */

describe('[C-102] 生成物：LF、末尾恰好一个换行、行尾无空格、无 BOM', () => {
  it('四条约束逐条成立（含 5 种新 kind 的混合页）', () => {
    const src = srcOf([
      { name: 'A', methodName: 'a1', locator: '用户名', kind: 'label' },
      { name: 'B', methodName: 'b1', locator: 'submit', kind: 'testid' },
      { name: 'C', methodName: 'c1', locator: 'button', kind: 'role', roleName: '登录' },
    ]);
    expect(src).not.toContain('\r');
    expect(src.startsWith('\n')).toBe(false);
    expect(src.endsWith('\n')).toBe(true);
    expect(src.endsWith('\n\n')).toBe(false);
    expect(src.charCodeAt(0)).not.toBe(0xfeff);
    expect(src.split('\n').every((line) => line === line.replace(/[ \t]+$/, ''))).toBe(true);
  });
});
