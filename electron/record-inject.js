'use strict';

/**
 * record-inject.js —— 录制域的**页内注入器**（源码字符串）+ 候选算法 + 值脱敏。
 *
 * 三个**常量**函数声明，经 `cdp-client` 的参数化入口送进页面（绝不字符串拼接）：
 *   - `INSTALL_FN_SRC`  `function (nonce)`：挂事件监听、装 `window.__dshRecorder`；
 *   - `STOP_FN_SRC`     `function ()`：卸载监听（幂等）；
 *   - `VALIDATE_FN_SRC` `function (strategy, selector)`：元素级校验（`record:validate` 的页内一半）。
 *
 * 三条硬约束：
 * 1. **选择器只经参数传入**（契约 `[C-114]` validate 条 / `review-sec` SEC-02）：
 *    三个源码里没有任何拼接外部输入的位点，`selector` 永远走 `Runtime.callFunctionOn` 的
 *    `arguments`。`VALIDATE_FN_SRC` 里连 `eval` / `new Function` 都没有（单测断言）。
 * 2. **所有输入类控件一律只回 `{ length }`**（契约 `[C-119]` 第 2 款 / SEC-04）：
 *    `input`（含 `type=password` / `text` / `number` …）、`textarea`、`contenteditable` **不按 type 分叉**；
 *    `select` 只回 `selectedIndex`（契约同款）。载荷里**永不出现 `value` 键**。
 *    ⚠️ 长度只能由页内算：读出文本后**立即丢弃、只把数字送出去**——退回「连读都不许读」的字面禁令，
 *    `contenteditable` 就只能回 `length: 0`，那是撒谎。
 * 3. **事件载荷不带 sessionId / seq**（那是主进程的事）：页内只回
 *    `{ action, target, candidates, valueMeta?, ms }`，主进程按 `[C-114]` 补 envelope 与 6 键裁剪。
 *
 * 为什么用字符串常量 + `vm` 单测：页内代码没法在 node 里 import，把它写成字符串常量、
 * 单测用 `node:vm` 跑**同一份源码**（配手写假 DOM），就不会出现「node 里一份、页面里另一份」的漂移。
 *
 * @module electron/record-inject
 */

/** binding 名前缀：`__dsh_<nonce>`，`nonce = sha256(sessionId).slice(0, 12)`（契约 `[C-117]` 第 4 条） */
const BINDING_PREFIX = '__dsh_';
/** 页内挂 `window.__dshRecorder` 的键 */
const SESSION_KEY = '__dshRecorder';
/**
 * 上限**唯一真源**：页内源码里的数字由这几个常量生成（`INSTALL_FN_SRC` 用模板替换），
 * 不再在模块常量与页内源码里各写一份（SEC-R2-12：改一处漏一处 = 上限名存实亡）。
 */
const MAX_TEXT = 80;
const MAX_CANDIDATES = 20;
const MAX_TESTID_LENGTH = 200;
const MAX_ROLE_LENGTH = 200;
const MAX_TAG_LENGTH = 64;
/** 页内载荷允许的键（主进程据此裁剪，多余键一律丢弃） */
const PAYLOAD_KEYS = ['action', 'target', 'candidates', 'valueMeta', 'ms'];
/** 校验支持的策略（契约 `[C-114]` `record:validate` 入参枚举） */
const VALIDATE_STRATEGIES = ['css', 'xpath', 'text', 'role'];
/** nonce 形状：sha256 十六进制的前 12 位 */
const NONCE_PATTERN = /^[0-9a-f]{12}$/;
/** 页内异常名字的白名单形状（只回名字，不回原文） */
const EXCEPTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * 页内异常载荷的**唯一形状**（SEC-R2-05）：只回 `{ name, length }`。
 *
 * 为什么不回原文：页面里 `throw new Error('token=' + token)` 会把表单值带进 `description`，
 * 一旦进 `errors[]` / `onException` / 审计 / 界面就等于落库。这里把「名字」（白名单正则）与
 * 「长度」（数字）送出，排障够用，内容不出页面。
 *
 * ⚠️ `electron/cdp-client.js` 目前仍回 160 字原文（t18 的 owner 面，本片不动）；
 * t18 接线时只需 `errors.push(...)` 换成 `sanitizePageException(details)`，形状以本函数为准。
 *
 * @param {unknown} input CDP 的 `exceptionDetails`、Error 实例或字符串
 * @returns {{name: string, length: number}}
 */
