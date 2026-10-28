import type { ApiAssertions, ApiResponseData } from '../types';

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
  return cur.length === 1 ? cur[0] : cur;
}

const str = (v: any) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * 跑一遍断言：只断言填了的项，全通过才算过。
 * 状态码支持精确（200）与前缀通配（2xx）。
 */
export function runAssertions(a: ApiAssertions | undefined, resp: ApiResponseData): AssertResult[] {
  if (!a) return [];
  const out: AssertResult[] = [];

  const status = String(a.status || '').trim();
  if (status) {
    const actual = String(resp.status || '');
    const ok = /^\dxx$/i.test(status)
      ? actual.startsWith(status[0])
      : actual === status;
    out.push({ name: `状态码 = ${status}`, ok, detail: `实际 ${actual || '无响应'}` });
  }

  const maxMs = Number(String(a.maxMs || '').trim());
  if (Number.isFinite(maxMs) && maxMs > 0) {
    const ok = Number(resp.timeMs || 0) <= maxMs;
    out.push({ name: `耗时 ≤ ${maxMs}ms`, ok, detail: `实际 ${resp.timeMs}ms` });
  }

  const path = String(a.jsonPath || '').trim();
  if (path) {
    let actual = '';
    let ok = false;
    try {
      const json = JSON.parse(resp.body);
      const v = pick(json, path);
      actual = str(v);
      const expect = String(a.jsonValue ?? '');
      // 期望值为空时只断言「该路径存在」
      ok = expect === '' ? v !== undefined && v !== null : actual.includes(expect);
    } catch {
      actual = '响应不是合法 JSON';
    }
    out.push({
      name: expectLabel(path, a.jsonValue),
      ok,
      detail: `实际 ${actual === '' ? '（空）' : actual.slice(0, 80)}`,
    });
  }

  const contains = String(a.contains || '').trim();
  if (contains) {
    const ok = String(resp.body || '').includes(contains);
    out.push({ name: `正文包含“${contains.slice(0, 24)}”`, ok, detail: ok ? '已命中' : '未找到' });
  }

  return out;
}

function expectLabel(path: string, value?: string) {
  const v = String(value ?? '');
  return v === '' ? `${path} 存在` : `${path} 包含“${v.slice(0, 20)}”`;
}

/** 有没有配置任何断言 */
export function hasAssertions(a: ApiAssertions | undefined): boolean {
  if (!a) return false;
  return !!String(a.status || '').trim()
    || !!String(a.maxMs || '').trim()
    || !!String(a.jsonPath || '').trim()
    || !!String(a.contains || '').trim();
}
