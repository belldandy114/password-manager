/**
 * 「钉」成独立小窗：把一条记录摘出来摆在屏幕上，不跟着主窗口走。
 *
 * 用途是测试时边看边操作：主窗口缩在后台，小窗一直浮在上面显示网址/账号/密码。
 *
 * 几条约束：
 * - 小窗和主窗共用同一个 preload，渲染层按 `?window=pin&id=xxx` 分流；
 * - 数据不新建 IPC —— 小窗直接 `entries:get-all` 再按 id 找，省一条通道，
 *   也避免把条目内容在参数里传来传去（URL 会被日志/标题带到）；
 * - 主窗口锁定/退出时全部关掉，不然锁屏后密码还挂在屏幕上。
 */

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 200;

function createPinManager(deps) {
  const {
    BrowserWindow, ipcMain, path, screen,
    isDev, preloadPath, distDir, isContentProtection, onLog,
  } = deps;

  /** id -> BrowserWindow */
  const wins = new Map();

  function closeAll() {
    for (const [, w] of wins) {
      try { if (!w.isDestroyed()) w.destroy(); } catch { /* 忽略 */ }
    }
    wins.clear();
  }

  function createFor(id) {
    const existing = wins.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return existing;
    }

    const win = new BrowserWindow({
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      minWidth: 300,
      minHeight: 150,
      frame: false,
      transparent: true,
      hasShadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      maximizable: false,
      fullscreenable: false,
      resizable: true,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    if (typeof isContentProtection === 'function' && isContentProtection()) {
      win.setContentProtection(true);
    }

    const query = `window=pin&id=${encodeURIComponent(id)}`;
    if (isDev) {
      win.loadURL(`http://localhost:5173?${query}`);
    } else {
      win.loadFile(path.join(distDir, 'index.html'), { search: query });
    }

    // 每家小窗错开 28px，连着钉三条不会完全重叠
    const idx = wins.size;
    try {
      const { workArea } = screen.getPrimaryDisplay();
      win.setPosition(
        Math.max(0, workArea.x + workArea.width - DEFAULT_WIDTH - 24 - idx * 28),
        Math.max(0, workArea.y + 80 + idx * 28),
      );
    } catch { /* 拿不到屏幕信息就用默认位置 */ }

    win.once('ready-to-show', () => {
      try { win.show(); } catch { /* 忽略 */ }
    });
    win.on('closed', () => { wins.delete(id); });
    wins.set(id, win);
    if (typeof onLog === 'function') onLog(`[pin] 打开 ${id}`);
    return win;
  }

  function register() {
    ipcMain.handle('pin:open', (_e, id) => {
      const key = String(id || '').trim();
      if (!key) return { success: false, error: '缺少条目 id' };
      try {
        createFor(key);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err && err.message ? err.message : err) };
      }
    });
    ipcMain.handle('pin:close', (event) => {
      // 只有小窗自己能关自己：按 sender 反查
      for (const [id, w] of wins) {
        if (!w.isDestroyed() && w.webContents === event.sender) {
          wins.delete(id);
          try { w.destroy(); } catch { /* 忽略 */ }
          return { success: true };
        }
      }
      return { success: false, error: '没有对应的小窗' };
    });
    ipcMain.handle('pin:close-all', () => { closeAll(); return { success: true }; });
    ipcMain.handle('pin:count', () => ({ success: true, data: wins.size }));
  }

  return { register, closeAll, createFor, count: () => wins.size };
}

module.exports = { createPinManager, DEFAULT_WIDTH, DEFAULT_HEIGHT };
