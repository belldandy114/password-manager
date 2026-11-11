'use strict';

/**
 * 密码库自检（只读）。
 *
 * 为什么需要它：`normalizeVault` 只保证「结构对」，保证不了「数据能用」——
 * 解密成功、界面能打开，不代表附件文件还在、标签没有悬空、历史记录还挂在活着的条目上。
 * 这些坏数据平时不报错，等到要恢复备份、要导出、要搜某条记录时才暴露。
 *
 * 设计约定：
 * - **纯函数**：不碰 fs、不碰 Electron，附件是否存在由调用方传回调进来，方便单测；
 * - **只读**：只返回问题清单，绝不自动修复 —— 修复策略（删/补/留）必须由人决定；
 * - **分级**：error 影响使用（数据没了/结构坏了），warn 是可疑，info 是完全可以不管的提示。
 */

/** entry 必填字段：缺了界面上就会出现一条点不开的空行 */
const REQUIRED_ENTRY_FIELDS = ['id', 'name'];

/**
 * 网址检查口径：与 electron/url-open.js 的 normalizeHttpUrl 对齐 ——
 * 没有协议头的（`example.com`、`10.0.0.1:8080`）会被自动补 https://，算正常；
 * 只有「写了协议头但不是 http(s)」的（ftp: / file: / javascript:）才点不开。
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_SCHEME = /^https?:\/\//i;

/** @param {string} url */
function badUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  return HAS_SCHEME.test(u) && !HTTP_SCHEME.test(u);
}

/**
 * 判断一个时间字符串是不是能用的时间戳。
 * 空值算「没填」不报错（早期导入的数据本来就没有时间），填了但解析不了才算问题。
 */
function badTime(v) {
  if (v == null || v === '') return false;
  const t = Date.parse(String(v));
  return Number.isNaN(t);
}

/**
 * @param {any} vault 已归一化的库（normalizeVault 的返回值）
 * @param {object} [opts]
 * @param {(id: string) => boolean} [opts.attachmentExists] 附件文件是否存在；不传就跳过这项检查
 * @param {string[]} [opts.noteAttachmentIds] 从笔记正文里抽出的附件 id（主进程抽，渲染层工具函数不共用）
 * @returns {{
 *   ok: boolean, checkedAt: string, schemaVersion: number,
 *   stats: Record<string, number>,
 *   counts: { error: number, warn: number, info: number },
 *   issues: Array<{ level: string, code: string, message: string, count: number, samples: string[] }>
 * }}
 */
