'use strict';

/**
 * 用例库的纯路径逻辑（无 fs / 无 Electron 依赖，可在渲染层单测）。
 *
 * 为什么单独抽出来：用例库直接操作磁盘上的文件，三件事一旦写错都很难查 ——
 *   1. 名称里带 `..` / 分隔符 → 文件写到库外面（目录穿越）；
 *   2. 重名直接覆盖 → 用户的用例文件被悄悄顶掉；
 *   3. 截断/后缀规则和界面对不上 → 用户看到的名字和磁盘上的不一致。
 * 所以规则都放这里，IPC 只负责调用，单测覆盖。
 */

const path = require('path');

/** 文件 / 文件夹名上限（Windows 路径长度等原因，留足余量） */
const MAX_NAME = 120;

/** 用例库允许的扩展名（上传时过滤；库里已有的文件不受限制） */
const CASE_EXTS = [
  '.xmind', '.md', '.markdown', '.txt',
  '.csv', '.xlsx', '.xls',
  '.json', '.yaml', '.yml', '.xml',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.zip', '.7z', '.rar', '.jmx',
];

/**
 * 规整一个用户输入的名称：Windows 不允许 `<>:"/\|?*` 与控制字符，
 * 末尾的点和空格也要去掉（`a.` 在资源管理器里会变成 `a`）。
 * 不允许 `.` / `..`。
 */
function safeName(input) {
  const raw = String(input == null ? '' : input);
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned) return { error: '名称不能为空' };
  if (cleaned === '.' || cleaned === '..') return { error: '名称不能是 . 或 ..' };
  if (cleaned.length > MAX_NAME) return { error: `名称太长（最多 ${MAX_NAME} 个字符）` };
  return { name: cleaned };
}

/**
 * 把相对路径解析到 root 内；越界（`..`、绝对路径）直接报错。
 * rel 为空表示 root 自身。
 */
function resolveInside(root, rel) {
  const base = path.resolve(String(root || ''));
  if (!base) return { error: '还没有设置用例库目录' };
  const raw = String(rel == null ? '' : rel);
  // 绝对路径一律拒绝：调用方只该传库内的相对路径
  if (path.isAbsolute(raw)) return { error: '非法路径（不允许绝对路径）' };
  const target = path.resolve(base, raw);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return { error: '非法路径（越出用例库目录）' };
  }
  return { base, target };
}

/**
 * 重名自动加后缀：`登录.xmind` → `登录(2).xmind`（目录没有扩展名就加到末尾）。
 * 大小写不敏感（Windows 上 `A.csv` 与 `a.csv` 是同一个文件）。
 */
function uniqueName(existing, name) {
  const taken = new Set((existing || []).map(n => String(n).toLowerCase()));
  const wanted = String(name);
  if (!taken.has(wanted.toLowerCase())) return wanted;
  const ext = path.extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${stem}(${i})${ext}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return `${stem}(${Date.now()})${ext}`;
}

/** 字节数 → 人类可读（列表里显示大小，0 字节也要能看懂） */
function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 文件夹最多两级：Test_Cases/<系统>/<模块> */
const MAX_FOLDER_DEPTH = 2;

/**
 * 移动目标是否合法（纯函数）：文件可以放进任意一级目录，**文件夹**只能放到根或系统这一级，
 * 否则会出现第三层（模块里再套模块），列表和树的展示规则就守不住了。
 */
function canMoveInto(isDir, targetRel) {
  if (!isDir) return { ok: true };
  const depth = String(targetRel || '').split('/').filter(Boolean).length;
  if (depth >= MAX_FOLDER_DEPTH) {
    return { ok: false, error: '最多两级文件夹：不能把文件夹放进「模块」里' };
  }
  return { ok: true };
}

module.exports = { MAX_NAME, CASE_EXTS, MAX_FOLDER_DEPTH, safeName, resolveInside, uniqueName, formatSize, canMoveInto };

