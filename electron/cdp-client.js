'use strict';

/**
 * cdp-client.js —— 录制域用的最小 CDP（Chrome DevTools Protocol）客户端。
 *
 * 来源：`scripts/lib/cdp.js` 的**子集迁入**（只取 connect / send / evaluate / waitFor / close），
 * 截图（`shot`）与回归专用部分（`listTargets` / `waitForTarget` / `toWaitExpression`）不迁——
 * 录制域从 `DevToolsActivePort` 直接拿 ws 地址（契约 `[C-117]` 第 1 条），不需要按端口扫目标。
 * `scripts/lib/cdp.js` 保留原样给 28 个回归脚本用，两者**语义差异只在本文件头部登记**：
 *   - 本文件**没有**任何「选择器 → JS 表达式」的拼接入口；
 *   - 需要按参数调用页内函数时只走 `callWithArgs(fnDeclaration, args)`（结构化参数）。
 *
 * 安全口径（契约 `[C-114]` validate 条 / `review-sec` SEC-02）：
 * **selector 绝不拼进 JS 表达式**。`callWithArgs` 的两跳固定为
 * `Runtime.evaluate({ expression: 'globalThis' })` + `Runtime.callFunctionOn({ objectId, functionDeclaration, arguments })`
 * ——`functionDeclaration` 是**常量**，外部输入只出现在 `arguments[].value` 里。
 *
 * 零新增依赖：只用运行时自带的 `WebSocket`（Node ≥ 22 / Electron 主进程都有）。
 *
 * @module electron/cdp-client
 */

const { sanitizePageException } = require('./record-inject');

/** 单条 CDP 命令的默认超时（与 scripts/lib/cdp.js 同量级，改慢改快都要动单测） */
const COMMAND_TIMEOUT_MS = 20000;
/** waitFor 的轮询间隔 */
const WAIT_POLL_MS = 200;
/** 参数化调用用的 objectGroup（便于一次性释放页内临时对象） */
const OBJECT_GROUP = 'record';
/** 目标发现的单次 HTTP 超时（`/json/list` 是本机回环请求，超过这个数就是浏览器没起来） */
const TARGET_DISCOVERY_TIMEOUT_MS = 5000;

/** 统一的超时错误：message 必须能看出「等什么、等多久」 */
class CdpTimeoutError extends Error {
  /**
   * @param {number} ms 超时的毫秒数
   * @param {string} what 被等待的对象描述（CDP 方法名 / 选择器 / 条件）
   */
  constructor(ms, what) {
    super(`超时（${ms}ms）：${what}`);
    this.name = 'CdpTimeoutError';
    this.timeoutMs = ms;
    this.what = what;
  }
}

/** 睡一会儿 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 编一条命令（纯函数，单测可 golden）。
 * @param {number} id 命令序号
 * @param {string} method CDP 方法名
 * @param {object} [params]
 * @returns {string} JSON 文本
 */
function encodeCommand(id, method, params, sessionId) {
  const message = { id, method, params: params || {} };
  // `Session.send` 形态（browser 端点 + `Target.attachToTarget({flatten:true})` 之后）
  if (sessionId) message.sessionId = String(sessionId);
  return JSON.stringify(message);
}

/**
 * 解一条消息（纯函数）。坏数据返回 `{ kind: 'invalid' }`，调用方静默丢弃。
 * @param {unknown} raw ws 收到的原始文本
 * @returns {{kind: 'response'|'event'|'invalid', id?: number|string, result?: unknown,
 *            error?: {code: number, message: string}|null, method?: string, params?: object}}
 */
function decodeMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return { kind: 'invalid' };
  }
  if (!msg || typeof msg !== 'object') return { kind: 'invalid' };
  if (typeof msg.method === 'string') return { kind: 'event', method: msg.method, params: msg.params || {} };
  if (typeof msg.id === 'number' || typeof msg.id === 'string') {
    if (msg.error) return { kind: 'response', id: msg.id, error: msg.error, result: undefined };
    return { kind: 'response', id: msg.id, error: null, result: msg.result };
  }
  return { kind: 'invalid' };
}

