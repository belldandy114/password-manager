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
const { ipcMain, dialog, shell } = require('electron');
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

  /**
   * 列出附件目录里的全部文件（附件集中管理页用）。
   *
   * 只返回 id / 大小 / 修改时间，**不返回内容**：一页可能几百个附件，
   * 全解密成 base64 送过去会直接把渲染进程撑爆；缩略图由页面按需逐张读。
   * 「属于谁」由渲染层拿 vault 里的引用关系去对，主进程不碰业务数据。
   */
  ipcMain.handle('attachment:list', () => {
    try {
      // dir 单独回传：目录为空时也能在界面上显示「附件存在哪个文件夹」
      if (!fs.existsSync(attachDir)) return { success: true, data: [], dir: attachDir };
      const out = [];
      for (const name of fs.readdirSync(attachDir)) {
        if (!name.endsWith('.enc')) continue;
        const id = name.slice(0, -4);
        try {
          const file = path.join(attachDir, name);
          const st = fs.statSync(file);
          if (!st.isFile()) continue;
          out.push({ id, size: st.size, updatedAt: new Date(st.mtimeMs).toISOString(), dir: attachDir, file });
        } catch { /* 单个文件读不到就跳过 */ }
      }
      out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return { success: true, data: out, dir: attachDir };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 在资源管理器里定位附件（带 id 定位 .enc 文件，不带 id 打开附件目录） */
  ipcMain.handle('attachment:reveal', (_event, payload = {}) => {
    try {
      const id = String(payload.id || '').replace(/[^a-zA-Z0-9-]/g, '');
      const file = id ? fileOf(id) : '';
      if (file && fs.existsSync(file)) shell.showItemInFolder(file);
      else if (fs.existsSync(attachDir)) shell.openPath(attachDir);
      else return { success: false, error: '附件目录不存在' };
      return { success: true, data: { dir: attachDir, file } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 把附件解密后另存到用户选的位置（导出）。
   * 走 dialog 在主进程里选路径，避免渲染层拿到任意写权限。
   */
  ipcMain.handle('attachment:export', async (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    if (!payload.id) return { success: false, error: '缺少附件 id' };
    try {
      const b64 = readAttachment(payload.id, password);
      if (!b64) return { success: false, error: '附件不存在或已损坏' };
      const mime = sniffImageMime(b64);
      // 扩展名优先用调用方给的原文件名（密钥/证书这类非图片附件只能靠它），
      // 其次按图片魔数推，最后兜底 .bin
      const nameExt = path.extname(String(payload.name || '')).replace(/^\./, '').toLowerCase();
      const ext = nameExt || (mime ? mime.replace('image/', '').replace('jpeg', 'jpg') : 'bin');
      const r = await dialog.showSaveDialog({
        defaultPath: safeName(payload.name, `附件-${payload.id.slice(0, 8)}.${ext}`),
      });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };
      fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
      return { success: true, data: { file: r.filePath } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerAttachIpc };