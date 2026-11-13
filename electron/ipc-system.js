'use strict';

/**
 * 系统类 IPC（对话框 / 文件读写 / 应用路径）。
 *
 * 从 main.js 整域搬出来（D2）：依赖通过参数注入（mainWindow / app），
 * 本模块不碰 main.js 的模块级状态。
 *
 * 1.24.2：测试数据生成器已从独立 Vue 子应用并入主应用，
 * `dialog:saveFile` / `fs:writeFile` 这两个只给子应用 preload 用的历史别名、
 * 以及 tdg 路径 / 回填转发 IPC 一并删除。
 */

const fs = require('fs');
const { ipcMain, dialog, app } = require('electron');

/**
 * @param {{ getWindow: () => any }} deps
 */
function registerSystemIpc(deps = {}) {
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;

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

  // ---- 路径 ----
  ipcMain.handle('app:get-path', (_event, name) => app.getPath(name));
}

module.exports = { registerSystemIpc };
