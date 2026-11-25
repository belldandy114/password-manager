import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  BINDING_PREFIX,
  INSTALL_FN_SRC,
  MAX_CANDIDATES,
  MAX_TEXT,
  STOP_FN_SRC,
  VALIDATE_FN_SRC,
  bindingName,
  sanitizePageException,
} from '../../../electron/record-inject.js';

/**
 * S2 · `electron/record-inject.js`：页内注入器（常量源码字符串）+ 候选算法 + 值脱敏。
 *
 * 测试方式：把**真实的注入器源码**放到 `node:vm` 里跑，配一个手写的假 DOM。
 * 这样测的是「交付出去的那段代码」本身，而不是在 node 里另写一份算法（避免两份定义漂移）。
 *
 * 两条安全判据：
 * - 候选/校验函数都是**常量源码**，外部输入只经参数传入（SEC-02）；
 * - 值只回长度/序号，载荷里连明文串的影子都没有（SEC-04 / `[C-119]` 第 2 款）。
 */

type El = {
  tagName: string;
  id: string;
  attrs: Record<string, string>;
  textContent: string;
  value?: string;
  type?: string;
  role?: string;
  selectedIndex?: number;
  isContentEditable?: boolean;
  parentElement: El | null;
  children: El[];
  getAttribute(name: string): string | null;
};

function makeEl(spec: Partial<El> & { tag: string; text?: string }): El {
  const el: El = {
    tagName: spec.tag.toUpperCase(),
    id: spec.id || '',
    attrs: spec.attrs || {},
    textContent: spec.text || '',
    value: spec.value,
    type: spec.type,
    role: spec.role,
    selectedIndex: spec.selectedIndex,
    isContentEditable: spec.isContentEditable,
    parentElement: null,
    children: [],
    getAttribute(name: string) {
      if (name === 'role') return (spec.role as string) || this.attrs.role || null;
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
  };
  for (const child of spec.children || []) {
    child.parentElement = el;
    el.children.push(child);
  }
  return el;
}

/** 假 DOM：选择器命中表由测试给定（注入器只拼选择器字符串、只数命中，不解析 CSS） */
function makePage(table: Record<string, El[]>, all: El[]) {
  const doc = {
    listeners: {} as Record<string, Array<(ev: unknown) => void>>,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    },
    querySelectorAll(selector: string): El[] {
      if (selector === '*') return all;
      if (table[selector]) return table[selector];
      // css-path 一定以 body 开头（本测试不解析 nth-of-type，只回「唯一命中」）
      if (/^body/.test(selector)) return [all[0]];
      return [];
    },
    evaluate(xpath: string) {
      return { snapshotLength: xpath === '//button' ? 3 : 0 };
    },
  };
  return doc;
}

const NONCE = 'a1b2c3d4e5f6';
const BINDING = `${BINDING_PREFIX}${NONCE}`;

describe('record-inject：注入器是常量源码（没有任何拼接位）', () => {
  it('三个源码字符串都不含模板占位、不含外部输入', () => {
    for (const src of [INSTALL_FN_SRC, STOP_FN_SRC, VALIDATE_FN_SRC]) {
      expect(typeof src).toBe('string');
      expect(src).not.toContain('${');
      expect(src.trim().startsWith('function')).toBe(true);
    }
  });

  it('binding 名 = __dsh_<nonce>，nonce 形状不对直接拒（[C-117] 第 4 条）', () => {
    expect(BINDING_PREFIX).toBe('__dsh_');
    expect(bindingName(NONCE)).toBe('__dsh_a1b2c3d4e5f6');
    for (const bad of ['', 'XYZ', 'a1b2c3d4e5f', 'a1b2c3d4e5f6a', 'a1b2c3d4e5fg', null, 12]) {
      expect(() => bindingName(bad as unknown as string), String(bad)).toThrow();
    }
  });

  it('常量：文本上限 80、候选上限 20（[C-114] 事件形状）', () => {
    expect(MAX_TEXT).toBe(80);
    expect(MAX_CANDIDATES).toBe(20);
  });
});

