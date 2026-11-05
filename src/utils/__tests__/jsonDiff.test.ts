import { describe, it, expect } from 'vitest';
import { diffJson, diffToText, formatDiffValue } from '../../utils/jsonDiff';

describe('diffJson', () => {
  it('相同对象没有差异', () => {
    expect(diffJson({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('key 顺序不同不算差异', () => {
    expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('改值只报那一条，路径带层级', () => {
    const d = diffJson({ data: { list: [{ id: 1, name: '甲' }] } }, { data: { list: [{ id: 1, name: '乙' }] } });
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('data.list[0].name');
    expect(d[0].kind).toBe('changed');
    expect(d[0].before).toBe('甲');
    expect(d[0].after).toBe('乙');
  });

  it('新增/删除 key 分别标记', () => {
    const d = diffJson({ a: 1 }, { b: 2 });
    expect(d.find((x) => x.path === 'a')?.kind).toBe('removed');
    expect(d.find((x) => x.path === 'b')?.kind).toBe('added');
  });

  it('数组长度变化报新增/删除', () => {
    const d = diffJson([1, 2], [1, 2, 3]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ path: '$[2]', kind: 'added', after: 3 });
  });

  it('类型变化算 changed（不是拆开递归）', () => {
    const d = diffJson({ a: 1 }, { a: '1' });
    expect(d[0]).toMatchObject({ path: 'a', kind: 'changed' });
  });

  it('null 与对象区分', () => {
    expect(diffJson({ a: null }, { a: { x: 1 } })[0].kind).toBe('changed');
  });
});

describe('diffToText', () => {
  it('无差异给提示', () => {
    expect(diffToText([])).toBe('（没有差异）');
  });

  it('三种标记符号', () => {
    const txt = diffToText([
      { path: 'a', kind: 'added', after: 1 },
      { path: 'b', kind: 'removed', before: 2 },
      { path: 'c', kind: 'changed', before: 3, after: 4 },
    ]);
    expect(txt).toContain('+ a = 1');
    expect(txt).toContain('- b = 2');
    expect(txt).toContain('~ c: 3 → 4');
  });
});

describe('formatDiffValue', () => {
  it('长字符串截断并加省略号', () => {
    const s = formatDiffValue('x'.repeat(500));
    expect(s.length).toBeLessThan(200);
    expect(s.endsWith('…')).toBe(true);
  });

  it('对象与 null 可读化', () => {
    expect(formatDiffValue({ a: 1 })).toBe('{"a":1}');
    expect(formatDiffValue(null)).toBe('null');
  });
});