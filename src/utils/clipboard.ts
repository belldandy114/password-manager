import { useStore } from '../store/useStore';

/** 这些标签的内容复制后需要定时清空剪贴板 */
const SENSITIVE = /密码|口令|验证码|动态码|密钥|token|secret|api.?key/i;

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE.test(label || '');
}

/**
 * 敏感内容统一走主进程的 clipboard:copy IPC：它会按设置的秒数定时清空剪贴板。
 * 渲染层直接调用 navigator.clipboard.writeText 会绕过这套机制。
 */
export async function copySensitive(text: string, label: string): Promise<boolean> {
  const seconds = Number(useStore.getState().settings?.clipboardClearDelay ?? 30);
  const delay = Math.max(0, seconds || 0) * 1000;
  try {
    const res = await window.electronAPI.clipboardCopy({ text, delay });
    return !!res?.success;
  } catch {
    // IPC 不可用时退化为普通复制，但明确返回 false 让调用方别承诺「会自动清空」
    try { await navigator.clipboard.writeText(text); } catch { /* 剪贴板不可用 */ }
    return false;
  }
}

/** 普通文本复制：不触发自动清空 */
export function copyPlain(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
