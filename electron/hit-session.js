'use strict';

/**
 * hit-session.js —— 元素库 A₂「CDP 点验」的**会话状态机**（单会话单例）。
 *
 * 契约：[A2-4] 没连上不许写成没命中 / [A2-5] 单例与并发 / [A2-6] 超时 / [A2-8] 端口发现 /
 *       [A2-9] 独立 profile / [A2-10] pid 双校验才 kill / [A2-11] stop 三级降级 /
 *       [A2-12] 退出即关 / [A2-13] 审计脱敏。
 *
 * 设计参考：1148872017/test-tool（main @ v0.65.0，package.json 声明 MIT，作者已授权，2026-11-27 留痕）
 *   借鉴：electron/sniffer/browser-session.js 的 waitForDevTools（双 reason + **不认子进程退出**）、
 *         navigate（先挂 loadWait 再导航）、launchOnce（spawn 成功即刻记账、子进程退出只记日志）、
 *         stopInternal（三级关闭）、stopSync（退出路径不盘点进程）、pid 账本读写容错、
 *         isOurProfileCommand（命令行去引号归一后判 profile）、killPidTrees（/T 杀进程树）、
 *         closeViaBrowserCdp（「Browser.close 不回包按可能已关闭处理」）。
 * 本项目改造点（**勿照搬上游**）：
 *   1. 单会话单例 + **单 pid**（不做全机进程盘点、不认领已在跑的实例 —— 后者等于接管用户的浏览器，[A2-5]/[A2-10]）；
 *   2. pid 文件 `pm-hit.pid`（5 字段）是**不可信输入**：动手前必须双校验（进程名 + 命令行含本 profile + CreationDate）；
 *   3. stop 三级：CDP Browser.close → `taskkill /T` → `taskkill /T /F` → 弃端口留痕；**禁 `/IM` 批量杀**（[A2-10]/[A2-11]）；
 *   4. 不做 headless、不做自动重试、不做 highlight/reopen 两入口（语义合并进 verify，[A2-5]）；
 *   5. 顶层不 require('electron')：需要的能力（浏览器路径表 / vault 读 / 审计）全部**注入**（[A2-16] 第 3 条）。
 *
 * 「错误码与用户提示分离」：返回 `{ success:false, error, code }`——`error` 给人看（文案取自 ERR_HIT），
 * `code` 只进日志/审计。任何文案与日志里都**不出现真实用户目录**（[A2-13]）。
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const {
  HIT_BUDGET,
  HIT_SCRIPT,
  ERR_HIT,
  HIT_PROFILE_DIR_NAME,
  HIT_REASONS,
  buildLaunchArgs,
  buildHitScriptArgs,
  computeHitBudget,
  devToolsPortPath,
  hitProfileDirOf,
  isInsideHitProfile,
  isHttpUrl,
  normalizeHitFacts,
  parseBrowserWsPath,
  parseDevToolsPort,
  pidFilePath,
  pickKillable,
  pickProcShell,
  queryFailureOf,
  splitRoleSelector,
  validateHitTestArgs,
} = require('./hit-args');
const { attach, closeBrowser, discoverPageTarget, isClosedError } = require('./cdp');

/** 轮询间隔（等 DevToolsActivePort / 等进程消失） */
const POLL_MS = 100;
/** 单次 verify 里「等进程消失」的两级预算（[A2-11]：L2 2000 / L3 3000） */
const KILL_WAIT_MS = { l2: 2000, l3: 3000 };
/** 高亮框配色（Overlay.highlightNode；不画 DOM，[A2-7]） */
const HIGHLIGHT_CONFIG = Object.freeze({
  showInfo: false,
  contentColor: { r: 255, g: 59, b: 48, a: 0.08 },
  borderColor: { r: 255, g: 59, b: 48, a: 0.9 },
});

/* ================================================================
   模块级单例状态（[A2-5]：只能有一份「现在到底有没有会话」的判断）
   ================================================================ */

let deps = {
  dataDir: '',
  findBrowser: () => '',
  spawn: null,
  spawnSync: null,
  fetch: null,
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  log: () => {},
  audit: () => {},
  isUnlocked: () => false,
  findElement: () => null,
  /** 探测可执行文件（默认复用仓库既有 `electron/which.js`；单测可注入成「没有 pwsh」） */
  which: (name) => require('./which').which(name),
};

/** PowerShell 解释器名的缓存（`where pwsh` 一次 ~50ms，别每个 pid 都探一次） */
let procShellCache = '';

/** 取「本次可用的 PowerShell」：pwsh 优先，没有就 powershell.exe（C-02） */
function procShell() {
  if (!procShellCache) procShellCache = pickProcShell(deps.which);
  return procShellCache;
}

/** 当前会话；null = 没有会话。字段见 startSession() */
let session = null;
/** 正在跑的 verify（同参合并 / 异参 busy，[A2-5]） */
let inflight = null;
/** 空闲自停定时器（[A2-6] idleStop） */
let idleTimer = null;

/** 注入依赖（ipc 层在 register 时调一次；测试也可以直接调） */
function configure(next) {
  deps = Object.assign({}, deps, next || {});
}

/** 把用户地址脱敏成 `协议//host/path`（[A2-13]：审计与状态里不许出现 query/片段） */
function safeUrl(value) {
  const raw = String(value || '');
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}

/** 只留 host（审计字段，[A2-13]） */
function safeHost(value) {
  try {
    return new URL(String(value || '')).host;
  } catch {
    return '';
  }
}

function fail(error, code) {
  return { success: false, error, code };
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(ms) || 1)));

/* ================================================================
   pid 账本（[A2-10]：spawn 成功立刻写，stop 收尾删；删不掉不阻塞）
   ================================================================ */

function writePidFile(profileDir, info) {
  const file = pidFilePath(profileDir);
  if (!file) return { ok: false, message: '没有 profile 目录' };
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(info || {}, null, 2), 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

function readPidFile(profileDir) {
  const file = pidFilePath(profileDir);
  const text = readTextSafe(file);
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    const pid = Number(j.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
      pid,
      sessionId: String(j.sessionId || ''),
      exe: String(j.exe || ''),
      startedAt: String(j.startedAt || ''),
    };
  } catch {
    return null;
  }
}

function clearPidFile(profileDir) {
  const file = pidFilePath(profileDir);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* 删不掉不阻塞（[A2-10]） */
  }
}

/* ================================================================
   进程校验（[A2-10]：三项全过才动手）
   ================================================================ */

/**
 * `tasklist` 的「查无此进程」提示行（英文 / 中文版）——**它不是进程名**。
 *
 * 历史缺陷（QA t15 的 B-2）：老实现把整行原样当进程名返回，于是 `isPidAlive` 对一个
 * 已经退出的 pid 回 `true`，`waitPidGone` 等满超时 → `stop` 恒落 L3 并报 `stop-failed`（实测 9.7s）。
 */
const TASKLIST_INFO_RE = /^\s*(INFO|信息)\s*[:：]/i;

/** 合法进程映像名（Windows 上一定是 `xxx.exe`） */
const EXE_NAME_RE = /^[\w.\- ]+\.exe$/i;

/**
 * 解析 `tasklist /FO CSV /NH` 的第一列进程名；**非 CSV 行 / 提示行 / 不像进程名一律回 ''**。
 *
 * 只回合法名字是刻意的：调用方用「有没有拿到名字」判断进程是否存活，
 * 放宽一点就会把「没查到」读成「还活着」（B-2 就是这么来的）。
 */
function parseTasklistName(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return '';
  if (TASKLIST_INFO_RE.test(text)) return '';
  const m = text.match(/^"([^"]+)"/);
  const name = (m ? m[1] : text.split(',')[0].replace(/^"|"$/g, '')).trim();
  if (!name) return '';
  return EXE_NAME_RE.test(name) ? name : '';
}

/** 解析 PowerShell `ConvertTo-Json -Compress` 的进程信息；坏 JSON 回 null */
function parseCimJson(stdout) {
  const text = String(stdout || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    return {
      cmd: String(j.CommandLine === undefined || j.CommandLine === null ? '' : j.CommandLine),
      creation: String(j.CreationDate === undefined || j.CreationDate === null ? '' : j.CreationDate),
    };
  } catch {
    return null;
  }
}

const PS_PROC_SCRIPT =
  'Get-CimInstance Win32_Process -Filter "ProcessId=__PID__" | ' +
  'Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress';

/**
 * 三项校验：进程名白名单 + 命令行含本次 profile 绝对路径 + 创建时间不早于会话开始。
 *
 * 任一项取不到就回 `{ ok:false }` —— **宁可少杀，不许错杀**：
 * 按镜像名批量杀会杀掉用户正在用、带未保存表单的真实浏览器（[A2-10] 后果最重的一条）。
 *
 * **PowerShell 不许写死**（C-02，review-code P1）：`pickProcShell` 按「pwsh → powershell.exe」
 * 探测（复用 `electron/which.js`）。Win10/11 默认没有 pwsh，写死会让这里恒 `{ok:false}`，
 * 于是 stop 的 L2/L3 永不执行、留一个带调试端口的浏览器进程。
 * 同时 `parsePowerShellDate` 要认 5.1 的 `/Date(ms)/`（只换 shell 不换日期解析等于没修）。
 *
 * @param {{timeoutTasklist?: number, timeoutShell?: number}} [opts] 退出路径用更紧的超时
 * @returns {{ok:boolean, why?:string, name?:string}}
 */
