'use strict';

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
];

/**
 * 当前库结构版本。**只许往上加，不许改历史值** ——
 * 已经把 v1 迁到 v2 的库，改动 v2 的定义就等于让它们的数据对不上号。
 */
const VAULT_SCHEMA_VERSION = 2;

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
};

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
