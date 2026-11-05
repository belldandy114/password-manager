import { describe, it, expect } from 'vitest';
import { guessMime, parseMultipartLine } from '../../../electron/multipart.js';

describe('multipart.guessMime 按扩展名猜 MIME', () => {
  it('图片/表格/压缩包都能认出来', () => {
    expect(guessMime('C:\\a\\b.JPG')).toBe('image/jpeg');
    expect(guessMime('/tmp/x.png')).toBe('image/png');
    expect(guessMime('报价单.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(guessMime('a.pdf')).toBe('application/pdf');
    expect(guessMime('a.zip')).toBe('application/zip');
  });

  it('认不出来的返回空串（由上层用 application/octet-stream）', () => {
    expect(guessMime('noext')).toBe('');
    expect(guessMime('a.unknown')).toBe('');
    expect(guessMime('')).toBe('');
  });
});

describe('multipart.parseMultipartLine 普通字段', () => {
  it('key=value 原样保留值里的空格与等号（不做 trim）', () => {
    const r = parseMultipartLine('declareInfo.applicationDeptName=   ');
    expect(r.ok).toBe(true);
    expect(r.key).toBe('declareInfo.applicationDeptName');
    expect(r.value).toBe('   ');
    expect(r.isFile).toBe(false);
  });

  it('值里带等号时只按第一个 = 切', () => {
    const r = parseMultipartLine('code=a=b=c');
    expect(r.key).toBe('code');
    expect(r.value).toBe('a=b=c');
  });

  it('没有 key 或没有 = 时 ok=false（调用方应忽略该行）', () => {
    expect(parseMultipartLine('').ok).toBe(false);
    expect(parseMultipartLine('=v').ok).toBe(false);
    expect(parseMultipartLine('noeq').ok).toBe(false);
  });
});

describe('multipart.parseMultipartLine 文件字段', () => {
  it('应用自己的写法：@路径，MIME 由扩展名推断', () => {
    const r = parseMultipartLine('files=@C:\\tmp\\4mb.jpg');
    expect(r.ok).toBe(true);
    expect(r.isFile).toBe(true);
    expect(r.filePath).toBe('C:\\tmp\\4mb.jpg');
    expect(r.mime).toBe('image/jpeg');
    expect(r.filename).toBe('');
  });

  it('curl -F 语法：@路径;type=...;filename=...', () => {
    const r = parseMultipartLine('files=@C:\\a\\b.bin;type=image/png;filename=pic.png');
    expect(r.isFile).toBe(true);
    expect(r.filePath).toBe('C:\\a\\b.bin');
    expect(r.mime).toBe('image/png');
    expect(r.filename).toBe('pic.png');
  });

  it('带引号的 type 也能解析', () => {
    const r = parseMultipartLine('f=@a.txt;type="text/plain"');
    expect(r.mime).toBe('text/plain');
  });

  it('只有 @ 没有路径时不崩（交给调用方报「文件不存在」）', () => {
    const r = parseMultipartLine('files=@');
    expect(r.ok).toBe(true);
    expect(r.isFile).toBe(true);
    expect(r.filePath).toBe('');
  });

  it('cURL 导入的占位值（@4mb.jpg）能被识别为文件，且推断出 jpg', () => {
    const r = parseMultipartLine('files=@4mb.jpg');
    expect(r.isFile).toBe(true);
    expect(r.filePath).toBe('4mb.jpg');
    expect(r.mime).toBe('image/jpeg');
  });
});