function sanitizePageException(input) {
  const details = input && typeof input === 'object' ? input : {};
  const exception = details.exception && typeof details.exception === 'object' ? details.exception : {};
  const rawName = typeof exception.className === 'string'
    ? exception.className
    : (typeof details.name === 'string' ? details.name : 'Error');
  const name = EXCEPTION_NAME_PATTERN.test(rawName) ? rawName : 'Error';
  const rawText = typeof exception.description === 'string'
    ? exception.description
    : (typeof details.text === 'string' ? details.text : (typeof details.message === 'string' ? details.message : ''));
  return { name, length: String(rawText).length };
}

/**
 * 拼页内 binding 名。nonce 形状不对直接抛（调用方传错就说明 sessionId 派生有问题）。
 * @param {string} nonce `sha256(sessionId).slice(0, 12)`，小写十六进制
 * @returns {string} 例如 `__dsh_a1b2c3d4e5f6`
 */
function bindingName(nonce) {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    throw new TypeError('bindingName 需要 12 位小写十六进制 nonce（sha256(sessionId).slice(0,12)）');
  }
  return BINDING_PREFIX + nonce;
}

/**
 * 注入器源码（常量）。
 *
 * 内部约定：`esc()` 只做 CSS 属性值转义；`countOf()` 失败按 0 命中（坏选择器不能把整条事件吞掉）；
 * `valueMetaOf()` 是唯一读输入值的位点，且**只返回长度 / 序号**。
 */