describe('record-inject：候选算法 golden（testid → id → role → text → css-path）', () => {
  /** 把真实注入器装进 vm 沙箱，返回 { payloads, doc, window, install } */
  function install(table: Record<string, El[]>, all: El[]) {
    const doc = makePage(table, all);
    const payloads: Array<Record<string, unknown>> = [];
    const win: Record<string, unknown> = {
      [BINDING]: (json: string) => payloads.push(JSON.parse(json) as Record<string, unknown>),
    };
    const sandbox = { window: win, document: doc, console };
    const installFn = vm.runInNewContext(`(${INSTALL_FN_SRC})`, sandbox) as (nonce: string) => { ok: boolean; reused?: boolean };
    const stopFn = vm.runInNewContext(`(${STOP_FN_SRC})`, sandbox) as () => { ok: boolean };
    const validateFn = vm.runInNewContext(`(${VALIDATE_FN_SRC})`, sandbox) as (
      strategy: string, selector: string,
    ) => { count: number; precise: boolean; invalid?: boolean; error?: string };
    const fire = (type: string, target: El, extra: Record<string, unknown> = {}) => {
      for (const fn of doc.listeners[type] || []) fn({ type, target, preventDefault() {}, ...extra });
    };
    return { doc, win, payloads, installFn, stopFn, validateFn, fire };
  }

  const PAGE = () => {
    const btn = makeEl({ tag: 'button', text: '登录', id: 'login', attrs: { 'data-testid': 'login-btn' }, role: 'button' });
    const btn2 = makeEl({ tag: 'button', text: '登录', role: 'button' });
    const form = makeEl({ tag: 'form', children: [btn, btn2] });
    const body = makeEl({ tag: 'body', children: [form] });
    const all = [body, form, btn, btn2];
    const table: Record<string, El[]> = {
      '[data-testid="login-btn"]': [btn],
      '#login': [btn],
      '[role="button"]': [btn, btn2],
    };
    return { btn, btn2, body, all, table };
  };

  it('点击 → 五类候选按 testid / id / role / text / css-path 顺序，带 count 与 precise', () => {
    const { btn, table, all } = PAGE();
    const h = install(table, all);
    h.installFn(NONCE);
    h.fire('click', btn);

    expect(h.payloads).toHaveLength(1);
    const event = h.payloads[0] as { action: string; target: { tag: string; role?: string; text?: string }; candidates: Array<Record<string, unknown>> };
    expect(event.action).toBe('click');
    expect(event.target).toMatchObject({ tag: 'button', role: 'button', text: '登录' });

    const cands = event.candidates;
    expect(cands).toHaveLength(5);
    expect(cands[0]).toEqual({ strategy: 'css', selector: '[data-testid="login-btn"]', count: 1, precise: true });
    expect(cands[1]).toEqual({ strategy: 'css', selector: '#login', count: 1, precise: true });
    expect(cands[2]).toEqual({ strategy: 'role', selector: '[role="button"]', count: 2, precise: false, roleName: 'button' });
    expect(cands[3]).toMatchObject({ strategy: 'text', selector: 'text=登录', count: 2, precise: false });
    expect(cands[4]).toMatchObject({ strategy: 'css', count: 1, precise: true });
    expect(String(cands[4].selector)).toMatch(/^body/);
  });

  it('候选里的属性值必须转义（引号 / 反斜杠不能把选择器拼坏）', () => {
    const evil = makeEl({ tag: 'div', text: 'x', attrs: { 'data-testid': 'a"b\\c' } });
    const body = makeEl({ tag: 'body', children: [evil] });
    const h = install({}, [body, evil]);
    h.installFn(NONCE);
    h.fire('click', evil);
    const first = (h.payloads[0] as { candidates: Array<{ selector: string }> }).candidates[0];
    expect(first.selector).toBe('[data-testid="a\\"b\\\\c"]');
  });

  it('没有 testid / id / role / 文本时只出 css-path（不造假候选）', () => {
    const blank = makeEl({ tag: 'div', text: '' });
    const body = makeEl({ tag: 'body', children: [blank] });
    const h = install({}, [body, blank]);
    h.installFn(NONCE);
    h.fire('click', blank);
    const cands = (h.payloads[0] as { candidates: Array<{ strategy: string }> }).candidates;
    expect(cands).toHaveLength(1);
    expect(cands[0].strategy).toBe('css');
  });

  it('长文本截断到 80 字并加省略号（target.text 上限）', () => {
    const long = '长'.repeat(200);
    const el = makeEl({ tag: 'span', text: long });
    const body = makeEl({ tag: 'body', children: [el] });
    const h = install({}, [body, el]);
    h.installFn(NONCE);
    h.fire('click', el);
    const target = (h.payloads[0] as { target: { text: string } }).target;
    expect(target.text.length).toBe(MAX_TEXT + 1);
    expect(target.text.endsWith('…')).toBe(true);
  });
});

