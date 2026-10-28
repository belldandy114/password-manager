import { describe, it, expect } from 'vitest';
import { passwordStrength, isWeakPassword, buildSecurityReport, entrySecurityFlags, PASSWORD_MAX_AGE_DAYS } from '../security';
import type { PasswordEntry } from '../../types';

const entry = (over: Partial<PasswordEntry>): PasswordEntry => ({
  id: over.id || 'e1', name: over.name || '站点', url: 'https://x.com',
  username: 'u', password: 'Zx9!kLm2#qWp', createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), ...over,
} as PasswordEntry);

describe('security.passwordStrength', () => {
  it('常见弱密码直接判极弱', () => {
    expect(passwordStrength('123456').score).toBe(1);
    expect(passwordStrength('password').reasons).toContain('常见弱密码');
    expect(passwordStrength('').score).toBe(0);
  });

  it('短密码/纯数字会被扣到最低档', () => {
    expect(passwordStrength('abcdefgh').reasons).toContain('纯字母');
    expect(passwordStrength('abcdefgh').score).toBeLessThanOrEqual(1);
    expect(passwordStrength('48205913').reasons).toContain('纯数字');
    expect(passwordStrength('48205913').score).toBeLessThanOrEqual(1);
  });

  it('长且混合字符的密码得分更高', () => {
    expect(passwordStrength('Zx9!kLm2#qWp7@Rt').score).toBeGreaterThanOrEqual(3);
  });

  it('isWeakPassword：空密码不算弱（单独统计）', () => {
    expect(isWeakPassword('')).toBe(false);
    expect(isWeakPassword('123456')).toBe(true);
    expect(isWeakPassword('Zx9!kLm2#qWp7@Rt')).toBe(false);
  });
});

describe('security.buildSecurityReport', () => {
  it('统计重复密码（空密码不参与重复判定）', () => {
    const report = buildSecurityReport([
      entry({ id: 'a', password: 'Same#Pass9x' }),
      entry({ id: 'b', password: 'Same#Pass9x' }),
      entry({ id: 'c', password: '' }),
      entry({ id: 'd', password: '' }),
    ]);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0].entryIds.sort()).toEqual(['a', 'b']);
    expect(report.empty).toBe(2);
  });

  it('统计弱密码与超期未改的密码', () => {
    const old = new Date(Date.now() - (PASSWORD_MAX_AGE_DAYS + 10) * 86400000).toISOString();
    const report = buildSecurityReport([
      entry({ id: 'w', password: '123456' }),
      entry({ id: 'o', password: 'Zx9!kLm2#qWp7@Rt', passwordUpdatedAt: old }),
    ]);
    expect(report.weak.map(w => w.entryIds[0])).toContain('w');
    expect(report.expired.map(w => w.entryIds[0])).toContain('o');
  });

  it('空库时分数为满分而不是 0（避免「没有数据=很差」的误解）', () => {
    const report = buildSecurityReport([]);
    expect(report.total).toBe(0);
    expect(report.score).toBeGreaterThanOrEqual(80);
  });

  it('问题越多分数越低', () => {
    const good = buildSecurityReport([entry({ id: 'g' })]);
    const bad = buildSecurityReport([entry({ id: 'b1', password: '123456' }), entry({ id: 'b2', password: '123456' })]);
    expect(good.score).toBeGreaterThan(bad.score);
  });
});

describe('security.entrySecurityFlags', () => {
  it('标出弱密码与共用密码', () => {
    const flags = entrySecurityFlags([
      entry({ id: 'a', password: 'Dup#Pass99' }),
      entry({ id: 'b', password: 'Dup#Pass99' }),
      entry({ id: 'c', password: '123456' }),
    ]);
    expect(flags.a.duplicate).toBe(true);
    expect(flags.b.duplicate).toBe(true);
    expect(flags.c.weak).toBe(true);
    expect(flags.c.duplicate).toBe(false);
  });
});