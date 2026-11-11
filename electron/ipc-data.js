'use strict';

/**
 * 备份 / 数据目录 / 审计日志 / 旧版本数据恢复相关 IPC（backup:* 6 个、data:* 6 个、audit:* 3 个）。
 *
 * 从 main.js 的 setupIpcHandlers() 里搬出来，逐行保持原逻辑不变：
 *   - 路径常量（DATA_DIR / BACKUP_DIR / ATTACH_DIR / AUDIT_FILE / LOCATION_FILE）由 main.js 注入，
 *     因为它们依赖 resolveDataDir() 与 app.getPath('userData')，启动早期就定了；
 *   - 备份/审计的读写函数也注入，避免这里再复制一份文件格式逻辑。
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, shell } = require('electron');
const { inspectVaultFile } = require('./vault-file');

function registerDataIpc(deps) {
  const {
    DATA_DIR,
    USER_DATA_DIR,
    DATA_FILE,
    BACKUP_DIR,
    ATTACH_DIR,
    AUDIT_FILE,
    LOCATION_FILE,
    listBackups,
    backupKeepCount,
    backupMirrorDir,
    mirrorBackupFile,
    appendAudit,
    readAudit,
    writeFileAtomic,
    clearCaches,
    getMainWindow,
  } = deps;

  // ---- 旧版本数据恢复（改名后「新库已建、旧库还在」时手动搬）----
  function legacyInfo() {
    const { planLegacyMigration } = require('./legacy-migrate');
    const current = app.getPath('userData');
    const plan = planLegacyMigration({
      appData: process.env.PM_APP_DATA || app.getPath('appData'),
      currentUserData: current,
      isDir: (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } },
      hasVault: (d) => fs.existsSync(path.join(d, 'vault.enc')),
      currentHasVault: fs.existsSync(path.join(current, 'vault.enc')),
    });
    return {
      legacyDir: plan.legacyDir || '',
      found: plan.found || [],
      currentHasVault: fs.existsSync(path.join(current, 'vault.enc')),
    };
  }

  ipcMain.handle('data:legacy-info', async () => ({ success: true, data: legacyInfo() }));

  ipcMain.handle('data:recover-legacy', async () => {
    try {
      const info = legacyInfo();
      if (!info.legacyDir) return { success: false, error: '没有找到可恢复的旧数据' };
      const current = app.getPath('userData');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      // 现有库先备份，绝不直接覆盖
      const curVault = path.join(current, 'vault.enc');
      if (fs.existsSync(curVault)) {
        fs.copyFileSync(curVault, path.join(current, `vault.enc.before-recover-${ts}`));
      }
      let copied = 0;
      for (const item of ['vault.enc', 'vault.enc.bak', 'settings.json']) {
        const src = path.join(info.legacyDir, item);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(current, item));
        copied += 1;
      }
      console.log(`[recover] 已从 ${info.legacyDir} 恢复 ${copied} 个文件（原库已备份）`);
      return { success: true, data: { from: info.legacyDir, copied, backup: ts } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- Backups ----
  ipcMain.handle('backup:list', () => ({
    success: true,
    data: listBackups(),
    dir: BACKUP_DIR,
    keep: backupKeepCount(),
    lastAt: (listBackups()[0] || {}).mtime || '',
  }));

  /** 备份状态：本地目录 + 异地目录（设置里配的第二目录/网盘） */
  ipcMain.handle('backup:status', () => {
    const local = listBackups();
    const mirrorDir = backupMirrorDir();
    let mirror = { dir: mirrorDir, files: [], lastAt: '' };
    if (mirrorDir) {
      try {
        const files = fs.readdirSync(mirrorDir)
          .filter(f => /^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(f))
          .sort()
          .reverse()
          .map(name => {
            const st = fs.statSync(path.join(mirrorDir, name));
            return { name, size: st.size, mtime: st.mtime.toISOString() };
          });
        mirror = { dir: mirrorDir, files, lastAt: (files[0] || {}).mtime || '' };
      } catch (e) {
        mirror = { dir: mirrorDir, files: [], lastAt: '', error: e.message };
      }
    }
    return {
      success: true,
      data: { local: { dir: BACKUP_DIR, files: local, keep: backupKeepCount() }, mirror },
    };
  });

  /** 选异地备份目录（可选同步盘里的文件夹） */
  ipcMain.handle('backup:mirror-pick', async () => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择异地备份目录（可以是 OneDrive / 坚果云 等同步盘的文件夹）',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 立即备份一次（不等「每天一次」）：本地 + 异地，返回两边路径 */
  ipcMain.handle('backup:now', async () => {
    try {
      if (!fs.existsSync(DATA_FILE)) return { success: false, error: '还没有密码库可备份' };
      const day = new Date().toISOString().slice(0, 10);
      const target = path.join(BACKUP_DIR, `vault-${day}.enc`);
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.copyFileSync(DATA_FILE, target);
      const mirror = mirrorBackupFile(target, day);
      appendAudit({ action: 'vault-backup', entry: path.basename(target) });
      return { success: true, data: { file: target, day, mirror } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 备份恢复：把指定备份原子写回正式库。
   * 恢复前先把当前库另存为 vault-prerestore-<时间>.enc（后悔药），恢复后清缓存并退回登录页
   * —— 备份可能是旧主密码加密的，必须重新走一次解锁来验证。
   */
  ipcMain.handle('backup:restore', async (_event, { name } = {}) => {
    try {
      const safe = path.basename(String(name || ''));
      if (!/^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(safe)) {
        return { success: false, error: '备份文件名不合法' };
      }
      const src = path.join(BACKUP_DIR, safe);
      if (!fs.existsSync(src)) return { success: false, error: '备份文件不存在' };

      // 恢复是「直接写回主库」：先做结构自检，半截/选错的文件一律不覆盖现有密码库。
      // 少了这一步，损坏的备份会把好库盖掉，用户只能靠 pre-restore 快照救回来。
      const inspection = inspectVaultFile(fs.readFileSync(src, 'utf8'));
      if (!inspection.ok) {
        return { success: false, error: `备份文件损坏，已取消恢复（${inspection.error}）` };
      }

      let preRestore = '';
      if (fs.existsSync(DATA_FILE)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
        preRestore = `vault-prerestore-${ts}.enc`;
        fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, preRestore));
        // 反悔用的快照只留最近 5 份，避免无限增长
        const pres = fs.readdirSync(BACKUP_DIR)
          .filter(f => /^vault-prerestore-.*\.enc$/.test(f))
          .sort();
        while (pres.length > 5) {
          try { fs.unlinkSync(path.join(BACKUP_DIR, pres.shift())); } catch { /* ignore */ }
        }
      }

      writeFileAtomic(DATA_FILE, fs.readFileSync(src, 'utf8'));
      clearCaches();
      appendAudit({ action: 'vault-restore', entry: safe });
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('lock-request');
      return { success: true, preRestore };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('backup:open-folder', async () => {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      await shell.openPath(BACKUP_DIR);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- 数据目录：看清楚在哪 / 打开 / 迁移到别的盘 ----
  ipcMain.handle('data:info', () => {
    const stat = (f) => {
      try { const s = fs.statSync(f); return { size: s.size, mtime: s.mtime.toISOString() }; } catch { return null; }
    };
    return {
      success: true,
      data: {
        dataDir: DATA_DIR,
        defaultDir: USER_DATA_DIR,
        isCustom: path.resolve(DATA_DIR) !== path.resolve(USER_DATA_DIR),
        vaultFile: DATA_FILE,
        backupDir: BACKUP_DIR,
        attachDir: ATTACH_DIR,
        backupCount: listBackups().length,
        vault: stat(DATA_FILE),
        bak: stat(`${DATA_FILE}.bak`),
      },
    };
  });

  ipcMain.handle('data:open-folder', async (_event, { which } = {}) => {
    const target = which === 'backups' ? BACKUP_DIR : DATA_DIR;
    try {
      fs.mkdirSync(target, { recursive: true });
      await shell.openPath(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 迁移：只复制不删除，旧目录原样保留；写指针文件后需要重启才生效 */
  ipcMain.handle('data:migrate', async () => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择新的数据目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      const target = r.filePaths[0];
      if (path.resolve(target) === path.resolve(DATA_DIR)) return { success: false, error: '这就是当前数据目录' };

      const copied = [];
      for (const f of ['vault.enc', 'vault.enc.bak', 'trash.enc', 'trash.enc.bak', 'settings.json', 'audit.log', 'window-state.json']) {
        const src = path.join(DATA_DIR, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(target, f));
          copied.push(f);
        }
      }
      for (const d of ['backups', 'attachments']) {
        const src = path.join(DATA_DIR, d);
        if (fs.existsSync(src)) {
          fs.cpSync(src, path.join(target, d), { recursive: true });
          copied.push(`${d}/`);
        }
      }
      fs.writeFileSync(LOCATION_FILE, JSON.stringify({ dir: target, from: DATA_DIR, at: new Date().toISOString() }, null, 2), 'utf8');
      appendAudit({ action: 'data-migrate', entry: target });
      return { success: true, data: { dir: target, copied } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 改回默认目录（userData） */
  ipcMain.handle('data:reset-location', () => {
    try {
      if (fs.existsSync(LOCATION_FILE)) fs.unlinkSync(LOCATION_FILE);
      return { success: true, data: { dir: USER_DATA_DIR } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- 审计日志 ----
  ipcMain.handle('audit:log', (_event, entry) => {
    if (!entry || !entry.action) return { success: false };
    appendAudit({ action: String(entry.action).slice(0, 40), detail: String(entry.detail || '').slice(0, 200) });
    return { success: true };
  });

  ipcMain.handle('audit:list', (_event, limit) => ({ success: true, data: readAudit(Number(limit) || 200) }));

  ipcMain.handle('audit:clear', () => {
    try { fs.writeFileSync(AUDIT_FILE, '', 'utf8'); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
  });
}

module.exports = { registerDataIpc };
