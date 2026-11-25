import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  declaredVersion, migrateVault, normalizeVault, VAULT_COLLECTIONS, VAULT_SCHEMA_VERSION, MIGRATIONS,
} from '../../../electron/vault-schema.js';

/**
 * 当前结构版本。**必须提到文件顶部**：`v1 库被升到当前版本` 那条用例在文件前半段就引用它，
 * 留在文件中部会踩 `const` 的 TDZ（RA2-18）。改版本时这里与 `vault-schema.js` 的
 * `VAULT_SCHEMA_VERSION` 必须同时改 —— 「真源在测试里」的约束才成立。
 */
const CURRENT = 5;

/** 6 个新集合（只追加不插序，末尾 6 项就是它们）；标题用 `NEW_KEYS.length` 插值，不写死数字 */
const NEW_KEYS = ['pomPages', 'scanRuns', 'coverageRuns', 'caseMaps', 'allureRuns', 'uiRecordings'];

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
    // 【[C-113] 必红项之一】v1 → … → 当前版本：每加一版迁移步这里都要跟着多一步。
    // 常量驱动不是放宽：`applied` 的**步数与顺序**都被逐元素锁死（RA2-05 指出这类断言不许退化成 toContain）。
    expect(applied).toEqual(Array.from({ length: CURRENT - 1 }, (_, i) => 1 + i));
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
    // 【等强度断言（RA2-05 恢复）】v2 库一路升到当前版本：CURRENT=5 时恰好是 [2,3,4] ——
    // `toEqual` 同时锁**步数**与**顺序**，多一步/少一步/乱序都红；`toContain` 两条锁不住这些。
    // 这是一条**必红项**：每加一版迁移，这里必须跟着改（与上面 :107 的常量驱动写法互补：
    // 那条随 CURRENT 自动延伸，这条把「当前这一刻的步数」钉成字面量）。
    expect(applied).toEqual([2, 3, 4]);
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

/**
 * 本地测试资产工作站（契约 C-18 / C-40 ~ C-44）+ 录制域（契约 §9 [C-109]/[C-111]/[C-113]，v18）。
 *
 * 这一组锁四件事：
 * 1. 版本号由**测试自己的字面量真源** `CURRENT` 驱动（[C-113]：改 `CURRENT` 一处，断言跟着走；
 *    真源在测试里，所以源码漂到 6 而测试没跟仍会红 —— 不是 `toBe(VAULT_SCHEMA_VERSION)` 那种恒真写法）；
 * 2. 迁移步真的存在且**不改既有数据**；
 * 3. `MIGRATIONS[4]` **幂等**（已有 id 保留原值）且回填的 id **可复现**（同一输入跑两次逐字相等）；
 * 4. 降级读（库版本更高）时不需要的键**原样保留**。
 */
// CURRENT / NEW_KEYS 已在文件顶部声明（RA2-18：提到顶部才不会被前半段的用例引用时踩 TDZ）

/** 读 AC-9 用的 v4 样库（真实结构，由 `normalizeVault` 的 key 清单产出，不是手搓字段） */
const V4_FIXTURE = JSON.parse(
  readFileSync(path.join(process.cwd(), 'src', 'utils', '__tests__', '__fixtures__', 'vault', 'v4-minimal.json'), 'utf8'),
);

