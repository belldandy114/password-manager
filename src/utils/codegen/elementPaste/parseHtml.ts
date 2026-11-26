/**
 * ③ Elements 面板复制出来的 outerHTML → 候选元素（1.36.0 / B6）。
 *
 * 输入通常是**一个元素**的 `outerHTML`（也可能是多行 HTML 片段，这里只取第一个标签）。
 *
 * ⚠️ 刻意**不用 `DOMParser`**：本模块要能在 node 里跑单测、也要能在渲染层跑，两边行为必须一致；
 * 而 `DOMParser` 对「半截 HTML」的容错规则是浏览器的实现细节（会把 `<div>` 自动补齐成整棵树），
 * 用正则只取首个标签的**属性**，行为可预测、可断言。代价是不支持注释/脚本里的假标签 —— 粘贴导入
 * 本来就是给「复制一个元素」用的，不做整页 HTML 解析。
 *
 * css 推定顺序（先到先用）：`#id` → `[aria-label="…"]` → `[name="…"]` → `tag.class1` → `tag`；
 * 前三种算 `exact`，后两种（会命中多个元素）算 `guess`，连标签都没有则 `unknown`（`locator: ''`）。
 */

import type { ElementPasteCandidate, PasteConfidence } from './types';
import { nameHint } from './types';

interface TagInfo {
  tag: string;
  attrs: Record<string, string>;
  innerText: string;
}

/** 取第一个标签的 tag / 属性 / 文本（属性值支持单双引号） */
function firstTag(html: string): TagInfo | null {
  const src = String(html ?? '');
  const m = src.match(/<([a-zA-Z][\w:-]*)((?:\s+[^\s/>=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/);
  if (!m) return null;
  const attrText = m[2] || '';
  const attrs: Record<string, string> = {};
  const re = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(attrText)) !== null) {
    const key = a[1].toLowerCase();
    const val = a[2] ?? a[3] ?? a[4] ?? '';
    attrs[key] = val;
  }
  const after = src.slice((m.index || 0) + m[0].length);
  const close = after.search(/<\/|<[a-zA-Z]/);
  const inner = close >= 0 ? after.slice(0, close) : after;
  const innerText = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return { tag: m[1].toLowerCase(), attrs, innerText };
}

/** 推定 css + 把握度 */
function cssOf(info: TagInfo): { locator: string; confidence: PasteConfidence; reason: string } {
  const id = String(info.attrs.id || '').trim();
  if (id) return { locator: `#${id}`, confidence: 'exact', reason: 'Elements HTML：按 id 定位，同一页唯一' };

  const aria = String(info.attrs['aria-label'] || '').trim();
  if (aria) return { locator: `[aria-label="${aria}"]`, confidence: 'exact', reason: 'Elements HTML：按 aria-label 精确定位' };

  const name = String(info.attrs.name || '').trim();
  if (name) return { locator: `[name="${name}"]`, confidence: 'exact', reason: 'Elements HTML：按 name 属性精确定位' };

  const cls = String(info.attrs.class || '').trim().split(/\s+/).filter(Boolean)[0];
  if (cls) {
    return { locator: `.${cls}`, confidence: 'guess', reason: 'Elements HTML：只有 class 可用，属结构性 css（同类元素可能不止一个）' };
  }
  return { locator: info.tag, confidence: 'guess', reason: 'Elements HTML：只有标签名可用，属结构性 css（页面上通常不止一个）' };
}

/**
 * 解析 HTML（outerHTML / 元素片段）。
 * 连标签都解析不出 → 返回**一条** `unknown` 候选（`locator: ''`，名字取文本前 30 字）：
 * 这样预览表能显示「这段粘进来的是什么」，而不是静默 0 条。
 */
export function parseHtml(text: string): ElementPasteCandidate[] {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const info = firstTag(raw);
  if (!info) {
    return [{
      name: nameHint(raw.slice(0, 60)),
      locator: '',
      kind: 'css',
      confidence: 'unknown',
      reason: 'Elements HTML：这段输入里没有可解析的标签（可能只复制了文本）',
      source: 'html',
    }];
  }
  const css = cssOf(info);
  const nameSource = info.innerText || info.attrs['aria-label'] || info.attrs.placeholder || css.locator;
  return [{
    name: nameHint(nameSource || info.tag),
    locator: css.locator,
    kind: 'css',
    confidence: css.confidence,
    reason: css.reason,
    source: 'html',
  }];
}
