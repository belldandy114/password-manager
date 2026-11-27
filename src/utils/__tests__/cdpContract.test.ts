import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  CDP_METHODS,
  PAGE_TARGET_RULES,
  attach,
  closeBrowser,
  discoverPageTarget,
  isAllowedMethod,
  pickPageTarget,
} from '../../../electron/cdp.js';

/**
 * 上游那份 CDP 库（`scripts/lib/cdp.js`，28 个 ui-*.js 回归脚本在用）。
 * 这里只**读/调**它，一行不改（本批不收敛两份库）。
 * 用 createRequire 是因为它是 CJS 且没有 .d.ts —— 只有真 require 进来，行为测试才是行为测试。
 */
const requireLegacy = createRequire(import.meta.url);
const legacyCdp = requireLegacy('../../../scripts/lib/cdp.js') as {
  waitForTarget: (
    port: number,
    match?: unknown,
    opts?: { timeout?: number; interval?: number }
  ) => Promise<{ id?: string; webSocketDebuggerUrl?: string } | null>;
};

/**
 * 元素库 A₂ · CDP 客户端的**收口面**（契约 [A2-7] 白名单 / [A2-8] 挑 target / [A2-16] 第 2 条）。
 *
 * 为什么单独一个测试文件：这个文件是「唯一能发字节的地方」，
 * 白名单一旦在这里漏了，其它所有层的自我约束都白写。
 * 另一半职责是**与 scripts/lib/cdp.js 的口径漂移门**（本仓库并存两份 CDP 库，队长裁定 Z-5）。
 */
describe('cdp · 方法白名单（[A2-7]：多一个即不通过）', () => {
  it('只允许 Runtime / Page / DOM / Overlay / Browser 五个域', () => {
    for (const m of CDP_METHODS) {
      expect(m).toMatch(/^(Runtime|Page|DOM|Overlay|Browser)\./);
    }
  });

  it('禁止清单里的域与方法一个都不许出现', () => {
    const joined = CDP_METHODS.join('|');
    for (const banned of [
      'Input.',
      'Storage.',
      'Network.',
      'Cookie.',
      'DOMStorage.',
      'Debugger.',
      'Fetch.',
      'Target.',
      'addScriptToEvaluateOnNewDocument',
      'captureScreenshot',
    ]) {
      expect(joined).not.toContain(banned);
    }
  });

  it('高亮走 Overlay，关浏览器走 Browser.close（各自都在表里）', () => {
    expect(CDP_METHODS).toContain('Overlay.highlightNode');
    expect(CDP_METHODS).toContain('Browser.close');
    expect(CDP_METHODS).toContain('Runtime.callFunctionOn');
    expect(isAllowedMethod('Overlay.highlightNode')).toBe(true);
    expect(isAllowedMethod('Input.dispatchMouseEvent')).toBe(false);
    expect(isAllowedMethod('')).toBe(false);
  });

  it('send() 在**发字节之前**就拒绝白名单外的方法（不是靠注释约束）', async () => {
    const sent: string[] = [];
    class FakeWS {
      url: string;
      private l: Record<string, Array<(ev?: unknown) => void>> = {};
      constructor(url: string) {
        this.url = url;
        setTimeout(() => this.emit('open'), 0);
      }
      addEventListener(n: string, fn: (ev?: unknown) => void) {
        (this.l[n] || (this.l[n] = [])).push(fn);
      }
      emit(n: string, ev?: unknown) {
        for (const fn of this.l[n] || []) fn(ev);
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.emit('close');
      }
    }
    const client = await attach('ws://127.0.0.1:1/devtools/page/X', {
      WebSocketImpl: FakeWS as unknown as never,
      timeout: 1000,
    });
    await expect(client.send('Network.enable')).rejects.toThrow(/白名单/);
    await expect(client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'x' })).rejects.toThrow(/白名单/);
    expect(sent.length).toBe(0); // 一个字都没发出去
    // 白名单内的照常发
    const pending = client.send('Overlay.enable', {}, 200).catch(() => 'timeout');
    expect(sent.length).toBe(1);
    await pending;
    client.close();
  });
});

