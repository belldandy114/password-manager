'use strict';

/**
 * 在线代码调试（本地执行）。
 *
 * 为什么在本地跑：这个工具是给测试/开发自用的桌面程序，本机就有 Node / Python / JDK，
 * 不需要联网编译器；离线、内网环境也能用。**但它不是沙箱**——UI 上必须写明。
 *
 * 能力：
 * - JavaScript：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1），无需额外安装
 * - Python：探测 python / python3
 * - Java：探测 javac + java（JDK，不是 JRE）；可以先复用 JMeter 里配置的 JDK
 *
 * 输出：按行流式推 `codelab:output`，结束时推 `codelab:done`（含退出码与耗时）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { ipcMain, app } = require('electron');
const { SUPPORTED, buildRunPlan, splitSteps, tempDirName } = require('./codelab-args');

const MAX_OUTPUT_LINES = 2000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;

let current = null;

/** 找一个可用的命令行程序：where/which 能定位到，并且能跑出帮助信息 */
function which(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || '';
  } catch {
    return '';
  }
}

function detect() {
  const nodePath = process.execPath; // Electron 自带 Node
  const pythonPath = which('python') || which('python3') || which('py');
  const javaExe = which('java');
  const javacExe = which('javac');
  return {
    node: { ok: !!nodePath, path: nodePath },
    python: { ok: !!pythonPath, path: pythonPath },
    java: { ok: !!(javaExe && javacExe), java: javaExe, javac: javacExe },
    supported: SUPPORTED,
  };
}

function pushLines(win, runId, stream, text) {
  if (!win) return;
  const parts = String(text).split(/\r?\n/);
  // 去掉末尾的空 segment：那是行尾换行造成的，不是真的空行
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  for (const line of parts) {
    if (line === '' && !text.trim()) continue;
    try { win.webContents.send('codelab:output', { runId, stream, line }); } catch { /* 窗口已关 */ }
  }
}

/** 讲一个子进程包成 Promise，边跑边把输出推给界面；失败也返回 exitCode 而不是 throw */
function runStep({ cmd, args, cwd, env, timeoutMs, win, runId, label, collected }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (current && current.runId === runId) current.child = child;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    const onData = (stream) => (buf) => {
      const text = buf.toString('utf8');
      if (stream === 'stdout') out += text;
      else err += text;
      if (collected.length < MAX_OUTPUT_LINES) pushLines(win, runId, stream, text);
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: `${err}${e.message}\n`, timedOut: false, label });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, out, err, timedOut, label });
    });
  });
}

function registerCodelabIpc(deps = {}) {
  const getWindow = deps.getWindow || (() => null);

  ipcMain.handle('codelab:detect', async () => ({ success: true, data: detect() }));

  ipcMain.handle('codelab:run', async (_e, { lang, code, timeoutMs } = {}) => {
    if (current) return { success: false, error: '还有一段代码在运行，先停止或等它结束' };
    const src = String(code == null ? '' : code);
    if (!src.trim()) return { success: false, error: '代码是空的' };

    const rt = detect();
    let plan;
    try {
      plan = buildRunPlan({
        lang,
        code: src,
        dir: '',
        runtime: {
          nodePath: rt.node.path,
          pythonPath: rt.python.path,
          javaExe: rt.java.java,
          javacExe: rt.java.javac,
        },
      });
    } catch (e) {
      return { success: false, error: e.message };
    }

    const runId = String(Date.now());
    const dir = path.join(app.getPath('userData'), 'codelab', tempDirName(runId, Math.random().toString(36).slice(2, 8)));
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of plan.files) fs.writeFileSync(path.join(dir, f.name), f.content, 'utf8');
    } catch (e) {
      return { success: false, error: `准备临时目录失败：${e.message}` };
    }

    const win = getWindow();
    const limit = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const collected = [];
    const { compile, run } = splitSteps(plan);

    current = { runId, dir };
    const startedAt = Date.now();
    try {
      const cmdText = [path.basename(plan.steps[0].cmd), ...plan.steps[0].args].join(' ');
      const fileName = (plan.files[0] && plan.files[0].name) || '';
      pushLines(win, runId, 'system', `$ ${cmdText}    （超时 ${Math.round(limit / 1000)}s）`);
      try { win && win.webContents.send('codelab:meta', { runId, file: fileName }); } catch { /* ignore */ }

      // 编译步骤（Java）：失败就不跑，避免 "class not found" 误导
      for (const step of compile) {
        const r = await runStep({ cmd: step.cmd, args: step.args, cwd: dir, env, timeoutMs: limit, win, runId, label: 'compile', collected });
        if (r.timedOut || r.code !== 0) {
          const done = { runId, ok: false, code: r.code, timedOut: r.timedOut, ms: Date.now() - startedAt, phase: 'compile', dir };
          try { win && win.webContents.send('codelab:done', done); } catch { /* ignore */ }
          return { success: false, error: r.timedOut ? '编译超时' : `编译失败（退出码 ${r.code}）` };
        }
      }

      let last = { code: 0, timedOut: false };
      for (const step of run) {
        last = await runStep({ cmd: step.cmd, args: step.args, cwd: dir, env, timeoutMs: limit, win, runId, label: 'run', collected });
      }
      const done = {
        runId,
        ok: !last.timedOut && last.code === 0,
        code: last.code,
        timedOut: last.timedOut,
        ms: Date.now() - startedAt,
        dir,
      };
      try { win && win.webContents.send('codelab:done', done); } catch { /* ignore */ }
      return { success: true, data: done };
    } finally {
      current = null;
      // 临时目录留一份（方便看生成的文件），超过 20 个时清最旧的
      try {
        const root = path.join(app.getPath('userData'), 'codelab');
        const dirs = fs.readdirSync(root).map((n) => ({ n, t: fs.statSync(path.join(root, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        for (const d of dirs.slice(20)) fs.rmSync(path.join(root, d.n), { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  ipcMain.handle('codelab:stop', async () => {
    if (!current || !current.child) return { success: true, data: { stopped: false } };
    const pid = current.child.pid;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else current.child.kill('SIGKILL');
    } catch { /* 已经退出 */ }
    return { success: true, data: { stopped: true, pid } };
  });
}

module.exports = { registerCodelabIpc, detect, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };
