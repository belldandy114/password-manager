'use strict';

/**
 * ipc-scan.js —— 代码体检（模块 3）与接口覆盖取数（模块 4.1）的 IPC 域。
 *
 * **W1 只接线，不做业务**（2026-11-20 裁决：先让四件套绿，再填实现）。
 * 通道与入参/出参/上限/取消语义见 docs/契约-本地测试资产工作站.md §2.2（C-52 ~ C-56），
 * 施工单见 docs/拆分-主进程.md §5.4（W5）。
 *
 * W5 要在这里落的东西（现在一行都没有，别在这里顺手加）：
 *   - 目录遍历 + 后缀白名单 + 跳过名单（C-54）
 *   - root 包含性校验与符号链接逃逸（C-16 第 1 条）、realpath 前缀比较
 *   - 单文件 1 MB / 文件数 2000 / findings 300 / 深度 12 / 60 s 超时（C-53）
 *   - cancel token 表与每 32 文件或 1 MB 让出事件循环（C-51/C-55）
 *   - 规则匹配走 electron/scan-rules.js（纯函数，W5 新建）
 */

const { ipcMain } = require('electron');

/**
 * @param {{ getMainWindow?: () => any }} deps  W5 从这里解构 getMainWindow（dialog 父窗口）
 */
function registerScanIpc(deps = {}) {
  // W1 骨架里窗口引用用不上（占位 handler 不开对话框）；W5 实现 scan:pick-root 时从 deps 解构
  // getMainWindow，**不要裸用 mainWindow**——拆出去的模块看不到 main.js 的模块级状态（守卫 check-ipc 会红）。
  void deps;

  ipcMain.handle('scan:pick-root', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));

  ipcMain.handle('scan:rules', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));

  ipcMain.handle('scan:run', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));

  ipcMain.handle('scan:cancel', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));

  ipcMain.handle('scan:reveal', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));
}

module.exports = { registerScanIpc };