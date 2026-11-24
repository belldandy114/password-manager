/**
 * 数字格式化（缺值一律显示 —）
 *
 * pct / num / ms 三个纯函数，两页签共用。
 *
 * 来源：t53 把 `src/pages/ResultHub.tsx`（625 行）按 `docs/拆分-渲染层.md` 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */


export const pct = (v: number | undefined): string => (typeof v === 'number' ? `${v.toFixed(2)}%` : '—');
export const num = (v: number | undefined): string => (typeof v === 'number' ? String(v) : '—');
export const ms = (v: number | undefined): string => (typeof v === 'number' ? `${Math.round(v)} ms` : '—');