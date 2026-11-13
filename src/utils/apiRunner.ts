/**
 * 接口批量运行器。
 *
 * 从 ApiClient 页面里抽出来的原因：这套「逐条发请求 → 校验断言 → 提取变量喂给下一条」
 * 的流程，除了手动批量运行，还要被**定时回归**复用。留在页面里，定时器只能再抄一遍，
 * 抄完两边行为就会慢慢跑偏（尤其是变量池和断言判定这两处）。
 *
 * 这里刻意不碰 React、不碰 store：只接收「请求数组 + 发送函数」，
 * 这样单测能直接喂假 send，页面和调度器用的是同一份实现。
 */
import type { ApiRequest, ApiResponseData } from '../types';
import { runAssertions, type AssertResult } from './apiAssert';
import { applyVars, mergeVarPool, readJsonPath } from './apiVars';

/** 一条请求跑完的结果（页面表格 / 落盘的运行记录都用这个形状） */
export interface RunStep {
  id: string;
  name: string;
  method: string;
  /** 变量替换之后的最终 URL，报告里显示这个才有意义 */
  url: string;
  ok: boolean;
  status: number;
  timeMs: number;
  error?: string;
  asserts: AssertResult[];
  /** 这一步从响应里提取出来的变量 */
  extracted?: Record<string, string>;
  /** 配了提取规则但没取到值的变量名 */
  extractMissing?: string[];
}

export interface RunnerPayload {
  method: string;
  url: string;
  headers: string;
  body: string;
  bodyType: 'json' | 'form' | 'multipart' | 'raw' | 'none';
  rawContentType: string;
  autoSession: boolean;
}

export interface RunnerResult {
  success: boolean;
  data?: ApiResponseData;
  error?: string;
}

export interface RunOptions {
  /** 带上会话 Cookie（页面上的「自动带上会话」开关） */
  autoSession?: boolean;
  send: (payload: RunnerPayload) => Promise<RunnerResult>;
  /** 每跑完一条回调一次，页面用来做流式渲染 */
  onStep?: (rows: RunStep[]) => void;
  /** 返回 true 就中止后续请求（关掉弹窗、切走了页面） */
  shouldStop?: () => boolean;
}

/** 把 cookies（每行 key=value）拼成 Cookie 头；已有 Cookie 头时不覆盖 */
export function withCookies(headers: string, cookies?: string): string {
  const ck = String(cookies || '').split('\n').map(l => l.trim()).filter(Boolean).join('; ');
  if (!ck) return headers;
  if (/^cookie\s*:/im.test(headers || '')) return headers;
  const base = String(headers || '').replace(/\n+$/, '');
  return `${base ? `${base}\n` : ''}Cookie: ${ck}`;
}

/**
 * 顺序跑一组请求。**必须顺序**：后面的请求可能用到前面提取出来的变量。
 */
export async function runRequests(list: ApiRequest[], opts: RunOptions): Promise<RunStep[]> {
  const rows: RunStep[] = [];
  /** 上游提取出来的变量，覆盖请求自身变量里的同名键 */
  const pool: Record<string, string> = {};

  for (const r of list) {
    if (opts.shouldStop && opts.shouldStop()) break;

    const vars = mergeVarPool(r.variables || '', pool);
    const url = applyVars(r.url, vars);
    const headers = withCookies(applyVars(r.headers, vars), r.cookies);
    const body = applyVars(r.body, vars);

    const res = await opts.send({
      method: r.method,
      url,
      headers,
      body,
      bodyType: r.bodyType || 'json',
      rawContentType: r.rawContentType || '',
      autoSession: !!opts.autoSession,
    });

    const asserts = res.success && res.data ? runAssertions(r.assertions, res.data) : [];
    const ok = !!(res.success && res.data) && (asserts.length === 0 || asserts.every(a => a.ok));

    // 提取变量：只在请求成功且响应是 JSON 时尝试，取不到就记一条提示
    let extracted: Record<string, string> | undefined;
    const extractMissing: string[] = [];
    if (ok && res.data && Array.isArray(r.extract) && r.extract.length > 0) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(res.data.body || 'null'); } catch { parsed = null; }
      const got: Record<string, string> = {};
      for (const rule of r.extract) {
        const name = String(rule.name || '').trim();
        if (!name) continue;
        const v = readJsonPath(parsed, rule.path || '');
        if (v === undefined) { extractMissing.push(name); continue; }
        got[name] = v;
        pool[name] = v;
      }
      if (Object.keys(got).length > 0) extracted = got;
    }

    rows.push({
      id: r.id,
      name: r.name,
      method: r.method,
      url,
      ok,
      status: res.data?.status || 0,
      timeMs: res.data?.timeMs || 0,
      error: res.success ? undefined : res.error,
      asserts,
      extracted,
      extractMissing: extractMissing.length ? extractMissing : undefined,
    });
    if (opts.onStep) opts.onStep([...rows]);
  }

  return rows;
}