/**
 * 页内异常**只出 `{ name, length }`**（SEC-R2-05）。
 *
 * 唯一真源是 `electron/record-inject.js` 的 `sanitizePageException()`：页面里
 * `throw new Error('token=' + token)` 会把表单值带进 `exception.description`，一旦原样进
 * `errors[]` / `onException` / 抛出的 Error message，就会被 S3 拿去展示或落审计。
 */
function exceptionShape(details) {
  return sanitizePageException(details);
}

/** 排障用的一行摘要：`TypeError（42 字）` —— 只有类型与长度，没有任何原文 */
function exceptionSummary(shape) {
  return `${shape.name}（${shape.length} 字）`;
}

/**
 * `ws://…/devtools/browser/<id>` 是 **browser 端点**：它只提供 `Browser` / `Target` / `SystemInfo` 域，
 * `Runtime.enable` / `Page.enable` 这类 **page target 作用域**的方法在这里会回 `-32601`。
 */
function isBrowserEndpoint(wsUrl) {
  try {
    return new URL(String(wsUrl)).pathname.startsWith('/devtools/browser/');
  } catch {
    return false;
  }
}

/**
 * 目标发现（**cdp-client 的唯一职责**，契约 v20）：`GET http://127.0.0.1:<port>/json/list`。
 *
 * @param {number} port 来自 `<profile>/DevToolsActivePort` 的**第一行**
 * @param {{fetchImpl?: Function, discoveryTimeout?: number}} [opts]
 * @returns {Promise<Array<object>>} 调试目标列表（拿不到就抛可读错误）
 */
async function listTargets(port, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('目标发现失败：当前运行时不支持 fetch（需要 Node ≥ 18 或 Electron 主进程）');
  const timeout = opts.discoveryTimeout || TARGET_DISCOVERY_TIMEOUT_MS;
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: makeTimeoutSignal(timeout) });
  } catch (e) {
    throw new Error(`目标发现失败：GET /json/list 不可达（端口 ${port}）：${(e && e.message) || e}`);
  }
  if (!res || typeof res.json !== 'function') throw new Error('目标发现失败：/json/list 响应不是 JSON');
  let list;
  try {
    list = await res.json();
  } catch {
    throw new Error('目标发现失败：/json/list 返回内容无法解析');
  }
  return Array.isArray(list) ? list : [];
}

/** 取一个 AbortSignal（运行时没有 AbortSignal.timeout 时返回 undefined，不影响主流程） */
function makeTimeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  } catch { /* 忽略 */ }
  return undefined;
}

/** 从 `/json/list` 里挑可用的 **page target**：排除 devtools 自建页与没有 ws 地址的条目 */
function pickPageTarget(list) {
  return (Array.isArray(list) ? list : []).find((t) => t
    && t.type === 'page'
    && typeof t.webSocketDebuggerUrl === 'string'
    && t.webSocketDebuggerUrl
    && !String(t.url || '').startsWith('devtools://')) || null;
}

/**
 * 两步连接的第一步：拿到 page target 的 `webSocketDebuggerUrl`。
 * @param {{port: number, fetchImpl?: Function, discoveryTimeout?: number}} opts
 * @returns {Promise<{id?: string, type: string, url?: string, webSocketDebuggerUrl: string}>}
 */
async function resolvePageTarget(opts) {
  const port = Number(opts && opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`目标发现失败：端口不合法（${opts && opts.port}）`);
  }
  const list = await listTargets(port, opts);
  const target = pickPageTarget(list);
  if (!target) {
    throw new Error(`目标发现失败：/json/list 里没有可用的 page target（端口 ${port}，共 ${list.length} 个目标）`);
  }
  return target;
}

