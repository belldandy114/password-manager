/**
 * JWT 生成（HS256）与解析辅助
 *
 * 只用 WebCrypto（`crypto.subtle`），不引第三方库；渲染层与测试环境都有。
 */

export interface JwtHeader {
  alg?: string;
  typ?: string;
  [k: string]: unknown;
}

export interface JwtPayload {
  [k: string]: unknown;
}

/** base64url 编码（无填充） */
export function b64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function'
    ? btoa(bin)
    : // 测试/主进程环境兜底
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 解码成 UTF-8 文本 */
export function b64urlDecodeToString(input: string): string {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = typeof atob === 'function'
    ? atob(s + pad)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Buffer.from(s + pad, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** HMAC-SHA256 签名（返回 base64url） */
async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

export interface SignJwtOptions {
  payload: JwtPayload;
  secret: string;
  /** 附带标准声明；传 0 表示不带 exp */
  expiresInSec?: number;
  issuedAt?: number;
  header?: JwtHeader;
}

/**
 * 生成 HS256 JWT。
 * 返回 `{ ok:true, token }` 或 `{ ok:false, error }`（payload 不是对象、secret 为空等）。
 */
export async function signJwt(opts: SignJwtOptions): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const { payload, secret } = opts;
  if (!secret) return { ok: false, error: 'secret 不能为空' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload 必须是 JSON 对象' };
  }

  const now = Math.floor((opts.issuedAt ?? Date.now()) / 1000);
  const body: JwtPayload = { ...payload };
  if (opts.expiresInSec && opts.expiresInSec > 0) body.exp = now + opts.expiresInSec;
  if (body.iat === undefined) body.iat = now;

  const header: JwtHeader = { alg: 'HS256', typ: 'JWT', ...(opts.header || {}) };
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(body))}`;
  try {
    const sig = await hmacSha256(secret, signingInput);
    return { ok: true, token: `${signingInput}.${sig}` };
  } catch (e) {
    return { ok: false, error: `签名失败：${(e as Error).message}` };
  }
}

/** 校验 HS256 token（工具箱里用来确认自己生成的对不对） */
export async function verifyJwtHs256(token: string, secret: string): Promise<boolean> {
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  try {
    const expect = await hmacSha256(secret, `${parts[0]}.${parts[1]}`);
    return expect === parts[2];
  } catch {
    return false;
  }
}

/** 解析 header / payload（不校验签名） */
export function decodeJwt(token: string): { header?: JwtHeader; payload?: JwtPayload; error?: string } {
  const parts = String(token || '').trim().split('.');
  if (parts.length < 2) return { error: '不是合法的 JWT（应为三段，用 . 分隔）' };
  try {
    return {
      header: JSON.parse(b64urlDecodeToString(parts[0])) as JwtHeader,
      payload: JSON.parse(b64urlDecodeToString(parts[1])) as JwtPayload,
    };
  } catch (e) {
    return { error: `解析失败：${(e as Error).message}` };
  }
}