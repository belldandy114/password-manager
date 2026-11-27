'use strict';

/**
 * cdp.js —— 极简 CDP 客户端（元素库 A₂ 点验通道的**唯一**连接点）。
 *
 * ── ADR（4 行）────────────────────────────────────────────────────────
 * 决策：本仓库**并存两份 CDP 库** —— `electron/cdp.js`（运行时，进 asar，以此为准）
 *       与 `scripts/lib/cdp.js`（28 个 ui-*.js 回归脚本用，不进 asar）。
 * 背景：`package.json` 的 `build.files` 只打 `dist/**` 与 `electron/**`，
 *       所以 `electron/*.js` **不能** require `scripts/lib/*`（打包后路径不存在）。
 * 备选与放弃原因：把 scripts/lib/cdp.js 搬进 electron/ 要改 5 个 ui 脚本的 require
 *       （`ui-glass-opaque-scan` / `ui-palette-cache-test` / `ui-bg-test` / `ui-bg-glass-test` /
 *       `scripts/lib/app.js`），属别批范围，本批不动 `scripts/**`。
 * 后果：将来收敛时**以 electron/cdp.js 为源**、scripts/lib/cdp.js 作薄包装；
 *       在那之前两处的「挑 page target」规则必须逐项相等（单测锁死，见 `PAGE_TARGET_RULES`）。
 * ─────────────────────────────────────────────────────────────────────
 * 设计参考：1148872017/test-tool（main @ v0.65.0，package.json 声明 MIT，作者已授权，2026-11-27 留痕）
 *   借鉴：electron/sniffer/cdp.js 的 createCdpClient 全结构（pending/waiters 双表、failAll、
 *         markClosed、send 超时、waitFor 事件、close 语义）；electron/sniffer/browser-session.js 的
 *         connect（按 type==='page' 选 target）与 connectBrowserLevel（browser 端点发 Browser.close）。
 * 本项目改造点：
 *   1. send() 前置 **CDP_METHODS 白名单**收口，越界 reject `CDP_FORBIDDEN`（[A2-7]）；
 *   2. closeBrowser() 只允许发 `Browser.close`、不 enable 任何域，端点用 DevToolsActivePort 第二行（[A2-8] 唯一例外）；
 *   3. waitFor 同一事件**同时只允许 1 个等待者**（上游 `list.shift()` 的单等待者语义，写进注释与实现）；
 *   4. 不 require scripts/lib/cdp.js、不 require electron、不 require hit-args（禁循环，[A2-16]）；
 *      端口/目标一律由调用方作为参数给进来；
 *   5. 不截图、不轮询求值、不收集 Runtime.exceptionThrown（白名单外的东西一概不做）。
 * 逐条原因：docs/方案-元素库-A0A1A2-移植清单.md §2.4。
 */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 允许发出的 CDP 方法（[A2-7]，**多一个即不通过**）。
 *
 * 为什么白名单放在**这一层**（而不是调用方各自判断）：这是唯一能发字节的地方，
 * 收口在这里才没有第二条绕过路径。上游只有注释承诺「只发那几个命令」，代码不拦。
 *
 * 明确不在表里的（禁止）：`Network.*` / `Storage.*` / `Cookie.*` / `DOMStorage.*` /
 * `Debugger.*` / `Input.*` / `Page.captureScreenshot` /
 * `Page.addScriptToEvaluateOnNewDocument` / `Fetch.*` / `Target.*`（除 `/json/list` 这条 HTTP 发现）。
 */
const CDP_METHODS = Object.freeze([
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  'Page.enable',
  'Page.navigate',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.requestNode',
  'Overlay.enable',
  'Overlay.highlightNode',
  'Overlay.hideHighlight',
  'Browser.close',
]);

/**
 * 挑 page target 的规则（**顺序即优先级**，逐项与 `scripts/lib/cdp.js:80` 的 pick 相等）：
 *   ① `type === 'page'`
 *   ② `url` 不以 `devtools://` 开头
 *   ③ 必须有 `webSocketDebuggerUrl`
 * 单测会把这三项与 scripts/lib/cdp.js 的源码逐项比对，任一处改动都会红。
 */
const PAGE_TARGET_RULES = Object.freeze([
  "type === 'page'",
  "url 不以 devtools:// 开头",
  'has webSocketDebuggerUrl',
]);

/** 给调用方判断「是不是通道断了」用（上层据此改报 running:false / success:false） */
function isClosedError(err) {
  const code = err && err.code;
  return code === 'CDP_CLOSED' || code === 'CDP_CONNECT';
}

