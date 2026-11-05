/**
 * IPC 调用兜底。
 *
 * 背景：主进程每个 handler 都返回 `{ success, data?, error? }`，但渲染层有 100+ 处
 * `await window.electronAPI.x()`，全靠手写 `if (res.success)` —— 总有几个地方忘了判，
 * 表现就是「界面提示成功，其实没写进去」（例如导出文件写盘失败仍然弹「导出成功」）。
 *
 * 用法：
 *   const r = await callIpc(() => window.electronAPI.fileWrite({ ... }));
 *   if (!r.ok) { addToast(r.error, 'error'); return; }
 *
 * 约定：
 * - 只有 `success === false`、抛异常、返回空值 才判失败（`canceled: true` 这种算成功，
 *   由调用方自己看 `res.canceled`，避免把「用户点了取消」当成错误弹提示）；
 * - 失败时一定给出**非空**中文兜底文案，不会出现 `undefined` 飘在界面上。
 */

export interface IpcEnvelope<T = unknown> {
  success?: boolean;
  data?: T;
  error?: string;
  canceled?: boolean;
  [key: string]: unknown;
}

export type IpcOutcome<T> =
  | { ok: true; data?: T; raw: IpcEnvelope<T> }
  | { ok: false; error: string; raw?: IpcEnvelope<T> };

const DEFAULT_ERROR = '操作失败，请重试';

/**
 * 统一收敛 IPC 结果。不会抛异常 —— 调用方只判 `ok`。
 */
export async function callIpc<T = unknown>(
  fn: () => Promise<IpcEnvelope<T> | null | undefined> | IpcEnvelope<T> | null | undefined,
): Promise<IpcOutcome<T>> {
  let res: IpcEnvelope<T> | null | undefined;
  try {
    res = await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    return { ok: false, error: msg.trim() || DEFAULT_ERROR };
  }
  if (!res || typeof res !== 'object') {
    return { ok: false, error: DEFAULT_ERROR };
  }
  if (res.success === false) {
    const msg = typeof res.error === 'string' ? res.error.trim() : '';
    return { ok: false, error: msg || DEFAULT_ERROR, raw: res };
  }
  return { ok: true, data: res.data, raw: res };
}
