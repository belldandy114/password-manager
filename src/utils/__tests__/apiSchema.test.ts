import { describe, it, expect } from 'vitest';
import { buildSchema, diffSchema, schemaFromBody, isSameStructure } from '../apiSchema';
import { jsonToTsTypes, jsonToMarkdownTable, codegenFromBody } from '../apiCodegen';

describe('apiSchema.buildSchema', () => {
  it('区分基础类型与 null', () => {
    expect(buildSchema('x').t).toBe('string');
    expect(buildSchema(1).t).toBe('number');
    expect(buildSchema(true).t).toBe('boolean');
    expect(buildSchema(null).t).toBe('null');
  });

  it('数组元素字段不一致时取并集，类型冲突降级 mixed', () => {
    const s = buildSchema([{ a: 1 }, { a: 2, b: 'x' }]);
    expect(s.t).toBe('array');
    expect(s.item?.t).toBe('object');
    expect(Object.keys(s.item?.fields || {}).sort()).toEqual(['a', 'b']);

    const mixed = buildSchema([1, 'x']);
    expect(mixed.item?.t).toBe('mixed');
  });

  it('空数组是 array + mixed，不会崩', () => {
    const s = buildSchema([]);
    expect(s.t).toBe('array');
    expect(s.item?.t).toBe('mixed');
  });
});

describe('apiSchema.diffSchema', () => {
  const base = buildSchema({ code: 0, data: { list: [{ id: 1 }] } });

  it('结构完全一致时判定为干净', () => {
    const next = buildSchema({ code: 1, data: { list: [{ id: 99 }] } });
    const d = diffSchema(base, next);
    expect(isSameStructure(d)).toBe(true);
    // 只比类型：值从 0 变 1、id 从 1 变 99 都不算变化
    expect(d.changed).toHaveLength(0);
  });

  it('字段新增 / 删除 / 类型变化分别归类', () => {
    const next = buildSchema({ code: '0', data: { list: [{ id: 1, extra: true }] }, added: 1 });
    const d = diffSchema(base, next);
    expect(d.added).toContain('data.list[].extra');
    expect(d.added).toContain('added');
    expect(d.changed).toEqual([{ path: 'code', from: 'number', to: 'string' }]);
    expect(d.removed).toHaveLength(0);
  });

  it('字段被删要能检出', () => {
    const next = buildSchema({ code: 0 });
    const d = diffSchema(base, next);
    expect(d.removed).toContain('data');
    expect(d.removed).toContain('data.list');
  });
});

describe('apiSchema.schemaFromBody', () => {
  it('合法 JSON 出结构，非法返回 null', () => {
    expect(schemaFromBody('{"a":1}')?.t).toBe('object');
    expect(schemaFromBody('<html>')).toBeNull();
    expect(schemaFromBody('')).toBeNull();
  });
});

describe('apiCodegen.jsonToTsTypes', () => {
  it('生成嵌套接口，数组元素单独命名', () => {
    const ts = jsonToTsTypes({ code: 0, data: { list: [{ id: 1, name: 'a' }] } });
    expect(ts).toContain('export interface Root');
    expect(ts).toContain('export interface RootDataListItem');
    expect(ts).toContain('list: RootDataListItem[];');
    expect(ts).toContain('id: number;');
  });

  it('根就是数组时生成 RootItem + 类型别名', () => {
    const ts = jsonToTsTypes([{ id: 1 }]);
    expect(ts).toContain('export interface RootItem');
    expect(ts).toContain('export type Root = RootItem[];');
  });

  it('非法 key 用引号包起来，类型冲突降级 unknown', () => {
    const ts = jsonToTsTypes({ 'a-b': 1, mixed: [1, 'x'] });
    expect(ts).toContain('"a-b": number;');
    expect(ts).toContain('unknown');
  });
});

describe('apiCodegen.jsonToMarkdownTable', () => {
  it('对象数组转表格（列取并集）', () => {
    const md = jsonToMarkdownTable([{ id: 1, name: 'a' }, { id: 2, extra: 'x' }]);
    expect(md).toContain('| id | name | extra |');
    expect(md).toContain('| --- | --- | --- |');
    expect(md).toContain('| 1 | a |  |');
  });

  it('单元格里的竖线与换行不会把表格拆坏', () => {
    const md = jsonToMarkdownTable([{ note: 'a|b\nc' }]);
    expect(md).toContain('a\\|b c');
  });

  it('普通对象当一键值表，标量数组按一列展开', () => {
    expect(jsonToMarkdownTable({ a: 1 })).toContain('| 字段 | 值 |');
    expect(jsonToMarkdownTable(['x', 'y'])).toContain('| # | 值 |');
  });

  it('空数组给出可读提示而不是空表', () => {
    expect(jsonToMarkdownTable([])).toContain('空数组');
  });
});

describe('apiCodegen.codegenFromBody', () => {
  it('非 JSON 返回 null', () => {
    expect(codegenFromBody('<html>')).toBeNull();
  });

  it('同时给出 TS 与表格', () => {
    const r = codegenFromBody('{"a":1}');
    expect(r?.ts).toContain('export interface Root');
    expect(r?.md).toContain('| a | 1 |');
  });
});