import { describe, it, expect } from 'vitest';

import {
  BATCH_MAX_ROWS,
  STREAM_MAX_ROWS,
  SINGLE_MAX_ROWS,
  MAX_LINE_BYTES,
  STREAM_FORMATS,
  FORMAT_CAPABILITIES,
  capabilityOf,
  batchSizes,
  progressPercent,
  clampStreamRows,
  decidePath,
} from '../tdg/batch';
import type { ExportFormat } from '../tdg/types';

/**
 * 十万级流式导出的纯函数单测（任务 t25 第 5 条；契约 §2.5 / C-65~C-69）。
 *
 * 这里锁的三类东西都是「错了不会报错、只会产出坏文件或坏体验」的判定：
 *   ① 上限常量必须与主进程 tdg-write.js 一致（两边各写一份，只能靠测试互相看住）；
 *   ② 切批不能漏行、不能超批；
 *   ③ 能力矩阵不能把 XLSX 放进大批量（那会真的把窗口卡死）。
 */

describe('上限常量与主进程 tdg-write.js 对齐（C-65~C-69）', () => {
  it('单批 ≤ 5000 / 单文件 ≤ 1,000,000 / 单行 ≤ 64 KB / 界面单次 5000', () => {
    expect(BATCH_MAX_ROWS).toBe(5000);
    expect(STREAM_MAX_ROWS).toBe(1_000_000);
    expect(MAX_LINE_BYTES).toBe(64 * 1024);
    expect(SINGLE_MAX_ROWS).toBe(5000);
    // 界面单次上限 = 单批上限：>5000 就必须切批，不存在「一批塞 8000」的中间态
    expect(SINGLE_MAX_ROWS).toBe(BATCH_MAX_ROWS);
  });

  it('流式只支持 csv / json / txt 三种（与 tdg-write.js 的 FORMATS 一致）', () => {
    expect([...STREAM_FORMATS].sort()).toEqual(['csv', 'json', 'txt']);
  });
});

