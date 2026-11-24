import { describe, it, expect } from 'vitest';
import {
  TDG_LIMITS, textBytes, createWriterState, openChunk, headersOf, encodeRows, closeChunk,
} from '../../../electron/tdg-write.js';
import { parseCsv } from '../../../electron/csv.js';

/**
 * 2.2 流式写盘的纯函数层（契约 C-65 ~ C-69 / 拆分 S-57〜S-60）。
 *
 * 这里测的是「给一批字符串，拼出来的文件对不对」，**不是**造数算法（那是渲染层 W3 的）。
 * 重点在跨批：第 1 批末尾与第 2 批开头拼起来不能多一个也不能少一个分隔符——
 * 这类错在界面上完全看不出来，只有把三批拼回去反解才能发现。
 */

describe('tdg-write.textBytes 按 UTF-8 字节数，不是字符数', () => {
  it('ASCII 1 字节、中文 3 字节、emoji 4 字节、空串 0', () => {
    expect(textBytes('')).toBe(0);
    expect(textBytes('abc')).toBe(3);
    expect(textBytes('中文')).toBe(6);
    expect(textBytes('😀')).toBe(4);
    // 这条是防「用 .length 当字节数」的守卫：6 个中文是 6 个字符但 18 字节
    expect('中文测试数据'.length).toBe(6);
    expect(textBytes('中文测试数据')).toBe(18);
  });
});

describe('tdg-write.createWriterState / openChunk / headersOf 起始状态', () => {
  it('createWriterState 给出格式/列/BOM 与零计数；默认上限等于 TDG_LIMITS', () => {
    const s = createWriterState({ format: 'csv', columns: ['a', 'b'], bom: true });
    expect(s).toMatchObject({ format: 'csv', rows: 0, bytes: 0, batches: 0, closed: false });
    expect(TDG_LIMITS).toEqual({
      maxRowsPerBatch: 5000, maxLineBytes: 64 * 1024, maxRows: 1000000, maxBytes: 512 * 1024 * 1024,
    });
  });

  it('openChunk：csv 带 BOM 出 \\uFEFF、不带 BOM 出空串、json 出 [、txt 出空串', () => {
    expect(openChunk(createWriterState({ format: 'csv', bom: true }), 'csv')).toBe('\uFEFF');
    expect(openChunk(createWriterState({ format: 'csv', bom: false }), 'csv')).toBe('');
    expect(openChunk(createWriterState({ format: 'json' }), 'json')).toBe('[');
    expect(openChunk(createWriterState({ format: 'txt' }), 'txt')).toBe('');
  });

  it('headersOf：csv 出表头行 + \\r\\n（列名按 CSV 规则转义），json/txt 与缺列都是空串', () => {
    expect(headersOf(['编号', '备注'], 'csv')).toBe('编号,备注\r\n');
    expect(headersOf(['a', 'b,c'], 'csv')).toBe('a,"b,c"\r\n');
    expect(headersOf(['a'], 'json')).toBe('');
    expect(headersOf(['a'], 'txt')).toBe('');
    expect(headersOf(undefined as unknown as string[], 'csv')).toBe('');
  });
});

describe('tdg-write.encodeRows CSV：跨批分隔符与 RFC4180 转义', () => {
  const state = () => createWriterState({ format: 'csv', columns: ['id', 'name'] });

  it('单批两行：每行都以 \\r\\n 结尾，bytes 等于 text 的 UTF-8 字节数', () => {
    const s = state();
    const r = encodeRows([['1', '张三'], ['2', '李四']], s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('1,张三\r\n2,李四\r\n');
    expect(r.rows).toBe(2);
    expect(r.bytes).toBe(textBytes(r.text));
    // 手算：'1,张三\r\n' = 1 + 1 + 6 + 2 = 10 字节；两行共 20
    expect(textBytes(r.text)).toBe(20);
  });

  it('跨批逗号：三批拼起来每行恰好一个 \\r\\n，不出现空行也不粘连', () => {
    const s = state();
    const header = headersOf(['id', 'name'], 'csv');
    const a = encodeRows([['1', 'a'], ['2', 'b']], s);
    const b = encodeRows([['3', 'c']], s);
    const c = encodeRows([['4', 'd'], ['5', 'e']], s);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    if (!a.ok || !b.ok || !c.ok) return;
    const whole = header + a.text + b.text + c.text;
    expect(whole).toBe('id,name\r\n1,a\r\n2,b\r\n3,c\r\n4,d\r\n5,e\r\n');
    // 机械判据：按 \r\n 切完最后一段必须是空串（否则末行缺行尾），且没有 '' 中间行
    const lines = whole.split('\r\n');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines.slice(0, -1).every((x) => x !== '')).toBe(true);
    expect(lines.slice(0, -1)).toHaveLength(6); // 表头 + 5 行
    expect(s.rows).toBe(5);
  });

  it('字段内带逗号 / 双引号 / 换行：按 RFC4180 加引号并把内部引号翻倍', () => {
    const s = createWriterState({ format: 'csv', columns: ['a', 'b'] });
    const r = encodeRows([
      ['x,y', 'plain'],
      ['he said "hi"', 'z'],
      ['line1\r\nline2', 'w'],
    ], s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('"x,y",plain\r\n"he said ""hi""",z\r\n"line1\r\nline2",w\r\n');
  });

  it('核心：三批拼回后 parseCsv 反解，行数与字段值必须与输入完全一致', () => {
    const s = createWriterState({ format: 'csv', columns: ['id', 'note'] });
    const batches: string[][][] = [
      [['1', 'a,b'], ['2', 'he said "hi"']],
      [['3', '中文一行'], ['4', 'x']],
      [['5', 'line1\r\nline2'], ['6', '']],
    ];
    let whole = headersOf(['id', 'note'], 'csv');
    const expected: string[][] = [['id', 'note']];
    for (const batch of batches) {
      const r = encodeRows(batch, s);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      whole += r.text;
      for (const row of batch) expected.push(row);
    }
    const parsed = parseCsv(whole);
    expect(parsed).toEqual(expected);
    expect(parsed.length).toBe(7); // 表头 + 6 行
    expect(s.rows).toBe(6);
  });
});

describe('tdg-write.encodeRows JSON / TXT 的批次边界', () => {
  it('JSON：三批拼出来是合法数组，记录数与内容都对（跨批逗号不多不少）', () => {
    const s = createWriterState({ format: 'json', columns: ['id', 'name'] });
    const open = openChunk(s, 'json');
    const a = encodeRows([['1', 'a'], ['2', 'b']], s);
    const b = encodeRows([['3', 'c']], s);
    const c = encodeRows([['4', 'd']], s);
    if (!a.ok || !b.ok || !c.ok) throw new Error('encode 失败');
    const whole = open + a.text + b.text + c.text + closeChunk(s);
    const parsed = JSON.parse(whole) as Array<{ id: string; name: string }>;
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ id: '1', name: 'a' });
    expect(parsed[3]).toEqual({ id: '4', name: 'd' });
    // 记录之间只能有一个逗号：',,' 就是跨批拼错
    expect(whole).not.toContain(',,');
  });

  it('JSON：零批次时 closeChunk 给出空数组，不是「[\\n]」这种脏东西', () => {
    const s = createWriterState({ format: 'json' });
    const whole = openChunk(s, 'json') + closeChunk(s);
    expect(JSON.parse(whole)).toEqual([]);
  });

  it('TXT：每行以 \\n 结尾，不做转义（原样保留逗号与引号）', () => {
    const s = createWriterState({ format: 'txt' });
    const r = encodeRows(['a,b', 'he said "hi"'], s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('a,b\nhe said "hi"\n');
    expect(closeChunk(s)).toBe('');
  });
});

