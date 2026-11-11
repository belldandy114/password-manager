'use strict';
/**
 * 整库导入 / 导出 IPC（CSV / JSON / XLSX / HTML 书签 / 加密备份）。
 *
 * 拆出来的原因：这段逻辑原本在 setupIpcHandlers() 里，`export:plain` 与
 * `export:selected-plain` 的 CSV/XLSX 拼装是逐行复制的，改一处很容易漏另一处。
 * 现在两条路径共用 buildPlainExport()，行为保持与拆分前逐字节一致。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain } = require('electron');

/** CSV 表头（导出用，顺序即列顺序） */
const CSV_FIELDS = ['name', 'envType', 'url', 'username', 'password', 'notes', 'tags', 'createdAt', 'updatedAt'];
const CSV_HEADERS = {
  name: '名称', envType: '环境类型', url: '网址', username: '账号',
  password: '密码', notes: '备注', tags: '标签', createdAt: '创建时间', updatedAt: '修改时间',
};

/**
 * 把条目列表按 format 渲染成可下载的字符串（json / xlsx(base64) / csv）。
 * @param {any[]} entries
 * @param {string} format
 */
function buildPlainExport(entries, format, XLSX) {
  if (format === 'json') return JSON.stringify(entries, null, 2);

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(entries);
    const colWidths = Object.keys(entries[0] || {}).map(k => ({ wch: Math.max(k.length * 2, 15) }));
    ws['!cols'] = colWidths;
    XLSX.utils.book_append_sheet(wb, ws, '密码网址');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return buf.toString('base64');
  }

  let output = CSV_FIELDS.map(k => CSV_HEADERS[k] || k).join(',') + '\n';
  entries.forEach(e => {
    output += CSV_FIELDS.map(k => {
      const v = e[k];
      if (Array.isArray(v)) return `"${v.join(';')}"`;
      return `"${(v || '').toString().replace(/"/g, '""')}"`;
    }).join(',') + '\n';
  });
  return output;
}

/**
 * 按 filter 过滤条目：production / testing / tag:xxx。
 * @param {any[]} entries
 * @param {string} filter
 */
function filterEntries(entries, filter) {
  if (filter === 'production') return entries.filter(e => e.envType === 'production');
  if (filter === 'testing') return entries.filter(e => e.envType === 'testing');
  if (filter && filter.startsWith('tag:')) {
    const tag = filter.slice(4);
    return entries.filter(e => e.tags && e.tags.includes(tag));
  }
  return entries;
}

/**
 * 判重键：url + 用户名（同一网址不同账号不算重复；没有 url 时退回 name + 用户名）。
 * @param {any} e
 */
function dupKey(e) {
  const url = String(e && e.url || '').trim().toLowerCase().replace(/\/+$/, '');
  const user = String(e && e.username || '').trim().toLowerCase();
  const name = String(e && e.name || '').trim().toLowerCase();
  return url ? `${url}||${user}` : `name||${name}||${user}`;
}

/**
 * @param {object} deps
 * @param {() => string|null} deps.getPassword
 * @param {() => any} deps.getMainWindow
 * @param {(pw: string) => any} deps.loadVault
 * @param {(vault: any, pw: string) => void} deps.saveVault
 * @param {(text: string, pw: string) => string|null} deps.encrypt
 * @param {(text: string, pw: string) => string|null} deps.decrypt
 * @param {(records: any[]) => any[]} deps.normalizeImportRecords
 * @param {(text: string) => string[][]} deps.parseCsv
 * @param {any} deps.dialog
 * @param {any} deps.XLSX
 */
