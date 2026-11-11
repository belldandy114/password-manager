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
const { auditVault } = require('./vault-audit');
const { logPath, tail: logTail } = require('./app-log');

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
    loadVault,
    getPassword,
    attachmentFile,
    decrypt,
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

  // ---- 库自检（只读体检）----
  /**
   * 体检当前库：结构、悬空标签、丢失的附件、孤儿历史。
   * 只读 —— 报告里的问题一律由用户自己决定怎么处理，这里绝不自动改数据。
   */
  ipcMain.handle('vault:audit', () => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    const vault = loadVault(pw);
    if (!vault) return { success: false, error: '数据损坏，无法读取' };
    try {
      const report = auditVault(vault, {
        attachmentExists: (id) => {
          try { return fs.existsSync(attachmentFile(id)); } catch { return false; }
        },
      });
      return { success: true, data: report };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 恢复演练：拿一份备份，用当前主密码解开、体检，**不碰正式库**。
   *
   * 为什么需要：备份文件存在 ≠ 备份能用。主密码改过之后，旧备份是用旧密码加密的，
   * 平时完全看不出来，真出事要恢复时才发现解不开。演练就是提前把这件事试一遍。
   */
  ipcMain.handle('vault:restore-drill', (_event, { name } = {}) => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    try {
      const safe = path.basename(String(name || ''));
      if (!/^vault-\d{4}-\d{2}-\d{2}\.enc$/.test(safe)) {
        return { success: false, error: '备份文件名不合法' };
      }
      const src = path.join(BACKUP_DIR, safe);
      if (!fs.existsSync(src)) return { success: false, error: '备份文件不存在' };

      const text = fs.readFileSync(src, 'utf8');
      const inspection = inspectVaultFile(text);
      if (!inspection.ok) {
        return { success: true, data: { name: safe, ok: false, stage: 'format', error: inspection.error } };
      }
      const json = decrypt(text, pw);
      if (!json) {
        return {
          success: true,
          data: {
            name: safe,
            ok: false,
            stage: 'decrypt',
            error: '用当前主密码解不开（多半是改密码之前的备份，需要用当时的密码恢复）',
          },
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { success: true, data: { name: safe, ok: false, stage: 'parse', error: '解密成功但内容不是合法 JSON' } };
      }
      const report = auditVault(parsed, {
        attachmentExists: (id) => {
          try { return fs.existsSync(attachmentFile(id)); } catch { return false; }
        },
      });
      return {
        success: true,
        data: {
          name: safe,
          ok: report.ok,
          stage: 'done',
          bytes: inspection.bytes,
          report,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 导出诊断包：把日志、环境信息、库自检结果打成一个文本文件。
   * 不含密码、不含条目内容 —— 只放「排障需要的最小集合」。
   */
  ipcMain.handle('log:export-diagnostic', async () => {
    try {
      const r = await dialog.showSaveDialog(getMainWindow(), {
        title: '导出诊断包',
        defaultPath: `诊断包-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }],
      });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };

      const pw = getPassword();
      let auditText = '（未解锁，跳过库自检）';
      if (pw) {
        const vault = loadVault(pw);
        if (vault) {
          try {
            const rep = auditVault(vault, {
              attachmentExists: (id) => {
                try { return fs.existsSync(attachmentFile(id)); } catch { return false; }
              },
            });
            auditText = [
              `结构版本: v${rep.schemaVersion}`,
              `统计: ${JSON.stringify(rep.stats)}`,
              `问题: error ${rep.counts.error} / warn ${rep.counts.warn} / info ${rep.counts.info}`,
              ...rep.issues.map(i => `  [${i.level}] ${i.code} ×${i.count} — ${i.message}`),
            ].join('\n');
          } catch (e) {
            auditText = `（自检失败：${e.message}）`;
          }
        }
      }

      const backups = listBackups();
      const lines = [
        '===== 测试中台 诊断包 =====',
        `导出时间: ${new Date().toISOString()}`,
        `应用版本: ${process.env.PM_APP_VERSION || app.getVersion()}`,
        `Electron: ${process.versions.electron}  Chrome: ${process.versions.chrome}  Node: ${process.versions.node}`,
        `平台: ${process.platform} ${process.arch}  ${process.getSystemVersion ? process.getSystemVersion() : ''}`,
        `数据目录: ${DATA_DIR}`,
        `默认目录: ${USER_DATA_DIR}`,
        `库文件: ${fs.existsSync(DATA_FILE) ? `${fs.statSync(DATA_FILE).size} 字节` : '不存在'}`,
        `备份: ${backups.length} 份${backups[0] ? `，最近 ${backups[0].name}` : ''}`,
        `异地备份: ${backupMirrorDir() || '未配置'}`,
        '',
        '===== 库自检 =====',
        auditText,
        '',
        '===== 运行日志（最近 400 行）=====',
        logTail(400) || '（没有日志）',
      ];
      fs.writeFileSync(r.filePath, lines.join('\n'), 'utf8');
      appendAudit({ action: 'diagnostic-export', entry: path.basename(r.filePath) });
      return { success: true, data: { file: r.filePath } };
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
