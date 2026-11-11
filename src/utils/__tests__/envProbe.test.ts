import { describe, it, expect } from 'vitest';
import {
  MAX_URLS,
  DEFAULT_TIMEOUT_MS,
  SLOW_MS,
  normalizeProbeUrl,
  clampTimeout,
  runProbes,
  summarizeProbes,
  type ProbeResult,
} from '../../../electron/env-probe.js';

describe('normalizeProbeUrl', () => {
  it('没写协议时补 http://', () => {
    expect(normalizeProbeUrl('192.0.2.10:8080/health')).toBe('http://192.0.2.10:8080/health');
  });

  it('保留 https 与路径、查询串', () => {
    expect(normalizeProbeUrl('https://a.example.com/api/ping?x=1')).toBe('https://a.example.com/api/ping?x=1');
  });

  it('去掉用户多打的斜杠再补协议', () => {
    expect(normalizeProbeUrl('//intranet.local/a')).toBe('http://intranet.local/a');
  });

  it('拒绝非 http(s) 协议', () => {
    expect(normalizeProbeUrl('file:///c:/windows')).toBe('');
    expect(normalizeProbeUrl('javascript:alert(1)')).toBe('');
    expect(normalizeProbeUrl('ftp://a.example.com')).toBe('');
  });

  it('空值与垃圾输入返回空串', () => {
    expect(normalizeProbeUrl('')).toBe('');
    expect(normalizeProbeUrl('   ')).toBe('');
    expect(normalizeProbeUrl(null)).toBe('');
    expect(normalizeProbeUrl('http://')).toBe('');
  });

  it('保留末尾路径的斜杠之外不做多余改写', () => {
    expect(normalizeProbeUrl('example.com/health')).toBe('http://example.com/health');
  });
});

describe('clampTimeout', () => {
  it('低于下限抬到 2s', () => {
    expect(clampTimeout(10)).toBe(2000);
  });

  it('负数按非法值处理，回落默认值', () => {
    expect(clampTimeout(-5)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('高于上限压到 30s', () => {
    expect(clampTimeout(999999)).toBe(30000);
  });

  it('非法值回落默认值', () => {
    expect(clampTimeout('abc')).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(0)).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('合法值四舍五入保留', () => {
    expect(clampTimeout(5000.6)).toBe(5001);
  });
});

describe('runProbes', () => {
  it('结果顺序与入参一致（并发不代表乱序）', async () => {
    const delays: Record<string, number> = { a: 30, b: 5, c: 15 };
    const out = await runProbes(['a', 'b', 'c'], async (url) => {
      await new Promise((r) => setTimeout(r, delays[url]));
      return { ok: true, status: 200, ms: delays[url] };
    });
    expect(out.map((r) => r.url)).toEqual(['a', 'b', 'c']);
  });

  it('并发不超过上限', async () => {
    let live = 0;
    let peak = 0;
    await runProbes(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'], async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return { ok: true, ms: 5 };
    }, { concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('单个探针抛错不影响整批，只记该条失败', async () => {
    const out = await runProbes(['ok', 'bad', 'ok2'], async (url) => {
      if (url === 'bad') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, ms: 3 };
    });
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ url: 'bad', ok: false, error: 'ECONNREFUSED' });
    expect(out[0].ok).toBe(true);
    expect(out[2].ok).toBe(true);
  });

  it('探针返回空对象时补成失败而不是崩溃', async () => {
    const out = await runProbes(['x'], async () => ({}) as Partial<ProbeResult>);
    expect(out[0]).toMatchObject({ url: 'x', ok: false });
    expect(typeof out[0].error).toBe('string');
  });

  it('超过上限的地址被截断', async () => {
    const urls = Array.from({ length: MAX_URLS + 5 }, (_, i) => `h${i}`);
    const out = await runProbes(urls, async () => ({ ok: true, ms: 1 }));
    expect(out).toHaveLength(MAX_URLS);
  });

  it('空输入直接返回空数组', async () => {
    const out = await runProbes([], async () => ({ ok: true, ms: 1 }));
    expect(out).toEqual([]);
  });
});

describe('summarizeProbes', () => {
  const rows: Array<Partial<ProbeResult>> = [
    { url: 'a', ok: true, ms: 100 },
    { url: 'b', ok: true, ms: SLOW_MS + 1 },
    { url: 'c', ok: false, ms: 5000, error: '超时' },
  ];

  it('统计可达 / 失败 / 慢', () => {
    const s = summarizeProbes(rows);
    expect(s.total).toBe(3);
    expect(s.ok).toBe(2);
    expect(s.fail).toBe(1);
    expect(s.slow).toBe(1);
  });

  it('平均耗时只算可达条目', () => {
    const s = summarizeProbes(rows);
    expect(s.avgMs).toBe(Math.round((100 + SLOW_MS + 1) / 2));
  });

  it('最慢地址取可达条目里耗时最长的', () => {
    expect(summarizeProbes(rows).slowest).toBe('b');
  });

  it('空结果不产生 NaN', () => {
    const s = summarizeProbes([]);
    expect(s).toMatchObject({ total: 0, ok: 0, fail: 0, slow: 0, avgMs: 0, slowest: '' });
  });
});