/**
 * review-code 两条的回归钉：C-01（role 的 `exact` 选项必须降 guess）、C-10（`scan.ts` 的 O(n²) 切片）
 * 与「未闭合输入整行计入 skippedLines」的显式断言。
 *
 * ## C-01 为什么必须降 guess
 * `exact` 的唯一判据是「元素库生成的写法与 codegen 原文**语义逐字等价**」。元素库的 `role` 只存
 * `(locator, roleName)`，生成出来是 `getByRole(AriaRole.X, new Page.GetByRoleOptions().setName("…"))`
 * —— 默认匹配（子串 + 忽略大小写）。而原写法带 `exact: true` 时是**精确 + 大小写敏感**，两者不等价。
 * 把这种不确定性报成 `exact` 比「认不出」更坏：用户会以为这条能直接用。
 *
 * ## C-10 为什么钉性能
 * 老实现的每段标识符都用 `src.slice(i)` 切「剩余全文」，一行 N 段链就是 O(n²)。
 * 夹具 `'page' + ".getByText('x')".repeat(20000)`（≈340KB）在旧实现上能卡到秒级。
 * 这里断言 500ms 内返回；谁把它写回切子串，这条会先红。
 */
import { describe, it, expect } from 'vitest';

import {
  parsePlaywright, parsePlaywrightReport, mapChain, skipReasonOf, scanLine,
  type ParsedSegment,
} from '../elementPaste';

/* ================================================================
   C-01：role 的 exact 选项
   ================================================================ */

describe('[C-01] role 带 exact 选项 → guess（不再把不确定性报成 exact）', () => {
  it('带 `exact: true` → guess，reason 说明 exact 语义不同', () => {
    const rows = parsePlaywright("await page.getByRole('button', { name: '登录', exact: true }).click();");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('role');
    expect(rows[0].locator).toBe('button');
    expect(rows[0].role).toBe('登录');
    expect(rows[0].confidence).toBe('guess');
    expect(rows[0].reason).toContain('exact');
    expect(rows[0].reason).toContain('可能多命中');
  });

  it('不带 extra 选项（对照）→ exact，reason 是「语义稳定」', () => {
    const rows = parsePlaywright("await page.getByRole('button', { name: '登录' }).click();");
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe('exact');
    expect(rows[0].reason).toContain('语义稳定');
  });

  it('带其它未支持选项（includeHidden）→ guess，reason 说明附加选项存不下', () => {
    const rows = parsePlaywright("await page.getByRole('button', { name: '登录', includeHidden: true }).click();");
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe('guess');
    expect(rows[0].reason).toContain('附加选项');
  });

  it('三语法同一口径：Python `exact=True` 与 Java `setExact(true)` 也都 guess', () => {
    const py = parsePlaywright('page.get_by_role("button", name="登录", exact=True).click()');
    expect(py).toHaveLength(1);
    expect(py[0].confidence).toBe('guess');
    expect(py[0].reason).toContain('exact');

    const java = parsePlaywright(
      'page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录").setExact(true)).click();',
    );
    expect(java).toHaveLength(1);
    expect(java[0].confidence).toBe('guess');
    expect(java[0].reason).toContain('exact');
  });

  it('exact 只压一档：仍产出候选（不因 exact 变成不认识）', () => {
    const report = parsePlaywrightReport("await page.getByRole('button', { name: '登录', exact: true }).click();");
    expect(report.candidates).toHaveLength(1);
    expect(report.skippedLines).toHaveLength(0);
  });
});

/* ================================================================
   C-10：性能回归（O(n) 扫描）
   ================================================================ */

describe('[C-10] scanLine 是线性扫描：340KB / 20000 段链 500ms 内返回', () => {
  it("`'page' + \".getByText('x')\".repeat(20000)` → 500ms 内返回（贴实测耗时）", () => {
    const huge = `page${".getByText('x')".repeat(20000)}`;
    expect(huge.length).toBeGreaterThan(300_000); // ≈340KB，确定不是小样本

    const t0 = performance.now();
    const scanned = scanLine(huge);
    const report = parsePlaywrightReport(huge);
    const elapsed = performance.now() - t0;

    // 实测耗时打出来（回执要贴原始输出）
    // eslint-disable-next-line no-console
    console.log(`[C-10] 20000 段链（${huge.length} 字节）扫描 + 解析耗时：${elapsed.toFixed(1)}ms`);

    expect(scanned).not.toBeNull();
    expect(scanned!.calls).toHaveLength(20000);
    expect(elapsed).toBeLessThan(500);
    // 多段链本来就表达不了 → 整行计入 skipped（而不是造出一条假候选）
    expect(report.candidates).toHaveLength(0);
    expect(report.skippedLines).toHaveLength(1);
  });

  it('线性性朴证：段数翻倍，耗时不出现量级跳变（同机同轮比值 < 8）', () => {
    const build = (n: number) => `page${".getByText('x')".repeat(n)}`;
    const measure = (n: number) => {
      const text = build(n);
      const t0 = performance.now();
      scanLine(text);
      return performance.now() - t0;
    };
    measure(2000); // 预热
    const one = Math.max(measure(5000), 0.05);
    const two = Math.max(measure(10000), 0.05);
    // O(n²) 会接近 4 倍以上；O(n) 通常 1.2~2.5 倍，给 8 倍宽余量只为不误报抖动
    expect(two / one).toBeLessThan(8);
  });
});

