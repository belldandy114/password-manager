import { describe, it, expect } from 'vitest';
import {
  hexToRgb, rgbToHex, luminance, contrast, shift, ensureReadableOnWhiteText, pickDominantColor,
} from '../accent';

describe('accent 颜色工具', () => {
  it('hex 解析支持 #rgb / #rrggbb / 无 #', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('4f9d99')).toEqual({ r: 79, g: 157, b: 153 });
    expect(hexToRgb('#zzz')).toBeNull();
    expect(rgbToHex({ r: 79, g: 157, b: 153 })).toBe('#4f9d99');
  });

  it('黑白对比度是 21，同色是 1', () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(Math.round(contrast(white, black))).toBe(21);
    expect(contrast(white, white)).toBe(1);
    expect(luminance(white)).toBeCloseTo(1, 5);
  });

  it('shift 变亮/变暗都落在 hex 范围内', () => {
    expect(shift('#808080', 0.5)).toBe('#c0c0c0');
    expect(shift('#808080', -0.5)).toBe('#404040');
  });

  it('ensureReadableOnWhiteText 会把太亮的颜色压暗到 AA', () => {
    const white = { r: 255, g: 255, b: 255 };
    const out = ensureReadableOnWhiteText('#ffe066');
    const rgb = hexToRgb(out)!;
    expect(contrast(rgb, white)).toBeGreaterThanOrEqual(4.5);
    // 本来就够暗的不动
    expect(ensureReadableOnWhiteText('#1f2937')).toBe('#1f2937');
  });

  it('pickDominantColor 忽略近黑近灰，选出彩色主色', () => {
    const px: number[] = [];
    // 200 个白像素
    for (let i = 0; i < 200; i += 1) px.push(250, 250, 250, 255);
    // 100 个绿色像素
    for (let i = 0; i < 100; i += 1) px.push(16, 185, 129, 255);
    // 50 个灰色
    for (let i = 0; i < 50; i += 1) px.push(128, 128, 128, 255);
    const color = pickDominantColor(px);
    const rgb = hexToRgb(color)!;
    expect(rgb.g).toBeGreaterThan(rgb.r);
    expect(rgb.g).toBeGreaterThan(150);
  });

  it('全灰/全白的图回退到默认强调色', () => {
    const px: number[] = [];
    for (let i = 0; i < 100; i += 1) px.push(200, 200, 200, 255);
    expect(pickDominantColor(px)).toBe('#4f9d99');
  });

  it('半透明像素不算数', () => {
    const px: number[] = [];
    for (let i = 0; i < 100; i += 1) px.push(255, 0, 0, 20); // 透明红
    for (let i = 0; i < 10; i += 1) px.push(0, 120, 255, 255);
    expect(hexToRgb(pickDominantColor(px))!.b).toBeGreaterThan(200);
  });
});
