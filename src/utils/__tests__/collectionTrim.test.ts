import { describe, it, expect } from 'vitest';

import {
  trimToCaps,
  bytesOfArray,
  byteLenOf,
  capsOf,
  trimNotice,
  COLLECTION_CAPS,
} from '../collectionTrim';

/**
 * 集合上限裁剪的单测（契约 [C-24] / [C-25]）。
 *
 * 为什么这些用例值得单独写：**裁剪写错的代价是「数据静默消失」**——
 * 丢的如果是新数据（而不是最旧的），用户在历史页只会觉得"刚才那次记录怎么没了"。
 * 所以这里逐条锁死：丢的是最旧、dropped 数对得上、入参数组不被改、上限为 0 的语义。
 */

interface Row {
  id: string;
  at: string;
  text?: string;
}

const row = (n: number, text = 'x'): Row => ({
  id: `r${n}`,
  // 越大的 n 越新
  at: `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`,
  ...(text ? { text } : {}),
});

describe('trimToCaps：什么都不超时不动', () => {
  it('未超条数、未超字节 → 原样返回，dropped=0，且元素顺序不变', () => {
    const items = [row(1), row(2), row(3)];
    const r = trimToCaps(items, { maxItems: 10, maxBytes: 1024 * 1024 });
    expect(r.dropped).toBe(0);
    expect(r.items).toEqual(items);
    expect(r.items.map((x) => x.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('不给任何上限 → 不裁剪（只保证返回新数组）', () => {
    const items = [row(1), row(2)];
    const r = trimToCaps(items, {});
    expect(r.dropped).toBe(0);
    expect(r.items).toEqual(items);
    expect(r.items).not.toBe(items); // 新数组，调用方可以放心改
  });
});

describe('trimToCaps：按条数上限裁最旧', () => {
  it('超过条数上限 → 丢掉最旧的那几条，保留最新的', () => {
    const items = [row(5), row(1), row(3), row(2), row(4)]; // 故意乱序
    const r = trimToCaps(items, { maxItems: 3 });
    expect(r.dropped).toBe(2);
    // 最旧的是 r1、r2；保留的应是 r3/r4/r5，且保持原有相对顺序
    expect(r.items.map((x) => x.id)).toEqual(['r5', 'r3', 'r4']);
  });

  it('时间取不到时按数组顺序（前面的更旧）', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const r = trimToCaps(items, { maxItems: 2 });
    expect(r.dropped).toBe(1);
    expect(r.items.map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('上限为 0 → 全部丢掉（不是"不限制"）', () => {
    const r = trimToCaps([row(1), row(2)], { maxItems: 0 });
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(2);
  });

  it('空数组 → dropped=0、items=[]', () => {
    const r = trimToCaps([], { maxItems: 5, maxBytes: 10 });
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(0);
  });
});

describe('trimToCaps：按字节上限裁最旧', () => {
  it('超过字节上限 → 从最旧丢到不超过为止', () => {
    const items = [row(1, 'a'.repeat(100)), row(2, 'b'.repeat(100)), row(3, 'c'.repeat(100))];
    const oneHundredChars = bytesOfArray([row(1, 'a'.repeat(100))]);
    // 只允许装下两条
    const r = trimToCaps(items, { maxBytes: oneHundredChars * 2 });
    expect(r.dropped).toBe(1);
    expect(r.items.map((x) => x.id)).toEqual(['r2', 'r3']);
    expect(bytesOfArray(r.items)).toBeLessThanOrEqual(oneHundredChars * 2);
  });

  it('条数与字节上限同时给 → 两个都要满足', () => {
    const items = [row(1, 'a'.repeat(80)), row(2, 'b'.repeat(80)), row(3, 'c'.repeat(80))];
    const r = trimToCaps(items, { maxItems: 2, maxBytes: bytesOfArray([row(1, 'a'.repeat(80))]) });
    // 条数先裁到 2 条，字节再裁到 1 条 → 只剩最新的 r3
    expect(r.items.map((x) => x.id)).toEqual(['r3']);
    expect(r.dropped).toBe(2);
  });

  it('单条就超上限 → 默认保留它（丢掉会让集合神秘清空），并如实返回 dropped', () => {
    const items = [row(1, 'a'.repeat(500)), row(2, 'b'.repeat(500))];
    const r = trimToCaps(items, { maxBytes: 50 });
    // 只剩 1 条「不可再裁」，且留下的是最新的那条
    expect(r.items.map((x) => x.id)).toEqual(['r2']);
    expect(r.dropped).toBe(1);
    expect(bytesOfArray(r.items)).toBeGreaterThan(50); // 已知会超，属不可再裁
  });

  it("singleOverflow:'drop' 时连最后一条也丢（上限为 0 的极端口径）", () => {
    const items = [row(1, 'a'.repeat(500))];
    const r = trimToCaps(items, { maxBytes: 10 }, { singleOverflow: 'drop' });
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});

describe('trimToCaps：dropped 计数与原数组安全', () => {
  it('dropped 与实际被丢条数一致（两者上限都触发时也对）', () => {
    const items = Array.from({ length: 10 }, (_, i) => row(i + 1, 'z'.repeat(50)));
    const r = trimToCaps(items, { maxItems: 6, maxBytes: bytesOfArray(items.slice(0, 3)) });
    expect(r.items.length + r.dropped).toBe(items.length);
    expect(r.dropped).toBe(10 - r.items.length);
    // 保留的必须是最新的那几条
    const keptIds = r.items.map((x) => x.id);
    expect(keptIds).toContain('r10');
  });

  it('原数组不被原地修改', () => {
    const items = [row(3), row(1), row(2)];
    const snapshot = JSON.parse(JSON.stringify(items));
    trimToCaps(items, { maxItems: 1 });
    expect(items).toEqual(snapshot);
    expect(items).toHaveLength(3);
  });

  it('幂等：对结果再裁一次不会再丢', () => {
    const items = [row(1), row(2), row(3), row(4)];
    const once = trimToCaps(items, { maxItems: 2 });
    const twice = trimToCaps(once.items, { maxItems: 2 });
    expect(twice.dropped).toBe(0);
    expect(twice.items).toEqual(once.items);
  });

  it('自定义 timeOf：按 updatedAt 而不是 at 排新旧', () => {
    const items = [
      { id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'b', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const r = trimToCaps(items, { maxItems: 1 }, { timeOf: (x) => x.updatedAt });
    expect(r.items.map((x) => x.id)).toEqual(['a']); // 丢 b（更旧）
  });
});

describe('字节口径（[C-24]：JSON.stringify 的 UTF-8 长度，不是字符数）', () => {
  it('中文按 3 字节算', () => {
    expect(byteLenOf('中文')).toBe(8); // JSON.stringify("中文") = "\"中文\"" = 2 + 6
    expect('中文'.length).toBe(2); // 若按 .length 就低估了
  });

  it('数组字节 = 2 + 各项之和 + 逗号数', () => {
    const a = { id: 'x' };
    expect(bytesOfArray([])).toBe(2);
    expect(bytesOfArray([a])).toBe(2 + byteLenOf(a));
    expect(bytesOfArray([a, a])).toBe(2 + byteLenOf(a) * 2 + 1);
  });
});

describe('集合上限常量与提示文案', () => {
  it('5 个集合的常量与契约 C-24 一致', () => {
    expect(COLLECTION_CAPS.caseMaps.maxItems).toBe(20000);
    expect(COLLECTION_CAPS.caseMaps.maxBytes).toBe(1536 * 1024);
    expect(COLLECTION_CAPS.scanRuns).toMatchObject({ maxItems: 20, maxBytes: 1536 * 1024 });
    expect(COLLECTION_CAPS.coverageRuns).toMatchObject({ maxItems: 20, maxBytes: 1536 * 1024 });
    expect(COLLECTION_CAPS.pomPages).toMatchObject({ maxItems: 200, maxBytes: 512 * 1024 });
    expect(COLLECTION_CAPS.allureRuns).toMatchObject({ maxItems: 20, maxBytes: 1024 * 1024 });
    // 未知键回落到保守值，不返回 undefined（否则调用方 trimToCaps(items, undefined) 会裁 0 条）
    expect(capsOf('notAKey').maxBytes).toBeGreaterThan(0);
  });

  it('trimNotice 用 [C-25] 的原话，dropped=0 时返回空串（不提示就别提示）', () => {
    expect(trimNotice(0)).toBe('');
    expect(trimNotice(3)).toBe('历史记录已按上限裁剪，最早 3 条已清理');
  });
});