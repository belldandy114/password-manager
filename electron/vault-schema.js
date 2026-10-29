'use strict';

/**
 * 密码库结构归一化（旧库升级的唯一关口）。
 *
 * 为什么单独成模块：
 * - 它是「老版本 vault → 当前结构」的唯一入口，改错了就是丢数据，必须有单测；
 * - 主进程 main.js 太大，纯函数先下沉，照着 electron/csv.js 的模式（配套 .d.ts 让渲染层单测也能 import）。
 *
 * 约定：**只保证结构，不改内容**。数组/对象原样透传（不深拷贝），
 * 因为 loadVault 会把结果放进内存缓存，拷贝反而会让缓存与磁盘不一致。
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
];

/**
 * 补齐缺失字段，保证返回值可直接用。
 * - entries / tags 必须是数组
 * - history 早期是数组，现在必须是对象（entryId → 历史记录[]），否则渲染层会崩
 * - 其余集合按 VAULT_COLLECTIONS 补空数组
 * - 未知字段一律丢弃（避免脏数据被写回磁盘）
 */
function normalizeVault(v) {
  const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const out = {
    entries: Array.isArray(src.entries) ? src.entries : [],
    tags: Array.isArray(src.tags) ? src.tags : [],
    history: (src.history && typeof src.history === 'object' && !Array.isArray(src.history)) ? src.history : {},
  };
  for (const key of VAULT_COLLECTIONS) {
    out[key] = Array.isArray(src[key]) ? src[key] : [];
  }
  return out;
}

module.exports = { VAULT_COLLECTIONS, normalizeVault };
