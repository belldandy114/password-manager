import { describe, it, expect } from 'vitest';
import {
  detectDelimiter, parseDelimited, toDelimited, looksLikeHeader, readTable,
  redactColumns, columnLabel,
} from '../tableRedact';

describe('detectDelimiter', () => {
  it('按首行出现最多的分隔符判定', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c')).toBe(';');
  });

  it('引号里的分隔符不算', () => {
    expect(detectDelimiter('"a,b",c\n1,2')).toBe(',');
    expect(detectDelimiter('"a,b,c",d')).toBe(',');
  });

  it('没有分隔符时回落逗号', () => {
    expect(detectDelimiter('单列文本')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('parseDelimited', () => {
  it('解析基本表格', () => {
    expect(parseDelimited('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('处理引号包裹与双引号转义', () => {
    expect(parseDelimited('a,"b,c"\n"x""y",z')).toEqual([['a', 'b,c'], ['x"y', 'z']]);
  });

  it('处理字段内换行', () => {
    expect(parseDelimited('a,"line1\nline2"\nb,c')).toEqual([['a', 'line1\nline2'], ['b', 'c']]);
  });

  it('剥掉 BOM 并丢掉末尾空行', () => {
    expect(parseDelimited('\uFEFFa,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('保留空单元格', () => {
    expect(parseDelimited('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('toDelimited', () => {
  it('需要时加引号并转义', () => {
    expect(toDelimited([['a', 'b,c'], ['x"y', 'z']])).toBe('a,"b,c"\n"x""y",z');
  });

  it('制表符分隔时不转义逗号', () => {
    expect(toDelimited([['a,b', 'c']], '\t')).toBe('a,b\tc');
  });

  it('往返一致', () => {
    const rows = [['姓名', '手机号'], ['张三', '13800138000'], ['李四', 'a,b']];
    expect(parseDelimited(toDelimited(rows))).toEqual(rows);
  });
});

describe('looksLikeHeader / readTable', () => {
  it('全非数字首行判为表头', () => {
    expect(looksLikeHeader(['姓名', '手机号'])).toBe(true);
    expect(looksLikeHeader(['1', '2'])).toBe(false);
    expect(looksLikeHeader(['', ''])).toBe(false);
  });

  it('readTable 拆出表头与数据', () => {
    const t = readTable('姓名,手机号\n张三,13800138000');
    expect(t.hasHeader).toBe(true);
    expect(t.headers).toEqual(['姓名', '手机号']);
    expect(t.rows).toEqual([['张三', '13800138000']]);
    expect(t.delimiter).toBe(',');
  });

  it('无表头时 headers 为空、数据全在 rows', () => {
    const t = readTable('1,2\n3,4');
    expect(t.hasHeader).toBe(false);
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('空文本返回空表', () => {
    expect(readTable('')).toEqual({ headers: [], rows: [], delimiter: ',', hasHeader: false });
  });
});

describe('redactColumns', () => {
  const rows = [
    ['张三', '13800138000', '备注一'],
    ['李四', '13900139000', '备注二'],
  ];

  it('只脱敏指定列，其余列原样', () => {
    const r = redactColumns(rows, { columns: [1], kinds: ['phone'] });
    expect(r.rows[0][0]).toBe('张三');
    expect(r.rows[0][1]).toBe('138****8000');
    expect(r.rows[0][2]).toBe('备注一');
    expect(r.total).toBe(2);
  });

  it('perColumn 按列统计命中数', () => {
    const r = redactColumns(rows, { columns: [1], kinds: ['phone'] });
    expect(r.perColumn).toEqual([{ column: 1, hits: 2 }]);
  });

  it('未勾选的列即使含敏感信息也不动', () => {
    const r = redactColumns([['13800138000', 'x']], { columns: [1], kinds: ['phone'] });
    expect(r.rows[0][0]).toBe('13800138000');
    expect(r.total).toBe(0);
  });

  it('越界列下标被忽略', () => {
    const r = redactColumns(rows, { columns: [9], kinds: ['phone'] });
    expect(r.rows).toEqual(rows);
    expect(r.perColumn).toEqual([{ column: 9, hits: 0 }]);
  });

  it('token 风格产出映射表', () => {
    const r = redactColumns(rows, { columns: [1], kinds: ['phone'], style: 'token' });
    expect(r.rows[0][1]).toBe('[手机号#1]');
    expect(r.mapping).toContain('[手机号#1]=13800138000');
  });

  it('多列同时处理', () => {
    const r = redactColumns([['13800138000', 'a@b.com']], { columns: [0, 1], kinds: ['phone', 'email'] });
    expect(r.rows[0][0]).toBe('138****8000');
    expect(r.rows[0][1]).toBe('a***@b.com');
    expect(r.perColumn.map((p) => p.column)).toEqual([0, 1]);
  });

  it('空列选择不改变任何内容', () => {
    const r = redactColumns(rows, { columns: [], kinds: ['phone'] });
    expect(r.rows).toEqual(rows);
    expect(r.total).toBe(0);
  });
});

describe('columnLabel', () => {
  it('有表头用表头名', () => {
    expect(columnLabel(['姓名', '手机号'], 1)).toBe('手机号');
  });

  it('没有表头用第 N 列', () => {
    expect(columnLabel([], 0)).toBe('第 1 列');
    expect(columnLabel(['', 'x'], 0)).toBe('第 1 列');
  });
});
