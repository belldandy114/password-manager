import { describe, it, expect } from 'vitest';
import { normalizeForDiff, diffLines, diffTexts } from '../textDiff';

const unchanged = (pairs: Array<[string, string, Parameters<typeof normalizeForDiff>[1]]>) => {
  for (const [a, b, opts] of pairs) {
    expect(diffLines(normalizeForDiff(a, opts), normalizeForDiff(b, opts)).every(l => l.type === 'same')).toBe(true);
  }
};

describe('normalizeForDiff', () => {
  it('统一 CRLF / CR 与 LF，避免 Windows 复制过来的文本全篇标红', () => {
    expect(normalizeForDiff('a\r\nb\rc')).toBe('a\nb\nc');
    unchanged([['a\nb', 'a\r\nb', {}]]);
  });

  it('ignoreWs 会消掉缩进、行尾空白和行内连续空白', () => {
    expect(normalizeForDiff('  a   b \n\t c', { ignoreWs: true })).toBe('a b\nc');
    unchanged([
      ['a\n  b', 'a\nb', { ignoreWs: true }],
      ['a b', '  a\t\tb   ', { ignoreWs: true }],
    ]);
  });

  it('ignoreWs 顺带忽略末尾换行 / 空白行（编辑器最常见的噪声）', () => {
    expect(normalizeForDiff('a\n\n  \n', { ignoreWs: true })).toBe('a');
    unchanged([
      ['a\n', 'a', { ignoreWs: true }],
      ['a\r\n', 'a\n\n', { ignoreWs: true }],
    ]);
  });

  it('ignoreCase 只影响字母，且可与 ignoreWs 叠加', () => {
    expect(normalizeForDiff(' AbC ', { ignoreWs: true, ignoreCase: true })).toBe('abc');
    unchanged([['Hello World', '  hello   world  ', { ignoreWs: true, ignoreCase: true }]]);
  });

  it('不开选项时保持原样（含缩进）', () => {
    expect(normalizeForDiff('  a\tb \r\n')).toBe('  a\tb \n');
    expect(diffLines(normalizeForDiff('  a'), normalizeForDiff('a')).filter(l => l.type !== 'same')).toHaveLength(2);
  });
});

describe('diffLines', () => {
  it('逐行报新增 / 删除 / 相同', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('两边相同时直接返回全部 same（归一化后判等是最常见路径）', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('超大文本给提示而不是分配巨型 DP 表', () => {
    const huge = 'x\n'.repeat(2000);
    const out = diffLines(huge, huge);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('文本过大');
  });
});

describe('diffTexts（按归一化值比较、展示原文）', () => {
  it('ignoreWs 下相同行保留左侧原始缩进，不再显示被压过的文本', () => {
    expect(diffTexts('  a\n\tb  ', 'a\nb', { ignoreWs: true })).toEqual([
      { type: 'same', text: '  a' },
      { type: 'same', text: '\tb  ' },
    ]);
  });

  it('ignoreCase 下相同行保留原始大小写', () => {
    expect(diffTexts('Hello World', 'hello   world', { ignoreWs: true, ignoreCase: true })).toEqual([
      { type: 'same', text: 'Hello World' },
    ]);
  });

  it('新增 / 删除行也展示各自原文', () => {
    expect(diffTexts('  a\n  old', 'a\n  new  ', { ignoreWs: true })).toEqual([
      { type: 'same', text: '  a' },
      { type: 'del', text: '  old' },
      { type: 'add', text: '  new  ' },
    ]);
  });

  it('不开选项时原文照搬，且缩进不同仍判为差异', () => {
    expect(diffTexts('  a', 'a')).toEqual([
      { type: 'del', text: '  a' },
      { type: 'add', text: 'a' },
    ]);
  });

  it('末尾空白行被忽略，但结果行数与归一化字符串一致', () => {
    expect(diffTexts('  a\n\n  \n', 'a', { ignoreWs: true })).toEqual([
      { type: 'same', text: '  a' },
    ]);
    expect(diffTexts('   \n  ', '', { ignoreWs: true })).toEqual([
      { type: 'same', text: '   ' },
    ]);
  });

  it('CRLF 只作行分隔符，不会把 \\r 带进展示文本', () => {
    expect(diffTexts('  a\r\n  b', 'a\nb', { ignoreWs: true })).toEqual([
      { type: 'same', text: '  a' },
      { type: 'same', text: '  b' },
    ]);
  });

  it('比较结果与旧的「先归一化再 diff」完全同构（只换展示文本）', () => {
    const cases: Array<[string, string, Parameters<typeof normalizeForDiff>[1]]> = [
      ['a\nb', 'a\nx\nc', {}],
      ['  a  \r\nb', 'a\r\n  c', { ignoreWs: true }],
      ['a\n\n', 'a', { ignoreWs: true }],
      ['   \n  ', '', { ignoreWs: true }],
      ['A\nb', 'a\nB', { ignoreCase: true }],
      ['a\r\nb', 'a\nb', {}],
      ['a\n\n\nb', 'a\nb', { ignoreWs: true }],
      ['  Hello  ', 'hello', { ignoreWs: true, ignoreCase: true }],
    ];
    for (const [a, b, opts] of cases) {
      const oldWay = diffLines(normalizeForDiff(a, opts), normalizeForDiff(b, opts));
      const newWay = diffTexts(a, b, opts);
      expect(newWay.map(l => l.type), `${a} / ${b}`).toEqual(oldWay.map(l => l.type));
      expect(newWay).toHaveLength(oldWay.length);
    }
  });

  it('超大文本同样给提示而不是分配巨型 DP 表', () => {
    const huge = 'x\n'.repeat(2000);
    const out = diffTexts(huge, huge, { ignoreWs: true });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('文本过大');
  });
});
