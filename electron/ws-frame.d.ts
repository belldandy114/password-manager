/**
 * WebSocket 帧编解码（RFC 6455）—— 主进程用，渲染层只通过 IPC 间接使用。
 *
 * 纯函数、不碰网络，便于单测。
 */

/** RFC 6455 握手固定串 */
export const GUID: string;

export const OPCODE: {
  CONT: 0x0;
  TEXT: 0x1;
  BINARY: 0x2;
  CLOSE: 0x8;
  PING: 0x9;
  PONG: 0xa;
};

/** 单条消息上限（字节） */
export const MAX_MESSAGE_BYTES: number;

/** 生成握手用的 Sec-WebSocket-Key */
export function makeKey(): string;

/** 由 key 算出服务端应回的 Sec-WebSocket-Accept */
export function acceptKey(key: string): string;

/**
 * 拼 Upgrade 请求。用户自写的 Host/Upgrade/Connection/Sec-WebSocket-* 会被忽略。
 */
export function buildHandshake(opts: {
  url: string;
  headers?: Record<string, string>;
  key: string;
}): string;

/**
 * 解析握手响应；`rest` 是握手之后紧跟的帧字节（可能非空）。
 * 数据还不完整时返回 null。
 */
export function parseHandshakeResponse(buf: Buffer): {
  status: number;
  statusLine: string;
  headers: Record<string, string>;
  rest: Buffer;
} | null;

/** 编码一帧（客户端发出的帧必须 mask=true） */
export function encodeFrame(opts?: {
  opcode?: number;
  payload?: Buffer | string;
  mask?: boolean;
  fin?: boolean;
}): Buffer;

/** 从缓冲区解出尽可能多的完整帧，返回剩余的不完整字节 */
export function decodeFrames(buf: Buffer): {
  frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>;
  rest: Buffer;
};

/** 构造关闭帧 */
export function closeFrame(code?: number, reason?: string): Buffer;

/** 解析关闭帧载荷 */
export function parseCloseFrame(payload: Buffer): { code: number; reason: string };
