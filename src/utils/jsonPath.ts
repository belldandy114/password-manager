/**
 * JSON 路径取值 / 递归取 key —— 从 Toolbox 抽出来，
 * 「JSON 转化」里的「按路径提取」页签与单元测试共用。
 */

/** 按路径取值：支持 `a.b[0].c`、`$.a.b`、`list[*].name`；空路径返回整体 */
export function pickByPath(root: unknown, path: string): unknown {
  const clean = String(path || '').trim().replace(/^\$\.?/, '');
  if (!clean) return root;
  const tokens = clean.replace(/\[(\d+|\*)\]/g, '.$1').split('.').filter((t) => t !== '');
  let cur: unknown[] = [root];
  for (const t of tokens) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v === null || v === undefined) continue;
      if (t === '*') {
        if (Array.isArray(v)) next.push(...v);
        else if (typeof v === 'object') next.push(...Object.values(v as Record<string, unknown>));
      } else if (Array.isArray(v) && /^\d+$/.test(t)) {
        if (v[Number(t)] !== undefined) next.push(v[Number(t)]);
      } else if (typeof v === 'object' && (v as Record<string, unknown>)[t] !== undefined) {
        next.push((v as Record<string, unknown>)[t]);
      }
    }
    cur = next;
  }
  return cur.length === 1 ? cur[0] : cur;
}

/** 递归收集某个 key 的所有值（不管嵌套多深） */
export function collectKey(root: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(root)) {
    root.forEach((v) => collectKey(v, key, out));
  } else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      if (k === key) out.push(v);
      collectKey(v, key, out);
    }
  }
  return out;
}