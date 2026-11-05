/**
 * JSON 结构对比（工具箱「JSON 对比」）
 *
 * 文本 diff 对格式化过的 JSON 会把整段标红（缩进/顺序变一点就全变），
 * 这里按 key 递归比较，只报「哪个路径增/删/改」。
 */

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  /** 路径，如 `data.list[0].name`；根为 `$` */
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
}

type Json = unknown;

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function short(v: Json, max = 120): string {
  if (v === undefined) return 'undefined';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function formatDiffValue(v: Json): string {
  return short(v, 160);
}

/**
 * 递归比较两个 JSON 值。
 * - 数组按下标比较（不做「元素移动」的智能对齐，避免误报成一片改动）
 * - 值类型不同算 changed
 * - 忽略 key 顺序（对象按并集遍历）
 */
export function diffJson(a: Json, b: Json, opts: { ignoreKeyOrder?: boolean } = {}): DiffEntry[] {
  void opts;
  const out: DiffEntry[] = [];

  const walk = (av: Json, bv: Json, path: string) => {
    const ta = typeOf(av);
    const tb = typeOf(bv);

    if (ta !== tb) {
      out.push({ path, kind: 'changed', before: av, after: bv });
      return;
    }

    if (ta === 'array') {
      const aa = av as Json[];
      const bb = bv as Json[];
      const len = Math.max(aa.length, bb.length);
      for (let i = 0; i < len; i += 1) {
        const p = `${path}[${i}]`;
        if (i >= aa.length) out.push({ path: p, kind: 'added', after: bb[i] });
        else if (i >= bb.length) out.push({ path: p, kind: 'removed', before: aa[i] });
        else walk(aa[i], bb[i], p);
      }
      return;
    }

    if (ta === 'object') {
      const ao = av as Record<string, Json>;
      const bo = bv as Record<string, Json>;
      const keys = Array.from(new Set([...Object.keys(ao), ...Object.keys(bo)]));
      for (const k of keys) {
        const p = path === '$' ? k : `${path}.${k}`;
        const inA = Object.prototype.hasOwnProperty.call(ao, k);
        const inB = Object.prototype.hasOwnProperty.call(bo, k);
        if (!inB) out.push({ path: p, kind: 'removed', before: ao[k] });
        else if (!inA) out.push({ path: p, kind: 'added', after: bo[k] });
        else walk(ao[k], bo[k], p);
      }
      return;
    }

    if (av !== bv) out.push({ path, kind: 'changed', before: av, after: bv });
  };

  walk(a, b, '$');
  return out;
}

/** 把 diff 结果转成可复制的文本 */
export function diffToText(entries: DiffEntry[]): string {
  if (!entries.length) return '（没有差异）';
  return entries
    .map((e) => {
      const sign = e.kind === 'added' ? '+' : e.kind === 'removed' ? '-' : '~';
      if (e.kind === 'added') return `${sign} ${e.path} = ${formatDiffValue(e.after)}`;
      if (e.kind === 'removed') return `${sign} ${e.path} = ${formatDiffValue(e.before)}`;
      return `${sign} ${e.path}: ${formatDiffValue(e.before)} → ${formatDiffValue(e.after)}`;
    })
    .join('\n');
}