describe('vault-schema 版本与迁移表（契约 [C-44] / [C-113]）', () => {
  it('当前结构版本由 CURRENT 驱动，且 MIGRATIONS[CURRENT-1] 存在', () => {
    expect(VAULT_SCHEMA_VERSION).toBe(CURRENT);
    expect(typeof MIGRATIONS[CURRENT - 1]).toBe('function');
  });

  it('v3 库升到当前版本：to === CURRENT、applied 含 3…CURRENT-1、数据一个字节都不动', () => {
    const entries = [{ id: 'a', name: 'X系统' }];
    const { vault, from, to, applied, future } = migrateVault({ schemaVersion: 3, entries });
    expect(from).toBe(3);
    expect(to).toBe(CURRENT);
    expect(applied).toEqual(Array.from({ length: CURRENT - 3 }, (_, i) => 3 + i));
    expect(future).toBe(false);
    expect(vault.entries).toEqual(entries);
    expect(vault.schemaVersion).toBe(CURRENT);
  });

  it(`${NEW_KEYS.length} 个新集合在 VAULT_COLLECTIONS 末尾，且缺失时补成空数组`, () => {
    for (const key of NEW_KEYS) {
      expect(VAULT_COLLECTIONS).toContain(key);
    }
    expect(VAULT_COLLECTIONS.slice(-NEW_KEYS.length)).toEqual(NEW_KEYS);
    const v = normalizeVault({});
    for (const key of NEW_KEYS) {
      expect(v[key]).toEqual([]);
    }
  });

  it('更高版本的库归一化时保留 uiRecordings（降级安全 + 键名是复数）', () => {
    const v = normalizeVault({ schemaVersion: CURRENT + 94, uiRecordings: [{ id: 'r1' }] });
    expect(v.schemaVersion).toBe(CURRENT + 94);
    expect(v.uiRecordings).toEqual([{ id: 'r1' }]);
  });
});