function verifyProcess(pid, profileDir, startedAt, opts) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return { ok: false, why: '不是有效 pid' };
  if (!profileDir) return { ok: false, why: '没有本次 profile 路径' };
  if (typeof deps.spawnSync !== 'function') return { ok: false, why: '没有可用的进程查询能力' };
  const o = opts || {};
  const timeoutTasklist = Math.max(300, Number(o.timeoutTasklist) || 3000);
  const timeoutShell = Math.max(500, Number(o.timeoutShell) || 4000);

  // 1) 进程名（tasklist 快：本机实测 ~137ms）
  let name = '';
  try {
    const out = deps.spawnSync('tasklist', ['/FI', `PID eq ${p}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: timeoutTasklist,
      windowsHide: true,
    });
    name = parseTasklistName(out && out.stdout);
  } catch (e) {
    return { ok: false, why: '查进程名失败：' + String((e && e.message) || e) };
  }

  // 2) 命令行 + 创建时间（PowerShell CIM；本机实测 pwsh ~1.5s / powershell.exe ~1.9s）
  const shell = procShell();
  let info = null;
  try {
    const out = deps.spawnSync(
      shell,
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', PS_PROC_SCRIPT.replace('__PID__', String(p))],
      { encoding: 'utf8', timeout: timeoutShell, windowsHide: true }
    );
    info = parseCimJson(out && out.stdout);
  } catch (e) {
    return { ok: false, why: '查命令行失败：' + String((e && e.message) || e) };
  }
  if (!info) return { ok: false, why: '取不到进程命令行，不敢动这个 pid' };

  const picked = pickKillable(
    [{ pid: p, name, cmd: info.cmd, creation: info.creation }],
    { profileDir, startedAt: startedAt || '' }
  );
  if (!picked.ours.length) {
    return { ok: false, why: (picked.skipped[0] && picked.skipped[0].why) || '校验不通过' };
  }
  return { ok: true, name };
}

/**
 * 只杀校验通过的 pid（[A2-10]）：`kill` 由调用方注入，**未通过的 pid 绝不进 kill**。
 * 这个函数是纯编排（不碰 fs / spawn），所以能被单测用夹具 + 间谍直接断言「没调用 taskkill」。
 */
function killOurs(procs, ctx, kill) {
  const picked = pickKillable(procs, ctx);
  const killed = [];
  if (typeof kill === 'function') {
    for (const p of picked.ours) {
      kill(p.pid);
      killed.push(p.pid);
    }
  }
  return { killed, skipped: picked.skipped };
}

/**
 * 进程是否还活着（`tasklist /FI` 精确查一个 pid）。
 *
 * **只有拿到合法进程名才算存活**：查不到 / 拿到「INFO: 没有运行的任务」提示 / 名字不像
 * `xxx.exe`，一律回 `false`。老实现用 `name !== 'info:'` 兜，而实际提示行是
 * `INFO: No tasks are running which match the specified criteria.` → 永远判存活（B-2）。
 */
function isPidAlive(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  if (typeof deps.spawnSync !== 'function') return false;
  try {
    const out = deps.spawnSync('tasklist', ['/FI', `PID eq ${p}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return !!parseTasklistName(out && out.stdout);
  } catch {
    return false;
  }
}

/** 等进程真的消失（比 sleep 固定时长可靠；上游 waitOwnedGone 同款思想） */
async function waitPidGone(pid, timeoutMs) {
  const deadline = deps.now() + Math.max(200, Number(timeoutMs) || 2000);
  while (deps.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isPidAlive(pid);
}

/** `taskkill /PID <pid> /T [/F]`（Windows 上必须 /T，否则渲染/GPU 子进程成孤儿） */
function taskkill(pid, force) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  if (typeof deps.spawnSync !== 'function') return false;
  try {
    const out = deps.spawnSync('taskkill', args, { encoding: 'utf8', timeout: 4000, windowsHide: true });
    /**
     * SEC-08（review-sec P3）：**读 status 才算成功**。
     *
     * 老实现不读返回值直接 `return true` —— 于是 `killed` 可能被置成 true 而进程仍在
     * （随后 `gone:false` 落 `stop-failed`），审计里 `killed:true` 与事实相反，
     * 破坏 `[A2-10]` 要求的「失败记 `killed:false`」。这里以 `status === 0` 为准。
     */
    const status = out && typeof out.status === 'number' ? out.status : null;
    if (status === 0) return true;
    deps.log(`[hit] taskkill 未成功：pid=${pid} force=${force ? 'Y' : 'N'} status=${status === null ? '未知' : status}`);
    return false;
  } catch (e) {
    deps.log('[hit] taskkill 失败：' + String((e && e.message) || e));
    return false;
  }
}

/* ================================================================
   启动与连接（[A2-8] / [A2-9]）
   ================================================================ */

/** 启动前清掉上一轮留下的 DevToolsActivePort（不清就会连到一个早已没了的端口） */
function clearStaleDevToolsPort(profileDir) {
  try {
    fs.unlinkSync(devToolsPortPath(profileDir));
  } catch {
    /* 本来就不存在 */
  }
}

/**
 * 清理前的包含性校验（[A2-9]：**删除/清空的对象永不由调用方给**）。
 *
 * profileDir 一律由 `hitProfileDirOf(dataDir)` 算出来；这里再校一次，
 * 是为了让「万一它被谁改成外部路径」在删之前就被拦住（而不是删完才发现）。
 * 校验不通过就返回 false，调用方跳过清理并留痕。
 */
function guardProfileForCleanup(dataDir, profileDir) {
  const dir = String(profileDir || '');
  if (!dir) return false;
  if (!isInsideHitProfile(dataDir, dir)) return false;
  return path.basename(dir) === HIT_PROFILE_DIR_NAME;
}

/** 浏览器 exe：先 Chrome 再 Edge（路径表只有一份，复用 ipc-browser 的 findBrowser，[A2-16] 第 4 条） */
function pickBrowserExe(findBrowser) {
  const order = ['chrome', 'msedge'];
  for (const id of order) {
    let p = '';
    try {
      p = String(findBrowser(id) || '');
    } catch {
      p = '';
    }
    if (p) return p;
  }
  return '';
}

/**
 * 等浏览器就绪：**只看 DevToolsActivePort + /json/list**，不看子进程退出码。
 *
 * Windows 上 spawn 出来的常常只是「转发进程」，转完就退（上游 bug1）——
 * 拿 exitCode 判「浏览器没起来」会造成假失败，所以子进程事件只记日志。
 *
 * 两个失败 reason 必须分开（[A2-4]：不许把两种没起来说成一句话）：
 *   `dap-timeout`     文件一直没出现 → 「浏览器起来了但没拿到调试端口」
 *   `attach-timeout`  文件有、端点不应答 → 「连不上调试通道」
 */
async function waitForDevTools(profileDir, budget, expectedUrl) {
  const b = budget || computeHitBudget(0);
  const launchDeadline = deps.now() + b.launch;
  let sawFile = false;
  let lastCode = '';
  while (deps.now() < launchDeadline) {
    const text = readTextSafe(devToolsPortPath(profileDir));
    const port = parseDevToolsPort(text);
    if (port) {
      sawFile = true;
      // [SEC-03]：把本次请求的 url 传下去，只接受同源的 page target
      const found = await discoverPageTarget(port, {
        timeout: Math.min(2500, b.attach),
        fetch: deps.fetch,
        expectedUrl,
      });
      if (found.ok) {
        return { ok: true, port, browserWsPath: parseBrowserWsPath(text), target: found.target };
      }
      lastCode = String((found && found.code) || '');
      // 缺少期望地址是**入参错误**，不是「还没就绪」：立刻失败，不要轮询到超时
      if (lastCode === 'CDP_NO_EXPECTED_URL') {
        return { ok: false, error: ERR_HIT.attachFailed, code: 'attach-failed' };
      }
    }
    await sleep(POLL_MS);
  }
  if (!sawFile) return { ok: false, error: ERR_HIT.noDevToolsPort, code: 'dap-timeout' };
  // 端口有了但一直挑不到同源 target：按 [SEC-03] 判「连不上」，**不许**换个 target 硬连
  return { ok: false, error: ERR_HIT.attachFailed, code: 'attach-timeout' };
}

/** 连上 page target 并 enable 四个域（[A2-7] 白名单内，[A2-8] 第 4 步） */
async function attachAndEnable(target, budget) {
  let client;
  try {
    client = await attach(target.webSocketDebuggerUrl, { timeout: budget.attach });
  } catch (e) {
    return { ok: false, error: ERR_HIT.attachFailed, code: 'attach-failed', detail: String((e && e.message) || e) };
  }
  try {
    await client.send('Runtime.enable', {}, 3000);
    await client.send('Page.enable', {}, 3000);
    await client.send('DOM.enable', {}, 3000);
    await client.send('Overlay.enable', {}, 3000);
  } catch (e) {
    try {
      client.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: ERR_HIT.attachFailed, code: 'enable-failed', detail: String((e && e.message) || e) };
  }
  return { ok: true, client };
}

/** 导航到目标页：**先挂 loadWait 再 navigate**（顺序反了会等不到事件） */
async function navigateTo(client, url, budget) {
  try {
    await client.send('Page.enable', {}, 2000);
  } catch {
    /* 有些 target 不需要 enable，失败不影响导航 */
  }
  const loadWait = client.waitFor('Page.loadEventFired', budget.attach).then(
    () => true,
    () => false
  );
  let res;
  try {
    res = await client.send('Page.navigate', { url }, Math.max(3000, budget.attach));
  } catch (e) {
    return { ok: false, error: '页面打开失败', code: 'nav-failed', detail: String((e && e.message) || e) };
  }
  if (res && res.errorText) {
    return { ok: false, error: `页面打开失败：${String(res.errorText)}`, code: 'nav-failed' };
  }
  const loaded = await loadWait;
  return { ok: true, loaded };
}

/**
 * 起一套新会话：建 profile → 清旧端口文件 → spawn → 立刻记账 → 等端口 → 连 CDP → 导航。
 *
 * 失败时**自己收尾**（刚起的进程按校验杀掉），并把 reason/code 如实带回 ——
 * [A2-4]：任何失败都不许变成 `hit.found === false`。
 */
async function startSession(url, budget) {
  const profileDir = hitProfileDirOf(deps.dataDir);
  if (!profileDir) return { ok: false, error: '数据目录没准备好，浏览器配置存不下来', code: 'no-data-dir' };
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '建浏览器配置目录失败', code: 'profile-failed', detail: String((e && e.message) || e) };
  }

  const exe = pickBrowserExe(deps.findBrowser);
  if (!exe) return { ok: false, error: ERR_HIT.noBrowser, code: 'no-browser' };
  if (typeof deps.spawn !== 'function') return { ok: false, error: ERR_HIT.launchFailed, code: 'launch-failed' };

  clearStaleDevToolsPort(profileDir);

  const sessionId = String(deps.uuid() || crypto.randomUUID());
  const startedAt = new Date(deps.now()).toISOString();
  const browserId = /msedge/i.test(exe) ? 'msedge' : 'chrome';

  let child;
  try {
    child = deps.spawn(exe, buildLaunchArgs({ profileDir, url }), {
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
    });
  } catch (e) {
    return { ok: false, error: ERR_HIT.launchFailed, code: 'launch-failed', detail: String((e && e.message) || e) };
  }
  const pid = Number(child && child.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: ERR_HIT.launchFailed, code: 'launch-failed' };
  }

  // 启动后**立即**记账：哪怕这个 pid 只是转发进程，它也是我们拉起的
  const rec = writePidFile(profileDir, { pid, sessionId, exe, profileDir, startedAt });
  if (!rec.ok) deps.log('[hit] pid 账本写不进去，残留清理只能靠命令行匹配');

  // 子进程事件只记日志（Windows 转发进程转完就退是常态，不代表浏览器退出）
  if (child && typeof child.on === 'function') {
    child.on('exit', (code) => deps.log(`[hit] browser child exited pid=${pid} code=${code}（只记日志）`));
    child.on('error', (e) => deps.log('[hit] browser child error：' + String((e && e.message) || e)));
  }

  /**
   * `[SEC-02]`（契约 v5）：**启动失败也必须留痕**。
   *
   * 之前这三个失败出口直接 `return`，审计里什么都没有 —— 而 `[A2-13]` 的 `stoppedAt`
   * 语义是「这次会话真的收尾了」。失败也是收尾，只是以失败收尾。
   * 审计仍是**既有 8 键**（不加 reason/URL/path/label）；失败这个事实由调用方另行落 app.log。
   */
  const auditStartFailure = (killed) => {
    auditHitSession({ sessionId, browserId, url, startedAt, hits: 0 }, { killed: killed === true, ok: false });
  };

  const ready = await waitForDevTools(profileDir, budget, url);
  if (!ready.ok) {
    // 收尾：按校验结果决定要不要杀（校验不过就不碰）
    let killed = false;
    if (verifyProcess(pid, profileDir, startedAt).ok) {
      killed = taskkill(pid, true);
      await waitPidGone(pid, KILL_WAIT_MS.l2);
    }
    clearPidFile(profileDir);
    auditStartFailure(killed);
    return ready;
  }

  const conn = await attachAndEnable(ready.target, budget);
  if (!conn.ok) {
    let killed = false;
    if (verifyProcess(pid, profileDir, startedAt).ok) {
      killed = taskkill(pid, true);
      await waitPidGone(pid, KILL_WAIT_MS.l2);
    }
    clearPidFile(profileDir);
    auditStartFailure(killed);
    return conn;
  }

  session = {
    sessionId,
    browserId,
    exe,
    pid,
    profileDir,
    port: ready.port,
    browserWsPath: ready.browserWsPath,
    client: conn.client,
    url,
    startedAt,
    lastHitAt: '',
    lastHitAtMs: deps.now(),
    hits: 0,
  };

  const nav = await navigateTo(conn.client, url, budget);
  if (!nav.ok) {
    await stopSession('nav-failed');
    return { ok: false, error: nav.error, code: nav.code };
  }
  resetIdleTimer();
  deps.log(`[hit] 会话就绪 ${browserId} pid=${pid} port=${ready.port}`);
  return { ok: true };
}

