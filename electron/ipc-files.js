'use strict';

/**
 * 目录型文件 IPC：测试笔记（notes:*）。
 *
 * 本域只依赖 fs / path / shell / dialog 与 ipcMain，没有共享状态，
 * 因此从 main.js 的 setupIpcHandlers()（约 3000 行的大函数）里整体搬出来。
 * 安全约定不变：所有路径都过 notesResolve 做目录穿越校验，删除走系统回收站。
 *
 * 1.36.0：周报域（7 条通道 + 其目录穿越校验助手）随「周报下线」（方案 §11.2）整块删除，
 * 本文件现在只承载笔记域；settings 里的周报目录字段保留（§4.2：不跟设置层较劲，回滚不用迁移）。
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, shell, dialog } = require('electron');

const NOTE_EXTS = ['.md', '.markdown', '.txt'];

function registerFileIpc(deps = {}) {
  // mainWindow 属于 main.js 的模块状态，拆分后必须注入；缺省时用无父窗口的对话框（也能弹出来）
  const getWindow = typeof deps.getWindow === "function" ? deps.getWindow : () => null;
  // ---- 测试笔记（可选：存到自己选的目录里，一篇一个 .md）----
  // ---- 测试笔记（可选：存到自己选的目录里，一篇一个 .md） ----
  const NOTE_EXTS = ['.md', '.markdown', '.txt'];

  const notesResolve = (dir, name) => {
    const root = path.resolve(String(dir || ''));
    const file = path.resolve(root, String(name || ''));
    if (!file.startsWith(root + path.sep) && file !== root) return { error: '非法文件路径' };
    return { file };
  };

  /** 文件名安全化：去掉非法字符，保证 .md 结尾，且不与已有文件重名 */
  const notesFileName = (title, dir) => {
    let base = String(title || '').trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!base) base = '未命名笔记';
    if (!/\.(md|markdown|txt)$/i.test(base)) base += '.md';
    if (!dir) return base;
    let name = base;
    let i = 2;
    while (fs.existsSync(path.join(dir, name))) {
      const dot = base.lastIndexOf('.');
      name = `${base.slice(0, dot)}-${i}${base.slice(dot)}`;
      i += 1;
    }
    return name;
  };

  ipcMain.handle('notes:list', async (_event, { dir } = {}) => {
    try {
      if (!dir) return { success: false, error: '未指定笔记目录' };
      if (!fs.existsSync(dir)) return { success: false, error: `目录不存在：${dir}` };
      if (!fs.statSync(dir).isDirectory()) return { success: false, error: `不是目录：${dir}` };
      const files = fs.readdirSync(dir)
        .filter(n => NOTE_EXTS.includes(path.extname(n).toLowerCase()))
        .map(n => {
          const st = fs.statSync(path.join(dir, n));
          return { name: n, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
      return { success: true, data: files };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:read', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = notesResolve(dir, name);
      if (error) return { success: false, error };
      if (!fs.existsSync(file)) return { success: false, error: '文件不存在' };
      const st = fs.statSync(file);
      return {
        success: true,
        data: { name, content: fs.readFileSync(file, 'utf8'), mtime: st.mtime.toISOString(), size: st.size },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:save', async (_event, { dir, name, content, title } = {}) => {
    try {
      if (!dir) return { success: false, error: '未指定笔记目录' };
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 没给文件名时用标题生成；给了就沿用（改名由 rename 处理）
      const fileName = String(name || '').trim() || notesFileName(title, dir);
      const { file, error } = notesResolve(dir, fileName);
      if (error) return { success: false, error };
      fs.writeFileSync(file, String(content == null ? '' : content), 'utf8');
      const st = fs.statSync(file);
      return { success: true, data: { name: fileName, size: st.size, mtime: st.mtime.toISOString() } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:rename', async (_event, { dir, name, nextName } = {}) => {
    try {
      let target = String(nextName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
      if (!target) return { success: false, error: '请填写文件名' };
      if (!/\.(md|markdown|txt)$/i.test(target)) target += '.md';
      const a = notesResolve(dir, name);
      const b = notesResolve(dir, target);
      if (a.error) return { success: false, error: a.error };
      if (b.error) return { success: false, error: b.error };
      if (!fs.existsSync(a.file)) return { success: false, error: '原文件不存在' };
      if (a.file !== b.file && fs.existsSync(b.file)) return { success: false, error: '同名文件已存在' };
      fs.renameSync(a.file, b.file);
      return { success: true, data: { name: target } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:delete', async (_event, { dir, name } = {}) => {
    try {
      const { file, error } = notesResolve(dir, name);
      if (error) return { success: false, error };
      if (!fs.existsSync(file)) return { success: false, error: '文件已不存在' };
      await shell.trashItem(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('notes:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择存放测试笔记的目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, data: null };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 在资源管理器里打开（打开目录 / 定位某个文件） */
  ipcMain.handle('notes:reveal', async (_event, { dir, name } = {}) => {
    try {
      if (name) {
        const { file, error } = notesResolve(dir, name);
        if (error) return { success: false, error };
        shell.showItemInFolder(file);
      } else if (dir && fs.existsSync(dir)) {
        shell.openPath(dir);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerFileIpc };
