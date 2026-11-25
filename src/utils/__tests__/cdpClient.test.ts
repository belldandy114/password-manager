import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { acceptKey, decodeFrames, encodeFrame, OPCODE } from '../../../electron/ws-frame';
import {
  COMMAND_TIMEOUT_MS,
  OBJECT_GROUP,
  CdpTimeoutError,
  connect,
  decodeMessage,
  encodeCommand,
} from '../../../electron/cdp-client.js';

/**
 * S2 · `electron/cdp-client.js`：从 `scripts/lib/cdp.js` 迁入的最小 CDP 客户端。
 *
 * 只保留 connect / send / evaluate / waitFor / close（截图与回归专用部分不迁）。
 * 单测**连本地假 WebSocket 服务**（`node:http` + 仓库自带 `ws-frame` 编解码，零新增依赖），
 * 不连真 Chrome、不开真端口之外的任何东西。
 */

type Cmd = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
type Handler = (cmd: Cmd, push: (msg: unknown) => void) => unknown;

/**
 * page target 作用域的方法（连 browser 端点时必须带 sessionId 才能用）。
 * 真 Chrome 在 browser 端点上对这些方法会回 `-32601 'X' wasn't found` —— 假服务必须照做，
 * 否则「连错端点」这一整类 bug 会被假绿掩盖（t18 的 blocker 就是这么漏过去的）。
 */
const PAGE_SCOPED = new Set([
  'Runtime.enable',
  'Runtime.disable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.addBinding',
  'Runtime.releaseObjectGroup',
  'Page.enable',
  'Page.navigate',
  'Page.captureScreenshot',
]);

/**
 * 起一个假 CDP 服务：**HTTP `/json/list` + 两种 WebSocket 端点**（`/devtools/page/...` 与
 * `/devtools/browser/...`），并实现「browser 端点 + page 作用域方法 + 无 sessionId → error」这条真实语义。
 */
