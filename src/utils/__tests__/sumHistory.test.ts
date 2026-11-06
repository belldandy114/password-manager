// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readHistory, pushHistory, prevOf, clearHistory, type SumSnapshot } from '../sumHistory';

const snap = (day: string, at: string, total: number): SumSnapshot => ({
  key: 'project-58', at, day, total, fixed: 0, active: total, resolved: 0, closed: 0, security: 0,
});

describe('汇总历史快照', () => {
  beforeEach(() => clearHistory());

  it('初始为空，清空后仍为空', () => {
    expect(readHistory()).toEqual([]);
    clearHistory();
    expect(readHistory()).toEqual([]);
  });

  it('同一 key + 同一统计日重跑覆盖当天记录', () => {
    pushHistory(snap('2026-11-05', '2026-11-05 09:00', 10));
    const list = pushHistory(snap('2026-11-05', '2026-11-05 15:00', 12));
    expect(list).toHaveLength(1);
    expect(list[0].total).toBe(12);
  });

  it('prevOf 取上一个不同统计日的最近一条', () => {
    pushHistory(snap('2026-11-04', '2026-11-04 09:00', 8));
    pushHistory(snap('2026-11-05', '2026-11-05 09:00', 10));
    expect(prevOf('project-58', '2026-11-06')?.total).toBe(10);
    expect(prevOf('project-58', '2026-11-05')?.total).toBe(8);
    expect(prevOf('other', '2026-11-06')).toBeNull();
  });
});
