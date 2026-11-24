'use strict';

/**
 * ipc-git.js —— Git Diff 影响面取数（模块 6）的 IPC 域，**只读**。
 *
 * 通道与上限/超时见 docs/契约-本地测试资产工作站.md §2.3（C-57 ~ C-60）。
 *
 * 分工（C-57 明令）：命令串拼装与 `-z` 解析**全部在 electron/git-args.js**（纯函数、可单测）；
 * 本模块只负责 spawn + 超时 + 错误文案映射。
 *
 * 安全底线（三条，缺一不可）：
 *   1. **没有任何「传参」口子**：渲染层只能传 `root` 与 `scope`，本文件从 payload 里只读这两个字段，
 *      `args` / `extra` 之类一律无视（有专门取证：传 `{ root, args: ['push'] }` 结果与不传完全一致）。
 *   2. 不执行任何写命令（commit/push/checkout/stash/reset/clean/config）：白名单里根本没有它们。
 *   3. `GIT_TERMINAL_PROMPT=0`：不会因为缺凭据卡在交互提示上。
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { ipcMain } = require('electron');
const {
  buildProbeArgs, buildDiffArgs, parseStatusZ, parseNumstatZ, mergeDiff, filterByScope, normalizeRoot,
} = require('./git-args');

/** C-58：10 秒超时 */
const TIMEOUT_MS = 10000;

/** C-60 错误文案（唯一真源在契约，这里只引用） */
const ERR = {
  noDir: '目录不存在',
  notRepo: '不是 git 仓库',
  noGit: 'git 不可用（未安装或不在 PATH）',
  timeout: '命令超时（10 秒）',
  badScope: (s) => `未知的 diff 范围：${s}`,
  failed: (m) => `git 命令失败：${m}`,
};

/** 超时杀进程树：git 自己不会再拉子进程，但 Windows 上 taskkill /T 更稳（杀不掉就退化为 kill） */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try { child.kill(); } catch { /* 已经退了 */ }
  }
}

/**
 * 跑一条白名单命令（`args` 只能来自 git-args.js）。
 * @returns {Promise<{ ok: true, stdout: string } | { ok: false, error: string }>}
 */
function runGit(root, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd: root,
        windowsHide: true,
        shell: false, // 绝不经 shell：文件名/参数都不给 shell 解释的机会
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // C-58：不弹凭据
          GIT_OPTIONAL_LOCKS: '0', // C-58：不抢索引锁
          GIT_PAGER: 'cat',
        },
      });
    } catch (e) {
      resolve({ ok: false, error: ERR.failed(e.message) });
      return;
    }

    const out = [];
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      killTree(child);
      done({ ok: false, error: ERR.timeout });
    }, TIMEOUT_MS);

    child.on('error', (e) => {
      done({ ok: false, error: e && e.code === 'ENOENT' ? ERR.noGit : ERR.failed(e.message) });
    });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', () => { /* stderr 只在失败时用，见下面 close */ });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) { done({ ok: true, stdout: Buffer.concat(out).toString('utf8') }); return; }
      const first = String(errText).split(/\r?\n/).find((l) => l.trim()) || '';
      if (/not a git repository/i.test(first)) { done({ ok: false, error: ERR.notRepo }); return; }
      done({ ok: false, error: ERR.failed(first) });
    });
  });
}

/** root 校验：存在 + 是目录（C-60 的「目录不存在」） */
function checkRoot(root) {
  const r = normalizeRoot(root);
  if (!r) return { ok: false, error: ERR.noDir };
  try {
    if (!fs.statSync(r).isDirectory()) return { ok: false, error: ERR.noDir };
  } catch {
    return { ok: false, error: ERR.noDir };
  }
  return { ok: true, root: r };
}

function registerGitIpc() {
  /**
   * `git:probe { root }` → `{ isRepo, branch, head, dirty }`
   * 非 git 目录返回可读中文 `不是 git 仓库`（不是把 git 的英文 stderr 吐出去）。
   */
  ipcMain.handle('git:probe', async (_event, payload = {}) => {
    const check = checkRoot(payload && payload.root);
    if (!check.ok) return { success: false, error: check.error };
    const { root } = check;
    const A = buildProbeArgs();

    const statusRes = await runGit(root, A.status);
    if (!statusRes.ok) return { success: false, error: statusRes.error };

    // 空仓库（还没有 commit）时 rev-parse 会失败，但它是 git 仓库：分支/提交记空串即可
    const branchRes = await runGit(root, A.branch);
    const headRes = await runGit(root, A.head);
    const branch = branchRes.ok ? branchRes.stdout.trim() : '';
    const head = headRes.ok ? headRes.stdout.trim() : '';
    const { entries } = parseStatusZ(statusRes.stdout);

    return {
      success: true,
      data: { isRepo: true, branch, head, dirty: entries.length > 0 },
    };
  });

  /**
   * `git:diff { root, scope }` → `{ root, scope, files, truncated }`
   * **只读 root 与 scope 两个字段**：payload 里的 args/extra 一律无视（C-57）。
   */
  ipcMain.handle('git:diff', async (_event, payload = {}) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const check = checkRoot(p.root);
    if (!check.ok) return { success: false, error: check.error };
    const { root } = check;

    const scope = String(p.scope == null ? '' : p.scope);
    const built = buildDiffArgs(scope);
    if (!built.ok) return { success: false, error: built.error }; // 未知 scope：拒绝，不拼进命令

    const A = buildProbeArgs();
    const statusRes = await runGit(root, A.status);
    if (!statusRes.ok) return { success: false, error: statusRes.error };

    const statRes = await runGit(root, built.args);
    // 空仓库 + scope=head 时 `HEAD` 不存在：这不是错误，返回空改动
    if (!statRes.ok && !/ambiguous argument|unknown revision|Nearest.*HEAD/i.test(statRes.error)) {
      return { success: false, error: statRes.error };
    }

    const { entries: allStatus } = parseStatusZ(statusRes.stdout);
    // 只保留该范围自己的改动：否则 staged 里会混进「只在工作区改了」的文件
    const statusEntries = filterByScope(allStatus, scope);
    const { entries: numstatEntries } = statRes.ok ? parseNumstatZ(statRes.stdout) : { entries: [] };
    const { files, truncated } = mergeDiff({ statusEntries, numstatEntries });

    return { success: true, data: { root, scope, files, truncated } };
  });
}

module.exports = { registerGitIpc, GIT_TIMEOUT_MS: TIMEOUT_MS };