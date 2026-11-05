import { describe, it, expect } from 'vitest';
import { signJwt, verifyJwtHs256, decodeJwt, b64urlEncode } from '../../utils/jwt';

/**
 * 权威向量：jwt.io 首页示例
 * header {"typ":"JWT","alg":"HS256"} payload {"sub":"1234567890","name":"John Doe","iat":1516239022}
 * secret "your-256-bit-secret"
 * → eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
 */
const VEC_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('b64urlEncode', () => {
  it('去掉填充并把 +/ 换成 -_', () => {
    const s = b64urlEncode('a?b>c~d');
    expect(s).not.toContain('=');
    expect(s).not.toContain('+');
    expect(s).not.toContain('/');
  });

  it('中文按 UTF-8 编码', () => {
    expect(b64urlEncode('中')).toBe('5Lit');
  });
});

describe('signJwt (HS256)', () => {
  it('复现 jwt.io 官方向量', async () => {
    const r = await signJwt({
      payload: { sub: '1234567890', name: 'John Doe', iat: 1516239022 },
      secret: 'your-256-bit-secret',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(VEC_TOKEN);
  });

  it('exp 按 expiresIn 计算', async () => {
    const r = await signJwt({ payload: { a: 1 }, secret: 's', expiresInSec: 60, issuedAt: 1_700_000_000_000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p = decodeJwt(r.token).payload!;
      expect(p.iat).toBe(1_700_000_000);
      expect(p.exp).toBe(1_700_000_060);
    }
  });

  it('空 secret / 非对象 payload 报错', async () => {
    expect((await signJwt({ payload: { a: 1 }, secret: '' })).ok).toBe(false);
    // @ts-expect-error 故意传错类型
    expect((await signJwt({ payload: [1, 2], secret: 's' })).ok).toBe(false);
  });

  it('自定义 header 合并', async () => {
    const r = await signJwt({ payload: { a: 1 }, secret: 's', header: { kid: 'k1' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const h = decodeJwt(r.token).header!;
      expect(h.alg).toBe('HS256');
      expect(h.kid).toBe('k1');
    }
  });
});

describe('verifyJwtHs256', () => {
  it('自己签的能验过', async () => {
    const r = await signJwt({ payload: { x: 1 }, secret: 'secret' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(await verifyJwtHs256(r.token, 'secret')).toBe(true);
  });

  it('换 secret 验不过', async () => {
    const r = await signJwt({ payload: { x: 1 }, secret: 'secret' });
    if (r.ok) expect(await verifyJwtHs256(r.token, 'other')).toBe(false);
  });

  it('段数不对直接 false', async () => {
    expect(await verifyJwtHs256('a.b', 's')).toBe(false);
  });
});

describe('decodeJwt', () => {
  it('解析官方向量', () => {
    const d = decodeJwt(VEC_TOKEN);
    expect(d.header?.alg).toBe('HS256');
    expect(d.payload?.name).toBe('John Doe');
  });

  it('乱码给错误', () => {
    expect(decodeJwt('not-a-token').error).toBeTruthy();
  });
});