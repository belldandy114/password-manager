import { md5 } from './md5';

/**
 * 接口签名计算（工具箱「签名计算」）
 *
 * 覆盖最常见的几种签名约定：
 * - kv：`k1=v1&k2=v2` 按 key 排序拼接 + `&key=secret`（阿里云/微信风格的简化版）
 * - concat：只拼接值（`v1v2v3`）+ secret
 * - json：把对象按 key 排序后序列化 + secret
 */

export type SignMode = 'kv' | 'concat' | 'json';
export type SignAlgo = 'md5' | 'sha1' | 'sha256';

export interface SignOptions {
  /** 参数：`k=v` 每行一条，或 JSON 对象文本 */
  params: string;
  secret: string;
  mode?: SignMode;
  algo?: SignAlgo;
  /** 是否转大写（有些接口要求 32 位大写） */
  upper?: boolean;
  /** kv 模式下 secret 的拼接方式 */
  secretAt?: 'end' | 'start' | 'none';
  /** kv 模式下的分隔符 */
  separator?: string;
}

export interface SignResult {
  ok: boolean;
  error?: string;
  /** 参与摘要的原文（排错时最关键的信息） */
  signingInput?: string;
  /** 摘要结果 */
  sign?: string;
  /** 解析后的键值对 */
  pairs?: Array<[string, string]>;
}

/** 解析 `k=v` 多行文本（也接受 JSON 对象） */
export function parseSignParams(text: string): { ok: true; pairs: Array<[string, string]> } | { ok: false; error: string } {
  const src = String(text || '').trim();
  if (!src) return { ok: true, pairs: [] };

  if (src.startsWith('{')) {
    try {
      const obj = JSON.parse(src) as Record<string, unknown>;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'JSON 参数必须是对象' };
      return {
        ok: true,
        pairs: Object.keys(obj).map((k) => [k, obj[k] === null || obj[k] === undefined ? '' : String(obj[k])]),
      };
    } catch (e) {
      return { ok: false, error: `JSON 参数解析失败：${(e as Error).message}` };
    }
  }

  const pairs: Array<[string, string]> = [];
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) return { ok: false, error: `第 ${pairs.length + 1} 行缺少「=」：${t}` };
    pairs.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
  }
  return { ok: true, pairs };
}

/** 拼出待摘要字符串（不含摘要算法） */
export function buildSigningInput(opts: SignOptions): SignResult {
  const parsed = parseSignParams(opts.params);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const mode = opts.mode || 'kv';
  const secret = opts.secret ?? '';
  const secretAt = opts.secretAt || 'end';
  const sep = opts.separator ?? '&';

  // 空值是否参与：这里统一参与（多数网关如此），并在界面上说明
  const pairs = parsed.pairs.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let core: string;
  if (mode === 'concat') {
    core = pairs.map(([, v]) => v).join('');
  } else if (mode === 'json') {
    const obj: Record<string, string> = {};
    for (const [k, v] of pairs) obj[k] = v;
    core = JSON.stringify(obj);
  } else {
    core = pairs.map(([k, v]) => `${k}=${v}`).join(sep);
  }

  let signingInput = core;
  if (secretAt === 'end' && secret) signingInput = core ? `${core}${sep}key=${secret}` : `key=${secret}`;
  else if (secretAt === 'start' && secret) signingInput = `${secret}${core}`;
  else if (secretAt === 'end' && !secret) signingInput = core;

  return { ok: true, signingInput, pairs };
}

async function sha(alg: 'SHA-1' | 'SHA-256', text: string): Promise<string> {
  const buf = await crypto.subtle.digest(alg, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 计算签名（md5 同步、sha 异步，统一 async 出口） */
export async function computeSign(opts: SignOptions): Promise<SignResult> {
  const built = buildSigningInput(opts);
  if (!built.ok) return built;
  const input = built.signingInput || '';
  let sign: string;
  try {
    if ((opts.algo || 'md5') === 'md5') sign = md5(input);
    else if (opts.algo === 'sha1') sign = await sha('SHA-1', input);
    else sign = await sha('SHA-256', input);
  } catch (e) {
    return { ok: false, error: `计算失败：${(e as Error).message}` };
  }
  if (opts.upper) sign = sign.toUpperCase();
  return { ok: true, signingInput: input, sign, pairs: built.pairs };
}