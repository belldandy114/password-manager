'use strict';

/**
 * 接口调试的 WebSocket / SSE 长连接（1.23.0）。
 *
 * 为什么自己实现 WebSocket 握手：Node 自带的 `WebSocket`（undici）不允许自定义
 * 握手请求头，而接口调试最常用的恰恰是 `Authorization` / `Cookie`。这里直接走
 * TCP/TLS + HTTP Upgrade，把头原样带上去；帧编解码在 `./ws-frame`（纯函数、有单测）。
 *
 * SSE 用 fetch 流式读：`EventSource` 在 Electron 主进程里不存在，而且同样不能带自定义头。
 *
 * 连接只活在内存里：锁定 / 退出时由 main.js 的 clearCaches() 调 closeAll() 全部断开，
 * 避免锁屏后还有一条连着别人系统的长连接在后台收消息。
 */

const net = require('net');
const tls = require('tls');
const { ipcMain } = require('electron');
const {
  OPCODE, MAX_MESSAGE_BYTES, makeKey, acceptKey, buildHandshake,
  parseHandshakeResponse, encodeFrame, decodeFrames, closeFrame, parseCloseFrame,
} = require('./ws-frame');

/** 同时最多开几条长连接：再多就是误用，也会把内存吃光 */
const MAX_CONNECTIONS = 8;
/** 单条 SSE 事件上限 */
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
/** 握手超时 */
const HANDSHAKE_TIMEOUT_MS = 15000;

/** id -> { kind, socket|controller, ... } */
const conns = new Map();
let seq = 0;

function nextId(kind) {
  seq += 1;
  return `${kind}-${Date.now().toString(36)}-${seq}`;
}

/** 把用户写的 "K: V" 多行头解析成对象 */
function parseHeaderLines(raw) {
  const out = {};
  String(raw || '').split('\n').forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  return out;
}

function closeAll() {
  for (const [, c] of conns) {
    try {
      if (c.kind === 'ws' && c.socket) c.socket.destroy();
      if (c.kind === 'sse' && c.controller) c.controller.abort();
    } catch { /* 已经断了就算了 */ }
  }
  conns.clear();
}

/**
 * @param {{
 *   getWindow: () => any,
 *   getPassword: () => string | null,
 * }} deps
 */