function cdpError(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function isAllowedMethod(method) {
  return CDP_METHODS.indexOf(String(method || '')) >= 0;
}

/**
 * 按 `PAGE_TARGET_RULES` 挑一个页面 target（**纯函数**，夹具可直喂）。
 *
 * @param {Array<object>} list `/json/list` 的返回
 * @returns {object|null}
 */
/**
 * 按规则挑一个**同源**的页面 target（**纯函数**，夹具可直喂）。
 *
 * `[SEC-03]`（契约 v5，安全评审 SEC-03）：除「type=page / 非 devtools:// / 有 ws 地址」三条形态规则外，
 * **还要求 target.url 与本次请求的 url 同源（scheme + host + port 三者全等）**。
 *
 * 为什么必须同源：这个浏览器是**带用户登录态**的（profile 跨会话保留）。若只是「挑第一个 page」，
 * 在用户自己又开了别的标签（或先前会话残留的标签）时，我们会把脚本注入到**别人的页面**上、
 * 并把导航开到别处 —— 那是拿用户登录态去做我们没打算做的事。同源不成立时**宁可报
 * `attach-failed` 也不许「挑一个再 navigate」**（契约 [A2-8] 第 3 步）。
 *
 * ⚠️ 与既有锁的关系（契约 v5 写死）：本函数里的同源校验是 **electron 侧新增的加固**，
 * **不参与** `scripts/lib/cdp.js` 的「逐项相等」比对（那个比对只覆盖四步**形态**）。
 * 改这里不要为了「让比对通过」删掉同源校验。
 *
 * @param {Array<object>} list `/json/list` 的返回
 * @param {string} expectedUrl 本次要打开的地址；缺失/非法 → 一律不选（返回 null）
 * @returns {object|null}
 */
function pickPageTarget(list, expectedUrl) {
  const want = originOf(expectedUrl);
  if (!want) return null; // 没有期望地址 = 无法判同源 → 不选（不许「挑一个先连上」）
  const arr = Array.isArray(list) ? list : [];
  for (const t of arr) {
    if (!t || t.type !== 'page') continue;
    if (String(t.url || '').startsWith('devtools://')) continue;
    if (!t.webSocketDebuggerUrl) continue;
    if (originOf(t.url) !== want) continue; // 跨源/无 URL 的 target 直接跳过
    return t;
  }
  return null;
}

/** `scheme//host:port` 归一（host 已含端口）；非法/空 → '' */
function originOf(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** 带超时的 GET JSON（只用于 `/json/list`，本文件是 electron/ 下唯一出现它的地方） */
async function getJson(url, timeoutMs, fetchImpl) {
  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof f !== 'function') throw cdpError('当前运行环境没有 fetch', 'CDP_CONNECT');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, Math.max(200, Number(timeoutMs) || 2000))
    : null;
  try {
    const res = await f(url, controller ? { signal: controller.signal } : undefined);
    if (!res || !res.ok) {
      throw cdpError(`读 ${url.replace(/\?.*$/, '')} 失败：HTTP ${res ? res.status : '无响应'}`, 'CDP_HTTP');
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 发现页面 target：`GET http://127.0.0.1:<port>/json/list` 后按规则挑（[A2-8] 第 3 步）。
 *
 * **不猜端口**：port 一定来自 `<profile>/DevToolsActivePort` 第一行（调用方读）。
 *
 * @param {number} port
 * @param {{timeout?: number, fetch?: Function}} [opts]
 * @returns {Promise<{ok:true, target:object} | {ok:false, error:string, code:string}>}
 */
async function discoverPageTarget(port, opts) {
  const o = opts || {};
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) {
    return { ok: false, error: '调试端口无效', code: 'CDP_PORT' };
  }
  // [SEC-03]：没有期望地址就不许连（否则「同源」无从判断）
  if (!originOf(o.expectedUrl)) {
    return { ok: false, error: '缺少目标地址，无法校验调试目标是否同源', code: 'CDP_NO_EXPECTED_URL' };
  }
  let list;
  try {
    list = await getJson(`http://127.0.0.1:${p}/json/list`, o.timeout, o.fetch);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: (e && e.code) || 'CDP_HTTP' };
  }
  const target = pickPageTarget(list, o.expectedUrl);
  if (!target) {
    return { ok: false, error: '浏览器里没有与目标地址同源的页面标签', code: 'CDP_NO_TARGET' };
  }
  return { ok: true, target };
}

/**
 * 连上一个 CDP WebSocket 端点，返回客户端。
 *
 * 结构照抄上游 `createCdpClient`：pending（命令 id → 回包）与 waiters（事件名 → 等待者）双表，
 * 断线时 `failAll` 把两边**全部** reject —— 绝不挂着不回（[A2-4]：没验成要说成没验成）。
 *
 * ⚠️ `waitFor` **同一事件同时只允许 1 个等待者**：`handleMessage` 对事件用 `shift()` 取第一个，
 * 多个等待者会串号。本项目只用一次（等 `Page.loadEventFired`），但语义写死在这里。
 *
 * @param {string} wsUrl 形如 ws://127.0.0.1:PORT/devtools/page/XXXX
 * @param {{timeout?: number, WebSocketImpl?: Function, onClose?: (reason:string)=>void, allow?: string[]}} [options]
 * @returns {Promise<object>} client：`{ url, send, waitFor, close, closed, closeReason, pendingCount }`
 */
function attach(wsUrl, options) {
  const opt = options || {};
  const defaultTimeout = Math.max(1000, Number(opt.timeout) || DEFAULT_TIMEOUT_MS);
  const WS = opt.WebSocketImpl || (typeof globalThis !== 'undefined' ? globalThis.WebSocket : null);
  const url = String(wsUrl || '');

  /**
   * 白名单**只许收缩、不许扩张**（C-04，review-code P2）。
   *
   * 老实现 `opt.allow` 是**整体替换** `CDP_METHODS`：传一个 `['Network.enable']` 就等于
   * 把收口从这条路径上摘掉了 —— 「白名单在这一层收口」于是有了第二条绕过路径。
   * 现在：请求的每个方法都必须是 `CDP_METHODS` 的子集，**有一个越界就整体拒绝**（不是静默丢弃，
   * 静默丢弃会让调用方以为自己有权限，出错时报的是「通道关闭」而不是「方法被禁」）。
   */
  let allow = CDP_METHODS;
  if (Array.isArray(opt.allow) && opt.allow.length) {
    const requested = opt.allow.map((m) => String(m));
    const outside = requested.filter((m) => CDP_METHODS.indexOf(m) < 0);
    if (outside.length) {
      return Promise.reject(
        cdpError('CDP allow 只能收缩不能扩张（这些不白名单内）：' + outside.join(', '), 'CDP_FORBIDDEN')
      );
    }
    allow = requested;
  }

  if (!url) return Promise.reject(cdpError('CDP 地址为空', 'CDP_CONNECT'));
  if (typeof WS !== 'function') {
    return Promise.reject(
      cdpError('当前运行环境没有全局 WebSocket（需要 Node 22+ 或 Electron 主进程）', 'CDP_CONNECT')
    );
  }

  let socket;
  try {
    // 唯一一处建连（[A2-16] 第 2 条）：有注入实现就用注入的（测试），否则用运行时全局的。
    // 这一行是整个 electron/ 目录里唯一构造 WebSocket 的地方，别在别处再建连接。
    socket = opt.WebSocketImpl ? new opt.WebSocketImpl(url) : new WebSocket(url);
  } catch (e) {
    return Promise.reject(cdpError('创建 WebSocket 失败：' + ((e && e.message) || e), 'CDP_CONNECT'));
  }

  /** @type {Map<number, {resolve:Function, reject:Function, timer:any, method:string}>} */
  const pending = new Map();
  /** @type {Map<string, Array<{resolve:Function, reject:Function, timer:any}>>} */
  const waiters = new Map();
  let nextId = 0;
  let closed = false;
  let closeReason = '';

  function failAll(reason) {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(cdpError(item.method + ' 因通道关闭失败：' + reason, 'CDP_CLOSED'));
    }
    pending.clear();
    for (const [method, list] of waiters) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(cdpError('等待事件 ' + method + ' 时通道关闭：' + reason, 'CDP_CLOSED'));
      }
    }
    waiters.clear();
  }

  function markClosed(reason) {
    if (closed) return;
    closed = true;
    closeReason = String(reason || '');
    failAll(closeReason || 'closed');
    if (typeof opt.onClose === 'function') {
      try {
        opt.onClose(closeReason);
      } catch {
        /* 回调自己出错不影响收尾 */
      }
    }
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (msg.error) {
        item.reject(
          cdpError(
            item.method + ' 失败：' + (msg.error.message || '未知错误') + '（code ' + msg.error.code + '）',
            'CDP_ERROR',
            { cdpCode: msg.error.code, cdpData: msg.error.data }
          )
        );
      } else {
        item.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method) {
      const list = waiters.get(msg.method);
      if (list && list.length) {
        const one = list.shift(); // 单等待者语义
        if (!list.length) waiters.delete(msg.method);
        clearTimeout(one.timer);
        one.resolve(msg.params || {});
      }
    }
  }

  function send(method, params, timeoutMs) {
    const name = String(method || '');
    // 白名单收口：越界在发字节之前就拒绝（[A2-7]）
    if (allow.indexOf(name) < 0) {
      return Promise.reject(cdpError('CDP 方法不在点验白名单内：' + name, 'CDP_FORBIDDEN'));
    }
    if (closed) return Promise.reject(cdpError('CDP 通道已关闭：' + closeReason, 'CDP_CLOSED'));
    const wait = Math.max(500, Number(timeoutMs) || defaultTimeout);

    return new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(cdpError(name + ' 超时（' + wait + 'ms）', 'CDP_TIMEOUT'));
      }, wait);
      pending.set(id, { resolve, reject, timer, method: name });
      try {
        socket.send(JSON.stringify({ id, method: name, params: params || {} }));
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(cdpError(name + ' 发送失败：' + ((e && e.message) || e), 'CDP_CLOSED'));
      }
    });
  }

  /** 等一个 CDP 事件（本项目只用 `Page.loadEventFired`）；同一事件同时只允许 1 个等待者 */
  function waitFor(method, timeoutMs) {
    const name = String(method || '');
    if (closed) return Promise.reject(cdpError('CDP 通道已关闭：' + closeReason, 'CDP_CLOSED'));
    if (waiters.has(name) && waiters.get(name).length) {
      return Promise.reject(cdpError('同一事件已有等待者：' + name + '（单等待者语义）', 'CDP_BUSY'));
    }
    const wait = Math.max(200, Number(timeoutMs) || defaultTimeout);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = waiters.get(name) || [];
        const idx = list.findIndex((w) => w.timer === timer);
        if (idx >= 0) list.splice(idx, 1);
        if (!list.length) waiters.delete(name);
        reject(cdpError('等待事件 ' + name + ' 超时（' + wait + 'ms）', 'CDP_TIMEOUT'));
      }, wait);
      if (!waiters.has(name)) waiters.set(name, []);
      waiters.get(name).push({ resolve, reject, timer });
    });
  }

  function close() {
    if (closed) return;
    markClosed('客户端主动关闭');
    try {
      socket.close();
    } catch {
      /* 已经断了就算了 */
    }
  }

  const client = {
    url,
    get closed() {
      return closed;
    },
    get closeReason() {
      return closeReason;
    },
    get pendingCount() {
      return pending.size;
    },
    send,
    waitFor,
    close,
  };

  socket.addEventListener('message', (ev) => handleMessage(ev && ev.data));
  socket.addEventListener('error', (ev) => {
    markClosed('WebSocket 出错' + (ev && ev.message ? '：' + ev.message : ''));
  });
  socket.addEventListener('close', () => {
    markClosed('WebSocket 已断开');
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      markClosed('连接超时');
      reject(cdpError('连 CDP 超时（' + defaultTimeout + 'ms）', 'CDP_CONNECT'));
    }, defaultTimeout);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(cdpError('连 CDP 失败：' + url, 'CDP_CONNECT'));
    });
  });
}

