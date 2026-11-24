import { describe, it, expect } from 'vitest';

import { trimPagesForWrite, blankPage, type PomPage } from './pomModel';
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