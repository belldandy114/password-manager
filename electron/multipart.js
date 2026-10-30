'use strict';

/**
 * multipart 表单行解析（`key=value`，值以 @ 开头表示文件）。
 *
 * 为什么要单独抽出来测：这一行同时承担三种 curl 写法
 *   1. 应用自己的约定：`files=@C:\a.jpg`
 *   2. curl 的 -F 语法：`files=@C:\a.jpg;type=image/jpeg;filename=x.jpg`
 *   3. 普通字段：`desc=说明文字`（值里可能有空格、等号，不能乱 trim）
 * 解析错的后果是「文件传不上去」或者「MIME 变成 application/octet-stream 被服务端拒绝」，
 * 而界面上看起来一切正常 —— 所以必须有单测兜住。
 */

/** 只按扩展名给个常见 MIME：绝大多数上传校验看的是这个 */
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

/** 按文件扩展名猜 MIME（猜不到给空串，交给上层用 application/octet-stream） */
function guessMime(filePath) {
  const s = String(filePath || '');
  const m = /\.([A-Za-z0-9]+)(?:"|'|\s|;|$)/.exec(s);
  if (!m) return '';
  return MIME_BY_EXT[m[1].toLowerCase()] || '';
}

/**
 * 解析一行 multipart 表单。
 * @returns {{ok: boolean, key: string, value: string, isFile: boolean, filePath: string, filename: string, mime: string}}
 */
function parseMultipartLine(line) {
  const raw = String(line == null ? '' : line);
  const at = raw.indexOf('=');
  const out = { ok: false, key: '', value: '', isFile: false, filePath: '', filename: '', mime: '' };
  if (at <= 0) return out;

  out.key = raw.slice(0, at).trim();
  if (!out.key) return out;
  out.value = raw.slice(at + 1);
  out.ok = true;
  if (!out.value.startsWith('@')) return out;

  // 文件字段：@路径(;type=xxx)?(;filename=yyy)?
  out.isFile = true;
  let rest = out.value.slice(1);
  const parts = rest.split(';');
  out.filePath = parts.shift().trim();
  for (const p of parts) {
    const m = /^\s*(type|filename)\s*=\s*(.*)$/i.exec(p);
    if (!m) continue;
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (m[1].toLowerCase() === 'type') out.mime = val;
    else out.filename = val;
  }
  if (!out.mime) out.mime = guessMime(out.filePath);
  return out;
}

module.exports = { MIME_BY_EXT, guessMime, parseMultipartLine };