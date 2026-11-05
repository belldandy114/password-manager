import { describe, it, expect } from 'vitest';
import { totpAt, base32Decode, generatePassword } from '../../../electron/ipc-tools.js';

/** RFC 6238 附录 B 的测试密钥（ASCII "12345678901234567890"）的 base32 形式 */
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('ipc-tools.totpAt（RFC 6238 官方向量，SHA1 / 30s / 8 位）', () => {
  // 时间戳 → 期望码，全部来自 RFC 6238 附录 B
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [t, expected] of vectors) {
    it(`T=${t} → ${expected}`, () => {
      expect(totpAt(SECRET, t * 1000, 8, 30)).toBe(expected);
    });
  }

  it('默认 6 位：取 8 位结果的后 6 位', () => {
    expect(totpAt(SECRET, 59 * 1000)).toBe('287082');
  });

  it('60 秒周期下相邻时间片不同（避免「永远同一个码」的低级错误）', () => {
    const a = totpAt(SECRET, 59 * 1000, 6, 30);
    const b = totpAt(SECRET, 61 * 1000, 6, 30);
    expect(a).not.toBe(b);
  });

  it('密钥无效 / 空 → null，不抛异常', () => {
    expect(totpAt('', 0)).toBeNull();
    expect(totpAt('!!!!', 0)).toBeNull();
    expect(() => totpAt(undefined as unknown as string, 0)).not.toThrow();
  });

  it('base32 解码容忍空格与分隔符', () => {
    expect(base32Decode('GEZD GNBV-GY3T').length).toBeGreaterThan(0);
    expect(base32Decode('').length).toBe(0);
  });
});

describe('ipc-tools.generatePassword', () => {
  it('默认长度 16；过长夹到 128，过短夹到 6', () => {
    expect(generatePassword().password!.length).toBe(16);
    expect(generatePassword({ length: 200 }).password!.length).toBe(128);
    expect(generatePassword({ length: 1 }).password!.length).toBe(6);
  });

  it('每种勾选的字符集至少出现一次（多跑几轮防止偶然）', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 12, symbols: true }).password!;
      expect(/[a-z]/.test(p)).toBe(true);
      expect(/[A-Z]/.test(p)).toBe(true);
      expect(/\d/.test(p)).toBe(true);
      expect(/[!@#$%^&*()\-_=+[\]{};:,.?/]/.test(p)).toBe(true);
    }
  });

  it('不勾符号时不会出现符号', () => {
    for (let i = 0; i < 30; i++) {
      expect(/^[A-Za-z0-9]+$/.test(generatePassword({ length: 24 }).password!)).toBe(true);
    }
  });

  it('excludeAmbiguous 去掉 Il1O0o', () => {
    for (let i = 0; i < 40; i++) {
      expect(/[Il1O0o]/.test(generatePassword({ length: 40, excludeAmbiguous: true }).password!)).toBe(false);
    }
  });

  it('全部字符集都关掉 → 明确报错', () => {
    const r = generatePassword({ lower: false, upper: false, digits: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('至少');
  });

  it('两次生成结果不同（有随机性）', () => {
    const a = generatePassword({ length: 24 }).password;
    const b = generatePassword({ length: 24 }).password;
    expect(a).not.toBe(b);
  });
});
