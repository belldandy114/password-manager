/**
 * B6-A：`kind='pw'`（Playwright 链原样存）的 JS → Java 机械改写。
 *
 * 锁两件事：
 * 1. §11.4 的 7 条改写规则**逐条**（转得出的时候）；
 * 2. 转不出的时候**不抛异常**，走既有 `warnings` + css 兜底（无 css 兜底时 `page.locator("body")`，
 *    裁定 Z9），且生成物仍然是合法 Java（`page.locator(` 一定在）。
 *
 * 写测试的顺序说明（TDD）：本文件先于 `pageobject.ts` 的 `case 'pw'` 落地写成，首跑 11 条红。
 */
import { describe, it, expect } from 'vitest';

import { generatePageObject, type PomElement } from '../pageobject';
import { blankElement, cleanPageForWrite, KINDS, validatePage, type PomPage } from '../../../components/codegen/pomModel';

/** 生成一页只有这一条元素的 Java，取出它的定位器表达式（`return` 那一行） */
function exprOf(locator: string, name = '目标'): { expr: string; warnings: string[]; content: string } {
  const r = generatePageObject({
    className: 'PwPage',
    baseUrl: 'https://example.com',
    pageName: 'PW 页',
    elements: [{ name, locator, kind: 'pw' } satisfies PomElement],
  });
  if (!r.ok) throw new Error('生成失败：' + r.error);
  const content = r.files[0].content;
  const line = content.split('\n').find((l) => l.trim().startsWith('return ')) || '';
  return { expr: line.trim().replace(/^return\s+/, '').replace(/;$/, ''), warnings: r.warnings, content };
}

