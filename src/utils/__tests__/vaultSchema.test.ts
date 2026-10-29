import { describe, it, expect } from 'vitest';
import { normalizeVault, VAULT_COLLECTIONS } from '../../../electron/vault-schema.js';

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
});
