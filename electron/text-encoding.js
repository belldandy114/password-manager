'use strict';

/**
 * 文本文件的编码嗅探（纯逻辑，可单测）。
 *
 * 起因：Excel 中文环境「另存为 CSV」默认写 GBK/GB18030，而 file:read-text 原来
 * 硬编码按 UTF-8 读，中文全变成 U+FFFD（界面上就是一片「����」）。
 *
 * 判定顺序：
 *   1. BOM（UTF-8 / UTF-16LE / UTF-16BE）——有 BOM 就以 BOM 为准；
 *   2. 严格 UTF-8 解码（fatal:true）能过就是 UTF-8；
 *   3. 严格 GB18030 解码能过就是 GB18030（GBK 的超集，覆盖 GBK/GB2312）；
 *   4. 都不行就退回宽松 UTF-8（保留替换字符，至少不抛错）。
 *
 * 之所以用「严格解码是否抛错」而不是统计 U+FFFD 比例：Node 的 TextDecoder
 * 在 fatal:true 时对非法字节直接抛 TypeError，比数替换字符更可靠，也不会把
 * 一段合法但含少量生僻字的 UTF-8 误判成 GBK。
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/** 严格解码；失败返回 null（不抛错，交给调用方继续试下一个编码） */
function tryDecode(buf, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * 把文件字节解成文本。
 * @param {Buffer|Uint8Array} buf
 * @returns {{ text: string, encoding: string }}
 */
function decodeTextBuffer(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!bytes.length) return { text: '', encoding: 'utf-8' };

  if (startsWith(bytes, UTF8_BOM)) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }

  // 纯 ASCII 一定同时是合法 UTF-8，先走这条最常见的路
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' };

  const gb = tryDecode(bytes, 'gb18030');
  if (gb !== null) return { text: gb, encoding: 'gb18030' };

  // 两种都不合法：宽松 UTF-8，保证调用方拿到字符串而不是异常
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8' };
}

/** 给界面显示用的编码名（GB18030 统一显示成 GBK，用户更熟） */
function encodingLabel(encoding) {
  const e = String(encoding || '').toLowerCase();
  if (e === 'gb18030' || e === 'gbk' || e === 'gb2312') return 'GBK';
  if (e === 'utf-16le' || e === 'utf-16be') return 'UTF-16';
  return 'UTF-8';
}

module.exports = { decodeTextBuffer, encodingLabel };