/** 确保有可用会话（同 url 复用、不同 url 导航；断了就重建一次） */
async function ensureReady(url, budget) {
  if (session && session.client && !session.client.closed && session.port) {
    if (session.url === url) return { ok: true };
    const nav = await navigateTo(session.client, url, budget);
    if (nav.ok) {
      session.url = url;
      return { ok: true };
    }
    // 通道断了：收掉再重建（一次，不重试）
    await stopSession('stale');
  }
  return startSession(url, budget);
}

/* ================================================================
   查询段（[A2-7]：两段固定脚本调用 + Overlay 高亮）
   ================================================================ */

/**
 * 查一次事实并画框。
 *
 * 全程只用白名单方法：`Runtime.evaluate('document')` 拿 document 句柄 →
 * `Runtime.callFunctionOn`（事实，returnByValue）→ 再一次（元素，要 objectId）→
 * `DOM.requestNode` → `Overlay.highlightNode` → `Runtime.releaseObject`。
 * 定位值只经 `arguments` 以 JSON 传值，脚本是常量（绝无拼接）。
 */
async function queryFacts(plan, budget) {
  const client = session && session.client;
  if (!client || client.closed) return { ok: false, error: ERR_HIT.attachFailed, code: 'cdp-closed' };

  const docRes = await client.send('Runtime.evaluate', { expression: 'document' }, 3000);
  const docId = docRes && docRes.result && docRes.result.objectId;
  if (!docId) return { ok: false, error: ERR_HIT.queryFailed, code: 'no-document' };

  const factRes = await client.send(
    'Runtime.callFunctionOn',
    {
      objectId: docId,
      functionDeclaration: HIT_SCRIPT,
      arguments: [{ value: buildHitScriptArgs(plan, false) }],
      returnByValue: true,
    },
    budget.query
  );
  const raw = factRes && factRes.result ? factRes.result.value : null;
  if (!raw || typeof raw !== 'object') return { ok: false, error: ERR_HIT.queryFailed, code: 'bad-facts' };

  // 命中才画框：再取一次「第一个命中元素」的 objectId（脚本只有一段，两处调用同一常量）
  if (Number(raw.total) > 0) {
    try {
      const elRes = await client.send(
        'Runtime.callFunctionOn',
        {
          objectId: docId,
          functionDeclaration: HIT_SCRIPT,
          arguments: [{ value: buildHitScriptArgs(plan, true) }],
          returnByValue: false,
        },
        Math.min(2000, budget.query)
      );
      const elId = elRes && elRes.result && elRes.result.objectId;
      if (elId) {
        try {
          const nodeRes = await client.send('DOM.requestNode', { objectId: elId }, 2000);
          const nodeId = nodeRes && nodeRes.nodeId;
          if (nodeId) {
            await client.send('Overlay.highlightNode', { nodeId, highlightConfig: HIGHLIGHT_CONFIG }, 2000);
          }
        } finally {
          try {
            await client.send('Runtime.releaseObject', { objectId: elId }, 1000);
          } catch {
            /* 释放失败不影响结论 */
          }
        }
      }
    } catch {
      /* 画框失败不影响「命中」这个事实（点验的价值是事实，不是那根红线） */
    }
  }
  return { ok: true, raw };
}

