import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getIndex, fuzzyMatch, preloadPinyin, isPinyinReady } from '../search';

beforeAll(async () => {
  // 拼音字典是异步 chunk，测试里要显式等它加载完
  await preloadPinyin();
});

describe('getIndex / fuzzyMatch', () => {
  it('空查询一律命中', () => {
    expect(fuzzyMatch('任意内容', '')).toBe(true);
    expect(fuzzyMatch('任意内容', '   ')).toBe(true);
  });

  it('原文、拼音首字母、全拼都能命中', () => {
    expect(isPinyinReady()).toBe(true);
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

  it('字典未加载时降级为原文匹配，不抛错、不误报', async () => {
    vi.resetModules();
    const fresh = await import('../search');
    expect(fresh.isPinyinReady()).toBe(false);
    // 原文仍能命中
    expect(fresh.fuzzyMatch('阿里云管理后台', '阿里')).toBe(true);
    expect(fresh.fuzzyMatch('阿里云管理后台', 'aly')).toBe(false);
    // 纯 ASCII 不受影响
    expect(fresh.fuzzyMatch('Hello-World', 'helloworld')).toBe(true);
  });
});
