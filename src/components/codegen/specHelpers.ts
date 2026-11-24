/**
 * OpenAPI 文本处理的几个小工具
 *
 * pathOf（剥 baseUrl 前缀）/ defaultClassName（标题 → 类名）/ MAX_SPEC_BYTES_HINT。纯函数，无副作用。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

/** 上限提示用（spec 超过 1 MB 就会明显卡） */
export const MAX_SPEC_BYTES_HINT = 1024 * 1024;

/** OpenAPI 的 url 去掉 baseUrl 前缀，表格里只显示路径（否则一列被域名占满，看不到差异） */
export function pathOf(url: string, baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (b && url.startsWith(b)) return url.slice(b.length) || '/';
  return url;
}

/** 从 spec 标题推一个默认类名：`Pet Store API` → `PetStoreApiTest` */
export function defaultClassName(title: string): string {
  const words = String(title || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return 'ApiTest';
  const pas = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return `${pas}Test`;
}