'use strict';

/**
 * 禅道页面解析的纯函数（从 main.js 下沉，便于单测）。
 *
 * 背景：禅道 20.x 把表格数据塞进 DOM 属性 `zui-create-dtable="..."`，
 * 但它**不是合法 JSON** —— 属性里混了 JS 函数体等非 JSON 片段，
 * 且引号被 HTML 实体编码。所以只能：先解实体 → 找到 `"data":` → 按括号配平截取数组 → JSON.parse。
 *
 * 这段逻辑以前埋在 main.js 里没有任何测试，改错就是「拉不到 Bug、界面空白」。
 */

/** HTML 实体解码（注意 &amp; 必须最后替换，否则 &amp;lt; 会被二次解码） */
const ztDecodeEntities = (s) => String(s == null ? '' : s)
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'")
  .replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&#x2F;/g, '/')
  .replace(/&amp;/g, '&');

/** 富文本 → 单行纯文本（用于 Bug 标题这类一行展示的位置） */
const ztStripTags = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * 从 dtable 属性里截出 data 数组并解析。
 * 任何一步不对劲都返回 []（调用方按「没有数据」处理，不要抛异常把整页搞崩）。
 * @param {string} html 页面 HTML
 * @returns {unknown[]}
 */
function ztTableRows(html) {
  if (!html) return [];
  const attr = String(html).match(/zui-create-dtable="([^"]*)"/);
  if (!attr) return [];
  const raw = ztDecodeEntities(attr[1]);
  const marker = '"data":';
  const at = raw.indexOf(marker);
  if (at < 0) return [];
  let i = at + marker.length;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] !== '[') return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let j = i; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) return [];
  try {
    const arr = JSON.parse(raw.slice(i, end));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

module.exports = { ztDecodeEntities, ztStripTags, ztTableRows };