/* ================================================================
   未闭合输入：整行丢弃 + 计入 skippedLines + 带原因
   ================================================================ */

describe('未闭合的引号 / 括号：有界（不死循环）但整行丢弃并计入 skippedLines', () => {
  const UNCLOSED: Array<[string, string]> = [
    ["未闭合单引号：page.getByText('全部", "page.getByText('全部"],
    ['未闭合双引号：page.getByLabel("用户名', 'page.getByLabel("用户名'],
    ['未闭合括号：page.getByRole("button", { name: "登录"', 'page.getByRole("button", { name: "登录"'],
    ['未闭合括号（嵌套）：page.locator("#a"', 'page.locator("#a"'],
  ];

  for (const [label, line] of UNCLOSED) {
    it(`${label} → skippedLines 1 条、带原因、候选里没有半截行`, () => {
      const report = parsePlaywrightReport(line);
      expect(report.candidates).toHaveLength(0);
      expect(report.skippedLines).toHaveLength(1);
      expect(report.skippedLines[0].line).toBe(1);
      expect(report.skippedLines[0].reason).toContain('没闭合');
      expect(report.skippedLines[0].text).toContain('page.');
      // 半截行不许漏进候选
      expect(report.candidates.some((c) => line.includes(c.locator) && c.locator.length > 0)).toBe(false);
    });
  }

  it('未闭合行与正常行混排：正常行照常出候选，未闭合行只计数', () => {
    const report = parsePlaywrightReport([
      "await page.getByText('全部').click();",
      "await page.getByLabel('用户名",
      "await page.getByTestId('submit').click();",
    ].join('\n'));
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates.map((c) => c.kind)).toEqual(['text', 'testid']);
    expect(report.skippedLines).toHaveLength(1);
    expect(report.skippedLines[0].line).toBe(2);
  });

  it('scanLine 本身对未闭合输入是**有界**的（不死循环，返回 unclosed 标记）', () => {
    const scanned = scanLine("page.getByText('x");
    expect(scanned).not.toBeNull();
    expect(scanned!.calls).toHaveLength(1);
    expect(scanned!.calls[0].unclosed).toBe(true);
    // 未闭合后不再往后扫（`.click()` 这类尾巴不会被当成第二段）
    const tail = scanLine("page.getByText('x').click('");
    expect(tail).not.toBeNull();
    expect(tail!.calls.map((c) => c.name)).toEqual(['getByText', 'click']);
    expect(tail!.calls[1].unclosed).toBe(true);
  });
});

/* ================================================================
   skippedLines 现在带原因（review-code：不许静默消失）
   ================================================================ */

describe('skippedLines 每条带行号 + 原文 + 原因（不静默）', () => {
  it('f-string 插值 → 原因指向「不是字符串字面量」', () => {
    const report = parsePlaywrightReport('page.get_by_label(f"用户名{idx}").click()');
    expect(report.skippedLines).toHaveLength(1);
    expect(report.skippedLines[0].reason).toContain('字面量');
    expect(report.skippedLines[0].line).toBe(1);
  });

  it('iframe 链 → 原因指向 iframe / 多候选组合', () => {
    const report = parsePlaywrightReport(
      "page.locator('iframe#if').contentFrame().getByRole('button', { name: '登录' }).click();",
    );
    expect(report.skippedLines).toHaveLength(1);
    expect(report.skippedLines[0].reason).toContain('iframe');
  });

  it('纯动作行 / 非定位行不计入 skippedLines（它们是预期忽略）', () => {
    for (const line of [
      "await page.click('#submit');",
      "await page.goto('https://example.com');",
      'import x from "y";',
      '',
    ]) {
      expect(parsePlaywrightReport(line).skippedLines).toHaveLength(0);
    }
  });

  it('skipReasonOf：每种判空分支都有可读原因（逐条枚举，新增分支必须同步）', () => {
    const cases: Array<[ParsedSegment[], RegExp]> = [
      [[], /没有可用的定位段/],
      // 与 mapChain 同口径：动作段先被切掉，整行只有动作 → 「没有可用的定位段」
      [[{ method: 'click' }], /没有可用的定位段/],
      // 不是动作、也不是定位方法（`page.url()` 这类）
      [[{ method: 'url' }], /首段不是 page 上的定位方法/],
      [[{ method: 'locator', locatorArg: '#a' }, { method: 'frameLocator', locatorArg: '#f' }], /iframe/],
      [[{ method: 'locator', locatorArg: '#a' }, { method: 'getByRole', locatorArg: 'button' }], /元素库表达不了/],
      [[{ method: 'getByText' }], /字面量/],
      [[{ method: 'locator', locatorArg: '#a' }, { method: 'nth' }], /nth/],
      [[{ method: 'getByText', locatorArg: 'x' }, { method: 'filter' }], /filter/],
    ];
    for (const [segments, pattern] of cases) {
      expect(skipReasonOf(segments)).toMatch(pattern);
    }
  });

  it('mapChain 对「多段无索引链」返回 null（与 skipReasonOf 的判空一致）', () => {
    expect(mapChain({ target: 'js', segments: [{ method: 'locator', locatorArg: '#a' }, { method: 'getByRole', locatorArg: 'button' }] }, { source: 'playwright-js' })).toBeNull();
  });
});