describe('kind=pw：7 条改写规则逐条（§11.4）', () => {
  /* 规则 1：去掉前置 await 与尾部动作 —— 元素库只存定位，不存动作 */
  it('规则①：`await page.locator("#a").click()` → `page.locator("#a")`（await 与 .click() 都去掉）', () => {
    const { expr, warnings } = exprOf('await page.locator("#a").click()');
    expect(expr).toBe('page.locator("#a")');
    // 剥掉动作不算「转不出」，不该有告警
    expect(warnings).toEqual([]);
  });

  it('规则①：`.fill(...)` / `.press(...)` 这类尾动作同样剥掉', () => {
    const { expr } = exprOf('await page.locator("#kw").fill("x");');
    expect(expr).toBe('page.locator("#kw")');
  });

  /* 规则 2：locator("css") → page.locator("css")（独占一条时补 page 前缀） */
  it('规则②：`locator("#a")` → `page.locator("#a")`（缺 page 前缀时补上）', () => {
    const { expr } = exprOf('locator("#a")');
    expect(expr).toBe('page.locator("#a")');
  });

  /* 规则 3：filter({ hasText }) —— 正则去锚点转字符串，并压一条告警 */
  it('规则③：`filter({ hasText: /^全部$/ })` → `.filter(new Locator.FilterOptions().setHasText("全部"))` 且告警说明锚点已去', () => {
    const { expr, warnings } = exprOf('page.locator("#row").filter({ hasText: /^全部$/ })');
    expect(expr).toBe('page.locator("#row").filter(new Locator.FilterOptions().setHasText("全部"))');
    expect(warnings.join('\n')).toContain('正则');
  });

  it('规则③：`hasText` 是字符串时不告警（只在去锚点时才提醒）', () => {
    const { expr, warnings } = exprOf('page.locator("#row").filter({ hasText: "全部" })');
    expect(expr).toBe('page.locator("#row").filter(new Locator.FilterOptions().setHasText("全部"))');
    expect(warnings).toEqual([]);
  });

  /* 规则 4：hasNotText 同名映射 */
  it('规则④：`filter({ hasNotText: "已删除" })` → `.filter(new Locator.FilterOptions().setHasNotText("已删除"))`', () => {
    const { expr } = exprOf('page.locator("#row").filter({ hasNotText: "已删除" })');
    expect(expr).toBe('page.locator("#row").filter(new Locator.FilterOptions().setHasNotText("已删除"))');
  });

  /* 规则 5：getByPlaceholder 同名 */
  it('规则⑤：`getByPlaceholder("请输入账号")` → `.getByPlaceholder("请输入账号")`（方法名同名，补 page 前缀）', () => {
    const { expr, warnings } = exprOf('page.getByPlaceholder("请输入账号")');
    expect(expr).toBe('page.getByPlaceholder("请输入账号")');
    expect(warnings).toEqual([]);
  });

  /* 规则 6：getByRole → AriaRole 枚举 + GetByRoleOptions().setName */
  it('规则⑥：`getByRole(\'button\', { name: \'提交\' })` → `.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))`', () => {
    const { expr } = exprOf("page.getByRole('button', { name: '提交' })");
    expect(expr).toBe('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))');
  });

  /* 规则 7：filter({ has }) / or() / and() / nth() 转不出 → 告警 + css 兜底 */
  it('规则⑦：`filter({ has: ... })` 转不出 → 告警非空，表达式回落到链里的 css', () => {
    const { expr, warnings } = exprOf('page.locator("#row").filter({ has: page.locator("#cell") })');
    expect(expr).toBe('page.locator("#row")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).toContain('转不出');
  });

  it('规则⑦：`.or()` 转不出 → 告警 + css 兜底（`#a` 仍在表达式里）', () => {
    const { expr, warnings } = exprOf('page.locator("#a").or(page.locator("#b"))');
    expect(expr).toBe('page.locator("#a")');
    expect(warnings.join('\n')).toContain('转不出');
  });

  it('规则⑦：`.and()` 与 `.nth(2)` 同样转不出', () => {
    for (const chain of ['page.locator("#a").and(page.locator("#b"))', 'page.locator("#a").nth(2)']) {
      const { expr, warnings } = exprOf(chain);
      expect(expr).toBe('page.locator("#a")');
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  /* Z9：整条链没有 css 兜底 → page.locator("body") + 明确的「请手改」 */
  it('Z9：转不出且链里没有 css → `page.locator("body")` + 告警含「手改」', () => {
    const { expr, warnings, content } = exprOf("page.getByRole('button').or(page.getByText('好'))");
    expect(expr).toBe('page.locator("body")');
    expect(warnings.join('\n')).toContain('手改');
    // 生成物仍可编译：定位器表达式一定是 page.locator(...) 或 getBy*，不是半截 JS
    expect(content).toContain('page.locator("body")');
    expect(content).not.toContain('await ');
  });

  it('转不出一条都不抛：脏链（括号不闭合 / 空串）也只是告警 + 兜底', () => {
    for (const chain of ['page.locator("#a"', '(', '', 'page.']) {
      expect(() => exprOf(chain)).not.toThrow();
      const { warnings } = exprOf(chain);
      expect(warnings.length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================
   pomModel：pw 的 KINDS / 校验 / source 透传（B6-A 的数据层半边）
   ================================================================ */

describe('pomModel：kind=pw 的下拉项与校验（文案逐字定稿见渲染层契约 §6.1）', () => {
  const page = (els: PomPage['elements']): PomPage => ({
    id: 'p1', name: '登录页', baseUrl: 'https://example.com/login',
    className: 'LoginPage', elements: els, updatedAt: '2026-11-27T00:00:00.000Z',
  });

  it('KINDS 含 pw 一项，文案逐字 = `Playwright 链（原样存）`，且原 4 项顺序不变', () => {
    expect(KINDS.map((k) => k.id)).toEqual(['css', 'xpath', 'text', 'role', 'pw']);
    expect(KINDS[4].label).toBe('Playwright 链（原样存）');
  });

  it('pw 链含换行 → 校验文案逐字命中', () => {
    const msg = validatePage(page([{ id: 'el-1', name: '行元素', locator: 'page.locator("#a")\n.click()', kind: 'pw' }]), []);
    expect(msg).toBe('第 1 个元素：Playwright 链不能包含换行或控制字符');
  });

  it('pw 链含控制字符（\\u0007）→ 同一条文案', () => {
    const msg = validatePage(page([{ id: 'el-1', name: '行元素', locator: 'page.locator("#a")\u0007', kind: 'pw' }]), []);
    expect(msg).toBe('第 1 个元素：Playwright 链不能包含换行或控制字符');
  });

  it('pw 链为空 / 超过 500 字符 → 沿用既有两条文案', () => {
    expect(validatePage(page([{ id: 'el-1', name: '空', locator: '   ', kind: 'pw' }]), []))
      .toBe('第 1 个元素：定位器不能为空');
    const long = `page.locator("#${'a'.repeat(500)}")`;
    expect(validatePage(page([{ id: 'el-1', name: '长', locator: long, kind: 'pw' }]), []))
      .toBe('第 1 个元素：定位器最多 500 个字符');
  });

  it('pw 不要求填 role（role 只属 kind=role）', () => {
    expect(validatePage(page([{ id: 'el-1', name: '按钮', locator: "page.getByRole('button')", kind: 'pw' }]), [])).toBeNull();
  });

  it('保存一次后 kind=pw 不被洗掉，且 source 被白名单透传（漏它等于保存一次就洗掉来源）', () => {
    const clean = cleanPageForWrite(page([
      { id: 'el-1', name: '按钮', locator: "page.getByRole('button')", kind: 'pw', source: 'paste' },
      { id: 'el-2', name: '输入框', locator: '#kw', kind: 'css' },
    ]));
    expect(clean.elements[0].kind).toBe('pw');
    expect(clean.elements[0].source).toBe('paste');
    // 没给 source 的历史元素不该被塞一个空字段（那会让白名单出现永远空的键）
    expect(Object.keys(clean.elements[1]).sort()).toEqual(['id', 'kind', 'locator', 'name']);
    // pw 也不该被塞 role
    expect(Object.keys(clean.elements[0]).sort()).toEqual(['id', 'kind', 'locator', 'name', 'source']);
  });

  it('三种 source 都能透传，blankElement() 默认 manual', () => {
    for (const source of ['paste', 'manual', 'recorder'] as const) {
      const clean = cleanPageForWrite(page([{ id: 'el-1', name: 'x', locator: '#a', kind: 'css', source }]));
      expect(clean.elements[0].source).toBe(source);
    }
    expect(blankElement().source).toBe('manual');
  });
});
