/**
 * A₁：codegen 三语言（JS / Python / Java）粘贴解析（契约 [A1-8]，`[Z-3]`）。
 *
 * 锁六件事：
 * 1. **三 Target × 9 条矩阵**：每个 Target 的 `getByRole` / `getByText` / `getByLabel` /
 *    `getByPlaceholder` / `getByAltText` / `getByTitle` / `getByTestId` / `locator` / 带过滤的链，
 *    逐条断言 `{ kind, locator, role }`（[A1-8] (2)(3) 两张表）；
 * 2. **Java 反归一**：`AriaRole.MENUITEMCHECKBOX` → `locator === 'menuitemcheckbox'`（小写常量名）；
 * 3. `pw` 只留给真表达不了的链（带 filter/nth/first/last），且三语法的链渲染成**同一行 JS**；
 * 4. D-1 `detect.ts` 特征集：单 kind 脚本 / `page1.` 别名要认，`mypage.locator(` 不许误判；
 * 5. D-2 去重键含 `roleName`：`button[name=登录]` 与 `button[name=取消]` 不得并成一条；
 * 6. D-3 动作切分在**字符串字面量之外**：文本里含 `.click(` 的定位行整行保留。
 *
 * 夹具全部是 Playwright codegen 的**真实输出形态**（定位臂由 `playwright-core` 的
 * `asLocator` 生成、动作后缀取自三个 codegen 生成器的源码；见 t3 方案 §1.3），但以**固定
 * 文本**写进测试，不依赖本机 playwright。
 */
import { describe, it, expect } from 'vitest';

import {
  detectElementPaste, parseBySource, parsePlaywright, parsePlaywrightReport,
  parsePython, parseJava, detectTarget, PASTE_UNKNOWN_REASON,
  type ElementPasteCandidate,
} from '../elementPaste';

/** 三语法的定位行构造器（动作后缀：JS `;` / Python 无分号 / Java `;`） */
const L = {
  js: {
    role: "await page.getByRole('button', { name: '登录' }).click();",
    text: "await page.getByText('全部').click();",
    label: "await page.getByLabel('用户名').click();",
    placeholder: "await page.getByPlaceholder('请输入账号').fill('x');",
    alttext: "await page.getByAltText('头像').click();",
    title: "await page.getByTitle('提示').click();",
    testid: "await page.getByTestId('submit').click();",
    locator: "await page.locator('#row').click();",
    filter: "await page.getByRole('listitem').filter({ hasText: '审核结果' }).click();",
  },
  python: {
    role: 'page.get_by_role("button", name="登录").click()',
    text: 'page.get_by_text("全部").click()',
    label: 'page.get_by_label("用户名").click()',
    placeholder: 'page.get_by_placeholder("请输入账号").fill("x")',
    alttext: 'page.get_by_alt_text("头像").click()',
    title: 'page.get_by_title("提示").click()',
    testid: 'page.get_by_test_id("submit").click()',
    locator: 'page.locator("#row").click()',
    filter: 'page.get_by_role("listitem").filter(has_text="审核结果").click()',
  },
  java: {
    role: 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录")).click();',
    text: 'page.getByText("全部").click();',
    label: 'page.getByLabel("用户名").click();',
    placeholder: 'page.getByPlaceholder("请输入账号").fill("x");',
    alttext: 'page.getByAltText("头像").click();',
    title: 'page.getByTitle("提示").click();',
    testid: 'page.getByTestId("submit").click();',
    locator: 'page.locator("#row").click();',
    filter: 'page.getByRole(AriaRole.LISTITEM).filter(new Locator.FilterOptions().setHasText("审核结果")).click();',
  },
} as const;

type Method = keyof typeof L.js;

/** 每个方法的期望（[A1-8] (3) 表：8 个方法各落具体 kind，只有过滤链落 pw） */
const EXPECT: Record<Method, { kind: string; locator: string; role?: string }> = {
  role: { kind: 'role', locator: 'button', role: '登录' },
  text: { kind: 'text', locator: '全部' },
  label: { kind: 'label', locator: '用户名' },
  placeholder: { kind: 'placeholder', locator: '请输入账号' },
  alttext: { kind: 'alttext', locator: '头像' },
  title: { kind: 'title', locator: '提示' },
  testid: { kind: 'testid', locator: 'submit' },
  locator: { kind: 'css', locator: '#row' },
  filter: { kind: 'pw', locator: "page.getByRole('listitem').filter({ hasText: '审核结果' })" },
};

