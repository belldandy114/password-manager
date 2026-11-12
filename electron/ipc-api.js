'use strict';

/**
 * 接口调试 / 通用存储 / 附件 / 密码历史 的 IPC。
 *
 * 从 main.js 的 setupIpcHandlers() 里搬出来，逐行保持原逻辑不变：
 *   - file:pick / file:save-text：文件对话框（导出 CSV 带 UTF-8 BOM，Excel 不乱码）；
 *   - ws:get / ws:set：给 snippets/notes/checklists 等扩展模块用的通用集合读写；
 *   - history:get：条目密码历史；
 *   - attachment:pick / open / delete：条目附件（会话密钥加密，落 attachments/<id>.enc）；
 *   - api:send / api:cookies / api:cookies-clear：接口调试的 HTTP 客户端与会话 Cookie 罐。
 *
 * Cookie 罐只放内存、不落盘：这些是别人的登录态 token，落盘等于把凭证明文写在磁盘上。
 * 锁定 / 退出时由 main.js 的 clearCaches() 调 clearApiJar() 一并清空。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, ipcMain, dialog, shell } = require('electron');
const { parseMultipartLine } = require('./multipart');
const { decodeTextBuffer, encodingLabel } = require('./text-encoding');

/** file:read-text 允许的文本扩展名与大小上限（脱敏工具按列处理用） */
const TEXT_EXTS = ['.csv', '.tsv', '.txt', '.json', '.log', '.md', '.sql'];
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

const apiJar = new Map(); // origin -> Map(name -> { value, expiresAt })

function apiJarAbsorb(origin, setCookieList) {
  let jar = apiJar.get(origin);
  if (!jar) { jar = new Map(); apiJar.set(origin, jar); }
  for (const raw of setCookieList || []) {
    const parts = String(raw).split(';');
    const first = parts.shift() || '';
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    let expiresAt = 0; // 0 = 会话级
    let expireFlag = 0; // -1 = 立即删除
    for (const p of parts) {
      const eq = p.indexOf('=');
      const k = (eq > 0 ? p.slice(0, eq) : p).trim().toLowerCase();
      const v = eq > 0 ? p.slice(eq + 1).trim() : '';
      if (k === 'max-age') {
        const n = Number(v);
        if (Number.isFinite(n)) expireFlag = n <= 0 ? -1 : 0, expiresAt = n <= 0 ? 0 : Date.now() + n * 1000;
      } else if (k === 'expires') {
        const t = Date.parse(v);
        if (Number.isFinite(t)) { expiresAt = t; expireFlag = t <= Date.now() ? -1 : 0; }
      }
    }
    if (expireFlag === -1) jar.delete(name);
    else jar.set(name, { value, expiresAt });
  }
  if (!jar.size) apiJar.delete(origin);
}

function apiJarHeader(origin) {
  const jar = apiJar.get(origin);
  if (!jar || !jar.size) return '';
  const out = [];
  for (const [name, v] of jar) {
    if (v.expiresAt > 0 && v.expiresAt <= Date.now()) { jar.delete(name); continue; }
    out.push(`${name}=${v.value}`);
  }
  return out.join('; ');
}

function apiJarList(origin) {
  const rows = [];
  for (const [o, jar] of apiJar) {
    if (origin && o !== origin) continue;
    for (const [name, v] of jar) {
      if (v.expiresAt > 0 && v.expiresAt <= Date.now()) continue;
      rows.push({ origin: o, name, expiresAt: v.expiresAt });
    }
  }
  return rows;
}

/** 锁定 / 退出时清空会话 Cookie（由 main.js 的 clearCaches 调用） */
function clearApiJar() {
  apiJar.clear();
}

/**
 * @param {{
 *   getPassword: () => string | null,
 *   getMainWindow: () => any,
 *   loadVault: (password: string) => any,
 *   saveVault: (vault: any, password: string) => void,
 *   encrypt: (plain: string, password: string) => string,
 *   readAttachment: (id: string, password: string) => string | null,
 *   attachmentFile: (id: string) => string,
 *   attachDir: string,
 *   vaultCollections: string[],
 * }} deps
 */