/**
 * 连一个 CDP 会话。**两条路，推荐第一条**：
 *
 * ① **两步连接（生产路径，照 `scripts/lib/cdp.js` 的成熟做法）**：
 *    调用方只给 `port`（来自 `<profile>/DevToolsActivePort` 的**第一行**）→ 本模块自己
 *    `GET http://127.0.0.1:<port>/json/list` → 取 **page target** 的 `webSocketDebuggerUrl`
 *    → 连它 → 再发 `Runtime.enable` / `Page.enable`。
 *    为什么不连 `DevToolsActivePort` 第二行那个 `ws://…/devtools/browser/<id>`：**browser 端点
 *    只有 `Browser` / `Target` / `SystemInfo` 域**，`Runtime.enable` / `Page.enable` 在那里会回
 *    `-32601`；旧实现在 browser 端点上直接 enable，真机必失败（t18 的 blocker，假 WS 服务掩盖了它）。
 *
 * ② **底层能力 `connect({ wsUrl })`**：给什么连什么。连到 **browser 端点**时本函数**不会**自动发
 *    page 作用域方法（`pageScoped === false`）；要用 page 作用域方法得先
 *    `Target.attachToTarget({ flatten: true })` 拿 `sessionId`，再 `send(method, params, { sessionId })`。
 *
 * **选的是 ①（`/json/list`），不做 attach 路线**：`/json/list` 是既有真源（28 个回归脚本在用）、
 * 一次 HTTP 就拿到 page 目标、不需要维护 sessionId 生命周期；attach 只是给未来「多 tab」留的口子。
 *
 * ⚠️ **目标发现是 cdp-client 的唯一职责**（契约 v20）：会话层只给 `port`，**不得**自己写
 * `/json/list`、不得自己拼 `ws://`、不得私有 attach——两处实现必然漂移。
 *
 * @param {{port?: number, wsUrl?: string, timeout?: number, discoveryTimeout?: number,
 *          fetchImpl?: Function, WebSocketImpl?: Function,
 *          onException?: (exception: {name: string, length: number}) => void}} opts
 * @returns {Promise<{
 *   wsUrl: string, targetId: string, pageScoped: boolean,
 *   errors: Array<{name: string, length: number}>,
 *   send: (method: string, params?: object, opts?: {timeout?: number, sessionId?: string}) => Promise<any>,
 *   evaluate: (expression: string, opts?: {timeout?: number, throwOnException?: boolean}) => Promise<any>,
 *   callFunctionOn: (objectId: string, fnDeclaration: string, args?: unknown[], opts?: {timeout?: number}) => Promise<any>,
 *   callWithArgs: (fnDeclaration: string, args?: unknown[], opts?: {timeout?: number}) => Promise<any>,
 *   waitFor: (spec: {fn: string, args?: unknown[], desc?: string, timeout?: number, interval?: number,
 *                    throwOnTimeout?: boolean}|string, opts?: object) => Promise<boolean>,
 *   close: () => void
 * }>}
 */
