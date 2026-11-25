/**
 * 元素库（pomPages）的数据形状与纯校验
 *
 * 被 ElementLibTab / ElementTable 共用；不依赖 React，只依赖 newId 与生成的 PomLocatorKind。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { newId } from '../../utils/id';
import { trimToCaps, capsOf, trimNotice } from '../../utils/collectionTrim';
import type { PomLocatorKind } from '../../utils/codegen/pageobject';

/* ================================================================
   类型（与契约 §1.2 的 pomPages / PomElement 字段一一对应）
   ================================================================ */

export interface PomElementRow {
  /**
   * 元素 id（契约 §9 [C-110]，v18 / 裁定 J-13）：**类型可选、写入必填**。
   *
   * - 读端：v1.34.0 及以前落库的元素没有这个字段，历史页与生成器**必须容错**（缺 id 按「未关联」处理）；
   * - 写端：新建走 `blankElement()`（`newId`），迁移回填走 `MIGRATIONS[4]`（确定性派生），
   *   保存走 `cleanPageForWrite()`（白名单透传，缺则补）—— **三条路径都必须产出非空 id**。
   *
   * 它是 `UiStep.elementId` 的唯一锚点：一旦在保存时被洗掉，录制步骤与元素库就断链。
   */
  id?: string;
  name: string;
  locator: string;
  kind: PomLocatorKind;
  /** `kind='role'` 时的可访问名（[C-28] 必填） */
  role?: string;
  note?: string;
}

export interface PomPage {
  id: string;
  name: string;
  baseUrl: string;
  className?: string;
  elements: PomElementRow[];
  note?: string;
  updatedAt: string;
}

export const KINDS: Array<{ id: PomLocatorKind; label: string }> = [
  { id: 'css', label: 'css 选择器' },
  { id: 'xpath', label: 'xpath' },
  { id: 'text', label: '可见文本' },
  { id: 'role', label: '角色（role）' },
];

/** 上限（契约 §1.2 [C-27]） */
export const MAX_PAGES = 200;
export const MAX_ELEMENTS = 200;

/* ================================================================
   纯校验（页面内做字段级校验；[C-23] 明确字段校验在渲染层）
   ================================================================ */

/** 返回错误文案，null = 通过 */
export function validatePage(draft: PomPage, all: PomPage[]): string | null {
  const name = draft.name.trim();
  if (!name) return '页面名不能为空';
  if (name.length > 80) return '页面名最多 80 个字符';
  if (all.some((p) => p.id !== draft.id && p.name.trim() === name)) return `页面名已存在：${name}`;

  const baseUrl = draft.baseUrl.trim();
  if (!baseUrl) return '页面地址（baseUrl）不能为空';
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) return '页面地址必须是 http:// 或 https:// 开头';
  if (baseUrl.length > 500) return '页面地址最多 500 个字符';

  if (draft.elements.length > MAX_ELEMENTS) return `单个页面最多 ${MAX_ELEMENTS} 个元素`;

  for (let i = 0; i < draft.elements.length; i += 1) {
    const el = draft.elements[i];
    const at = `第 ${i + 1} 个元素`;
    if (!el.name.trim()) return `${at}：名称不能为空`;
    if (el.name.trim().length > 60) return `${at}：名称最多 60 个字符`;
    if (!el.locator.trim()) return `${at}：定位器不能为空`;
    if (el.locator.length > 500) return `${at}：定位器最多 500 个字符`;
    if (!KINDS.some((k) => k.id === el.kind)) return `${at}：定位器类型无效`;
    if (el.kind === 'role') {
      // [C-28] 固定文案：少了它生成的 Java 会 setName("")，等于没写选择器
      if (!String(el.role ?? '').trim()) return `role 定位器必须填写 role 名称`;
      if (String(el.role).length > 40) return `${at}：role 名称最多 40 个字符`;
    }
  }
  return null;
}

