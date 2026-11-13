'use strict';

/**
 * WebSocket 帧编解码（RFC 6455）。
 *
 * 为什么不用 Node 自带的 `WebSocket`：undici 的实现不允许自定义握手请求头，
 * 而接口调试最常用的恰恰是 `Authorization` / `Cookie` 这类头。这里自己走
 * TCP/TLS + HTTP Upgrade，就能把头原样带上去。
 *
 * 纯函数、不碰网络，便于单测：帧的掩码、长度三档（<126 / 16 位 / 64 位）、
 * 分片续帧、控制帧都在这里覆盖。
 */

const crypto = require('crypto');

/** RFC 6455 规定的握手固定串 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** 单条消息上限：超过就断开，避免对端发个 2GB 把渲染进程撑爆 */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/** 握手用的 Sec-WebSocket-Key（16 字节随机数的 base64） */
function makeKey() {
  return crypto.randomBytes(16).toString('base64');
}

/** 服务端应回的 Sec-WebSocket-Accept */
function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

/**
 * 拼 Upgrade 请求。
 * 用户自己写的 Host / Upgrade / Connection / Sec-WebSocket-* 一律忽略，
 * 这些由握手本身决定，让用户覆盖只会把连接搞坏。
 */
function buildHandshake({ url, headers = {}, key }) {
  const u = new URL(url);
  const path = `${u.pathname || '/'}${u.search || ''}`;
  const skip = new Set([
    'host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
    'content-length', 'content-type',
  ]);
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${u.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  for (const [k, v] of Object.entries(headers || {})) {
    if (!k || v === undefined || v === null) continue;
    if (skip.has(String(k).toLowerCase())) continue;
    lines.push(`${k}: ${v}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * 解析握手响应。返回的 rest 是「握手之后紧跟的帧字节」——
 * 有些服务端会在 101 的同一个包里就带第一条消息，不能丢。
 */
function parseHandshakeResponse(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx < 0) return null;
  const head = buf.subarray(0, idx).toString('utf8');
  const lines = head.split('\r\n');
  const statusLine = lines.shift() || '';
  const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    status: m ? Number(m[1]) : 0,
    statusLine,
    headers,
    rest: buf.subarray(idx + 4),
  };
}

/**
 * 编码一帧。客户端发出的帧必须掩码（mask=true）。
 * 长度三档：<126 直接放；≤65535 用 126 + 16 位；更大用 127 + 64 位。
 */
function encodeFrame({ opcode = OPCODE.TEXT, payload = Buffer.alloc(0), mask = true, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  if (mask) headerLen += 4;

  const out = Buffer.alloc(headerLen + len);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let off = 2;
  if (len < 126) {
    out[1] = len;
  } else if (len <= 0xffff) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
    off = 4;
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  }
  if (mask) {
    out[1] |= 0x80;
    const key = crypto.randomBytes(4);
    key.copy(out, off);
    off += 4;
    for (let i = 0; i < len; i += 1) out[off + i] = data[i] ^ key[i % 4];
  } else {
    data.copy(out, off);
  }
  return out;
}

/**
 * 从缓冲区里尽可能多地解出完整帧，返回剩余的不完整字节。
 * 数据不够一帧就原样留在 rest 里，等下一次数据到达再拼。
 */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(p);
      p += 8;
      if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error(`帧过大（${big} 字节）`);
      len = Number(big);
    }
    if (len > MAX_MESSAGE_BYTES) throw new Error(`帧过大（${len} 字节）`);

    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;

    let payload = buf.subarray(p, p + len);
    if (maskKey) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** 关闭帧：前两字节是状态码，后面是 UTF-8 原因 */
function closeFrame(code = 1000, reason = '') {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2, 'utf8');
  return encodeFrame({ opcode: OPCODE.CLOSE, payload: body });
}

/** 解析关闭帧的载荷（可能为空） */
function parseCloseFrame(payload) {
  if (!payload || payload.length < 2) return { code: 1005, reason: '' };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

module.exports = {
  GUID,
  OPCODE,
  MAX_MESSAGE_BYTES,
  makeKey,
  acceptKey,
  buildHandshake,
  parseHandshakeResponse,
  encodeFrame,
  decodeFrames,
  closeFrame,
  parseCloseFrame,
};
