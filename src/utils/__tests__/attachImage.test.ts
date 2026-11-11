import { describe, it, expect } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  base64Size,
  parseImageDataUrl,
  stampedImageName,
  sniffImageMime,
  buildImageDataUrl,
} from '../../../electron/attach-image.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const JPG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U';
const GIF = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

describe('base64Size', () => {
  it('按长度换算字节数，处理两种补位', () => {
    expect(base64Size('AAAA')).toBe(3);
    expect(base64Size('AAA=')).toBe(2);
    expect(base64Size('AA==')).toBe(1);
    expect(base64Size('')).toBe(0);
  });
});

describe('parseImageDataUrl', () => {
  it('接受 png 并给出扩展名与大小', () => {
    const r = parseImageDataUrl(`data:image/png;base64,${PNG}`);
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('image/png');
    expect(r.ext).toBe('png');
    expect(r.size).toBeGreaterThan(0);
    expect(r.base64).toBe(PNG);
  });

  it('jpeg 归一到 jpg 扩展名', () => {
    expect(parseImageDataUrl(`data:image/jpeg;base64,${JPG}`)).toMatchObject({ ok: true, ext: 'jpg' });
  });

  it('MIME 大小写不敏感', () => {
    expect(parseImageDataUrl(`data:IMAGE/PNG;base64,${PNG}`)).toMatchObject({ ok: true, mime: 'image/png' });
  });

  it('拒绝非图片 dataURL', () => {
    expect(parseImageDataUrl('data:text/plain;base64,aGVsbG8=')).toMatchObject({ ok: false });
    expect(parseImageDataUrl('data:application/pdf;base64,JVBERi0=')).toMatchObject({ ok: false });
  });

  it('拒绝空内容与非法输入', () => {
    expect(parseImageDataUrl('')).toMatchObject({ ok: false });
    expect(parseImageDataUrl('data:image/png;base64,')).toMatchObject({ ok: false });
    expect(parseImageDataUrl('not a data url')).toMatchObject({ ok: false });
    expect(parseImageDataUrl(null as any)).toMatchObject({ ok: false });
  });

  it('超过大小上限时报错', () => {
    // 每 4 个 base64 字符 3 字节，这里造一段刚超过上限的内容
    const big = 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8);
    const r = parseImageDataUrl(`data:image/png;base64,${big}`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('12MB');
  });

  it('容忍 base64 里的换行', () => {
    const wrapped = PNG.replace(/(.{20})/g, '$1\n');
    expect(parseImageDataUrl(`data:image/png;base64,${wrapped}`)).toMatchObject({ ok: true });
  });
});

describe('stampedImageName', () => {
  it('按本地时间生成可读文件名', () => {
    const d = new Date(2026, 10, 9, 18, 30, 45);
    expect(stampedImageName('png', d)).toBe('截图-20261109-183045.png');
  });

  it('补零到两位', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(stampedImageName('jpg', d)).toBe('截图-20260102-030405.jpg');
  });
});

describe('sniffImageMime', () => {
  it('识别常见图片文件头', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime('UklGRiQAAABXRUJQVlA4')).toBe('image/webp');
    expect(sniffImageMime('Qk1GAAAAAAAAADYAAAAo')).toBe('image/bmp');
  });

  it('认不出来返回空串', () => {
    expect(sniffImageMime('aGVsbG8gd29ybGQ=')).toBe('');
    expect(sniffImageMime('')).toBe('');
  });
});

describe('buildImageDataUrl', () => {
  it('拼回可直接给 img src 的地址', () => {
    expect(buildImageDataUrl('image/png', PNG)).toBe(`data:image/png;base64,${PNG}`);
  });

  it('缺参数返回空串', () => {
    expect(buildImageDataUrl('', PNG)).toBe('');
    expect(buildImageDataUrl('image/png', '')).toBe('');
  });
});