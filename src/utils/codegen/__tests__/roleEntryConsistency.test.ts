/**
 * role 的**单一入口**与 roleName 口径一致性（review-arch AR-1 / AR-4 / AR-8，契约 [A1-2]）。
 *
 * ## 为什么要专门一个文件
 * `kind='role'` 与 `kind='pw'`（链里带 `getByRole`）是两条不同的生成路径，但它们必须**共用同一个** role
 * 解析入口 `ariaRoleExpr`。t6 评审发现两条路径曾经分叉：
 * - `kind=role` → 未知角色降级 `page.locator("role=x")` + 1 条告警；
 * - `kind=pw` 链 → 未知角色直接 `fail()` → 整链降级 css/`body`。
 * 同一个角色名，换个 kind 就换了行为，用户看到的是「一个能跑、一个直接不算」。
 *
 * 本文件的每条用例都**同时走两条路径**（只测一侧等于没测），断言：
 * 产物表达式逐字相同、告警文案逐字相同、条数相同、`ok` 都是 true（不抛、不 fail）。
 *
 * ⚠️ 与 [A1-4] 的关系：契约 [A1-4] 原文写「pw 链规则⑥ 保持整链降级（`[Z-2]` 的兜底不适用链内）」，
 * 该条已被 t24 的任务书覆盖（AR-1 要求两条路径一致）。因此本文件即 [A1-4] 的**新口径**，
 * 待契约 v5 回写勘误；`[Z-2]` 的另一半（不许用 `AriaRole.valueOf`）仍然有效并在此断言。
 */
import { describe, it, expect } from 'vitest';

import { generatePageObject, type PageObjectInput, type PomElement } from '../pageobject';

function inputOf(elements: PomElement[]): PageObjectInput {
  return {
    className: 'RoleEntryPage',
    baseUrl: 'https://role.example.com/login',
    pageName: 'role 单入口页',
    elements,
  };
}

/** 取出生成物里的 `return ...;` 那一行（元素少时只有一条） */
function returnLineOf(elements: PomElement[]): { expr: string; warnings: string[] } {
  const r = generatePageObject(inputOf(elements));
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  const line = r.files[0].content.split('\n').find((l) => l.trim().startsWith('return ')) || '';
  return { expr: line.trim().replace(/^return\s+/, '').replace(/;$/, ''), warnings: r.warnings };
}

/** kind=role 的路径（`locatorExpr` 的 role 分支） */
function viaRoleKind(locator: string, roleName?: string): { expr: string; warnings: string[] } {
  return returnLineOf([{ name: '目标', methodName: 'target', locator, kind: 'role', ...(roleName === undefined ? {} : { roleName }) }]);
}

/** kind=pw 的路径（`pwChainToJava` 规则⑥） */
function viaPwChain(role: string, name?: string): { expr: string; warnings: string[] } {
  const chain = `page.getByRole('${role}'${name === undefined ? '' : `, { name: '${name}' }`})`;
  return returnLineOf([{ name: '目标', methodName: 'target', locator: chain, kind: 'pw' }]);
}

/* ================================================================
   AR-1：同一输入走两条入口 → 产物与告警逐字相同
   ================================================================ */

