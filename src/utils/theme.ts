import type { ThemeMode, AccentColor } from '../types';

const MEDIA = '(prefers-color-scheme: dark)';

/** 强调色预设（值 + hover 近似色） */
export const ACCENTS: Record<AccentColor, { label: string; value: string; hover: string; light: string }> = {
  teal: { label: '青瓷', value: '#4f9d99', hover: '#5cb0ab', light: 'rgba(79, 157, 153, 0.14)' },
  indigo: { label: '靛蓝', value: '#6366f1', hover: '#5558e6', light: 'rgba(99, 102, 241, 0.1)' },
  blue: { label: '科技蓝', value: '#3b82f6', hover: '#2f74e0', light: 'rgba(59, 130, 246, 0.1)' },
  green: { label: '青绿', value: '#10b981', hover: '#0ea472', light: 'rgba(16, 185, 129, 0.1)' },
  orange: { label: '琥珀', value: '#f59e0b', hover: '#dd8b09', light: 'rgba(245, 158, 11, 0.1)' },
  rose: { label: '玫红', value: '#f43f5e', hover: '#e11d48', light: 'rgba(244, 63, 94, 0.1)' },
};

/**
 * 强调色只写 data-accent 属性，具体色值交给 CSS 按主题解析。
 *
 * 旧实现用 inline style 直接写 --accent / --accent-hover / --accent-light，
 * 会盖掉 tokens.css 的浅色主题令牌，导致浅色下强调色仍是深色值（约 3:1，
 * 不达 AA），而且切换主题时不会重算。改为属性后主题切换由 CSS 自动生效。
 */
export function applyAccent(accent: AccentColor | undefined) {
  const key = accent && ACCENTS[accent] ? accent : 'teal';
  document.documentElement.setAttribute('data-accent', key);
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(MEDIA).matches;
  } catch {
    return true;
  }
}

/** 把 dark/light/system 解析成实际生效的主题 */
export function resolveTheme(mode: ThemeMode | undefined): 'dark' | 'light' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode === 'light' ? 'light' : 'dark';
}

export function applyTheme(mode: ThemeMode | undefined) {
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
}

/** 密度三档：compact / standard / cozy，写到 <html data-density> */
export type DensityMode = 'compact' | 'standard' | 'cozy';

export function applyDensity(density: string | undefined) {
  const d = density === 'compact' || density === 'cozy' ? density : 'standard';
  document.documentElement.setAttribute('data-density', d);
}

/** 订阅系统主题变化，返回取消订阅函数 */
export function watchSystemTheme(cb: () => void): () => void {
  try {
    const mq = window.matchMedia(MEDIA);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
  } catch {
    return () => {};
  }
}