function registerApiIpc(deps) {
  const {
    getPassword, getMainWindow, loadVault, saveVault, encrypt,
    readAttachment, attachmentFile, attachDir, vaultCollections,
  } = deps;
  const pw = () => getPassword();

  /** 选任意文件（接口调试上传附件用） */
  ipcMain.handle('file:pick', async (_event, { title, filters } = {}) => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        title: title || '选择文件',
        properties: ['openFile'],
        filters: filters || undefined,
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      return { success: true, data: { file: r.filePaths[0], name: path.basename(r.filePaths[0]) } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 保存文本文件（导出 CSV 等）：带 UTF-8 BOM，Excel 打开不乱码 */
  ipcMain.handle('file:save-text', async (_event, { content, defaultName, filters } = {}) => {
    try {
      const r = await dialog.showSaveDialog(getMainWindow(), {
        defaultPath: defaultName || 'export.csv',
        filters: filters || [{ name: 'CSV 文件', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };
      fs.writeFileSync(r.filePath, '\uFEFF' + String(content ?? ''), 'utf8');
      return { success: true, data: { file: r.filePath } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 读取文本文件（脱敏工具「上传文件按列脱敏」用）。
   * 只读文本类扩展名，且限制 8MB——这里不是通用文件浏览器，别让它变成任意读盘入口。
   */
  ipcMain.handle('file:read-text', async (_event, { file, maxBytes } = {}) => {
    try {
      const target = String(file || '');
      if (!target) return { success: false, error: '没有选择文件' };
      const ext = path.extname(target).toLowerCase();
      if (!TEXT_EXTS.includes(ext)) {
        return { success: false, error: `只支持 ${TEXT_EXTS.join(' / ')} 文本文件` };
      }
      const st = fs.statSync(target);
      if (!st.isFile()) return { success: false, error: '不是一个文件' };
      const limit = Math.min(Number(maxBytes) > 0 ? Number(maxBytes) : MAX_TEXT_BYTES, MAX_TEXT_BYTES);
      if (st.size > limit) {
        return { success: false, error: `文件太大（${(st.size / 1024 / 1024).toFixed(1)} MB），上限 ${Math.round(limit / 1024 / 1024)} MB` };
      }
      // 不能硬编码 utf8：Excel 中文环境另存的 CSV 是 GBK，按 UTF-8 读会全是「����」
      const decoded = decodeTextBuffer(fs.readFileSync(target));
      return {
        success: true,
        data: {
          text: decoded.text.replace(/^\uFEFF/, ''),
          name: path.basename(target),
          size: st.size,
          encoding: decoded.encoding,
          encodingLabel: encodingLabel(decoded.encoding),
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- Generic storage for the extra modules (snippets/notes/checklists/…) ----
  ipcMain.handle('ws:get', (_event, key) => {
    if (!pw()) return { success: false, error: '未解锁' };
    if (!vaultCollections.includes(key)) return { success: false, error: '无效的数据类型' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault[key] };
  });

  ipcMain.handle('ws:set', (_event, { key, value }) => {
    if (!pw()) return { success: false, error: '未解锁' };
    if (!vaultCollections.includes(key)) return { success: false, error: '无效的数据类型' };
    if (!Array.isArray(value)) return { success: false, error: '数据格式错误' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    vault[key] = value;
    saveVault(vault, pw());
    return { success: true, data: value };
  });

  // ---- Password history ----
  ipcMain.handle('history:get', (_event, entryId) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault.history[entryId] || [] };
  });

  // ---- Attachments (encrypted with the session key) ----
  ipcMain.handle('attachment:pick', async () => {
    if (!pw()) return { success: false, error: '未解锁' };
    const result = await dialog.showOpenDialog(getMainWindow(), { properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    try {
      const filePath = result.filePaths[0];
      const st = fs.statSync(filePath);
      if (st.size > 20 * 1024 * 1024) return { success: false, error: '附件不能超过 20MB' };
      const buf = fs.readFileSync(filePath);
      const id = crypto.randomUUID();
      fs.mkdirSync(attachDir, { recursive: true });
      fs.writeFileSync(attachmentFile(id), encrypt(buf.toString('base64'), pw()), 'utf8');
      return {
        success: true,
        data: { id, name: path.basename(filePath), size: st.size, addedAt: new Date().toISOString() },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('attachment:open', async (_event, { id, name }) => {
    if (!pw()) return { success: false, error: '未解锁' };
    try {
      const b64 = readAttachment(id, pw());
      if (!b64) return { success: false, error: '附件不存在或已损坏' };
      const dir = path.join(app.getPath('temp'), 'pm-attachments');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, name || `${id}.bin`);
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
      await shell.openPath(target);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('attachment:delete', async (_event, { id }) => {
    try {
      const file = attachmentFile(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---- HTTP client for the API debugger ----
  ipcMain.handle('api:send', async (_event, {
    method = 'GET', url, headers = '', body = '', bodyType = 'json', rawContentType = '', autoSession = true,
  }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return { success: false, error: 'URL 必须以 http:// 或 https:// 开头' };
    }
    const started = Date.now();
    let origin = '';
    try { origin = new URL(url).origin; } catch { /* 上面已校验过 */ }
    try {
      const hdrs = {};
      String(headers || '').split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) hdrs[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      });
      // 会话保持：把 Cookie 罐里该站点的 cookie 合并进请求头。
      // 用户手写的 Cookie 优先级更高（同名不覆盖），并且手写时整体不注入，避免意外改动请求。
      if (autoSession) {
        const jar = apiJarHeader(origin);
        const ckKey = Object.keys(hdrs).find(k => k.toLowerCase() === 'cookie');
        if (!ckKey && jar) hdrs['Cookie'] = jar;
      }
      // 用户自己写了 Content-Type 就不覆盖
      const hasCT = () => Object.keys(hdrs).some(k => k.toLowerCase() === 'content-type');
      const setCT = (v) => { if (!hasCT()) hdrs['Content-Type'] = v; };

      const init = { method: method.toUpperCase(), headers: hdrs };
      const canHaveBody = !['GET', 'HEAD'].includes(init.method);
      if (canHaveBody && bodyType !== 'none' && body) {
        if (bodyType === 'form') {
          // key=value 每行一个 → x-www-form-urlencoded
          const params = new URLSearchParams();
          String(body).split('\n').forEach(line => {
            const i = line.indexOf('=');
            if (i > 0) params.append(line.slice(0, i).trim(), line.slice(i + 1));
          });
          init.body = params.toString();
          setCT('application/x-www-form-urlencoded; charset=UTF-8');
        } else if (bodyType === 'multipart') {
          // key=value 每行一个；value 以 @ 开头视为文件路径（支持 curl 的 ;type= / ;filename= 语法）
          const fd = new FormData();
          const lines = String(body).split('\n').filter(l => l.trim());
          for (const line of lines) {
            const p = parseMultipartLine(line);
            if (!p.ok) continue;
            if (p.isFile) {
              if (!p.filePath || !fs.existsSync(p.filePath)) {
                // cURL 导入的文件字段只有文件名、没有内容，必须让用户重新选一次
                return {
                  success: false,
                  error: `上传文件不存在：${p.filePath || '(空)'}。如果是从 cURL 导入的文件字段，请点「选择文件」重新指定本地文件。`,
                };
              }
              // 带上 MIME：不少服务端会校验 part 的 Content-Type，缺省 octet-stream 会被拒
              const mime = p.mime || 'application/octet-stream';
              const name = p.filename || path.basename(p.filePath);
              fd.append(p.key, new Blob([fs.readFileSync(p.filePath)], { type: mime }), name);
            } else {
              fd.append(p.key, p.value);
            }
          }
          // 不要手动设 Content-Type：fetch 会按 FormData 自动带 boundary。
          // 用户如果自己写了 Content-Type（常见从别处粘过来的 multipart/form-data 无 boundary），
          // 会让请求体解析失败，这里直接去掉，交给 fetch 生成。
          Object.keys(hdrs).forEach(k => { if (k.toLowerCase() === 'content-type') delete hdrs[k]; });
          init.body = fd;
        } else if (bodyType === 'raw') {
          init.body = body;
          setCT(rawContentType || 'text/plain; charset=UTF-8');
        } else {
          init.body = body;
          setCT('application/json; charset=UTF-8');
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      init.signal = controller.signal;

      const res = await fetch(url, init);
      clearTimeout(timer);
      const text = await res.text();
      const resHeaders = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      // undici 的 getSetCookie() 才能拿到「一条一条」的 Set-Cookie；
      // forEach 会把多个 Set-Cookie 用逗号拼成一条，Expires 里的逗号会让解析全乱。
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (resHeaders['set-cookie'] ? [resHeaders['set-cookie']] : []);
      if (autoSession && setCookies.length && origin) apiJarAbsorb(origin, setCookies);
      return {
        success: true,
        data: {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
          setCookies,
          body: text.length > 500000 ? text.slice(0, 500000) + '\n...（响应过大，已截断）' : text,
          size: Buffer.byteLength(text),
          timeMs: Date.now() - started,
        },
      };
    } catch (e) {
      return { success: false, error: e.name === 'AbortError' ? '请求超时（30 秒）' : e.message };
    }
  });

  // ---- 会话 Cookie 罐（接口调试用） ----
  ipcMain.handle('api:cookies', (_event, { origin } = {}) => ({ success: true, data: apiJarList(origin) }));

  ipcMain.handle('api:cookies-clear', (_event, { origin } = {}) => {
    if (origin) apiJar.delete(origin);
    else apiJar.clear();
    return { success: true, data: apiJarList() };
  });
}

module.exports = { registerApiIpc, clearApiJar };
