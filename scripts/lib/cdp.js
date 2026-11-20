'use strict';

/**
 * cdp.js —— Electron UI 回归脚本的 CDP（Chrome DevTools Protocol）公共库。
 *
 * 抽取动机：28 个 scripts/ui-*.js 各自复制了一份「连 WebSocket / 发号 / 等回包 / 求值 / 截图」，
 * 每份 40~90 行，改一次超时策略要改 28 遍；出错时有的脚本静默返回 undefined、有的直接卡死。
 * 这里只维护一份，并且**统一语义**：
 *   - 连窗口：listTargets / waitForTarget / attach
 *   - 求值：  session.ev(表达式)
 *   - 等待：  session.waitFor({selector} | {expr} | 字符串)
 *   - 截图：  session.shot(名字)
 *   - 关闭：  session.close()
 *   - 页面未捕获异常：session.errors（Runtime.exceptionThrown 收集，最多 160 字/条）
 *
 * 所有等待都有超时，超时抛 CdpTimeoutError，错误信息里写明「等的是什么 + 等了多久」，
 * 不再出现「脚本挂住但没有输出」。Node 18+ 自带 global fetch / WebSocket，本库不引第三方依赖。
 *
 * @module scripts/lib/cdp
 */

const fs = require('fs');
const path = require('path');

/** 默认超时（毫秒）：等窗口 / 等选择器 / 等表达式 / 单条 CDP 命令 */
const DEFAULT_TIMEOUT = 20000;
/** waitFor 的轮询间隔（毫秒） */
const POLL_INTERVAL = 200;
/** 页面未捕获异常保留的最大字符数（沿用既有脚本的口径） */
const EXCEPTION_TEXT_LIMIT = 160;

/** 统一的超时错误：message 里必须能看出「等什么、等多久」 */
class CdpTimeoutError extends Error {
  /**
   * @param {number} ms 超时的毫秒数
   * @param {string} what 被等待的对象描述（选择器 / 表达式 / CDP 方法名）
   */
  constructor(ms, what) {
    super(`超时（${ms}ms）：${what}`);
    this.name = 'CdpTimeoutError';
    this.timeoutMs = ms;
    this.what = what;
  }
}

/**
 * 睡一会儿
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 读 /json/list，返回调试目标列表。应用还没起来（端口未监听）时返回空数组，不抛错。
 * @param {number} port 远程调试端口
 * @returns {Promise<Array<{id?: string, type: string, title?: string, url: string, webSocketDebuggerUrl?: string}>>}
 */
async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 轮询直到出现满足条件的调试目标。
 * @param {number} port 远程调试端口
 * @param {(target: object) => boolean} [match] 过滤条件，默认「第一个非 devtools 的 page」
 * @param {{timeout?: number, interval?: number}} [opts] 超时与轮询间隔
 * @returns {Promise<object|null>} 找到就返回 target，超时返回 null（是否算错由调用方决定）
 */
async function waitForTarget(port, match, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const interval = opts.interval || POLL_INTERVAL;
  const pick = typeof match === 'function'
    ? match
    : (t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://');
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const target = (await listTargets(port)).find(pick);
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(interval);
  }
  return null;
}

/**
 * 把 waitFor 的入参归一成「要轮询的表达式 + 人类可读的描述」。
 * 规则（写死在这里，避免各脚本各猜一套）：
 *   - 对象 { selector } → document.querySelector 判存在
 *   - 对象 { expr }     → 表达式按真值判断
 *   - 字符串以 . # [ 开头，或形如 `tag` / `tag.class` → 当作 CSS 选择器
 *   - 其余字符串 → 当作 JS 表达式（例如 `!!document.querySelector('.pg')`）
 * @param {string|{selector?: string, expr?: string}} target 等待目标
 * @returns {{expr: string, desc: string}}
 */
