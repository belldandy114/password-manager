import { describe, it, expect } from 'vitest';
import { repairJson } from '../jsonRepair';
import { formatHm, formatDateTime, formatRecent } from '../time';

const ok = (input: string) => {
  const r = repairJson(input);
  expect(r.success).toBe(true);
  return r;
};

describe('jsonRepair.repairJson', () => {
  it('本来就是合法 JSON 的，原样解析成功', () => {
    const r = ok('{"a":1}');
    expect(JSON.parse(r.json!)).toEqual({ a: 1 });
  });

  it('去掉尾逗号', () => {
    const r = ok('{"a":1,"b":2,}');
    expect(JSON.parse(r.json!)).toEqual({ a: 1, b: 2 });
  });

  it('单引号转双引号', () => {
    const r = ok("{'a':1}");
    expect(JSON.parse(r.json!)).toEqual({ a: 1 });
  });

  it('无引号的 key 补引号', () => {
    const r = ok('{a:1,b:"x"}');
    expect(JSON.parse(r.json!)).toEqual({ a: 1, b: 'x' });
  });

  it('去掉 // 与 /* */ 注释', () => {
    const r = ok('{\n// 注释\n"a":1 /* 块注释 */\n}');
    expect(JSON.parse(r.json!)).toEqual({ a: 1 });
  });

  it('字符串里的逗号/冒号不能被当成结构符号破坏', () => {
    const r = ok('{"url":"http://a.com/x,1","s":"a:b,}"}');
    expect(JSON.parse(r.json!).url).toBe('http://a.com/x,1');
    expect(JSON.parse(r.json!).s).toBe('a:b,}');
  });

  it('括号没闭合时会补齐', () => {
    const r = ok('{"a":[1,2');
    expect(JSON.parse(r.json!)).toEqual({ a: [1, 2] });
  });

  it('完全不是 JSON 时给出可读的错误而不是抛异常', () => {
    const r = repairJson('@@@');
    expect(typeof r.success).toBe('boolean');
    if (!r.success) {
      expect(r.error?.type).toBeTruthy();
      expect(typeof r.error?.message).toBe('string');
    }
  });

  it('关掉单个修复项时不做那一种修复（选项要真的生效）', () => {
    const r = repairJson("{'a':1}", { fixSingleQuote: false });
    // 不允许修单引号时，结果要么失败，要么保留原样（不能偷偷换成双引号）
    if (r.success) expect(r.json).toContain("'a'");
  });
});

describe('time 格式化（北京时间，不是 UTC）', () => {
  it('formatHm 取本地时分，别用 iso.slice 拿 UTC', () => {
    // 2026-01-05T03:20:00Z = 北京时间 11:20
    const iso = '2026-01-05T03:20:00.000Z';
    expect(formatHm(iso)).toBe('11:20');
  });

  it('formatDateTime 带日期与时分', () => {
    const iso = '2026-01-05T03:20:00.000Z';
    expect(formatDateTime(iso)).toBe('2026-01-05 11:20');
  });

  it('空值返回空串，不抛异常', () => {
    expect(formatHm('')).toBe('');
    expect(formatHm(null)).toBe('');
    expect(formatHm(undefined)).toBe('');
    expect(formatDateTime('')).toBe('');
    expect(formatRecent('')).toBe('');
  });

  it('formatRecent：当天只显示 HH:mm，往日补上 MM-DD', () => {
    const now = Date.now();
    // 当天（用本地 00:30 避免跨日边界抖动）
    const today = new Date();
    today.setHours(0, 30, 0, 0);
    expect(formatRecent(today.toISOString())).toMatch(/^\d{2}:\d{2}$/);
    // 三天前 → MM-DD HH:mm
    const old = new Date(now - 3 * 24 * 3600 * 1000);
    expect(formatRecent(old.toISOString())).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法时间字符串不炸', () => {
    expect(() => formatHm('not-a-date')).not.toThrow();
  });
});