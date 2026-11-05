import type { ApiAssertions, ApiResponseData, AssertOp, AssertRule } from '../types';

export interface AssertResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** 取 JSON 路径（a.b[0].c / a.list[*].id），与工具箱的 JSON 提取同一套规则 */
function pick(root: any, path: string): any {
  const clean = String(path || '').trim().replace(/^\$\.?/, '');
  if (!clean) return undefined;
  const tokens = clean.replace(/\[(\d+|\*)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any[] = [root];
  for (const t of tokens) {
    const next: any[] = [];
    for (const v of cur) {
      if (v === null || v === undefined) continue;
      if (t === '*') {
        if (Array.isArray(v)) next.push(...v);
        else if (typeof v === 'object') next.push(...Object.values(v));
      } else if (Array.isArray(v) && /^\d+$/.test(t)) {
        if (v[Number(t)] !== undefined) next.push(v[Number(t)]);
      } else if (typeof v === 'object' && (v as any)[t] !== undefined) {
        next.push((v as any)[t]);
      }
    }
    cur = next;
  }
  // 空数组表示「路径一格都没走下去」= 路径不存在，必须返回 undefined，
  // 否则「路径存在」断言会拿 [] 当有值（1.6.0 前的老实现也有这个问题）。
  return cur.length === 0 ? undefined : cur.length === 1 ? cur[0] : cur;
}

const str = (v: any) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/** 每种检查类型的界面文案 */
export const ASSERT_OPS: { v: AssertOp; label: string; targetPh: string; valuePh: string }[] = [
  { v: 'status', label: '状态码', targetPh: '—', valuePh: '200 或 2xx' },
  { v: 'time', label: '耗时 ≤', targetPh: '—', valuePh: '1000 (ms)' },
  { v: 'json', label: 'JSON 路径', targetPh: 'data.list[0].id', valuePh: '留空 = 只要路径存在' },
  { v: 'body', label: '正文包含', targetPh: '—', valuePh: '例如 "success":true' },
  { v: 'header', label: '响应头', targetPh: 'content-type', valuePh: '留空 = 只要有这个头' },
  { v: 'jsonValid', label: '是合法 JSON', targetPh: '—', valuePh: '—' },
];

const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `r${Math.random().toString(36).slice(2)}`);

/** 旧数据（5 个固定槽位）→ 规则列表 */
export function migrateAssertions(a: ApiAssertions | undefined): AssertRule[] {
  if (!a) return [];
  if (Array.isArray(a.rules)) return a.rules;
  const out: AssertRule[] = [];
  if (String(a.status || '').trim()) out.push({ id: newId(), op: 'status', value: String(a.status).trim() });
  if (String(a.maxMs || '').trim()) out.push({ id: newId(), op: 'time', value: String(a.maxMs).trim() });
  if (String(a.jsonPath || '').trim()) {
    out.push({ id: newId(), op: 'json', target: String(a.jsonPath).trim(), value: String(a.jsonValue ?? '') });
  }
  if (String(a.contains || '').trim()) out.push({ id: newId(), op: 'body', value: String(a.contains).trim() });
  return out;
}

/** 反向：规则列表 → 保存用的 ApiAssertions（只写 rules，不再写旧的槽位） */
export function toAssertions(rules: AssertRule[]): ApiAssertions {
  return { rules };
}

export function makeRule(op: AssertOp = 'status'): AssertRule {
  return { id: newId(), op, target: '', value: '' };
}

function ruleLabel(r: AssertRule): string {
  const v = String(r.value ?? '').trim();
  const t = String(r.target ?? '').trim();
  switch (r.op) {
    case 'status': return `状态码 ${r.negate ? '≠' : '='} ${v || '?'}`;
    case 'time': return r.negate ? `耗时 > ${v || '?'}ms` : `耗时 ≤ ${v || '?'}ms`;
    case 'json': return r.negate
      ? (v ? `${t} 不含“${v.slice(0, 20)}”` : `${t} 不存在`)
      : (v ? `${t} 含“${v.slice(0, 20)}”` : `${t} 存在`);
    case 'body': return `正文${r.negate ? '不含' : '包含'}“${v.slice(0, 24)}”`;
    case 'header': return r.negate
      ? (v ? `响应头 ${t} 不含“${v.slice(0, 20)}”` : `无响应头 ${t}`)
      : (v ? `响应头 ${t} 含“${v.slice(0, 20)}”` : `有响应头 ${t}`);
    case 'jsonValid': return r.negate ? '不是合法 JSON' : '是合法 JSON';
    default: return '断言';
  }
}

function runOne(r: AssertRule, resp: ApiResponseData): AssertResult {
  const value = String(r.value ?? '').trim();
  const target = String(r.target ?? '').trim();
  const mark = (ok: boolean, detail: string): AssertResult => ({ name: ruleLabel(r), ok: r.negate ? !ok : ok, detail });

  switch (r.op) {
    case 'status': {
      const actual = String(resp.status || '');
      const hit = /^\dxx$/i.test(value) ? actual.startsWith(value[0]) : actual === value;
      return mark(hit, `实际 ${actual || '无响应'}`);
    }
    case 'time': {
      const max = Number(value);
      const actual = Number(resp.timeMs || 0);
      if (!Number.isFinite(max) || max <= 0) return { name: ruleLabel(r), ok: false, detail: '断言值不是数字' };
      return mark(actual <= max, `实际 ${actual}ms`);
    }
    case 'json': {
      let json: any;
      try {
        json = JSON.parse(resp.body);
      } catch {
        return { name: ruleLabel(r), ok: false, detail: '响应不是合法 JSON' };
      }
      const v = pick(json, target);
      const actual = str(v);
      const exists = v !== undefined && v !== null;
      const hit = value === '' ? exists : actual.includes(value);
      return mark(hit, `实际 ${actual === '' ? '（空）' : actual.slice(0, 80)}`);
    }
    case 'body': {
      const hit = String(resp.body || '').includes(value);
      return mark(hit, hit ? '已命中' : '未找到');
    }
    case 'header': {
      const key = Object.keys(resp.headers || {}).find(k => k.toLowerCase() === target.toLowerCase());
      const actual = key ? String(resp.headers[key]) : '';
      const exists = !!key;
      const hit = value === '' ? exists : actual.toLowerCase().includes(value.toLowerCase());
      return mark(hit, exists ? `实际 ${actual.slice(0, 80)}` : '响应里没有这个头');
    }
    case 'jsonValid': {
      let ok = true;
      try { JSON.parse(resp.body); } catch { ok = false; }
      return mark(ok, ok ? '解析通过' : '解析失败');
    }
    default:
      return { name: '断言', ok: false, detail: '未知类型' };
  }
}

/** 跑一遍断言：只跑配置了的规则，全通过才算过 */
export function runAssertions(a: ApiAssertions | undefined, resp: ApiResponseData): AssertResult[] {
  return migrateAssertions(a).map(r => runOne(r, resp));
}

/** 有没有配置任何断言 */
export function hasAssertions(a: ApiAssertions | undefined): boolean {
  return migrateAssertions(a).length > 0;
}