import { describe, it, expect } from 'vitest';

// 渲染层不能 import 主进程模块，但**测试可以** require 它来做对照（仓库既有写法，见 jmxScript.test.ts）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mainCsv = require('../../../electron/csv.js');

import {
  parseCsvLite,
  importCaseMapsCsv,
  readHeader,
  parseTargetRef,
  buildManualEntry,
  dedupeByCaseNo,
  isCaseMapCsvFile,
  unsupportedFileMessage,
  caseMapSummary,
  CASE_MAP_UNSUPPORTED_MSG,
  CASE_MAP_LIMITS,
  type CaseMapEntry,
} from '../caseMaps';

/**
 * 用例映射纯函数单测（契约 §1.5 / [C-34]–[C-36]）。
 *
 * 最重要的一条是 **CSV 对照测试**：渲染层有一份最小解析器、主进程有一份 `parseCsv`，
 * 两套实现一旦分叉，用户会遇到「导入成功但字段错位」这种最难查的问题。所以同一个 fixture
 * 必须两边解析出**逐字相同**的结果 —— 这条测试就是那道锁。
 */

/* ================================================================
   ① 与主进程 parseCsv 的对照（这条是"两套解析不分叉"的唯一保障）
   ================================================================ */

const FIXTURE = [
  '用例编号,用例标题,脚本,备注',
  'TC-001,登录成功,src/test/java/LoginTest.java#testLogin,"引号,逗号都在里面"',
  'TC-002,"标题里有""双引号""",src/test/java/LoginTest.java,',
  'TC-003,多行字段,"src/test/java/A.java#b","第一行\n第二行"',
  'TC-004,,src/test/java/B.java,',
  '',
].join('\r\n');

describe('parseCsvLite 与 electron/csv.js 的 parseCsv 逐字一致（对照测试）', () => {
  it('同一 fixture（含引号逗号、"" 转义、\\r\\n、多行字段、空字段、尾部空行）两边结果相同', () => {
    const mine = parseCsvLite(FIXTURE);
    const theirs = mainCsv.parseCsv(FIXTURE);
    expect(mine).toEqual(theirs);
    // 逐字再比一次（toEqual 对嵌套数组已足够，这里显式断言长度与每格）
    expect(mine.length).toBe(theirs.length);
    for (let i = 0; i < mine.length; i += 1) expect(mine[i]).toEqual(theirs[i]);
  });

  it('BOM 开头两边都吃掉', () => {
    const withBom = `\uFEFF${FIXTURE}`;
    expect(parseCsvLite(withBom)).toEqual(mainCsv.parseCsv(withBom));
  });

  it('只有引号状态的边角料也一致（未闭合引号、连续逗号、纯逗号行）', () => {
    const cases = [
      'a,b,c',
      'a,"b,c",d',
      'a,"b""c",d',
      '"未闭合,b,c\n第二行,d',
      ',,,\n,,\n x , y ',
      'a,b\r\nc,d\r\n',
      'a,b\n\n\nc,d',
    ];
    for (const c of cases) {
      expect(parseCsvLite(c)).toEqual(mainCsv.parseCsv(c));
    }
  });
});

/* ================================================================
   ② 表头识别
   ================================================================ */

describe('readHeader：中英文列名都要认', () => {
  it('中文表头', () => {
    const h = readHeader(['用例编号', '用例标题', '脚本', '备注']);
    expect(h).toMatchObject({ caseNo: 0, caseTitle: 1, target: 2, note: 3, missing: [] });
  });

  it('英文表头（大小写/下划线都不敏感）', () => {
    const h = readHeader(['CaseNo', 'case_title', 'TARGET', 'Kind', 'Note']);
    expect(h).toMatchObject({ caseNo: 0, caseTitle: 1, target: 2, kind: 3, note: 4, missing: [] });
  });

  it('缺必需列时能说清缺什么', () => {
    const h = readHeader(['标题', '备注']);
    expect(h.missing.join('')).toContain('caseNo');
    expect(h.missing.join('')).toContain('target');
  });
});

