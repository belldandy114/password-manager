'use strict';

/**
 * 环境巡检 IPC（#3）：一次把多个环境的地址探一遍，返回状态码与耗时。
 *
 * 为什么要用 electron 的 net 而不是 Node 的 http：
 * - 走 Chromium 的网络栈，公司代理 / 系统证书 / PAC 与浏览器一致，探"能不能打开"才有意义；
 * - Node 的 http 不走系统代理，内网环境下会得到一堆误报的失败。
 *
 * 判定口径：拿到状态码就算「服务可达」（401/403/404 说明服务活着，只是路径或权限不对），
 * 只有 5xx 与网络层错误算失败。请求拿到响应头就 abort，不下载响应体。
 */

const { ipcMain, net, shell, session } = require('electron');
const { spawn } = require('child_process');
const { openHttpUrl } = require('./url-open');
const { focusBrowser } = require('./browser-focus');
const { normalizeProbeUrl, clampTimeout, runProbes, summarizeProbes, MAX_URLS } = require('./env-probe');

/** 探测单个地址：resolve 一个永远不会 reject 的结果 */
function probeOne(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timer = null;
    let req = null;

    const finish = (patch) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ url, ms: Date.now() - started, ...patch });
    };

    try {
      req = net.request({ method: 'GET', url, session: session.defaultSession, redirect: 'follow' });
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || '无法发起请求' });
      return;
    }

    timer = setTimeout(() => {
      try { req.abort(); } catch { /* 忽略 */ }
      finish({ ok: false, error: `超时（${timeoutMs} ms）` });
    }, timeoutMs);

    req.on('response', (res) => {
      const status = Number(res.statusCode) || 0;
      // 状态码 0 说明连接被判死（黑洞地址常见），要带上原因，别留个空白失败
      finish(status > 0
        ? { ok: status < 500, status }
        : { ok: false, status: 0, error: '没有拿到状态码' });
      // 拿到响应头就够判断了，别把页面/大文件读进内存
      try { req.abort(); } catch { /* 忽略 */ }
    });

    req.on('error', (err) => {
      const msg = String((err && err.message) || '连接失败');
      finish({ ok: false, error: msg.replace(/^net::/, '') });
    });

    try {
      req.end();
    } catch (e) {
      finish({ ok: false, error: (e && e.message) || '请求结束失败' });
    }
  });
}

/**
 * @param {{ loadSettings?: () => any }} deps 预留：以后要从设置里读代理/超时
 */
function registerEnvIpc(deps = {}) {
  void deps;

  ipcMain.handle('env:probe', async (_event, payload = {}) => {
    const raw = Array.isArray(payload.targets) ? payload.targets : [];
    if (!raw.length) return { success: false, error: '没有可巡检的地址' };

    // 逐条规整：非法地址直接判失败，不能整批退掉（用户可能只填错了一条）
    const entries = raw.slice(0, MAX_URLS).map((t, i) => {
      const id = String((t && t.id) || '') || `t${i}`;
      const url = normalizeProbeUrl(t && t.url);
      return { id, raw: String((t && t.url) || ''), url };
    });
    const valid = entries.filter((e) => !!e.url);
    const invalid = entries.filter((e) => !e.url);

    const timeoutMs = clampTimeout(payload.timeoutMs);
    const probed = valid.length ? await runProbes(valid.map((e) => e.url), (u) => probeOne(u, timeoutMs)) : [];

    const results = [];
    let cursor = 0;
    for (const e of entries) {
      if (!e.url) {
        results.push({ id: e.id, url: e.raw, ok: false, ms: 0, error: '地址不合法' });
      } else {
        const r = probed[cursor] || { url: e.url, ok: false, ms: 0, error: '未返回结果' };
        cursor += 1;
        results.push({ ...r, id: e.id });
      }
    }
    return { success: true, data: { results, summary: summarizeProbes(results), timeoutMs } };
  });

  // 巡检表里「打开」用：只放行 http(s)，避免把奇怪 scheme 丢给系统。
  // 走 url-open 的兜底链：openExternal 静默失败时再试 rundll32 / cmd start，
  // 并把真正的原因带回渲染层（用户至少能看到「没能打开」而不是毫无反应）。
  ipcMain.handle('env:open', async (_event, { url } = {}) => {
    const u = normalizeProbeUrl(url);
    if (!u) return { success: false, error: '地址不合法' };
    console.log('[open] env:open -> 默认浏览器链');
    const r = await openHttpUrl(u, { shell, spawn });
    if (r && r.success) {
      console.log('[open] 打开成功 via=' + r.via + '，尝试把浏览器叫到前台');
      focusBrowser();
    }
    return r;
  });
}

module.exports = { registerEnvIpc, probeOne };