function auditVault(vault, opts = {}) {
  const v = vault && typeof vault === 'object' && !Array.isArray(vault) ? vault : {};
  const attachmentExists = typeof opts.attachmentExists === 'function' ? opts.attachmentExists : null;
  /** @type {Array<{level:string,code:string,message:string,samples:string[]}>} */
  const issues = [];
  const add = (level, code, message, samples) => {
    const list = (samples || []).map(String);
    issues.push({ level, code, message, samples: list.slice(0, 5), count: list.length });
  };

  const entries = Array.isArray(v.entries) ? v.entries : [];
  const tags = Array.isArray(v.tags) ? v.tags : [];
  const history = v.history && typeof v.history === 'object' && !Array.isArray(v.history) ? v.history : {};

  // ---- 条目 ----
  const seenIds = new Map();
  const missingId = [];
  const dupIds = new Map();
  const missingName = [];
  const badUrls = [];
  const badTimes = [];
  const danglingTags = [];
  const missingAttach = [];
  const usedTags = new Set();

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id || '');
    if (!id) missingId.push(e.name || '(无名称)');
    else if (seenIds.has(id)) {
      const n = (dupIds.get(id) || 1) + 1;
      dupIds.set(id, n);
    } else seenIds.set(id, 1);

    for (const f of REQUIRED_ENTRY_FIELDS) {
      if (f === 'id') continue;
      if (!String(e[f] == null ? '' : e[f]).trim()) missingName.push(id || '(无 id)');
    }

    const url = String(e.url || '').trim();
    if (badUrl(url)) badUrls.push(`${e.name || id}: ${url}`);

    if (badTime(e.createdAt) || badTime(e.updatedAt)) badTimes.push(`${e.name || id}`);

    if (Array.isArray(e.tags)) {
      for (const t of e.tags) {
        const name = String(t || '').trim();
        if (!name) continue;
        usedTags.add(name);
        if (!tags.includes(name)) danglingTags.push(`${e.name || id} → ${name}`);
      }
    }

    if (attachmentExists && Array.isArray(e.attachments)) {
      for (const a of e.attachments) {
        const aid = String((a && a.id) || '');
        if (aid && !attachmentExists(aid)) missingAttach.push(`${e.name || id} → ${aid}`);
      }
    }
  }

  if (missingId.length) add('error', 'entry-missing-id', `${missingId.length} 条记录没有 id，界面里点不开也删不掉`, missingId);
  if (dupIds.size) {
    const samples = [...dupIds.entries()].slice(0, 5).map(([id, n]) => `${id} ×${n}`);
    add('error', 'entry-duplicate-id', `${dupIds.size} 个 id 被多条记录重复使用，编辑其中一条会改到另一条`, samples);
  }
  if (missingName.length) add('warn', 'entry-missing-name', `${missingName.length} 条记录没有名称`, missingName);
  if (badUrls.length) add('warn', 'entry-bad-url', `${badUrls.length} 条记录的网址不是 http(s)，点「打开」会用不了`, badUrls);
  if (badTimes.length) add('warn', 'entry-bad-time', `${badTimes.length} 条记录的时间戳解析不了，排序会错位`, badTimes);
  if (danglingTags.length) add('warn', 'tag-dangling', `${danglingTags.length} 处条目引用了标签表里不存在的标签（筛选面板里看不到）`, danglingTags);
  if (missingAttach.length) add('error', 'attachment-missing', `${missingAttach.length} 个条目附件的文件已丢失`, missingAttach);

  // ---- 历史记录 ----
  const orphanHistory = Object.keys(history).filter(k => !seenIds.has(k));
  if (orphanHistory.length) {
    add('warn', 'history-orphan', `${orphanHistory.length} 组密码历史挂在已删除的条目上（白占地方，可清理）`, orphanHistory);
  }

  // ---- 笔记里的图片附件 ----
  if (attachmentExists) {
    const noteMissing = [];
    for (const n of Array.isArray(v.notes) ? v.notes : []) {
      const md = String((n && n.content) || '');
      const re = /!\[[^\]]*\]\(pm-att:([a-zA-Z0-9-]+)\)/g;
      let m;
      while ((m = re.exec(md)) !== null) {
        if (!attachmentExists(m[1])) noteMissing.push(`${(n && n.title) || '未命名笔记'} → ${m[1]}`);
      }
    }
    if (noteMissing.length) add('error', 'note-attachment-missing', `${noteMissing.length} 张笔记图片的文件已丢失`, noteMissing);
  }

  // ---- 接口调试历史 ----
  const apiIds = new Set((Array.isArray(v.apiRequests) ? v.apiRequests : []).map(r => String((r && r.id) || '')));
  const apiHistory = v.apiHistory && typeof v.apiHistory === 'object' && !Array.isArray(v.apiHistory) ? v.apiHistory : null;
  if (apiHistory) {
    const orphanApi = Object.keys(apiHistory).filter(k => !apiIds.has(k));
    if (orphanApi.length) add('info', 'api-history-orphan', `${orphanApi.length} 组接口历史对应的请求已删除`, orphanApi);
  }

  // ---- 标签 ----
  const unusedTags = tags.filter(t => !usedTags.has(String(t)));
  if (unusedTags.length) add('info', 'tag-unused', `${unusedTags.length} 个标签没有任何条目在用`, unusedTags);
  const dupTags = tags.filter((t, i) => tags.indexOf(t) !== i);
  if (dupTags.length) add('warn', 'tag-duplicate', `标签表里有 ${dupTags.length} 个重复标签`, dupTags);

  const counts = { error: 0, warn: 0, info: 0 };
  for (const it of issues) counts[it.level] = (counts[it.level] || 0) + 1;

  const stats = {
    entries: entries.length,
    tags: tags.length,
    historyGroups: Object.keys(history).length,
    notes: Array.isArray(v.notes) ? v.notes.length : 0,
    accounts: Array.isArray(v.accounts) ? v.accounts.length : 0,
    environments: Array.isArray(v.environments) ? v.environments.length : 0,
    snippets: Array.isArray(v.snippets) ? v.snippets.length : 0,
    apiRequests: apiIds.size,
  };

  return {
    ok: counts.error === 0,
    checkedAt: new Date().toISOString(),
    schemaVersion: Number(v.schemaVersion) || 1,
    stats,
    counts,
    issues: issues.sort((a, b) => severity(b.level) - severity(a.level)),
  };
}

/** error > warn > info */
function severity(level) {
  if (level === 'error') return 3;
  if (level === 'warn') return 2;
  return 1;
}

module.exports = { auditVault, badUrl, REQUIRED_ENTRY_FIELDS };