/** 新建一份空白页面 */
export function blankPage(): PomPage {
  return {
    id: newId('pom-'),
    name: '',
    baseUrl: 'https://',
    className: '',
    elements: [],
    note: '',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 新建一个空白元素（[C-110] 写端必填：**id 在新建那一刻就定下来**，不等保存）。
 *
 * 为什么不在保存时才生成：用户可能先填一半就切页签（草稿留在 state 里），
 * 保存时再生成会让「同一次编辑」在不同保存轮次拿到不同 id，引用它的录制步骤就漂了。
 */
export function blankElement(): PomElementRow {
  return { id: newId('el-'), name: '', locator: '', kind: 'css', role: '' };
}

/**
 * 保存前把页面草稿归一成「真正要写进 vault 的形状」（契约 §9 [C-110] ②，**本轮唯一的数据丢失路径**）。
 *
 * **为什么必须有这个函数**：原来这段逻辑写在 `ElementLibTab.savePage` 里，按
 * `name / locator / kind / role / note` **逐字段重建**元素对象 —— 任何不在清单里的字段都会被丢掉，
 * 包括迁移回填的 `id`。用户在元素库里「编辑一次 + 保存一次」，元素 id 就被洗白，
 * `UiStep.elementId` 变成悬空引用，AC-8「重开应用后逐字段相等」当场失败。
 *
 * 所以：**白名单必须透传 `id`**，且历史元素缺 id 时补一个新的（`id: el.id || newId('el-')`）。
 * 提成纯函数是为了让「保存后 id 不变」这件事能被单测锁死，而不是靠点一遍界面。
 */
export function cleanPageForWrite(draft: PomPage): PomPage {
  return {
    id: draft.id,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    className: (draft.className || '').trim(),
    note: (draft.note || '').trim(),
    elements: draft.elements.map((el) => ({
      id: el.id ? String(el.id) : newId('el-'), // [C-110] ②：透传，不许写 undefined / 空串
      name: el.name.trim(),
      locator: el.locator, // [C-27]：定位器原样存，转义只在生成器里做
      kind: el.kind,
      ...(el.kind === 'role' ? { role: String(el.role ?? '').trim() } : {}),
      ...(el.note ? { note: el.note } : {}),
    })),
    updatedAt: new Date().toISOString(),
  };
}

/* ================================================================
   写入前的上限裁剪（契约 [C-24]/[C-25] 的第 5 个集合 pomPages）
   ================================================================ */

export interface PomWritePlan {
  /** 真正要写进 `ws:set` 的数组 */
  items: PomPage[];
  /** 被裁掉几条（0 = 没超限） */
  dropped: number;
  /** 给用户看的提示文案；`dropped === 0` 时为空串 */
  notice: string;
}

/**
 * 元素库写入前的裁剪计划。
 *
 * **为什么不能直接 `trimToCaps(items)` 了事**：元素库是「改一个元素就整表写回」的形态，
 * 而 `trimToCaps` 按时间从**最旧**开始丢。用户完全可能打开一个很早建的页面改个定位器——
 * 那一刻这条页面的 `updatedAt` 还是旧的（甚至就是全表最旧），如果照常排，
 * **保存后它会被当成最早的清理掉**：用户的操作结果当场消失，而且他多半不会想到是"上限裁剪"干的。
 *
 * 所以这里把**刚保存的那条**（`keepId`）钉成「最新」参与排序，其余照常按 `updatedAt` 排。
 * 只用了 `trimToCaps` 公开的 `timeOf` 选项，没有改它的实现、也没有改数据本身。
 *
 * @param next   即将写入的完整数组（已被调用方增/删/改过）
 * @param keepId 本次操作"刚动过"的那条 id（保存页面时传；删除时不必传）
 */
export function trimPagesForWrite(next: PomPage[], keepId?: string): PomWritePlan {
  const caps = capsOf('pomPages');
  // 钉住的那条用「最大时间戳」而不是改它的 updatedAt：数据保持原样，只影响排序
  const PINNED = '9999-12-31T23:59:59.999Z';
  const cut = trimToCaps(next, caps, {
    timeOf: (p) => (keepId && p.id === keepId ? PINNED : p.updatedAt),
  });
  const notice = cut.dropped
    ? `页面数已达上限（${caps.maxItems}）：${trimNotice(cut.dropped)}；刚保存的页面不会被裁掉`
    : '';
  return { items: cut.items, dropped: cut.dropped, notice };
}