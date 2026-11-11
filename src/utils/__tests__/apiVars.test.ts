import { describe, it, expect } from 'vitest';
import { parseVarLines, applyVars, readJsonPath, mergeVarPool } from '../apiVars';

describe('parseVarLines', () => {
  it('按第一个等号切分，值里可以有等号', () => {
    expect(parseVarLines('a=1\nb=x=y')).toEqual({ a: '1', b: 'x=y' });
  });

  it('忽略空行与没有等号的行', () => {
    expect(parseVarLines('\n  \nfoo\n=oops')).toEqual({});
  });

  it('键值两侧空白被去掉', () => {
    expect(parseVarLines('  token  =  abc  ')).toEqual({ token: 'abc' });
  });
});

describe('applyVars', () => {
  it('替换 {{name}} 与 {{ name }}', () => {
    expect(applyVars('{{a}}/{{ b }}', 'a=1\nb=2')).toBe('1/2');
  });

  it('没定义的变量原样保留，方便看出拼错', () => {
    expect(applyVars('{{nope}}', 'a=1')).toBe('{{nope}}');
  });

  it('值里带 {{}} 不递归展开（避免自引用死循环）', () => {
    expect(applyVars('{{a}}', 'a={{b}}\nb=2')).toBe('{{b}}');
  });

  it('空文本不炸', () => {
    expect(applyVars('', 'a=1')).toBe('');
  });
});

describe('readJsonPath', () => {
  const body = { data: { token: 'tk-1', list: [{ id: 7 }, { id: 8 }] }, ok: true, nil: null };

  it('取顶层字段', () => {
    expect(readJsonPath(body, 'ok')).toBe('true');
  });

  it('取嵌套字段', () => {
    expect(readJsonPath(body, 'data.token')).toBe('tk-1');
  });

  it('取数组下标', () => {
    expect(readJsonPath(body, 'data.list[1].id')).toBe('8');
  });

  it('取对象时序列化成 JSON', () => {
    expect(readJsonPath(body, 'data.list[0]')).toBe('{"id":7}');
  });

  it('路径不存在 / 值为 null / 中途不是对象 → undefined', () => {
    expect(readJsonPath(body, 'data.missing')).toBeUndefined();
    expect(readJsonPath(body, 'nil')).toBeUndefined();
    expect(readJsonPath(body, 'ok.deeper')).toBeUndefined();
    expect(readJsonPath(null, 'a')).toBeUndefined();
  });

  it('空路径返回 undefined', () => {
    expect(readJsonPath(body, '   ')).toBeUndefined();
  });
});

describe('mergeVarPool', () => {
  it('变量池覆盖同名键', () => {
    expect(parseVarLines(mergeVarPool('a=1\nb=2', { b: '9' }))).toEqual({ a: '1', b: '9' });
  });

  it('只有变量池时也成立', () => {
    expect(parseVarLines(mergeVarPool('', { token: 'x' }))).toEqual({ token: 'x' });
  });
});
