'use strict';

/**
 * 卸载（R3）纯函数模块 —— 契约 `docs/契约-设置细分-免密-卸载.md` §3.1 / §3.4 / §3.5 / D7。
 *
 * **本文件不 require('electron')**：`isPackaged` / `process.execPath` / `execFileSync`
 * 以及文件系统读写全部**由调用方注入**（D7），这样 vitest 里能直接测 mode 矩阵、
 * 受管清单、`dataDirAck` 校验与体积统计，不需要 Electron 运行时。
 *
 * 三条红线（违反即判不合格）：
 *   1. **只有 `listManagedDataPaths()` 里的条目会被删**，清单外一律不动（D5：不递归删 DATA_DIR）；
 *   2. 每个目标删前 `realpath` 校验仍在 `DATA_DIR` 之下（防目录软链逃逸）；
 *   3. `mode === 'dev'` 时**不 spawn 任何东西**（源码目录请用户自己删，§3.4）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 产品名：注册表 `DisplayName` 与 NSIS 产物名都靠它（`package.json` 的 `productName`） */
const UNINSTALL_PRODUCT_NAME = '测试中台';

/**
 * 卸载器发现顺序（§3.4）：HKCU → HKLM → HKLM\WOW6432Node（32 位应用在 64 位系统上）。
 * 一律用 `reg query <key> /s`，**不拼 cmd /c、不带 shell:true**（防命令注入）。
 */
const REG_UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
];

/** 注册表查询预算：超时按「未找到」处理，不许让设置页卡住（§3.4） */
const REG_QUERY_TIMEOUT_MS = 1500;

/** 体积统计预算（§3.4）：深度 ≤6、条目 ≤20000、总耗时 ≤2000ms */
const SIZE_BUDGET_MS = 2000;
const SIZE_MAX_DEPTH = 6;
const SIZE_MAX_ENTRIES = 20000;
const SIZE_BREAKDOWN_MAX = 8;

/**
 * 受管删除清单（§3.5）。**唯一定义处** —— handler 里不许再散写一份。
 * 清单外的东西（用户自己丢进数据目录的文件、自定义附件目录）一律不动。
 */
const MANAGED_DATA_FILES = [
  'vault.enc',
  'vault.enc.bak',
  'trash.enc',
  'trash.enc.bak',
  'settings.json',
  'audit.log',
  'window-state.json',
  'autologin.json',
  'clipboard.enc',
  'cases.json',
];
const MANAGED_DATA_DIRS = ['backups', 'attachments', 'logs', 'background', 'update'];

/** 真实文件系统实现；单测可传自己的替身覆盖其中任意一项 */
function defaultIo(overrides) {
  return Object.assign({
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => fs.statSync(p),
    readdirSync: (p, opts) => (opts ? fs.readdirSync(p, opts) : fs.readdirSync(p)),
    realpathSync: (p) => fs.realpathSync(p),
    unlinkSync: (p) => fs.unlinkSync(p),
    rmdirSync: (p) => fs.rmdirSync(p),
    rmSync: (p, opts) => fs.rmSync(p, opts),
    execFileSync: (file, args, opts) => execFileSync(file, args, opts),
  }, overrides || {});
}

/** `mode`：`app.isPackaged` 为真 = 安装版，否则源码/`npm start`（§3.4） */
function uninstallMode(isPackaged) {
  return isPackaged ? 'installed' : 'dev';
}

/**
 * 解析注册表的 `UninstallString`（§3.4 解析规则）。
 *
 * `"C:\...\Uninstall 测试中台.exe" /S` → `C:\...\Uninstall 测试中台.exe`；
 * `C:\...\Uninstall.exe /S`           → `C:\...\Uninstall.exe`；
 * 不是 `.exe` 绝对路径的（msiexec / 相对路径 / 空）一律 null，**绝不凭空猜路径**。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function parseUninstallString(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  let candidate;
  const quoted = /^"([^"]+)"/.exec(text);
  if (quoted) {
    candidate = quoted[1].trim();
  } else {
    const msi = /^MsiExec\.exe/i.test(text);
    if (msi) return null; // MSI 安装的 UninstallString 是 msiexec，本项目的 NSIS 产物不走这条路
    candidate = text.split(/\s+/)[0];
  }
  if (!candidate) return null;
  if (!/\.exe$/i.test(candidate)) return null;
  if (!path.isAbsolute(candidate)) return null;
  return candidate;
}

/**
 * 解析 `reg query <key> /s` 的输出（纯字符串处理，便于单测）。
 *
 * 形如：
 *   HKEY_CURRENT_USER\Software\...\Uninstall\{GUID}
 *       DisplayName    REG_SZ    测试中台
 *       UninstallString    REG_SZ    "C:\...\Uninstall 测试中台.exe"
 *
 * @param {unknown} text
 * @returns {{ key: string, displayName: string, uninstallString: string }[]}
 */