/* ================================================================
   空闲自停（[A2-6] idleStop / [A2-12]）
   ================================================================ */

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stopSession('idle').catch(() => {
      /* 自停失败不抛（已经留痕） */
    });
  }, HIT_BUDGET.idleStop);
  // 定时器不该因为一个点验会话把进程钉住
  if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
}

/* ================================================================
   对外：verify / status / stop
   ================================================================ */

/** `el:hit-test` 的唯一入口（三个 op 在这一处分流，避免三份状态判断漂移，[A2-1]） */
async function handle(input) {
  const v = validateHitTestArgs(input, {
    unlocked: !!deps.isUnlocked(),
    findElement: (pageId, elementId) => deps.findElement(pageId, elementId),
  });
  if (!v.ok) return fail(v.error, v.code);
  if (v.op === 'status') return { success: true, data: { op: 'status', session: status() } };
  if (v.op === 'stop') return stopSession('user');
  return verify(v.plan);
}

async function verify(plan) {
  const key = [plan.url, plan.kind, plan.locator, plan.roleName].join('|');
  if (inflight) {
    // 同参合并（面板连点两次是常态）；异参明确 busy，不排队
    if (inflight.key === key) return inflight.promise;
    return fail(ERR_HIT.busy, 'busy');
  }
  const promise = (async () => {
    try {
      return await runVerify(plan);
    } finally {
      inflight = null;
    }
  })();
  inflight = { key, promise };
  return promise;
}

