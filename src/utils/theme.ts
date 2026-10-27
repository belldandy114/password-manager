import type { ThemeMode } from '../types';

const MEDIA = '(prefers-color-scheme: dark)';

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