describe('MIGRATIONS[4]：补 uiRecordings + 回填元素 id（幂等、可复现）', () => {
  /** 迁移步在 `vault-schema.d.ts` 里是 `Record<string, unknown>`，用例侧收窄一下，避免一路 any */
  interface MigratedOut {
    uiRecordings?: unknown[];
    pomPages?: Array<{ id?: string; elements: Array<{ id?: string; name?: string; locator?: string; kind?: string }> }>;
    scanRuns?: unknown[];
  }
  const run4 = (v: Record<string, unknown>): MigratedOut => MIGRATIONS[4](v) as unknown as MigratedOut;

  const withElements = (elements: unknown[]) => ({ schemaVersion: 4, pomPages: [{ id: 'pom-1', elements }] });

  it('补 uiRecordings: []，且给缺 id 的元素回填非空 id', () => {
    const out = run4(withElements([{ name: 'a', locator: '#a', kind: 'css' }]));
    expect(out.uiRecordings).toEqual([]);
    const el = out.pomPages![0].elements[0];
    expect(typeof el.id).toBe('string');
    expect(el.id!.length).toBeGreaterThan(0);
    // 其余字段一个字节都不动
    expect(el.name).toBe('a');
    expect(el.locator).toBe('#a');
    expect(el.kind).toBe('css');
  });

  it('幂等：已有 id 的元素保留原值，连跑两次结果完全相同', () => {
    const input = withElements([
      { name: 'a', locator: '#a', kind: 'css', id: 'fixed-id' },
      { name: 'b', locator: '#b', kind: 'css' },
    ]);
    const once = run4(input);
    expect(once.pomPages![0].elements[0].id).toBe('fixed-id');
    const twice = run4(once as unknown as Record<string, unknown>);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('回填的 id 可复现：同一份「无 id」输入独立跑两次，结果严格相等（不依赖随机源/时间）', () => {
    const make = () => withElements([{ name: 'a', locator: '#a', kind: 'css' }]);
    const first = run4(make());
    const second = run4(make());
    expect(first.pomPages![0].elements[0].id).toBe(second.pomPages![0].elements[0].id);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('不该动的集合原样透传（只补 uiRecordings，不碰别的）', () => {
    const out = run4({ schemaVersion: 4, scanRuns: [{ id: 's1' }] });
    expect(out.scanRuns).toEqual([{ id: 's1' }]);
    expect(out.pomPages).toBeUndefined(); // 库里没 pomPages 就不该被凭空造出来
  });
});

describe('AC-9 往返：v4 样库 → 升级 → 回写 → 降级读（契约 [C-112]）', () => {
  interface ReadableVault {
    schemaVersion: number;
    uiRecordings?: unknown[];
    pomPages: Array<{ elements: Array<{ id?: string }> }>;
  }
  const asVault = (v: unknown): ReadableVault => v as unknown as ReadableVault;
  const upgraded = () => asVault(normalizeVault(migrateVault(V4_FIXTURE).vault));

  it('升级后 uiRecordings 被补成数组，元素 id 全部齐备', () => {
    const up = upgraded();
    expect(up.schemaVersion).toBe(CURRENT);
    expect(up.uiRecordings).toEqual([]);
    for (const el of up.pomPages[0].elements) {
      expect(typeof el.id).toBe('string');
      expect((el.id as string).length).toBeGreaterThan(0);
    }
    // 已带 id 的那条必须保持原值
    expect(up.pomPages[0].elements[1].id).toBe('fixed-id-keep-me');
  });

  it('降级读（旧应用看到 schemaVersion 当前 + 1 > 自己的）不丢 uiRecordings', () => {
    const written = { ...upgraded(), uiRecordings: [{ id: 'r1', name: '录制 1', steps: [] }] };
    // 旧应用的 normalizeVault：它不认识 uiRecordings，但库版本更高时应原样保留
    const downgraded = asVault(normalizeVault(written));
    expect(downgraded.uiRecordings).toEqual([{ id: 'r1', name: '录制 1', steps: [] }]);
  });
});

/**
 * M7 证伪用例（t18）：`deriveElementId` 的 seed 由
 * `[page.id, pageIndex, elementIndex, el.name, el.locator]` 五个分量拼成（NUL 分隔后 sha1）。
 * 之前只断言「同一份输入两次结果相等」，所以**砍掉任一 seed 分量仍然绿** —— 而砍掉
 * `elementIndex` 会让「同名元素在页内换位置」派生到同一个 id：迁移回填后 `UiStep.elementId`
 * 指向的元素会在下一次迁移/编辑后错位。这里逐个分量做成「改它就必变」的断言。
 */
describe('vault-schema：deriveElementId 的 seed 分量（每个都不能砍）', () => {
  /** 把 v4 库迁移一次，取 pomPages[0].elements 的派生 id */
  const idsFor = (pageId: string, names: string[]) => {
    const migrated = migrateVault({
      schemaVersion: 4,
      pomPages: [{
        id: pageId,
        name: '登录页',
        baseUrl: 'https://example.com',
        elements: names.map((n) => ({ name: n, locator: `#${n}`, kind: 'css' })),
      }],
    });
    const pages = (migrated.vault as { pomPages: Array<{ elements: Array<{ id?: string }> }> }).pomPages;
    return pages[0].elements.map((e) => e.id);
  };

  it('同输入 → 同 id（确定性），且形状是 uuid（32 位十六进制）', () => {
    const a = idsFor('p1', ['login']);
    const b = idsFor('p1', ['login']);
    expect(a[0]).toBe(b[0]);
    expect(String(a[0])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('pageId 分量：换页面 id → id 必变', () => {
    expect(idsFor('p2', ['login'])[0]).not.toBe(idsFor('p1', ['login'])[0]);
  });

  it('元素名分量：换 name → id 必变', () => {
    expect(idsFor('p1', ['signup'])[0]).not.toBe(idsFor('p1', ['login'])[0]);
  });

  it('下标分量：同名元素从 index 0 挪到 index 1 → id 必变（砍掉 elementIndex 这里必红）', () => {
    const base = idsFor('p1', ['login'])[0];
    const shifted = idsFor('p1', ['filler', 'login']);
    expect(shifted[1]).not.toBe(base);
    expect(shifted[1]).not.toBe(shifted[0]);
  });

  it('locator 分量：同名同位置但 locator 不同 → id 必变', () => {
    const one = migrateVault({ schemaVersion: 4, pomPages: [{ id: 'p1', name: 'P', baseUrl: 'https://e.com', elements: [{ name: 'login', locator: '#a', kind: 'css' }] }] });
    const two = migrateVault({ schemaVersion: 4, pomPages: [{ id: 'p1', name: 'P', baseUrl: 'https://e.com', elements: [{ name: 'login', locator: '#b', kind: 'css' }] }] });
    const idOf = (m: unknown) => (m as { vault: { pomPages: Array<{ elements: Array<{ id?: string }> }> } }).vault.pomPages[0].elements[0].id;
    expect(idOf(one)).not.toBe(idOf(two));
  });
});
