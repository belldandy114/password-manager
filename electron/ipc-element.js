'use strict';

/**
 * ipc-element.js —— 「元素库 · 定位/试跑」的 IPC 域（1.36.0 / B8，契约 §12.6 / §12.7，裁定 Q4 / Q5）。
 *
 * 四条通道：
 *   - `el:deps`         只回两盏灯（node / playwright 包），**不回真实绝对路径**（Q4 硬约束①）
 *   - `el:pick-dir`     选「Playwright 工作目录」（工作目录存渲染层 localStorage，主进程无状态）
 *   - `el:trial-run`    写临时 .mjs → `node` 跑 Playwright 持久 profile → 解析 stdout JSON → 删脚本
 *   - `el:profile-clear` 只允许删 `<工作目录>/.pm-profile`，带路径包含性校验（Q4 硬约束②，安全红线）
 *
 * 三条硬约束（每条都有对应单测 / 取证）：
 *   1. **主进程不 require('playwright')**：浏览器库只在子进程里由 node 解析；本文件只用 `which('node')`。
 *   2. **工作目录与 profile 不进 vault / 备份 / 导出**：目录每次由渲染层作为入参传进来，本模块无状态。
 *   3. **超时要杀进程树**：`taskkill /PID <pid> /T /F`（`shell:false`），并把已完成的结果照回，
 *      `truncated:true` + `truncatedReason:'timeout'`（既有枚举，不新增取值）。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ipcMain, dialog } = require('electron');
const { which } = require('./which');
const {
  ERR,
  PROFILE_DIR_NAME,
  SCRIPT_PREFIX,
  buildDeps,
  buildTrialScript,
  isInsideProfile,
  parseTrialOutput,
  profileDirOf,
  summarizeChildError,
  validateTrialArgs,
} = require('./element-args');

/** 总超时触发后等 close 的收尾宽限（要的是**拿到最后一条 stdout**，不是等着不死） */
const KILL_GRACE_MS = 800;
/** stdout / stderr 累计上限：Playwright 的日志很吵，别让它把内存吃光 */
const OUTPUT_CAP = 2 * 1024 * 1024;
/** `el:deps` 探测 playwright 的超时（解析一个包，正常 < 1s） */
const PROBE_TIMEOUT_MS = 8000;

/**
 * 正在跑的试跑（按**解析后的 profile 目录**去重）。
 *
 * profile 不能被两个进程同时用（§12.7）：第二次调用立刻回「正在运行，请稍候」，
 * **不排队**——排队会让渲染层以为按钮没响应，也会留下悬挂 Promise。
 */
const inflight = new Set();

/** 进程树终止：Windows 上杀父进程会留下 Chrome 子进程，必须 /T（继承 ipc-codelab 的做法） */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 进程已经没了 */ }
}

/**
 * 探测 playwright 包（**在子进程里**验，主进程不引浏览器库）。
 *
 * 两级判定，顺序有意义：
 *   ① 先看**本目录**有没有 `node_modules/playwright`（最准，也正是临时 `.mjs` 的解析起点）；
 *   ② 没有就用 `node` 在本目录**真 import 一次**——上层目录 / 全局装着的同样能用，灯也该是绿的，
 *      但 `detail` 要说明「用的是上层安装」，不能假装是本目录装的。
 *
 * 返回的 detail 一律是**固定文案**，绝不带 stderr 原文：那条报文常常包含
 * `Require stack: - C:\\Users\\<真实用户名>\\...`，正是 Q4 明令不许回的东西。
 */
function probePlaywright(nodeExe, workDir) {
  if (!nodeExe) return { ok: false, detail: '未找到 Node.js，无法探测 playwright 包' };
  try {
    for (const pkg of ['playwright', 'playwright-core']) {
      if (fs.existsSync(path.join(workDir, 'node_modules', pkg, 'package.json'))) {
        return { ok: true, local: true };
      }
    }
  } catch { /* 目录权限异常时走②的 import 探测 */ }
  try {
    const r = spawnSync(nodeExe, ['-e', "import('playwright').then(()=>process.exit(0),()=>process.exit(3))"], {
      cwd: workDir,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'ignore',
    });
    if (r && r.status === 0) return { ok: true, local: false };
    return { ok: false, detail: '工作目录里没有 playwright 包（node_modules/playwright）' };
  } catch {
    return { ok: false, detail: '探测 playwright 失败（node 无法在这个目录里执行）' };
  }
}

/** 写临时脚本 → 跑 → 清脚本。脚本名随机，写在**用户指定目录**里（顺手就能 require 到同目录的 playwright）。 */
function writeScript(workDir, source) {
  const name = `${SCRIPT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mjs`;
  const file = path.join(workDir, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

/**
 * 跑一次试跑（子进程 + 总超时 + 杀进程树 + 解析 stdout）。
 *
 * @param {{ nodeExe: string, workDir: string, scriptPath: string, profileDir: string, budget: { total: number } }} p
 * @returns {Promise<{ parsed: any|null, timedOut: boolean, stderr: string, exitCode: number|null }>}
 */
function runTrialScript({ nodeExe, workDir, scriptPath, profileDir, budget }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    let child;
    try {
      child = spawn(nodeExe, [scriptPath], {
        cwd: workDir,
        env: Object.assign({}, process.env, { PM_EL_PROFILE: profileDir }),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ parsed: null, timedOut: false, stderr: String((e && e.message) || e), exitCode: null });
      return;
    }

    child.stdout.on('data', (d) => {
      if (stdout.length < OUTPUT_CAP) stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < OUTPUT_CAP) stderr += String(d);
    });
    child.on('error', (e) => {
      finish({ parsed: null, timedOut: false, stderr: String((e && e.message) || e), exitCode: null });
    });
    child.on('close', (code) => {
      finish({ parsed: parseTrialOutput(stdout), timedOut, stderr, exitCode: code == null ? null : code });
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // 给 close 一点时间；进程树被杀后通常立刻回来，但仍兜一个底
      setTimeout(() => finish({ parsed: parseTrialOutput(stdout), timedOut: true, stderr, exitCode: null }), KILL_GRACE_MS);
    }, budget.total);
  });
}

