import { describe, it, expect } from 'vitest';
import { ATT_PREFIX, attImageMarkdown, extractAttIds, matchAttImage } from '../attachRefs';

describe('attImageMarkdown / extractAttIds', () => {
  it('生成可被自己解析回来的图片语法', () => {
    const md = attImageMarkdown('abc-123', '登录截图');
    expect(md).toBe('![登录截图](pm-att:abc-123)');
    expect(extractAttIds(md)).toEqual(['abc-123']);
  });

  it('alt 里的方括号被去掉，避免破坏语法', () => {
    expect(attImageMarkdown('id1', '图[1]')).toBe('![图1](pm-att:id1)');
  });

  it('多个附件去重且保持出现顺序', () => {
    const md = `${attImageMarkdown('b')}\n${attImageMarkdown('a')}\n${attImageMarkdown('b')}`;
    expect(extractAttIds(md)).toEqual(['b', 'a']);
  });

  it('没有附件时返回空数组', () => {
    expect(extractAttIds('普通文本 ![x](https://a/b.png)')).toEqual([]);
    expect(extractAttIds('')).toEqual([]);
  });

  it('前缀常量与语法一致', () => {
    expect(ATT_PREFIX).toBe('pm-att:');
  });
});

describe('matchAttImage', () => {
  it('整行是附件图片时命中', () => {
    expect(matchAttImage('![截图](pm-att:9f8e-1)')).toEqual({ alt: '截图', id: '9f8e-1' });
  });

  it('前后有空格也命中', () => {
    expect(matchAttImage('  ![](pm-att:x1)  ')).toEqual({ alt: '', id: 'x1' });
  });

  it('行内混着文字不算', () => {
    expect(matchAttImage('看图 ![x](pm-att:a) 就明白了')).toBeNull();
  });

  it('普通链接图片不算附件', () => {
    expect(matchAttImage('![x](https://example.com/a.png)')).toBeNull();
  });

  it('空行返回 null', () => {
    expect(matchAttImage('')).toBeNull();
  });
});