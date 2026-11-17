import { describe, it, expect } from 'vitest';
// @ts-ignore - 纯 JS 模块，无 .d.ts
import { buildProbeCandidates, probeByIds } from '../../../electron/zentao-probe.js';

/** 真实环境里的那份产品 id（实测 products 列表只回这 31 个，最大 68，漏了 69） */
const REAL_IDS = [
  4, 49, 30, 43, 27, 33, 47, 62, 63, 64, 41, 65, 38, 66, 15, 34, 17, 35, 36,
  14, 67, 68, 40, 39, 57, 58, 59, 28, 42, 32, 50,
].map(String);

describe('zentao-probe.buildProbeCandidates 候选 id 生成', () => {
  it('空列表不出候选', () => {
    const r = buildProbeCandidates([]);
    expect(r.candidates).toEqual([]);
    expect(r.maxId).toBe(0);
  });

  it('尾部优先：maxId 之后的新 id 排在最前面（漏掉的 69 就在这里）', () => {
    const r = buildProbeCandidates(REAL_IDS);
    expect(r.maxId).toBe(68);
    // 前 30 个是 69..98
    expect(r.candidates.slice(0, 3)).toEqual(['69', '70', '71']);
    expect(r.candidates).toContain('69');
  });

  it('已知 id 不会出现在候选里', () => {
    const r = buildProbeCandidates(REAL_IDS);
    for (const id of REAL_IDS) expect(r.candidates).not.toContain(id);
  });

  it('中间断档也会补进候选', () => {
    const r = buildProbeCandidates(['4', '30']);
    // 5..29 都是断档
    expect(r.candidates).toContain('5');
    expect(r.candidates).toContain('29');
    expect(r.gaps).toBeGreaterThan(20);
  });

  it('候选总数不超过 cap（默认 120）', () => {
    const ids = Array.from({ length: 50 }, (_, i) => String(i * 2 + 1)); // 大量断档
    const r = buildProbeCandidates(ids);
    expect(r.candidates.length).toBeLessThanOrEqual(120);
  });

  it('断档过多时只扫尾部并标 capped（大实例不被拖慢）', () => {
    // 只有 100 和 5000 两个 id → 断档近 5000 个，超过 gapLimit
    const r = buildProbeCandidates(['100', '5000'], { tail: 10 });
    expect(r.capped).toBe(true);
    expect(r.gaps).toBe(-1);
    expect(r.candidates).toEqual(['5001', '5002', '5003', '5004', '5005', '5006', '5007', '5008', '5009', '5010']);
  });

  it('尾部超过 cap 时也要截断', () => {
    const r = buildProbeCandidates(['1'], { tail: 500, cap: 20 });
    expect(r.candidates.length).toBe(20);
    expect(r.candidates[0]).toBe('2');
  });
});

describe('zentao-probe.probeByIds 并发探测', () => {
  /** 只有 69 存在的假禅道：其它 id 一律 404 */
  const makeFetch = (existing: Record<string, any>) => {
    const calls: string[] = [];
    const fetchOne = async (id: string) => {
      calls.push(id);
      if (!(id in existing)) throw new Error('禅道 API 返回 HTTP 404');
      return existing[id];
    };
    return { fetchOne, calls };
  };

  it('只在存在时返回，结果按 id 数字序（回归：69 能被找回来）', async () => {
    const { fetchOne } = makeFetch({ 69: { id: '69', name: '漏掉的项目' } });
    const { found, denied } = await probeByIds(['70', '69', '71'], fetchOne);
    expect(found).toEqual([{ id: '69', name: '漏掉的项目' }]);
    expect(denied).toBe(0);
  });

  it('按数字而不是字符串排序（99 要排在 100 前面）', async () => {
    const { fetchOne } = makeFetch({ 100: { id: '100' }, 99: { id: '99' } });
    const { found } = await probeByIds(['100', '99'], fetchOne);
    expect(found.map((x: any) => x.id)).toEqual(['99', '100']);
  });

  it('403 单独计数：区分「不存在」和「有但无权限」', async () => {
    const fetchOne = async (id: string) => {
      if (id === '69') throw new Error('禅道 API 返回 HTTP 403');
      throw new Error('禅道 API 返回 HTTP 404');
    };
    const { found, denied } = await probeByIds(['69', '70', '71'], fetchOne);
    expect(found).toEqual([]);
    expect(denied).toBe(1);
  });

  it('fetchOne 返回 null 视为不命中，不算失败', async () => {
    let n = 0;
    const { found, denied } = await probeByIds(['1', '2'], async () => { n++; return null; });
    expect(found).toEqual([]);
    expect(denied).toBe(0);
    expect(n).toBe(2);
  });

  it('每个候选只探测一次，不漏不重', async () => {
    const { fetchOne, calls } = makeFetch({});
    await probeByIds(['1', '2', '3', '4', '5', '6', '7'], fetchOne, { concurrency: 3 });
    expect(calls.sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('空候选不发送任何请求', async () => {
    let n = 0;
    const r = await probeByIds([], async () => { n++; return null; });
    expect(n).toBe(0);
    expect(r.found).toEqual([]);
    expect(r.denied).toBe(0);
    expect(r.misses).toEqual([]);
  });

  it('misses 只收「明确返回 null」的 id，抛错的不能算（否则会被缓存成不存在）', async () => {
    const fetchOne = async (id: string) => {
      if (id === '1') return { id: '1' };            // 存在
      if (id === '2') return null;                    // 明确不存在
      if (id === '3') throw new Error('禅道 API 返回 HTTP 404'); // 404 也算确定不存在（由调用方转 null）
      throw new Error('禅道 API 请求超时（30 秒）');   // 网络错误：绝不能写进缓存
    };
    const r = await probeByIds(['1', '2', '3', '4'], fetchOne);
    expect(r.found.map((x: any) => x.id)).toEqual(['1']);
    expect(r.misses).toEqual(['2']);
    expect(r.errors).toEqual(['3', '4']);
  });
});
