/**
 * 三格式自动识别（1.36.0 / B6，渲染层契约 §6.2 / 方案 §10.1；A₁ 扩三语法，`[A1-8]`）。
 *
 * 判定顺序**固定**（三种同时命中时取先）：
 *   ① `JSON.parse` 成功且 `steps` 是数组、首步带 `selectors` 或 `type` → `recorder-json`
 *   ② 「有 `page*.` 调用」**且**「有任一语言的定位方法」→ `playwright-js`（见下）
 *   ③ 含 `<` 且能解析出至少一个标签 → `html`
 *   都不命中 → `source: null` + 固定文案（`PASTE_UNKNOWN_REASON`），**写 0 条**。
 *
 * ## ② 的特征集为什么从「任两条」改成「两条 AND」（D-1 修复）
 * 老规则是 `DATE_HINTS`（`page.` / `getByRole(` / `getByText(` / `locator(`）命中 ≥2。实测 12 个
 * 用例里**漏判 7 个、误判 1 个**：
 * - 漏判：只用了 A₀ 新增单 kind 的脚本（`page.getByTestId('x')`、`page.getByLabel('x')`、
 *   `page.getByTitle('x')`、`page.get_by_test_id('x')`）只命中 `page.` 一条；弹窗别名
 *   `page1.getByText('x')` 连 `page.` 都命中不了（`page1.` 里没有这个子串）。
 * - 误判：`const mypage = {}; mypage.locator('x')` 命中 2 条 → 被判成 Playwright 脚本。
 *
 * 新规则是两个**结构性**特征：
 * - `PAGE_CALL`：`\bpage\d*\s*\.` —— `page` 必须是独立词（`mypage.` 不算），允许 `page0..N` 别名；
 * - `LOCATOR_CALL`：`.getBy[A-Z]*` / `.get_by_*` / `.locator(` / `.frameLocator(` —— 三语法都覆盖。
 *
 * 为什么 AND 而不是「任两条」：单独 `page.` 太松（任何 Node 脚本都可能出现），单独 `locator(`
 * 更松；而「页对象」与「定位方法」在同一条语句里**必然共现**（三个 codegen 生成器的动作行都以
 * `subject = pageAlias` 开头），所以 AND 既不放宽也不收紧真脚本。
 *
 * ## 三语法（`[A1-8]` (4)）
 * Target 是**自动判定 + 只读回显**，不是用户选择：`detectTarget` 只用于「按哪种写法去读参数」，
 * `PasteSource` 的取值**零改动**（`'playwright-js'` 现在语义是「任意 Target 的 codegen 脚本」）。
 */

import type { ElementPasteCandidate, PasteSource, PasteTarget } from './types';
import { PASTE_TARGET_LABEL, PASTE_UNKNOWN_REASON } from './types';
import { parseRecorder } from './parseRecorder';
import { parsePlaywright, parsePlaywrightReport } from './parsePlaywright';
import { parseHtml } from './parseHtml';
import { targetOfText } from './scan';

export interface DetectResult {
  source: PasteSource | null;
  candidates: ElementPasteCandidate[];
  /** 一句人话：凭什么认成这个格式 / 为什么认不出 */
  reason: string;
  /**
   * 「像定位行但认不出」的行数（`[A1-8]` (5) 的不静默口径）。
   * 纯动作行与非定位行**不计入**——它们是预期忽略。界面上要显示「N 行未识别」。
   */
  skippedLines: number;
}

/** ① 有页对象调用：`page.` / `page0..N.`，`page` 必须是独立词 */
const PAGE_CALL = /\bpage\d*\s*\./;
/** ② 有任一语言的定位方法 */
const LOCATOR_CALL = /\.(getBy[A-Z][A-Za-z]*|get_by_[a-z_]+|locator|frameLocator|frame_locator)\s*\(/;

/** 像不像 Playwright codegen 脚本（② 的判据，见文件头） */
export function looksLikePlaywrightScript(text: string): boolean {
  const s = String(text ?? '');
  return PAGE_CALL.test(s) && LOCATOR_CALL.test(s);
}

/**
 * 判定文本是哪种 codegen Target 的写法（契约 `[A1-8]` (4)）。
 * 顺序固定：Java（`AriaRole.` / 选项对象构造）→ Python（`get_by_*`）→ JS → `null`。
 */
export function detectTarget(text: string): PasteTarget | null {
  const s = String(text ?? '');
  if (!LOCATOR_CALL.test(s)) return null;
  return targetOfText(s);
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
  // Target 只影响「按哪种写法读参数」，不改变"这里是 Playwright 脚本"这个判断
  if (source === 'playwright-js') return parsePlaywright(text, detectTarget(text) ?? undefined);
  return parseHtml(text);
}

/** 自动识别 + 解析（粘贴框的默认路径） */
export function detectElementPaste(text: string): DetectResult {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  const none: DetectResult = { source: null, candidates: [], reason: PASTE_UNKNOWN_REASON, skippedLines: 0 };
  if (!trimmed) return none;

  // ① Recorder JSON
  if (looksRecorderJson(trimmed)) {
    const candidates = parseRecorder(trimmed);
    if (candidates.length) {
      return { source: 'recorder-json', candidates, reason: '认出来了：JSON 里有 steps[]，且首步带 selectors/type（DevTools Recorder 导出）', skippedLines: 0 };
    }
    return { source: 'recorder-json', candidates: [], reason: '是 Recorder JSON，但 steps 里没有可用的选择器', skippedLines: 0 };
  }

  // ② Playwright codegen 脚本（JS / Python / Java 任意混写）
  if (looksLikePlaywrightScript(trimmed)) {
    const target = detectTarget(trimmed);
    const report = parsePlaywrightReport(trimmed, target ?? undefined);
    const targetLabel = target ? `（${PASTE_TARGET_LABEL[target]} 写法）` : '';
    const skippedCount = report.skippedLines.length;
    const skipped = skippedCount ? `，其中 ${skippedCount} 行未识别` : '';
    if (report.candidates.length) {
      return {
        source: 'playwright-js',
        candidates: report.candidates,
        reason: `认出来了：Playwright codegen 脚本${targetLabel}${skipped}`,
        skippedLines: skippedCount,
      };
    }
    return {
      source: 'playwright-js',
      candidates: [],
      reason: skippedCount
        ? `像 Playwright 脚本，但没有可解析的定位行（${skippedCount} 行未识别）`
        : '像 Playwright 脚本，但没有可解析的定位行',
      skippedLines: skippedCount,
    };
  }

  // ③ HTML
  if (trimmed.includes('<')) {
    const candidates = parseHtml(trimmed);
    const hasTag = candidates.some((c) => c.confidence !== 'unknown');
    if (hasTag) {
      return { source: 'html', candidates, reason: '认出来了：含 < 且能解析出标签（Elements 复制的 HTML）', skippedLines: 0 };
    }
    return { source: 'html', candidates, reason: '含 < 但解析不出标签', skippedLines: 0 };
  }

  return none;
}
