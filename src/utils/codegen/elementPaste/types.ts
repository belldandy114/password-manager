/**
 * 粘贴导入的公共类型（1.36.0 / B6，渲染层契约 §6.2）。
 *
 * 纯类型 + 纯函数模块：**零 IPC、零 window、零 React**。解析器只做「文本 → 候选行」，
 * 写库由调用方走既有的 `cleanPageForWrite` + `trimPagesForWrite` + `ws:set`（§6.2 的唯一写入路径）。
 */

import type { PomLocatorKind } from '../pageobject';

/** 三种可识别的输入格式 */
export type PasteSource = 'recorder-json' | 'playwright-js' | 'html';

/**
 * 每行的把握程度：
 * - `exact`：定位器唯一或语义明确（`#id` / `[aria-label]` / `getByRole(name)` / `getByText`）；
 * - `guess`：能生成但可能失配（结构性 css、`filter()` / `nth()` 链、只有 class 的 HTML）；
 * - `unknown`：连标签都没解析出来（`locator: ''`，默认不勾选）。
 */
export type PasteConfidence = 'exact' | 'guess' | 'unknown';

/** 一条可导入的候选元素（与 `PomElementRow` 的字段一一对应，外加「凭哪条特征认出来的」） */
export interface ElementPasteCandidate {
  /** 建议的元素名（用户可在预览表里改） */
  name: string;
  locator: string;
  kind: PomLocatorKind;
  /** `kind='role'` 时的可访问名 */
  role?: string;
  confidence: PasteConfidence;
  /** 一句人话：为什么判成这个把握度（预览表里单独一列，不折叠） */
  reason: string;
  source: PasteSource;
}

/** 整段输入认不出来时的固定文案（逐字定稿，见渲染层契约 §6.2） */
export const PASTE_UNKNOWN_REASON = '无法识别：支持 DevTools Recorder 导出的 JSON / Playwright codegen 脚本 / Elements 复制的 HTML';

/** 元素名建议的统一截断（预览表里一行能放下） */
export const NAME_HINT_MAX = 30;

/** 取一段人话作名字：合并空白 + 截断 */
export function nameHint(raw: string, fallback = '未命名元素'): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  return s.length > NAME_HINT_MAX ? `${s.slice(0, NAME_HINT_MAX)}…` : s;
}