describe('[AR-1] role 单一入口：kind=role 与 pw 链规则⑥ 行为一致', () => {
  it('已知角色 button / 可访问名 登录 → 两条入口产物逐字相同、无告警', () => {
    const a = viaRoleKind('button', '登录');
    const b = viaPwChain('button', '登录');
    expect(a.expr).toBe('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"))');
    expect(b.expr).toBe(a.expr);
    expect(b.warnings).toEqual(a.warnings);
    expect(a.warnings).toEqual([]);
  });

  it('未知角色 fancy-widget → 两条入口都降级 `page.locator("role=fancy-widget")` + 同一条告警', () => {
    const a = viaRoleKind('fancy-widget', '怪');
    const b = viaPwChain('fancy-widget', '怪');
    expect(a.expr).toBe('page.locator("role=fancy-widget")');
    expect(b.expr).toBe(a.expr);
    // 告警逐字相同、条数相同（pw 链不再额外压一条「映射不上 AriaRole」的 fail 文案）
    expect(b.warnings).toEqual(a.warnings);
    expect(a.warnings).toHaveLength(1);
    expect(a.warnings[0]).toBe('role 无法映射到 AriaRole：fancy-widget，已用 page.locator("role=fancy-widget") 兜底');
    // 不抛、不 fail：仍然是一份可编译的生成物
    expect(a.expr).not.toContain('undefined');
  });

  it('空角色 → 两条入口都降级 `page.locator("role=")` + 同一条告警（不抛）', () => {
    const a = viaRoleKind('', '空');
    const b = viaPwChain('', '空');
    expect(a.expr).toBe('page.locator("role=")');
    expect(b.expr).toBe(a.expr);
    expect(b.warnings).toEqual(a.warnings);
    expect(a.warnings).toHaveLength(1);
  });

  it('另一侧的已知角色（menuitem / 分隔符写法）也一致（不是只对齐了 button 一个样本）', () => {
    for (const role of ['menuitem', 'menu item checkbox', 'alertdialog']) {
      const a = viaRoleKind(role, '甲');
      const b = viaPwChain(role, '甲');
      expect(b.expr).toBe(a.expr);
      expect(b.warnings).toEqual(a.warnings);
    }
  });

  it('pw 链里未知角色不再整链降级（不出现 css 兜底 / body 兜底 / 「转不出」告警）', () => {
    const { expr, warnings } = viaPwChain('fancy-widget', '怪');
    expect(expr).not.toContain('body');
    expect(expr).not.toContain('fallback');
    expect(warnings.join('\n')).not.toContain('转不出');
    expect(warnings.join('\n')).not.toContain('映射不上');
  });

  it('[Z-2] 两条入口都不生成 AriaRole 的 valueOf 形态（未知角色走 role= 字符串兜底）', () => {
    // 判据串在这里拼接：`grep 'AriaRole.valueOf' src/` 的机械门要求**生产代码** 0 命中，
    // 测试里也不留字面量，免得门把断言自己算进去
    const forbidden = ['AriaRole', 'valueOf'].join('.');
    for (const { expr } of [viaRoleKind('fancy-widget', '怪'), viaPwChain('fancy-widget', '怪')]) {
      expect(expr).not.toContain('AriaRole');
      expect(expr).not.toContain(forbidden);
    }
  });
});

/* ================================================================
   AR-4：roleName 一律 trim（两条路径同一口径）
   ================================================================ */

describe('[AR-4] roleName 统一 trim：两条路径都不生成带首尾空格的 setName', () => {
  it('kind=role：roleName `  提交  ` → setName("提交")', () => {
    const { expr } = viaRoleKind('button', '  提交  ');
    expect(expr).toBe('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))');
    expect(expr).not.toContain('"  提交  "');
  });

  it('kind=pw：链里 `{ name: \'  提交  \' }` → setName("提交")', () => {
    const { expr } = viaPwChain('button', '  提交  ');
    expect(expr).toBe('page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))');
    expect(expr).not.toContain('"  提交  "');
  });

  it('两条路径对同一个带空格的可访问名产物逐字相同', () => {
    const a = viaRoleKind('button', '  提交  ');
    const b = viaPwChain('button', '  提交  ');
    expect(b.expr).toBe(a.expr);
  });

  it('roleName 只有空白 → 视为未填，退回元素展示名（不生成 setName("")）', () => {
    const { expr } = viaRoleKind('button', '   ');
    expect(expr).toContain('setName("目标")');
    expect(expr).not.toContain('setName("")');
  });

  it('未给 roleName（历史数据）→ 仍退回元素展示名（既有行为不变）', () => {
    const { expr } = viaRoleKind('button');
    expect(expr).toContain('setName("目标")');
  });
});

/* ================================================================
   AR-8：无 kind 时的告警文案（不得为空值 / 不得出现 undefined）
   ================================================================ */

describe('[AR-8] 无 kind 的告警文案给固定值 `（空）`，不出现 undefined', () => {
  it('kind=undefined → `未知的元素类型：（空），已按 css 处理`', () => {
    const r = generatePageObject(inputOf([{ name: 'Legacy', locator: '#a', kind: undefined as unknown as PomElement['kind'] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain('未知的元素类型：（空），已按 css 处理');
    expect(r.warnings.join('\n')).not.toContain('undefined');
  });

  it("kind='' → 同一条固定文案", () => {
    const r = generatePageObject(inputOf([{ name: 'Legacy', locator: '#a', kind: '' as unknown as PomElement['kind'] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain('未知的元素类型：（空），已按 css 处理');
  });

  it('kind 只有空白 → 同样按空处理（不把空白原样拼进告警）', () => {
    const r = generatePageObject(inputOf([{ name: 'Legacy', locator: '#a', kind: '   ' as unknown as PomElement['kind'] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain('未知的元素类型：（空），已按 css 处理');
  });

  it('非空脏值仍显示实际值（trim 后）：CSS / foo', () => {
    for (const [raw, shown] of [['CSS', 'CSS'], ['  foo  ', 'foo']] as const) {
      const r = generatePageObject(inputOf([{ name: 'Legacy', locator: '#a', kind: raw as unknown as PomElement['kind'] }]));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.warnings.join('\n')).toContain(`未知的元素类型：${shown}，已按 css 处理`);
    }
  });
});