describe('record-inject：值处理 —— 所有输入类控件只回 length（[C-119] 第 2 款）', () => {
  function pageWith(...els: El[]) {
    const body = makeEl({ tag: 'body', children: els });
    return { body, all: [body, ...els] };
  }

  function fireAndPayload(el: El, type = 'input', extra: Record<string, unknown> = {}) {
    const { body, all } = pageWith(el);
    const doc = makePage({}, all);
    const payloads: Array<Record<string, unknown>> = [];
    const win: Record<string, unknown> = { [BINDING]: (json: string) => payloads.push(JSON.parse(json)) };
    const sandbox = { window: win, document: doc, console };
    const installFn = vm.runInNewContext(`(${INSTALL_FN_SRC})`, sandbox) as (n: string) => unknown;
    installFn(NONCE);
    for (const fn of doc.listeners[type] || []) fn({ type, target: el, preventDefault() {}, ...extra });
    return { payload: payloads[0], raw: JSON.stringify(payloads[0] || {}), body };
  }

  /** 递归找有没有叫 value 的键（载荷里出现 value 即结构性违规） */
  function hasValueKey(node: unknown): boolean {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(hasValueKey);
    return Object.entries(node as Record<string, unknown>).some(([k, v]) => k === 'value' || hasValueKey(v));
  }

  it('密码框：只回 { length }，载荷里没有明文', () => {
    const pwd = makeEl({ tag: 'input', type: 'password', value: 'hunter2' });
    const { payload, raw } = fireAndPayload(pwd);
    expect((payload as { valueMeta: unknown }).valueMeta).toEqual({ length: 7, redacted: true });
    expect(raw).not.toContain('hunter2');
    expect(hasValueKey(payload)).toBe(false);
  });

  it('普通文本框同样只回 { length }（不按 type 分叉：手机号也不许进库）', () => {
    const text = makeEl({ tag: 'input', type: 'text', value: '13800138000' });
    const { payload, raw } = fireAndPayload(text);
    expect((payload as { valueMeta: unknown }).valueMeta).toEqual({ length: 11, redacted: true });
    expect(raw).not.toContain('13800138000');
  });

  it('textarea / contenteditable 也只回长度（文本一律不出页面）', () => {
    const ta = makeEl({ tag: 'textarea', value: 'secret note' });
    const a = fireAndPayload(ta);
    expect((a.payload as { valueMeta: unknown }).valueMeta).toEqual({ length: 11, redacted: true });
    expect(a.raw).not.toContain('secret note');

    const ce = makeEl({ tag: 'div', text: 'editable secret', isContentEditable: true });
    const b = fireAndPayload(ce);
    expect((b.payload as { valueMeta: unknown }).valueMeta).toEqual({ length: 15, redacted: true });
    expect(b.raw).not.toContain('editable secret');
  });

  it('select 只回选项序号，不回选项文本', () => {
    const select = makeEl({ tag: 'select', text: '是', selectedIndex: 1 });
    const { payload, raw } = fireAndPayload(select, 'change');
    expect((payload as { valueMeta: unknown }).valueMeta).toEqual({ selectedIndex: 1, redacted: true });
    expect(raw).not.toContain('是');
  });

  it('action 映射：click / fill / select / press', () => {
    expect((fireAndPayload(makeEl({ tag: 'button', text: 'b' }), 'click').payload as { action: string }).action).toBe('click');
    expect((fireAndPayload(makeEl({ tag: 'input', type: 'text', value: 'x' }), 'input').payload as { action: string }).action).toBe('fill');
    expect((fireAndPayload(makeEl({ tag: 'select', selectedIndex: 0 }), 'change').payload as { action: string }).action).toBe('select');
    expect((fireAndPayload(makeEl({ tag: 'input', value: 'x' }), 'keydown', { key: 'Enter' }).payload as { action: string }).action).toBe('press');
    // 非 Enter 的按键不产生事件（否则每敲一个字都记一步）
    expect(fireAndPayload(makeEl({ tag: 'input', value: 'x' }), 'keydown', { key: 'a' }).payload).toBeUndefined();
  });

  it('载荷只有约定键（action / target / candidates / valueMeta / ms），没有别的自由字段', () => {
    const { payload } = fireAndPayload(makeEl({ tag: 'input', type: 'password', value: 'p' }));
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual(['action', 'candidates', 'ms', 'target', 'valueMeta']);
    expect(typeof (payload as { ms: number }).ms).toBe('number');
  });
});