async function connect(opts = {}) {
  const hasPort = opts.port !== undefined && opts.port !== null && opts.port !== '';
  /** 目标发现（只在给了 port 时做；给了 port 就以 port 为准，忽略调用方塞的 wsUrl） */
  let target = null;
  let wsUrl = String(opts.wsUrl || '');
  if (hasPort) {
    target = await resolvePageTarget(opts);
    wsUrl = String(target.webSocketDebuggerUrl);
  }
  if (!wsUrl) throw new Error('connect 失败：需要 port（推荐）或 wsUrl');
  /** 连的是 browser 端点吗？是的话**绝不**自动发 page 作用域方法 */
  const pageScoped = !isBrowserEndpoint(wsUrl);
  const targetId = target && target.id ? String(target.id) : '';
  const defaultTimeout = opts.timeout || COMMAND_TIMEOUT_MS;
  const WebSocketImpl = opts.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (!WebSocketImpl) throw new Error('当前运行时不支持 WebSocket（需要 Node ≥ 22 或 Electron 主进程）');
  const onException = typeof opts.onException === 'function' ? opts.onException : () => {};

  const ws = new WebSocketImpl(wsUrl);
  /** 页面未捕获异常：**只出 `{ name, length }`**（SEC-R2-05，绝不带页面原文） */
  const errors = [];
  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  let seq = 0;
  let closed = false;

  const failAll = (reason) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(`CDP 连接不可用：${reason}`));
    }
  };

  const handleEvent = (decoded) => {
    if (decoded.method !== 'Runtime.exceptionThrown') return;
    const shape = exceptionShape(decoded.params && decoded.params.exceptionDetails);
    errors.push(shape);
    try { onException(shape); } catch { /* 回调自己炸了不影响连接 */ }
  };

  /** 记录一条页内异常，返回**排障摘要**（`TypeError（42 字）`，不含原文） */
  const noteException = (details) => {
    const shape = exceptionShape(details);
    errors.push(shape);
    try { onException(shape); } catch { /* 同上 */ }
    return exceptionSummary(shape);
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpTimeoutError(defaultTimeout, `连接 CDP ${wsUrl}`)), defaultTimeout);
    const onOpen = () => {
      clearTimeout(timer);
      ws.addEventListener('message', (event) => {
        const decoded = decodeMessage(event && event.data);
        if (decoded.kind === 'response') {
          const entry = pending.get(decoded.id);
          if (!entry) return;
          pending.delete(decoded.id);
          clearTimeout(entry.timer);
          if (decoded.error) entry.reject(new Error(`CDP 错误 ${decoded.error.code}：${decoded.error.message}`));
          else entry.resolve(decoded.result);
          return;
        }
        if (decoded.kind === 'event') handleEvent(decoded);
      });
      ws.addEventListener('close', () => failAll('连接已关闭'));
      ws.addEventListener('error', () => failAll('连接出错'));
      resolve();
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`连接 CDP 失败：${wsUrl}`));
    });
  });

  /**
   * 发一条 CDP 命令（异常统一 reject，不返回半成品）。
   * @param {string} method
   * @param {object} [params]
   * @param {{timeout?: number, sessionId?: string}} [callOpts]
   *   `sessionId`：browser 端点 + `Target.attachToTarget({ flatten:true })` 之后必须带，
   *   否则 page 作用域方法会回 `-32601`
   * @returns {Promise<any>} 命令 result
   */
  const send = (method, params = {}, callOpts = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error('CDP 连接不可用：连接已关闭'));
      return;
    }
    const id = ++seq;
    const timeout = callOpts.timeout || defaultTimeout;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CdpTimeoutError(timeout, `CDP ${method}`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(encodeCommand(id, method, params, callOpts.sessionId));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });

  /**
   * 在页面里求值。**只接受固定表达式**：需要外部输入时用 `callWithArgs`，
   * 禁止把 selector / 用户输入拼进 expression（SEC-02）。
   * @param {string} expression
   * @param {{timeout?: number, throwOnException?: boolean}} [evalOpts]
   * @returns {Promise<any>}
   */
  const evaluate = async (expression, evalOpts = {}) => {
    const res = await send('Runtime.evaluate', {
      expression: String(expression),
      awaitPromise: true,
      returnByValue: true,
    }, { timeout: evalOpts.timeout });
    if (res && res.exceptionDetails) {
      const summary = noteException(res.exceptionDetails);
      if (evalOpts.throwOnException) throw new Error('页面求值异常：' + summary);
      return undefined;
    }
    return res && res.result ? res.result.value : undefined;
  };

  /**
   * 在指定对象上调用一个**常量**函数声明，外部输入只经 `arguments`（结构化参数）。
   * @param {string} objectId 目标对象的 remote objectId
   * @param {string} fnDeclaration 函数声明源码（必须是常量，不得拼接外部输入）
   * @param {unknown[]} [args] 位置参数
   * @param {{timeout?: number}} [callOpts]
   * @returns {Promise<any>} returnByValue 解出来的值
   */
  const callFunctionOn = async (objectId, fnDeclaration, args = [], callOpts = {}) => {
    if (!objectId) throw new Error('callFunctionOn 失败：缺少 objectId');
    const res = await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: String(fnDeclaration),
      arguments: (args || []).map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      objectGroup: OBJECT_GROUP,
    }, { timeout: callOpts.timeout });
    if (res && res.exceptionDetails) {
      throw new Error('页面求值异常：' + noteException(res.exceptionDetails));
    }
    return res && res.result ? res.result.value : undefined;
  };

  /**
   * 参数化调用的唯一入口：先取 `globalThis` 的 objectId，再 `callFunctionOn`。
   * 两跳里 expression 都是常量 `'globalThis'`，外部输入只出现在 arguments。
   * @param {string} fnDeclaration
   * @param {unknown[]} [args]
   * @param {{timeout?: number}} [callOpts]
   * @returns {Promise<any>}
   */
  const callWithArgs = async (fnDeclaration, args = [], callOpts = {}) => {
    const global = await send('Runtime.evaluate', { expression: 'globalThis', objectGroup: OBJECT_GROUP }, { timeout: callOpts.timeout });
    const objectId = global && global.result && global.result.objectId;
    if (!objectId) throw new Error('取不到 globalThis 的 objectId，无法参数化调用');
    try {
      return await callFunctionOn(objectId, fnDeclaration, args, callOpts);
    } finally {
      // RA2-09：每轮都新取一个 globalThis 句柄，用完必须释放 objectGroup，
      // 否则 `waitFor` 每 200 ms 轮询一次，句柄在页内无限堆积（V8 heap 只增不减）。
      try {
        await send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }, { timeout: callOpts.timeout });
      } catch { /* 连接已断 / 页面已关：释放失败不该把已经拿到的结果变成异常 */ }
    }
  };

  /**
   * 轮询等待条件成立（参数化：条件函数是常量，参数走 `arguments`）。
   * @param {{fn: string, args?: unknown[], desc?: string, timeout?: number, interval?: number,
   *          throwOnTimeout?: boolean}|string} spec
   * @param {{timeout?: number, interval?: number, throwOnTimeout?: boolean}} [waitOpts]
   * @returns {Promise<boolean>} 成立返回 true；超时按 throwOnTimeout 抛或返回 false
   */
  const waitFor = async (spec, waitOpts = {}) => {
    const input = typeof spec === 'string' ? { fn: spec } : (spec || {});
    const timeout = waitOpts.timeout || input.timeout || defaultTimeout;
    const interval = waitOpts.interval || input.interval || WAIT_POLL_MS;
    const throwOnTimeout = (waitOpts.throwOnTimeout === undefined ? input.throwOnTimeout : waitOpts.throwOnTimeout) !== false;
    const desc = input.desc || '条件';
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const ok = await callWithArgs(input.fn, input.args || [], { timeout });
      if (ok) return true;
      await sleep(interval);
    }
    if (throwOnTimeout) throw new CdpTimeoutError(timeout, desc);
    return false;
  };

  /** 关连接（幂等；失败不抛）。关闭后所有 pending 立即 reject，绝不留悬挂 Promise */
  const close = () => {
    if (closed) return;
    closed = true;
    failAll('连接已关闭');
    try { ws.close(); } catch { /* 已断 */ }
  };

  // 只有在 **page target 端点**上才 enable：browser 端点上这两个方法会回 -32601（t18 blocker）
  if (pageScoped) {
    await send('Runtime.enable');
    await send('Page.enable');
  }

  return { wsUrl, targetId, pageScoped, errors, send, evaluate, callFunctionOn, callWithArgs, waitFor, close };
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  WAIT_POLL_MS,
  TARGET_DISCOVERY_TIMEOUT_MS,
  OBJECT_GROUP,
  CdpTimeoutError,
  sleep,
  encodeCommand,
  decodeMessage,
  isBrowserEndpoint,
  listTargets,
  pickPageTarget,
  resolvePageTarget,
  connect,
};
