import { describe, it, expect } from 'vitest';
import { weekRange, weekOptions, compareWeeks, weekStats, buildGroupMessage } from '../weeklyDraft';
import type { ZentaoBug } from '../../types';

const bug = (over: Partial<ZentaoBug>): ZentaoBug => ({
  id: '1', title: 't', status: 'active', severity: '3', productName: 'P', ...over,
} as ZentaoBug);

describe('weeklyDraft.weekRange 方向', () => {
  it('offset 越大越早（0=本周，1=上周，2=两周前）', () => {
    const w0 = weekRange(0);
    const w1 = weekRange(1);
    const w2 = weekRange(2);
    expect(w1.start < w0.start).toBe(true);
    expect(w1.end < w0.start).toBe(true);
    expect(w2.start < w1.start).toBe(true);
  });

  it('一周恰好 7 天，周一开头、周日结尾', () => {
    const { start, end } = weekRange(1);
    const s = new Date(`${start}T00:00:00`);
    const e = new Date(`${end}T00:00:00`);
    expect(s.getDay()).toBe(1); // 周一
    expect(e.getDay()).toBe(0); // 周日
    expect(Math.round((e.getTime() - s.getTime()) / 86400000)).toBe(6);
  });
});

describe('weeklyDraft.weekOptions 下拉映射', () => {
  it('第一项是本周，第二项是上周，且上周必须早于本周', () => {
    const list = weekOptions(9);
    expect(list).toHaveLength(9);
    expect(list[0].label).toBe('本周');
    expect(list[0].offset).toBe(0);
    expect(list[1].label).toBe('上周');
    expect(list[1].offset).toBe(1);
    expect(list[1].end < list[0].start).toBe(true);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].start < list[i - 1].start).toBe(true);
    }
    expect(list[2].label).toBe('2 周前');
  });

  it('每项的日期与 weekRange 一致', () => {
    for (const o of weekOptions(3)) {
      expect(o.start).toBe(weekRange(o.offset).start);
      expect(o.end).toBe(weekRange(o.offset).end);
    }
  });
});

describe('weeklyDraft.compareWeeks 对比的是「前一周」而不是下一周', () => {
  it('prev 一定早于 cur（下拉选上周时曾算成下周，就是这里反了）', () => {
    const r = compareWeeks([], 0);
    expect(r.prev.end < r.cur.start).toBe(true);
    // 差 7 天：上周日 + 1 天 = 本周一
    const gap = Math.round((new Date(`${r.cur.start}T00:00:00`).getTime() - new Date(`${r.prev.end}T00:00:00`).getTime()) / 86400000);
    expect(gap).toBe(1);
  });

  it('任一 offset 都成立（1=上周，则对比前两周）', () => {
    for (const off of [0, 1, 2, 5]) {
      const r = compareWeeks([], off);
      expect(r.cur.start).toBe(weekRange(off).start);
      expect(r.prev.start).toBe(weekRange(off + 1).start);
      expect(r.prev.end < r.cur.start).toBe(true);
    }
  });

  it('各周的缺陷计入对应的桶，不会串周', () => {
    const cur = weekRange(0);
    const prev = weekRange(1);
    const bugs = [
      bug({ id: 'c1', date: `${cur.start} 10:00:00` }),
      bug({ id: 'p1', date: `${prev.start} 10:00:00` }),
      bug({ id: 'p2', date: `${prev.start} 11:00:00`, status: 'closed', closedDate: `${prev.end} 09:00:00` }),
    ];
    const r = compareWeeks(bugs, 0);
    expect(r.cur.created).toBe(1);
    expect(r.prev.created).toBe(2);
    expect(r.prev.closed).toBe(1);
    expect(r.cur.closed).toBe(0);
  });
});

describe('weeklyDraft.weekStats / buildGroupMessage', () => {
  it('未关闭只算非 closed，致命/严重单独计数', () => {
    const w = weekRange(0);
    const s = weekStats([
      bug({ id: 'a', status: 'active', severity: '1' }),
      bug({ id: 'b', status: 'resolved', severity: '2' }),
      bug({ id: 'c', status: 'closed', severity: '1' }),
    ], w.start, w.end);
    expect(s.unclosed).toBe(2);
    expect(s.fatal).toBe(1);
    expect(s.serious).toBe(1);
  });

  it('群消息里日期是 MM.DD 且带四项数字', () => {
    const w = weekRange(0);
    const msg = buildGroupMessage([bug({ id: 'a', date: `${w.start} 09:00:00` })], w.start, w.end);
    expect(msg).toContain(`${w.start.slice(5).replace('-', '.')}-${w.end.slice(5).replace('-', '.')}`);
    expect(msg).toMatch(/新提 1/);
    expect(msg).toMatch(/未关闭：\d+/);
  });
});