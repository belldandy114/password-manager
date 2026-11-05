import { describe, it, expect } from 'vitest';
import { detectUnit, parseTimestamp, formatDuration, buildTimeline, timelineToText } from '../../utils/timeParse';

describe('detectUnit', () => {
  it('10 位=秒 / 13 位=毫秒 / 16 位=微秒 / 19 位=纳秒', () => {
    expect(detectUnit('1700000000')).toBe('s');
    expect(detectUnit('1700000000000')).toBe('ms');
    expect(detectUnit('1700000000000000')).toBe('us');
    expect(detectUnit('1700000000000000000')).toBe('ns');
  });
});

describe('parseTimestamp', () => {
  it('秒级时间戳按本地时区还原', () => {
    const r = parseTimestamp('1700000000');
    expect(r.ok).toBe(true);
    expect(r.unit).toBe('s');
    expect(r.ms).toBe(1700000000000);
    expect(r.iso).toBe('2023-11-14T22:13:20.000Z');
  });

  it('毫秒级同值不差 1000 倍', () => {
    expect(parseTimestamp('1700000000000').ms).toBe(1700000000000);
  });

  it('微秒/纳秒换算正确', () => {
    expect(parseTimestamp('1700000000000000').ms).toBe(1700000000000);
    expect(parseTimestamp('1700000000000000000').ms).toBe(1700000000000);
  });

  it('可手动指定单位', () => {
    expect(parseTimestamp('1700000000', 'ms').ms).toBe(1700000000);
  });

  it('日期字符串能反查时间戳', () => {
    const r = parseTimestamp('2026-11-02 14:07:59');
    expect(r.ok).toBe(true);
    expect(typeof r.ms).toBe('number');
  });

  it('垃圾输入报错', () => {
    expect(parseTimestamp('哈哈').ok).toBe(false);
  });
});

describe('formatDuration', () => {
  it('低于 1 秒给毫秒', () => {
    expect(formatDuration(350)).toBe('350 毫秒');
  });

  it('分级显示天/时/分/秒', () => {
    expect(formatDuration(1000)).toBe('1 秒');
    expect(formatDuration(61_000)).toBe('1 分 1 秒');
    expect(formatDuration(3_661_000)).toBe('1 小时 1 分 1 秒');
    expect(formatDuration(90_061_000)).toBe('1 天 1 小时 1 分 1 秒');
  });

  it('负值带 -', () => {
    expect(formatDuration(-2000)).toBe('-2 秒');
  });
});

describe('buildTimeline', () => {
  it('算出行间隔与累计偏移', () => {
    const { rows } = buildTimeline('1700000000000\n1700000005000\n1700000030000');
    expect(rows).toHaveLength(3);
    expect(rows[0].delta).toBe(0);
    expect(rows[1].delta).toBe(5000);
    expect(rows[2].delta).toBe(25000);
    expect(rows[2].offset).toBe(30000);
  });

  it('坏行不影响其它行', () => {
    const { rows } = buildTimeline('1700000000000\n看不懂\n1700000002000');
    expect(rows[1].error).toBeTruthy();
    expect(rows[2].offset).toBe(2000);
  });

  it('空输入报错', () => {
    expect(buildTimeline('  ').error).toBeTruthy();
  });
});

describe('timelineToText', () => {
  it('包含总耗时行', () => {
    const { rows } = buildTimeline('1700000000000\n1700000060000');
    const txt = timelineToText(rows);
    expect(txt).toContain('距上一行 1 分');
    expect(txt).toContain('总耗时：1 分');
  });
});