/**
 * 关浏览器（stop 的 **L1** 降级，[A2-8] 的**唯一**例外路径）。
 *
 * `Browser.close` 属 Browser 域，页面端点发不出去 —— 必须用 browser 端点：
 * `ws://127.0.0.1:<port>` + `DevToolsActivePort` **第二行**（`/devtools/browser/<id>`）。
 * 而且**只允许发这一条命令、不 enable 任何域**。
 *
 * 注意上游结论：浏览器关自己时经常不回包、直接把 ws 断掉 —— 那不算失败。
 * 所以这里「没回包」也按已下发处理，最终是否真关掉由调用方的进程校验决定。
 *
 * @param {number} port
 * @param {string} browserWsPath DevToolsActivePort 第二行
 * @param {{timeout?: number, WebSocketImpl?: Function}} [opts]
 * @returns {Promise<{ok:boolean, maybe?:boolean, error?:string}>}
 */
async function closeBrowser(port, browserWsPath, opts) {
  const o = opts || {};
  const p = Number(port);
  const wsPath = String(browserWsPath || '');
  if (!Number.isInteger(p) || p <= 0 || !wsPath.startsWith('/devtools/browser/')) {
    return { ok: false, error: '没有可用的浏览器级调试地址' };
  }
  let client = null;
  try {
    client = await attach(`ws://127.0.0.1:${p}${wsPath}`, {
      timeout: Math.max(500, Number(o.timeout) || 2000),
      WebSocketImpl: o.WebSocketImpl,
      allow: ['Browser.close'],
    });
    await client.send('Browser.close', {}, Math.max(500, Number(o.timeout) || 2000));
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 浏览器关自己时通常不回包：按「可能已关闭」交给进程校验
    return { ok: true, maybe: true, error: msg };
  } finally {
    if (client) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  CDP_METHODS,
  PAGE_TARGET_RULES,
  isAllowedMethod,
  isClosedError,
  cdpError,
  pickPageTarget,
  originOf,
  discoverPageTarget,
  attach,
  closeBrowser,
};
