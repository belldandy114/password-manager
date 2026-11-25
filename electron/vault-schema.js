'use strict';

const crypto = require('crypto');

/**
 * 密码库结构归一化 + 版本迁移（旧库升级的唯一关口）。
 *
 * 为什么单独成模块：
 * - 它是「老版本 vault → 当前结构」的唯一入口，改错了就是丢数据，必须有单测；
 * - 主进程 main.js 太大，纯函数先下沉，照着 electron/csv.js 的模式（配套 .d.ts 让渲染层单测也能 import）。
 *
 * 约定：**只保证结构，不改内容**。数组/对象原样透传（不深拷贝），
 * 因为 loadVault 会把结果放进内存缓存，拷贝反而会让缓存与磁盘不一致。
 *
 * 版本号的意义：以前靠 normalizeVault 里一堆 `|| []` 兜底，只能补「缺什么」，
 * 补不了「结构变了」（比如 history 从数组变成对象、某字段从 string 变数组）。
 * 现在每个结构变更都要在 MIGRATIONS 里留一步，读库时按 from→to 顺序执行；
 * 库里存 schemaVersion，降级打开更高版本的库也不会把不认识的字段写丢。
 */

/** 除 entries / tags / history 之外的集合；新增模块只改这里 */
const VAULT_COLLECTIONS = [
  'snippets',
  'notes',
  'checklists',
  'accounts',
  'environments',
  'apiRequests',
  'integrations',
  'ztPresets',
  'apiEnvs',
  'apiHistory',
  'codeSnippets',
  // 接口回归：回归集定义 + 最近若干次运行结果
  'regressionSets',
  'regressionRuns',
  // 1.25.0：环境巡检历史（原来在 localStorage，换机器带不走且明文存内网地址）
  'envProbes',
  // 1.25.0：测试数据生成器的数据集（存配置，不存生成结果）
  'tdgDatasets',
  // 本地测试资产工作站（13 项）：元素库 / 代码体检记录 / 覆盖台账 / 用例映射 / Allure 历史。
  // **键名是全复数**（`caseMaps` 不是 `caseMap`）——单数会让 ws:get 走「无效的数据类型」或返回空数组，
  // normalizeVault 也会把未知键直接丢掉，表现是「页面永远空着」，属静默失效（契约 C-18）。
  'pomPages',
  'scanRuns',
  'coverageRuns',
  'caseMaps',
  'allureRuns',
  // UI 录制器（契约 §9 [C-109]）：录制会话的步骤序列。v4 之后新增的第一个集合，
  // **没有 3→4 那趟车可搭**，所以它必须随 v4→v5 这次 bump 一起落地（[C-111]）。
  'uiRecordings',
];

/**
 * 当前库结构版本。**只许往上加，不许改历史值** ——
 * 已经把 v1 迁到 v2 的库，改动 v2 的定义就等于让它们的数据对不上号。
 *
 * v4 → v5（契约 §9 [C-111]，2026-11-26，对禁令 #10 的定向一次豁免）：
 * 只为交付「UI 录制器」的 `uiRecordings` 集合与元素 `id`，结构上没有搬移任何既有字节。
 */
const VAULT_SCHEMA_VERSION = 5;

/**
 * 迁移表：key = 源版本，value = 把该版本的结构升到「下一版」的纯函数。
 * 约定：只做结构搬移和补字段，**绝不删用户数据**；迁完再交给 normalizeVault 兜底。
 */
