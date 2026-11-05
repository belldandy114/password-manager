import { describe, it, expect } from 'vitest';
import { inspectVaultFile, MIN_BYTES, SALT_LENGTH, IV_LENGTH, TAG_LENGTH, ALGO } from '../../../electron/vault-file.js';

/**
 * tsconfig 不含 node 类型（AGENTS.md 的约定），所以测试里不能用 Buffer。
 * 这里自己写一个最小 base64 编码，够造「合法/截断/过短」三类样本。
 */
const b64 = (bytes: number[]): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += b === undefined ? '=' : chars[(n >> 6) & 63];
    out += c === undefined ? '=' : chars[n & 63];
  }
  return out;
};

/** 造一个合法的「假密码库文件」：头部(64B) + 任意密文 */
const makeVault = (cipherBytes = 100): string =>
  b64(Array.from({ length: SALT_LENGTH + IV_LENGTH + TAG_LENGTH + cipherBytes }, (_, i) => (i * 7 + 3) & 0xff));

describe('vault-file 常量', () => {
  it('算法与长度与 main.js 约定一致（文件格式不能随手改）', () => {
    expect(ALGO).toBe('aes-256-gcm');
    expect(SALT_LENGTH).toBe(32);
    expect(IV_LENGTH).toBe(16);
    expect(TAG_LENGTH).toBe(16);
    expect(MIN_BYTES).toBe(SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1);
  });
});

describe('vault-file.inspectVaultFile 结构自检', () => {
  it('正常文件：ok 且字节数正确', () => {
    const r = inspectVaultFile(makeVault(100));
    expect(r.ok).toBe(true);
    expect(r.bytes).toBe(SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 100);
  });

  it('首尾空白/换行不影响判断（编辑器保存会带换行）', () => {
    expect(inspectVaultFile(`\n  ${makeVault(10)}  \r\n`).ok).toBe(true);
  });

  it('空文件报错', () => {
    for (const bad of ['', '   ', '\n']) {
      const r = inspectVaultFile(bad);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('空');
    }
  });

  it('非 base64 内容报错（选错文件的情况）', () => {
    const r = inspectVaultFile('这不是密码库文件，只是一段中文');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('base64');
  });

  it('长度不整除 4 报错；合法但太短的报「过短」', () => {
    expect(inspectVaultFile('QUJ').error).toContain('base64');
    const short = inspectVaultFile('QUJD'); // 合法 base64，但只有 3 字节
    expect(short.ok).toBe(false);
    expect(short.error).toContain('过短');
  });

  it('只有头部、没有密文时报「过短」', () => {
    const headOnly = b64(Array.from({ length: SALT_LENGTH + IV_LENGTH + TAG_LENGTH }, () => 1));
    const r = inspectVaultFile(headOnly);
    expect(r.ok).toBe(false);
    expect(r.bytes).toBe(MIN_BYTES - 1);
    expect(r.error).toContain('过短');
  });

  it('截断的文件（少一半）能被识别出来', () => {
    const full = makeVault(1000);
    const cut = full.slice(0, Math.floor(full.length / 2));
    expect(inspectVaultFile(cut).ok).toBe(false);
  });

  it('null/undefined 不抛异常', () => {
    expect(() => inspectVaultFile(null as unknown as string)).not.toThrow();
    expect(inspectVaultFile(undefined as unknown as string).ok).toBe(false);
  });
});
