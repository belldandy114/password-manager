'use strict';

/**
 * 环境巡检的纯逻辑（地址规整 + 并发调度 + 汇总）。
 *
 * 真正的网络请求留在 ipc-env.js（要用 electron 的 net 走 Chromium 的代理与证书栈），
 * 这里只做能单测的部分，避免把超时/并发/顺序这类容易写错的地方埋进 IPC。
 */

const MAX_URLS = 500;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 30000;
/** 超过这个耗时就标记为「慢」，巡检表里高亮 */
const SLOW_MS = 2000;

/**
 * 把用户填的地址规整成可请求的 URL。
 * - 没写协议补 http://（内网地址多数没有 https）；
 * - 只允许 http / https，其它 scheme（file:、javascript: 等）一律拒绝；
 * - 空串或解析失败返回 ''，调用方据此跳过。
 */
function normalizeProbeUrl(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // 只补协议，不猜端口；带 user:pass@ 的也交给 URL 解析
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s.replace(/^\/+/, '');
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!u.hostname) return '';
  return u.toString();
}

/** 超时时间收敛到 [2s, 30s]，非法值回落默认 8s */
function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

/**
 * 并发跑一批探针，结果顺序与入参一致（巡检表按用户填的顺序显示）。
 * probeOne 抛错不会中断整批，只把这一条记成失败。
 */
async function runProbes(urls, probeOne, options) {
  const list = (Array.isArray(urls) ? urls : [])
    .map((u) => (typeof u === 'string' ? u : String(u == null ? '' : u)))
    .slice(0, MAX_URLS);
  const opts = options || {};
  // 并发随批量自动放大一点：80 个地址用 6 并发，最坏情况（全超时）要等 100 秒以上。
  // 上限仍卡在 16，别把内网一次打满。
  const autoConcurrency = Math.min(16, Math.max(DEFAULT_CONCURRENCY, Math.ceil(list.length / 8)));
  const concurrency = Math.max(1, Math.min(16, Math.round(Number(opts.concurrency) || autoConcurrency)));
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      const url = list[i];
      try {
        const r = await probeOne(url, i);
        const row = { url, ok: false, ms: 0, ...(r || {}) };
        // 只有在没拿到结果时才补默认错误；成功的条目不该挂着「未返回结果」
        if (!row.ok && !row.error) row.error = '请求失败';
        results[i] = row;
      } catch (e) {
        results[i] = { url, ok: false, ms: 0, error: (e && e.message) || '请求失败' };
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, list.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * 汇总：可达 / 失败 / 慢的数量，平均耗时取可达条目的均值。
 * 「慢」只统计可达的，失败的不算慢。
 */
function summarizeProbes(results) {
  const list = Array.isArray(results) ? results.filter(Boolean) : [];
  const total = list.length;
  const okList = list.filter((r) => r.ok);
  const slow = okList.filter((r) => Number(r.ms) >= SLOW_MS);
  const msList = okList.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n >= 0);
  const avgMs = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0;
  let slowest = '';
  let worst = -1;
  okList.forEach((r) => {
    const ms = Number(r.ms) || 0;
    if (ms > worst) {
      worst = ms;
      slowest = r.url;
    }
  });
  return {
    total,
    ok: okList.length,
    fail: total - okList.length,
    slow: slow.length,
    avgMs,
    slowest,
  };
}

module.exports = {
  MAX_URLS,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  SLOW_MS,
  normalizeProbeUrl,
  clampTimeout,
  runProbes,
  summarizeProbes,
};