function registerWsIpc(deps = {}) {
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;
  const getPassword = typeof deps.getPassword === 'function' ? deps.getPassword : () => null;

  /** 往渲染层推事件；窗口没了就静默丢弃 */
  const emit = (channel, payload) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  const guard = () => {
    if (!getPassword()) return { success: false, error: '未解锁' };
    if (conns.size >= MAX_CONNECTIONS) {
      return { success: false, error: `同时最多 ${MAX_CONNECTIONS} 条长连接，请先关掉一些` };
    }
    return null;
  };

  // ---------------- WebSocket ----------------

  ipcMain.handle('ws:connect', (_event, payload = {}) => {
    const bad = guard();
    if (bad) return bad;
    const raw = String(payload.url || '').trim();
    if (!/^wss?:\/\//i.test(raw)) {
      return { success: false, error: '地址必须以 ws:// 或 wss:// 开头' };
    }
    let u;
    try { u = new URL(raw); } catch { return { success: false, error: '地址不合法' }; }

    const id = nextId('ws');
    const secure = u.protocol === 'wss:';
    const port = Number(u.port) || (secure ? 443 : 80);
    const key = makeKey();
    const headers = parseHeaderLines(payload.headers);
    const startedAt = Date.now();

    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: !payload.insecure })
      : net.connect({ host: u.hostname, port });

    const conn = { kind: 'ws', socket, id, opened: false, buf: Buffer.alloc(0), startedAt };
    conns.set(id, conn);

    const fail = (message) => {
      if (!conns.has(id)) return;
      conns.delete(id);
      emit('ws:event', { id, type: 'error', data: message, at: new Date().toISOString() });
      try { socket.destroy(); } catch { /* ignore */ }
    };

    const timer = setTimeout(() => fail(`握手超时（${HANDSHAKE_TIMEOUT_MS} ms）`), HANDSHAKE_TIMEOUT_MS);

    socket.on(secure ? 'secureConnect' : 'connect', () => {
      socket.write(buildHandshake({ url: raw, headers, key }));
    });

    socket.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);

      if (!conn.opened) {
        const hs = parseHandshakeResponse(conn.buf);
        if (!hs) return; // 还没收全
        clearTimeout(timer);
        if (hs.status !== 101) {
          fail(`握手失败：${hs.statusLine || '无响应'}`);
          return;
        }
        const expect = acceptKey(key);
        if (hs.headers['sec-websocket-accept'] !== expect) {
          fail('握手校验失败：Sec-WebSocket-Accept 不匹配');
          return;
        }
        conn.opened = true;
        conn.buf = hs.rest;
        emit('ws:event', {
          id, type: 'open', data: `已连接（${Date.now() - startedAt} ms）`, at: new Date().toISOString(),
        });
      }

      try {
        const { frames, rest } = decodeFrames(conn.buf);
        conn.buf = rest;
        for (const f of frames) {
          if (f.opcode === OPCODE.PING) {
            socket.write(encodeFrame({ opcode: OPCODE.PONG, payload: f.payload }));
            continue;
          }
          if (f.opcode === OPCODE.PONG) continue;
          if (f.opcode === OPCODE.CLOSE) {
            const c = parseCloseFrame(f.payload);
            conns.delete(id);
            emit('ws:event', {
              id, type: 'close', data: `对端关闭（${c.code}${c.reason ? ` ${c.reason}` : ''}）`, at: new Date().toISOString(),
            });
            try { socket.end(closeFrame(c.code === 1005 ? 1000 : c.code)); } catch { /* ignore */ }
            return;
          }
          if (f.opcode === OPCODE.TEXT || f.opcode === OPCODE.BINARY || f.opcode === OPCODE.CONT) {
            const text = f.payload.toString('utf8');
            emit('ws:event', {
              id,
              type: 'message',
              data: text,
              binary: f.opcode === OPCODE.BINARY,
              bytes: f.payload.length,
              at: new Date().toISOString(),
            });
          }
        }
      } catch (e) {
        fail(e.message);
      }
    });

    socket.on('error', (e) => fail(e.message || '连接失败'));
    socket.on('close', () => {
      clearTimeout(timer);
      if (!conns.has(id)) return;
      conns.delete(id);
      emit('ws:event', { id, type: 'close', data: '连接已断开', at: new Date().toISOString() });
    });

    return { success: true, data: { id } };
  });

  ipcMain.handle('ws:send', (_event, payload = {}) => {
    const conn = conns.get(payload.id);
    if (!conn || conn.kind !== 'ws' || !conn.opened) {
      return { success: false, error: '连接未就绪' };
    }
    const text = String(payload.data ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      return { success: false, error: `单条消息不能超过 ${MAX_MESSAGE_BYTES / 1024 / 1024} MB` };
    }
    try {
      conn.socket.write(encodeFrame({ opcode: OPCODE.TEXT, payload: text }));
      return { success: true, data: { bytes: Buffer.byteLength(text, 'utf8') } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ws:close', (_event, payload = {}) => {
    const conn = conns.get(payload.id);
    if (!conn) return { success: true };
    conns.delete(payload.id);
    try {
      if (conn.kind === 'ws') {
        conn.socket.write(closeFrame(1000, 'client close'));
        conn.socket.end();
      } else if (conn.controller) {
        conn.controller.abort();
      }
    } catch { /* ignore */ }
    return { success: true };
  });

  // ---------------- SSE ----------------

  ipcMain.handle('sse:connect', async (_event, payload = {}) => {
    const bad = guard();
    if (bad) return bad;
    const raw = String(payload.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) {
      return { success: false, error: '地址必须以 http:// 或 https:// 开头' };
    }

    const id = nextId('sse');
    const controller = new AbortController();
    const conn = { kind: 'sse', controller, id, startedAt: Date.now() };
    conns.set(id, conn);

    const headers = { Accept: 'text/event-stream', ...parseHeaderLines(payload.headers) };
    const startedAt = Date.now();

    // 不 await：连接是长活的，这里只负责把流读起来，事件通过 ws:event 推给渲染层
    void (async () => {
      try {
        const res = await fetch(raw, { headers, signal: controller.signal });
        if (!res.ok) {
          conns.delete(id);
          emit('ws:event', {
            id, type: 'error', data: `HTTP ${res.status} ${res.statusText || ''}`.trim(), at: new Date().toISOString(),
          });
          return;
        }
        emit('ws:event', {
          id, type: 'open', data: `已连接（${Date.now() - startedAt} ms）`, at: new Date().toISOString(),
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE 以空行分隔事件；\r\n 与 \n 都要认
          let idx = buf.search(/\r?\n\r?\n/);
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
            if (Buffer.byteLength(block, 'utf8') > MAX_SSE_EVENT_BYTES) {
              emit('ws:event', { id, type: 'error', data: '单条事件过大，已跳过', at: new Date().toISOString() });
            } else if (block.trim()) {
              let eventName = 'message';
              const dataLines = [];
              for (const line of block.split(/\r?\n/)) {
                if (line.startsWith(':')) continue; // 注释/心跳
                if (line.startsWith('event:')) eventName = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
              }
              emit('ws:event', {
                id,
                type: 'message',
                event: eventName,
                data: dataLines.join('\n'),
                at: new Date().toISOString(),
              });
            }
            idx = buf.search(/\r?\n\r?\n/);
          }
        }
        conns.delete(id);
        emit('ws:event', { id, type: 'close', data: '服务端结束了事件流', at: new Date().toISOString() });
      } catch (e) {
        conns.delete(id);
        if (e && e.name === 'AbortError') {
          emit('ws:event', { id, type: 'close', data: '已断开', at: new Date().toISOString() });
        } else {
          emit('ws:event', { id, type: 'error', data: (e && e.message) || '连接失败', at: new Date().toISOString() });
        }
      }
    })();

    return { success: true, data: { id } };
  });

  return { closeAll };
}

module.exports = { registerWsIpc, closeAll, MAX_CONNECTIONS };