describe('record-inject：安装 / 幂等 / 卸载', () => {
  it('重复安装不重复挂监听（回 installed:true / replaced:true，永不回 reused）', () => {
    const el = makeEl({ tag: 'div', text: 'x' });
    const body = makeEl({ tag: 'body', children: [el] });
    const doc = makePage({}, [body, el]);
    const win: Record<string, unknown> = { [BINDING]: () => {} };
    const sandbox = { window: win, document: doc, console };
    const installFn = vm.runInNewContext(`(${INSTALL_FN_SRC})`, sandbox) as (n: string) => { ok: boolean; installed?: boolean; replaced?: boolean };
    const stopFn = vm.runInNewContext(`(${STOP_FN_SRC})`, sandbox) as () => { ok: boolean };

    const first = installFn(NONCE);
    expect(first.ok).toBe(true);
    expect(first.installed).toBe(true);
    expect(first.replaced).toBe(false);
    const clickCount = (doc.listeners.click || []).length;
    expect(clickCount).toBeGreaterThan(0);

    const second = installFn(NONCE);
    expect(second).toMatchObject({ ok: true, installed: true, replaced: true });
    expect((doc.listeners.click || []).length).toBe(clickCount); // 不叠加

    expect(stopFn().ok).toBe(true);
    expect((doc.listeners.click || []).length).toBe(0);
    expect(win.__dshRecorder).toBeUndefined();
    // 卸载后再装能重新挂上（不是一次性）
    expect(installFn(NONCE).ok).toBe(true);
    expect((doc.listeners.click || []).length).toBe(clickCount);
  });

  it('页面预置同名 __dshRecorder（含假 stop / 零监听）→ 强制覆盖，不许静默空转（SEC-R2-04）', () => {
    const el = makeEl({ tag: 'button', text: 'b' });
    const body = makeEl({ tag: 'body', children: [el] });
    const doc = makePage({}, [body, el]);
    const payloads: Array<Record<string, unknown>> = [];
    let plantedStopCalls = 0;
    const win: Record<string, unknown> = {
      [BINDING]: (json: string) => payloads.push(JSON.parse(json)),
      // 被录制页面在 install 之前就能种下这个公开固定名，让「安装成功但零监听」
      __dshRecorder: { stop: () => { plantedStopCalls += 1; }, fake: true },
    };
    const sandbox = { window: win, document: doc, console };
    const installFn = vm.runInNewContext(`(${INSTALL_FN_SRC})`, sandbox) as (n: string) => { ok: boolean; installed?: boolean; replaced?: boolean; reused?: boolean };

    const r = installFn(NONCE);
    expect(r.ok).toBe(true);
    expect(r.installed).toBe(true);      // 必须真的装了
    expect(r.replaced).toBe(true);       // 并显式告诉主进程「顶掉了页面预置的对象」
    expect(r.reused).toBeUndefined();    // 绝不回 reused（那会让 S3 以为一切正常）
    expect(plantedStopCalls).toBe(1);    // 先收拾掉页面预置的那个，避免残留监听

    // 真的挂上了：点一下必须出事件（空转的直接证据）
    for (const fn of doc.listeners.click || []) fn({ type: 'click', target: el, preventDefault() {} });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ action: 'click', target: { tag: 'button' } });
  });

  it('页内没有 binding 时安静跳过（不抛、不 console）', () => {
    const el = makeEl({ tag: 'button', text: 'b' });
    const body = makeEl({ tag: 'body', children: [el] });
    const doc = makePage({}, [body, el]);
    const sandbox = { window: {}, document: doc, console };
    const installFn = vm.runInNewContext(`(${INSTALL_FN_SRC})`, sandbox) as (n: string) => { ok: boolean };
    installFn(NONCE);
    expect(() => {
      for (const fn of doc.listeners.click || []) fn({ type: 'click', target: el, preventDefault() {} });
    }).not.toThrow();
  });
});