async function runVerify(plan) {
  const startedMs = deps.now();
  const budget = plan.budget || computeHitBudget(plan.timeoutMs);

  const ready = await ensureReady(plan.url, budget);
  if (!ready.ok) return fail(ready.error, ready.code); // [A2-4]：不带 hit 字段

  let queried;
  try {
    queried = await queryFacts(plan, budget);
  } catch (e) {
    const closed = isClosedError(e);
    if (closed) await stopSession('closed');
    return fail(
      closed ? ERR_HIT.attachFailed : e && e.code === 'CDP_TIMEOUT' ? ERR_HIT.timeout : ERR_HIT.queryFailed,
      closed ? 'cdp-closed' : e && e.code === 'CDP_TIMEOUT' ? 'query-timeout' : 'query-failed'
    );
  }
  if (!queried.ok) return fail(queried.error, queried.code);

  /**
   * C-03（review-code P1）：**非法选择器不许伪装成「没命中」**。
   * 判定与文案的单一真源在 `hit-args.queryFailureOf`（纯函数，可单测），这里只负责转成回执。
   */
  const qf = queryFailureOf(queried.raw);
  if (qf) return fail(qf.error, qf.code);

  const hit = normalizeHitFacts(queried.raw, {
    kind: plan.kind,
    locator: plan.locator,
    roleName: plan.roleName,
    source: plan.source,
    pageId: plan.pageId,
    elementId: plan.elementId,
    ms: deps.now() - startedMs,
  });

  if (session) {
    session.hits += 1;
    session.lastHitAt = new Date(deps.now()).toISOString();
    session.lastHitAtMs = deps.now();
    resetIdleTimer();
  }
  return { success: true, data: { op: 'verify', hit, session: status() } };
}

/** 会话状态（**只读**：绝不拉起浏览器、绝不导航，[A2-5]） */
function status() {
  if (!session) {
    return {
      open: false,
      sessionId: '',
      browserId: '',
      port: 0,
      url: '',
      startedAt: '',
      lastHitAt: '',
      idleStopInMs: HIT_BUDGET.idleStop,
    };
  }
  const idleUsed = Math.max(0, deps.now() - (session.lastHitAtMs || deps.now()));
  return {
    open: true,
    sessionId: session.sessionId,
    browserId: session.browserId,
    port: session.port || 0,
    url: safeUrl(session.url),
    startedAt: session.startedAt,
    lastHitAt: session.lastHitAt || '',
    idleStopInMs: Math.max(0, HIT_BUDGET.idleStop - idleUsed),
  };
}

