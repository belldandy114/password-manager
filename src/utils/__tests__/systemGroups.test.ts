import { describe, it, expect } from 'vitest';
import { buildSystems, systemKey, systemOfEntryName, matchesSystem, systemStats } from '../systemGroups';

describe('systemKey', () => {
  it('忽略大小写、首尾空白与连续空格', () => {
    expect(systemKey('  资产管理系统  ')).toBe(systemKey('资产管理系统'));
    expect(systemKey('Asset System')).toBe(systemKey('asset   system'));
  });

  it('全角括号与半角括号视为同一个', () => {
    expect(systemKey('宿舍（学生端）')).toBe(systemKey('宿舍(学生端)'));
  });
});

describe('systemOfEntryName', () => {
  it('去掉环境后缀', () => {
    expect(systemOfEntryName('资产管理系统-测试')).toBe('资产管理系统');
    expect(systemOfEntryName('宿舍管理系统(正式)')).toBe('宿舍管理系统');
    expect(systemOfEntryName('通行系统 生产版')).toBe('通行系统');
  });

  it('没有后缀时原样返回', () => {
    expect(systemOfEntryName('学工综合平台')).toBe('学工综合平台');
  });

  it('空值返回空串', () => {
    expect(systemOfEntryName('')).toBe('');
  });
});

describe('buildSystems', () => {
  const input = {
    entries: [
      { id: 'e1', name: '资产管理系统-测试', url: 'http://a' },
      { id: 'e2', name: '资产管理系统-正式', url: 'http://b' },
      { id: 'e3', name: '宿舍管理系统', url: 'http://c' },
    ],
    accounts: [
      { id: 'a1', system: '资产管理系统', role: '管理员', username: 'admin' },
      { id: 'a2', system: '资产管理系统 ', role: '普通用户', username: 'tester' },
      { id: 'a3', system: '', role: '临时', username: 'tmp' },
    ],
    envs: [
      { id: 'v1', system: '资产管理系统', url: 'http://192.0.2.10:8080' },
      { id: 'v2', system: '宿舍管理系统', url: 'http://192.0.2.11:8080' },
    ],
  };

  it('同一系统的账号与环境合并到一组', () => {
    const groups = buildSystems(input);
    const asset = groups.find(g => g.name === '资产管理系统')!;
    expect(asset.accounts).toHaveLength(2);
    expect(asset.envs).toHaveLength(1);
    // 两条网址的名字去掉环境后缀后也叫「资产管理系统」
    expect(asset.entries).toHaveLength(2);
  });

  it('按条目总数降序，未指定系统排最后', () => {
    const groups = buildSystems(input);
    expect(groups[0].name).toBe('资产管理系统');
    expect(groups[groups.length - 1].name).toBe('未指定系统');
  });

  it('空 system 归到未指定系统', () => {
    const groups = buildSystems(input);
    const none = groups.find(g => g.key === '__none__')!;
    expect(none.accounts).toHaveLength(1);
  });

  it('没有数据时返回空数组', () => {
    expect(buildSystems({ entries: [], accounts: [], envs: [] })).toEqual([]);
  });

  it('大小写不同的系统名合并', () => {
    const groups = buildSystems({
      entries: [], envs: [],
      accounts: [
        { id: '1', system: 'CRM', username: 'a' },
        { id: '2', system: 'crm', username: 'b' },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].accounts).toHaveLength(2);
  });

  it('网址条目自带的账号也收进 inlineAccounts', () => {
    const groups = buildSystems({
      accounts: [], envs: [],
      entries: [
        { id: 'e1', name: '合同管理系统-测试', username: 'admin' },
        { id: 'e2', name: '合同管理系统-正式', username: 'root' },
        { id: 'e3', name: '合同管理系统-正式', url: 'http://x' },   // 没账号
      ],
    });
    const g = groups[0];
    expect(g.inlineAccounts).toHaveLength(2);
    expect(g.inlineAccounts.map(a => a.username)).toEqual(['admin', 'root']);
    expect(g.inlineAccounts[0].from).toBe('合同管理系统-测试');
  });

  it('systemStats 把条目账号算进账号总数', () => {
    const groups = buildSystems({
      accounts: [{ id: 'a1', system: '合同管理系统', username: 'tester' }],
      envs: [],
      entries: [{ id: 'e1', name: '合同管理系统-测试', username: 'admin' }],
    });
    const s = systemStats(groups);
    expect(s.accounts).toBe(2);   // 1 个测试账号 + 1 个条目账号
    expect(s.systems).toBe(1);
  });
});

describe('matchesSystem', () => {
  const g = {
    key: 'asset', name: '资产管理系统',
    entries: [{ id: 'e', name: '资产管理系统-测试', url: 'http://a' }],
    accounts: [{ id: 'a', system: '资产管理系统', role: '管理员', username: 'admin' }],
    envs: [{ id: 'v', system: '资产管理系统', url: 'http://192.0.2.10:8080' }],
    inlineAccounts: [],
  };

  it('空查询全通过', () => {
    expect(matchesSystem(g, '')).toBe(true);
  });

  it('命中系统名', () => {
    expect(matchesSystem(g, '资产')).toBe(true);
  });

  it('命中账号与地址', () => {
    expect(matchesSystem(g, 'admin')).toBe(true);
    expect(matchesSystem(g, '192.0.2.10')).toBe(true);
  });

  it('不命中返回 false', () => {
    expect(matchesSystem(g, '宿舍')).toBe(false);
  });
});
