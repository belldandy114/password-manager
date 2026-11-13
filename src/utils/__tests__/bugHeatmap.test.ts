import { describe, it, expect } from 'vitest';
import { shortModuleName, mondayOf, moduleWeekHeatmap } from '../bugSummary';
import type { ZentaoBug } from '../../types';

/** 2026-11-13 是周五，那一周的周一是 11-09 */
const NOW = new Date('2026-11-13T10:00:00');

const mk = (
  id: string,
  openedDate: string,
  moduleName: string,
  extra: Partial<ZentaoBug> = {},
): ZentaoBug => ({
  id,
  title: `bug-${id}`,
  status: 'active',
  resolution: '',
  openedBy: 'zhangsan',
  assignedTo: 'lisi',
  moduleName,
  openedDate,
  ...extra,
});

describe('shortModuleName', () => {
  it('取路径最后一段', () => {
    expect(shortModuleName('内控管理/资产管理/添置资产')).toBe('添置资产');
    expect(shortModuleName('内控管理 / 资产管理 / 添置资产')).toBe('添置资产');
  });

  it('单段原样返回', () => {
    expect(shortModuleName('登录模块')).toBe('登录模块');
  });

  it('空值归到未指定模块', () => {
    expect(shortModuleName('')).toBe('未指定模块');
    expect(shortModuleName('  /  ')).toBe('未指定模块');
  });
});

describe('mondayOf', () => {
  it('周五归到本周一', () => {
    expect(mondayOf('2026-11-13')).toBe('2026-11-09');
  });

  it('周日归到上一个周一', () => {
    expect(mondayOf('2026-11-15')).toBe('2026-11-09');
  });

  it('周一返回自身', () => {
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
  });

  it('非法日期返回空串', () => {
    expect(mondayOf('')).toBe('');
  });
});

describe('moduleWeekHeatmap', () => {
  const bugs = [
    mk('1', '2026-11-10 09:00:00', 'A/登录'),
    mk('2', '2026-11-11 09:00:00', 'A/登录'),
    mk('3', '2026-11-12 14:00:00', 'A/登录'),
    mk('4', '2026-11-03 09:00:00', 'A/登录'),
    mk('5', '2026-11-04 09:00:00', 'B/导出'),
    mk('6', '2026-10-01 09:00:00', 'B/导出'), // 超出 3 周窗口
    mk('7', '2026-11-12 09:00:00', 'C/派单', { status: 'closed', resolution: 'fixed' }),
  ];

  it('周序列从旧到新，最后一个是本周', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW });
    expect(h.weeks).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
  });

  it('按提交日期落到对应周', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW });
    const login = h.rows.find((r) => r.module === '登录')!;
    expect(login.counts).toEqual([0, 1, 3]);
    expect(login.total).toBe(4);
  });

  it('窗口外的缺陷不计入', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW });
    const exp = h.rows.find((r) => r.module === '导出')!;
    expect(exp.total).toBe(1); // 10-01 那条被丢掉
  });

  it('按总数降序排列', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW });
    expect(h.rows[0].module).toBe('登录');
  });

  it('single 最大值用于着色', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW });
    expect(h.max).toBe(3);
  });

  it('topN 之外的模块合并成「其他」', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW, topN: 1 });
    expect(h.rows).toHaveLength(2);
    expect(h.rows[1].module).toContain('其他');
    expect(h.mergedModules).toBe(2);
    expect(h.rows[1].total).toBe(2); // 导出 1 + 派单 1
  });

  it('onlyOpen 过滤掉已修复/已关闭', () => {
    const all = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW });
    const open = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW, onlyOpen: true });
    expect(all.rows.find((r) => r.module === '派单')!.total).toBe(1);
    expect(open.rows.find((r) => r.module === '派单')).toBeUndefined();
  });

  it('排除人员生效（按指派人，不看提交人；已关闭的不受影响）', () => {
    const h = moduleWeekHeatmap(bugs, { weeks: 3, now: NOW, exclude: new Set(['lisi']) });
    // 未关闭的都指派给 lisi → 被排除；只剩那条已关闭的「派单」
    expect(h.rows.map((r) => r.module)).toEqual(['派单']);
  });

  it('空数据不报错', () => {
    const h = moduleWeekHeatmap([], { weeks: 3, now: NOW });
    expect(h.rows).toEqual([]);
    expect(h.max).toBe(0);
    expect(h.weeks).toHaveLength(3);
  });

  it('历史周按日切点归属', () => {
    // 切点 17:30：11-09 18:00 提交 → 统计日 11-10，仍在本周
    const one = [mk('9', '2026-11-09 18:00:00', 'A/登录')];
    const h = moduleWeekHeatmap(one, { weeks: 1, now: NOW, cutoffMin: 1050 });
    expect(h.rows[0].counts).toEqual([1]);
  });

  it('支持半年 / 一年档位（不再被 26 周上限截断）', () => {
    expect(moduleWeekHeatmap([], { weeks: 26, now: NOW }).weeks).toHaveLength(26);
    expect(moduleWeekHeatmap([], { weeks: 52, now: NOW }).weeks).toHaveLength(52);
    expect(moduleWeekHeatmap([], { weeks: 104, now: NOW }).weeks).toHaveLength(104);
  });

  it('一年档位下当周仍能落进最后一列', () => {
    const one = [mk('10', '2026-11-12 10:00:00', 'A/登录')];
    const h = moduleWeekHeatmap(one, { weeks: 52, now: NOW });
    expect(h.rows[0].counts[51]).toBe(1);
  });
});
