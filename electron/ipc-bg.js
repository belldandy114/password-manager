/**
 * ipc-bg.js —— 自定义背景图（选择 / 读取 / 清除）
 *
 * 图片由主进程处理：
 *   - 用 Electron 自带的 nativeImage 读图并缩放（不引入 sharp 之类的原生依赖）；
 *   - 最长边压到 2560 / 1600，JPEG 存 88 质量（透明 PNG 保留 PNG，避免透明区变黑）；
 *   - 文件放在 <数据目录>/background/ 下，设置里只存文件名，不进 localStorage。
 */
const fs = require('fs');
const path = require('path');

const MAX_W = 2560;
const MAX_H = 1600;
const JPEG_QUALITY = 88;

module.exports = { registerBgIpc };

/**
 * @param {{ ipcMain: import('electron').IpcMain; dialog: import('electron').Dialog; nativeImage: import('electron').NativeImage; dataDir: string; getWindow: () => import('electron').BrowserWindow | null; loadSettings: () => any; saveSettings: (s: any) => void; }} deps
 */
function registerBgIpc(deps) {
  const { ipcMain, dialog, nativeImage, dataDir, loadSettings, saveSettings } = deps;
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;
  const dir = path.join(dataDir, 'background');

  const readMeta = (file) => {
    try {
      const abs = path.join(dir, file);
      if (!file || !fs.existsSync(abs)) return null;
      const img = nativeImage.createFromPath(abs);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      return { abs, size, ext: path.extname(file).toLowerCase() };
    } catch {
      return null;
    }
  };

  ipcMain.handle('bg:get', async () => {
    try {
      const s = loadSettings() || {};
      const file = String(s.backgroundImage || '');
      const meta = readMeta(file);
      if (!meta) return { success: true, data: { configured: false } };
      const buf = fs.readFileSync(meta.abs);
      const mime = meta.ext === '.png' ? 'image/png' : 'image/jpeg';
      return {
        success: true,
        data: {
          configured: true,
          name: file,
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
          width: meta.size.width,
          height: meta.size.height,
          bytes: buf.length,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('bg:choose', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择背景图片',
        buttonLabel: '使用这张',
        properties: ['openFile'],
        filters: [{ name: '图片（JPG/PNG）', extensions: ['jpg', 'jpeg', 'png'] }],
      });
      if (r.canceled || !r.filePaths?.[0]) return { success: false, canceled: true };
      const src = r.filePaths[0];
      const img = nativeImage.createFromPath(src);
      if (img.isEmpty()) return { success: false, error: '读不出这张图片：只支持 JPG / PNG（WebP、BMP 请先另存为 PNG）' };

      const size = img.getSize();
      const scale = Math.min(1, MAX_W / size.width, MAX_H / size.height);
      const outSize = {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      };
      const resized = scale < 1 ? img.resize({ width: outSize.width, height: outSize.height, quality: 'good' }) : img;

      fs.mkdirSync(dir, { recursive: true });
      const keepPng = path.extname(src).toLowerCase() === '.png';
      const name = `bg-${Date.now()}${keepPng ? '.png' : '.jpg'}`;
      const bytes = keepPng ? resized.toPNG() : resized.toJPEG(JPEG_QUALITY);
      fs.writeFileSync(path.join(dir, name), bytes);

      const s = loadSettings() || {};
      const old = String(s.backgroundImage || '');
      s.backgroundImage = name;
      // 第一张图默认开一点效果，后续沿用用户调好的值
      if (s.backgroundOpacity === undefined) s.backgroundOpacity = 0.32;
      if (s.backgroundBlur === undefined) s.backgroundBlur = 8;
      if (s.backgroundDim === undefined) s.backgroundDim = 0.42;
      if (s.backgroundAutoAccent === undefined) s.backgroundAutoAccent = true;
      // 新图要重新取色，清掉上一张的主色
      s.backgroundAccent = '';
      saveSettings(s);
      if (old && old !== name) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { /* 旧图删不掉不影响 */ }
      }

      return {
        success: true,
        data: {
          name,
          dataUrl: `data:${keepPng ? 'image/png' : 'image/jpeg'};base64,${bytes.toString('base64')}`,
          width: outSize.width,
          height: outSize.height,
          original: size,
          bytes: bytes.length,
          settings: s,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('bg:clear', async () => {
    try {
      const s = loadSettings() || {};
      const old = String(s.backgroundImage || '');
      s.backgroundImage = '';
      saveSettings(s);
      if (old) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { /* 忽略 */ }
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}


