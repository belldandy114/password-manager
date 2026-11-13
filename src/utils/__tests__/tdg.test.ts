import { describe, it, expect } from 'vitest';
import { generateData } from '../tdg';
import type { GenerateConfig } from '../tdg/types';
import { generateFromRegex, REGEX_PRESETS } from '../tdg/regexGenerator';
import { GENERATORS, GROUPS } from '../tdg/catalog';

describe('测试数据：后 N 位只对身份证 / 手机号生效', () => {
  const idCardCfg = {
    id: 'idCard' as const,
    count: 3,
    idCard: { gender: 'random' as const, birthYearMin: 1980, birthYearMax: 2000, idType: 'mainland' as const },
  };

  it('手机号不传 phone 参数也能生成（曾因解引用 undefined 直接崩）', () => {
    const list = generateData({ id: 'phone', count: 5 });
    expect(list).toHaveLength(5);
    expect(list.every(i => /^1[3-9]\d{9}$/.test(i.value))).toBe(true);
    expect(list.every(i => i.last6 === undefined)).toBe(true);
  });

  it('手机号按 lastDigits 给出尾号', () => {
    const list = generateData({ id: 'phone', count: 5, phone: { prefixes: ['138'] }, lastDigits: 4 });
    expect(list.every(i => i.last6 === i.value.slice(-4))).toBe(true);
  });

  it('后 N 位填 0 时不产出这一列（slice(-0) 会返回整串，必须挡掉）', () => {
    expect(generateData({ ...idCardCfg, idCardLastDigits: 0 }).every(i => i.last6 === undefined)).toBe(true);
    expect(generateData({ id: 'phone', count: 3, lastDigits: 0 }).every(i => i.last6 === undefined)).toBe(true);
  });

  it('身份证按位数给尾号', () => {
    const list = generateData({ ...idCardCfg, idCardLastDigits: 6 });
    expect(list.every(i => i.last6 === i.value.slice(-6))).toBe(true);
  });

  it('其它类型永远没有后 N 位', () => {
    const configs: GenerateConfig[] = [
      { id: 'name', count: 3 },
      { id: 'email', count: 3, email: { domains: ['qq.com'], allowSpecialChars: false } },
      { id: 'uuid', count: 3 },
      { id: 'regex', count: 3, regexPattern: '\\d{3}', regexFlags: '' },
    ];
    for (const cfg of configs) {
      const list = generateData(cfg);
      expect(list.every(i => i.last6 === undefined)).toBe(true);
    }
  });
});

describe('正则快捷预设', () => {
  it('每个预设都能被 randexp 解析，不返回错误串', () => {
    for (const p of REGEX_PRESETS) {
      const v = generateFromRegex(p.pattern);
      expect(v.startsWith('[正则错误:'), `${p.label} -> ${v}`).toBe(false);
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('预设 label 不重复', () => {
    expect(new Set(REGEX_PRESETS.map(p => p.label)).size).toBe(REGEX_PRESETS.length);
  });
});

describe('生成器目录', () => {
  it('17 类 id 唯一且全部分到某个分组', () => {
    expect(GENERATORS).toHaveLength(17);
    expect(new Set(GENERATORS.map(g => g.id)).size).toBe(17);
    const grouped = GROUPS.flatMap(g => g.ids);
    expect(new Set(grouped).size).toBe(17);
    expect(grouped.sort()).toEqual(GENERATORS.map(g => g.id).sort());
  });
});
