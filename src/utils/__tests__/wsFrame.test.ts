import { describe, it, expect } from 'vitest';
import {
  GUID, OPCODE, MAX_MESSAGE_BYTES, makeKey, acceptKey, buildHandshake,
  parseHandshakeResponse, encodeFrame, decodeFrames, closeFrame, parseCloseFrame,
} from '../../../electron/ws-frame';

describe('WebSocket 帧编解码', () => {
  it('acceptKey 与 RFC 6455 示例一致', () => {
    // RFC 6455 §1.3 的示例：key 对应固定的 accept
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(GUID).toBe('258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
  });

  it('makeKey 是 16 字节的 base64', () => {
    const k = makeKey();
    expect(Buffer.from(k, 'base64')).toHaveLength(16);
    expect(makeKey()).not.toBe(k);
  });

  it('buildHandshake 带路径、查询串与自定义头', () => {
    const req = buildHandshake({
      url: 'wss://example.com/ws/chat?room=1',
      headers: { Authorization: 'Bearer t', 'X-Trace': 'abc' },
      key: 'k',
    });
    expect(req.startsWith('GET /ws/chat?room=1 HTTP/1.1\r\n')).toBe(true);
    expect(req).toContain('Host: example.com\r\n');
    expect(req).toContain('Upgrade: websocket\r\n');
    expect(req).toContain('Sec-WebSocket-Key: k\r\n');
    expect(req).toContain('Authorization: Bearer t\r\n');
    expect(req).toContain('X-Trace: abc\r\n');
    expect(req.endsWith('\r\n\r\n')).toBe(true);
  });

  it('buildHandshake 忽略用户自写的握手头', () => {
    const req = buildHandshake({
      url: 'ws://a.com/x',
      headers: { Host: 'evil', Upgrade: 'h2c', Connection: 'close', 'Sec-WebSocket-Key': 'bad', 'Content-Length': '9' },
      key: 'good',
    });
    expect(req).toContain('Host: a.com\r\n');
    expect(req).toContain('Sec-WebSocket-Key: good\r\n');
    expect(req).not.toContain('evil');
    expect(req).not.toContain('h2c');
    expect(req).not.toContain('Content-Length');
  });

  it('parseHandshakeResponse 解析状态与头，并保留后续字节', () => {
    const frame = encodeFrame({ opcode: OPCODE.TEXT, payload: 'hi', mask: false });
    const raw = Buffer.concat([
      Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: x\r\n\r\n', 'utf8'),
      frame,
    ]);
    const r = parseHandshakeResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(101);
    expect(r!.headers.upgrade).toBe('websocket');
    expect(r!.headers['sec-websocket-accept']).toBe('x');
    expect(r!.rest.equals(frame)).toBe(true);
  });

  it('parseHandshakeResponse 数据不完整时返回 null', () => {
    expect(parseHandshakeResponse(Buffer.from('HTTP/1.1 101 OK\r\n'))).toBeNull();
  });

  it('encodeFrame 小载荷（<126）', () => {
    const f = encodeFrame({ opcode: OPCODE.TEXT, payload: 'hello', mask: true });
    expect(f[0]).toBe(0x81);
    expect(f[1] & 0x80).toBe(0x80); // 有掩码
    expect(f[1] & 0x7f).toBe(5);
    expect(f).toHaveLength(2 + 4 + 5);
  });

  it('encodeFrame 中载荷（16 位长度）', () => {
    const payload = Buffer.alloc(200, 0x61);
    const f = encodeFrame({ opcode: OPCODE.BINARY, payload, mask: false });
    expect(f[0]).toBe(0x82);
    expect(f[1]).toBe(126);
    expect(f.readUInt16BE(2)).toBe(200);
    expect(f).toHaveLength(4 + 200);
  });

  it('encodeFrame 大载荷（64 位长度）', () => {
    const payload = Buffer.alloc(70000, 0x62);
    const f = encodeFrame({ opcode: OPCODE.BINARY, payload, mask: false });
    expect(f[1]).toBe(127);
    expect(Number(f.readBigUInt64BE(2))).toBe(70000);
    expect(f).toHaveLength(10 + 70000);
  });

  it('encodeFrame + decodeFrames 往返（掩码）', () => {
    const f = encodeFrame({ opcode: OPCODE.TEXT, payload: '中文 payload', mask: true });
    const { frames, rest } = decodeFrames(f);
    expect(rest).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(frames[0].opcode).toBe(OPCODE.TEXT);
    expect(frames[0].fin).toBe(true);
    expect(frames[0].payload.toString('utf8')).toBe('中文 payload');
  });

  it('decodeFrames 一次解出多帧', () => {
    const a = encodeFrame({ opcode: OPCODE.TEXT, payload: 'a', mask: false });
    const b = encodeFrame({ opcode: OPCODE.TEXT, payload: 'b', mask: false });
    const { frames, rest } = decodeFrames(Buffer.concat([a, b]));
    expect(frames.map(x => x.payload.toString())).toEqual(['a', 'b']);
    expect(rest).toHaveLength(0);
  });

  it('decodeFrames 半帧留在 rest 里', () => {
    const f = encodeFrame({ opcode: OPCODE.TEXT, payload: 'abcdef', mask: false });
    const { frames, rest } = decodeFrames(f.subarray(0, f.length - 2));
    expect(frames).toHaveLength(0);
    expect(rest).toHaveLength(f.length - 2);
  });

  it('decodeFrames 分片帧保留 fin=false', () => {
    const f1 = encodeFrame({ opcode: OPCODE.TEXT, payload: 'ab', mask: false, fin: false });
    const f2 = encodeFrame({ opcode: OPCODE.CONT, payload: 'cd', mask: false, fin: true });
    const { frames } = decodeFrames(Buffer.concat([f1, f2]));
    expect(frames).toHaveLength(2);
    expect(frames[0].fin).toBe(false);
    expect(frames[1].fin).toBe(true);
    expect(frames[1].opcode).toBe(OPCODE.CONT);
  });

  it('decodeFrames 超过上限时报错', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2);
    expect(() => decodeFrames(header)).toThrow(/帧过大/);
  });

  it('closeFrame / parseCloseFrame 往返', () => {
    const f = closeFrame(1001, 'going away');
    const { frames } = decodeFrames(f);
    expect(frames[0].opcode).toBe(OPCODE.CLOSE);
    const c = parseCloseFrame(frames[0].payload);
    expect(c.code).toBe(1001);
    expect(c.reason).toBe('going away');
  });

  it('parseCloseFrame 空载荷回 1005', () => {
    expect(parseCloseFrame(Buffer.alloc(0))).toEqual({ code: 1005, reason: '' });
  });
});
