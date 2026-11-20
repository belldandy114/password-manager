/**
 * background.ts —— 把「自定义背景」的设置写到 <html>（CSS 变量 + data-bg）
 *
 * CSS 只认属性与变量，不认 React 状态，所以读写都集中在这里，
 * 方便测试与以后做「跟随主题的两套参数」。
 */

export interface BgOptions {
  present: boolean;
  /** 图片不透明度 0~0.9 */
  opacity?: number;
  /** 背景模糊 px */
  blur?: number;
  /** 压暗/压亮遮罩 0~0.9 */
  dim?: number;
  /** 从图片提取的强调色（#rrggbb） */
  accent?: string;
  autoAccent?: boolean;
  /** 关闭自动取色时用的预设强调色 key（teal/indigo/...） */
  presetAccent?: string;
}

const clamp = (n: number | undefined, min: number, max: number, fallback: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
};

export function applyBackground(o: BgOptions) {
  const root = document.documentElement;
  if (!o.present) {
    root.removeAttribute('data-bg');
    root.style.removeProperty('--bg-opacity');
    root.style.removeProperty('--bg-blur');
    root.style.removeProperty('--bg-dim');
    root.style.removeProperty('--bg-accent');
    if (root.getAttribute('data-accent') === 'image') {
      if (o.presetAccent) root.setAttribute('data-accent', o.presetAccent);
      else root.removeAttribute('data-accent');
    }
    return;
  }
  root.setAttribute('data-bg', 'image');
  root.style.setProperty('--bg-opacity', String(clamp(o.opacity, 0, 0.9, 0.32)));
  root.style.setProperty('--bg-blur', `${clamp(o.blur, 0, 30, 8)}px`);
  root.style.setProperty('--bg-dim', String(clamp(o.dim, 0, 0.9, 0.42)));

  if (o.autoAccent && o.accent) {
    root.style.setProperty('--bg-accent', o.accent);
    root.setAttribute('data-accent', 'image');
  } else {
    root.style.removeProperty('--bg-accent');
    if (root.getAttribute('data-accent') === 'image') {
      if (o.presetAccent) root.setAttribute('data-accent', o.presetAccent);
      else root.removeAttribute('data-accent');
    }
  }
}
