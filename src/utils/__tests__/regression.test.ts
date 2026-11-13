import { describe, it, expect } from 'vitest';
import {
  isDue, nextRunAt, summarizeRun, compareRuns, diffAlerts, pruneRuns, latestRunOf,
  intervalLabel, type RegressionSet, type RegressionRun,
} from '../regression';
import type { RunStep } from '../apiRunner';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');

const set = (over: Partial<RegressionSet> = {}): RegressionSet => ({
  id: 's1', name: '冒烟', requestIds: ['a'], intervalMin: 30, enabled: true,
  createdAt: '2026-11-01T00:00:00.000Z', ...over,
});

const step = (over: Partial<RunStep> = {}): RunStep => ({
  id: 'a', name: '登录', method: 'POST', url: 'http://x/login',
  ok: true, status: 200, timeMs: 100, asserts: [], ...over,
});

describe('isDue', () => {
  it('没启用或间隔为 0 都不跑', () => {
    expect(isDue(set({ enabled: false }), NOW)).toBe(false);
    expect(isDue(set({ intervalMin: 0 }), NOW)).toBe(false);
  });

  it('从未跑过 → 立刻到期（勾上就该马上跑一次）', () => {
    expect(isDue(set(), NOW)).toBe(true);
  });

  it('未到间隔不跑，到点就跑', () => {
    expect(isDue(set({ lastRunAt: new Date(NOW - 10 * 60_000).toISOString() }), NOW)).toBe(false);
    expect(isDue(set({ lastRunAt: new Date(NOW - 30 * 60_000).toISOString() }), NOW)).toBe(true);
  });

  it('lastRunAt 是坏的也当成到期，别把定时卡死', () => {
    expect(isDue(set({ lastRunAt: 'not-a-date' }), NOW)).toBe(true);
  });
});

describe('nextRunAt', () => {
  it('有上次时间就加上间隔', () => {
    const last = NOW - 5 * 60_000;
    expect(nextRunAt(set({ lastRunAt: new Date(last).toISOString() }))).toBe(last + 30 * 60_000);
  });

  it('没启用返回 null', () => {
    expect(nextRunAt(set({ enabled: false }))).toBeNull();
  });
});

describe('summarizeRun', () => {
  it('统计通过数、失败数与总耗时', () => {
    const s = summarizeRun([step({ timeMs: 100 }), step({ id: 'b', ok: false, timeMs: 60 })]);
    expect(s).toEqual({ total: 2, pass: 1, fail: 1, totalMs: 160 });
  });

  it('空数组不炸', () => {
    expect(summarizeRun([])).toEqual({ total: 0, pass: 0, fail: 0, totalMs: 0 });
  });
});

describe('compareRuns', () => {
  it('上次通过这次失败 → 新失败', () => {
    const d = compareRuns([step()], [step({ ok: false, status: 500 })]);
    expect(d[0].kind).toBe('new-fail');
    expect(d[0].statusChanged).toBe(true);
  });

  it('上次失败这次通过 → 已恢复', () => {
    const d = compareRuns([step({ ok: false })], [step()]);
    expect(d[0].kind).toBe('recovered');
  });

  it('两次都失败 / 都通过', () => {
    expect(compareRuns([step({ ok: false })], [step({ ok: false })])[0].kind).toBe('same-fail');
    expect(compareRuns([step()], [step()])[0].kind).toBe('same-pass');
  });

  it('这次才出现 → 新增；上次有这次没有 → 已移除', () => {
    const d = compareRuns([step()], [step(), step({ id: 'b', name: '列表' })]);
    expect(d.find(x => x.id === 'b')?.kind).toBe('added');
    const d2 = compareRuns([step(), step({ id: 'b' })], [step()]);
    expect(d2.find(x => x.id === 'b')?.kind).toBe('gone');
  });

  it('按 id 对齐，顺序变了不算变化', () => {
    const prev = [step({ id: 'a' }), step({ id: 'b' })];
    const cur = [step({ id: 'b' }), step({ id: 'a' })];
    const d = compareRuns(prev, cur);
    expect(d.map(x => x.kind)).toEqual(['same-pass', 'same-pass']);
  });

  it('记录耗时差', () => {
    const d = compareRuns([step({ timeMs: 100 })], [step({ timeMs: 260 })]);
    expect(d[0].timeDeltaMs).toBe(160);
  });


  it('失败的步骤没有耗时，不给耗时差（否则会显示「快了 120ms」这种误导）', () => {
    const d = compareRuns([step({ timeMs: 120 })], [step({ ok: false, timeMs: 0 })]);
    expect(d[0].timeDeltaMs).toBeNull();
  });

  it('没有上次结果时全部算新增', () => {
    expect(compareRuns(null, [step()])[0].kind).toBe('added');
  });
});

describe('diffAlerts', () => {
  it('只数新失败与已移除', () => {
    const d = compareRuns(
      [step({ id: 'a' }), step({ id: 'b', ok: false })],
      [step({ id: 'a', ok: false }), step({ id: 'b' })],
    );
    expect(diffAlerts(d)).toBe(1);
  });
});

describe('pruneRuns / latestRunOf', () => {
  const run = (id: string, setId: string, at: string): RegressionRun => ({
    id, setId, setName: '冒烟', at, trigger: 'schedule', steps: [step()],
  });

  it('每个集合各留最近 N 次，按时间倒序', () => {
    const runs = [
      run('1', 's1', '2026-11-01T00:00:00.000Z'),
      run('2', 's1', '2026-11-02T00:00:00.000Z'),
      run('3', 's1', '2026-11-03T00:00:00.000Z'),
      run('4', 's2', '2026-11-01T00:00:00.000Z'),
      run('5', 's2', '2026-11-02T00:00:00.000Z'),
    ];
    const kept = pruneRuns(runs, 2);
    expect(kept.filter(r => r.setId === 's1').map(r => r.id)).toEqual(['3', '2']);
    expect(kept.filter(r => r.setId === 's2').map(r => r.id)).toEqual(['5', '4']);
    expect(kept[0].at >= kept[kept.length - 1].at).toBe(true);
  });

  it('latestRunOf 取该集合最新一条', () => {
    const runs = [run('1', 's1', '2026-11-01T00:00:00.000Z'), run('2', 's1', '2026-11-05T00:00:00.000Z'), run('3', 's2', '2026-11-09T00:00:00.000Z')];
    expect(latestRunOf(runs, 's1')?.id).toBe('2');
    expect(latestRunOf(runs, 's3')).toBeNull();
  });
});

describe('intervalLabel', () => {
  it('已知档位给中文，未知档位兜底', () => {
    expect(intervalLabel(30)).toBe('每 30 分钟');
    expect(intervalLabel(7)).toBe('每 7 分钟');
  });
});
