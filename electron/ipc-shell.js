'use strict';
/**
 * 壳层 IPC：应用级命令、快速搜索小窗、随手记小窗、日志、检查更新，以及小窗的数据版本号。
 *
 * 这些 handler 原先散在 main.js 的模块作用域（app:/quicknote:/palette:/log:/update:check）
 * 与 setupIpcHandlers() 里（palette:epoch）。搬出来只为让 main.js 少背一层脚手架，
 * 行为与返回结构一字未改。
 */
const { app, ipcMain, shell, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { logPath, tail: logTail } = require('./app-log');
const { cmpVersion } = require('./update-check');
const { openHttpUrl } = require('./url-open');
const { focusBrowser } = require('./browser-focus');

/**
 * 网址条目：补上协议后交给系统默认浏览器，不要把应用窗口拉出来。
 * 走 url-open 统一兜底链 —— 应用以管理员身份运行时 openExternal 会「假成功」，
 * 只有 explorer 代理能真正把浏览器拉起来（小窗回车打开也吃过这个亏）。
 */
function openEntryInBrowser(raw) {
  let url = String(raw || '').trim();
  if (!url) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
  // 只允许 http(s)，避免把奇怪的 scheme 丢给系统
  if (!/^https?:\/\//i.test(url)) return false;
  void openHttpUrl(url, { shell, spawn }).then((r) => {
    if (r && r.success) focusBrowser();
  }).catch(() => { /* 忽略 */ });
  if (process.env.PM_DEBUG_HOTKEY) console.log('[palette] open-url ' + url);
  return true;
}

/**
 * @param {object} deps
 * @param {() => any} deps.getMainWindow
 * @param {() => boolean} deps.isUnlocked
 * @param {() => any} deps.hotkeyInfo
 * @param {(next: object, opts: object) => any} deps.applyHotkeys
 * @param {() => void} deps.showMainWindow
 * @param {() => void} deps.showSearchWindow
 * @param {() => void} deps.hideSearchWindow
 * @param {(height: number) => void} deps.setSearchWindowHeight
 * @param {() => void} deps.showQuickNote
 * @param {() => void} deps.hideQuickNote
 * @param {() => Promise<any>} deps.fetchLatestRelease
 */
function registerShellIpc(deps) {
  const {
    getMainWindow, isUnlocked, hotkeyInfo, applyHotkeys,
    showMainWindow, showSearchWindow, hideSearchWindow, setSearchWindowHeight,
    showQuickNote, hideQuickNote, fetchLatestRelease,
  } = deps;

  /** 把命令送回主窗口执行（窗口可能还没建/已销毁） */
  function sendToMain(channel, payload) {
    const win = getMainWindow();
    try {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    } catch { /* 忽略 */ }
  }

  ipcMain.handle('app:relaunch', async () => {
    app.relaunch();
    app.exit(0);
    return { success: true };
  });

  /** 设置页显示真实生效的全局快捷键（自定义或回退后都不能写死） */
  ipcMain.handle('app:hotkeys', async () => ({ success: true, data: hotkeyInfo() }));

  /**
   * 改全局快捷键：先试着注册，成功才落盘；失败会把原因（conflict / same）带回去，
   * 并回滚到原来能用的组合。
   */
  ipcMain.handle('app:hotkeys-apply', async (_event, payload) => {
    try {
      const r = applyHotkeys({
        search: payload && payload.search,
        toggle: payload && payload.toggle,
        quicknote: payload && payload.quicknote,
      }, { persist: true });
      return {
        success: r.ok,
        data: r.data,
        rolledBack: !!r.rolledBack,
        error: r.ok ? '' : (r.data.search.reason || r.data.toggle.reason || 'conflict'),
        info: hotkeyInfo(),
      };
    } catch (e) {
      return { success: false, error: e.message, info: hotkeyInfo() };
    }
  });

  // ---- 随手记小窗 ----
  ipcMain.handle('quicknote:hide', () => {
    hideQuickNote();
    return { success: true };
  });

  /** 与全局随手记键等价的入口（托盘/回归脚本用） */
  ipcMain.handle('quicknote:show', () => {
    if (!isUnlocked()) { showMainWindow(); return { success: false, error: 'locked' }; }
    showQuickNote();
    return { success: true };
  });

  // ---- 独立快速搜索小窗 ----
  ipcMain.handle('palette:hide', () => {
    hideSearchWindow();
    return { success: true };
  });

  /** 与全局快捷键等价的入口（托盘/回归脚本用；未解锁时只把主窗口带出来） */
  ipcMain.handle('palette:show', () => {
    if (!isUnlocked()) { showMainWindow(); return { success: false, error: 'locked' }; }
    showSearchWindow();
    return { success: true };
  });

  /** 按结果条数调整小窗高度：没输入时只留一个搜索框 */
  ipcMain.handle('palette:resize', (_event, height) => {
    setSearchWindowHeight(height);
    return { success: true };
  });

  /** 选中一条命令：网址 → 默认浏览器；其它 → 收起小窗并让主窗口执行 */
  ipcMain.handle('palette:run', (_event, item) => {
    hideSearchWindow();
    // 网址类：直接开浏览器，应用保持原样（不用跳转、不用弹出主窗口）
    if (item && typeof item.id === 'string' && item.id.startsWith('entry:') && item.url) {
      if (openEntryInBrowser(item.url)) return { success: true };
    }
    if (item && item.id === 'action:lock') {
      // 锁定不需要把窗口提前拉出来，原地锁就行
      sendToMain('palette:run', item);
      return { success: true };
    }
    showMainWindow();
    sendToMain('palette:run', item || {});
    return { success: true };
  });

  /** 小窗里发现还没解锁：收起小窗，把主窗口叫出来解锁 */
  ipcMain.handle('palette:unlock', () => {
    hideSearchWindow();
    showMainWindow();
    return { success: true };
  });

  ipcMain.handle('log:info', async () => ({ success: true, data: { path: logPath() || '' } }));
  ipcMain.handle('log:open', async () => {
    const f = logPath();
    if (!f || !fs.existsSync(f)) return { success: false, error: '还没有日志文件' };
    const err = await shell.openPath(path.dirname(f));
    return err ? { success: false, error: err } : { success: true, data: { path: f } };
  });
  ipcMain.handle('log:tail', async (_e, lines = 200) => ({
    success: true,
    data: { path: logPath() || '', text: String(logTail(Number(lines) || 200) || '') },
  }));

  /** 渲染层错误/警告转写到主进程 app.log（app-log.js 已劫持 console.warn/error） */
  ipcMain.handle('log:renderer', async (_e, payload = {}) => {
    const level = payload.level === 'error' ? 'error' : 'warn';
    const line = '[renderer] ' + String(payload.message || '').slice(0, 600);
    if (level === 'error') console.error(line);
    else console.warn(line);
    return { success: true };
  });

  ipcMain.handle('update:check', async () => {
    try {
      const rel = await fetchLatestRelease();
      const current = app.getVersion();
      return {
        success: true,
        data: {
          current,
          latest: rel.latest,
          hasUpdate: !!rel.latest && cmpVersion(rel.latest, current) > 0,
          url: rel.htmlUrl,
          downloadUrl: rel.downloadUrl,
          assetName: rel.assetName,
          digest: rel.digest,
          notes: rel.notes,
        },
      };
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '请求超时' : e.message };
    }
  });
}

/**
 * 小窗用的「数据版本」：epoch 没变就直接复用上一次拼好的命令列表。
 * 只回两个字段，比重新取 7 类数据（最多 1,600 条）便宜得多。
 * 依赖会话状态（currentPassword / vaultEpoch），所以在 setupIpcHandlers() 里注册。
 */
function registerShellSessionIpc(deps) {
  const { isUnlocked, getEpoch } = deps;
  ipcMain.handle('palette:epoch', () => ({ epoch: getEpoch(), unlocked: isUnlocked() }));

  /**
   * 系统通知（环境巡检状态翻转等）。点一下把主窗口拉出来。
   * 与禅道新 Bug 提醒用同一套 Electron Notification，不额外引依赖。
   */
  ipcMain.handle('app:notify', async (_e, payload = {}) => {
    const title = String(payload.title || '').slice(0, 120);
    const body = String(payload.body || '').slice(0, 400);
    if (!title) return { success: false, error: '缺少标题' };
    try {
      const n = new Notification({ title, body, silent: !!payload.silent });
      n.on('click', () => {
        const win = getMainWindow();
        try {
          if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        } catch { /* 忽略 */ }
        if (payload.page) sendToMain('app:navigate', { page: payload.page });
      });
      n.show();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err && err.message ? err.message : err) };
    }
  });
}

module.exports = { registerShellIpc, registerShellSessionIpc, openEntryInBrowser };