function registerVaultIoIpc(deps) {
  const { getPassword, getMainWindow, loadVault, saveVault, encrypt, decrypt,
    normalizeImportRecords, parseCsv, dialog, XLSX } = deps;

  // ---- Import ----
  ipcMain.handle('import:csv-json', async (_event, { filePath, password }) => {
    if (!getPassword()) return { success: false, error: '未解锁' };
    try {
      const ext = path.extname(filePath).toLowerCase();
      let records = [];

      if (ext === '.xlsx' || ext === '.xls') {
        const workbook = XLSX.readFile(filePath, { raw: false });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) return { success: false, error: 'Excel文件为空' };
        const sheet = workbook.Sheets[sheetName];
        records = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        if (ext === '.json') {
          records = JSON.parse(content);
          if (!Array.isArray(records)) records = [records];
        } else if (ext === '.csv' || ext === '.txt') {
          const rows = parseCsv(content);
          if (rows.length < 2) return { success: false, error: 'CSV文件格式无效' };
          const headers = rows[0].map(h => h.trim());
          for (let i = 1; i < rows.length; i++) {
            if (rows[i].every(v => !String(v).trim())) continue;
            const obj = {};
            headers.forEach((h, idx) => { obj[h] = rows[i][idx] === undefined ? '' : rows[i][idx]; });
            records.push(obj);
          }
          // CSV has no way to keep the original timestamps apart from these columns;
          // they are mapped by normalizeImportRecords like any other field.
        } else if (ext === '.html' || ext === '.htm') {
          const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
          let match;
          while ((match = linkRegex.exec(content)) !== null) {
            const url = match[1];
            const name = match[2].trim();
            if (url && !url.startsWith('javascript:') && !url.startsWith('place:')) {
              records.push({ name, url, username: '', password: '', notes: '', envType: 'production', tags: '' });
            }
          }
        }
      }
      const normalized = normalizeImportRecords(records);
      // 一列都没认出来（比如用户的表头是自定义中文）时，把原始记录交回去，
      // 让界面上的手动字段映射派上用场，而不是直接报「没有可导入的数据」。
      if (normalized.length === 0 && records.length > 0) {
        return { success: true, data: records, raw: true };
      }
      return { success: true, data: normalized };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- Import encrypted backup ----
  ipcMain.handle('import:encrypted', async (_event, { filePath, importPassword }) => {
    if (!getPassword()) return { success: false, error: '未解锁' };
    try {
      // Try reading as text (base64 string format from this app's export)
      let rawContent = fs.readFileSync(filePath, 'utf8').trim();
      // Strip UTF-8 BOM if present
      if (rawContent.charCodeAt(0) === 0xFEFF) rawContent = rawContent.slice(1).trim();

      let decrypted = decrypt(rawContent, importPassword);

      // If text decryption failed, try reading as binary and convert to base64
      if (!decrypted) {
        const binaryBuf = fs.readFileSync(filePath);
        const b64Content = binaryBuf.toString('base64');
        decrypted = decrypt(b64Content, importPassword);
      }

      if (!decrypted) return { success: false, error: '密码错误或文件损坏' };
      const data = JSON.parse(decrypted);
      if (!data.entries || !Array.isArray(data.entries)) {
        return { success: false, error: '无效的加密备份文件' };
      }
      return { success: true, data: data.entries };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('import:confirm', (_event, { entries, conflictStrategy }) => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    const vault = loadVault(pw);
    if (!vault) return { success: false, error: '数据损坏' };

    const existingMap = new Map();
    vault.entries.forEach(e => existingMap.set(dupKey(e), e));

    const now = new Date().toISOString();
    let importedCount = 0;

    entries.forEach(entry => {
      const existing = existingMap.get(dupKey(entry));
      if (existing) {
        if (conflictStrategy === 'skip') return;
        if (conflictStrategy === 'overwrite') {
          Object.assign(existing, entry);
          existing.updatedAt = now;
          importedCount++;
          return;
        }
        if (conflictStrategy === 'duplicate') {
          // fall through to add
        } else {
          return; // unknown strategy, skip
        }
      }
      vault.entries.push({
        ...entry,
        id: entry.id || crypto.randomUUID(),
        createdAt: entry.createdAt || now,
        updatedAt: now,
      });
      importedCount++;
      if (entry.tags) {
        entry.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
      }
    });

    saveVault(vault, pw);
    return { success: true, data: vault, importedCount };
  });

  // ---- Import template ----
  ipcMain.handle('import:download-template', async () => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      defaultPath: '导入模板.xlsx',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const wb = XLSX.utils.book_new();
    const ws_data = XLSX.utils.aoa_to_sheet([
      ['名称', 'URL', '账号', '密码', '备注', '标签', '环境类型'],
      ['示例网站', 'https://example.com', 'admin', 'P@ssw0rd', '备注信息', '工作;重要', 'production'],
    ]);
    ws_data['!cols'] = [{ wch: 20 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 20 }, { wch: 15 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws_data, '密码网址');
    XLSX.writeFile(wb, result.filePath);
    return { success: true };
  });

  // ---- Export ----
  ipcMain.handle('export:encrypted', (_event, { exportPassword, filter }) => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    const vault = loadVault(pw);
    if (!vault) return { success: false, error: '数据损坏' };
    const entries = filterEntries(vault.entries, filter);
    const exportData = { entries, tags: vault.tags, exportedAt: new Date().toISOString() };
    const encrypted = encrypt(JSON.stringify(exportData), exportPassword);
    return { success: true, data: encrypted };
  });

  ipcMain.handle('export:plain', (_event, { format, includePasswords, filter }) => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    const vault = loadVault(pw);
    if (!vault) return { success: false, error: '数据损坏' };
    let entries = filterEntries(vault.entries, filter);
    if (!includePasswords) entries = entries.map(e => ({ ...e, password: undefined }));
    return { success: true, data: buildPlainExport(entries, format, XLSX), count: entries.length };
  });

  // ---- Export selected entries by IDs ----
  ipcMain.handle('export:selected-encrypted', (_event, { ids, exportPassword }) => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    const vault = loadVault(pw);
    if (!vault) return { success: false, error: '数据损坏' };
    const entries = vault.entries.filter(e => ids.includes(e.id));
    const exportData = { entries, tags: vault.tags, exportedAt: new Date().toISOString() };
    const encrypted = encrypt(JSON.stringify(exportData), exportPassword);
    return { success: true, data: encrypted, count: entries.length };
  });

  ipcMain.handle('export:selected-plain', (_event, { ids, format, includePasswords }) => {
    const pw = getPassword();
    if (!pw) return { success: false, error: '未解锁' };
    const vault = loadVault(pw);
    if (!vault) return { success: false, error: '数据损坏' };
    let entries = vault.entries.filter(e => ids.includes(e.id));
    if (!includePasswords) entries = entries.map(e => ({ ...e, password: undefined }));
    return { success: true, data: buildPlainExport(entries, format, XLSX), count: entries.length };
  });
}

module.exports = { registerVaultIoIpc, buildPlainExport, filterEntries, dupKey };