const PAGE_INSTALL_TEMPLATE = String.raw`function (nonce) {
  var KEY = '__dshRecorder';
  var MAX_TEXT = __MAX_TEXT__;
  var MAX_CANDIDATES = __MAX_CANDIDATES__;
  var MAX_TESTID = __MAX_TESTID__;
  var MAX_ROLE = __MAX_ROLE__;
  var MAX_TAG = __MAX_TAG__;
  var PII_PATTERNS = [/^\d{11,19}$/, /^\d{17}[\dXx]$/];
  var bind = window['__dsh_' + nonce];
  if (typeof bind !== 'function') {
    return { ok: false, error: '页内没有注入 binding，录制事件无法上报' };
  }
  // SEC-R2-04：window.__dshRecorder 是**公开固定名**，被录制页面能在 install 之前把它种上，
  // 让「安装成功但零监听」。所以：认得就顶掉，绝不回 reused（那会让主进程以为一切正常）。
  var replaced = false;
  var existing = window[KEY];
  if (existing) {
    replaced = true;
    try { if (typeof existing.stop === 'function') existing.stop(); } catch (e) { /* 页面自己写的 stop 可能抛 */ }
    try { delete window[KEY]; } catch (e) { window[KEY] = undefined; }
  }
  var startedAt = Date.now();

  function normalize(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }
  function textOf(el) {
    var t = normalize(el && el.textContent);
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t;
  }
  function isInputLike(el) {
    var tag = tagOf(el);
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return !!(el && el.isContentEditable);
  }
  // SEC-R2-14：展示型元素里的身份证 / 手机号 / 卡号**不许**变成定位器文本
  function isSensitiveText(text) {
    if (!text) return false;
    for (var i = 0; i < PII_PATTERNS.length; i += 1) {
      if (PII_PATTERNS[i].test(text)) return true;
    }
    return false;
  }
  // 只有「非输入类 + 非敏感文本」才允许把可见文本当定位器 / target.text
  function visibleTextOf(el) {
    if (isInputLike(el)) return '';
    var text = textOf(el);
    return isSensitiveText(text) ? '' : text;
  }
  function esc(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function tagOf(el) {
    return String((el && el.tagName) || '').toLowerCase().slice(0, MAX_TAG);
  }
  function safeList(selector) {
    try {
      var list = document.querySelectorAll(selector);
      return list ? list : [];
    } catch (e) {
      return [];
    }
  }
  function countOf(selector) {
    return safeList(selector).length;
  }
  function countText(text) {
    var all = safeList('*');
    var n = 0;
    for (var i = 0; i < all.length; i += 1) {
      if (textOf(all[i]) === text) n += 1;
    }
    return n;
  }
  function candidate(strategy, selector, count, roleName) {
    var item = { strategy: strategy, selector: selector, count: count, precise: count === 1 };
    if (roleName) item.roleName = roleName;
    return item;
  }
  function cssPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.tagName && tagOf(node) !== 'html' && depth < 12) {
      var tag = tagOf(node);
      var seg = tag;
      var parent = node.parentElement;
      if (parent && parent.children && parent.children.length > 1) {
        var sameTag = 0;
        var index = 0;
        for (var i = 0; i < parent.children.length; i += 1) {
          var sib = parent.children[i];
          if (tagOf(sib) === tag) {
            sameTag += 1;
            if (sib === node) index = sameTag;
          }
        }
        if (sameTag > 1) seg = tag + ':nth-of-type(' + index + ')';
      }
      parts.unshift(seg);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }
  function candidatesOf(el) {
    var out = [];
    var rawTestId = el && el.getAttribute ? el.getAttribute('data-testid') : null;
    // SEC-R2-06：页内就截断，别让单条事件被 5 MB 的 data-testid 放大
    var testId = rawTestId ? String(rawTestId).slice(0, MAX_TESTID) : '';
    if (testId) {
      var testSel = '[data-testid="' + esc(testId) + '"]';
      out.push(candidate('css', testSel, countOf(testSel)));
    }
    if (el && el.id && /^[A-Za-z_][\w-]*$/.test(el.id)) {
      out.push(candidate('css', '#' + el.id, countOf('#' + el.id)));
    }
    var rawRole = el && el.getAttribute ? el.getAttribute('role') : null;
    var role = rawRole ? String(rawRole).slice(0, MAX_ROLE) : '';
    if (role) {
      var roleSel = '[role="' + esc(role) + '"]';
      out.push(candidate('role', roleSel, countOf(roleSel), role));
    }
    // SEC-R2-14：输入类与「身份证/手机号/卡号形态」的可见文本都不许变成 text= 候选
    var text = visibleTextOf(el);
    if (text) {
      out.push(candidate('text', 'text=' + text, countText(text)));
    }
    var path = cssPath(el);
    if (path) {
      out.push(candidate('css', path, countOf(path)));
    }
    return out.slice(0, MAX_CANDIDATES);
  }
  function valueMetaOf(el) {
    var tag = tagOf(el);
    if (tag === 'select') {
      return { selectedIndex: Number(el && el.selectedIndex) || 0, redacted: true };
    }
    var raw = '';
    if (el && typeof el.value === 'string') {
      raw = el.value;
    } else if (el && el.isContentEditable) {
      raw = normalize(el.textContent);
    }
    return { length: raw.length, redacted: true };
  }
  function targetOf(el) {
    var target = { tag: tagOf(el) };
    var rawRole = el && el.getAttribute ? el.getAttribute('role') : null;
    if (rawRole) target.role = String(rawRole).slice(0, MAX_ROLE);
    // 输入类控件的 textContent 就是用户输入（contenteditable）或选项文本（select）——
    // 一律不进 target（SEC-04 的落点，值只经 valueMeta 回长度/序号）；
    // 展示型元素里的身份证/手机号/卡号形态文本同样不进（SEC-R2-14）。
    var text = visibleTextOf(el);
    if (text) target.text = text;
    return target;
  }
  function build(action, el) {
    var payload = {
      action: action,
      target: targetOf(el),
      candidates: candidatesOf(el),
      ms: Date.now() - startedAt
    };
    if (action === 'fill' || action === 'select') payload.valueMeta = valueMetaOf(el);
    return payload;
  }
  function report(action, ev) {
    try {
      var el = ev && ev.target;
      if (!el || !el.tagName) return;
      var payload = build(action, el);
      try { bind(JSON.stringify(payload)); } catch (e) { /* binding 调用失败不上抛 */ }
    } catch (e) { /* 页内异常绝不影响被测页面 */ }
  }
  function onClick(ev) { report('click', ev); }
  function onInput(ev) { report('fill', ev); }
  function onChange(ev) {
    var tag = String((ev && ev.target && ev.target.tagName) || '').toLowerCase();
    report(tag === 'select' ? 'select' : 'fill', ev);
  }
  function onKeydown(ev) {
    if (!ev || ev.key !== 'Enter') return;
    report('press', ev);
  }
  var handlers = { click: onClick, input: onInput, change: onChange, keydown: onKeydown };

  window[KEY] = {
    startedAt: startedAt,
    stop: function () {
      for (var type in handlers) {
        if (Object.prototype.hasOwnProperty.call(handlers, type) && document.removeEventListener) {
          document.removeEventListener(type, handlers[type], true);
        }
      }
      try { delete window[KEY]; } catch (e) { window[KEY] = undefined; }
    }
  };

  if (document.addEventListener) {
    for (var type in handlers) {
      if (Object.prototype.hasOwnProperty.call(handlers, type)) {
        document.addEventListener(type, handlers[type], true);
      }
    }
  }
  return { ok: true, installed: true, replaced: replaced };
}`;

