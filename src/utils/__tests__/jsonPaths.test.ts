import { describe, it, expect } from 'vitest';
import { flattenJsonPaths, upsertVariable } from '../../../electron/json-paths.js';

describe('json-paths：从响应里找可提取字段', () => {
  const resp = {
    code: 200,
    msg: 'ok',
    data: {
      token: 'abc.def.ghi',
      user: { id: 7, name: '张三', admin: true, deleted: null },
      list: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }],
      tags: [],
    },
  };

  it('把叶子字段展开成「点号路径 + 完整值」', () => {
    const leaves = flattenJsonPaths(resp);
    const byPath = Object.fromEntries(leaves.map(l => [l.path, l.value]));
    expect(byPath['code']).toBe('200');
    expect(byPath['data.token']).toBe('abc.def.ghi');
    expect(byPath['data.user.name']).toBe('张三');
    expect(byPath['data.user.admin']).toBe('true');
    expect(byPath['data.user.deleted']).toBe('null');
    expect(byPath['data.list.0.title']).toBe('A');
  });

  it('name 取路径最后一段（默认变量名）', () => {
    const token = flattenJsonPaths(resp).find(l => l.path === 'data.token')!;
    expect(token.name).toBe('token');
    expect(token.type).toBe('string');
  });

  it('数组元素最多展开 5 个（避免超大列表刷屏）', () => {
    const big = { list: Array.from({ length: 20 }, (_, i) => ({ id: i })) };
    const leaves = flattenJsonPaths(big).filter(l => l.path.startsWith('list.'));
    expect(leaves.length).toBe(5);
  });

  it('max 限制总条数', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(flattenJsonPaths(many, { max: 10 }).length).toBe(10);
  });

  it('长字符串只在展示层截断，值保持完整', () => {
    const long = 'x'.repeat(200);
    const leaf = flattenJsonPaths({ token: long }, { maxStringShow: 20 })[0];
    expect(leaf.value).toBe(long);
    expect(leaf.preview.length).toBeLessThan(30);
  });

  it('空对象 / 非对象输入不炸', () => {
    expect(flattenJsonPaths({})).toEqual([]);
    expect(flattenJsonPaths(null)).toEqual([]);
  });
});

describe('json-paths：写入变量表', () => {
  it('追加一行', () => {
    expect(upsertVariable('a=1', 'token', 'abc')).toBe('a=1\ntoken=abc');
  });

  it('同名覆盖而不是重复', () => {
    expect(upsertVariable('token=old\nb=2', 'token', 'new')).toBe('b=2\ntoken=new');
  });

  it('空变量表 / 空名字安全', () => {
    expect(upsertVariable('', 'token', 'v')).toBe('token=v');
    expect(upsertVariable('a=1', '  ', 'v')).toBe('a=1');
  });
});
