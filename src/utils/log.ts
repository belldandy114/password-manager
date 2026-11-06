/**
 * 渲染层日志：关键失败除了 console，还要同步进主进程 app.log。
 * app-log.js 已劫持主进程 console.warn/error，所以一条 IPC 就能落盘。
 */
function emit(level: 'warn' | 'error', scope: string, err: unknown, extra?: string) {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err ?? '');
  const line = `[${scope}] ${detail}${extra ? ` | ${extra}` : ''}`.slice(0, 600);
  try {
    if (level === 'error') console.error(line);
    else console.warn(line);
  } catch { /* console 不可用 */ }
  try {
    void window.electronAPI?.logRenderer?.(level, line)?.catch?.(() => {});
  } catch { /* 日志不能影响业务 */ }
}

export function logWarn(scope: string, err: unknown, extra?: string) {
  emit('warn', scope, err, extra);
}

export function logError(scope: string, err: unknown, extra?: string) {
  emit('error', scope, err, extra);
}