/**
 * 关掉会话（[A2-11] 三级降级 + 幂等）。
 *
 * 顺序**不许调换**：L1→L2→L3 全程保留调试端口，只有全部失败才弃端口 ——
 * 先弃端口会让 L1 失去唯一一次「优雅关闭」的机会，而优雅关闭能保住用户在那个浏览器里没提交的表单。
 */
async function stopSession(reason) {
  const s = session;
  if (!s) {
    return {
      success: true,
      data: { op: 'stop', stopped: true, killed: false, alreadyStopped: true, session: status() },
    };
  }
  session = null; // 立刻从单例摘掉：后续 verify 会重新拉起，不会再拿到这个半死会话
  clearIdleTimer();

  let level = 'none';
  let killed = false;

  // L1：CDP Browser.close（browser 端点，等 ≤ 2000ms）
  if (s.port && s.browserWsPath) {
    const closed = await closeBrowser(s.port, s.browserWsPath, { timeout: 2000 });
    if (closed.ok) level = 'browser-close';
  }
  let gone = await waitPidGone(s.pid, KILL_WAIT_MS.l2);

  /**
   * L1 之后进程已经不在 → **直接判干净退出**：`stopped:true, killed:false`。
   *
   * 语义（[A2-11]）：`killed` 只在走 L2/L3 时为 true —— 浏览器自己退的（用户关窗口，
   * 或 `Browser.close` 生效）不该记成「被杀」。这条分支同时保证耗时 < 3s：
   * 不再跑两次 `verifyProcess`（每次都要起一次 pwsh）与 2s+3s 的等待。
   * 历史缺陷（B-2）下这条永远进不来 —— `isPidAlive` 把提示行当进程名，`gone` 恒为 false。
   */
  if (gone) {
    try {
      if (s.client && !s.client.closed) s.client.close();
    } catch {
      /* ignore */
    }
    if (guardProfileForCleanup(deps.dataDir, s.profileDir)) {
      clearPidFile(s.profileDir);
    } else {
      deps.log('[hit] 跳过 pid 账本清理：profile 不在数据目录下');
    }
    auditHitSession(s, { killed: false, ok: true });
    deps.log(`[hit] 会话已关闭（${reason} / ${level} / killed=false，进程在 L1 后已不在）`);
    return {
      success: true,
      data: { op: 'stop', stopped: true, killed: false, alreadyStopped: false, session: status() },
    };
  }

  // L2：taskkill /T（不带 /F）
  if (!gone) {
    const v = verifyProcess(s.pid, s.profileDir, s.startedAt);
    if (v.ok) {
      if (taskkill(s.pid, false)) {
        killed = true;
        level = 'taskkill';
      }
      gone = await waitPidGone(s.pid, KILL_WAIT_MS.l2);
    } else {
      deps.log('[hit] stop L2 停手：' + v.why);
    }
  }

  // L3：taskkill /T /F
  if (!gone) {
    const v = verifyProcess(s.pid, s.profileDir, s.startedAt);
    if (v.ok) {
      if (taskkill(s.pid, true)) {
        killed = true;
        level = 'taskkill-force';
      }
      gone = await waitPidGone(s.pid, KILL_WAIT_MS.l3);
    } else {
      deps.log('[hit] stop L3 停手：' + v.why);
    }
  }

  try {
    if (s.client && !s.client.closed) s.client.close();
  } catch {
    /* ignore */
  }
  // 清理前先过包含性校验：profile 必须是「我们自己算出来的那个目录」（[A2-9]）
  if (guardProfileForCleanup(deps.dataDir, s.profileDir)) {
    clearPidFile(s.profileDir);
  } else {
    deps.log('[hit] 跳过 pid 账本清理：profile 不在数据目录下');
  }

  // X：仍没关掉 → 放弃调试端口 + 留痕
  auditHitSession(s, { killed, ok: gone });
  if (!gone) {
    deps.log(`[hit] stop 失败（${reason}）：浏览器没能关掉，已放弃调试端口`);
    return fail(ERR_HIT.stopFailed, 'stop-failed');
  }
  deps.log(`[hit] 会话已关闭（${reason} / ${level} / killed=${killed}）`);
  return {
    success: true,
    data: { op: 'stop', stopped: true, killed, alreadyStopped: false, session: status() },
  };
}

/**
 * 退出路径的同步收尾（[A2-12] will-quit）。
 *
 * **不做「全盘进程盘点」**（那是上游 browser-session.js 的做法：扫一遍 Win32_Process，
 * 起一次 PowerShell 就是 1.5~1.9 秒，会把退出拖住）——这里只处理 pid 账本里记着的
 * **至多 2 个 pid**（本次 spawn 的 + 账本里的），且每个 pid 仍走 `[A2-10]` 的最小双校验：
 *   tasklist 查进程名（本机实测 ~137ms）+ PowerShell 查命令行（pwsh ~1.5s / powershell.exe ~1.9s）
 * 实测单 pid ≈ 1.7–2.1s、两 pid ≈ 3.4–4.2s（超时上限 1.0s + 1.5s = 2.5s/pid，即最坏 5s）。
 * 校验不过就不碰（宁可留一个进程，也不误杀用户的浏览器）。
 *
 * 说明（C-05，review-code P2）：上一版注释写「不做进程盘点」，与实现（每 pid 起一次 PowerShell）
 * 自相矛盾。现在注释按实测写清，并给退出路径更紧的超时（见下面 opts）。
 */
