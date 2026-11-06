import { describe, it, expect } from 'vitest';
import { getTagHue } from '../tagColors';

describe('getTagHue', () => {
  it('返回值落在 0-360', () => {
    for (const tag of ['', '测试', '生产', 'a', '中文标签-很长很长']) {
      const hue = getTagHue(tag);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('同一标签稳定，不同标签通常不同', () => {
    expect(getTagHue('生产')).toBe(getTagHue('生产'));
    expect(getTagHue('生产')).not.toBe(getTagHue('测试'));
  });
});
