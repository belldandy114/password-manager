'use strict';

/**
 * git-args.js —— Git 影响面（模块 6）的**只读**命令白名单与 `-z` 解析。纯函数，只 require `path`。
 *
 * 为什么单独成模块（契约 C-57 / 裁决 R4）：命令串拼装与 `-z` 解析必须能在 vitest 里直接测，
 * 塞进 `ipc-git.js`（那里 `require('electron')`）就只能起 Electron 才能验证。
 *
 * **安全底线**：渲染层只能传 `root` 与 `scope` 枚举，本模块产出的命令永远是下面四条之一——
 * 不存在 `args` / `extra` 这类入参，也就没有「拼一个任意 git 参数进去」的口子（C-57/C-58）。
 *
 * ## `-z` 的段序（以 **实测 git 2.39.1** 为准，不是以契约为准）
 *
 *   - `status --porcelain -z`：普通条目 `XY <path>\0`；rename/copy 是 **两段**：
 *     实测输出 `R  新名字 file.txt\0old name.txt\0` —— **新路径在前、旧路径在后**。
 *     （契约 §2.3 写的 `R  old\0new\0` 与实测相反。）
 *   - `diff --numstat -z`：普通条目 `add\tdel\t<path>\0`；rename 是 `add\tdel\t\0<旧>\0<新>\0`
 *     —— **旧路径在前**，与契约一致。
 *
 * 两处「少消费一段」都会让后面所有条目整体错位，表现是「有文件列表，但状态和路径全对不上」。
 * 因此 `parseStatusZ` / `parseNumstatZ` 都按段号推进（i/j 指针），而不是只按 `\0` 切完取值。
 */

const path = require('path');

/** `git:diff` 允许的三种范围（C-57：scope 只影响后缀） */
const GIT_SCOPES = Object.freeze(['unstaged', 'staged', 'head']);

/**
 * **每次 git 调用都前置的三个 `-c`**（安全评审 S-03）。
 *
 * `git status` / `git diff` 会读**仓库自己的** `.git/config`：
 *   - `core.fsmonitor` 指向一个可执行程序 → 有人在你跑体检的仓库里设一条
 *     `fsmonitor = /path/to/evil`，你 `git status` 一下就把别人的程序执行了；
 *   - `core.hooksPath` 可把 hooks 指到别处（同理可执行）；
 *   - `diff.external` 让 `git diff` 调外部 diff 程序。
 * 威胁模型是「仓库不可信」（克隆来的、别人发来的 zip），不是「本机单用户」。
 * 三个 `-c` 必须**在子命令之前**（`git -c k=v status`），所以拼在参数数组最前面。
 */
const GIT_SAFE_CONFIG = Object.freeze([
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=',
  '-c', 'diff.external=',
]);

/** scope → `diff --numstat -z` 的后缀（unstaged 无后缀） */
const DIFF_SUFFIX = Object.freeze({
  unstaged: Object.freeze([]),
  staged: Object.freeze(['--cached']),
  head: Object.freeze(['HEAD']),
});

/** 文件数上限（C-57 表：文件数 2000） */
const MAX_FILES = 2000;

/** 明确禁止出现在白名单里的写命令（C-58：不给通道就是最彻底的保护） */
const WRITE_COMMANDS = Object.freeze([
  'commit', 'push', 'checkout', 'stash', 'reset', 'clean', 'config', 'merge', 'rebase', 'rm', 'add',
]);

const clone = (arr) => arr.slice();

/**
 * `git:probe` 需要的三条只读命令（每条都是固定数组，调用方只能整体使用）。
 * @returns {{ branch: string[], head: string[], status: string[] }}
 */
function buildProbeArgs() {
  return {
    branch: [...GIT_SAFE_CONFIG, 'rev-parse', '--abbrev-ref', 'HEAD'],
    head: [...GIT_SAFE_CONFIG, 'rev-parse', '--short', 'HEAD'],
    status: [...GIT_SAFE_CONFIG, 'status', '--porcelain', '-z'],
  };
}

