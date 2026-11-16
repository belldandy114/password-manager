import { describe, it, expect } from 'vitest';
import { generateData } from '../tdg';
import type { GenerateConfig } from '../tdg/types';
import { generateFromRegex, REGEX_PRESETS } from '../tdg/regexGenerator';
import { GENERATORS, GROUPS } from '../tdg/catalog';
import { exportSql } from '../tdg/export';
import type { GenerateResultItem } from '../tdg/types';

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

describe('SQL 导出：表名 / 列名可配', () => {
  const items: GenerateResultItem[] = [
    { id: 1, type: '姓名', value: '张三' },
    { id: 2, type: '姓名', value: "O'Brien" },
  ];

  it('不传参数时保持默认 test_data / value（老调用方与老单测不受影响）', () => {
    const sql = exportSql(items);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_data');
    expect(sql).toContain('INSERT INTO test_data (id, type, value)');
  });

  it('自定义表名与列名会同时出现在建表与插入语句里', () => {
    const sql = exportSql(items, { table: 't_user', column: 'user_name' });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS t_user');
    expect(sql).toContain('user_name TEXT');
    expect(sql).toContain('INSERT INTO t_user (id, type, user_name)');
    expect(sql).not.toContain('test_data');
  });

  it('单引号仍然被转义（自定义表名不影响转义逻辑）', () => {
    expect(exportSql(items, { table: 't_user' })).toContain("'O''Brien'");
  });

  it('非法标识符退回默认值，不产出坏 SQL', () => {
    // 空格 / 分号 / 数字开头 / 空串都不可用
    for (const bad of ['my table', 't;drop', '1abc', '', '   ', 'a-b']) {
      const sql = exportSql(items, { table: bad, column: bad });
      expect(sql, bad).toContain('CREATE TABLE IF NOT EXISTS test_data');
      expect(sql, bad).toContain('INSERT INTO test_data (id, type, value)');
    }
  });

  it('有后 N 位时列名同样生效', () => {
    const withLast: GenerateResultItem[] = [{ id: 1, type: '身份证', value: '110101199001011234', last6: '011234' }];
    const sql = exportSql(withLast, { table: 't_id', column: 'id_no' });
    expect(sql).toContain('id_no TEXT');
    expect(sql).toContain('INSERT INTO t_id (id, type, id_no, last_x)');
  });
});
