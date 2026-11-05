'use strict';

/**
 * 从 JSON 响应里抽出「可提取为变量」的叶子字段。
 *
 * 用途：登录接口拿到 token 之后，下一步请求要带 `Authorization: Bearer {{token}}`。
 * 以前只能手动从响应里抄，抄错一个字符就 401。现在点一下字段就生成变量。
 *
 * 设计取舍：
 * - 只取**叶子**（string/number/boolean/null），数组和对象不单独成行（但数组元素会展开，最多 maxItems 条）；
 * - 路径用点号表示（`data.token`），与 `{{变量}}` 的取值习惯一致；
 * - 太长的字符串截断显示，但**存进变量的是完整值**（截断只发生在展示层）。
 */

const MAX_ARRAY_ITEMS = 5;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function leafText(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * @param {any} root 解析后的 JSON
 * @param {{ max?: number, maxStringShow?: number }} [opts]
 * @returns {{ path: string, name: string, value: string, preview: string, type: string }[]}
 */
function flattenJsonPaths(root, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : 300;
  const showLen = Number(opts.maxStringShow) > 0 ? Number(opts.maxStringShow) : 80;
  const out = [];

  const walk = (node, path) => {
    if (out.length >= max) return;
    if (Array.isArray(node)) {
      const n = Math.min(node.length, MAX_ARRAY_ITEMS);
      for (let i = 0; i < n; i++) walk(node[i], path ? `${path}.${i}` : String(i));
      return;
    }
    if (isPlainObject(node)) {
      for (const k of Object.keys(node)) walk(node[k], path ? `${path}.${k}` : k);
      return;
    }
    const value = leafText(node);
    const lastSeg = path.split('.').pop() || path;
    const type = node === null ? 'null' : typeof node;
    out.push({
      path,
      name: lastSeg,
      value,
      preview: value.length > showLen ? `${value.slice(0, showLen)}…` : value,
      type,
    });
  };

  // 根是 null/undefined 时没有「字段」可言（否则会产出一条 path 为空的假字段）
  if (root === null || root === undefined) return out;
  walk(root, '');
  return out;
}

/** 把「提取出的字段」写进变量表文本（同名覆盖），返回新的变量表文本 */
function upsertVariable(varsText, name, value) {
  const key = String(name || '').trim();
  if (!key) return String(varsText || '');
  const lines = String(varsText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const at = l.indexOf('=');
      if (at <= 0) return true;
      return l.slice(0, at).trim() !== key;
    });
  lines.push(`${key}=${String(value == null ? '' : value)}`);
  return lines.join('\n');
}

module.exports = { flattenJsonPaths, upsertVariable, MAX_ARRAY_ITEMS };