/**
 * `git:diff` 的命令：`diff --numstat -z` + scope 后缀。
 * 未知 scope **拒绝**（返回错误串，C-60），绝不把入参拼进命令。
 * @param {'unstaged'|'staged'|'head'} scope
 * @returns {{ ok: true, args: string[] } | { ok: false, error: string }}
 */
function buildDiffArgs(scope) {
  const s = String(scope == null ? '' : scope);
  if (!GIT_SCOPES.includes(s)) return { ok: false, error: `未知的 diff 范围：${s}` };
  return { ok: true, args: [...GIT_SAFE_CONFIG, 'diff', '--numstat', '-z', ...clone(DIFF_SUFFIX[s])] };
}

/** rename / copy 的两个状态字母（这两个才有第二段路径） */
const isRenameLetter = (ch) => ch === 'R' || ch === 'C';

/**
 * 解析 `git status --porcelain -z`。
 *
 * 每条 `XY<space><path>\0`，rename/copy 再跟一段旧路径（**新在前**）。
 * @param {string} text git 的原始输出（含 NUL）
 * @returns {{ ok: true, entries: { x: string, y: string, path: string, origPath: string }[] }}
 */
function parseStatusZ(text) {
  const src = String(text == null ? '' : text);
  const parts = src.split('\0');
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const seg = parts[i];
    if (!seg) { i += 1; continue; } // 结尾空段 / 连续空段
    const x = seg[0] || ' ';
    const y = seg[1] || ' ';
    const p = seg.slice(3); // 跳过 "XY "
    const entry = { x, y, path: p, origPath: '' };
    if (isRenameLetter(x) || isRenameLetter(y)) {
      // 第二段是旧路径；少消费它，后面的条目会整体错位
      entry.origPath = parts[i + 1] == null ? '' : parts[i + 1];
      i += 2;
    } else {
      i += 1;
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * 解析 `git diff --numstat -z`。
 *
 * 每条 `add\tdel\t<path>\0`；rename 是 `add\tdel\t\0<旧>\0<新>\0`（**旧在前**）。
 * 二进制文件的行数字段是 `-`，统一记 0 并置 `binary: true`（C-59）。
 * @param {string} text
 * @returns {{ ok: true, entries: { path: string, origPath: string, additions: number, deletions: number, binary: boolean }[] }}
 */
function parseNumstatZ(text) {
  const src = String(text == null ? '' : text);
  const parts = src.split('\0');
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const seg = parts[i];
    if (!seg) { i += 1; continue; }
    const tab1 = seg.indexOf('\t');
    const tab2 = tab1 === -1 ? -1 : seg.indexOf('\t', tab1 + 1);
    if (tab1 === -1 || tab2 === -1) { i += 1; continue; } // 不是 numstat 行，跳过而不是崩
    const rawAdd = seg.slice(0, tab1);
    const rawDel = seg.slice(tab1 + 1, tab2);
    const inlinePath = seg.slice(tab2 + 1);
    const binary = rawAdd === '-' || rawDel === '-';
    const additions = binary ? 0 : Number(rawAdd) || 0;
    const deletions = binary ? 0 : Number(rawDel) || 0;

    if (inlinePath) {
      entries.push({ path: inlinePath, origPath: '', additions, deletions, binary });
      i += 1;
    } else {
      // rename：路径为空，后面两段依次是旧路径、新路径
      const origPath = parts[i + 1] == null ? '' : parts[i + 1];
      const newPath = parts[i + 2] == null ? '' : parts[i + 2];
      entries.push({ path: newPath, origPath, additions, deletions, binary });
      i += 3;
    }
  }
  return { ok: true, entries };
}

/**
 * 两列 XY 合成为 UI 用的状态串（C-59）。
 * @param {string} x 已暂存侧
 * @param {string} y 工作区侧
 * @param {boolean} binary 是否二进制（numstat 给 `-`）
 * @returns {string}
 */
function statusOf(x, y, binary) {
  let s;
  if (x === '?' && y === '?') s = 'untracked';
  else if (isRenameLetter(x) || isRenameLetter(y)) s = 'renamed';
  else if (x === 'A' || y === 'A') s = 'added';
  else if (x === 'D' || y === 'D') s = 'deleted';
  else if (x === 'M' && (y === ' ' || y === '')) s = 'staged-modified';
  else s = 'modified';
  return binary ? `${s}-binary` : s;
}

/**
 * 合并 status（状态字母）与 numstat（行数），按 `path` 对齐。
 *
 * 以 status 条目为主（它代表「工作区/暂存区真实有什么」），numstat 只补行数与 binary 标记；
 * numstat 里有但 status 里没有的（例如 `head` 范围里已删除的旧文件）也补进去，状态按 modified。
 *
 * @param {{ statusEntries?: any[], numstatEntries?: any[], maxFiles?: number }} input
 * @returns {{ files: { path: string, origPath?: string, status: string, additions: number, deletions: number }[], truncated: boolean }}
 */
function mergeDiff({ statusEntries, numstatEntries, maxFiles } = {}) {
  const stats = new Map();
  for (const n of Array.isArray(numstatEntries) ? numstatEntries : []) {
    stats.set(String(n.path), n);
  }
  const limit = Math.max(1, Math.min(Number(maxFiles) || MAX_FILES, MAX_FILES));

  const out = [];
  const seen = new Set();
  for (const st of Array.isArray(statusEntries) ? statusEntries : []) {
    const key = String(st.path);
    const num = stats.get(key);
    const file = {
      path: key,
      status: statusOf(st.x, st.y, !!(num && num.binary)),
      additions: num ? num.additions : 0,
      deletions: num ? num.deletions : 0,
    };
    if (st.origPath) file.origPath = String(st.origPath);
    out.push(file);
    seen.add(key);
  }
  for (const [key, num] of stats) {
    if (seen.has(key)) continue;
    const file = {
      path: key,
      status: statusOf(' ', 'M', !!num.binary),
      additions: num.additions,
      deletions: num.deletions,
    };
    if (num.origPath) file.origPath = String(num.origPath);
    out.push(file);
  }

  const truncated = out.length > limit;
  return { files: truncated ? out.slice(0, limit) : out, truncated };
}

/**
 * 按 scope 过滤 status 条目——**每个范围只留自己那部分改动**。
 *
 * 不这么做的话，`staged` 里会混进「只在工作区改了」的文件（它的 X 是空格、Y 是 M），
 * 用户看到「已暂存 N 个文件」里有个没暂存过的文件，就会怀疑这个功能算错了。
 *   - `staged`  ：索引侧有改动（X 不是空格、也不是 `?`）
 *   - `unstaged`：工作区侧有改动（Y 不是空格），以及未跟踪 `??`
 *   - `head`    ：HEAD → 工作区，全留
 *
 * @param {{ x: string, y: string, path: string, origPath?: string }[]} entries
 * @param {'unstaged'|'staged'|'head'} scope
 */
function filterByScope(entries, scope) {
  const list = Array.isArray(entries) ? entries : [];
  const s = String(scope || '');
  if (s === 'staged') return list.filter((e) => e.x !== ' ' && e.x !== '?');
  if (s === 'unstaged') return list.filter((e) => e.y !== ' ' || (e.x === '?' && e.y === '?'));
  return list.slice();
}
/** 把 git 的绝对输出根规整一下（只做字符串归一，不碰磁盘） */
function normalizeRoot(root) {
  const r = String(root == null ? '' : root).trim();
  return r ? path.normalize(r) : '';
}

module.exports = {
  GIT_SCOPES,
  DIFF_SUFFIX,
  MAX_FILES,
  WRITE_COMMANDS,
  GIT_SAFE_CONFIG,
  buildProbeArgs,
  buildDiffArgs,
  parseStatusZ,
  parseNumstatZ,
  statusOf,
  filterByScope,
  mergeDiff,
  normalizeRoot,
};