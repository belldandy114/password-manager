import { describe, it, expect } from 'vitest';

import { KINDS, validatePage, normalizePageKinds, cleanPageForWrite, blankPage, trimPagesForWrite, type PomPage, type PomElementRow } from './pomModel';
import { POM_LOCATOR_KINDS } from '../../utils/codegen/pageobject';
import { COLLECTION_CAPS, trimToCaps } from '../../utils/collectionTrim';

/**
 * `trimPagesForWrite` 单测（契约 [C-24]/[C-25] 的第 5 个集合 `pomPages`）。
 *
 * 这条测试守的是一个**会吃掉用户操作结果**的坑：元素库是「改一个元素就整表写回」，
 * 而裁剪按时间从最旧丢。用户打开一个很早建的页面改个定位器、保存 —— 如果照常排，
 * 这条（`updatedAt` 还是旧的）正好是最旧的，保存后当场被清掉。
 * 所以要证明：**刚保存的那条一定还在**，被丢的是别人。
 */

const page = (id: string, updatedAt: string, name = id): PomPage => ({
  id,
  name,
  baseUrl: 'https://example.com',
  className: '',
  elements: [],
  note: '',
  updatedAt,
});

/** 造 n 条，时间递增（第 0 条最旧） */
const makePages = (n: number): PomPage[] =>
  Array.from({ length: n }, (_, i) => page(`p${i}`, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));

const CAP = COLLECTION_CAPS.pomPages.maxItems as number;

