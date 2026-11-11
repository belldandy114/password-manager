import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createClipHistory, CLIP_HISTORY_MAX, CLIP_HISTORY_FILE } from '../../../electron/clip-history.js';

/**
 * 剪贴板历史的落盘行为。
 *
 * 这里用真文件而不是 mock fs：这个模块的价值全在「关掉应用再打开还能读回来」，
 * 用内存桩测等于把要验证的东西替换掉了。加密用可逆的假实现（真 AES 在
 * vault-file 那边已有覆盖），只验证「写进去的是密文、读回来的是原文」。
 */
const fakeEncrypt = (plain: string, pw: string) => `enc:${pw}:${Buffer.from(plain, 'utf8').toString('base64')}`;
const fakeDecrypt = (cipher: string, pw: string) => {
  const m = /^enc:([^:]*):(.*)$/.exec(cipher);
  if (!m || m[1] !== pw) return null;
  return Buffer.from(m[2], 'base64').toString('utf8');
};

let dir = '';
let password: string | null = 'pw1';
let enabled = true;

function make() {
  return createClipHistory({
    dir,
    encrypt: fakeEncrypt,
    decrypt: fakeDecrypt,
    writeFileAtomic: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    },
    getPassword: () => password,
    isEnabled: () => enabled,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-clip-'));
  password = 'pw1';
  enabled = true;
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('createClipHistory', () => {
  it('关闭开关时不记录、不落盘', () => {
    enabled = false;
    const h = make();
    h.remember('secret');
    expect(h.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, CLIP_HISTORY_FILE))).toBe(false);
  });

  it('记录后落盘的是密文，不含明文', () => {
    const h = make();
    h.remember('hunter2');
    const raw = fs.readFileSync(path.join(dir, CLIP_HISTORY_FILE), 'utf8');
    expect(raw.startsWith('enc:pw1:')).toBe(true);
    expect(raw).not.toContain('hunter2');
  });

  it('新实例（模拟重启）能读回上次的历史', () => {
    make().remember('hunter2');
    const h2 = make();
    expect(h2.load().map((x) => x.text)).toEqual(['hunter2']);
  });

  it('与最新一条相同则跳过，不产生重复', () => {
    const h = make();
    h.remember('a');
    h.remember('a');
    expect(h.list()).toHaveLength(1);
    h.remember('b');
    h.remember('a');
    expect(h.list().map((x) => x.text)).toEqual(['a', 'b']);
  });

  it('超过上限时丢掉最旧的', () => {
    const h = make();
    for (let i = 0; i < CLIP_HISTORY_MAX + 5; i++) h.remember(`t${i}`);
    expect(h.list()).toHaveLength(CLIP_HISTORY_MAX);
    expect(h.list()[0].text).toBe(`t${CLIP_HISTORY_MAX + 4}`);
    expect(h.list().some((x) => x.text === 't0')).toBe(false);
  });

  it('锁屏只清内存，文件还在，解锁后能读回', () => {
    const h = make();
    h.remember('hunter2');
    h.forget();
    expect(h.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, CLIP_HISTORY_FILE))).toBe(true);
    expect(h.load().map((x) => x.text)).toEqual(['hunter2']);
  });

  it('清空会删掉文件', () => {
    const h = make();
    h.remember('hunter2');
    h.wipe();
    expect(h.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, CLIP_HISTORY_FILE))).toBe(false);
  });

  it('改主密码后用新密码重写，旧密码再也解不开', () => {
    const h = make();
    h.remember('hunter2');
    password = 'pw2';
    h.repersist('pw2');
    const raw = fs.readFileSync(path.join(dir, CLIP_HISTORY_FILE), 'utf8');
    expect(raw.startsWith('enc:pw2:')).toBe(true);
    expect(fakeDecrypt(raw, 'pw1')).toBeNull();
    expect(fakeDecrypt(raw, 'pw2')).toContain('hunter2');
  });

  it('文件损坏时当作空历史，不抛错', () => {
    fs.writeFileSync(path.join(dir, CLIP_HISTORY_FILE), 'not-a-cipher', 'utf8');
    const h = make();
    expect(h.load()).toEqual([]);
  });

  it('未解锁（没有主密码）时不落盘', () => {
    password = null;
    const h = make();
    h.remember('hunter2');
    expect(h.list()).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, CLIP_HISTORY_FILE))).toBe(false);
  });
});