function parseRegQueryOutput(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) continue;
    if (/^\s*(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\\/i.test(line)) {
      if (cur) out.push(cur);
      cur = { key: line.trim(), displayName: '', uninstallString: '' };
      continue;
    }
    if (!cur) continue;
    const m = /^\s+(\S+)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const value = m[3].trim();
    if (/^DisplayName$/i.test(name)) cur.displayName = value;
    else if (/^UninstallString$/i.test(name)) cur.uninstallString = value;
  }
  if (cur) out.push(cur);
  return out;
}

/** 注册表里找 `DisplayName === productName` 且带可用 UninstallString 的那一项 */
function queryRegistryUninstaller(productName, io) {
  for (const key of REG_UNINSTALL_KEYS) {
    let text = '';
    try {
      text = io.execFileSync('reg', ['query', key, '/s'], {
        timeout: REG_QUERY_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue; // 键不存在 / 超时 → 试下一个；超时按「未找到」处理
    }
    for (const item of parseRegQueryOutput(text)) {
      if (item.displayName !== productName) continue;
      const exe = parseUninstallString(item.uninstallString);
      if (!exe) continue;
      let exists = false;
      try { exists = !!io.existsSync(exe); } catch { exists = false; }
      if (!exists) continue;
      const source = key.startsWith('HKCU') ? 'registry-hkcu' : 'registry-hklm';
      return { path: exe, source, regKey: item.key };
    }
  }
  return null;
}

/**
 * 卸载器发现（§3.4）。返回 `{ path, source, regKey }`，找不到时三项全 null。
 *
 * @param {{ isPackaged?: boolean, execPath?: string, productName?: string, io?: object }} input
 */
function findUninstaller(input) {
  const i = input || {};
  const io = defaultIo(i.io);
  const none = { path: null, source: null, regKey: null };
  if (!i.isPackaged) return none;                 // dev：不查注册表、不猜路径
  const productName = i.productName || UNINSTALL_PRODUCT_NAME;

  const fromReg = queryRegistryUninstaller(productName, io);
  if (fromReg) return fromReg;

  // 回退：exe 同级目录的 NSIS 产物（`nsis.oneClick:false` + 允许改目录时的默认名）
  const execPath = typeof i.execPath === 'string' ? i.execPath : '';
  if (execPath) {
    const sibling = path.join(path.dirname(execPath), `Uninstall ${productName}.exe`);
    let exists = false;
    try { exists = !!io.existsSync(sibling); } catch { exists = false; }
    if (exists) return { path: sibling, source: 'exe-sibling', regKey: null };
  }
  return none;
}

/** `child` 是否仍在 `parent` 之下（都用 realpath 归一后的绝对路径） */
function isInside(parent, child) {
  const p = String(parent || '').toLowerCase();
  const c = String(child || '').toLowerCase();
  if (!p || !c) return false;
  if (p === c) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * `dataDir` 的体积统计（§3.4）：递归深度 ≤6、条目 ≤20000、总耗时 ≤2000ms；
 * `breakdown` = 直属子项体积（文件与目录），降序，最多 8 条。
 *
 * 超预算/无权限/软链都**不中断**，只把原因写进 `error`（此时 `size` 是**下限值**）。
 *
 * @param {string} dir
 * @param {{ io?: object, budgetMs?: number, now?: () => number }} [opts]
 * @returns {{ size: number, breakdown: { dir: string, size: number }[], error?: string }}
 */
function dataSizeOf(dir, opts) {
  const o = opts || {};
  const io = defaultIo(o.io);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const budgetMs = Number.isFinite(Number(o.budgetMs)) && Number(o.budgetMs) > 0 ? Number(o.budgetMs) : SIZE_BUDGET_MS;
  const deadline = now() + budgetMs;

  const state = { entries: 0, timedOut: false, skipped: 0, deep: 0 };

  const walk = (target, depth) => {
    if (state.timedOut) return 0;
    let items;
    try {
      items = io.readdirSync(target, { withFileTypes: true });
    } catch {
      state.skipped += 1;
      return 0;
    }
    let size = 0;
    for (const it of items) {
      if (state.entries >= SIZE_MAX_ENTRIES) { state.timedOut = true; return size; }
      if (now() > deadline) { state.timedOut = true; return size; }
      state.entries += 1;
      const name = it && (it.name || String(it));
      const full = path.join(target, name);
      try {
        const isLink = typeof it.isSymbolicLink === 'function' ? it.isSymbolicLink() : false;
        if (isLink) { state.skipped += 1; continue; }              // 软链不计入，避免环
        const isDir = typeof it.isDirectory === 'function' ? it.isDirectory() : false;
        if (isDir) {
          if (depth + 1 > SIZE_MAX_DEPTH) { state.deep += 1; continue; }
          size += walk(full, depth + 1);
          continue;
        }
        const st = io.statSync(full);
        size += Number(st && st.size) || 0;
      } catch {
        state.skipped += 1;
      }
    }
    return size;
  };

  let total = 0;
  const breakdown = [];
  let top;
  try {
    top = io.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { size: 0, breakdown: [], error: `无法读取数据目录：${(e && e.message) || '未知错误'}` };
  }
  for (const it of top) {
    if (state.entries >= SIZE_MAX_ENTRIES) { state.timedOut = true; break; }
    if (now() > deadline) { state.timedOut = true; break; }
    state.entries += 1;
    const name = it && (it.name || String(it));
    const full = path.join(dir, name);
    let childSize = 0;
    try {
      const isLink = typeof it.isSymbolicLink === 'function' ? it.isSymbolicLink() : false;
      if (isLink) {
        state.skipped += 1;
      } else if (typeof it.isDirectory === 'function' && it.isDirectory()) {
        childSize = walk(full, 1);
      } else {
        const st = io.statSync(full);
        childSize = Number(st && st.size) || 0;
      }
    } catch {
      state.skipped += 1;
    }
    total += childSize;
    breakdown.push({ dir: name, size: childSize });
  }

  breakdown.sort((a, b) => b.size - a.size || String(a.dir).localeCompare(String(b.dir)));
  const out = { size: total, breakdown: breakdown.slice(0, SIZE_BREAKDOWN_MAX) };

  const notes = [];
  if (state.timedOut) notes.push('统计超时，体积为下限值');
  if (state.skipped > 0) notes.push(`${state.skipped} 处文件/目录无法读取或为软链，已跳过`);
  if (state.deep > 0) notes.push(`${state.deep} 处目录层级超过 ${SIZE_MAX_DEPTH} 层，未计入`);
  if (notes.length) out.error = notes.join('；');
  return out;
}

/**
 * 受管清单的绝对路径列表（§3.5）。**单一真源**。
 * @param {string} dataDir
 * @returns {string[]}
 */
function listManagedDataPaths(dataDir) {
  const dir = String(dataDir || '');
  if (!dir) return [];
  return [
    ...MANAGED_DATA_FILES.map((f) => path.join(dir, f)),
    ...MANAGED_DATA_DIRS.map((d) => path.join(dir, d)),
  ];
}

/**
 * `dataDirAck` 校验（§3.3）：等价于「用户真的看到了这个路径」。
 * Windows 大小写不敏感 → 两侧都 `path.resolve` 后小写比较。
 *
 * @param {unknown} ack 渲染层回显的那串绝对路径
 * @param {string} dataDir 主进程当前的 `DATA_DIR`
 * @returns {boolean}
 */
function isDataDirAck(ack, dataDir) {
  if (typeof ack !== 'string' || !ack.trim()) return false;
  try {
    return path.resolve(ack).toLowerCase() === path.resolve(String(dataDir || '')).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 按受管清单删数据（§3.5）。文件不存在不报错（自身幂等）。
 *
 * 每个目标删前 `realpath` 校验「仍在 dataDir 之下」，越界跳过并记日志；
 * 删完若目录变空只尝试**非递归** `rmdir`，失败保留目录。
 *
 * @param {{ dataDir?: string, io?: object, log?: (msg: string) => void }} input
 * @returns {{ removedPaths: string[], error: string|null }}
 */
function removeManagedData(input) {
  const i = input || {};
  const io = defaultIo(i.io);
  const log = typeof i.log === 'function' ? i.log : () => {};
  const dataDir = String(i.dataDir || '');
  const removedPaths = [];
  const errors = [];
  if (!dataDir) return { removedPaths, error: '数据目录为空' };

  let dataReal = '';
  try {
    dataReal = io.realpathSync(dataDir);
  } catch {
    return { removedPaths, error: null }; // 目录本来就不在 → 没有可删的（幂等）
  }

  for (const target of listManagedDataPaths(dataDir)) {
    let exists = false;
    try { exists = !!io.existsSync(target); } catch { exists = false; }
    if (!exists) continue;
    try {
      const real = io.realpathSync(target);
      if (!isInside(dataReal, real)) {
        log(`[uninstall] 跳过越界目标（不在数据目录下）：${target}`);
        continue;
      }
      const st = io.statSync(real);
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        io.rmSync(target, { recursive: true, force: true });
      } else {
        io.unlinkSync(target);
      }
      removedPaths.push(target);
    } catch (e) {
      errors.push(`${path.basename(target)}: ${(e && e.message) || '未知错误'}`);
    }
  }

  // 目录变空才收尾；**只** rmdir（非递归），删不掉就留着
  try {
    const left = io.readdirSync(dataDir);
    if (!left || left.length === 0) io.rmdirSync(dataDir);
  } catch { /* 目录不空 / 被占用 → 保留 */ }

  return { removedPaths, error: errors.length ? errors.join('；') : null };
}

module.exports = {
  UNINSTALL_PRODUCT_NAME,
  REG_UNINSTALL_KEYS,
  REG_QUERY_TIMEOUT_MS,
  SIZE_BUDGET_MS,
  SIZE_MAX_DEPTH,
  SIZE_MAX_ENTRIES,
  MANAGED_DATA_FILES,
  MANAGED_DATA_DIRS,
  defaultIo,
  uninstallMode,
  parseUninstallString,
  parseRegQueryOutput,
  findUninstaller,
  isInside,
  dataSizeOf,
  listManagedDataPaths,
  isDataDirAck,
  removeManagedData,
};
