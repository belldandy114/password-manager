/**
 * ① DevTools Recorder 导出的 JSON → 候选元素（1.36.0 / B6）。
 *
 * Recorder 的导出形状（Chromium 117+ 实测）：
 * ```json
 * { "title": "登录", "steps": [ { "type": "click", "title": "提交",
 *   "selectors": [ ["#submit"], ["aria/提交"] ] } ] }
 * ```
 * `selectors` 是**候选数组的数组**：外层按优先级排（Recorder 自己已经把最稳的放前面），
 * 内层是 `[selector, ...其它参数]`。这里只取每条步骤的**第一条可用候选** —— 一个元素一个定位器，
 * 多候选并存会让「改定位器」这件事没有唯一答案。
 *
 * 选择器前缀与映射（Recorder 的 `selectors` 语法）：
 * - `aria/提交` → 可访问名。元素库没有「aria 名」这种 kind，落到 `text`（可见文本最接近）；
 * - `role/button[name="登录"]` → `kind:'role'`（`locator` 存角色名、`role` 存可访问名，与 [C-28] 对齐）；
 * - `text/全部` → `kind:'text'`；
 * - `xpath/…`、`//…` → `kind:'xpath'`；
 * - 其余（`#id`、`.cls`、`div > span`）→ `kind:'css'`。
 */

import type { ElementPasteCandidate, PasteConfidence } from './types';
import { nameHint } from './types';

/** 结构性 css（换数据就会失配）：伪类 / 后代组合 / 纯标签 */
function cssConfidence(css: string): { confidence: PasteConfidence; reason: string } {
  const s = String(css ?? '').trim();
  if (!s) return { confidence: 'unknown', reason: '空选择器' };
  if (/:[a-z-]+\(|:(nth|first|last|eq)/i.test(s)) {
    return { confidence: 'guess', reason: 'css 里带结构性伪类（如 :nth-child），列表顺序一变就会指错行' };
  }
  if (/^#[\w-]+$/.test(s)) return { confidence: 'exact', reason: '按 id 定位，同一页只有一个' };
  if (/^\[[^\]]+="[^"]*"\]$/.test(s)) return { confidence: 'exact', reason: '按属性精确定位' };
  if (/^[a-z][\w-]*$/i.test(s)) return { confidence: 'guess', reason: '只有标签名（如 div），页面上通常不止一个' };
  if (/^\.[\w-]+$/.test(s) || /^[a-z][\w-]*\.[\w-]+/i.test(s)) {
    return { confidence: 'guess', reason: '按 class 定位，样式改名或同类多行时会失配' };
  }
  return { confidence: 'exact', reason: 'Recorder 记录的 css 选择器（含 id/属性组合，通常唯一）' };
}

/** `role/button[name="登录"]` → { role: 'button', name: '登录' } */
function parseRoleSelector(sel: string): { role: string; name: string } | null {
  const m = sel.match(/^role\/([\w-]+)(?:\[name="([^"]*)"\])?/i);
  if (!m) return null;
  return { role: m[1], name: m[2] ?? '' };
}

/** 单条 selector 文本 → 候选（不带 name，名字由调用方补） */
function candidateOfSelector(
  sel: string,
): { kind: ElementPasteCandidate['kind']; locator: string; role?: string; confidence: PasteConfidence; reason: string } | null {
  const s = String(sel ?? '').trim();
  if (!s) return null;

  const role = parseRoleSelector(s);
  if (role) {
    return {
      kind: 'role', locator: role.role.toLowerCase(), role: role.name,
      confidence: role.name ? 'exact' : 'guess',
      reason: role.name ? 'Recorder 记录的是「角色 + 可访问名」，语义稳定' : '只有角色名、没有可访问名，页面上同类元素会撞车',
    };
  }
  if (s.startsWith('aria/')) {
    const v = s.slice('aria/'.length);
    return { kind: 'text', locator: v, confidence: 'guess', reason: '可访问名按可见文本存（元素库没有 aria-name 这种类型）' };
  }
  if (s.startsWith('text/')) {
    return { kind: 'text', locator: s.slice('text/'.length), confidence: 'guess', reason: '按可见文本定位，文案一改就失配' };
  }
  if (s.startsWith('xpath/') || s.startsWith('//')) {
    return { kind: 'xpath', locator: s.replace(/^xpath\//, ''), confidence: 'guess', reason: 'xpath 与页面结构强耦合，改版就断' };
  }
  const css = s.replace(/^css\//, '');
  const c = cssConfidence(css);
  return { kind: 'css', locator: css, confidence: c.confidence, reason: c.reason };
}

/**
 * 解析 Recorder JSON。
 *
 * 认不出来（不是 JSON / 没有 steps）→ 空数组（**不抛**：用户可能把别的东西粘进来了，
 * 调用方据此显示「无法识别」并写 0 条）。
 */
export function parseRecorder(text: string): ElementPasteCandidate[] {
  let o: unknown;
  try {
    o = JSON.parse(String(text ?? ''));
  } catch {
    return [];
  }
  const steps = (o as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];

  const out: ElementPasteCandidate[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const s = step as { selectors?: unknown[]; title?: unknown; type?: unknown };
    if (!Array.isArray(s.selectors) || !s.selectors.length) continue;
    // 外层按优先级排：取第一条能识别的
    for (const entry of s.selectors) {
      const sel = Array.isArray(entry) ? entry[0] : entry;
      if (typeof sel !== 'string') continue;
      const c = candidateOfSelector(sel);
      if (!c) continue;
      const title = typeof s.title === 'string' ? s.title.trim() : '';
      const fallback = c.role || c.locator || (typeof s.type === 'string' ? s.type : '未命名元素');
      out.push({
        name: nameHint(title || fallback),
        locator: c.locator,
        kind: c.kind,
        ...(c.role ? { role: c.role } : {}),
        confidence: c.confidence,
        reason: `DevTools Recorder：${c.reason}`,
        source: 'recorder-json',
      });
      break; // 一条步骤只要一个候选
    }
  }
  return out;
}