const MIGRATIONS = {
  /**
   * v1 → v2
   * v1 的特征：没有 schemaVersion；history 早期是「按时间平铺的数组」。
   * 数组版在渲染层按对象遍历会崩，所以这里显式按 entryId 归组成对象；
   * 没有 entryId 的孤儿记录挪到 `__orphan` 下，宁可留着也不扔。
   */
  1: (v) => {
    const next = { ...v };
    if (Array.isArray(next.history)) {
      const grouped = {};
      for (const item of next.history) {
        if (!item || typeof item !== 'object') continue;
        const key = String(item.entryId || '') || '__orphan';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(item);
      }
      next.history = grouped;
    }
    return next;
  },

  /**
   * v2 → v3：把独立的「测试账号」并进网址条目。
   *
   * 以前同一个系统的地址在 entries、账号在 accounts，查一个系统要在两个页面之间对。
   * 现在账号挂到条目下（entry.accounts），一个地址看得全：主账号 + 各角色账号。
   *
   * 匹配从严到宽：① 系统名 + 环境都相同；② 只比系统名。
   * 都匹配不上就跳过 —— 挂错条目比不合并更糟。
   * 原 accounts 集合**原样保留**（只追加不删除）：迁移写错了也不丢数据，回退旧版本还能看到。
   */
  2: (v) => {
    const next = { ...v };
    const entries = Array.isArray(next.entries) ? next.entries.map((e) => ({ ...e })) : [];
    const accts = Array.isArray(next.accounts) ? next.accounts : [];
    if (!entries.length || !accts.length) return next;

    for (const a of accts) {
      const sys = sysKeyOf(a.system);
      const user = String(a.username || '').trim();
      if (!sys || !user) continue;
      let hit = entries.find((e) => sysKeyOf(e.name) === sys && String(e.envType || '') === String(a.envType || ''));
      if (!hit) hit = entries.find((e) => sysKeyOf(e.name) === sys);
      if (!hit) continue;
      const list = Array.isArray(hit.accounts) ? hit.accounts.slice() : [];
      const dup = list.some((x) => String(x.username || '') === user && String(x.role || '') === String(a.role || ''));
      if (dup) continue;
      list.push({
        id: String(a.id || '') || `acc-${user}`,
        role: String(a.role || ''),
        username: user,
        password: String(a.password || ''),
        note: String(a.note || ''),
      });
      hit.accounts = list;
    }

    next.entries = entries;
    return next;
  },

  /**
   * v3 → v4：只新增集合，结构无搬移；加这一步是为了让降级打开能命中 future 分支。
   *
   * 为什么「什么都不做」也要留一步（契约 C-41）：本次只往 VAULT_COLLECTIONS 追加了
   * pomPages / scanRuns / coverageRuns / caseMaps / allureRuns，一个既有字节都不动，
   * 所以本步是恒等函数。它的唯一作用是让库里的 schemaVersion 真的涨到 4 ——
   * 旧版应用（版本 3）读 4 的库时 declaredVersion > 当前版本，会走 migrateVault 的 future 分支
   * 与 normalizeVault 的「保留未知字段」分支，5 个新集合才不会在降级往返里被洗掉（C-43）。
   * **恒等也要有返回值**：migrateVault 的循环会为所有 v3 老库实实在在调用一次。
   */
  3: (v) => v,

  /**
   * v4 → v5（契约 §9 [C-111] / [C-110]，2026-11-26，对禁令 #10 的定向一次豁免）
   *
   * **只做两件事**，一个既有字节都不搬：
   * 1. 缺失的 `uiRecordings` 补成 `[]`（新集合从空数组开始）；
   * 2. `pomPages[].elements[]` 里**缺 `id`** 的元素回填 `id`（[C-110]：写端必填，读端容错历史数据）。
   *
   * **幂等**：已有 `id` 的元素原样保留，重复执行结果严格相等（单测锁死）。
   *
   * **回填的 id 必须可复现**：用 sha1 对 `(pageId, elementIndex, name, locator)` **四维**派生
   * （`pageId` 缺失时用 `#<pageIndex>` 兜底，见 `deriveElementId` 与契约 `[C-111]` v22）——
   * **不用 `crypto.randomUUID()`** —— 随机会让同一份老库在两台机器上迁移出不同结果，
   * AC-8「重开应用后逐字段相等」与 golden 都没法比，跨机器导入导出还会把元素引用指错。
   * （`[C-21]` 的 randomUUID 是给渲染层**新建**元素定的，迁移路径不适用。）
   */
  4: (v) => {
    const next = { ...v };
    if (!Array.isArray(next.uiRecordings)) next.uiRecordings = [];
    if (Array.isArray(next.pomPages)) {
      next.pomPages = next.pomPages.map((page, pageIndex) => {
        if (!page || typeof page !== 'object' || !Array.isArray(page.elements)) return page;
        const elements = page.elements.map((el, elementIndex) => {
          if (!el || typeof el !== 'object') return el;
          if (typeof el.id === 'string' && el.id) return el; // 已有 id：原样保留（幂等）
          return { ...el, id: deriveElementId(page, pageIndex, elementIndex, el) };
        });
        return { ...page, elements };
      });
    }
    return next;
  },
};

