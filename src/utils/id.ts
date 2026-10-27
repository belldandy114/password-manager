/**
 * 生成条目 id
 *
 * 优先用 crypto.randomUUID()，取不到时退回时间戳 + 随机数，
 * 保证在任何上下文（含非安全上下文）都不会抛异常。
 */
export function newId(prefix = ''): string {
  try {
    const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
    if (c && typeof c.randomUUID === 'function') return prefix + c.randomUUID();
  } catch { /* 某些环境下 randomUUID 不可用，走下面的兜底 */ }
  return `${prefix}id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
