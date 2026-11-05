import { describe, it, expect } from 'vitest';
import { generateIds, idsToText } from '../../utils/idGen';

const fixedRandom = () => {
  let i = 0;
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05];
  return () => seq[i++ % seq.length];
};

describe('generateIds', () => {
  it('uuid 形如 v4 且唯一', () => {
    const rows = generateIds({ kind: 'uuid', count: 5 });
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(rows.map((r) => r.value)).size).toBe(5);
  });

  it('trace 默认 32 位十六进制', () => {
    const r = generateIds({ kind: 'trace', count: 1 })[0];
    expect(r.value).toMatch(/^[0-9a-f]{32}$/);
  });

  it('hex 长度可配置 + 前缀', () => {
    const r = generateIds({ kind: 'hex', length: 6, prefix: 'pm-', count: 1 })[0];
    expect(r.value).toMatch(/^pm-[0-9a-f]{6}$/);
  });

  it('seq 按宽度补零并可指定起始', () => {
    const rows = generateIds({ kind: 'seq', length: 5, start: 98, count: 3 });
    expect(rows.map((r) => r.value)).toEqual(['00098', '00099', '00100']);
  });

  it('order 以时间戳开头', () => {
    const when = new Date(2026, 10, 2, 14, 7, 59).getTime();
    const r = generateIds({ kind: 'order', count: 1, now: when, random: fixedRandom() })[0];
    expect(r.value.startsWith('20261102140759')).toBe(true);
    expect(r.value).toHaveLength(18);
  });

  it('snowflake 是递增的十进制数字串', () => {
    const rows = generateIds({ kind: 'snowflake', count: 3, now: 1_700_000_000_000 });
    const nums = rows.map((r) => BigInt(r.value));
    expect(nums[0] < nums[1] && nums[1] < nums[2]).toBe(true);
    expect(String(rows[0].value)).toMatch(/^\d{15,20}$/);
  });

  it('count 夹在 1..500 之间', () => {
    expect(generateIds({ kind: 'hex', count: 0 })).toHaveLength(1);
    expect(generateIds({ kind: 'hex', count: 9999 })).toHaveLength(500);
  });

  it('随机源可注入（可重复）', () => {
    const a = generateIds({ kind: 'uuid', count: 1, random: fixedRandom() })[0].value;
    const b = generateIds({ kind: 'uuid', count: 1, random: fixedRandom() })[0].value;
    expect(a).toBe(b);
  });
});

describe('idsToText', () => {
  it('每行一个', () => {
    expect(idsToText([{ value: 'a' }, { value: 'b' }])).toBe('a\nb');
  });
});