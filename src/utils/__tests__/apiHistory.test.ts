import { describe, it, expect } from 'vitest';
import { dayLabel, groupByDay, matchesQuery, filterHistory } from '../apiHistory';
import type { ApiHistoryItem } from '../../types';

const NOW = new Date(2026, 9, 29, 15, 0, 0); // 本地时间 2026-10-29 15:00
const iso = (y: number, m: number, d: number, h = 10, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();

describe('apiHistory.dayLabel 分组标签', () => {
  it('今天 / 昨天 / 同年其他日期 / 跨年', () => {
    expect(dayLabel(iso(2026, 10, 29, 9), NOW)).toEqual({ key: '2026-10-29', label: '今天' });
    expect(dayLabel(iso(2026, 10, 28, 23), NOW)).toEqual({ key: '2026-10-28', label: '昨天' });
    expect(dayLabel(iso(2026, 10, 20), NOW).label).toBe('10 月 20 日');
    expect(dayLabel(iso(2025, 12, 31), NOW)).toEqual({ key: '2025-12-31', label: '2025-12-31' });
  });

  it('跨月的「昨天」也算昨天（月末边界）', () => {
    const monthStart = new Date(2026, 10, 1, 8, 0, 0); // 11-01
    expect(dayLabel(iso(2026, 10, 31, 22), monthStart).label).toBe('昨天');
  });

  it('空值 / 非法时间 → 未知时间，不出现 Invalid Date', () => {
    for (const bad of [undefined, null, '', 'not-a-date']) {
      const r = dayLabel(bad as string | undefined, NOW);
      expect(r.key).toBe('unknown');
      expect(r.label).toBe('未知时间');
    }
  });
});

describe('apiHistory.groupByDay 分组', () => {
  it('相邻同天合并，保持原顺序', () => {
    const list = [
      { at: iso(2026, 10, 29, 14) },
      { at: iso(2026, 10, 29, 9) },
      { at: iso(2026, 10, 28, 20) },
      { at: iso(2026, 10, 1, 8) },
    ];
    const groups = groupByDay(list, NOW);
    expect(groups.map(g => g.label)).toEqual(['今天', '昨天', '10 月 1 日']);
    expect(groups[0].items).toHaveLength(2);
  });

  it('同一日期不相邻时不强行合并（不重排）', () => {
    const list = [{ at: iso(2026, 10, 29) }, { at: iso(2026, 10, 28) }, { at: iso(2026, 10, 29, 8) }];
    const groups = groupByDay(list, NOW);
    expect(groups).toHaveLength(3);
  });

  it('空数组 → 空分组', () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });

  it('坏时间落到「未知时间」组', () => {
    const groups = groupByDay([{ at: 'oops' }, { at: iso(2026, 10, 29) }], NOW);
    expect(groups[0].label).toBe('未知时间');
    expect(groups[1].label).toBe('今天');
  });
});

describe('apiHistory.matchesQuery 搜索', () => {
  it('空关键字全部命中', () => {
    expect(matchesQuery('', 'GET', 'http://a/b')).toBe(true);
    expect(matchesQuery('   ', 'x')).toBe(true);
  });

  it('大小写不敏感，任一字段命中即可', () => {
    expect(matchesQuery('get', 'GET', '/x')).toBe(true);
    expect(matchesQuery('ADMIN', 'POST', 'http://h/admin-api/x')).toBe(true);
    expect(matchesQuery('zzz', 'POST', '/x')).toBe(false);
  });

  it('能搜状态码，也能容忍空字段', () => {
    expect(matchesQuery('400', 'GET', '/x', 400)).toBe(true);
    expect(matchesQuery('a', undefined, null)).toBe(false);
  });
});

describe('apiHistory.filterHistory', () => {
  const mk = (id: string, method: string, url: string, status: number, at: string): ApiHistoryItem =>
    ({ id, method, url, status, at, timeMs: new Date(at).getTime() });
  const list: ApiHistoryItem[] = [
    mk('1', 'GET', 'http://h/admin-api/a', 200, iso(2026, 10, 29)),
    mk('2', 'POST', 'http://h/admin-api/b', 400, iso(2026, 10, 28)),
    mk('3', 'GET', 'http://other/c', 0, iso(2026, 10, 27)),
  ];

  it('空查询原样返回（引用不变，避免多余渲染）', () => {
    expect(filterHistory(list, '')).toBe(list);
  });

  it('按地址 / 方法 / 状态过滤', () => {
    expect(filterHistory(list, 'admin-api').map(i => i.id)).toEqual(['1', '2']);
    expect(filterHistory(list, 'post').map(i => i.id)).toEqual(['2']);
    expect(filterHistory(list, '400').map(i => i.id)).toEqual(['2']);
    expect(filterHistory(list, 'nope')).toEqual([]);
  });
});
