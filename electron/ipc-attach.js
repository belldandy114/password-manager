'use strict';

/**
 * 图片附件 IPC（#5）：粘贴截图 → 加密落盘 → 需要时读回 dataURL 显示。
 *
 * 和老的 `attachment:pick` 复用同一个存储位置与加密方式（attachments/<id>.enc，
 * 会话密钥加密），区别只是入口不同：
 * - pick：文件对话框选文件；
 * - save-image：渲染层从剪贴板拿到 dataURL 直接送过来。
 *
 * 依赖注入（currentPassword / encrypt / readAttachment / ATTACH_DIR）是为了不碰
 * main.js 的模块级状态，和 ipc-system / ipc-files 的拆分约定一致。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain } = require('electron');
const {
  parseImageDataUrl, stampedImageName, sniffImageMime, buildImageDataUrl,
} = require('./attach-image');

/** 文件名去掉路径分隔符与控制字符，避免被当成路径用 */
function safeName(raw, fallback) {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
  return s || fallback;
}

/**
 * @param {{
 *   getPassword: () => string,
 *   attachDir: string,
 *   fileOf: (id: string) => string,
 *   encrypt: (plain: string, password: string) => string,
 *   readAttachment: (id: string, password: string) => string | null,
 * }} deps
 */
function registerAttachIpc(deps = {}) {
  const getPassword = typeof deps.getPassword === 'function' ? deps.getPassword : () => '';
  const attachDir = deps.attachDir || '';
  const fileOf = typeof deps.fileOf === 'function' ? deps.fileOf : (id) => path.join(attachDir, `${id}.enc`);
  const encrypt = deps.encrypt;
  const readAttachment = deps.readAttachment;

  ipcMain.handle('attachment:save-image', (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    const parsed = parseImageDataUrl(payload.dataUrl);
    if (!parsed.ok) return { success: false, error: parsed.error };
    try {
      const id = crypto.randomUUID();
      fs.mkdirSync(attachDir, { recursive: true });
      fs.writeFileSync(fileOf(id), encrypt(parsed.base64, password), 'utf8');
      return {
        success: true,
        data: {
          id,
          name: safeName(payload.name, stampedImageName(parsed.ext)),
          size: parsed.size,
          mime: parsed.mime,
          kind: 'image',
          addedAt: new Date().toISOString(),
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('attachment:read-image', (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    if (!payload.id) return { success: false, error: '缺少附件 id' };
    try {
      const b64 = readAttachment(payload.id, password);
      if (!b64) return { success: false, error: '附件不存在或已损坏' };
      const mime = sniffImageMime(b64);
      if (!mime) return { success: false, error: '不是支持的图片格式' };
      return { success: true, data: { dataUrl: buildImageDataUrl(mime, b64), mime } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerAttachIpc };