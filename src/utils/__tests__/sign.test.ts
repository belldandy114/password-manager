import { describe, it, expect } from 'vitest';
import { computeSign, buildSigningInput, parseSignParams } from '../../utils/sign';
import { md5 } from '../../utils/md5';

describe('md5', () => {
  it('空串与已知向量', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('中文按 UTF-8 摘要', () => {
    expect(md5('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
  });
});

describe('parseSignParams', () => {
  it('k=v 多行', () => {
    const r = parseSignParams('a=1\nb=2');
    expect(r.ok && r.pairs).toEqual([['a', '1'], ['b', '2']]);
  });

  it('注释与空行忽略', () => {
    const r = parseSignParams('# c\n\na=1');
    expect(r.ok && r.pairs).toEqual([['a', '1']]);
  });

  it('JSON 对象也支持', () => {
    const r = parseSignParams('{"a":1,"b":null}');
    expect(r.ok && r.pairs).toEqual([['a', '1'], ['b', '']]);
  });

  it('缺 = 报错带行号', () => {
    const r = parseSignParams('a=1\nbad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/第 2 行/);
  });
});

describe('buildSigningInput', () => {
  it('kv 模式按 key 排序并追加 key=secret', () => {
    const r = buildSigningInput({ params: 'b=2\na=1', secret: 'sec' });
    expect(r.signingInput).toBe('a=1&b=2&key=sec');
  });

  it('concat 模式只拼值', () => {
    const r = buildSigningInput({ params: 'b=2\na=1', secret: 'sec', mode: 'concat' });
    expect(r.signingInput).toBe('12&key=sec');
  });

  it('secret 放前面', () => {
    const r = buildSigningInput({ params: 'a=1', secret: 'sec', secretAt: 'start' });
    expect(r.signingInput).toBe('seca=1');
  });

  it('不拼 secret', () => {
    const r = buildSigningInput({ params: 'a=1', secret: 'sec', secretAt: 'none' });
    expect(r.signingInput).toBe('a=1');
  });

  it('符号串可配置（有些接口用 & 之外的）', () => {
    const r = buildSigningInput({ params: 'a=1\nb=2', secret: 's', separator: '' });
    expect(r.signingInput).toBe('a=1b=2key=s');
  });
});

describe('computeSign', () => {
  it('md5 + kv', async () => {
    const r = await computeSign({ params: 'a=1', secret: 'sec' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.signingInput).toBe('a=1&key=sec');
      expect(r.sign).toBe(md5('a=1&key=sec'));
    }
  });

  it('大写输出', async () => {
    const r = await computeSign({ params: 'a=1', secret: 'sec', upper: true });
    if (r.ok) expect(r.sign).toBe(md5('a=1&key=sec').toUpperCase());
  });

  it('sha256 长度 64', async () => {
    const r = await computeSign({ params: 'a=1', secret: 'sec', algo: 'sha256' });
    if (r.ok) expect(r.sign).toMatch(/^[0-9a-f]{64}$/);
  });

  it('参数错误原样返回错误', async () => {
    const r = await computeSign({ params: 'oops', secret: 's' });
    expect(r.ok).toBe(false);
  });
});