/**
 * 迁移回填元素 id 的确定性派生（[C-111]）：同输入 → 同输出，跨机器/跨次执行都一样。
 * 输出拼成 uuid 形状（8-4-4-4-12，共 32 位十六进制），但**不是 RFC 4122 版本号语义**，
 * 没有任何代码按版本位解析它（契约 §9 [C-109] 的 `id` 约束已写明这一点）。
 *
 * 维度与 `[C-111]` 对齐：**`pageId` + `elementIndex` + `name` + `locator` 四维**（RA2-14：
 * 原实现多一维 `pageIndex`，契约里没有它 —— 页面顺序一变（插入/删除页面）所有元素 id 全变，
 * 反而破坏「稳定锚点」的初衷）。页面没有 id 的极端情况用 `#<pageIndex>` 兜底，避免不同页面
 * 在 pageId 缺失时互相撞车。
 */
function deriveElementId(page, pageIndex, elementIndex, el) {
  const pageKey = page && page.id != null && page.id !== '' ? String(page.id) : `#${pageIndex}`;
  const seed = [pageKey, elementIndex, el && el.name, el && el.locator]
    .map((x) => (x == null ? '' : String(x)))
    .join('\u0000');
  const hex = crypto.createHash('sha1').update(seed, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * v3 迁移用的系统名归一：与渲染层 `src/utils/systemGroups.ts` 的 systemOfEntryName 保持一致。
 * 主进程不能 import TS，所以这里保留一份等价实现（规则很短，改一处记得改两处）。
 */
function sysKeyOf(name) {
  return String(name || '').trim()
    .replace(/[-_—\s]*[（(]\s*(正式|测试|开发|预发|生产|验收)(环境|版)?\s*[）)]\s*$/i, '')
    .replace(/[-_—\s]+(正式|测试|开发|预发|生产|验收)(环境|版)?\s*$/i, '')
    .replace(/[-_—\s]+(uat|sit|fat|dev|prod|test|staging|pre|stage)\s*$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * 读出库里声明的版本；没有就当 v1（本项目第一版没写版本号）。
 * @param {unknown} v
 * @returns {number}
 */
function declaredVersion(v) {
  const n = Number(v && typeof v === 'object' ? v.schemaVersion : 0);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * 把任意版本的库升到当前版本。
 *
 * 返回值里的 `future` 表示「这个库来自更新版本的应用」：
 * 此时不做迁移，只把版本号原样带回，由 normalizeVault 保留未知字段，
 * 避免用户降级打开新库后，一保存就把新字段全洗掉。
 *
 * @param {unknown} v
 * @returns {{ vault: any, from: number, to: number, applied: number[], future: boolean }}
 */
function migrateVault(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const from = declaredVersion(src);
  const applied = [];
  const future = from > VAULT_SCHEMA_VERSION;

  if (future) {
    return { vault: { ...src }, from, to: from, applied, future };
  }

  let cur = { ...src };
  let ver = from;
  while (ver < VAULT_SCHEMA_VERSION) {
    const step = MIGRATIONS[ver];
    if (!step) break;
    cur = step(cur);
    applied.push(ver);
    ver += 1;
  }

  // 迁移函数不自己写版本号，统一在这里落，避免某一版忘了加
  cur.schemaVersion = ver;
  return { vault: cur, from, to: ver, applied, future };
}

/**
 * 补齐缺失字段，保证返回值可直接用。
 * - entries / tags 必须是数组
 * - history 早期是数组，现在必须是对象（entryId → 历史记录[]），否则渲染层会崩
 * - 其余集合按 VAULT_COLLECTIONS 补空数组
 * - 未知字段一律丢弃（避免脏数据被写回磁盘）；**但库版本比当前新时保留**，
 *   否则降级打开一次就把新版本的字段抹掉了
 */
function normalizeVault(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const ver = declaredVersion(src);
  const out = {
    schemaVersion: ver > VAULT_SCHEMA_VERSION ? ver : VAULT_SCHEMA_VERSION,
    entries: Array.isArray(src.entries) ? src.entries : [],
    tags: Array.isArray(src.tags) ? src.tags : [],
    history: (src.history && typeof src.history === 'object' && !Array.isArray(src.history)) ? src.history : {},
  };
  for (const key of VAULT_COLLECTIONS) {
    out[key] = Array.isArray(src[key]) ? src[key] : [];
  }
  // 更高版本的库：不认识的字段原样带上，让它还能被原封不动写回去
  if (ver > VAULT_SCHEMA_VERSION) {
    for (const key of Object.keys(src)) {
      if (!(key in out)) out[key] = src[key];
    }
  }
  return out;
}

module.exports = {
  VAULT_COLLECTIONS,
  VAULT_SCHEMA_VERSION,
  MIGRATIONS,
  declaredVersion,
  migrateVault,
  normalizeVault,
};
