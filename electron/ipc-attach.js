'use strict';

/**
 * 图片 / 文件附件 IPC：粘贴截图 → 加密落盘 → 需要时读回。
 *
 * 和老的 `attachment:pick` 复用同一个存储位置与加密方式（attachments/<id>.enc，
 * 会话密钥加密），区别只是入口不同：
 * - pick：文件对话框选文件；
 * - save-image：渲染层从剪贴板拿到 dataURL 直接送过来。
 *
 * 1.24.7：附件目录不再写死。`getAttachDir()` 每次返回当前目录（settings.attachDir
 * 有值就用它），设置页改完立即生效；切换目录时把已有 .enc 复制过去，
 * 复制失败就不切换，避免「设置了新目录、旧图全部失效」。
 *
 * 1.25.1：**笔记附件单独一个目录**。用户反馈「切到目录模式后附件和 .md 混在一起」，
 * 期望的是笔记的截图跟着笔记目录走。做法是给 `attachment:save-image` 加可选
 * `scope: 'note' | 'entry'`（默认 entry）：
 *   - `note` → 写 `<笔记目录>/attachments`（自动创建）；
 *   - 读取时先找笔记目录、再回退全局目录 —— **老附件还在全局目录，不能破坏**。
 * 全局 `getAttachDir()` 保持原样，网址条目的附件不受影响。
 *
 * 依赖注入是为了不碰 main.js 的模块级状态，和 ipc-system / ipc-files 的拆分约定一致。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, dialog, shell } = require('electron');
const {
  parseImageDataUrl, stampedImageName, sniffImageMime, buildImageDataUrl,
} = require('./attach-image');

/** 文件名去掉路径分隔符与控制字符，避免被当成路径用 */
function safeName(raw, fallback) {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80);
  return s || fallback;
}

/**
 * 在 dir 里为 name 找一个不冲突的文件名：重名自动加 `-2` / `-3` 后缀。
 *
 * 批量导出**绝不覆盖**已有文件：用户可能把两次导出放进同一个目录，
 * 覆盖等于静默丢数据（而且丢的是他自己机器上的文件，不是我们的库）。
 * 用 existsSync 逐个试而不是「先收集目录再算」，因为写盘过程中目录可能被别的程序改动。
 */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
    n += 1;
    // 极端情况（同一目录里已有上千个同名文件）兜底，避免死循环
    if (n > 9999) {
      candidate = path.join(dir, `${base}-${Date.now()}${ext}`);
      break;
    }
  }
  return candidate;
}

/**
 * 断言 target 确实落在 dir 内部（防目录穿越）。
 * 用 `dir + path.sep` 前缀比较，避免 `/a/bc` 被 `/a/b` 误判为子路径。
 */
function assertInside(dir, target) {
  const root = path.resolve(dir);
  const full = path.resolve(target);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('目标路径越界');
  }
  return full;
}

/** 把 srcDir 里的 .enc 复制到 dstDir（不覆盖已存在的）；任一条失败就整体报错 */
async function copyEncStrict(srcDir, dstDir) {
  let copied = 0;
  let skipped = 0;
  if (!srcDir || !fs.existsSync(srcDir)) return { copied, skipped };
  if (path.resolve(srcDir) === path.resolve(dstDir)) return { copied, skipped };
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.enc')) continue;
    const from = path.join(srcDir, name);
    const to = path.join(dstDir, name);
    if (fs.existsSync(to)) { skipped += 1; continue; }
    // 异步复制：附件几百张时同步 copy 会把主进程事件循环堵死，界面像卡死
    await fs.promises.copyFile(from, to);
    copied += 1;
  }
  return { copied, skipped };
}

/**
 * @param {{
 *   getPassword: () => string,
 *   getAttachDir: () => string,
 *   defaultAttachDir: string,
 *   setAttachDirOverride: (dir: string) => void,
 *   loadSettings: () => any,
 *   saveSettings: (s: any) => void,
 *   fileOf: (id: string) => string,
 *   encrypt: (plain: string, password: string) => string,
 *   readAttachment: (id: string, password: string) => string | null,
 *   loadVault?: (password: string) => any,
 *   getNotesAttachDir?: () => string,
 *   resolveFile?: (id: string) => string,
 * }} deps
 */
