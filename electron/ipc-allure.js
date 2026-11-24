'use strict';

/**
 * ipc-allure.js —— Allure results 解析（模块 5.1）的 IPC 域，**只读**。
 *
 * **W1 只接线，不做业务**。通道与上限见 docs/契约-本地测试资产工作站.md §2.4（C-61 ~ C-64），
 * 施工单见 docs/拆分-主进程.md §5.5（W6-A）。
 *
 * W6-A 要在这里落的东西：
 *   - 只读 *-result.json / *-container.json / environment.*，附件与 HTML 一律不读（C-61）
 *   - maxFiles 5000 / 单文件 2 MB / 30 s 超时 / 每 64 文件让出事件循环（C-62）
 *   - 坏文件不整体失败：计入 skippedFiles 继续，只有「一个可解析的 result 都没有」才 success:false（C-63）
 *   - 解析、聚类、flaky 判定全部在 electron/allure-parse.js（纯函数，W6-A 新建）
 *
 * 安全底线：命中的用例内容不进日志、不进审计（C-17）。
 */

const { ipcMain } = require('electron');

/**
 * @param {{ getMainWindow?: () => any }} deps  W6-A 从这里解构 getMainWindow（dialog 父窗口）
 */
function registerAllureIpc(deps = {}) {
  // W1 骨架里窗口引用用不上；W6-A 实现 allure:pick-dir 时从 deps 解构，别裸用 mainWindow（守卫会红）
  void deps;

  ipcMain.handle('allure:pick-dir', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));

  ipcMain.handle('allure:parse', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));
}

module.exports = { registerAllureIpc };