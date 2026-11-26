/**
 * 三格式自动识别（1.36.0 / B6，渲染层契约 §6.2 / 方案 §10.1）。
 *
 * 判定顺序**固定**（三种同时命中时取先）：
 *   ① `JSON.parse` 成功且 `steps` 是数组、首步带 `selectors` 或 `type` → `recorder-json`
 *   ② 文本里命中 `getByRole(` / `getByText(` / `locator(` / `page.` 中**任两条** → `playwright-js`
 *   ③ 含 `<` 且能解析出至少一个标签 → `html`
 *   都不命中 → `source: null` + 固定文案（`PASTE_UNKNOWN_REASON`），**写 0 条**。
 *
 * 为什么「任两条」而不是「任一条」：单条 `locator(` 太容易撞（`page` 这个词也会出现在别的脚本里），
 * 而 codegen 的真脚本几乎必然同时出现 `page.` 与某个 `getBy*`/`locator(`。
 */

import type { ElementPasteCandidate, PasteSource } from './types';
import { PASTE_UNKNOWN_REASON } from './types';
import { parseRecorder } from './parseRecorder';
import { parsePlaywright } from './parsePlaywright';
import { parseHtml } from './parseHtml';

export interface DetectResult {
  source: PasteSource | null;
  candidates: ElementPasteCandidate[];
  /** 一句人话：凭什么认成这个格式 / 为什么认不出 */
  reason: string;
}

const DATE_HINTS = ['page.', 'getByRole(', 'getByText(', 'locator('];

/** ② 的分值：命中几种特征 */
function playwrightScore(text: string): number {
  return DATE_HINTS.filter((h) => text.includes(h)).length;
}

/** 判断是不是 Recorder JSON（① 的形状检查，不依赖全文是合法 JSON 之外的东西） */
function looksRecorderJson(text: string): boolean {
  if (!text.trim().startsWith('{')) return false;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return false; }
  const steps = (o as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || !steps.length) return false;
  const first = steps[0] as { selectors?: unknown; type?: unknown } | undefined;
  if (!first || typeof first !== 'object') return false;
  return Array.isArray(first.selectors) || typeof first.type === 'string';
}

/** 按指定的格式解析（UI 顶部下拉改选后走这里：只重解析、不重新识别） */
export function parseBySource(source: PasteSource, text: string): ElementPasteCandidate[] {
  if (source === 'recorder-json') return parseRecorder(text);
  if (source === 'playwright-js') return parsePlaywright(text);
  return parseHtml(text);
}

/** 自动识别 + 解析（粘贴框的默认路径） */
export function detectElementPaste(text: string): DetectResult {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { source: null, candidates: [], reason: PASTE_UNKNOWN_REASON };

  // ① Recorder JSON
  if (looksRecorderJson(trimmed)) {
    const candidates = parseRecorder(trimmed);
    if (candidates.length) {
      return { source: 'recorder-json', candidates, reason: '认出来了：JSON 里有 steps[]，且首步带 selectors/type（DevTools Recorder 导出）' };
    }
    return { source: 'recorder-json', candidates: [], reason: '是 Recorder JSON，但 steps 里没有可用的选择器' };
  }

  // ② Playwright codegen 脚本
  if (playwrightScore(trimmed) >= 2) {
    const candidates = parsePlaywright(trimmed);
    if (candidates.length) {
      return { source: 'playwright-js', candidates, reason: '认出来了：文本里同时出现 page. 与 getBy*/locator(（Playwright codegen 脚本）' };
    }
    return { source: 'playwright-js', candidates: [], reason: '像 Playwright 脚本，但没有可解析的定位行' };
  }

  // ③ HTML
  if (trimmed.includes('<')) {
    const candidates = parseHtml(trimmed);
    const hasTag = candidates.some((c) => c.confidence !== 'unknown');
    if (hasTag) {
      return { source: 'html', candidates, reason: '认出来了：含 < 且能解析出标签（Elements 复制的 HTML）' };
    }
    return { source: 'html', candidates, reason: '含 < 但解析不出标签' };
  }

  return { source: null, candidates: [], reason: PASTE_UNKNOWN_REASON };
}
