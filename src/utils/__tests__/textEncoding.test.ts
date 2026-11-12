import { describe, it, expect } from 'vitest';
import { decodeTextBuffer, encodingLabel } from '../../../electron/text-encoding.js';

/** 把字符串按 GBK 编成字节（Node 的 Buffer 不支持 gbk，这里手工查表太麻烦，直接用已知字节） */
const GBK_NAME_PHONE = Buffer.from([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb5, 0xe7, 0xbb, 0xb0]); // 姓名,电话

describe('decodeTextBuffer', () => {
  it('纯 ASCII 按 UTF-8 解', () => {
    const r = decodeTextBuffer(Buffer.from('name,phone\nA,1\n', 'utf8'));
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('name,phone\nA,1\n');
  });

  it('UTF-8 中文正常解出，不误判成 GBK', () => {
    const r = decodeTextBuffer(Buffer.from('姓名,电话\n张三,13800138000\n', 'utf8'));
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toContain('张三');
  });

  it('GBK 字节回落 GB18030 并解出中文', () => {
    const r = decodeTextBuffer(GBK_NAME_PHONE);
    expect(r.encoding).toBe('gb18030');
    expect(r.text).toBe('姓名,电话');
  });

  it('带 UTF-8 BOM 时剥掉 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('姓名', 'utf8')]);
    const r = decodeTextBuffer(buf);
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('姓名');
  });

  it('带 UTF-16LE BOM 时按 UTF-16LE 解', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('姓名', 'utf16le')]);
    const r = decodeTextBuffer(buf);
    expect(r.encoding).toBe('utf-16le');
    expect(r.text).toBe('姓名');
  });

  it('空文件返回空串', () => {
    expect(decodeTextBuffer(Buffer.alloc(0))).toEqual({ text: '', encoding: 'utf-8' });
  });

  it('两种编码都不合法时仍返回字符串（宽松 UTF-8），不抛错', () => {
    const r = decodeTextBuffer(Buffer.from([0xff, 0xff, 0xff]));
    expect(typeof r.text).toBe('string');
    expect(r.encoding).toBe('utf-8');
  });

  it('接受 Uint8Array', () => {
    const r = decodeTextBuffer(new Uint8Array(GBK_NAME_PHONE));
    expect(r.text).toBe('姓名,电话');
  });
});

describe('encodingLabel', () => {
  it('GB18030 / GBK / GB2312 都显示成 GBK', () => {
    expect(encodingLabel('gb18030')).toBe('GBK');
    expect(encodingLabel('GBK')).toBe('GBK');
    expect(encodingLabel('gb2312')).toBe('GBK');
  });

  it('UTF-16 两种字节序都显示成 UTF-16', () => {
    expect(encodingLabel('utf-16le')).toBe('UTF-16');
    expect(encodingLabel('utf-16be')).toBe('UTF-16');
  });

  it('其它一律 UTF-8', () => {
    expect(encodingLabel('utf-8')).toBe('UTF-8');
    expect(encodingLabel('')).toBe('UTF-8');
  });
});