describe('record-inject：校验入口参数化（SEC-02，选择器绝不拼进表达式）', () => {
  function harness(selectorHits: Record<string, El[]>, all: El[]) {
    const doc = makePage(selectorHits, all);
    const sandbox = { window: {}, document: doc, console };
    const validateFn = vm.runInNewContext(`(${VALIDATE_FN_SRC})`, sandbox) as (
      strategy: string, selector: string,
    ) => { count: number; precise: boolean; invalid?: boolean; error?: string };
    return { validateFn, sandbox, doc };
  }

  it('注入载荷经参数传入：页内 window.__pwned 必须仍是 undefined', () => {
    const btn = makeEl({ tag: 'button', text: 'x' });
    const body = makeEl({ tag: 'body', children: [btn] });
    const { validateFn, sandbox } = harness({ '*': [body, btn] }, [body, btn]);

    const payload = "a'; (window.__pwned=1)//";
    const result = validateFn('css', payload);

    expect(result.count).toBe(0);
    expect(result.precise).toBe(false);
    expect((sandbox as { window: Record<string, unknown> }).window.__pwned).toBeUndefined();
    // 反证：源码里不含载荷，也不含任何可执行拼接点
    expect(VALIDATE_FN_SRC).not.toContain(payload);
    expect(VALIDATE_FN_SRC).not.toContain('__pwned');
    expect(VALIDATE_FN_SRC).not.toContain('eval(');
    expect(VALIDATE_FN_SRC).not.toContain('new Function');
  });

  it('css / role 走 querySelectorAll 计数，text 按文本扫，xpath 走 document.evaluate', () => {
    const btn = makeEl({ tag: 'button', text: '登录' });
    const btn2 = makeEl({ tag: 'button', text: '登录' });
    const body = makeEl({ tag: 'body', children: [btn, btn2] });
    const all = [body, btn, btn2];
    const { validateFn } = harness({ '[role="button"]': [btn, btn2], '#login': [btn] }, all);

    expect(validateFn('css', '#login')).toMatchObject({ count: 1, precise: true });
    expect(validateFn('role', '[role="button"]')).toMatchObject({ count: 2, precise: false });
    expect(validateFn('text', '登录')).toMatchObject({ count: 2, precise: false });
    expect(validateFn('xpath', '//button')).toMatchObject({ count: 3, precise: false });
  });

  it('选择器语法错 → invalid:true + 可读错误，不抛（[C-114] validate 的 invalid 位）', () => {
    const body = makeEl({ tag: 'body', children: [] });
    const doc = makePage({}, [body]);
    doc.querySelectorAll = () => { throw new SyntaxError('not a valid selector'); };
    const sandbox = { window: {}, document: doc, console };
    const validateFn = vm.runInNewContext(`(${VALIDATE_FN_SRC})`, sandbox) as (
      strategy: string, selector: string,
    ) => { count: number; precise: boolean; invalid?: boolean; error?: string };
    const r = validateFn('css', 'a[');
    expect(r).toMatchObject({ invalid: true, count: 0, precise: false });
    expect(typeof r.error).toBe('string');
  });
});

