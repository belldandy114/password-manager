'use strict';

/**
 * 系统类 IPC（对话框 / 文件读写 / 应用路径 / 子应用路径）。
 *
 * 从 main.js 整域搬出来（D2），保持行为不变：
 * - 依赖通过参数注入（mainWindow / app / TDG 路径），本模块不碰 main.js 的模块级状态；
 * - 两套历史别名（`dialog:save-file` 与 `dialog:saveFile`、`file:write` 与 `fs:writeFile`）
 *   **必须保留**：前者给页面用，后者给测试数据子应用用，删掉会有功能静默失效。
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, app } = require('electron');

/** 「测试数据 → 接口调试」一次最多带多少条：再多请求体也没法用，还容易卡住渲染进程 */
const MAX_TDG_VALUES = 500;

/**
 * @param {{ getWindow: () => any, tdgPaths?: { distPath: string, preloadPath: string } }} deps
 */
function registerSystemIpc(deps = {}) {
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;
  const tdg = deps.tdgPaths || { distPath: '', preloadPath: '' };

  // ---- 文件对话框 ----
  ipcMain.handle('dialog:open-file', async (_event, { filters } = {}) => {
    const r = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'],
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (r.canceled) return { canceled: true };
    return { canceled: false, filePath: r.filePaths[0] };
  });

  ipcMain.handle('dialog:save-file', async (_event, { defaultName, filters } = {}) => {
    const r = await dialog.showSaveDialog(getWindow(), {
      defaultPath: defaultName,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (r.canceled) return { canceled: true };
    return { canceled: false, filePath: r.filePath };
  });

  // 旧别名（测试数据子应用在用）
  ipcMain.handle('dialog:saveFile', async (_event, { defaultName, filters } = {}) => {
    const r = await dialog.showSaveDialog(getWindow(), {
      defaultPath: defaultName,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    return { canceled: false, filePath: r.filePath };
  });

  // ---- 写文件 ----
  ipcMain.handle('file:write', (_event, { filePath, content, encoding } = {}) => {
    try {
      if (encoding === 'base64') fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
      else fs.writeFileSync(filePath, content, 'utf8');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 旧别名（测试数据子应用在用）
  ipcMain.handle('fs:writeFile', async (_event, { filePath, content, encoding } = {}) => {
    try {
      fs.writeFileSync(filePath, content, encoding || 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ---- 路径 ----
  ipcMain.handle('app:get-path', (_event, name) => app.getPath(name));

  ipcMain.handle('tdg:get-path', () => ({
    distPath: tdg.distPath,
    preloadPath: tdg.preloadPath,
  }));

  /**
   * 测试数据子应用 → 主窗口：把生成结果交给「接口调试」填进请求体。
   *
   * 子应用是独立 webview，拿不到主窗口的 store，所以走主进程转发一次。
   * 只转发字符串数组并做上限截断：生成结果可能上万条，整包塞进 IPC 会把
   * 主窗口卡住，而请求体本来也用不了那么多。
   */
  ipcMain.handle('tdg:to-api', (_event, payload = {}) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return { success: false, error: '主窗口不可用' };
    const raw = Array.isArray(payload.values) ? payload.values : [];
    const values = raw
      .map((v) => String(v == null ? '' : v))
      .filter((v) => v !== '')
      .slice(0, MAX_TDG_VALUES);
    if (!values.length) return { success: false, error: '没有可填入的数据' };
    win.webContents.send('tdg:to-api', { values, truncated: raw.length > values.length });
    return { success: true, data: { count: values.length, truncated: raw.length > values.length } };
  });

  // 目录型文件 IPC（周报 / 笔记）在 electron/ipc-files.js；这里只做校验反馈
  ipcMain.handle('system:paths', () => ({
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    tdgDist: tdg.distPath,
  }));
}

module.exports = { registerSystemIpc, MAX_TDG_VALUES };
