'use strict';

/**
 * ipc-git.js —— Git Diff 影响面取数（模块 6）的 IPC 域，**只读**。
 *
 * **W1 只接线，不做业务**。通道与上限/超时见 docs/契约-本地测试资产工作站.md §2.3（C-57 ~ C-60），
 * 施工单见 docs/拆分-主进程.md §5.5（W6-B）。
 *
 * W6-B 要在这里落的东西（本模块只负责 spawn + 超时 + 错误文案）：
 *   - execFile('git', args, { cwd, timeout: 10000, env: GIT_TERMINAL_PROMPT=0 / GIT_OPTIONAL_LOCKS=0 })（C-58）
 *   - 命令白名单拼装与 `-z` 解析**全部在 electron/git-args.js**（C-57/C-59 明令，不许写进这里：
 *     本模块 require('electron')，塞进来就只能起 Electron 才能测）
 *   - 错误文案按 C-60 映射；非 git 目录必须给中文，不透传 git 的英文 stderr
 *
 * 安全底线：不写文件、不执行任何 git 写命令、渲染层不能传任意参数（C-15/C-57）。
 */

const { ipcMain } = require('electron');

function registerGitIpc() {
  ipcMain.handle('git:probe', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));

  ipcMain.handle('git:diff', async () => ({ success: false, error: '该功能尚未实现（W1 骨架）' }));
}

module.exports = { registerGitIpc };