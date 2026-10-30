import { describe, it, expect } from 'vitest';
import { pushRecord, recordFromRun, MAX_RECORDS } from '../../../electron/jmeter-history.js';

const run = (id: string) => ({
  runId: id,
  ok: true,
  code: 0,
  stats: { samples: 100, errors: 2, errorPct: 2, avg: 120, max: 400, tps: 33.3 },
  jtlPath: 'C:/out/a.jtl',
  reportDir: 'C:/out/report-1',
  logPath: 'C:/out/a.log',
});

describe('jmeter-history：记录整理', () => {
  it('recordFromRun 只留需要的字段，并带上脚本名/参数', () => {
    const r = recordFromRun(run('r1'), { jmxPath: 'E:/脚本/广科华贸.jmx', mode: 'report', threads: 50, loops: 10 });
    expect(r.id).toBe('r1');
    expect(r.jmxName).toBe('广科华贸.jmx');
    expect(r.samples).toBe(100);
    expect(r.errors).toBe(2);
    expect(r.tps).toBeCloseTo(33.3, 1);
    expect(r.mode).toBe('report');
    expect(r.threads).toBe(50);
    expect(r.loops).toBe(10);
  });

  it('没有统计（脚本失败）也能记录，数值为 0', () => {
    const r = recordFromRun({ runId: 'r2', ok: false, code: 1, stats: null }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
    expect(r.samples).toBe(0);
  });

  it('pushRecord 按时间倒序，并限制条数', () => {
    let list: any[] = [];
    for (let i = 0; i < 5; i++) list = pushRecord(list, recordFromRun(run('r' + i), {}));
    expect(list[0].id).toBe('r4');
    expect(list.length).toBe(5);
    const capped = pushRecord(list, recordFromRun(run('rx'), {}), 3);
    expect(capped.length).toBe(3);
    expect(capped[0].id).toBe('rx');
  });

  it('没有 id 的记录被忽略；默认上限是 50', () => {
    expect(pushRecord([], {} as never)).toEqual([]);
    expect(MAX_RECORDS).toBe(50);
  });
});
