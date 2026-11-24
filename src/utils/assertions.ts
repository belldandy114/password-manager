/**
 * 1.4 断言模板库的检索与合并（契约 §3.6 / [C-97]–[C-99]）。
 *
 * 分工：`assertionsSeed.ts` 只有静态种子；本文件负责
 *   ① 三维检索（语言 / 框架 / 用途，[C-98]）
 *   ② 种子 + 用户自定义片段的合并与稳定排序（[C-98]）
 *   ③ 自定义片段 ↔ vault `codeSnippets` 行的映射（[C-97]：`kind:'assert'` 与 notes 的 `kind='sql'` 同模式）
 *
 * 为什么自定义片段要复用一个「别人的集合」：契约 [C-97] 明确要求存既有 `codeSnippets`，
 * 不新开集合。代价是 `codeSnippets` 里同时有 CodeLab 的普通片段与断言片段，
 * 所以**两侧都要按 `kind` 过滤**——本文件负责「读到非断言行时忽略它」，
 * 另一侧（CodeLab 片段库）需要在自己的批次里补 `kind !== 'assert'` 过滤（已在交付说明里点名）。
 */

import {
  ASSERTION_SEED,
  type AssertionCategory,
  type AssertionFramework,
  type AssertionLang,
  type AssertionSnippet,
} from './assertionsSeed';

export type { AssertionCategory, AssertionFramework, AssertionLang, AssertionSnippet };
export { ASSERTION_SEED, FRAMEWORK_LABELS, CATEGORY_LABELS } from './assertionsSeed';

export interface AssertionFilter {
  category?: AssertionCategory;
  lang?: AssertionLang;
}

function includesIgnoreCase(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}

/**
 * 检索（[C-98]）：
 * - `query` 对 `title + tags + code` 做**不区分大小写**的子串匹配；不做模糊 / 拼音 / 正则；
 * - `framework` 精确过滤；
 * - `filter.category` / `filter.lang` 精确过滤（附加维度，见 assertionsSeed.ts 顶部说明）；
 * - 空 `query` 返回全部；结果顺序 = 入参顺序（种子原序 / 调用方给的顺序），**不做二次排序**。
 */
export function listAssertions(
  query?: string,
  framework?: AssertionFramework,
  filter: AssertionFilter = {},
): AssertionSnippet[] {
  return filterAssertions(ASSERTION_SEED, query, framework, filter);
}

/**
 * 对**任意**片段数组用同一套判据过滤。
 *
 * 为什么要单独暴露：页面里最终展示的是「种子 + 用户自定义」合并后的列表（[C-98] 要求种子在前），
 * 若只对种子调 `listAssertions`、自定义那半自己再写一遍匹配逻辑，就会出现两套不一致的检索
 * （改了 keyword 规则只改一处）。所以过滤逻辑只有这一份。
 */
export function filterAssertions(
  items: AssertionSnippet[],
  query?: string,
  framework?: AssertionFramework,
  filter: AssertionFilter = {},
): AssertionSnippet[] {
  const q = (query ?? '').trim().toLowerCase();
  return items.filter((s) => {
    if (framework && s.framework !== framework) return false;
    if (filter.category && s.category !== filter.category) return false;
    if (filter.lang && s.lang !== filter.lang) return false;
    if (!q) return true;
    if (includesIgnoreCase(s.title, q)) return true;
    if (s.tags.some(t => includesIgnoreCase(t, q))) return true;
    return includesIgnoreCase(s.code, q);
  });
}

/**
 * 合并：**种子在前（原顺序）+ 自定义在后（`updatedAt` 降序）**，顺序必须稳定（[C-98]）。
 *
 * 自定义片段里没有 `updatedAt` 的（比如刚从剪贴板粘出来的）排在同类末尾并保持传入顺序，
 * 避免「同一次渲染里顺序抖动」。
 */
export function mergeAssertions(seed: AssertionSnippet[], custom: AssertionSnippet[]): AssertionSnippet[] {
  const sorted = custom
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ta = a.s.updatedAt ? Date.parse(a.s.updatedAt) : Number.NEGATIVE_INFINITY;
      const tb = b.s.updatedAt ? Date.parse(b.s.updatedAt) : Number.NEGATIVE_INFINITY;
      if (tb !== ta) return tb - ta;
      return a.i - b.i;
    })
    .map(x => x.s);
  return [...seed, ...sorted];
}

/* ================================================================
   自定义片段 ↔ codeSnippets 行
   ----------------------------------------------------------------
   `codeSnippets` 的元素类型是既有 `CodelabSnippet`（id/name/lang/code/createdAt/updatedAt）。
   本批**不改 src/types.ts**（W1 已冻结），所以 here 用「既有字段 + 两个附加字段」的行类型：
   `kind: 'assert'` 用于与他人区分（[C-97]）、`tags/framework/category` 用于三维检索能覆盖自定义片段。
   落库走既有的 `ws:set`（`wsSet(key, value: any[])`，多出来的字段原样存进加密库）。
   ================================================================ */

export interface CustomAssertionRow {
  id: string;
  /** 既有字段：标题（CodelabSnippet 叫 name，不叫 title） */
  name: string;
  /** 既有字段：语言，本批固定 java */
  lang: string;
  /** 既有字段：代码正文 */
  code: string;
  /** 既有字段：时间戳（ISO） */
  createdAt: string;
  updatedAt: string;
  /** [C-97] 区分标志：只有断言片段带它 */
  kind: 'assert';
  framework: AssertionFramework;
  category: AssertionCategory;
  tags: string[];
}

/** 只认 `kind === 'assert'`：CodeLab 的普通片段（没有 kind 或别的 kind）一律不算断言片段 */
export function isAssertRow(row: unknown): row is CustomAssertionRow {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  return r.kind === 'assert' && typeof r.id === 'string' && typeof r.code === 'string';
}

/** vault 行 → 可检索的断言片段（按 updatedAt 降序，供 mergeAssertions 保持稳定） */
export function rowsToAssertions(rows: unknown[]): AssertionSnippet[] {
  return rows
    .filter(isAssertRow)
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
    .map(row => ({
      id: row.id,
      title: row.name,
      lang: 'java' as AssertionLang,
      framework: row.framework || 'restassured',
      category: row.category || 'general',
      tags: Array.isArray(row.tags) ? row.tags : [],
      code: row.code,
      // 复制的是 code 原文（[C-99]：展示与复制逐字符相同，不许在这里做 trim / 重排）
      updatedAt: row.updatedAt,
    }));
}

export interface NewAssertionInput {
  name: string;
  code: string;
  framework?: AssertionFramework;
  category?: AssertionCategory;
  tags?: string[];
}

/**
 * 生成/更新一行可落库的断言片段。
 * - 新建时 `id` 用 `crypto.randomUUID()`（[C-21] 同口径：不用时间戳/自增，避免多窗口撞号）；
 * - 更新时传入 `existing`，保留 `id` 与 `createdAt`，只动内容与 `updatedAt`。
 */
export function toAssertionRow(input: NewAssertionInput, existing?: CustomAssertionRow): CustomAssertionRow {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    lang: 'java',
    code: input.code,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    kind: 'assert',
    framework: input.framework ?? existing?.framework ?? 'restassured',
    category: input.category ?? existing?.category ?? 'general',
    tags: input.tags ?? existing?.tags ?? [],
  };
}

/** 校验新片段的必填项（UI 上直接显示这两个文案，不要「输入有误」这种笼统提示） */
export function validateAssertionInput(input: NewAssertionInput): string | null {
  if (!input.name.trim()) return '标题不能为空（检索和列表都靠它认片段）';
  if (!input.code.trim()) return '代码不能为空';
  return null;
}

/** 删除：只从行数组里摘掉指定 id（种子不在这个数组里，天然删不到，[C-97]「内置只读」） */
export function removeAssertionRow(rows: unknown[], id: string): unknown[] {
  return rows.filter(r => !(isAssertRow(r) && r.id === id));
}