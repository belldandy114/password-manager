'use strict';

/**
 * 「用系统浏览器打开网址」的兜底链（纯逻辑，便于单测）。
 *
 * 为什么不是一句 `shell.openExternal` 就完事，也不是「explorer.exe 排第一」：
 * 这些路径**不是每个宿主进程里都成立**，必须靠实测定顺序。2026-11-11 在本机做过 8 组对照
 * （同一个 https 探测地址 + 本地 HTTP 服务器收请求 + 事后查 Chrome 历史，判「真打开」还是「假成功」）：
 *
 * | 方式                                  | 从 node 进程 | 从 Electron 主进程 |
 * |---------------------------------------|--------------|--------------------|
 * | rundll32 url.dll,FileProtocolHandler  | ✅           | ✅                 |
 * | shell.openExternal                    | ✅           | ✅                 |
 * | 直接拉 browser.exe（Chrome/Edge）      | ✅           | ✅                 |
 * | `explorer.exe <url>`（shell 代理）     | ✅           | ❌ 退出码 1，静默失败 |
 *
 * 也就是说 **explorer 代理在 Electron 里是假成功**（spawn 出去、立刻 exit 1、浏览器毫无反应），
 * 曾经把它排第一，界面照样显示「已打开」，用户看到的就是「点了没反应」。
 *
 * 现在的顺序（每条都会往 app.log 写一行，出问题一次点击就能定位）：
 *   rundll32 → 直接拉浏览器 exe（Chrome/Edge…）→ openExternal → explorer（最后兜底）
 *
 * 另一个坑：`cmd /c start "" <url>` 看着最像双击，但地址里带 `&` 时 cmd 会当成命令分隔符，
 * 查询串被截断，所以这里不采用。rundll32 走 CommandLineToArgvW，`&` 是普通字符，安全。
 *
 * 依赖（shell / spawn / platform / candidateBrowsers / log）全部由调用方注入，
 * 模块内不 require electron，这样渲染层单测可以直接 import。
 */

const fs = require('fs');

/**
 * 补协议并只放行 http(s)；非法地址返回空串。
 *
 * 两个容易写错的地方（都踩过）：
 * - `javascript:alert(1)` 这种**不带 // 的伪协议**不能靠「没协议就补 https://」处理，
 *   否则会拼成 `https://javascript:alert(1)` 而绕过校验 —— 先显式拒绝危险 scheme；
 * - `localhost:3000` / `host:8080/path` 是环境矩阵里最常见的填法，不能当伪协议拒掉，
 *   所以只按「已知危险 scheme 名单」拦，不按「有没有冒号」判。
 */
const DANGEROUS_SCHEME = /^(javascript|data|vbscript|file|about|blob|filesystem|mailto|tel|chrome|edge|ms-)/i;

function normalizeHttpUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  // 控制字符与空白直接去掉：粘贴进来的地址常带换行/制表符
  url = url.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (!url) return '';
  if (DANGEROUS_SCHEME.test(url)) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  return /^https?:\/\//i.test(url) ? url : '';
}

/** 日志里只留「协议 + 主机 + 路径」，去掉查询串（地址里可能带 token/密码） */
function safeForLog(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return String(url || '').slice(0, 160);
  }
}

/**
 * 兜底命令：只在 Windows 上有意义，顺序即实测的可靠性顺序。
 *
 * 每条都带 `via`，失败时回给界面/日志，方便下次排查「到底哪条没生效」。
 *
 * @param {string} url
 * @param {string} platform
 * @returns {Array<{ exe: string, args: string[], via: string }>}
 */
function fallbackCommands(url, platform) {
  if (platform !== 'win32') return [];
  const windir = process.env.WINDIR || 'C:\\Windows';
  return [
    { exe: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], via: 'rundll32' },
    // explorer 在 Electron 宿主里会静默 exit 1（假成功），只留作最后兜底
    { exe: `${windir}\\explorer.exe`, args: [url], via: 'explorer' },
  ];
}

/**
 * 常见的 Chrome / Edge 安装位置。直接拉 exe 走的是「新标签页」通道，
 * 不依赖 http 协议关联是否被改坏 —— 这是 openExternal 失败时最有效的一招。
 */