describe('batchSizes：切批不漏行、不超批', () => {
  it('整除：10000 → [5000, 5000]', () => {
    expect(batchSizes(10000)).toEqual([5000, 5000]);
  });

  it('有余数：100001 → [5000×20, 1]', () => {
    const out = batchSizes(100001);
    expect(out).toHaveLength(21);
    expect(out[out.length - 1]).toBe(1);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100001);
  });

  it('0 行 → 空数组（不产生「0 行的一批」）', () => {
    expect(batchSizes(0)).toEqual([]);
    expect(batchSizes(-5)).toEqual([]);
  });

  it('小于一批 → 单批', () => {
    expect(batchSizes(1)).toEqual([1]);
    expect(batchSizes(4999)).toEqual([4999]);
    expect(batchSizes(5000)).toEqual([5000]);
  });

  it('恰好等于上限：1,000,000 → 200 批，每批都是 5000', () => {
    const out = batchSizes(STREAM_MAX_ROWS);
    expect(out).toHaveLength(200);
    expect(out.every(n => n === BATCH_MAX_ROWS)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBe(STREAM_MAX_ROWS);
  });

  it('任意 total 都满足「每批 ≤ batchSize 且总和 === total」', () => {
    for (const total of [1, 4999, 5000, 5001, 12345, 100000, 999999]) {
      const out = batchSizes(total);
      expect(Math.max(...out)).toBeLessThanOrEqual(BATCH_MAX_ROWS);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('自定义 batchSize 也被尊重（测试与将来调参用）', () => {
    expect(batchSizes(10, 3)).toEqual([3, 3, 3, 1]);
    expect(batchSizes(10, 1)).toHaveLength(10);
  });
});

describe('progressPercent：边界夹紧', () => {
  it('0 / 一半 / 满 / 超', () => {
    expect(progressPercent(0, 100000)).toBe(0);
    expect(progressPercent(50000, 100000)).toBe(50);
    expect(progressPercent(100000, 100000)).toBe(100);
    expect(progressPercent(200000, 100000)).toBe(100); // 超了也只显示 100
  });

  it('负进度与 total<=0 都是 0（不产生负数/NaN 的宽度）', () => {
    expect(progressPercent(-5, 100)).toBe(0);
    expect(progressPercent(10, 0)).toBe(0);
    expect(progressPercent(10, -1)).toBe(0);
  });

  it('按批推进时单调不减，最后一个满批恰好 100', () => {
    const total = 12345;
    let last = -1;
    let done = 0;
    for (const size of batchSizes(total)) {
      done += size;
      const p = progressPercent(done, total);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(last).toBe(100);
  });
});

describe('clampStreamRows：输入框夹紧', () => {
  it('小于 1 / NaN / 负数 → 1', () => {
    expect(clampStreamRows(0)).toBe(1);
    expect(clampStreamRows(-100)).toBe(1);
    expect(clampStreamRows(Number.NaN)).toBe(1);
  });

  it('超过 100 万 → 100 万；小数向下取整', () => {
    expect(clampStreamRows(2_000_000)).toBe(STREAM_MAX_ROWS);
    expect(clampStreamRows(100000.7)).toBe(100000);
  });
});

describe('格式能力矩阵（写进 UI，也要能在代码里断言）', () => {
  it('csv / json / txt：支持到 1,000,000 行', () => {
    for (const f of ['csv', 'json', 'txt'] as ExportFormat[]) {
      const cap = capabilityOf(f);
      expect(cap.stream).toBe(true);
      expect(cap.streamMaxRows).toBe(STREAM_MAX_ROWS);
      expect(cap.singleMaxRows).toBe(5000);
      expect(cap.reason).toBeUndefined();
    }
  });

  it('xlsx / md / sql：不支持流式，理由要具体到能直接显示', () => {
    for (const f of ['xlsx', 'md', 'sql'] as ExportFormat[]) {
      const cap = capabilityOf(f);
      expect(cap.stream).toBe(false);
      expect(cap.streamMaxRows).toBe(0);
      expect(cap.reason && cap.reason.length).toBeGreaterThan(10);
    }
    // XLSX 的理由必须点名 exceljs / 内存，不能是「暂不支持」
    expect(capabilityOf('xlsx').reason).toContain('exceljs');
    expect(capabilityOf('xlsx').reason).toContain('内存');
  });

  it('矩阵覆盖全部 6 种格式，顺序固定（UI 直接 map 渲染）', () => {
    expect(FORMAT_CAPABILITIES.map(c => c.format)).toEqual(['txt', 'csv', 'md', 'xlsx', 'json', 'sql']);
    expect(FORMAT_CAPABILITIES.filter(c => c.stream)).toHaveLength(3);
  });
});

describe('decidePath：点按钮之前就决定走哪条路', () => {
  it('≤5000 → 原路径（既有行为零回归），给的是引导文案', () => {
    const p = decidePath(5000, 'xlsx');
    expect(p.path).toBe('single');
    if (p.path === 'single') expect(p.reason).toContain('上面的「导出」');
  });

  it('>5000 + csv/json/txt → 流式，批数 = ceil(n/5000)', () => {
    const p = decidePath(100000, 'csv');
    expect(p).toEqual({ path: 'stream', total: 100000, batchSize: 5000, batches: 20 });
    expect(decidePath(100001, 'json')).toMatchObject({ path: 'stream', batches: 21 });
  });

  it('>5000 + xlsx → blocked 且理由是 exceljs 内存（UI 上要禁用，不要等点了才失败）', () => {
    const p = decidePath(100000, 'xlsx');
    expect(p.path).toBe('blocked');
    if (p.path === 'blocked') {
      expect(p.reason).toContain('exceljs');
      expect(p.reason).toContain('CSV');
    }
  });

  it('>5000 + md/sql → blocked', () => {
    expect(decidePath(6000, 'md').path).toBe('blocked');
    expect(decidePath(6000, 'sql').path).toBe('blocked');
  });

  it('超过单文件上限 → blocked（点之前就拦住，不要写到一半才报）', () => {
    const p = decidePath(STREAM_MAX_ROWS + 1, 'csv');
    expect(p.path).toBe('blocked');
    if (p.path === 'blocked') expect(p.reason).toContain('单文件上限');
  });

  it('恰好等于上限 → stream（边界值走通）', () => {
    expect(decidePath(STREAM_MAX_ROWS, 'txt')).toMatchObject({ path: 'stream', batches: 200 });
  });

  it('行数非正 → blocked', () => {
    expect(decidePath(0, 'csv').path).toBe('blocked');
    expect(decidePath(-1, 'csv').path).toBe('blocked');
  });
});