describe('trimPagesForWrite：没超限时不动', () => {
  it('页面数在上限内 → items 原样、dropped=0、notice 为空', () => {
    const pages = makePages(3);
    const plan = trimPagesForWrite(pages, 'p1');
    expect(plan.dropped).toBe(0);
    expect(plan.notice).toBe('');
    expect(plan.items.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('trimPagesForWrite：超限时裁最旧', () => {
  it('上限 +1 条（没有 keepId）→ 丢掉最旧那条', () => {
    const pages = makePages(CAP + 1);
    const plan = trimPagesForWrite(pages);
    expect(plan.dropped).toBe(1);
    expect(plan.items).toHaveLength(CAP);
    expect(plan.items.some((p) => p.id === 'p0')).toBe(false); // p0 最旧
    expect(plan.items.some((p) => p.id === `p${CAP}`)).toBe(true);
  });

  it('超上限时给出提示文案（含「已按上限裁剪…最早 N 条」与上限值）', () => {
    const plan = trimPagesForWrite(makePages(CAP + 2));
    expect(plan.dropped).toBe(2);
    expect(plan.notice).toContain('页面数已达上限');
    expect(plan.notice).toContain(String(CAP));
    expect(plan.notice).toContain('最早 2 条已清理'); // trimNotice 的原文
    expect(plan.notice).toContain('刚保存的页面不会被裁掉');
  });
});

describe('trimPagesForWrite：刚编辑的最旧条目必须保留（本命题目）', () => {
  it('编辑的是全表最旧的一条 → 它仍在，被丢的是别的（次旧）那条', () => {
    const pages = makePages(CAP + 1); // p0 最旧，pCAP 最新
    // 模拟「打开 p0（很早建的）改了个定位器并保存」：内容变了，但若调用方没刷新时间，
    // 它的 updatedAt 仍是全表最旧 —— 正是危险场景。
    const editedOldest = { ...pages[0], elements: [{ name: '登录按钮', locator: 'button', kind: 'role' as const, role: '登录' }] };
    const next = [editedOldest, ...pages.slice(1)];

    const plan = trimPagesForWrite(next, editedOldest.id);
    expect(plan.dropped).toBe(1);
    expect(plan.items.some((p) => p.id === editedOldest.id)).toBe(true);       // 刚编辑的还在
    expect(plan.items.find((p) => p.id === editedOldest.id)?.elements).toHaveLength(1); // 内容也是新的
    expect(plan.items.some((p) => p.id === 'p1')).toBe(false);                  // 被丢的是次旧那条
    expect(plan.items).toHaveLength(CAP);
  });

  it('对照组：同样的输入但不传 keepId → 最旧那条（被编辑的那条）会被丢掉', () => {
    const pages = makePages(CAP + 1);
    const editedOldest = { ...pages[0], name: '改过名的最旧页' };
    const next = [editedOldest, ...pages.slice(1)];

    const withoutPin = trimPagesForWrite(next);
    expect(withoutPin.items.some((p) => p.id === editedOldest.id)).toBe(false); // 说明「钉住」是必要的

    const withPin = trimPagesForWrite(next, editedOldest.id);
    expect(withPin.items.some((p) => p.id === editedOldest.id)).toBe(true);
  });

  it('keepId 指向不在数组里的条目时不报错、也不影响正常裁剪', () => {
    const plan = trimPagesForWrite(makePages(CAP + 1), 'not-exist');
    expect(plan.dropped).toBe(1);
    expect(plan.items).toHaveLength(CAP);
    expect(plan.items.some((p) => p.id === 'p0')).toBe(false);
  });

  it('新建（keepId 是刚加进数组头的那条）也会被保留', () => {
    const pages = makePages(CAP);
    const fresh = page('new', '2020-01-01T00:00:00.000Z'); // 故意给一个很早的时间
    const plan = trimPagesForWrite([fresh, ...pages], 'new');
    expect(plan.items.some((p) => p.id === 'new')).toBe(true);
    expect(plan.items).toHaveLength(CAP);
    expect(plan.dropped).toBe(1);
  });
});

describe('trimPagesForWrite：不改数据、不改 trimToCaps 行为', () => {
  it('入参数组不被原地修改', () => {
    const pages = makePages(CAP + 1);
    const snapshot = JSON.parse(JSON.stringify(pages));
    trimPagesForWrite(pages, 'p0');
    expect(pages).toEqual(snapshot);
  });

  it('钉住只影响排序，不篡改被保存条目的 updatedAt', () => {
    const pages = makePages(CAP + 1);
    const plan = trimPagesForWrite(pages, 'p0');
    const kept = plan.items.find((p) => p.id === 'p0');
    expect(kept?.updatedAt).toBe(pages[0].updatedAt); // 时间戳一个字没改
  });

  it('与直接调 trimToCaps 的结果在「无 keepId」时完全一致（没有偷偷改口径）', () => {
    const pages = makePages(CAP + 3);
    const direct = trimToCaps(pages, COLLECTION_CAPS.pomPages, { timeOf: (p) => p.updatedAt });
    const plan = trimPagesForWrite(pages);
    expect(plan.items.map((p) => p.id)).toEqual(direct.items.map((p) => p.id));
    expect(plan.dropped).toBe(direct.dropped);
  });

  it('blankPage 生成的页面能被正常裁（id 唯一、有 updatedAt）', () => {
    const pages = [...makePages(CAP), blankPage()];
    const plan = trimPagesForWrite(pages, pages[pages.length - 1].id);
    expect(plan.items).toHaveLength(CAP);
    expect(plan.dropped).toBe(1);
  });
});
/* ================================================================
   1.37.0（S3 / [A0-8]）：10 种定位方式的编辑态与校验
   ================================================================ */

/** 造一个只含 1 个元素的页面（baseUrl 合法，好让校验走到元素那一段） */
const pageWith = (el: Partial<PomElementRow>): PomPage => ({
  id: 'pg-1',
  name: '登录页',
  baseUrl: 'https://example.com/login',
  className: '',
  elements: [{ id: 'el-1', name: '用户名', locator: '#user', kind: 'css', ...el }],
  note: '',
  updatedAt: '2026-11-28T00:00:00.000Z',
});

describe('KINDS：单一下拉清单（不得留第二份手写数组）', () => {
  it('10 项，且与 POM_LOCATOR_KINDS 逐项同序（含 pw）', () => {
    expect(KINDS).toHaveLength(10);
    expect(KINDS.map((k) => k.id)).toEqual(POM_LOCATOR_KINDS.map((k) => k.id));
    expect(KINDS.map((k) => k.label)).toEqual(POM_LOCATOR_KINDS.map((k) => k.label));
    expect(KINDS.map((k) => k.id)).toContain('pw');
  });

  it('清单里每个 id 都唯一（重复会渲染出两个同值 option）', () => {
    expect(new Set(KINDS.map((k) => k.id)).size).toBe(KINDS.length);
  });
});

describe('validatePage：10 种 kind 都能保存（新增 5 种不被拦）', () => {
  const samples: Record<string, Partial<PomElementRow>> = {
    css: { locator: '#user' },
    xpath: { locator: '//input[@id="user"]' },
    text: { locator: '用户名' },
    role: { locator: 'textbox', role: '用户名' },
    pw: { locator: "page.getByRole('textbox', { name: '用户名' })" },
    label: { locator: '用户名' },
    placeholder: { locator: '请输入用户名' },
    alttext: { locator: '公司 Logo' },
    title: { locator: '悬停提示' },
    testid: { locator: 'login-user' },
  };

  it('10 种各存一次都通过（返回 null）', () => {
    for (const id of KINDS.map((k) => k.id)) {
      const el = samples[id];
      expect(el, `缺少 ${id} 的样本`).toBeTruthy();
      expect(validatePage(pageWith(el), []), `kind=${id} 被拦了`).toBeNull();
    }
  });

  it('全量清单覆盖：samples 的键与 KINDS 的 id 完全一致（新增 kind 必须同步样本）', () => {
    expect(Object.keys(samples).sort()).toEqual(KINDS.map((k) => k.id).sort());
  });
});

describe('validatePage：脏 kind 与 xpath 前缀', () => {
  it('老记录没有 kind（undefined）→ 当 css，能保存（[A0-3] ②）', () => {
    const page = pageWith({ locator: '#user' });
    // 模拟历史数据：字段缺失（TS 侧用 as 绕过，运行期就是 undefined）
    (page.elements[0] as { kind?: unknown }).kind = undefined;
    expect(validatePage(page, [])).toBeNull();
  });

  it('` CSS ` / `bogus` 都归一成 css，不被判「类型无效」', () => {
    for (const dirty of [' CSS ', 'bogus', '']) {
      const page = pageWith({ locator: '#user' });
      (page.elements[0] as { kind?: unknown }).kind = dirty;
      expect(validatePage(page, []), `kind=${JSON.stringify(dirty)}`).toBeNull();
    }
  });

  it('xpath 带 xpath= 前缀 → 逐字文案（[A0-4]）', () => {
    expect(validatePage(pageWith({ kind: 'xpath', locator: 'xpath=//div[@id="app"]' }), []))
      .toBe('第 1 个元素：xpath 类型不要再写 xpath= 前缀（生成器会加）');
  });

  it('role 缺可访问名 → 既有固定文案（一个字都不改）', () => {
    expect(validatePage(pageWith({ kind: 'role', locator: 'textbox', role: '  ' }), []))
      .toBe('role 定位器必须填写 role 名称');
  });

  it('role 可访问名超过 40 字 → 元素级文案', () => {
    expect(validatePage(pageWith({ kind: 'role', locator: 'textbox', role: 'x'.repeat(41) }), []))
      .toBe('第 1 个元素：role 名称最多 40 个字符');
  });
});

describe('normalizePageKinds：读库投影把整页 kind 归一', () => {
  it('脏值 / 缺失一律变 css，其它字段原样', () => {
    const page: PomPage = {
      ...pageWith({}),
      elements: [
        { id: 'a', name: '一', locator: '#a', kind: ' CSS ' as never, role: '保留' },
        { id: 'b', name: '二', locator: '//b', kind: undefined as never },
        { id: 'c', name: '三', locator: '//c', kind: 'xpath' },
      ],
    };
    const out = normalizePageKinds(page);
    expect(out.elements.map((e) => e.kind)).toEqual(['css', 'css', 'xpath']);
    expect(out.elements[0].role).toBe('保留');
    expect(out.elements[2].locator).toBe('//c');
  });

  it('不改入参（纯函数；草稿是 React state，原地改会漏渲染）', () => {
    const page = pageWith({});
    const snapshot = JSON.parse(JSON.stringify(page));
    normalizePageKinds(page);
    expect(page).toEqual(snapshot);
  });
});

describe('cleanPageForWrite：10 种 kind 存得进、读得回（重开应用逐字段相等）', () => {
  /** 模拟一次「保存 → 落盘 → 重开读回」：白名单归一 + JSON 序列化往返（vault 是 JSON） */
  const roundTrip = (page: PomPage): PomPage => JSON.parse(JSON.stringify(cleanPageForWrite(page)));

  it('10 种 kind 保存后一个都不丢，读回与保存前逐字段相等', () => {
    const rows: PomElementRow[] = [
      { id: 'k1', name: 'css', locator: '#a', kind: 'css' },
      { id: 'k2', name: 'xpath', locator: '//b', kind: 'xpath' },
      { id: 'k3', name: 'text', locator: '登录', kind: 'text' },
      { id: 'k4', name: 'role', locator: 'button', kind: 'role', role: '登录' },
      { id: 'k5', name: 'pw', locator: "page.getByText('登录')", kind: 'pw' },
      { id: 'k6', name: 'label', locator: '用户名', kind: 'label' },
      { id: 'k7', name: 'placeholder', locator: '请输入', kind: 'placeholder' },
      { id: 'k8', name: 'alttext', locator: 'Logo', kind: 'alttext' },
      { id: 'k9', name: 'title', locator: '提示', kind: 'title' },
      { id: 'k10', name: 'testid', locator: 'login-submit', kind: 'testid' },
    ];
    const page: PomPage = { ...pageWith({}), elements: rows };
    expect(validatePage(page, [])).toBeNull(); // 先确认 10 种都过写端校验

    const back = roundTrip(page);
    expect(back.elements.map((e) => e.kind)).toEqual(rows.map((e) => e.kind));
    expect(back.elements.map((e) => e.locator)).toEqual(rows.map((e) => e.locator));
    // 只有 role 带 role 字段，其余不该凭空多出（[A0-2]：不给其它 kind 开第二字段）
    expect(back.elements.filter((e) => e.role !== undefined).map((e) => e.id)).toEqual(['k4']);
  });
});
/* ================================================================
   t26（review-arch AR-7）：`cleanPageForWrite` 写端归一 kind
   ================================================================ */

describe('AR-7：脏 kind 在写端就被归一（不落库原样脏值）', () => {
  it('三种脏值保存后落库值都是 css', () => {
    for (const dirty of ['CSS', 'foo', '']) {
      const page = pageWith({ locator: '#user' });
      (page.elements[0] as { kind?: unknown }).kind = dirty;
      const saved = cleanPageForWrite(page);
      expect(saved.elements[0].kind, `kind=${JSON.stringify(dirty)}`).toBe('css');
    }
  });

  it('大小写 + 两端空白也归一（` CSS ` → css），合法值不动', () => {
    for (const [dirty, want] of [[' CSS ', 'css'], ['Xpath', 'xpath'], ['testid', 'testid']] as const) {
      const page = pageWith({ locator: '#user' });
      (page.elements[0] as { kind?: unknown }).kind = dirty;
      expect(cleanPageForWrite(page).elements[0].kind).toBe(want);
    }
  });

  it('`role` 仍按**原值**判断是否带 role 字段（归一不会把脏值变成 role）', () => {
    const dirtyRole = pageWith({ locator: 'button', role: '  提交  ' });
    (dirtyRole.elements[0] as { kind?: unknown }).kind = 'role';
    const savedRole = cleanPageForWrite(dirtyRole).elements[0];
    expect(savedRole.kind).toBe('role');
    expect(savedRole.role).toBe('提交'); // 顺带锁 role 的 trim（与本函数既有口径一致）

    const dirtyCss = pageWith({ locator: '#user', role: '提交' });
    (dirtyCss.elements[0] as { kind?: unknown }).kind = 'CSS';
    const savedCss = cleanPageForWrite(dirtyCss).elements[0];
    expect(savedCss.kind).toBe('css');
    expect(savedCss.role).toBeUndefined(); // 非 role 不带第二字段（[A0-2]）
  });
});

describe('AR-7：归一不丢字段（保存 → reload 逐字段相等）', () => {
  it('白名单里的每个字段都还在，且脏 kind 被写成 css', () => {
    const full = pageWith({
      locator: '#user',
      role: ' 提交 ', // 非 role 行，这个字段会被白名单丢掉（既有口径，见 [A0-2]）
      source: 'paste',
      hitCount: 0, // 0 是有效值，不能用真值判断丢掉
      checkedAt: '2026-11-28T02:03:04.000Z',
      note: '备注原样保留',
    });
    (full.elements[0] as { kind?: unknown }).kind = 'CSS'; // 脏值

    const saved = cleanPageForWrite(full);
    const el = saved.elements[0];
    expect(el.id).toBe('el-1');
    expect(el.name).toBe('用户名');
    expect(el.locator).toBe('#user');
    expect(el.kind).toBe('css');
    expect(el.source).toBe('paste');
    expect(el.hitCount).toBe(0);
    expect(el.checkedAt).toBe('2026-11-28T02:03:04.000Z');
    expect(el.note).toBe('备注原样保留');

    // reload：vault 是 JSON，序列化往返后逐字段相等（除 updatedAt 由函数生成）
    const reloaded = JSON.parse(JSON.stringify(saved));
    const { updatedAt: _a, ...savedRest } = saved;
    const { updatedAt: _b, ...reloadedRest } = reloaded;
    expect(reloadedRest).toEqual(savedRest);
  });

  it('历史元素缺 id 时补一个新的（[C-110] ② 既有口径不回退）', () => {
    const page = pageWith({});
    (page.elements[0] as { id?: unknown }).id = undefined;
    const saved = cleanPageForWrite(page).elements[0];
    expect(typeof saved.id).toBe('string');
    expect(String(saved.id).length).toBeGreaterThan(0);
  });
});
