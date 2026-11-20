/**
 * accent.ts —— 从图片里取主色 + 保证按钮文字可读（纯函数，canvas 只在 extractAccent 里用）
 *
 * 规则：
 *   - 忽略近白/近黑/低饱和像素（它们通常是天空、墙面、阴影，取出来当强调色会很脏）；
 *   - 颜色按 24 级量化后投票，取票数最高的一簇再取平均，避免单个像素噪点；
 *   - 强调色要压到「白字放在上面对比度 ≥ 4.5」，否则按钮文字会糊掉。
 */

export interface RGB { r: number; g: number; b: number }

export function hexToRgb(hex: string): RGB | null {
  const s = String(hex || '').trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** WCAG 相对亮度 */
export function luminance({ r, g, b }: RGB): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 对比度 1~21 */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 调整明度（0~1 之间按比例混黑/混白），hsl 太绕，直接在 RGB 上做线性插值 */
export function shift(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const target = amount < 0 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const t = Math.min(1, Math.abs(amount));
  return rgbToHex({
    r: rgb.r + (target.r - rgb.r) * t,
    g: rgb.g + (target.g - rgb.g) * t,
    b: rgb.b + (target.b - rgb.b) * t,
  });
}

/**
 * 让白字放在这个颜色上达到对比度 target（默认 4.5，AA）。
 * 太亮就压暗；本来就够暗就原样返回。
 */
export function ensureReadableOnWhiteText(hex: string, target = 4.5): string {
  const white = { r: 255, g: 255, b: 255 };
  let out = hex;
  for (let i = 0; i < 24; i += 1) {
    const rgb = hexToRgb(out);
    if (!rgb) return hex;
    if (contrast(rgb, white) >= target) return out;
    out = shift(out, -0.06);
  }
  return out;
}

/**
 * 从 RGBA 像素里挑主色（不依赖 DOM，方便单测）。
 * @param pixels 形如 [r,g,b,a, r,g,b,a, ...]
 */
export function pickDominantColor(pixels: number[] | Uint8ClampedArray, fallback = '#4f9d99'): string {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 160) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // 近黑 / 近白 / 灰都不适合当强调色
    if (max < 40 || min > 220) continue;
    if (max - min < 12) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const cur = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    cur.n += 1;
    cur.r += r;
    cur.g += g;
    cur.b += b;
    buckets.set(key, cur);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const v of buckets.values()) if (!best || v.n > best.n) best = v;
  if (!best) return fallback;
  return rgbToHex({ r: best.r / best.n, g: best.g / best.n, b: best.b / best.n });
}

/**
 * 从 <img> 上取主色（浏览器里用；画到 48×48 的 canvas 再统计）。
 * 图片必须是同源或 data: URL，否则 canvas 会被污染。
 */
export function extractAccent(img: HTMLImageElement): string {
  try {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '#4f9d99';
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    return pickDominantColor(data);
  } catch {
    return '#4f9d99';
  }
}