function stopSessionSync(reason) {
  const s = session;
  session = null;
  clearIdleTimer();
  const profileDir = s ? s.profileDir : hitProfileDirOf(deps.dataDir);
  const ledger = profileDir ? readPidFile(profileDir) : null;
  const targets = [];
  if (s && s.pid) targets.push({ pid: s.pid, startedAt: s.startedAt });
  if (ledger && ledger.pid && (!s || ledger.pid !== s.pid)) {
    targets.push({ pid: ledger.pid, startedAt: ledger.startedAt });
  }
  // 退出路径的超时要更紧：2 个 pid × 2.5s = 5s 最坏，仍比「扫全盘」可控
  const syncBudget = { timeoutTasklist: 1000, timeoutShell: 1500 };
  const startedMs = deps.now();
  let killed = false;
  for (const t of targets) {
    const v = verifyProcess(t.pid, profileDir, t.startedAt, syncBudget);
    if (!v.ok) {
      deps.log('[hit] 退出收尾停手：' + v.why);
      continue;
    }
    if (taskkill(t.pid, true)) killed = true;
  }
  if (s && s.client) {
    try {
      if (!s.client.closed) s.client.close();
    } catch {
      /* ignore */
    }
  }
  if (profileDir && guardProfileForCleanup(deps.dataDir, profileDir)) clearPidFile(profileDir);
  /**
   * `[SEC-02]`（契约 v5）：`will-quit` 这条路径**也必须写审计**。
   *
   * 之前只在异步 `stopSession` 里写，正常退出（用户关应用）等于「收尾了却无痕」——
   * 而 `[A2-13]` 的 `stoppedAt` 正是为这个场景定义的。这里没有会话时（`s === null`）
   * 也没有可记的 sessionId，直接跳过；有会话就按既有 **8 键**记一条。
   */
  if (s) auditHitSession(s, { killed, ok: true });
  deps.log(`[hit] 退出收尾完成（${reason}），处理 ${targets.length} 个 pid，耗时 ${deps.now() - startedMs}ms`);
}

/**
 * 审计一条（[A2-13]：**恰好 8 个键**）。
 *
 * 只记 host，不记完整 URL / path / query / label（`label` 是页面文本，可能含手机号/工号）。
 * 失败也不加自由文本字段 —— 自由文本只许进 app.log。
 */
function auditHitSession(s, extra) {
  if (!s) return;
  const entry = {
    action: 'el-hit-session',
    sessionId: s.sessionId,
    browserId: s.browserId,
    host: safeHost(s.url),
    startedAt: s.startedAt,
    stoppedAt: new Date(deps.now()).toISOString(),
    hits: Number(s.hits) || 0,
    killed: extra && extra.killed === true,
  };
  try {
    deps.audit(entry);
  } catch (e) {
    deps.log('[hit] 审计写入失败：' + String((e && e.message) || e));
  }
  if (extra && extra.ok === false) deps.log('[hit] 审计标记：本次 stop 未成功（ok:false）');
}

/** 测试/排障用：当前会话快照（不做任何副作用） */
function peek() {
  return session ? Object.assign({}, session, { client: undefined }) : null;
}

/** 测试用：重置单例（不杀进程；只清内存状态） */
function _reset() {
  clearIdleTimer();
  inflight = null;
  session = null;
  procShellCache = '';
}

/**
 * 测试用：种一个「看起来已经连上」的假会话。
 *
 * 存在的唯一理由：`stop` 的收尾语义（L1 之后进程已不在 → `stopped:true, killed:false`，
 * 且不跑 L2/L3）要在**不起真浏览器**的前提下可回归。生产路径永不调用它。
 */
function __setSessionForTest(next) {
  session = next || null;
  if (session) {
    session.hits = Number(session.hits) || 0;
    session.lastHitAtMs = Number(session.lastHitAtMs) || deps.now();
    session.lastHitAt = String(session.lastHitAt || '');
  }
  return session;
}

module.exports = {
  configure,
  handle,
  verify,
  status,
  stopSession,
  stopSessionSync,
  verifyProcess,
  killOurs,
  auditHitSession,
  parseTasklistName,
  parseCimJson,
  pickBrowserExe,
  safeUrl,
  safeHost,
  writePidFile,
  readPidFile,
  clearPidFile,
  clearStaleDevToolsPort,
  guardProfileForCleanup,
  isPidAlive,
  waitPidGone,
  peek,
  _reset,
  __setSessionForTest,
  HIT_PROFILE_DIR_NAME,
  HIT_REASONS,
  splitRoleSelector,
  isHttpUrl,
  isInsideHitProfile,
};
