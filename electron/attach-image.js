'use strict';

/**
 * 粘贴截图的纯逻辑：dataURL 解析、大小限制、文件名、MIME 嗅探。
 *
 * 从剪贴板拿到的图片一定以 dataURL 形式过来（渲染层没有别的通道），
 * 但这些数据不可信：可能是任意 data: 类型、可能超大、可能是空内容。
 * 校验都在这里做，写盘那一步（ipc-attach.js）只负责加密落盘。
 */

/** 单张图片上限：截图一般几百 KB，12MB 已经能装下 4K 全屏图 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** 允许的图片类型 → 扩展名。只收浏览器能直接显示的，避免存进来打不开 */
const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/** base64 解码后的字节数（不吃内存，按长度算） */
function base64Size(b64) {
  const s = String(b64 || '');
  if (!s) return 0;
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/**
 * 解析 dataURL。
 * @returns {{ok: true, mime: string, ext: string, base64: string, size: number} | {ok: false, error: string}}
 */
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) return { ok: false, error: '没有图片数据' };
  const m = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!m) return { ok: false, error: '不是有效的图片 dataURL' };
  const mime = m[1].toLowerCase();
  const ext = IMAGE_EXT[mime];
  if (!ext) return { ok: false, error: `不支持的图片格式：${mime}` };
  const base64 = m[2].replace(/\s+/g, '');
  const size = base64Size(base64);
  if (!size) return { ok: false, error: '图片内容为空' };
  if (size > MAX_IMAGE_BYTES) return { ok: false, error: '图片不能超过 12MB' };
  return { ok: true, mime, ext, base64, size };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 生成默认文件名：截图-20261109-183045.png（本地时间，便于按时间找） */
function stampedImageName(ext, date) {
  const d = date instanceof Date ? date : new Date();
  const name = `截图-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `${name}.${String(ext || 'png').toLowerCase()}`;
}

/** 存进 vault 的只有字节，显示时得知道 MIME：按文件头前几字节嗅探 */
function sniffImageMime(base64) {
  const b = String(base64 || '').slice(0, 32);
  if (!b) return '';
  if (b.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b.startsWith('/9j/')) return 'image/jpeg';
  if (b.startsWith('R0lGOD')) return 'image/gif';
  if (b.startsWith('UklGR')) return 'image/webp';
  if (b.startsWith('Qk')) return 'image/bmp';
  return '';
}

function buildImageDataUrl(mime, base64) {
  if (!mime || !base64) return '';
  return `data:${mime};base64,${base64}`;
}

module.exports = {
  MAX_IMAGE_BYTES,
  IMAGE_EXT,
  base64Size,
  parseImageDataUrl,
  stampedImageName,
  sniffImageMime,
  buildImageDataUrl,
};