describe('parseTargetRef：按 # 判 file / method', () => {
  it('有 # → method；没 # → file', () => {
    expect(parseTargetRef('src/A.java#testA')).toEqual({ kind: 'method', ref: 'src/A.java#testA' });
    expect(parseTargetRef('src/A.java')).toEqual({ kind: 'file', ref: 'src/A.java' });
  });

  it('显式 kind 优先；声明成 method 却没有 # 判为无效', () => {
    expect(parseTargetRef('src/A.java', 'file')).toEqual({ kind: 'file', ref: 'src/A.java' });
    expect(parseTargetRef('src/A.java#x', 'file')).toBeNull();
    expect(parseTargetRef('src/A.java', 'method')).toBeNull();
  });

  it('空 / 超长 → null', () => {
    expect(parseTargetRef('')).toBeNull();
    expect(parseTargetRef('x'.repeat(CASE_MAP_LIMITS.targetRef + 1))).toBeNull();
  });
});

/* ================================================================
   ③ CSV → 条目：四数之和 == 行数，重复合并而不是覆盖
   ================================================================ */

const empty: CaseMapEntry[] = [];

describe('importCaseMapsCsv：计数与幂等语义（[C-35]）', () => {
  it('首次导入：全部 added，四数之和等于数据行数', () => {
    const r = importCaseMapsCsv(FIXTURE, empty, { now: '2026-01-01T00:00:00.000Z', makeId: (i) => `id-${i}` });
    expect(r.report.added).toBe(4);
    expect(r.report.updated).toBe(0);
    expect(r.report.invalid).toBe(0);
    expect(r.report.rows).toBe(4);
    expect(r.report.added + r.report.updated + r.report.skipped + r.report.invalid).toBe(r.report.rows);
    expect(r.items).toHaveLength(4);
    expect(r.items[0]).toMatchObject({
      id: 'id-0',
      caseNo: 'TC-001',
      caseTitle: '登录成功',
      target: { kind: 'method', ref: 'src/test/java/LoginTest.java#testLogin' },
      source: 'csv',
      note: '引号,逗号都在里面',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('再导一次同一份：全部 updated（幂等键 caseNo），条数不变', () => {
    const first = importCaseMapsCsv(FIXTURE, empty, { now: '2026-01-01T00:00:00.000Z', makeId: (i) => `id-${i}` });
    const second = importCaseMapsCsv(FIXTURE, first.items, { now: '2026-02-02T00:00:00.000Z', makeId: (i) => `new-${i}` });
    expect(second.report.added).toBe(0);
    expect(second.report.updated).toBe(4);
    // RC-07 口径：merged 只统计「命中了已有集合里的条目」——这 4 行全部命中，所以是 4
    expect(second.report.merged).toBe(4);
    expect(second.items).toHaveLength(4);
    // id 保持原样（不新增），updatedAt 更新
    expect(second.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
    expect(second.items[0].updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('同一份 CSV 内部重复的 caseNo：合并 + merged 计数，末行覆盖 target', () => {
    const csv = [
      '用例编号,脚本',
      'TC-9,src/A.java',
      'TC-9,src/B.java#m',
    ].join('\n');
    const r = importCaseMapsCsv(csv, empty, { now: '2026-01-01T00:00:00.000Z', makeId: (i) => `id-${i}` });
    expect(r.items).toHaveLength(1);
    expect(r.report.added).toBe(1);
    expect(r.report.updated).toBe(1);
    // RC-07：merged 只统计「命中了已有集合里的条目」。这里第二条 TC-9 命中的是**本次刚新增**的那条，
    // 不是已有集合 → 不计入 merged（否则「其中合并 N 条」会把本文件内的重复重复计一次）
    expect(r.report.merged).toBe(0);
    expect(r.report.added + r.report.updated + r.report.skipped + r.report.invalid).toBe(r.report.rows);
    expect(r.items[0].target).toEqual({ kind: 'method', ref: 'src/B.java#m' });
  });

  it('同一份 CSV 连续导入两次：第一次「新增 4 / 合并 0」，第二次「新增 0 / 合并 4」', () => {
    const csv = [
      '用例编号,脚本',
      'TC-A,src/A.java',
      'TC-B,src/B.java',
      'TC-C,src/C.java',
      'TC-D,src/D.java',
    ].join('\n');
    const first = importCaseMapsCsv(csv, empty, { now: '2026-01-01T00:00:00.000Z', makeId: (i) => `id-${i}` });
    expect(first.report).toMatchObject({ added: 4, updated: 0, merged: 0, invalid: 0 });

    const second = importCaseMapsCsv(csv, first.items, { now: '2026-02-02T00:00:00.000Z', makeId: (i) => `new-${i}` });
    // 第二次每一行都命中了已有集合里的条目 → 全部 merged，一条都没新增
    expect(second.report).toMatchObject({ added: 0, updated: 4, merged: 4, invalid: 0 });
    expect(second.items).toHaveLength(4);
    expect(second.report.added + second.report.updated + second.report.skipped + second.report.invalid).toBe(second.report.rows);
  });

  it('注释行与空行：注释行计入 skipped，四数仍等于行数', () => {
    const csv = [
      '用例编号,脚本',
      '# 这一行是说明',
      'TC-1,src/A.java',
      '',
    ].join('\n');
    const r = importCaseMapsCsv(csv, empty, { now: '2026-01-01T00:00:00.000Z' });
    expect(r.report.rows).toBe(2);   // parseCsvLite 已经滤掉全空行
    expect(r.report.skipped).toBe(1);
    expect(r.report.added).toBe(1);
    expect(r.report.added + r.report.updated + r.report.skipped + r.report.invalid).toBe(r.report.rows);
  });

  it('缺编号 / 缺脚本 / 超长 → invalid 并带可读错误', () => {
    const csv = [
      '用例编号,脚本',
      ',src/A.java',
      'TC-2,',
      `${'x'.repeat(65)},src/C.java`,
      'TC-4,src/D.java',
    ].join('\n');
    const r = importCaseMapsCsv(csv, empty, { now: '2026-01-01T00:00:00.000Z' });
    expect(r.report.invalid).toBe(3);
    expect(r.report.added).toBe(1);
    expect(r.report.errors.length).toBeGreaterThanOrEqual(3);
    expect(r.report.errors.join('\n')).toContain('用例编号为空');
    expect(r.report.errors.join('\n')).toContain('脚本为空');
    expect(r.report.added + r.report.updated + r.report.skipped + r.report.invalid).toBe(r.report.rows);
  });

  it('表头缺必需列 → 一条错误、零导入（不猜列位）', () => {
    const r = importCaseMapsCsv('标题,备注\nA,B', empty, { now: '2026-01-01T00:00:00.000Z' });
    expect(r.items).toEqual([]);
    expect(r.report.added).toBe(0);
    expect(r.report.errors[0]).toContain('表头缺少必需列');
  });

  it('空文本 → 明确报错，不抛异常', () => {
    const r = importCaseMapsCsv('', empty, { now: '2026-01-01T00:00:00.000Z' });
    expect(r.report.errors[0]).toContain('没有任何行');
    expect(r.items).toEqual([]);
  });

  it('入参数组不被修改', () => {
    const existing: CaseMapEntry[] = [{
      id: 'old', caseNo: 'TC-001', target: { kind: 'file', ref: 'src/old.java' }, source: 'manual', updatedAt: '2025-01-01T00:00:00.000Z',
    }];
    const snapshot = JSON.parse(JSON.stringify(existing));
    importCaseMapsCsv(FIXTURE, existing, { now: '2026-01-01T00:00:00.000Z' });
    expect(existing).toEqual(snapshot);
  });
});

/* ================================================================
   ④ 手工维护
   ================================================================ */

describe('buildManualEntry：重名直接报错，不静默覆盖', () => {
  const existing: CaseMapEntry[] = [{
    id: 'a1', caseNo: 'TC-100', target: { kind: 'file', ref: 'src/X.java' }, source: 'manual', updatedAt: '2026-01-01T00:00:00.000Z',
  }];

  it('新建成功：source=manual，target 按 # 推断', () => {
    const r = buildManualEntry({ caseNo: 'TC-101', targetRef: 'src/Y.java#testY', caseTitle: '标题' }, existing, { now: '2026-01-02T00:00:00.000Z' });
    expect(r.error).toBeUndefined();
    expect(r.entry).toMatchObject({
      caseNo: 'TC-101',
      target: { kind: 'method', ref: 'src/Y.java#testY' },
      source: 'manual',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('编辑自己（同 id）不算重名', () => {
    const r = buildManualEntry({ id: 'a1', caseNo: 'TC-100', targetRef: 'src/X.java' }, existing, { now: '2026-01-02T00:00:00.000Z' });
    expect(r.error).toBeUndefined();
    expect(r.entry?.id).toBe('a1');
  });

  it('用别人的 caseNo → 报「用例编号已存在」', () => {
    const r = buildManualEntry({ caseNo: 'TC-100', targetRef: 'src/Z.java' }, existing);
    expect(r.error).toContain('用例编号已存在：TC-100');
  });

  it('空编号 / 空脚本 / 超长备注各自有具体文案', () => {
    expect(buildManualEntry({ caseNo: '', targetRef: 'src/Z.java' }, []).error).toContain('用例编号不能为空');
    expect(buildManualEntry({ caseNo: 'TC-1', targetRef: '' }, []).error).toContain('脚本不能为空');
    expect(buildManualEntry({ caseNo: 'TC-1', targetRef: 'src/A.java', note: 'x'.repeat(201) }, []).error).toContain('备注最多');
  });
});

describe('集合辅助：dedupe / 文件类型 / 汇总', () => {
  it('dedupeByCaseNo 保留 updatedAt 最新的那条', () => {
    const items: CaseMapEntry[] = [
      { id: '1', caseNo: 'TC-1', target: { kind: 'file', ref: 'a' }, source: 'csv', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', caseNo: 'TC-1', target: { kind: 'file', ref: 'b' }, source: 'csv', updatedAt: '2026-02-01T00:00:00.000Z' },
    ];
    expect(dedupeByCaseNo(items).map((i) => i.id)).toEqual(['2']);
  });

  it('只接 .csv；其它扩展名给固定文案（[C-36]）', () => {
    expect(isCaseMapCsvFile('a.CSV')).toBe(true);
    expect(isCaseMapCsvFile('a.xmind')).toBe(false);
    expect(isCaseMapCsvFile('a.xlsx')).toBe(false);
    expect(unsupportedFileMessage('a.csv')).toBe('');
    expect(unsupportedFileMessage('用例.xmind')).toBe(CASE_MAP_UNSUPPORTED_MSG);
    expect(unsupportedFileMessage('用例.xlsx')).toBe(CASE_MAP_UNSUPPORTED_MSG);
    expect(CASE_MAP_UNSUPPORTED_MSG).toBe('只支持规范化 CSV 导入，不支持 xmind/Excel 解析');
  });

  it('caseMapSummary 统计 file/method 与来源', () => {
    const items: CaseMapEntry[] = [
      { id: '1', caseNo: 'A', target: { kind: 'file', ref: 'a' }, source: 'csv', updatedAt: '' },
      { id: '2', caseNo: 'B', target: { kind: 'method', ref: 'a#m' }, source: 'manual', updatedAt: '' },
    ];
    expect(caseMapSummary(items)).toEqual({ total: 2, file: 1, method: 1, csv: 1, manual: 1 });
  });
});