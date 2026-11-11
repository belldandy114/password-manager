/**
 * 「打开网址」的唯一入口（渲染层）。
 *
 * 以前每个页面各写一遍 `browserOpen(...)`，失败要么只 console.warn、要么静默吞掉，
 * 用户看到的就是「点了打开没反应」。现在统一：
 *   - 地址为空直接给原因，不去调 IPC；
 *   - 主进程返回 success:false 才判失败（用户取消不算失败）；
 *   - 失败时把地址复制到剪贴板，调用方只要把 error 显示出来即可。
 *
 * 注意：`browser:open` 的 browser 传 'default' 走系统关联；传具体浏览器 id 才会直接拉进程。
 */

export interface OpenUrlResult {
  ok: boolean;
  /** 失败原因（已去掉 net:: 前缀这类噪音），成功时为空 */
  error?: string;
  /** 失败时是否已把地址复制到剪贴板（调用方可以在文案里说明） */
  copied?: boolean;
}

function stripNoise(message: string): string {
  return String(message || '').replace(/^Error:\s*/i, '').replace(/^net::/, '').trim();
}

export async function openUrlInDefaultBrowser(raw: string): Promise<OpenUrlResult> {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, error: '这条没有填网址' };

  try {
    const res = await window.electronAPI.browserOpen({ browser: 'default', url });
    if (res && res.success) return { ok: true };
    return { ok: false, error: stripNoise((res && res.error) || '系统未响应') };
  } catch (e) {
    return { ok: false, error: stripNoise((e as Error)?.message || String(e)) };
  }
}
