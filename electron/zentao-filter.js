'use strict';

/**
 * 禅道「我的 Bug」本地账号过滤。
 *
 * 为什么要在本地过滤：禅道 REST 的 `GET bugs` 只对 `product` / `status` 这类参数可靠生效，
 * `openedBy` / `assignedTo` 传了也可能被**静默忽略**——表现是「我提交的」拉回来一堆别人的 Bug。
 * 之前只在假禅道上验过过滤，真实实例只验过 `product`，所以这个坑一直没暴露。
 *
 * 策略：服务端参数照传（能过滤更好），回来后再按 account 本地过滤一遍；
 * 如果返回里根本没有账号字段（不同禅道版本字段可能缺失），就**不要过滤**，只标记出来，
 * 否则会把所有数据误杀成 0 条。
 */

/** 从 `{account, realname}` 或裸字符串里取账号，统一小写比较 */
function accountOf(who) {
  if (!who) return '';
  if (typeof who === 'string') return who.trim().toLowerCase();
  return String(who.account || '').trim().toLowerCase();
}

/** 按视图取「谁」：我提交的看 openedBy，待我验证看 assignedTo */
function pickWho(bug, scope) {
  if (!bug) return null;
  return scope === 'opened' ? bug.openedBy : bug.assignedTo;
}

/**
 * @param {any[]} rows 服务端返回并已映射的 Bug 列表
 * @param {string} account 当前登录账号
 * @param {'opened'|'verify'|string} scope
 * @returns {{ rows: any[], filtered: boolean, withAccount: number, dropped: number }}
 */
function filterMineBugs(rows, account, scope) {
  const list = Array.isArray(rows) ? rows : [];
  const want = String(account || '').trim().toLowerCase();
  if (!want) return { rows: list, filtered: false, withAccount: 0, dropped: 0 };
  // 空列表没有「过滤过」可言，返回未过滤（界面据此不显示「已按账号过滤」）
  if (list.length === 0) return { rows: [], filtered: false, withAccount: 0, dropped: 0 };

  let withAccount = 0;
  for (const b of list) {
    if (accountOf(pickWho(b, scope))) withAccount++;
  }
  // 一条账号字段都没有 → 服务端没返回这个信息，本地过滤会把全部数据误杀，直接放弃过滤
  if (list.length > 0 && withAccount === 0) {
    return { rows: list, filtered: false, withAccount: 0, dropped: 0 };
  }

  const kept = list.filter(b => accountOf(pickWho(b, scope)) === want);
  return { rows: kept, filtered: true, withAccount, dropped: list.length - kept.length };
}

module.exports = { accountOf, pickWho, filterMineBugs };