/**
 * @param {{ getMainWindow: () => any }} deps
 */
function registerElementIpc(deps) {
  const getWindow = () => (deps && typeof deps.getMainWindow === 'function' ? deps.getMainWindow() : null);

  // ---------------- el:deps（只读 · 两盏灯） ----------------
  ipcMain.handle('el:deps', async (_event, input) => {
    try {
      const workDir = String((input && input.dir) || '').trim();
      if (!workDir) return { success: false, error: ERR.emptyDir };
      if (!fs.existsSync(workDir)) return { success: false, error: '工作目录不存在，请重新选择' };
      const nodeExe = which('node');
      const pw = probePlaywright(nodeExe, workDir);
      const data = buildDeps({
        workDir,
        nodePath: nodeExe || null,
        playwrightOk: pw.ok,
        playwrightLocal: pw.local === true,
        playwrightDetail: pw.detail,
      });
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---------------- el:pick-dir（选 Playwright 工作目录） ----------------
  ipcMain.handle('el:pick-dir', async () => {
    try {
      const r = await dialog.showOpenDialog(getWindow(), {
        title: '选择 Playwright 工作目录（需已安装 playwright 包）',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, data: null };
      return { success: true, data: r.filePaths[0] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ---------------- el:profile-clear（唯一会删目录的通道） ----------------
  ipcMain.handle('el:profile-clear', async (_event, input) => {
    const workDir = String((input && input.dir) || '').trim();
    if (!workDir) return { success: false, error: ERR.emptyDir };
    const target = input && input.target != null ? String(input.target) : '';
    // 调用方给了路径就必须过包含性校验；不给则只删本模块自己算出来的那个目录
    if (target && !isInsideProfile(workDir, target)) {
      return { success: false, error: ERR.profileTarget };
    }
    const profileDir = profileDirOf(workDir);
    if (!profileDir || path.basename(profileDir) !== PROFILE_DIR_NAME) {
      return { success: false, error: ERR.profileOutside };
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      // 回**脱敏后**的路径：连「清的是哪台机器上哪个目录」都不往外带（Q4 硬约束①）
      return { success: true, data: { cleared: true, path: `${'<工作目录>'}/${PROFILE_DIR_NAME}` } };
    } catch (e) {
      return { success: false, error: `清理失败：${e.message}` };
    }
  });

  // ---------------- el:trial-run（写临时 .mjs → node 跑 → 解析 → 删） ----------------
  ipcMain.handle('el:trial-run', async (_event, input) => {
    const v = validateTrialArgs(input);
    if (!v.ok) return { success: false, error: v.error };

    const { dir: workDir, url, items, withStyle, budget } = v;
    if (!fs.existsSync(workDir)) return { success: false, error: '工作目录不存在，请重新选择' };

    const nodeExe = which('node');
    if (!nodeExe) return { success: false, error: ERR.noNode };

    const profileDir = profileDirOf(workDir);
    if (inflight.has(profileDir)) return { success: false, error: ERR.busy };
    inflight.add(profileDir);

    let scriptPath = '';
    try {
      scriptPath = writeScript(workDir, buildTrialScript({ url, items, withStyle, budget }));
      const r = await runTrialScript({ nodeExe, workDir, scriptPath, profileDir, budget });
      const parsed = r.parsed || null;

      // 超时：把**已经跑完**的结果照回，并显式标 truncated（契约 Q4 硬约束③：不许静默丢）
      if (r.timedOut) {
        return {
          success: true,
          data: {
            results: (parsed && Array.isArray(parsed.results)) ? parsed.results : [],
            ms: (parsed && Number.isFinite(parsed.ms)) ? parsed.ms : budget.total,
            truncated: true,
            truncatedReason: 'timeout',
            loginRequired: !!(parsed && parsed.loginRequired),
            message: '试跑未在预算内完成（已返回完成部分），可再点一次重试',
          },
        };
      }

      if (!parsed) {
        // 没有哨兵行 = 子进程根本没跑起来（缺依赖、语法错、node 崩）→ 不许编结果
        const reason = summarizeChildError(r.stderr);
        return {
          success: false,
          error: reason ? `试跑失败：${reason}` : '试跑失败：没有拿到结果（检查工作目录里是否装了 playwright）',
        };
      }

      if (parsed.error) {
        return { success: false, error: `试跑失败：${String(parsed.error).slice(0, 300)}` };
      }

      return {
        success: true,
        data: {
          results: Array.isArray(parsed.results) ? parsed.results : [],
          ms: Number.isFinite(parsed.ms) ? parsed.ms : 0,
          loginRequired: !!parsed.loginRequired,
          ...(parsed.loginRequired ? { message: '页面需要登录：请在弹出的窗口里登录后点「重试」' } : {}),
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    } finally {
      if (scriptPath) { try { fs.rmSync(scriptPath, { force: true }); } catch { /* 删不掉也不影响本次结果 */ } }
      inflight.delete(profileDir);
    }
  });
}

module.exports = { registerElementIpc, probePlaywright };
