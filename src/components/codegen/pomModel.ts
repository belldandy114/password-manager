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
import { POM_LOCATOR_KINDS, normalizeLocatorKind } from '../../utils/codegen/pageobject';
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
  /**
   * 这条元素是**怎么来的**（1.36.0 / B6，裁定 Z10：本批只加这一个字段）。
   *
   * - `paste`：粘贴导入（DevTools Recorder JSON / Playwright codegen / Elements HTML）；
   * - `manual`：元素库里手工加的（`blankElement()` 的默认值）；
   * - `recorder`：历史数据里由录制器建的（B7 之后不再产生，读端保留以显示真实来源）。
   *
   * 可选且**必须进 `cleanPageForWrite` 白名单**：保存是唯一的写入路径，
   * 漏掉白名单就会「保存一次把来源洗成 undefined」，表格那列随即变成 `—`。
   */
  source?: 'paste' | 'manual' | 'recorder';
  /**
   * 「上次校验」两列的数据来源（1.36.0 / B8，裁定 Z10：本批新增这两个字段，且**只有**这两个）。
   *
   * 写入方只有一个：元素库的「试跑」（`el:trial-run` 的 results 回填 → `cleanPageForWrite` 白名单透传）。
   * 不加 `styleSnapshot`：主进程虽然会回 6 键样式，但渲染层没有它的展示位，
   * 加了就是「永远没有写入方的字段」——比没有更难排查（Z10 的原话）。
   */
  checkedAt?: string;
  /** 一次试跑的命中数：0 = 选择器未命中（与「需要登录」「未执行」是三件不同的事） */
  hitCount?: number;
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

/**
 * 定位方式清单（下拉渲染用）。
 *
 * **1.37.0（S3 / [A0-8]）改为再导出单一真源**：以前这里是手写的 5 项数组，与生成器里的
 * `PomLocatorKind` 是两份清单——加一种定位方式必须改两处，漏一处就是「下拉里选不到」
 * 或「选了被 `validatePage` 拦下」。现在只保留 `utils/codegen/pageobject.ts` 的
 * `POM_LOCATOR_KINDS`（10 项，含顺序），这里**不再出现任何字面量**。
 * 判据（[A0-8] 证伪形态）：本文件里出现第二份 `['css','xpath',…]` 白名单即不通过。
 */
export const KINDS: ReadonlyArray<{ id: PomLocatorKind; label: string }> = POM_LOCATOR_KINDS;

/** kind 归一（[A0-3]）：脏值 / 缺值 / 大小写与空白差异一律当 `css`，与生成器、主进程同一函数 */
export { normalizeLocatorKind };

/** 上限（契约 §1.2 [C-27]） */
export const MAX_PAGES = 200;
export const MAX_ELEMENTS = 200;

/**
 * 1.36.0（B8）：Playwright「试跑」工作目录的 localStorage 键。
 *
 * 放在这里（而**不是** ElementLibTab）：设置页也要读写它，而设置页不该为了一个字符串常量
 * 把整个 codegen 组件树（含 pageobject 生成器、粘贴解析器）拉进自己的 chunk —— 那会让
 * 元素库的懒加载白做。`pomModel.ts` 是零依赖的纯模型模块，设置页与元素库引用它都不亏。
 *
 * 值**不进 vault、不进备份、不进导出**（方案 §12.7：那个目录含登录 cookie）。
 */
export const EL_WORK_DIR_KEY = 'pm.el.workDir';

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
    // [A0-3]：脏 kind（缺失 / 空串 / 大小写 / 未收录）先归一成 `css`，再往下校验。
    // 老库里的元素因此「打开即可保存」，而不是被拦在「定位器类型无效」——
    // 归一后理论上不可能非法，下面那行保留为**防御性断言**（[A0-4] 的原话：归一后仍非法理论上不可达）。
    const kind = normalizeLocatorKind(el.kind);
    if (!KINDS.some((k) => k.id === kind)) return `${at}：定位器类型无效`;
    if (kind === 'pw') {
      // 1.36.0（B6）：pw 存的是一行 JS 链，换行/控制字符会让它落库后既生成不了 Java
      // 也没法在预览表里等宽显示（文案逐字定稿，见渲染层契约 §6.1）。
      if (/[\r\n\u0000-\u001f]/.test(el.locator)) return `${at}：Playwright 链不能包含换行或控制字符`;
    }
    if (kind === 'xpath') {
      // [A0-4] 新增（文案逐字）：xpath 的 `xpath=` 前缀由生成器加，用户再写一遍会变成
      // `page.locator("xpath=xpath=//div")`——生成得出、跑起来必然 0 命中，属最难排查的一类。
      if (/^\s*xpath=/i.test(el.locator)) return `${at}：xpath 类型不要再写 xpath= 前缀（生成器会加）`;
    }
    if (kind === 'role') {
      // [C-28] 固定文案：少了它生成的 Java 会 setName("")，等于没写选择器
      if (!String(el.role ?? '').trim()) return `role 定位器必须填写 role 名称`;
      if (String(el.role).length > 40) return `${at}：role 名称最多 40 个字符`;
    }
  }
  return null;
}

/**
 * 读库投影：[A0-3] ② 把整页元素的 `kind` 归一。
 *
 * 为什么在**读**的时候就归一、而不是等保存：老记录（1.34.0 及以前）没有 kind 概念，
 * 或存了 `'CSS'` / `''` 这类脏值。不归一的话，下拉会显示成空白（`<select value>` 匹配不到任何
 * `<option>`）、用户以为「类型丢了」；归一后它显示为 `css` 并可直接保存（保存即写回 `kind:'css'`）。
 */
export function normalizePageKinds(page: PomPage): PomPage {
  return {
    ...page,
    elements: page.elements.map((el) => ({ ...el, kind: normalizeLocatorKind(el.kind) })),
  };
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
  // 默认 kind 取清单第一项（`css`）而不是写字面量：这样「文件里没有第二处 kind 清单/默认值字面量」，
  // 将来若调整清单顺序，新元素的默认类型会跟着清单走，不会与下拉第一项不一致。
  return {
    id: newId('el-'),
    name: '',
    locator: '',
    kind: POM_LOCATOR_KINDS[0].id,
    role: '',
    source: 'manual',
  };
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
      // t26（AR-7）：**写端也归一 kind**。以前这里写 `kind: el.kind` 原样透传，脏值（`'CSS'` /
      // `'foo'` / `''` / undefined）会原样落库，只能等下次读出来由 `normalizeLocatorKind` 兜底 ——
      // 同一份脏数据在库里躺着，任何直接读 vault 的地方（导出 / 备份比对 / 未来的消费者）都得再归一一次。
      // 写端一处收口更省事，且与 [A0-3] 的口径完全一致（用同一个函数，不新写第二套判定）。
      // 注意 `el.kind === 'role'` 那个判断仍看**原值**：脏值本来就不是 role，归一后也不会变成 role，
      // 所以两个分支不会因为归一而错位。
      kind: normalizeLocatorKind(el.kind),
      ...(el.kind === 'role' ? { role: String(el.role ?? '').trim() } : {}),
      // 1.36.0（B6）：来源必须透传（漏它 = 保存一次就把「粘贴导入 / 手工添加」洗成 `—`）。
      // 用条件展开而不是 `source: el.source`：历史元素没有这个字段时不该多出一个永远空的键。
      ...(el.source ? { source: el.source } : {}),
      // 1.36.0（B8）：试跑结果同样只在**有值**时才写（`hitCount: 0` 是有效值，不能用真值判断）。
      ...(typeof el.hitCount === 'number' ? { hitCount: el.hitCount } : {}),
      ...(el.checkedAt ? { checkedAt: el.checkedAt } : {}),
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