function registerAttachIpc(deps = {}) {
  const getPassword = typeof deps.getPassword === 'function' ? deps.getPassword : () => '';
  const getAttachDir = typeof deps.getAttachDir === 'function' ? deps.getAttachDir : () => '';
  const defaultAttachDir = deps.defaultAttachDir || '';
  const setAttachDirOverride = typeof deps.setAttachDirOverride === 'function' ? deps.setAttachDirOverride : () => {};
  const loadSettings = typeof deps.loadSettings === 'function' ? deps.loadSettings : () => ({});
  const saveSettings = typeof deps.saveSettings === 'function' ? deps.saveSettings : () => {};
  const fileOf = typeof deps.fileOf === 'function'
    ? deps.fileOf
    : (id) => path.join(getAttachDir(), `${id}.enc`);
  const encrypt = deps.encrypt;
  const readAttachment = deps.readAttachment;
  // 可选：批量导出时用来把 id 还原成附件原名（名字只存在 vault 的条目引用里，磁盘上没有）。
  // 没注入也能工作，只是文件名退回 `<id>.bin`。
  const loadVault = typeof deps.loadVault === 'function' ? deps.loadVault : null;

  /**
   * 笔记附件目录（`<笔记目录>/attachments`）。未启用目录模式时返回空串。
   * 由 main.js 注入（它才知道 settings.notesDir 与路径校验规则）。
   */
  const getNotesAttachDir = typeof deps.getNotesAttachDir === 'function' ? deps.getNotesAttachDir : () => '';
  /**
   * 按 id 找**实际存在**的附件文件（先笔记目录、再全局目录）。
   * 没注入时退化成「全局目录下拼路径」，行为与 1.24.7 一致。
   */
  const resolveFile = typeof deps.resolveFile === 'function'
    ? deps.resolveFile
    : (id) => fileOf(id);

  /** 写入目录：scope='note' 且笔记目录可用时写笔记目录，否则写全局目录 */
  const writeDirOf = (scope) => {
    if (String(scope || '') === 'note') {
      const nd = getNotesAttachDir();
      if (nd) return nd;
    }
    return getAttachDir();
  };

  /** 某个 id 的写入路径（新 id 必然不存在，所以就是「该 scope 的目录 + id.enc」） */
  const writeFileOf = (id, scope) => {
    const safe = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
    return path.join(writeDirOf(scope), `${safe}.enc`);
  };

  /** 附件实际所在目录（用于列表 / 定位 / 展示来源） */
  const dirOfFile = (file) => (file ? path.dirname(file) : '');

  ipcMain.handle('attachment:save-image', (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    const parsed = parseImageDataUrl(payload.dataUrl);
    if (!parsed.ok) return { success: false, error: parsed.error };
    try {
      const id = crypto.randomUUID();
      // 1.25.1：笔记里粘贴的截图存到 <笔记目录>/attachments，与 .md 文件放在一起
      const scope = String(payload.scope || '') === 'note' ? 'note' : 'entry';
      const dir = writeDirOf(scope);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(writeFileOf(id, scope), encrypt(parsed.base64, password), 'utf8');
      return {
        success: true,
        data: {
          id,
          name: safeName(payload.name, stampedImageName(parsed.ext)),
          size: parsed.size,
          mime: parsed.mime,
          kind: 'image',
          addedAt: new Date().toISOString(),
          // 回传落点：渲染层能显示「存在笔记目录 / 全局目录」，也方便排障
          scope,
          dir,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('attachment:read-image', (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    if (!payload.id) return { success: false, error: '缺少附件 id' };
    try {
      const b64 = readAttachment(payload.id, password);
      if (!b64) return { success: false, code: 'missing', error: '附件不存在或已损坏' };
      const mime = sniffImageMime(b64);
      if (!mime) return { success: false, code: 'not-image', error: '不是支持的图片格式' };
      return { success: true, data: { dataUrl: buildImageDataUrl(mime, b64), mime } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 文本预览（证书 / 密钥 / 配置这类非图片附件）。
   * 只解前 128KB 判断是否像文本，返回最多 64KB；二进制一律拒绝、提示导出。
   */
  ipcMain.handle('attachment:text-preview', (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    if (!payload.id) return { success: false, error: '缺少附件 id' };
    try {
      const b64 = readAttachment(payload.id, password);
      if (!b64) return { success: false, code: 'missing', error: '附件不存在或已损坏' };
      const buf = Buffer.from(b64, 'base64');
      const head = buf.subarray(0, 128 * 1024);
      // 含 NUL 字节基本就是二进制；UTF-8 替换符过多也按二进制处理
      if (head.includes(0)) return { success: false, code: 'binary', error: '这是二进制文件，请导出后查看' };
      const text = head.toString('utf8');
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad > text.length * 0.02) return { success: false, code: 'binary', error: '这是二进制文件，请导出后查看' };
      return {
        success: true,
        data: {
          text: text.slice(0, 64 * 1024),
          size: buf.length,
          truncated: buf.length > 64 * 1024,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 列出附件目录里的全部文件（附件集中管理页用）。
   *
   * 只返回 id / 大小 / 修改时间，**不返回内容**：一页可能几百个附件，
   * 全解密成 base64 送过去会直接把渲染进程撑爆；缩略图由页面按需逐张读。
   * 「属于谁」由渲染层拿 vault 里的引用关系去对，主进程不碰业务数据。
   *
   * 1.25.1：同时列**两个**目录（笔记目录 + 全局目录），每条带 `scope` 标明来源。
   * 同一个 id 只出一条（先笔记目录优先，与读取顺序一致），避免附件页出现重复卡片。
   */
  ipcMain.handle('attachment:list', () => {
    try {
      const globalDir = getAttachDir();
      const notesDir = getNotesAttachDir();
      const sources = [];
      if (notesDir) sources.push({ dir: notesDir, scope: 'note' });
      sources.push({ dir: globalDir, scope: 'entry' });

      const out = [];
      const seen = new Set();
      let anyExists = false;
      for (const { dir, scope } of sources) {
        let exists = false;
        try { exists = fs.existsSync(dir); } catch { exists = false; }
        if (exists) anyExists = true;
        if (!exists) continue;
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.enc')) continue;
          const id = name.slice(0, -4);
          if (seen.has(id)) continue;
          try {
            const file = path.join(dir, name);
            const st = fs.statSync(file);
            if (!st.isFile()) continue;
            seen.add(id);
            out.push({ id, size: st.size, updatedAt: new Date(st.mtimeMs).toISOString(), dir, file, scope });
          } catch { /* 单个文件读不到就跳过 */ }
        }
      }
      out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      // dir 单独回传：目录为空/不存在时也能在界面上显示「附件存在哪个文件夹」
      return {
        success: true,
        data: out,
        dir: globalDir,
        dirExists: anyExists,
        notesDir: notesDir || '',
        notesDirExists: notesDir ? fs.existsSync(notesDir) : false,
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 当前附件目录信息（设置页 / 附件页展示与「改回默认」判断） */
  ipcMain.handle('attachment:dir-info', () => {
    const dir = getAttachDir();
    const notesDir = getNotesAttachDir();
    return {
      success: true,
      data: {
        dir,
        defaultDir: defaultAttachDir,
        isCustom: path.resolve(dir) !== path.resolve(defaultAttachDir),
        exists: fs.existsSync(dir),
        // 1.25.1：笔记附件目录（<笔记目录>/attachments），未启用目录模式时为空
        notesDir: notesDir || '',
        notesDirExists: notesDir ? fs.existsSync(notesDir) : false,
      },
    };
  });

  /**
   * 确保笔记附件目录存在（1.25.1）。
   *
   * 用户要求「切换笔记目录后，在该目录下自动创建 attachments 文件夹」。
   * 切换目录本身走的是 `settings:save`（写 notesDir），主进程没有「目录切换」事件，
   * 所以由渲染层在切完目录 / 进入目录模式时调一次这里，把文件夹建出来 ——
   * 这样用户切完目录去资源管理器里就能看到 attachments，而不是等第一次粘贴截图才出现。
   *
   * 只创建 `<notesDir>/attachments`，**不碰**全局附件目录。
   */
  ipcMain.handle('attachment:ensure-note-dir', () => {
    try {
      const notesDir = getNotesAttachDir();
      if (!notesDir) return { success: true, data: { dir: '', created: false, reason: '未启用目录模式' } };
      const existed = fs.existsSync(notesDir);
      fs.mkdirSync(notesDir, { recursive: true });
      return { success: true, data: { dir: notesDir, created: !existed } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /** 选一个目录（不立即切换，交给 attachment:set-dir） */
  ipcMain.handle('attachment:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog({
        title: '选择附件存放目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      return { success: true, data: { dir: r.filePaths[0] } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 切换附件目录（空 dir = 改回默认）。
   * 先把现有 .enc 复制到新目录，全部成功才切换并写设置 —— 中途失败就保持原状。
   */
  ipcMain.handle('attachment:set-dir', async (_event, payload = {}) => {
    const want = String(payload.dir || '').trim();
    const reset = !want;
    const target = reset ? defaultAttachDir : want;
    if (!target) return { success: false, error: '默认附件目录不可用' };
    if (!path.isAbsolute(target)) return { success: false, error: '请选择绝对路径' };
    try {
      fs.mkdirSync(target, { recursive: true });
      // 可写校验：真的写一个临时文件，比 accessSync 可靠（网络盘/只读盘）
      const probe = path.join(target, `.pm-write-test-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (e) {
      return { success: false, error: `目录不可写：${e.message}` };
    }

    const from = getAttachDir();
    let moved = { copied: 0, skipped: 0 };
    try {
      moved = await copyEncStrict(from, target);
    } catch (e) {
      return { success: false, error: `复制附件失败，已保持原目录：${e.message}` };
    }

    try {
      const s = loadSettings() || {};
      s.attachDir = reset ? '' : target;
      saveSettings(s);
      setAttachDirOverride(reset ? '' : target);
    } catch (e) {
      return { success: false, error: `写入设置失败：${e.message}` };
    }

    return {
      success: true,
      data: { dir: target, from, copied: moved.copied, skipped: moved.skipped, reset },
    };
  });

  /** 在资源管理器里定位附件（带 id 定位 .enc 文件，不带 id 打开附件目录） */
  ipcMain.handle('attachment:reveal', (_event, payload = {}) => {
    try {
      const id = String(payload.id || '').replace(/[^a-zA-Z0-9-]/g, '');
      // 1.25.1：先按 id 找实际所在目录（笔记目录 / 全局目录），找不到再退回全局目录
      const file = id ? resolveFile(id) : '';
      const dir = file ? dirOfFile(file) : getAttachDir();
      if (file && fs.existsSync(file)) shell.showItemInFolder(file);
      else if (fs.existsSync(dir)) shell.openPath(dir);
      else return { success: false, error: '附件目录不存在' };
      return { success: true, data: { dir, file } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 把附件解密后另存到用户选的位置（导出）。
   * 走 dialog 在主进程里选路径，避免渲染层拿到任意写权限。
   */
  ipcMain.handle('attachment:export', async (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };
    if (!payload.id) return { success: false, error: '缺少附件 id' };
    try {
      const b64 = readAttachment(payload.id, password);
      if (!b64) return { success: false, error: '附件不存在或已损坏' };
      const mime = sniffImageMime(b64);
      // 扩展名优先用调用方给的原文件名（密钥/证书这类非图片附件只能靠它），
      // 其次按图片魔数推，最后兜底 .bin
      const nameExt = path.extname(String(payload.name || '')).replace(/^\./, '').toLowerCase();
      const ext = nameExt || (mime ? mime.replace('image/', '').replace('jpeg', 'jpg') : 'bin');
      const r = await dialog.showSaveDialog({
        defaultPath: safeName(payload.name, `附件-${payload.id.slice(0, 8)}.${ext}`),
      });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };
      fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
      return { success: true, data: { file: r.filePath } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  /**
   * 批量导出到用户选的目录（1.25.0）。
   *
   * 换机/交接时一个个点「导出」太慢。规则：
   * - 选一次目录，逐个解密写盘；**单个失败不影响其它**（最后汇总 failed 数）；
   * - 文件名用附件原名，重名自动加 `-2`/`-3`，**绝不覆盖**已有文件；
   * - 文件名必须过 safeName + 落在目标目录内（附件名来自 vault，属于不可信输入）。
   *
   * 原文件名从哪来：优先 `payload.names`（渲染层顺手带过来的 id→name 映射），
   * 其次注入的 `loadVault`（从条目引用里查），都没有就退回 `<id>.bin`。
   * 主进程不主动读库是为了不把「附件导出」和「vault 解密」耦合在一起。
   */
  ipcMain.handle('attachment:export-many', async (_event, payload = {}) => {
    const password = getPassword();
    if (!password) return { success: false, error: '未解锁' };

    const ids = Array.isArray(payload.ids) ? payload.ids : null;
    if (!ids || ids.length === 0) return { success: false, error: '请先选择要导出的附件' };

    // id → 原名。两种来源都接受，缺失就靠 id 兜底。
    const nameOf = new Map();
    if (payload.names && typeof payload.names === 'object') {
      for (const [id, name] of Object.entries(payload.names)) {
        if (name) nameOf.set(String(id), String(name));
      }
    }
    if (loadVault) {
      try {
        const vault = loadVault(password);
        for (const e of (vault && vault.entries) || []) {
          for (const a of e.attachments || []) {
            if (a && a.id && a.name && !nameOf.has(String(a.id))) nameOf.set(String(a.id), String(a.name));
          }
        }
      } catch { /* 查不到原名不影响导出，退回 id.bin */ }
    }

    let dir;
    try {
      const r = await dialog.showOpenDialog({
        title: '选择附件导出目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      dir = r.filePaths[0];
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return { success: false, error: e.message };
    }

    const files = [];
    let exported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];
    const seen = new Set();

    for (const rawId of ids) {
      const id = String(rawId || '').replace(/[^a-zA-Z0-9-]/g, '');
      // 空 id / 重复 id 直接跳过：重复导出同一个附件只会产生一堆 -2/-3 副本
      if (!id || seen.has(id)) { skipped += 1; continue; }
      seen.add(id);
      try {
        const b64 = readAttachment(id, password);
        if (!b64) { skipped += 1; continue; }
        const original = nameOf.get(id) || '';
        // 原名可能带子目录（"截图/a.png"），basename 后再过白名单，双保险
        const base = safeName(path.basename(original), '');
        // 没有原名时用 `<id>.bin`，**不按魔数猜扩展名**：sniffImageMime 只看 base64 前两位，
        // 任何以 "B"+0x4? 开头的文件都会被当成 BMP（实测文本 "BINDATA" 就会变成 .bmp）。
        // 猜错扩展名比 .bin 更糟 —— 用户双击会拿错程序打开。vault 里的附件都带 name，
        // 走到这里的基本是没人引用的孤儿 .enc，.bin 是诚实的。
        const name = base || `${id}.bin`;
        const target = assertInside(dir, uniquePath(dir, name));
        fs.writeFileSync(target, Buffer.from(b64, 'base64'));
        files.push(target);
        exported += 1;
      } catch (e) {
        failed += 1;
        errors.push(`${id}: ${e.message}`);
      }
    }

    return {
      success: true,
      data: { dir, exported, skipped, failed, files, ...(errors.length ? { errors } : {}) },
    };
  });
}

module.exports = { registerAttachIpc };