describe('record-inject：第二段安全评审的 S2 修复（SEC-R2）', () => {
  function pageWith(...els: El[]) {
    const body = makeEl({ tag: 'body', children: els });
    return { body, all: [body, ...els] };
  }

  function install(el: El) {
    const { body, all } = pageWith(el);
    const doc = makePage({}, all);
    const payloads: Array<Record<string, unknown>> = [];
    const win: Record<string, unknown> = { [BINDING]: (json: string) => payloads.push(JSON.parse(json)) };
    const sandbox = { window: win, document: doc, console };
    const installFn = vm.runInNewContext(`(${INSTALL_FN_SRC})`, sandbox) as (n: string) => { ok: boolean };
    installFn(NONCE);
    const fire = (type: string) => {
      for (const fn of doc.listeners[type] || []) fn({ type, target: el, preventDefault() {} });
    };
    return { payloads, fire, body };
  }

  it('上限只剩一份真源：页内 MAX_TEXT / MAX_CANDIDATES 由模块常量生成（SEC-R2-12）', () => {
    const text = /var MAX_TEXT = (\d+);/.exec(INSTALL_FN_SRC);
    const cands = /var MAX_CANDIDATES = (\d+);/.exec(INSTALL_FN_SRC);
    expect(text).toBeTruthy();
    expect(cands).toBeTruthy();
    expect(Number(text![1])).toBe(MAX_TEXT);
    expect(Number(cands![1])).toBe(MAX_CANDIDATES);
  });

  it('身份证 / 手机号 / 卡号形态的可见文本不得进 text= 候选，也不进 target.text（SEC-R2-14）', () => {
    const cases: Array<[string, string]> = [
      ['13800138000', '手机号'],
      ['110101199003074477', '身份证'],
      ['6222020200112345678', '银行卡'],
    ];
    for (const [text, label] of cases) {
      const el = makeEl({ tag: 'td', text });
      const h = install(el);
      h.fire('click');
      const payload = h.payloads[0] as { candidates: Array<{ strategy: string; selector: string }>; target: Record<string, unknown> };
      expect(payload.candidates.some((c) => c.strategy === 'text'), label).toBe(false);
      expect(JSON.stringify(payload.candidates), label).not.toContain(text);
      expect(payload.target.text, label).toBeUndefined();
      expect(JSON.stringify(payload), label).not.toContain(text);
    }
    // 对照：普通业务文本仍然出 text 候选与 target.text（不是一刀切）
    const normal = makeEl({ tag: 'button', text: '登录' });
    const h2 = install(normal);
    h2.fire('click');
    const p2 = h2.payloads[0] as { candidates: Array<{ strategy: string }>; target: { text?: string } };
    expect(p2.candidates.some((c) => c.strategy === 'text')).toBe(true);
    expect(p2.target.text).toBe('登录');
  });

  it('data-testid / role / tag 在页内就截断（SEC-R2-06：别让单条事件被放大）', () => {
    const el = makeEl({
      tag: 'section',
      text: '',
      role: 'r'.repeat(300),
      attrs: { 'data-testid': 't'.repeat(300) },
    });
    const h = install(el);
    h.fire('click');
    const payload = h.payloads[0] as {
      target: { tag: string; role?: string };
      candidates: Array<{ selector: string; roleName?: string }>;
    };
    expect(payload.target.tag.length).toBeLessThanOrEqual(64);
    expect(String(payload.target.role).length).toBeLessThanOrEqual(200);
    const testIdCandidate = payload.candidates.find((c) => c.selector.startsWith('[data-testid='));
    expect(testIdCandidate).toBeTruthy();
    expect(testIdCandidate!.selector.length).toBeLessThanOrEqual(220); // 200 + 包装字符
    expect(String(testIdCandidate!.roleName).length).toBeLessThanOrEqual(200);
  });

  it('页内异常只回 { name, length }，不回 160 字原文（SEC-R2-05）', () => {
    const shape = (input: unknown) => sanitizePageException(input);
    const msg = 'token=abc123';
    expect(shape(new Error(msg))).toEqual({ name: 'Error', length: msg.length });

    const quoted = "throw '手机号 13800138000'";
    expect(shape({ exception: { description: quoted } })).toEqual({ name: 'Error', length: quoted.length });

    const typed = 'TypeError: x is not a function';
    expect(shape({ exception: { className: 'TypeError', description: typed } }))
      .toEqual({ name: 'TypeError', length: typed.length });

    // 原文一律不出现
    const leaky = shape({ exception: { description: 'secret=13800138000' } });
    expect(JSON.stringify(leaky)).not.toContain('13800138000');
    expect(JSON.stringify(leaky)).not.toContain('secret');
    // 非字符串 / 怪异输入不抛，name 归一成 Error
    expect(shape(null)).toEqual({ name: 'Error', length: 0 });
    expect(shape({ exception: { className: '<script>', description: 42 } })).toEqual({ name: 'Error', length: 0 });
  });
});

