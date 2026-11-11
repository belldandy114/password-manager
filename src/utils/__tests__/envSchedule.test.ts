import { describe, it, expect } from 'vitest';
import { diffProbe, toSnap } from '../envSchedule';
import type { EnvProbeResult } from '../../types';

const r = (id: string, ok: boolean, ms: number, error?: string): EnvProbeResult => ({ id, ok, ms, url: `http://${id}`, error });

describe('toSnap', () => {
  it('只留 ok 与 ms，丢掉不存在的条目', () => {
    expect(toSnap({ a: r('a', true, 12) })).toEqual({ a: { ok: true, ms: 12 } });
  });

  it('ms 非法时记 0，不写 NaN', () => {
    expect(toSnap({ a: { id: 'a', ok: true, ms: NaN, url: 'x' } as EnvProbeResult })).toEqual({ a: { ok: true, ms: 0 } });
  });
});

describe('diffProbe', () => {
  const name = (id: string) => `站-${id}`;

  it('可达 → 不可达 算 fail', () => {
    const flips = diffProbe({ a: { ok: true, ms: 100 } }, { a: r('a', false, 0, 'ECONNREFUSED') }, name);
    expect(flips).toHaveLength(1);
    expect(flips[0].kind).toBe('fail');
    expect(flips[0].text).toContain('站-a');
    expect(flips[0].text).toContain('ECONNREFUSED');
  });

  it('不可达 → 可达 算 recover', () => {
    const flips = diffProbe({ a: { ok: false, ms: 0 } }, { a: r('a', true, 88) }, name);
    expect(flips[0].kind).toBe('recover');
  });

  it('耗时翻倍且过 2 秒算 slow', () => {
    const flips = diffProbe({ a: { ok: true, ms: 1500 } }, { a: r('a', true, 3200) }, name);
    expect(flips[0].kind).toBe('slow');
  });

  it('耗时翻倍但没到 2 秒不算变慢（避免 40ms→90ms 也弹通知）', () => {
    expect(diffProbe({ a: { ok: true, ms: 40 } }, { a: r('a', true, 95) }, name)).toHaveLength(0);
  });

  it('都正常且没有明显变化 → 空', () => {
    expect(diffProbe({ a: { ok: true, ms: 100 } }, { a: r('a', true, 120) }, name)).toHaveLength(0);
  });

  it('首次巡检（没有上次快照）不报翻转', () => {
    expect(diffProbe({}, { a: r('a', false, 0) }, name)).toHaveLength(0);
  });

  it('新出现的条目不算翻转', () => {
    expect(diffProbe({ a: { ok: true, ms: 1 } }, { a: r('a', true, 1), b: r('b', false, 0) }, name)).toHaveLength(0);
  });
});