describe('tdg-write 四项上限：拒绝时状态不被污染', () => {
  it('单批 > 5000 行 → batch-rows，且累计计数不动', () => {
    const s = createWriterState({ format: 'csv' });
    const rows = Array.from({ length: 5001 }, (_, i) => [`${i}`]);
    const r = encodeRows(rows, s);
    expect(r).toMatchObject({ ok: false, reason: 'batch-rows' });
    expect(s.rows).toBe(0);
    expect(s.batches).toBe(0);
    expect(s.bytes).toBe(0);
  });

  it('单行 > 64 KB → line-bytes，且累计计数不动', () => {
    const s = createWriterState({ format: 'csv' });
    const big = 'x'.repeat(64 * 1024 + 1);
    const r = encodeRows([[big]], s);
    expect(r).toMatchObject({ ok: false, reason: 'line-bytes' });
    expect(s.rows).toBe(0);
  });

  it('累计行超上限 → rows-cap；拒绝后 writer 仍可用（下一批正常写入）', () => {
    const s = createWriterState({ format: 'csv', limits: { maxRows: 3 } });
    expect(encodeRows([['1'], ['2'], ['3']], s).ok).toBe(true);
    const over = encodeRows([['4']], s);
    expect(over).toMatchObject({ ok: false, reason: 'rows-cap' });
    expect(s.rows).toBe(3); // 计数没有被污染
    // 拒绝之后仍然可以继续用（状态没坏），但已到上限，再写还是会被拒
    expect(encodeRows([['5']], s)).toMatchObject({ ok: false, reason: 'rows-cap' });
    expect(s.rows).toBe(3);
  });

  it('累计字节超上限 → bytes-cap，累计字节不回退', () => {
    const s = createWriterState({ format: 'csv', limits: { maxBytes: 10 } });
    expect(encodeRows([['1234']], s).ok).toBe(true); // 6 字节（含 \r\n）
    const over = encodeRows([['56789']], s); // 再加 7 字节 → 13 > 10
    expect(over).toMatchObject({ ok: false, reason: 'bytes-cap' });
    expect(s.bytes).toBe(6);
  });

  it('空批：ok 且不改任何计数（不能让 JSON 的逗号被空批吃掉）', () => {
    const s = createWriterState({ format: 'json', columns: ['a'] });
    const r = encodeRows([], s);
    expect(r).toMatchObject({ ok: true, text: '', rows: 0, bytes: 0 });
    expect(s.batches).toBe(0);
    const first = encodeRows([['1']], s);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text.startsWith(',')).toBe(false); // 空批没把批次序号占掉
  });

  it('未知格式 / 已关闭的 writer → 明确 reason，不抛异常', () => {
    const bad = createWriterState({ format: 'xlsx' as unknown as 'csv' });
    expect(encodeRows([['1']], bad)).toMatchObject({ ok: false, reason: 'bad-format' });
    const s = createWriterState({ format: 'csv' });
    s.closed = true;
    expect(encodeRows([['1']], s)).toMatchObject({ ok: false, reason: 'closed' });
    expect(closeChunk(null as unknown as ReturnType<typeof createWriterState>)).toBe('');
  });
});