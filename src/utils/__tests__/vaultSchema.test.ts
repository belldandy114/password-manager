import { describe, it, expect } from 'vitest';
import {
  declaredVersion, migrateVault, normalizeVault, VAULT_COLLECTIONS, VAULT_SCHEMA_VERSION,
} from '../../../electron/vault-schema.js';

/**
 * normalizeVault 是「旧密码库 → 当前结构」的唯一关口：改错就是丢数据。
 * 这组用例把它的行为钉死，尤其是「新增集合不能漏」和「history 旧格式」。
 */
describe('vault-schema.normalizeVault 结构归一化', () => {
  it('空输入也能得到完整结构（不抛异常）', () => {
    for (const bad of [undefined, null, '', 0, 'x', [], true]) {
      const v = normalizeVault(bad);
      expect(Array.isArray(v.entries)).toBe(true);
      expect(Array.isArray(v.tags)).toBe(true);
      expect(v.history).toEqual({});
    }
  });

  it('每个已知集合都会被补齐成数组', () => {
    const v = normalizeVault({});
    for (const key of VAULT_COLLECTIONS) {
      expect(Array.isArray(v[key])).toBe(true);
    }
    // 新增集合时必须同时出现在 VAULT_COLLECTIONS 里，否则这里会挂
    expect(VAULT_COLLECTIONS).toContain('apiHistory');
    expect(VAULT_COLLECTIONS).toContain('integrations');
  });

  it('已有数据原样保留，不被清空', () => {
    const entries = [{ id: 'a', name: 'x' }];
    const tags = ['t1'];
    const history = { a: [{ password: 'p' }] };
    const snippets = [{ id: 's1' }];
    const v = normalizeVault({ entries, tags, history, snippets });
    expect(v.entries).toEqual(entries);
    expect(v.tags).toEqual(tags);
    expect(v.history).toEqual(history);
    expect(v.snippets).toEqual(snippets);
  });

  it('history 是数组（早期格式）时重置为对象，避免渲染层当对象遍历崩掉', () => {
    expect(normalizeVault({ history: [{ a: 1 }] }).history).toEqual({});
    expect(normalizeVault({ history: 'oops' }).history).toEqual({});
  });

  it('类型不对的集合被替换成空数组（而不是保留脏值）', () => {
    const v = normalizeVault({ entries: { a: 1 }, tags: 'x', notes: { n: 1 } });
    expect(v.entries).toEqual([]);
    expect(v.tags).toEqual([]);
    expect(v.notes).toEqual([]);
  });

  it('未知字段被丢弃（脏数据不会写回磁盘）', () => {
    const v = normalizeVault({ entries: [], foo: 'bar', __proto__x: 1 });
    expect('foo' in v).toBe(false);
  });

  it('幂等：归一化两次结果一致', () => {
    const once = normalizeVault({ entries: [{ id: 'a' }], notes: [{ id: 'n' }] });
    const twice = normalizeVault(once);
    expect(twice).toEqual(once);
  });

  it('不修改传入对象本身', () => {
    const input: Record<string, unknown> = { entries: [{ id: 'a' }] };
    normalizeVault(input);
    expect(Object.keys(input)).toEqual(['entries']);
  });

  it('归一化后一定带上当前结构版本号', () => {
    expect(normalizeVault(null).schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(normalizeVault({ entries: [] }).schemaVersion).toBe(VAULT_SCHEMA_VERSION);
  });
});

/**
 * 版本迁移：库文件里存 schemaVersion，读库时按 from → to 依次升级。
 * 这组用例钉住「不丢数据」与「不越界降级」两条底线。
 */
describe('vault-schema.migrateVault 版本迁移', () => {
  it('没有 schemaVersion 的库视为 v1', () => {
    expect(declaredVersion({})).toBe(1);
    expect(declaredVersion({ schemaVersion: 0 })).toBe(1);
    expect(declaredVersion({ schemaVersion: 'abc' })).toBe(1);
    expect(declaredVersion(null)).toBe(1);
    expect(declaredVersion({ schemaVersion: 2 })).toBe(2);
  });

  it('v1 库被升到当前版本，并记录执行过的步骤', () => {
    const { vault, from, to, applied, future } = migrateVault({ entries: [{ id: 'a' }] });
    expect(from).toBe(1);
    expect(to).toBe(VAULT_SCHEMA_VERSION);
    expect(applied).toEqual([1, 2]);
    expect(future).toBe(false);
    expect(vault.schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(vault.entries).toEqual([{ id: 'a' }]);
  });

  it('v2 → v3：测试账号按系统名并入条目，匹配不上的留在原集合', () => {
    const { vault, applied } = migrateVault({
      schemaVersion: 2,
      entries: [
        { id: 'e1', name: '合同管理系统-测试', envType: 'testing' },
        { id: 'e2', name: '合同管理系统-正式', envType: 'production' },
      ],
      accounts: [
        { id: 'a1', system: '合同管理系统', envType: 'testing', role: '管理员', username: 'admin', password: 'x' },
        { id: 'a2', system: '合同管理系统', envType: 'production', role: '只读', username: 'viewer', password: 'y' },
        { id: 'a3', system: '对不上的系统', role: '临时', username: 'tmp', password: 'z' },
      ],
    });
    expect(applied).toEqual([2]);
    const ents = vault.entries as Array<{ accounts?: Array<{ username: string }> }>;
    expect(ents[0].accounts).toHaveLength(1);
    expect(ents[0].accounts![0].username).toBe('admin');
    expect(ents[1].accounts![0].username).toBe('viewer');
    // 原集合原样保留（迁移只追加不删除）
    expect(vault.accounts).toHaveLength(3);
  });

  it('v3 迁移可重复执行，不会重复追加同一个账号', () => {
    const once = migrateVault({
      schemaVersion: 2,
      entries: [{ id: 'e', name: 'X系统' }],
      accounts: [{ id: 'a', system: 'X系统', role: 'r', username: 'u' }],
    }).vault;
    const twice = migrateVault({ ...once, schemaVersion: 2 }).vault;
    expect((twice.entries as Array<{ accounts?: unknown[] }>)[0].accounts).toHaveLength(1);
  });

  it('v1 的 history 数组按 entryId 归组成对象，孤儿记录落 __orphan', () => {    const { vault } = migrateVault({
      entries: [],
      history: [
        { entryId: 'a', password: 'p1' },
        { entryId: 'a', password: 'p2' },
        { entryId: 'b', password: 'p3' },
        { password: 'no-owner' },
        null,
        'junk',
      ],
    });
    expect(Object.keys(vault.history as Record<string, unknown>).sort()).toEqual(['__orphan', 'a', 'b']);
    expect((vault.history as Record<string, unknown[]>).a).toHaveLength(2);
    expect((vault.history as Record<string, unknown[]>).b).toHaveLength(1);
    expect((vault.history as Record<string, unknown[]>).__orphan).toHaveLength(1);
  });

  it('已经是当前版本的库不再迁移', () => {
    const { from, to, applied } = migrateVault({ schemaVersion: VAULT_SCHEMA_VERSION, entries: [] });
    expect(from).toBe(VAULT_SCHEMA_VERSION);
    expect(to).toBe(VAULT_SCHEMA_VERSION);
    expect(applied).toEqual([]);
  });

  it('更高版本的库不降级，标记 future', () => {
    const newer = { schemaVersion: VAULT_SCHEMA_VERSION + 1, entries: [], somethingNew: { x: 1 } };
    const { vault, from, to, applied, future } = migrateVault(newer);
    expect(future).toBe(true);
    expect(applied).toEqual([]);
    expect(from).toBe(VAULT_SCHEMA_VERSION + 1);
    expect(to).toBe(VAULT_SCHEMA_VERSION + 1);
    expect(vault.somethingNew).toEqual({ x: 1 });
  });

  it('更高版本的库归一化时保留未知字段（降级打开不至于洗掉新字段）', () => {
    const v = normalizeVault({
      schemaVersion: VAULT_SCHEMA_VERSION + 1,
      entries: [],
      somethingNew: { x: 1 },
    });
    expect(v.schemaVersion).toBe(VAULT_SCHEMA_VERSION + 1);
    expect(v.somethingNew).toEqual({ x: 1 });
  });

  it('当前及更旧版本的未知字段仍然丢弃', () => {
    expect('somethingNew' in normalizeVault({ entries: [], somethingNew: 1 })).toBe(false);
  });

  it('迁移不修改传入对象', () => {
    const input: Record<string, unknown> = { entries: [], history: [{ entryId: 'a' }] };
    migrateVault(input);
    expect(Array.isArray(input.history)).toBe(true);
    expect('schemaVersion' in input).toBe(false);
  });

  it('迁移可以重复执行且结果稳定（幂等）', () => {
    const first = migrateVault({ entries: [], history: [{ entryId: 'a', password: 'p' }] });
    const second = migrateVault(first.vault);
    expect(second.applied).toEqual([]);
    expect(second.vault.history).toEqual(first.vault.history);
  });
});