/** 页内源码里由模块常量生成的占位（上限唯一真源，SEC-R2-12） */
const LIMIT_PLACEHOLDERS = {
  __MAX_TEXT__: MAX_TEXT,
  __MAX_CANDIDATES__: MAX_CANDIDATES,
  __MAX_TESTID__: MAX_TESTID_LENGTH,
  __MAX_ROLE__: MAX_ROLE_LENGTH,
  __MAX_TAG__: MAX_TAG_LENGTH,
};

/**
 * 注入器源码：由 `PAGE_INSTALL_TEMPLATE` + 模块常量生成。
 * 生成一次后就是**纯数字**的常量源码（不再含占位符，也不含 `${`），送进页面的仍是固定字符串。
 */
const INSTALL_FN_SRC = Object.keys(LIMIT_PLACEHOLDERS).reduce(
  (src, token) => src.split(token).join(String(LIMIT_PLACEHOLDERS[token])),
  PAGE_INSTALL_TEMPLATE,
);

/** 卸载器源码（常量）：`window.__dshRecorder.stop()`，幂等 */
const STOP_FN_SRC = String.raw`function () {
  var rec = window.__dshRecorder;
  if (!rec || typeof rec.stop !== 'function') { return { ok: false, error: '未安装录制器' }; }
  rec.stop();
  return { ok: true };
}`;

/**
 * 元素级校验源码（常量）。`strategy` / `selector` 都是**参数**，不是源码的一部分。
 * 返回 `{ count, precise }`；选择器/表达式坏掉时回 `{ invalid: true, error }`（契约 `[C-114]` 的 invalid 位）。
 */
const VALIDATE_FN_SRC = String.raw`function (strategy, selector) {
  var s = typeof selector === 'string' ? selector : '';
  function normalize(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }
  try {
    var count = 0;
    if (strategy === 'xpath') {
      if (typeof document.evaluate !== 'function') {
        return { count: 0, precise: false, invalid: true, error: '当前页面不支持 XPath' };
      }
      var snap = document.evaluate(s, document, null, 7, null);
      count = snap && typeof snap.snapshotLength === 'number' ? snap.snapshotLength : 0;
    } else if (strategy === 'text') {
      var all = document.querySelectorAll('*') || [];
      for (var i = 0; i < all.length; i += 1) {
        if (normalize(all[i] && all[i].textContent) === normalize(s)) count += 1;
      }
    } else {
      var list = document.querySelectorAll(s) || [];
      count = list.length;
    }
    return { count: count, precise: count === 1 };
  } catch (e) {
    return { count: 0, precise: false, invalid: true, error: '选择器语法错误' };
  }
}`;

module.exports = {
  BINDING_PREFIX,
  SESSION_KEY,
  MAX_TEXT,
  MAX_CANDIDATES,
  MAX_TESTID_LENGTH,
  MAX_ROLE_LENGTH,
  MAX_TAG_LENGTH,
  PAYLOAD_KEYS,
  VALIDATE_STRATEGIES,
  NONCE_PATTERN,
  PAGE_INSTALL_TEMPLATE,
  LIMIT_PLACEHOLDERS,
  INSTALL_FN_SRC,
  STOP_FN_SRC,
  VALIDATE_FN_SRC,
  bindingName,
  sanitizePageException,
};

