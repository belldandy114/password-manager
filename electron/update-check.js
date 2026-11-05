'use strict';

/**
 * 版本比较 + 「要不要弹更新提示」的判定（纯函数，从 main.js 下沉）。
 *
 * 这段逻辑写错的后果是悄悄错：要么新版本永远提示不到（用户一直用旧版），
 * 要么每次启动都弹同一个提示（很快就被用户关掉通知）。
 */

/** a>b → 1，a<b → -1，相等 → 0；不足位按 0 补 */
function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 是否需要弹「发现新版本」。
 * - 最新版必须比当前版本高；
 * - 同一版本只提示一次（记住上次提示过的版本号）。
 */
function shouldNotifyUpdate({ current, latest, lastNotified }) {
  const cur = String(current || '').replace(/^v/i, '').trim();
  const lat = String(latest || '').replace(/^v/i, '').trim();
  if (!cur || !lat) return false;
  if (cmpVersion(lat, cur) <= 0) return false;
  const prev = String(lastNotified || '').replace(/^v/i, '').trim();
  return prev !== lat;
}

module.exports = { cmpVersion, shouldNotifyUpdate };
