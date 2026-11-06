import { describe, it, expect } from 'vitest';
import { getIndex, fuzzyMatch } from '../search';

describe('getIndex / fuzzyMatch', () => {
  it('空查询一律命中', () => {
    expect(fuzzyMatch('任意内容', '')).toBe(true);
    expect(fuzzyMatch('任意内容', '   ')).toBe(true);
  });

  it('原文、拼音首字母、全拼都能命中', () => {
    expect(fuzzyMatch('阿里云管理后台', '阿里')).toBe(true);
    expect(fuzzyMatch('阿里云管理后台', 'aly')).toBe(true);
    expect(fuzzyMatch('阿里云管理后台', 'ali')).toBe(true);
  });

  it('无关关键词不命中', () => {
    expect(fuzzyMatch('阿里云管理后台', 'zzzz')).toBe(false);
  });

  it('纯 ASCII 文本索引包含自身小写', () => {
    const idx = getIndex('Hello-World');
    expect(idx.lower).toBe('hello-world');
    expect(idx.initials).toBe('helloworld');
  });
});