const METHODS = Object.keys(EXPECT) as Method[];
const TARGETS: Array<{ target: 'js' | 'python' | 'java'; label: string; parse: (text: string) => ElementPasteCandidate[] }> = [
  { target: 'js', label: 'JS', parse: (t) => parsePlaywright(t) },
  { target: 'python', label: 'Python', parse: (t) => parsePython(t) },
  { target: 'java', label: 'Java', parse: (t) => parseJava(t) },
];

/** 一行 → 唯一候选（断言"恰好一条"） */
function one(line: string, parse: (text: string) => ElementPasteCandidate[] = parsePlaywright): ElementPasteCandidate {
  const rows = parse(line);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/* ================================================================
   ① 三 Target × 9 条矩阵（27 条断言）
   ================================================================ */

for (const { target, label, parse } of TARGETS) {
  describe(`[A1-8] ${label} Target：9 条定位行 → 同一个候选`, () => {
    for (const method of METHODS) {
      it(`${method}：kind=${EXPECT[method].kind} / locator=${EXPECT[method].locator}`, () => {
        const row = one(L[target][method], parse);
        expect(row.kind).toBe(EXPECT[method].kind);
        expect(row.locator).toBe(EXPECT[method].locator);
        expect(row.role).toBe(EXPECT[method].role);
        expect(row.source).toBe('playwright-js');
        // Target 只读回显（[A1-8] (4)）：不进 pomPages，只在预览表标一下
        expect(row.target).toBe(target);
        expect(row.reason).toContain('Playwright codegen');
        expect(row.reason.trim().length).toBeGreaterThan(0);
      });
    }
  });
}

/* ================================================================
   ② 三语法的同一元素 → 完全相同的候选（这是矩阵无空格的要害）
   ================================================================ */

describe('[A1-8] 同一个元素三种写法 → 除 target 外逐字段相等', () => {
  it('role 行：JS / Python / Java 产出同一个 {kind, locator, role, confidence}', () => {
    const js = one(L.js.role);
    const py = one(L.python.role);
    const java = one(L.java.role);
    for (const row of [py, java]) {
      expect({ kind: row.kind, locator: row.locator, role: row.role, confidence: row.confidence })
        .toEqual({ kind: js.kind, locator: js.locator, role: js.role, confidence: js.confidence });
    }
  });

  it('filter 链：三语言都渲染成同一行 JS（否则生成不出 Java、点验也标 skip）', () => {
    const js = one(L.js.filter);
    const py = one(L.python.filter);
    const java = one(L.java.filter);
    expect(py.locator).toBe(js.locator);
    expect(java.locator).toBe(js.locator);
    expect(js.locator.startsWith('page.')).toBe(true);
    expect(js.confidence).toBe('guess');
  });
});

/* ================================================================
   ③ Java 反归一 + 角色写法
   ================================================================ */

describe('[A1-8] (1) Java 的 AriaRole 反归一：大写常量 → 小写 ARIA 角色名', () => {
  it('AriaRole.MENUITEMCHECKBOX → locator === "menuitemcheckbox"', () => {
    const rows = parseJava('page.getByRole(AriaRole.MENUITEMCHECKBOX, new Page.GetByRoleOptions().setName("甲")).click();');
    expect(rows).toHaveLength(1);
    expect(rows[0].locator).toBe('menuitemcheckbox');
    expect(rows[0].role).toBe('甲');
    expect(rows[0].kind).toBe('role');
  });

  it('AriaRole.COLUMNHEADER / AriaRole.TEXTBOX → columnheader / textbox（不插分隔符）', () => {
    expect(one('page.getByRole(AriaRole.COLUMNHEADER).click();').locator).toBe('columnheader');
    expect(one('page.getByRole(AriaRole.TEXTBOX, new Page.GetByRoleOptions().setName("用户名")).fill("u");').locator).toBe('textbox');
  });

  it('链上的选项类名按位置取值（Page / Locator / FrameLocator 都认，不许写死 new Page.）', () => {
    const java = one('page.locator("form").getByRole(AriaRole.BUTTON, new Locator.GetByRoleOptions().setName("提交")).first();', parseJava);
    expect(java.kind).toBe('pw');
    expect(java.locator).toBe("page.locator('form').getByRole('button', { name: '提交' }).first()");
    // 元素库的 pw 只留给「带过滤/索引的链」；纯 链式 locator+getByRole 属认不出（计入未识别，可查）
    const noIndex = parsePlaywrightReport('page.locator("form").getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交")).click();');
    expect(noIndex.candidates).toHaveLength(0);
    expect(noIndex.skippedLines).toHaveLength(1);
  });
});

describe('[A1-5] role 要能拆 `button:登录` 与 `role=button` 两种写法', () => {
  it('getByRole("button:登录") → role=button + 可访问名=登录', () => {
    const row = one("await page.getByRole('button:登录').click();");
    expect(row.kind).toBe('role');
    expect(row.locator).toBe('button');
    expect(row.role).toBe('登录');
    expect(row.confidence).toBe('exact');
  });

  it('locator("role=button") → role/button，无量名 → guess', () => {
    const row = one("await page.locator('role=button').click();");
    expect(row.kind).toBe('role');
    expect(row.locator).toBe('button');
    expect(row.role).toBeUndefined();
    expect(row.confidence).toBe('guess');
  });

  it('locator(\'role=button[name="登录"]\') → 角色名 + 可访问名都拆出来', () => {
    const row = one('await page.locator(\'role=button[name="登录"]\').click();');
    expect(row.kind).toBe('role');
    expect(row.locator).toBe('button');
    expect(row.role).toBe('登录');
    expect(row.confidence).toBe('exact');
  });

  it('role= 写法在 Python / Java 的 locator() 里同样成立', () => {
    expect(one('page.locator("role=alertdialog").click()').locator).toBe('alertdialog');
    expect(one('page.locator("role=alertdialog").click();').locator).toBe('alertdialog');
  });
});

/* ================================================================
   ④ 动作行忽略 + 去重
   ================================================================ */

describe('[A1-8] 动作行一律忽略（导入 0 条），且不计入「未识别」', () => {
  /** 「定位 + 动作」：整行只留定位 */
  const LOCATOR_PLUS_ACTION = [
    "await page.click('#submit');",                      // 纯动作（下面的纯动作组）
    "await page.getByRole('button').click();",
    'page.get_by_text("全部").fill("x")',
    'page.getByText("全部").press("Enter");',
    'page.locator("#row").press("Enter");',
    'page.locator("#row").selectOption("x");',
  ].slice(1);

  it('纯动作行（没有定位方法）→ 0 条候选，skippedLines 也为 0', () => {
    const pureActions = [
      "await page.click('#submit');",
      "await page.fill('#user', 'admin');",
      "await page.press('#user', 'Enter');",
      'page.select_option("#sel", "a")',
      'page.fill("#u", "admin")',
      "await page.goto('https://example.com');",
    ];
    for (const line of pureActions) {
      expect(parsePlaywright(line)).toHaveLength(0);
      const report = parsePlaywrightReport(line);
      expect(report.skippedLines).toHaveLength(0);
    }
  });

  it('「定位 + 动作」整行只留定位（动作尾巴被切掉）', () => {
    for (const line of LOCATOR_PLUS_ACTION) {
      const rows = parsePlaywright(line);
      expect(rows).toHaveLength(1);
      expect(rows[0].locator).not.toContain('click');
      expect(rows[0].locator).not.toContain('fill');
      expect(rows[0].locator).not.toContain('press');
      expect(rows[0].locator).not.toContain('selectOption');
    }
  });
});

describe('[D-2] 去重键含 roleName：不同可访问名不是同一个元素', () => {
  it('button[name=登录] 与 button[name=取消] → 2 条（老键会并成 1 条）', () => {
    const rows = parsePlaywright([
      "await page.getByRole('button', { name: '登录' }).click();",
      "await page.getByRole('button', { name: '取消' }).click();",
    ].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role)).toEqual(['登录', '取消']);
  });

  it('同一元素重复粘贴（同语言两行）→ 条数不变（1 条）', () => {
    const rows = parsePlaywright([
      "await page.getByRole('button', { name: '登录' }).click();",
      "await page.getByRole('button', { name: '登录' }).click();",
    ].join('\n'));
    expect(rows).toHaveLength(1);
  });

  it('同一元素跨语言粘三次（JS + Python + Java）→ 1 条（跨语言去重成立）', () => {
    const rows = parsePlaywright([L.js.role, L.python.role, L.java.role].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('role');
  });

  it('文本类按归一化空白去重：`全部` 与 `  全部 ` → 1 条', () => {
    const rows = parsePlaywright([
      "await page.getByText('全部').click();",
      "await page.getByText('  全部 ').click();",
    ].join('\n'));
    expect(rows).toHaveLength(1);
  });

  it('css 不折叠空白（后代选择器语义不同 → 2 条）', () => {
    const rows = parsePlaywright([
      "await page.locator('#a .b').click();",
      "await page.locator('#a  .b').click();",
    ].join('\n'));
    expect(rows).toHaveLength(2);
  });
});

/* ================================================================
   ⑤ D-3：动作切分在字符串字面量之外
   ================================================================ */

describe('[D-3] TAIL_ACTION 不在字符串字面量内误切', () => {
  it('文本里含 `.click(` 的定位行整行保留（老实现会切在字符串中间、静默丢行）', () => {
    const line = "await page.getByText('行内有 .click( 字样').click();";
    const rows = parsePlaywright(line);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('text');
    expect(rows[0].locator).toBe('行内有 .click( 字样');
    expect(rows[0].confidence).toBe('exact');
  });

  it('Java 的 setName 里含 `.fill(` 也不误切', () => {
    const rows = parseJava('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("含 .fill( 的名字")).click();');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('含 .fill( 的名字');
  });

  it('Python 的 name= 里含 `.press(` 也不误切', () => {
    const rows = parsePython('page.get_by_role("button", name="含 .press( 的名字").click()');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('含 .press( 的名字');
  });
});

/* ================================================================
   ⑥ D-1：detect.ts 特征集与负样本
   ================================================================ */

describe('[D-1] detectElementPaste：单 kind 与 page1 别名都要认，mypage 不许误判', () => {
  const POSITIVE: Array<[string, string]> = [
    ['JS 单 kind：getByTestId', "await page.getByTestId('submit').click();"],
    ['JS 单 kind：getByLabel', "await page.getByLabel('用户名').fill('u');"],
    ['JS 单 kind：getByTitle', "await page.getByTitle('提示').click();"],
    ['Python 两行（没有 locator(）', 'page.get_by_role("button", name="登录").click()\npage.get_by_text("全部").click()'],
    ['Python 单 kind：test_id', 'page.get_by_test_id("submit").click()'],
    ['Java 单 kind：getByTestId', 'page.getByTestId("submit").click();'],
    ['Java 单 kind：getByLabel', 'page.getByLabel("用户名").fill("u");'],
    ['Java 只有 AriaRole 行', 'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录")).click();'],
    ['弹窗别名 page1', "await page1.getByText('确定').click();"],
  ];

  for (const [name, text] of POSITIVE) {
    it(`${name} → playwright-js`, () => {
      const r = detectElementPaste(text);
      expect(r.source).toBe('playwright-js');
      expect(r.candidates.length).toBeGreaterThan(0);
      expect(r.skippedLines).toBe(0);
    });
  }

  it('DetectTarget：9 条里 Java/Python/JS 各判对', () => {
    expect(detectTarget('page.getByRole(AriaRole.BUTTON).click();')).toBe('java');
    expect(detectTarget('page.get_by_role("button").click()')).toBe('python');
    expect(detectTarget("await page.getByRole('button').click();")).toBe('js');
    expect(detectTarget('我今天想加一个登录按钮')).toBeNull();
  });

  it('负样本：含 page. 的普通脚本 / 纯自然语言 → 0 候选，不产垃圾行', () => {
    const plain = 'const page = await browser.newPage();\nawait page.setViewportSize({ width: 1, height: 2 });';
    const r1 = detectElementPaste(plain);
    expect(r1.candidates).toEqual([]);
    expect(r1.source).toBeNull();

    const natural = '我今天想加一个登录按钮';
    const r2 = detectElementPaste(natural);
    expect(r2.candidates).toEqual([]);
    expect(r2.reason).toBe(PASTE_UNKNOWN_REASON);
  });

  it('负样本：mypage.locator( 不许被判成 Playwright 脚本（老规则会误判）', () => {
    const text = "const mypage = {}; mypage.locator('x');";
    const r = detectElementPaste(text);
    expect(r.source).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it('html / recorder 的判定顺序不变', () => {
    expect(detectElementPaste('<div id="a">x</div>').source).toBe('html');
    const json = JSON.stringify({ steps: [{ type: 'click', selectors: [['#a']] }] });
    expect(detectElementPaste(json).source).toBe('recorder-json');
  });
});

/* ================================================================
   ⑦ 不静默：认不出的行要计数
   ================================================================ */

describe('[A1-8] (5) 不静默：认不出的行计入 skippedLines，不演成「成功导入 0 条」', () => {
  it('f-string 插值（不是字面量）→ 0 候选 + skippedLines 1', () => {
    const report = parsePlaywrightReport('page.get_by_label(f"用户名{idx}").click()');
    expect(report.candidates).toHaveLength(0);
    expect(report.skippedLines).toHaveLength(1);
  });

  it('iframe 链（元素库不做 iframe 内定位）→ 计数，不硬塞成候选', () => {
    const report = parsePlaywrightReport("page.locator('iframe#if').contentFrame().getByRole('button', { name: '登录' }).click();");
    expect(report.candidates).toHaveLength(0);
    expect(report.skippedLines).toHaveLength(1);
  });

  it('一条认不出 + 两条正常 → 2 候选 + 1 未识别', () => {
    const report = parsePlaywrightReport([
      "await page.getByText('全部').click();",
      'page.get_by_label(varName).click()',
      'page.locator("role=button").click()',
    ].join('\n'));
    expect(report.candidates).toHaveLength(2);
    expect(report.skippedLines).toHaveLength(1);
    expect(report.candidates.every((c) => c.kind !== 'pw')).toBe(true);
  });

  it('detect 的 reason 里带未识别行数（界面照读，不需要自己算）', () => {
    const r = detectElementPaste([
      "await page.getByText('全部').click();",
      'page.get_by_label(varName).click()',
    ].join('\n'));
    expect(r.skippedLines).toBe(1);
    expect(r.reason).toContain('1 行未识别');
  });
});

/* ================================================================
   ⑧ 置信度 / NAME_HINT_MAX / 无 pw 泄漏
   ================================================================ */

describe('[A1-8] 置信度与名字截断', () => {
  it('带 exact 选项 → guess + 说明（元素库按默认子串匹配生成）', () => {
    const js = one("await page.getByLabel('用户名', { exact: true }).click();");
    expect(js.confidence).toBe('guess');
    expect(js.reason).toContain('exact');
    const py = one('page.get_by_label("用户名", exact=True).click()');
    expect(py.confidence).toBe('guess');
    const java = one('page.getByLabel("用户名", new Page.GetByLabelOptions().setExact(true)).click();');
    expect(java.confidence).toBe('guess');
  });

  it('角色带附加选项（level）→ guess（元素库只存 name，可能多命中）', () => {
    const js = one("await page.getByRole('heading', { level: 2 }).click();");
    expect(js.confidence).toBe('guess');
    expect(js.reason).toContain('附加选项');
    expect(one('page.get_by_role("heading", level=2).click()').confidence).toBe('guess');
    expect(one('page.getByRole(AriaRole.HEADING, new Page.GetByRoleOptions().setLevel(2)).click();').confidence).toBe('guess');
  });

  it('只有角色名、没有可访问名 → guess（保存前必须补 role 名称）', () => {
    expect(one("await page.getByRole('button').click();").confidence).toBe('guess');
    expect(one('page.get_by_role("button").click()').confidence).toBe('guess');
  });

  it('结构性 css → guess；id → exact', () => {
    expect(one("await page.locator('#row').click();").confidence).toBe('exact');
    expect(one("await page.locator('.row').click();").confidence).toBe('guess');
    expect(one('page.locator("div.row").click()').confidence).toBe('guess');
  });

  it('xpath：带 id 属性 → exact；纯结构路径 → guess（且不保留 xpath= 前缀）', () => {
    const exact = one('await page.locator(\'xpath=//div[@id="a"]\').click();');
    expect(exact.kind).toBe('xpath');
    expect(exact.locator).toBe('//div[@id="a"]');
    expect(exact.confidence).toBe('exact');
    const guess = one("await page.locator('xpath=/html/body/div[3]/span').click();");
    expect(guess.confidence).toBe('guess');
    expect(guess.locator).toBe('/html/body/div[3]/span');
  });

  it('NAME_HINT_MAX=30：超长文本截 30 字 + 省略号', () => {
    const longText = '登'.repeat(40);
    const row = one(`await page.getByText('${longText}').click();`);
    expect(row.name.length).toBe(31);
    expect(row.name.endsWith('…')).toBe(true);
  });

  it('pw 只留给带过滤/索引的链（矩阵里 8 个方法都不许落 pw）', () => {
    for (const { target } of TARGETS) {
      for (const method of METHODS) {
        if (method === 'filter') continue;
        expect(one(L[target][method]).kind).not.toBe('pw');
      }
    }
  });

  it('parseBySource 手动改选后仍按 Target 解析（HTML 文本 → 0 条）', () => {
    expect(parseBySource('playwright-js', '<div id="a">x</div>')).toEqual([]);
    expect(parseBySource('playwright-js', L.python.role)).toHaveLength(1);
    expect(parseBySource('playwright-js', L.java.role)).toHaveLength(1);
  });
});
