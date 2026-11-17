import { describe, it, expect } from 'vitest';
// @ts-ignore - 纯 JS 模块，无 .d.ts
import { ztPageAll } from '../../../electron/zentao-pager.js';

/** 造一个「按 total 分页、服务端每页只给 perPage 条」的假接口 */
const makeFetcher = (all: any[], serverPageSize: number) => {
  const calls: number[] = [];
  const fetchPage = async (page: number, perPage: number) => {
    calls.push(page);
    // 模拟禅道服务端把 limit 压到 serverPageSize（同源框架默认 20）
    const size = Math.min(perPage, serverPageSize);
    const list = all.slice((page - 1) * size, page * size);
    return { list, total: all.length };
  };
  return { fetchPage, calls };
};

describe('zentao-pager.ztPageAll 禅道分页聚合', () => {
  it('服务端压低 limit 时仍按 total 翻页拉全（拉取不全的核心回归）', async () => {
    const all = Array.from({ length: 55 }, (_, i) => ({ id: i + 1, name: `项目${i + 1}` }));
    const { fetchPage, calls } = makeFetcher(all, 20); // 请求 limit=1000，服务端每页只给 20
    const r = await ztPageAll(fetchPage, { getId: (x: any) => x.id });
    expect(r.items.length).toBe(55);
    expect(r.total).toBe(55);
    expect(r.truncated).toBe(false);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('数据量正好一页时只请求一次', async () => {
    const all = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const { fetchPage, calls } = makeFetcher(all, 100);
    const r = await ztPageAll(fetchPage, { getId: (x: any) => x.id });
    expect(r.items.length).toBe(10);
    expect(calls).toEqual([1]);
  });

  it('按 id 去重：跨页重复条目不会重复计入', async () => {
    const { fetchPage } = makeFetcher([{ id: 1 }, { id: 2 }, { id: 3 }], 2);
    // 第 2 页故意重复返回 id=2、并新增 id=3
    let n = 0;
    const dup = async (page: number) => {
      n++;
      if (n === 1) return { list: [{ id: 1 }, { id: 2 }], total: 3 };
      return { list: [{ id: 2 }, { id: 3 }], total: 3 };
    };
    void fetchPage;
    const r = await ztPageAll(dup, { getId: (x: any) => x.id });
    expect(r.items.map((x: any) => x.id)).toEqual([1, 2, 3]);
  });

  it('服务端忽略 page（整页全是重复）时立即停止，不死循环', async () => {
    let calls = 0;
    const fetchPage = async () => { calls++; return { list: [{ id: 1 }, { id: 2 }], total: 999 }; };
    const r = await ztPageAll(fetchPage, { getId: (x: any) => x.id, maxPages: 10 });
    expect(r.items.length).toBe(2);
    expect(calls).toBe(2); // 第二页无新增 → 停止
  });

  it('撞到 maxPages 仍未拉满时标记 truncated', async () => {
    const { fetchPage } = makeFetcher(Array.from({ length: 1000 }, (_, i) => ({ id: i })), 5);
    const r = await ztPageAll(fetchPage, { getId: (x: any) => x.id, maxPages: 3 });
    expect(r.pages).toBe(3);
    expect(r.items.length).toBe(15);
    expect(r.truncated).toBe(true);
  });

  it('空页立即结束，不虚增页数', async () => {
    let calls = 0;
    const fetchPage = async (page: number) => {
      calls++;
      return page === 1 ? { list: [{ id: 1 }], total: 50 } : { list: [], total: 50 };
    };
    const r = await ztPageAll(fetchPage, { getId: (x: any) => x.id });
    expect(r.items.length).toBe(1);
    expect(calls).toBe(2);
  });

  it('total 缺失时以实际条数为准，不误报 truncated', async () => {
    const fetchPage = async (page: number) => ({
      list: page === 1 ? [{ id: 1 }, { id: 2 }] : [],
      total: 0,
    });
    const r = await ztPageAll(fetchPage, { getId: (x: any) => x.id });
    expect(r.items.length).toBe(2);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('条目无 id 时也能聚合（不提供 getId）', async () => {
    const { fetchPage } = makeFetcher([{ v: 1 }, { v: 2 }, { v: 3 }], 2);
    const r = await ztPageAll(fetchPage, {});
    expect(r.items.length).toBe(3);
  });
});
