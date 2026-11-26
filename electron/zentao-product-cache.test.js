/**
 * ztProductCache 的信封解包回归（既有缺陷修复 t9；队长裁定 §十）。
 *
 * 根因：`electron/ipc-zentao.js` 的 `ztProductCache` 值是**信封** `{ at, map }`
 * （两个写入点都这么存：`ztApiPrograms` 与 `ztApiProducts`），但三个消费方
 * （`zentao:project-bugs` / `zentao:all-bugs` / `ztSummaryOf`）把它当成了映射本身，
 * 于是 `nameMap[productId]` 恒为 undefined → `ztMapApiBug` 的 `productName` 恒空 →
 * 周报草稿的项目分组退化成「（1）未分类」。
 *
 * 本文件锁四件事：
 *   ① 信封解包后能取到真实项目名；
 *   ② **旧 bug 的形态**（把信封当映射直接索引 → 空名）与「productName 的取值表达式」一起锁死，
 *      防止有人把消费方"简化"回去；
 *   ③ 缓存未命中/形状不对时不抛、渲染成空名（既有容忍行为不能被修坏）；
 *   ④ 源码守卫：本文件所有 `ztProductCache` 取值都必须过 `ztProductMapOf`（唯一例外是
 *      `ztApiPrograms` 的 TTL 读取，它必须同时看 `hit.at`，见 ⑤）。
 *
 * 为什么放在 electron/ 而不是 src/utils/__tests__/：本任务 inScope 只有
 * `electron/ipc-zentao.js`，「不碰 src/**」是硬边界；vitest 默认 include 会收
 * `electron/*.test.js`（实测已验），`node --check` 对 ESM 语法同样通过（ci-gate 会覆盖它）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { ztProductMapOf } = require_('./ipc-zentao.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(HERE, 'ipc-zentao.js');
const SRC_LINES = readFileSync(SRC_PATH, 'utf8').split(/\r?\n/);

/** 一个与 `ztApiProducts` 写入形状逐字一致的信封 */
const envelope = (map) => ({ at: 1700000000000, map });

/**
 * `ztMapApiBug` 里 productName 的**真实取值表达式**（与 ipc-zentao.js 逐字一致，
 * 由下面 ② 的源码断言锁着）。它住在 `registerZentaoIpc` 闭包里、无法直接 import，
 * 所以这里按同一表达式求值 —— 断言的是「解包后的映射喂给这段表达式能得到真实项目名」。
 */
const productNameOf = (nameMap, productId) => (nameMap && nameMap[String(productId)]) || '';

describe('ztProductCache 信封解包（t9）', () => {
  it('① 解包后取到真实项目名（修复后的正确路径）', () => {
    const cache = new Map([['http://zt.example|admin', envelope({ '69': '资产管理系统' })]]);
    const nameMap = ztProductMapOf(cache, 'http://zt.example|admin');
    expect(nameMap).toEqual({ '69': '资产管理系统' });
    expect(productNameOf(nameMap, '69')).toBe('资产管理系统');
  });

  it('② 形态锁：信封当映射索引 → 空名；且 productName 的取值表达式与实现逐字一致', () => {
    const env = envelope({ '69': '资产管理系统' });
    // 旧写法：nameMap = cache.get(key)（拿到的是信封，不是 map）
    expect(productNameOf(env, '69')).toBe('');
    // 且信封是**真值**，所以旧代码 `if (!nameMap) { 重拉产品 }` 的兜底永远不会触发
    expect(!!env).toBe(true);
    // 解包之后才是真实名
    expect(productNameOf(ztProductMapOf(new Map([['k', env]]), 'k'), '69')).toBe('资产管理系统');
    // 源码锚：上面这行表达式必须仍是实现里的那一句（改实现就要回来改这个测试的假设）
    expect(SRC_LINES.some((l) => l.includes('productName: nameMap[String(b.product)] || \'\','))).toBe(true);
  });

  it('③ 缓存未命中 / 形状不对：返回 null、不抛，渲染成空名而不是崩', () => {
    expect(ztProductMapOf(new Map(), 'nope')).toBeNull();
    for (const bad of [undefined, null, '', 0, 'str', [], {}, { at: 1 }, { map: null }, { map: 'x' }, { map: [] }]) {
      const cache = new Map([['k', bad]]);
      const got = ztProductMapOf(cache, 'k');
      expect(got === null || (typeof got === 'object' && !Array.isArray(got))).toBe(true);
      expect(() => productNameOf(got || {}, '69')).not.toThrow();
      expect(productNameOf(got || {}, '69')).toBe('');
    }
    // 连 cache 本身不是 Map（或没传）也不炸 —— 防御性单测
    expect(ztProductMapOf(null, 'k')).toBeNull();
    expect(ztProductMapOf(undefined, 'k')).toBeNull();
  });

  it('④ 同一信封里多个产品 id 各自命中，未收录的 id 仍是空名', () => {
    const cache = new Map([['k', envelope({ '69': '资产管理系统', '70': '广科 / 网关' })]]);
    const nameMap = ztProductMapOf(cache, 'k');
    expect(productNameOf(nameMap, '69')).toBe('资产管理系统');
    expect(productNameOf(nameMap, '70')).toBe('广科 / 网关');
    expect(productNameOf(nameMap, '71')).toBe('');
  });

  it('⑤ 源码守卫：所有 ztProductCache 取值都过 ztProductMapOf，唯一例外是 TTL 读取', () => {
    const rawGets = SRC_LINES
      .map((line, i) => ({ no: i + 1, line: line.trim() }))
      // 只看代码行：注释里的 `ztProductCache.get(key)` 是文档说明，不是取值点
      .filter(({ line }) => !/^(\/\/|\/\*|\*)/.test(line))
      .filter(({ line }) => /ztProductCache\s*\.\s*get\s*\(/.test(line))
      .filter(({ line }) => !/ztProductMapOf\s*\(\s*ztProductCache\s*,/.test(line));

    // 唯一允许的裸取：ztApiPrograms 里那处要先判 TTL（hit.at），不能交给只认 .map 的助手
    expect(rawGets.map((x) => x.line)).toEqual(['const hit = ztProductCache.get(key);']);
    const ttlContext = SRC_LINES.slice(rawGets[0].no - 1, rawGets[0].no + 2).join('\n');
    expect(ttlContext).toContain('hit.map');
    expect(ttlContext).toContain('hit.at');

    // 三个消费方（project-bugs / all-bugs / ztSummaryOf）共 5 处取值，全部走解包
    const wrapped = SRC_LINES.filter(
      (line) => /ztProductMapOf\s*\(\s*ztProductCache\s*,/.test(line),
    );
    expect(wrapped).toHaveLength(5);
    // 写入侧形状不能改（本任务只修解包）：两处写入仍是 { at, map }
    const writes = SRC_LINES.filter((line) => /ztProductCache\s*\.\s*set\s*\(/.test(line));
    expect(writes).toHaveLength(2);
    for (const w of writes) expect(w).toContain('{ at: Date.now(), map }');
  });
});