describe('cdp · 挑 page target（[A2-8] 第 3 步）', () => {
  it('跳过非 page / devtools:// / 没有 ws 地址的条目', () => {
    const list = [
      { id: 'a', type: 'service_worker', url: 'https://x', webSocketDebuggerUrl: 'ws://a' },
      { id: 'b', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://b' },
      { id: 'c', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: '' },
      { id: 'd', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://d' },
      { id: 'e', type: 'page', url: 'https://other.example', webSocketDebuggerUrl: 'ws://e' },
    ];
    expect(pickPageTarget(list, 'https://example.com/')?.id).toBe('d');
    expect(pickPageTarget([], 'https://example.com/')).toBe(null);
    expect(pickPageTarget(null, 'https://example.com/')).toBe(null);
  });

  it('规则顺序数组：先 type、再 devtools 排除（顺序变了就是漂移）', () => {
    expect(PAGE_TARGET_RULES.length).toBe(3);
    expect(PAGE_TARGET_RULES[0]).toContain('page');
    expect(PAGE_TARGET_RULES[1]).toContain('devtools://');
    expect(PAGE_TARGET_RULES[2]).toContain('webSocketDebuggerUrl');
  });
});

describe('cdp · 与 scripts/lib/cdp.js 的口径漂移门（队长裁定 Z-5）', () => {
  const legacyPath = path.resolve(__dirname, '../../../scripts/lib/cdp.js');

  /**
   * AR-5（review-arch 的 P1）：这条门原来是**半耦合**——
   *   改 `PAGE_TARGET_RULES` 顺序会红（索引断言）、改 legacy 谓词会红（源码字面量断言），
   *   但把 `pickPageTarget` 的实现改成「永远返回第一个 page」也**不会红**（常量只被断言、不被执行）。
   * 而这条锁存在的唯一目的就是防「实现悄悄偏离上游」，所以下面补**行为等价**测试：
   * 同一份夹具同时喂给两份 picker，断言选出同一个 target。
   *
   * 做法：把 `globalThis.fetch` 临时替换成返回固定夹具的桩，再**真的调用**
   * `scripts/lib/cdp.js` 的 `waitForTarget`（它内部走 `listTargets()` → `fetch`），
   * 与 `electron/cdp.js` 的 `pickPageTarget` 对同一夹具的结果比较。legacy 一行不改。
   */
  async function legacyPick(fixtures: unknown[], timeout = 80): Promise<string | null> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => fixtures })) as unknown as typeof fetch;
    try {
      const t = await legacyCdp.waitForTarget(1, undefined, { timeout, interval: 10 });
      return t ? String(t.id || '') : null;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it('常量侧：规则常量相等（顺序受约束，实现由下面的行为测试锁）', () => {
    const src = fs.readFileSync(legacyPath, 'utf8');
    // scripts/lib/cdp.js 的默认 pick：type==='page' 且 url 不以 devtools:// 开头
    expect(src).toContain("t.type === 'page' && !String(t.url || '').startsWith('devtools://')");
    // 规则常量的顺序也受约束（顺序变了 = 上游语义变了，得重新评估）
    expect(PAGE_TARGET_RULES.length).toBe(3);
    expect(PAGE_TARGET_RULES[0]).toContain('page');
    expect(PAGE_TARGET_RULES[1]).toContain('devtools://');
    expect(PAGE_TARGET_RULES[2]).toContain('webSocketDebuggerUrl');
  });

  it('行为等价：同一夹具两份 picker 选出同一个 target（非 page / devtools 都被跳过）', async () => {
    const fixtures = [
      { id: 'a', type: 'service_worker', url: 'https://x', webSocketDebuggerUrl: 'ws://a' },
      { id: 'b', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://b' },
      { id: 'd', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://d' },
      { id: 'e', type: 'page', url: 'https://other.example', webSocketDebuggerUrl: 'ws://e' },
    ];
    expect(pickPageTarget(fixtures, 'https://example.com/')?.id).toBe('d');
    expect(await legacyPick(fixtures)).toBe('d');
  });

  it('行为等价：没有可用 page 时两边都是 null（不会瞎指一个）', async () => {
    const fixtures = [
      { id: 'a', type: 'service_worker', url: 'https://x', webSocketDebuggerUrl: 'ws://a' },
      { id: 'b', type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://b' },
    ];
    expect(pickPageTarget(fixtures, 'https://example.com/')).toBe(null);
    expect(await legacyPick(fixtures)).toBe(null);
    expect(pickPageTarget([], 'https://example.com/')).toBe(null);
  });

  /**
   * **第三条规则的语义差异（结论：以 electron 为准）**
   *
   * legacy `waitForTarget` 是「先 `.find(谓词)` 拿到**第一个** page，再要求它有 ws 地址」——
   * 首个 page 没有 `webSocketDebuggerUrl` 时，它**不会**去看后面的 page，而是轮询到超时返回 null
   * （调用方拿到的是「没找到窗口」，排查起来像环境问题）。
   * electron `pickPageTarget` 是「按规则**跳过**不合格项，继续找下一个」——首个 page 没 ws 就取下一个。
   *
   * 为什么以 electron 为准：A₂ 的浏览器是我们自己刚拉起的，首个 page 常常是 `about:blank`
   * / 尚未拿到 ws 的空标签；跳过它才是「找到能连的页面」的正确语义，也能避免把一次可恢复的
   * 中间态报成「没找到浏览器」（[A2-4]：没连上不许写成没命中）。
   * 这条差异**不改 legacy**（本批不收敛），只在测试里钉住 electron 的行为，并把差异记下来。
   */
  it('行为差异（已定案）：首个 page 缺 ws → electron 选下一个，legacy 等到超时返回 null', async () => {
    const fixtures = [
      { id: 'c', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: '' },
      { id: 'd', type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://d' },
    ];
    // electron：跳过没有 ws 的首个 page，取下一个 —— 这是本项目的契约行为
    expect(pickPageTarget(fixtures, 'https://example.com/')?.id).toBe('d');
    // legacy：.find 命中首个 page 后因缺 ws 永远不返回 → 超时 null（差异的实证，不是我们坏掉）
    expect(await legacyPick(fixtures, 60)).toBe(null);
  });

  it('两份库都只连 127.0.0.1 的调试端点', () => {
    const legacy = fs.readFileSync(legacyPath, 'utf8');
    expect(legacy).toContain('http://127.0.0.1:');
    const mine = fs.readFileSync(path.resolve(__dirname, '../../../electron/cdp.js'), 'utf8');
    expect(mine).toContain('http://127.0.0.1:');
    // electron/ 下只有这一个文件**真的请求** /json/list、也只有一个地方 new WebSocket(（[A2-16] 第 2 条）
    // 按「真的调用了」计数（注释里提到这个词不算，否则谁写一行说明就红了）
    const listCalls = mine
      .split('\n')
      .filter((l) => l.includes('/json/list') && l.includes('getJson(') && !l.trim().startsWith('*'));
    expect(listCalls.length).toBe(1);
    expect((mine.match(/new WebSocket\(/g) || []).length).toBe(1);
  });
});

describe('cdp · 关浏览器只走 browser 端点（[A2-8] 唯一例外）', () => {
  it('没有合法的 browser 端点路径 → 直接回 ok:false，不尝试连接', async () => {
    await expect(closeBrowser(0, '')).resolves.toEqual({ ok: false, error: '没有可用的浏览器级调试地址' });
    await expect(closeBrowser(5778, '/devtools/page/X')).resolves.toEqual({
      ok: false,
      error: '没有可用的浏览器级调试地址',
    });
  });
});

describe('cdp · C-04：白名单只能收缩不能扩张（opt.allow 不再是「整体替换」）', () => {
  class FakeWS {
    static sent: string[] = [];
    private l: Record<string, Array<(ev?: unknown) => void>> = {};
    constructor(_url: string) {
      setTimeout(() => this.emit('open'), 0);
    }
    addEventListener(n: string, fn: (ev?: unknown) => void) {
      (this.l[n] || (this.l[n] = [])).push(fn);
    }
    emit(n: string, ev?: unknown) {
      for (const fn of this.l[n] || []) fn(ev);
    }
    send(data: string) {
      FakeWS.sent.push(data);
    }
    close() {
      this.emit('close');
    }
  }

  it('请求里含白名单外的方法 → 整体拒绝，且一个字节都不发', async () => {
    FakeWS.sent = [];
    await expect(
      attach('ws://127.0.0.1:1/devtools/page/X', {
        WebSocketImpl: FakeWS as unknown as never,
        allow: ['Page.enable', 'Network.enable'],
        timeout: 500,
      })
    ).rejects.toThrow(/只能收缩/);
    expect(FakeWS.sent.length).toBe(0);
  });

  it('收缩到白名单子集是允许的（closeBrowser 的 Browser.close 就走这条）', async () => {
    FakeWS.sent = [];
    const client = await attach('ws://127.0.0.1:1/devtools/page/X', {
      WebSocketImpl: FakeWS as unknown as never,
      allow: ['Browser.close'],
      timeout: 500,
    });
    // 子集内的方法能发（这里只验不抛，事件回包由假 WS 负责）
    const pending = client.send('Browser.close', {}, 100).catch(() => 'timeout');
    expect(FakeWS.sent.length).toBe(1);
    await pending;
    // 收缩之后，白名单里但**没被允许**的方法也要被拒
    await expect(client.send('Page.enable')).rejects.toThrow(/白名单/);
    client.close();
  });
});

describe('cdp · SEC-03：page target 必须与目标地址同源（scheme+host+port 全等）', () => {
  const fixtures = [
    { id: 'x', type: 'page', url: 'https://example.com/other', webSocketDebuggerUrl: 'ws://x' },
    { id: 'y', type: 'page', url: 'https://evil.example/login', webSocketDebuggerUrl: 'ws://y' },
  ];

  it('同源命中：路径不同但 scheme+host+port 相同就算同源', () => {
    expect(pickPageTarget(fixtures, 'https://example.com/wanted')?.id).toBe('x');
    // 端口也算在内：默认端口与显式 443 视为同源
    expect(pickPageTarget(fixtures, 'https://example.com:443/wanted')?.id).toBe('x');
  });

  it('跨源拒：只有别的域名的标签时不选（不许挑一个再 Page.navigate）', () => {
    const crossOnly = [fixtures[1]];
    expect(pickPageTarget(crossOnly, 'https://example.com/wanted')).toBe(null);
    // 端口不同也算跨源
    expect(pickPageTarget([{ id: 'p', type: 'page', url: 'https://example.com:8443/', webSocketDebuggerUrl: 'ws://p' }], 'https://example.com/')).toBe(null);
  });

  it('无 URL 拒：没有期望地址就无法判同源 → 不选；discoverPageTarget 直接回 CDP_NO_EXPECTED_URL（不联网）', async () => {
    expect(pickPageTarget(fixtures)).toBe(null);
    expect(pickPageTarget(fixtures, '')).toBe(null);
    expect(pickPageTarget(fixtures, 'about:blank')).toBe(null);
    expect(pickPageTarget(fixtures, 'file:///C:/x.html')).toBe(null);
    // discoverPageTarget 在发请求之前就拒（不给「先连上再说」的机会）
    await expect(discoverPageTarget(1, { expectedUrl: '' })).resolves.toEqual({
      ok: false,
      error: '缺少目标地址，无法校验调试目标是否同源',
      code: 'CDP_NO_EXPECTED_URL',
    });
  });
});