async function startFakeCdp(
  handler: Handler,
  opts: { endpoint?: 'page' | 'browser'; targets?: unknown[] } = {},
) {
  const received: Cmd[] = [];
  const httpRequests: string[] = [];
  const sockets: Array<{ destroy: () => void }> = [];
  const endpoint = opts.endpoint ?? 'page';
  let listeningPort = 0;

  const listPayload = () => opts.targets ?? [
    {
      id: 'BROWSER',
      type: 'other',
      url: 'devtools://devtools/bundled/inspector.html',
      webSocketDebuggerUrl: `ws://127.0.0.1:${listeningPort}/devtools/browser/ROOT`,
    },
    {
      id: 'PAGE-1',
      type: 'page',
      url: 'https://example.com/',
      webSocketDebuggerUrl: `ws://127.0.0.1:${listeningPort}/devtools/page/PAGE-1`,
    },
  ];

  const server = http.createServer((req, res) => {
    httpRequests.push(String(req.url || ''));
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listPayload()));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  server.on('upgrade', (req, socket) => {
    sockets.push(socket as unknown as { destroy: () => void });
    const isBrowserEndpoint = String(req.url || '').includes('/devtools/browser/');
    const key = String((req.headers as Record<string, unknown>)['sec-websocket-key'] || '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const push = (msg: unknown) => {
      try {
        socket.write(encodeFrame({ payload: JSON.stringify(msg), mask: false }));
      } catch { /* 连接已断 */ }
    };
    let buf: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest as Buffer;
      for (const frame of frames) {
        if (frame.opcode !== OPCODE.TEXT) continue;
        const cmd = JSON.parse(frame.payload.toString('utf8')) as Cmd;
        received.push(cmd);
        // 真 Chrome 语义：browser 端点上的 page 作用域方法必须带 sessionId
        if (isBrowserEndpoint && PAGE_SCOPED.has(String(cmd.method)) && !cmd.sessionId) {
          push({ id: cmd.id, error: { code: -32601, message: `'${cmd.method}' wasn't found` } });
          continue;
        }
        const reply = handler(cmd, push);
        if (reply === undefined || reply === null) continue;
        for (const msg of Array.isArray(reply) ? reply : [reply]) push(msg);
      }
    });
    socket.on('error', () => { /* 客户端主动断开 */ });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  listeningPort = address.port;
  return {
    port: address.port,
    pageWsUrl: `ws://127.0.0.1:${address.port}/devtools/page/PAGE-1`,
    browserWsUrl: `ws://127.0.0.1:${address.port}/devtools/browser/ROOT`,
    wsUrl: `ws://127.0.0.1:${address.port}${endpoint === 'browser' ? '/devtools/browser/ROOT' : '/devtools/page/PAGE-1'}`,
    received,
    httpRequests,
    close: async () => {
      for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 假服务默认应答：握手期的 enable 与「未知命令」都回空对象 */
const baseHandler: Handler = (cmd) => {
  if (cmd.method === 'Runtime.enable' || cmd.method === 'Page.enable') return { id: cmd.id, result: {} };
  return { id: cmd.id, result: {} };
};

describe('cdp-client：纯编解码（可单独 golden，不碰网络）', () => {
  it('encodeCommand 产出 {id, method, params}', () => {
    expect(JSON.parse(encodeCommand(7, 'Runtime.evaluate', { expression: '1' }))).toEqual({
      id: 7,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
    });
  });

  it('decodeMessage 区分 response / event / 坏数据', () => {
    expect(decodeMessage(JSON.stringify({ id: 3, result: { ok: 1 } }))).toMatchObject({ kind: 'response', id: 3 });
    expect(decodeMessage(JSON.stringify({ id: 4, error: { code: -32000, message: 'nope' } })))
      .toMatchObject({ kind: 'response', id: 4, error: { code: -32000 } });
    expect(decodeMessage(JSON.stringify({ method: 'Runtime.exceptionThrown', params: { a: 1 } })))
      .toMatchObject({ kind: 'event', method: 'Runtime.exceptionThrown' });
    expect(decodeMessage('not json')).toMatchObject({ kind: 'invalid' });
    expect(decodeMessage(JSON.stringify({ whatever: true }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('cdp-client：连本地假 WS 服务', () => {
  it('connect 后 send 能收到对应 id 的 result', async () => {
    const srv = await startFakeCdp((cmd) => (cmd.method === 'Browser.getVersion'
      ? { id: cmd.id, result: { product: 'Chrome/test' } }
      : baseHandler(cmd, () => {})));
    try {
      const session = await connect({ wsUrl: srv.wsUrl });
      const res = await session.send('Browser.getVersion');
      expect(res).toEqual({ product: 'Chrome/test' });
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('页面未捕获异常进 session.errors，并回调 onException（只出 {name,length}，SEC-R2-05）', async () => {
    const seen: Array<{ name: string; length: number }> = [];
    const desc = '页面炸了：TypeError secret-token=abc123';
    const srv = await startFakeCdp((cmd, push) => {
      if (cmd.method === 'Runtime.enable') {
        push({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exception: { className: 'TypeError', description: desc } } } });
        return { id: cmd.id, result: {} };
      }
      return baseHandler(cmd, push);
    });
    try {
      const session = await connect({ wsUrl: srv.wsUrl, onException: (e) => seen.push(e) });
      await new Promise((r) => setTimeout(r, 50));
      expect(session.errors).toEqual([{ name: 'TypeError', length: desc.length }]);
      expect(seen).toEqual([{ name: 'TypeError', length: desc.length }]);
      expect(JSON.stringify(seen)).not.toContain('secret-token');
      expect(JSON.stringify(seen)).not.toContain('页面炸了');
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('callWithArgs：两跳（globalThis → callFunctionOn），选择器只在 arguments 里（SEC-02）', async () => {
    const srv = await startFakeCdp((cmd) => {
      if (cmd.method === 'Runtime.evaluate') return { id: cmd.id, result: { result: { objectId: 'obj-1', type: 'object' } } };
      if (cmd.method === 'Runtime.callFunctionOn') return { id: cmd.id, result: { result: { value: { count: 0, precise: false } } } };
      return baseHandler(cmd, () => {});
    });
    try {
      const session = await connect({ wsUrl: srv.wsUrl });
      const payload = "a'; (window.__pwned=1)//";
      const value = await session.callWithArgs('function (sel) { return { count: 0, precise: false }; }', [payload]);
      expect(value).toEqual({ count: 0, precise: false });

      const call = srv.received.find((c) => c.method === 'Runtime.callFunctionOn');
      expect(call).toBeTruthy();
      const params = call!.params as Record<string, unknown>;
      expect(params.objectId).toBe('obj-1');
      // 结构化参数：载荷只出现在 arguments[0].value
      expect(params.arguments).toEqual([{ value: payload }]);
      // 函数声明是常量，绝不包含载荷（拼进表达式就是页内任意 JS）
      expect(String(params.functionDeclaration)).not.toContain(payload);
      expect(String(params.functionDeclaration)).not.toContain('__pwned');
      // 任何发出去的表达式里也不许有载荷
      for (const cmd of srv.received) {
        expect(JSON.stringify(cmd.params && cmd.params.expression ? cmd.params.expression : '')).not.toContain(payload);
      }
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('evaluate 走 returnByValue；页面异常记 errors 并返回 undefined', async () => {
    const srv = await startFakeCdp((cmd) => {
      if (cmd.method === 'Runtime.evaluate') {
        const expr = String((cmd.params as Record<string, unknown>).expression);
        if (expr === 'boom') return { id: cmd.id, result: { exceptionDetails: { exception: { description: 'boom!' } } } };
        return { id: cmd.id, result: { result: { value: 42 } } };
      }
      return baseHandler(cmd, () => {});
    });
    try {
      const session = await connect({ wsUrl: srv.wsUrl });
      expect(await session.evaluate('1+1')).toBe(42);
      expect(await session.evaluate('boom')).toBeUndefined();
      expect(session.errors.length).toBe(1);
      expect(session.errors[0]).toEqual({ name: 'Error', length: 'boom!'.length });
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('waitFor 是参数化的：轮询到真值才返回', async () => {
    let calls = 0;
    const srv = await startFakeCdp((cmd) => {
      if (cmd.method === 'Runtime.evaluate') return { id: cmd.id, result: { result: { objectId: 'obj-1' } } };
      if (cmd.method === 'Runtime.callFunctionOn') {
        calls += 1;
        return { id: cmd.id, result: { result: { value: calls >= 2 } } };
      }
      return baseHandler(cmd, () => {});
    });
    try {
      const session = await connect({ wsUrl: srv.wsUrl });
      await session.waitFor({ fn: 'function () { return true; }', desc: '等条件成立', interval: 10, timeout: 2000 });
      expect(calls).toBeGreaterThanOrEqual(2);
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('超时抛 CdpTimeoutError（文案含「超时」+ 毫秒 + 方法名）', async () => {
    const srv = await startFakeCdp((cmd, push) => (cmd.method === 'Slow.method' ? null : baseHandler(cmd, push)));
    try {
      const session = await connect({ wsUrl: srv.wsUrl });
      await expect(session.send('Slow.method', {}, { timeout: 120 })).rejects.toBeInstanceOf(CdpTimeoutError);
      await session.send('Slow.method', {}, { timeout: 120 }).catch((e: Error) => {
        expect(e.message).toContain('超时');
        expect(e.message).toContain('120');
        expect(e.message).toContain('Slow.method');
      });
      expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('close 幂等；关闭后 send 立刻 reject 而不是挂死', async () => {
    const srv = await startFakeCdp(baseHandler);
    try {
      const session = await connect({ wsUrl: srv.wsUrl });
      session.close();
      session.close();
      await expect(session.send('Runtime.evaluate', { expression: '1' }, { timeout: 300 })).rejects.toBeTruthy();
    } finally {
      await srv.close();
    }
  });

  it('服务端断开时所有 pending 都被 reject（不许留悬挂 Promise）', async () => {
    const srv = await startFakeCdp((cmd, push) => (cmd.method === 'Hang.method' ? null : baseHandler(cmd, push)));
    const session = await connect({ wsUrl: srv.wsUrl });
    const pending = session.send('Hang.method', {}, { timeout: 5000 });
    await srv.close();
    await expect(pending).rejects.toBeTruthy();
  });

  it('连不上时给出可读错误（不是挂住）', async () => {
    await expect(connect({ wsUrl: 'ws://127.0.0.1:1/devtools/browser/none', timeout: 300 })).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------- t18：两歩连接 + 端点语义 + 异常脱敏

describe('cdp-client：两歩连接（/json/list → page target → 再 enable）', () => {
  it('connect({ port }) 自己发现 page target，只在它上面 enable（不碰 browser 端点）', async () => {
    const srv = await startFakeCdp(baseHandler);
    try {
      const session = await connect({ port: srv.port });
      expect(srv.httpRequests).toContain('/json/list');
      expect(session.wsUrl).toBe(srv.pageWsUrl);        // 连的是 page target，不是 browser 端点
      expect(session.targetId).toBe('PAGE-1');
      expect(srv.received.map((c) => c.method)).toEqual(['Runtime.enable', 'Page.enable']);
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('/json/list 里没有 page target → 可读错误（绝不应降级去连 browser 端点）', async () => {
    const srv = await startFakeCdp(baseHandler, {
      targets: [{ id: 'BROWSER', type: 'other', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/ROOT' }],
    });
    try {
      await expect(connect({ port: srv.port })).rejects.toThrow(/page target/);
      expect(srv.received).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });
});

describe('cdp-client：browser 端点不得发 page 作用域方法', () => {
  it('connect({ wsUrl: browser 端点 }) 不自动 enable；显式 Page.enable 必须失败', async () => {
    const srv = await startFakeCdp(baseHandler, { endpoint: 'browser' });
    try {
      const session = await connect({ wsUrl: srv.browserWsUrl });
      // 一个 page 作用域方法都不许自动发（旧实现就是死在这里）
      expect(srv.received).toHaveLength(0);
      expect(session.pageScoped).toBe(false);
      await expect(session.send('Page.enable')).rejects.toThrow(/CDP 错误 -32601/);
      session.close();
    } finally {
      await srv.close();
    }
  });

  it('带 sessionId 时（Target.attachToTarget flatten 路线）page 作用域方法可以透传', async () => {
    const srv = await startFakeCdp(baseHandler, { endpoint: 'browser' });
    try {
      const session = await connect({ wsUrl: srv.browserWsUrl });
      const ok = await session.send('Page.enable', {}, { sessionId: 'SESS-1' });
      expect(ok).toEqual({});
      expect(srv.received[0]).toMatchObject({ method: 'Page.enable', sessionId: 'SESS-1' });
      session.close();
    } finally {
      await srv.close();
    }
  });
});

describe('cdp-client：页内异常三处出口都只出 {name,length}（SEC-R2-05）', () => {
  it('errors / onException / 抛出的 Error message 都检索不到原文', async () => {
    const seen: unknown[] = [];
    const secret = 'secret-token=abc123';
    const srv = await startFakeCdp((cmd) => {
      if (cmd.method === 'Runtime.evaluate') {
        return { id: cmd.id, result: { exceptionDetails: { exception: { className: 'TypeError', description: `TypeError: ${secret}` } } } };
      }
      return baseHandler(cmd, () => {});
    });
    try {
      const session = await connect({ wsUrl: srv.pageWsUrl, onException: (e) => seen.push(e) });
      // ③ 抛出路径：message 里只许出现「类型 + 长度」
      const err = await session.evaluate('boom', { throwOnException: true }).catch((e: Error) => e);
      expect(String((err as Error).message)).toMatch(/TypeError（\d+ 字）/);
      expect(String((err as Error).message)).not.toContain(secret);
      // ① errors[] 与 ② onException 同形状
      expect(session.errors).toHaveLength(1);
      expect(session.errors[0]).toEqual({ name: 'TypeError', length: `TypeError: ${secret}`.length });
      expect(seen).toEqual(session.errors);
      expect(JSON.stringify(session.errors)).not.toContain(secret);
      expect(JSON.stringify(seen)).not.toContain(secret);
      session.close();
    } finally {
      await srv.close();
    }
  });
});

describe('cdp-client：callWithArgs 的句柄必须释放（RA2-09 泄漏）', () => {
  it('每次调用后都发 Runtime.releaseObjectGroup，且不沿用旧 objectId；失败路径也释放', async () => {
    const seenIds: string[] = [];
    const srv = await startFakeCdp((cmd) => {
      if (cmd.method === 'Runtime.evaluate') {
        return { id: cmd.id, result: { result: { objectId: 'obj-1', type: 'object' } } };
      }
      if (cmd.method === 'Runtime.callFunctionOn') {
        seenIds.push(String(cmd.params && cmd.params.objectId));
        // 第 4 次让它抛页内异常，验证 finally 里也释放
        if (seenIds.length === 4) {
          return { id: cmd.id, result: { exceptionDetails: { exception: { className: 'Error', description: 'boom' } } } };
        }
        return { id: cmd.id, result: { result: { value: { count: 1 } } } };
      }
      return baseHandler(cmd, () => {});
    });
    try {
      const session = await connect({ wsUrl: srv.pageWsUrl });
      for (let i = 0; i < 3; i++) await session.callWithArgs('function () { return 1; }', []);
      const released = srv.received.filter((c) => c.method === 'Runtime.releaseObjectGroup');
      expect(released).toHaveLength(3);           // 三次调用 → 三次释放
      expect(released[0].params).toEqual({ objectGroup: OBJECT_GROUP });
      // 每次重新取句柄（不复用上一次的 objectId）
      expect(srv.received.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(3);

      // 异常路径：callFunctionOn 抛错时也要释放
      await expect(session.callWithArgs('function () { throw 1; }', [])).rejects.toThrow(/页面求值异常/);
      expect(srv.received.filter((c) => c.method === 'Runtime.releaseObjectGroup')).toHaveLength(4);
      session.close();
    } finally {
      await srv.close();
    }
  });
});