function toWaitExpression(target) {
  if (target && typeof target === 'object') {
    if (target.selector) {
      return { expr: `(() => !!document.querySelector(${JSON.stringify(target.selector)}))()`, desc: `选择器 ${target.selector}` };
    }
    if (target.expr) return { expr: String(target.expr), desc: `表达式 ${String(target.expr).slice(0, 80)}` };
    throw new TypeError('waitFor 需要 { selector } 或 { expr }');
  }
  const text = String(target || '').trim();
  const looksLikeSelector = /^[.#[]/.test(text) || /^[a-zA-Z][\w-]*(\.[\w-]+)*$/.test(text);
  if (!text) throw new TypeError('waitFor 需要一个非空的选择器或表达式');
  return looksLikeSelector
    ? { expr: `(() => !!document.querySelector(${JSON.stringify(text)}))()`, desc: `选择器 ${text}` }
    : { expr: text, desc: `表达式 ${text.slice(0, 80)}` };
}

/**
 * 连上一个调试目标，返回会话对象。
 * @param {string|{webSocketDebuggerUrl: string, url?: string}} target 调试目标，或直接给 ws 地址
 * @param {{timeout?: number, shotDir?: string, onException?: (text: string) => void}} [opts]
 *   timeout: 单条 CDP 命令的默认超时；shotDir: 截图默认目录；onException: 页面异常回调（默认打印）
 * @returns {Promise<{
 *   url: string, wsUrl: string, errors: string[],
 *   send: (method: string, params?: object, opts?: {timeout?: number}) => Promise<any>,
 *   ev: (expr: string, opts?: {timeout?: number, throwOnException?: boolean}) => Promise<any>,
 *   waitFor: (target: string|{selector?: string, expr?: string}, opts?: {timeout?: number, interval?: number, throwOnTimeout?: boolean}) => Promise<boolean>,
 *   shot: (name: string, opts?: {dir?: string, timeout?: number}) => Promise<string>,
 *   close: () => void
 * }>} CDP 会话
 */
async function attach(target, opts = {}) {
  const wsUrl = typeof target === 'string' ? target : String(target && target.webSocketDebuggerUrl || '');
  if (!wsUrl) throw new Error('attach 失败：没有 webSocketDebuggerUrl（目标还没就绪？用 waitForTarget 先等）');
  const defaultTimeout = opts.timeout || DEFAULT_TIMEOUT;
  const shotDir = opts.shotDir || path.join(__dirname, '..', '.tmp-shots');
  const onException = typeof opts.onException === 'function'
    ? opts.onException
    : (text) => console.log('  EXC ' + text);
  const errors = [];

  const ws = new WebSocket(wsUrl);
  let seq = 0;
  /** @type {Map<number, (result: any, error?: Error) => void>} */
  const pending = new Map();

  const failAll = (reason) => {
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve(undefined, new Error(`CDP 连接不可用：${reason}`));
    }
  };
  ws.onclose = () => failAll('连接已关闭');
  ws.onerror = () => failAll('连接出错');

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) resolve(undefined, new Error(`CDP 错误 ${msg.error.code}：${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const text = String(msg.params && msg.params.exceptionDetails && msg.params.exceptionDetails.exception
        && msg.params.exceptionDetails.exception.description || '').slice(0, EXCEPTION_TEXT_LIMIT);
      errors.push(text);
      onException(text);
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpTimeoutError(defaultTimeout, `连接 CDP ${wsUrl}`)), defaultTimeout);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
  });

  /**
   * 发一条 CDP 命令（异常统一 reject，不返回半成品）
   * @param {string} method 例如 Runtime.evaluate
   * @param {object} [params] 命令参数
   * @param {{timeout?: number}} [callOpts] 单条命令超时
   * @returns {Promise<any>} 命令 result
   */
  const send = (method, params = {}, callOpts = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = callOpts.timeout || defaultTimeout;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CdpTimeoutError(timeout, `CDP ${method}`));
    }, timeout);
    pending.set(id, (result, error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });

  /**
   * 在页面里求值（awaitPromise + returnByValue），返回可 JSON 化的结果。
   * @param {string} expr JS 表达式
   * @param {{timeout?: number, throwOnException?: boolean}} [evalOpts]
   *   throwOnException=true 时页面异常直接抛错（需要「断言页面没报错」之外的严格场景用）
   * @returns {Promise<any>} 表达式结果
   */
  const ev = async (expr, evalOpts = {}) => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true },
      { timeout: evalOpts.timeout || defaultTimeout });
    if (res && res.exceptionDetails) {
      const text = String((res.exceptionDetails.exception && res.exceptionDetails.exception.description)
        || res.exceptionDetails.text || '').slice(0, 200);
      onException(text);
      if (evalOpts.throwOnException) throw new Error('页面求值异常：' + text);
      return undefined;
    }
    return res && res.result ? res.result.value : undefined;
  };

  /**
   * 轮询等待条件成立。
   * @param {string|{selector?: string, expr?: string}} target 选择器或表达式（判定规则见 toWaitExpression）
   * @param {{timeout?: number, interval?: number, throwOnTimeout?: boolean}} [waitOpts]
   *   throwOnTimeout 默认 true：超时抛 CdpTimeoutError；传 false 则返回 false 由调用方自己判。
   * @returns {Promise<boolean>} 成立返回 true
   */
  const waitFor = async (target, waitOpts = {}) => {
    const timeout = waitOpts.timeout || defaultTimeout;
    const interval = waitOpts.interval || POLL_INTERVAL;
    const throwOnTimeout = waitOpts.throwOnTimeout !== false;
    const { expr, desc } = toWaitExpression(target);
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await ev(expr)) return true;
      await sleep(interval);
    }
    if (throwOnTimeout) throw new CdpTimeoutError(timeout, desc);
    return false;
  };

  /**
   * 截 PNG 存盘（目录不存在会自动建）。
   * @param {string} name 文件名（自动补 .png）或绝对路径
   * @param {{dir?: string, timeout?: number}} [shotOpts] dir 默认用 attach 时的 shotDir
   * @returns {Promise<string>} 落盘的绝对路径
   */
  const shot = async (name, shotOpts = {}) => {
    const timeout = shotOpts.timeout || defaultTimeout;
    const res = await send('Page.captureScreenshot', { format: 'png' }, { timeout });
    if (!res || !res.data) throw new Error(`截图失败（${name}）：CDP 没有返回 data`);
    const dir = shotOpts.dir || shotDir;
    const file = path.isAbsolute(name) ? name : path.join(dir, name.endsWith('.png') ? name : name + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  };

  /** 关掉 WebSocket（幂等；失败不抛） */
  const close = () => {
    try { ws.close(); } catch { /* 忽略 */ }
  };

  await send('Runtime.enable');
  await send('Page.enable');

  return {
    url: typeof target === 'string' ? '' : String(target.url || ''),
    wsUrl,
    errors,
    send,
    ev,
    waitFor,
    shot,
    close,
  };
}

module.exports = {
  DEFAULT_TIMEOUT,
  POLL_INTERVAL,
  CdpTimeoutError,
  sleep,
  listTargets,
  waitForTarget,
  attach,
};
