'use strict';

/**
 * 禅道 REST 通用分页聚合器。
 *
 * 背景（1.24.8 修复「项目拉取不全」）：
 *   禅道服务端可能**忽略或压低** limit（同源框架 limit 默认仅 20），
 *   所以「这一页条数 < limit 就认为到尾」是错的 —— 会静默丢掉后面的项目/Bug。
 *   正确做法：以响应里的 total 为准翻页，并做 id 去重 + 无进展保护。
 *
 * 设计成纯函数（fetchPage 由调用方注入），是为了能脱离 Electron 做单测。
 *
 * @param {(page:number, perPage:number) => Promise<{list:Array, total:number}>} fetchPage
 * @param {{perPage?:number, maxPages?:number, getId?:(row:any)=>any}} opts
 * @returns {Promise<{items:Array, total:number, pages:number, truncated:boolean}>}
 */
async function ztPageAll(fetchPage, opts = {}) {
  const perPage = Number(opts.perPage) > 0 ? Number(opts.perPage) : 1000;
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : 200;
  const getId = typeof opts.getId === 'function' ? opts.getId : null;

  const items = [];
  const seen = new Set();
  let total = 0;
  let pages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page, perPage);
    pages = page;
    const list = Array.isArray(res && res.list) ? res.list : [];
    const t = Number(res && res.total);
    if (Number.isFinite(t) && t >= 0) total = t;

    let added = 0;
    for (const row of list) {
      const key = getId ? String(getId(row) == null ? '' : getId(row)) : '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      items.push(row);
      added++;
    }

    if (!list.length) break;                        // 空页：到底了
    if (total && items.length >= total) break;      // 拉满 total：正常结束
    if (getId && added === 0) break;                // 整页全是重复：服务端忽略了 page 参数
    // 没有 total 时只能靠空页/重复页收尾，maxPages 是最后防线
  }

  return {
    items,
    total: total || items.length,
    pages,
    // 拉满才算完整；total 缺失时以「没撞到 maxPages 上限」视为完整
    truncated: total > 0 ? items.length < total : pages >= maxPages,
  };
}

module.exports = { ztPageAll };