function detectBrowserExes() {
  const env = process.env;
  const local = env.LOCALAPPDATA || '';
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const list = [
    { exe: `${local}\\Google\\Chrome\\Application\\chrome.exe`, via: 'chrome' },
    { exe: `${pf}\\Google\\Chrome\\Application\\chrome.exe`, via: 'chrome' },
    { exe: `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, via: 'chrome' },
    { exe: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, via: 'msedge' },
    { exe: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, via: 'msedge' },
  ];
  const out = [];
  for (const b of list) {
    try {
      if (b.exe && fs.existsSync(b.exe)) out.push(b);
    } catch { /* 忽略 */ }
  }
  return out;
}

/**
 * 把一条命令 spawn 出去，并**等到「进程真起来了」**再返回。
 *
 * 之前是 spawn 完立刻当成功 —— 而 exe 不存在时 `spawn` 并不抛错，只异步发 `error`，
 * 结果就是界面报「已打开」、实际什么都没有。这里用 `spawn`/`error` 事件竞速 + 600ms 超时。
 *
 * @returns {Promise<boolean>} 是否认为「已经交给系统」
 */
function spawnAndWait(cmd, spawn, log) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd.exe, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
      if (!child || typeof child.on !== 'function') return done(true);
      // 进程起不来（exe 不在/被杀软拦）会走 error；起来了会走 spawn
      child.on('error', (e) => { log(`  ${cmd.via} 起不来：${(e && e.message) || e}`); done(false); });
      child.on('spawn', () => done(true));
      // exit 只用来留痕（假成功就是「起来了又立刻退出」）
      child.on('exit', (code) => log(`  ${cmd.via} 退出码 ${code}`));
      // 拿不到事件（老版本 Node / 测试桩）也不要卡住：超时按成功算，交给后面兜底
      setTimeout(() => done(true), 600).unref?.();
      if (typeof child.unref === 'function') child.unref();
    } catch (e) {
      log(`  ${cmd.via} 抛错：${(e && e.message) || e}`);
      done(false);
    }
  });
}

/**
 * @param {string} raw 用户填的地址
 * @param {{
 *   shell?: { openExternal: (u: string) => Promise<any> },
 *   spawn?: Function,
 *   platform?: string,
 *   candidateBrowsers?: Array<{ exe: string, via: string }>,
 *   log?: (msg: string) => void,
 * }} deps
 * @returns {Promise<{ success: boolean, via?: string, error?: string }>}
 */
async function openHttpUrl(raw, deps = {}) {
  const url = normalizeHttpUrl(raw);
  if (!url) return { success: false, error: '地址不合法' };

  const { shell, spawn } = deps;
  const platform = deps.platform || process.platform;
  const win = platform === 'win32';
  const say = typeof deps.log === 'function' ? deps.log : (m) => { try { console.log(m); } catch { /* 忽略 */ } };
  const log = (msg) => say(`[url-open] ${msg}`);
  const t0 = Date.now();
  let lastError = '';

  log(`开始 ${safeForLog(url)} (${platform})`);

  /** 按序 spawn 兜底命令，第一条真正起来就算命中 */
  const tryCommands = async (cmds) => {
    if (typeof spawn !== 'function') return null;
    for (const cmd of cmds) {
      try {
        if (await spawnAndWait(cmd, spawn, log)) {
          log(`命中 via=${cmd.via} (${Date.now() - t0}ms)`);
          return { success: true, via: cmd.via || cmd.exe };
        }
      } catch (e) {
        lastError = (e && e.message) || lastError;
      }
    }
    return null;
  };

  // Windows：先 rundll32（实测在 Electron 里也能真打开），再直接拉浏览器 exe
  if (win) {
    const cmds = fallbackCommands(url, platform);
    const rundll = await tryCommands(cmds.filter((c) => c.via === 'rundll32'));
    if (rundll) return rundll;

    const browsers = (deps.candidateBrowsers || detectBrowserExes()).map((b) => ({
      exe: b.exe,
      args: [url],
      via: b.via,
    }));
    const direct = await tryCommands(browsers);
    if (direct) return direct;
  }

  if (shell && typeof shell.openExternal === 'function') {
    try {
      await shell.openExternal(url);
      log(`命中 via=shell (${Date.now() - t0}ms)`);
      return { success: true, via: 'shell' };
    } catch (e) {
      lastError = (e && e.message) || '系统未响应';
      log(`  openExternal 失败：${lastError}`);
    }
  }

  const rest = win ? fallbackCommands(url, platform).filter((c) => c.via !== 'rundll32') : [];
  const fallback = await tryCommands(rest);
  if (fallback) return fallback;

  log(`全部失败：${lastError || '打开失败'} (${Date.now() - t0}ms)`);
  return { success: false, error: lastError || '打开失败' };
}

module.exports = { normalizeHttpUrl, fallbackCommands, openHttpUrl, detectBrowserExes, safeForLog };
