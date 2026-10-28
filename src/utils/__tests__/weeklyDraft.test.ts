import { describe, it, expect } from 'vitest';
import { compareWeeks, weekStats, buildGroupMessage, weekRange, buildWeeklyDraft } from '../weeklyDraft';
import type { ZentaoBug } from '../../types';

// 造几条落在「指定日」的 Bug：date=提出，resolvedDate=解决，closedDate=关闭
const bug = (id: string, day: string, sev = '3', extra: Partial<ZentaoBug> = {}): ZentaoBug => ({
  id, title: `缺陷 ${id}`, status: 'active', severity: sev,
  productName: '资产管理系统', date: `${day} 10:00:00`,
  ...extra,
} as ZentaoBug);

const { start: thisStart, end: thisEnd } = weekRange(0);
const { start: prevStart, end: prevEnd } = weekRange(1);

describe('weeklyDraft.weekStats', () => {
  it('按提出/解决/关闭三个口径分别计数', () => {
    const bugs = [
      bug('1', thisStart),
      bug('2', thisStart),
      bug('3', prevStart, '3', { resolvedDate: `${thisStart} 15:00:00` }),
      bug('4', prevStart, '2', { closedDate: `${thisStart} 16:00:00` }),
      bug('5', prevEnd),
    ];
    const s = weekStats(bugs, thisStart, thisEnd);
    expect(s.created).toBe(2);
    expect(s.resolved).toBe(1);
    expect(s.closed).toBe(1);
    // 只有 status=closed 才算已关闭
    expect(s.unclosed).toBe(5);
    expect(s.serious).toBe(1);
  });

  it('按项目聚合，并按总量倒序', () => {
    const bugs = [
      bug('1', thisStart, '3', { productName: 'A' }),
      bug('2', thisStart, '3', { productName: 'B' }),
      bug('3', thisStart, '3', { productName: 'B' }),
      bug('4', thisStart, '3', { productName: '' }),
    ];
    const s = weekStats(bugs, thisStart, thisEnd);
    expect(s.byProject[0].name).toBe('B');
    expect(s.byProject[0].created).toBe(2);
    expect(s.byProject.some(p => p.name === '未分类')).toBe(true);
  });
});

describe('weeklyDraft.compareWeeks', () => {
  it('本周与上周各自独立统计，不会互相污染', () => {
    const bugs = [
      bug('1', thisStart),
      bug('2', thisStart),
      bug('3', prevStart),
    ];
    const { cur, prev } = compareWeeks(bugs, 0);
    expect(cur.created).toBe(2);
    expect(prev.created).toBe(1);
    expect(cur.start).toBe(thisStart);
    expect(prev.start).toBe(prevStart);
  });

  it('上周在这一周里没有数据时，对比值是 0 而不是继承本周', () => {
    const bugs = [bug('1', thisStart), bug('2', thisStart)];
    const { cur, prev } = compareWeeks(bugs, 0);
    expect(prev.created).toBe(0);
    expect(cur.created - prev.created).toBe(2);
  });
});

describe('weeklyDraft.buildGroupMessage', () => {
  it('输出可直接发群的纯文本（无 Markdown 标记）', () => {
    const bugs = [bug('1', thisStart, '1'), bug('2', thisStart, '2')];
    const text = buildGroupMessage(bugs, thisStart, thisEnd);
    expect(text).toContain('【测试周报');
    expect(text).toContain('新提 2');
    expect(text).toContain('未关闭：2');
    expect(text).toContain('致命 1');
    // 群消息里不该出现 ** 之类的 Markdown
    expect(text).not.toContain('**');
    expect(text.split('\n').every(l => l.length < 80)).toBe(true);
  });

  it('致命缺陷未关闭时会列进「待处理」', () => {
    const bugs = [bug('99', thisStart, '1')];
    const text = buildGroupMessage(bugs, thisStart, thisEnd);
    expect(text).toContain('#99');
  });
});

describe('weeklyDraft.buildWeeklyDraft（原有能力不回退）', () => {
  it('仍然生成三段式草稿', () => {
    const text = buildWeeklyDraft([bug('1', thisStart)], thisStart, thisEnd);
    expect(text).toContain('**一、本周工作**');
    expect(text).toContain('**二、问题与风险**');
    expect(text).toContain('**三、下周计划**');
    expect(text).toContain('新提 1 条');
  });
});