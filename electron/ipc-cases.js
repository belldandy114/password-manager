'use strict';

/**
 * 用例库 IPC（cases:*）。
 *
 * 设计取向：**只做文件管家**——用例文件由 xmind / Excel / Markdown 负责编辑，
 * 这里只负责「收纳 + 打开 + 导出」，不解析内容、不做应用内编辑。
 *
 * 安全约定（与 weekly / notes 一致）：
 *   - 所有相对路径过 `resolveInside()`，越界一律拒绝；
 *   - 删除走系统回收站（`shell.trashItem`），不做 `fs.unlink`；
 *   - 名称过 `safeName()`，重名自动加后缀，绝不覆盖已有文件。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ipcMain, shell, dialog } = require('electron');
const { CASE_EXTS, safeName, resolveInside, uniqueName, canMoveInto } = require('./cases-paths');

/** 列表里不展示的系统垃圾文件 */
const IGNORED = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

function registerCasesIpc(deps = {}) {
  const getWindow = typeof deps.getWindow === 'function' ? deps.getWindow : () => null;
  const dataDir = String(deps.dataDir || '');

  const configFile = path.join(dataDir, 'cases.json');

  const readConfig = () => {
    try {
      const raw = fs.readFileSync(configFile, 'utf8');
      const j = JSON.parse(raw);
      return { root: typeof j.root === 'string' ? j.root : '' };
    } catch {
      return { root: '' };
    }
  };
  const writeConfig = (cfg) => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  /** 读库配置：目录不存在时不自动创建（用户可能把盘拔了，别悄悄建个空库） */
  ipcMain.handle('cases:config', async () => {
    try {
      const cfg = readConfig();
      const root = cfg.root && fs.existsSync(cfg.root) ? cfg.root : '';
      return {
        success: true,
        data: {
          root,
          configured: !!cfg.root,
          exists: !!root,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 首次设置 / 重新选择空库：只保存，不迁移 */
  ipcMain.handle('cases:choose-root', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择用例库目录（建议放在云盘/固定盘，名称为 Test_Cases）',
        buttonLabel: '设为用例库',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      const root = path.resolve(r.filePaths[0]);
      fs.mkdirSync(root, { recursive: true });
      writeConfig({ root });
      startWatch(root);
      return { success: true, data: { root } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 统计目录下的文件数（迁移后校验用） */
  const countFiles = (dir) => {
    let n = 0;
    const walk = (d) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else n += 1;
      }
    };
    walk(dir);
    return n;
  };

  /**
   * 更改库位置：复制 → 校验文件数 → 把旧目录丢进回收站。
   * 校验不过就保留旧目录并报错，绝不「先删再复制」。
   */
  ipcMain.handle('cases:change-root', async (_event, { next } = {}) => {
    try {
      const cfg = readConfig();
      const oldRoot = cfg.root && fs.existsSync(cfg.root) ? cfg.root : '';
      const target = path.resolve(String(next || ''));
      if (!target) return { success: false, error: '没有选择新目录' };
      if (oldRoot && (target === oldRoot || target.startsWith(oldRoot + path.sep))) {
        return { success: false, error: '新目录不能是当前用例库本身或它的子目录' };
      }
      if (oldRoot && oldRoot.startsWith(target + path.sep)) {
        return { success: false, error: '新目录不能是当前用例库的上级目录' };
      }
      fs.mkdirSync(target, { recursive: true });

      let moved = 0;
      if (oldRoot) {
        const before = countFiles(oldRoot);
        fs.cpSync(oldRoot, target, { recursive: true, force: true });
        const after = countFiles(target);
        if (before !== after) {
          return {
            success: false,
            error: `复制校验失败（旧目录 ${before} 个文件，新目录 ${after} 个），旧目录已保留`,
          };
        }
        moved = after;
      }
      writeConfig({ root: target });
      startWatch(target);
      // 校验通过后再清理旧目录：进回收站，可恢复
      if (oldRoot) {
        try { await shell.trashItem(oldRoot); } catch { /* 删不掉不影响新库可用 */ }
      }
      return { success: true, data: { root: target, moved } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 列出某个目录（rel 为空 = 库根） */
  ipcMain.handle('cases:list', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: true, data: { configured: false, root: '', rel: '', dirs: [], files: [] } };
      if (!fs.existsSync(cfg.root)) {
        return { success: false, error: '用例库目录不存在（可能被移动或删除了），请重新选择' };
      }
      startWatch(cfg.root);
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '目录不存在' };

      const dirs = [];
      const files = [];
      const entries = fs.readdirSync(target, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORED.has(e.name.toLowerCase())) continue;
        if (e.name.startsWith('.')) continue;
        const full = path.join(target, e.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const childRel = path.relative(cfg.root, full).split(path.sep).join('/');
        if (e.isDirectory()) {
          // 一层统计：文件数（模块用）+ 子文件夹数（系统用，避免「有模块但顶层没文件」显示 0）
          let count = 0;
          let subDirs = 0;
          try {
            const kids = fs.readdirSync(full, { withFileTypes: true });
            count = kids.filter(x => x.isFile()).length;
            subDirs = kids.filter(x => x.isDirectory()).length;
          } catch { /* 权限问题就不显示 */ }
          dirs.push({ name: e.name, rel: childRel, mtime: st.mtime.toISOString(), fileCount: count, dirCount: subDirs });
        } else {
          files.push({
            name: e.name,
            rel: childRel,
            size: st.size,
            mtime: st.mtime.toISOString(),
            ext: path.extname(e.name).toLowerCase(),
          });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      files.sort((a, b) => b.mtime.localeCompare(a.mtime));
      return {
        success: true,
        data: {
          configured: true,
          root: cfg.root,
          rel: String(rel || ''),
          dirs,
          files,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 新建文件夹 */
  ipcMain.handle('cases:mkdir', async (_event, { rel, name } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target: parent, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      const checked = safeName(name);
      if (checked.error) return { success: false, error: checked.error };
      if (!fs.existsSync(parent)) return { success: false, error: '当前目录不存在' };
      const existing = fs.readdirSync(parent);
      const finalName = uniqueName(existing, checked.name);
      fs.mkdirSync(path.join(parent, finalName));
      return { success: true, data: { name: finalName } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 重命名（文件或文件夹） */
  ipcMain.handle('cases:rename', async (_event, { rel, name } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件或文件夹不存在' };
      if (path.resolve(target) === path.resolve(cfg.root)) {
        return { success: false, error: '不能重命名库根目录' };
      }
      const checked = safeName(name);
      if (checked.error) return { success: false, error: checked.error };
      const parent = path.dirname(target);
      const nextPath = path.join(parent, checked.name);
      if (nextPath !== target && fs.existsSync(nextPath)) {
        return { success: false, error: '同目录下已经有同名文件/文件夹' };
      }
      fs.renameSync(target, nextPath);
      const newRel = path.relative(cfg.root, nextPath).split(path.sep).join('/');
      return { success: true, data: { rel: newRel, name: checked.name } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 选文件（上传前） */
  ipcMain.handle('cases:pick-files', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择要放进用例库的文件',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '用例文件', extensions: CASE_EXTS.map(e => e.replace(/^\./, '')) },
          { name: '全部文件', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths?.length) return { success: false, canceled: true };
      return { success: true, data: r.filePaths };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 把选中的文件复制进当前目录（重名自动加后缀） */
  ipcMain.handle('cases:import', async (_event, { rel, files } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target: dir, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(dir)) return { success: false, error: '当前目录不存在' };
      const list = Array.isArray(files) ? files : [];
      if (!list.length) return { success: false, error: '没有选择文件' };

      const imported = [];
      const failed = [];
      for (const src of list) {
        try {
          const st = fs.statSync(src);
          if (!st.isFile()) { failed.push(`${path.basename(src)}（不是文件）`); continue; }
          const checked = safeName(path.basename(src));
          if (checked.error) { failed.push(`${path.basename(src)}（${checked.error}）`); continue; }
          const existing = fs.readdirSync(dir);
          const finalName = uniqueName(existing, checked.name);
          fs.copyFileSync(src, path.join(dir, finalName));
          imported.push(finalName);
        } catch (e) {
          failed.push(`${path.basename(src)}（${e.message}）`);
        }
      }
      return { success: true, data: { imported, failed } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 删除（进系统回收站） */
  ipcMain.handle('cases:delete', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (path.resolve(target) === path.resolve(cfg.root)) return { success: false, error: '不能删除库根目录' };
      if (!fs.existsSync(target)) return { success: false, error: '文件或文件夹已经不存在' };
      await shell.trashItem(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 用系统默认应用打开；没有关联应用时弹 Windows 的「打开方式」。
   * openPath 返回空串表示成功，返回非空字符串是错误信息（Electron 的约定）。
   */
  ipcMain.handle('cases:open', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };

      const msg = await shell.openPath(target);
      if (!msg) return { success: true, data: { how: 'default' } };

      if (process.platform === 'win32') {
        // 系统「打开方式」对话框：用户自己挑一个应用，这个文件从此有了关联
        spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', target], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref();
        return { success: true, data: { how: 'open-with' } };
      }
      return { success: false, error: `没有可用的默认应用：${msg}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 强制「用其他应用打开」：不试默认应用，直接弹系统「打开方式」 */
  ipcMain.handle('cases:open-with', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      if (process.platform !== 'win32') return { success: false, error: '当前系统不支持「打开方式」对话框' };
      spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return { success: true, data: { how: 'open-with' } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  /** 在资源管理器里定位 */
  ipcMain.handle('cases:reveal', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      shell.showItemInFolder(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 移动（拖拽到左侧目录）：文件可放到任意一级；文件夹只能放到根 / 系统这一级。
   * 目标重名自动加后缀，不动源文件的内容。
   */
  ipcMain.handle('cases:move', async (_event, { rel, targetRel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const src = resolveInside(cfg.root, rel);
      if (src.error) return { success: false, error: src.error };
      const dst = resolveInside(cfg.root, targetRel);
      if (dst.error) return { success: false, error: dst.error };
      if (!fs.existsSync(src.target)) return { success: false, error: '源文件不存在' };
      if (!fs.existsSync(dst.target)) return { success: false, error: '目标目录不存在' };
      if (!fs.statSync(dst.target).isDirectory()) return { success: false, error: '目标不是文件夹' };
      if (path.resolve(src.target) === path.resolve(cfg.root)) {
        return { success: false, error: '不能移动库根目录' };
      }
      const isDir = fs.statSync(src.target).isDirectory();
      // 不能把文件夹拖进它自己或它的子目录
      if (isDir && (dst.target === src.target || dst.target.startsWith(src.target + path.sep))) {
        return { success: false, error: '不能移动到自身或自己的子目录' };
      }
      const depthRule = canMoveInto(isDir, targetRel);
      if (!depthRule.ok) return { success: false, error: depthRule.error };

      const parent = path.dirname(src.target);
      if (path.resolve(parent) === path.resolve(dst.target)) {
        return { success: true, data: { unchanged: true, rel: String(rel || '') } };
      }
      const finalName = uniqueName(fs.readdirSync(dst.target), path.basename(src.target));
      const nextPath = path.join(dst.target, finalName);
      fs.renameSync(src.target, nextPath);
      const newRel = path.relative(cfg.root, nextPath).split(path.sep).join('/');
      return { success: true, data: { rel: newRel, name: finalName } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  /** 选一个目录（更改用例库位置时用；与导出目录分开，避免标题误导） */
  ipcMain.handle('cases:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择新的用例库目录',
        buttonLabel: '迁到这里',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { success: false, canceled: true };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  /** 选导出目标目录 */
  ipcMain.handle('cases:pick-export-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '导出到哪个目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { success: false, canceled: true };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 导出：把选中的文件/文件夹复制到目标目录（同名加后缀，不覆盖） */
  ipcMain.handle('cases:export', async (_event, { rels, dest } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const destDir = path.resolve(String(dest || ''));
      if (!destDir || !fs.existsSync(destDir)) return { success: false, error: '导出目录不存在' };
      const list = Array.isArray(rels) ? rels : [];
      if (!list.length) return { success: false, error: '没有选中要导出的内容' };

      const exported = [];
      const failed = [];
      for (const rel of list) {
        try {
          const { target, error } = resolveInside(cfg.root, rel);
          if (error) { failed.push(`${rel}（${error}）`); continue; }
          if (!fs.existsSync(target)) { failed.push(`${rel}（不存在）`); continue; }
          const name = uniqueName(fs.readdirSync(destDir), path.basename(target));
          fs.cpSync(target, path.join(destDir, name), { recursive: true, force: false });
          exported.push(name);
        } catch (e) {
          failed.push(`${rel}（${e.message}）`);
        }
      }
      return { success: true, data: { exported, failed, dest: destDir } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  /* ---------------- 预览 / 搜索 / 整文件夹导入 / 变更监听 ---------------- */

  const PREVIEW_TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.log', '.csv', '.yaml', '.yml', '.xml', '.sql', '.jmx', '.html', '.htm', '.css', '.js', '.ts']);
  const PREVIEW_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
  const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

  /** 应用内预览：文本 / CSV / Markdown / 图片 / Excel；其余返回 binary 让界面提示「用默认应用打开」 */
  ipcMain.handle('cases:preview', async (_event, { rel } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(target)) return { success: false, error: '文件不存在' };
      const st = fs.statSync(target);
      if (st.isDirectory()) return { success: false, error: '文件夹不支持预览' };
      if (st.size > PREVIEW_MAX_BYTES) {
        return { success: true, data: { kind: 'too-large', size: st.size, name: path.basename(target) } };
      }
      const ext = path.extname(target).toLowerCase();

      if (PREVIEW_IMAGE_EXT.has(ext)) {
        const buf = fs.readFileSync(target);
        return {
          success: true,
          data: { kind: 'image', dataUrl: `data:${MIME[ext] || 'image/png'};base64,${buf.toString('base64')}`, size: st.size, name: path.basename(target) },
        };
      }

      if (ext === '.xlsx' || ext === '.xls') {
        // 主进程解析（渲染层只收二维数组），最多 6 个 sheet × 200 行 × 30 列
        const XLSX = require('xlsx');
        const wb = XLSX.readFile(target, { cellDates: false, sheetRows: 201 });
        const sheets = (wb.SheetNames || []).slice(0, 6).map(name => {
          const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
          const rows = grid.slice(0, 200).map(r => (Array.isArray(r) ? r.slice(0, 30).map(v => String(v == null ? '' : v)) : []));
          return { name, rows, more: grid.length > 200 };
        });
        return { success: true, data: { kind: 'table', sheets, size: st.size, name: path.basename(target) } };
      }

      if (PREVIEW_TEXT_EXT.has(ext)) {
        const { decodeTextBuffer, encodingLabel } = require('./text-encoding');
        const { text, encoding } = decodeTextBuffer(fs.readFileSync(target));
        const kind = ext === '.csv' ? 'csv' : (ext === '.md' || ext === '.markdown') ? 'markdown' : 'text';
        let rows = null;
        if (kind === 'csv') {
          const { parseCsv } = require('./csv');
          rows = parseCsv(text).slice(0, 200);
        }
        return {
          success: true,
          data: {
            kind,
            text: text.slice(0, 400000),
            rows,
            encoding: encodingLabel(encoding),
            size: st.size,
            name: path.basename(target),
          },
        };
      }

      return { success: true, data: { kind: 'binary', size: st.size, ext, name: path.basename(target) } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 全库搜索（两级目录内按文件名匹配） */
  ipcMain.handle('cases:search', async (_event, { q, limit } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root || !fs.existsSync(cfg.root)) return { success: false, error: '用例库目录不可用' };
      const needle = String(q || '').trim().toLowerCase();
      // 空查询 = 给命令面板预热用：返回前 N 个文件（面板里再做本地过滤）
      const max = Math.max(1, Math.min(Number(limit) || 100, 300));
      const hits = [];
      const walk = (dir, depth) => {
        if (hits.length >= max) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length >= max) return;
          if (IGNORED.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          const childRel = path.relative(cfg.root, full).split(path.sep).join('/');
          if (e.isDirectory()) {
            if (depth < 2) walk(full, depth + 1);
            continue;
          }
          if (needle && !e.name.toLowerCase().includes(needle)) continue;
          let st = null;
          try { st = fs.statSync(full); } catch { /* 忽略 */ }
          hits.push({
            name: e.name,
            rel: childRel,
            size: st ? st.size : 0,
            mtime: st ? st.mtime.toISOString() : '',
            ext: path.extname(e.name).toLowerCase(),
            dir: path.dirname(childRel) === '.' ? '' : path.dirname(childRel).split(path.sep).join('/'),
          });
        }
      };
      walk(cfg.root, 0);
      return { success: true, data: { hits } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 选一个文件夹用于整目录导入 */
  ipcMain.handle('cases:pick-import-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择要导入的用例文件夹',
        buttonLabel: '导入',
        properties: ['openDirectory'],
      });
      if (r.canceled || !r.filePaths?.[0]) return { success: false, canceled: true };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 整目录导入：复制到当前目录下（保留内部结构，重名自动加后缀） */
  ipcMain.handle('cases:import-folder', async (_event, { rel, dir } = {}) => {
    try {
      const cfg = readConfig();
      if (!cfg.root) return { success: false, error: '还没有设置用例库目录' };
      const { target: destDir, error } = resolveInside(cfg.root, rel);
      if (error) return { success: false, error };
      if (!fs.existsSync(destDir)) return { success: false, error: '当前目录不存在' };
      const srcDir = path.resolve(String(dir || ''));
      if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
        return { success: false, error: '源文件夹不存在' };
      }
      if (String(rel || '').split('/').filter(Boolean).length >= 2) {
        return { success: false, error: '最多两级：请在系统或根目录导入文件夹' };
      }
      if (path.resolve(srcDir) === path.resolve(cfg.root)) return { success: false, error: '不能导入用例库自身' };
      const name = uniqueName(fs.readdirSync(destDir), path.basename(srcDir));
      fs.cpSync(srcDir, path.join(destDir, name), { recursive: true, force: false });
      let files = 0;
      const count = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(path.join(d, e.name)); else files += 1; } };
      count(path.join(destDir, name));
      return { success: true, data: { name, files } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /* 文件变更自动刷新：fs.watch 递归监听用例库根目录，防抖后通知渲染层 */
  let watcher = null;
  let watchRoot = '';
  let watchTimer = null;
  const stopWatch = () => {
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    watchRoot = '';
  };
  const startWatch = (root) => {
    if (!root) return;
    if (watcher && watchRoot === root) return;
    stopWatch();
    const win = getWindow();
    if (!win) return;
    try {
      watcher = fs.watch(root, { recursive: true }, () => {
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          watchTimer = null;
          const w = getWindow();
          if (w && !w.isDestroyed()) w.webContents.send('cases:changed');
        }, 500);
      });
      watcher.on('error', () => stopWatch());
      watchRoot = root;
    } catch { /* 某些盘符不支持递归监听，静默降级为手动刷新 */ }
  };
}

module.exports = { registerCasesIpc };





