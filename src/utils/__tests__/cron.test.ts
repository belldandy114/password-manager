import { describe, it, expect } from 'vitest';
import { parseCron, describeCron, nextRuns, normalizeCron, cronFromText, CRON_PRESETS } from '../../utils/cron';

describe('normalizeCron', () => {
  it('@daily 等别名展开', () => {
    expect(normalizeCron('@daily')).toBe('0 0 * * *');
    expect(normalizeCron('@hourly')).toBe('0 * * * *');
    expect(normalizeCron('@WEEKLY')).toBe('0 0 * * 0');
  });

  it('多余空白压缩', () => {
    expect(normalizeCron(' 0   9  *  *  * ')).toBe('0 9 * * *');
  });
});

describe('parseCron', () => {
  it('展开步长与区间', () => {
    const s = parseCron('*/15 9-11 * * 1-5')!;
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([9, 10, 11]);
    expect(s.dows).toEqual([1, 2, 3, 4, 5]);
  });

  it('周日 7 归一成 0', () => {
    expect(parseCron('0 0 * * 7')!.dows).toEqual([0]);
  });

  it('段数不对返回 null', () => {
    expect(parseCron('0 9 * *')).toBeNull();
  });

  it('越界值返回 null', () => {
    expect(parseCron('99 9 * * *')).toBeNull();
  });
});

describe('describeCron', () => {
  it('工作日 9 点', () => {
    expect(describeCron('0 9 * * 1-5')).toContain('周一');
    expect(describeCron('0 9 * * 1-5')).toContain('9 点');
  });

  it('每 30 分钟', () => {
    expect(describeCron('*/30 * * * *')).toContain('每 30 分钟');
  });

  it('每天 0 点', () => {
    expect(describeCron('0 0 * * *')).toContain('0 点');
  });

  it('非法表达式给提示', () => {
    expect(describeCron('bad')).toMatch(/5 段/);
  });
});

describe('nextRuns', () => {
  it('返回 n 条且严格递增', () => {
    const runs = nextRuns('*/30 * * * *', 3, new Date(2026, 10, 2, 10, 5, 0));
    expect(runs).toHaveLength(3);
    expect(runs[0]).toContain('10:30');
  });

  it('非法表达式返回空', () => {
    expect(nextRuns('bad')).toEqual([]);
  });
});

describe('cronFromText（反向生成）', () => {
  it('精确匹配预设', () => {
    expect(cronFromText('工作日 9 点')).toBe('0 9 * * 1-5');
    expect(cronFromText('每天9点')).toBe('0 9 * * *');
  });

  it('忽略「的」与空格', () => {
    expect(cronFromText('每 5 分钟的')).toBe('*/5 * * * *');
  });

  it('匹配不到返回 null', () => {
    expect(cronFromText('每逢佳节倍思亲')).toBeNull();
  });

  it('所有预设都能被自己的文案反查（保证示例自洽）', () => {
    for (const p of CRON_PRESETS) {
      expect(cronFromText(p.label)).toBe(p.expr);
    }
  });
});