'use strict';

/**
 * record-session.js —— 录制会话域：**单会话状态机** + 子进程 / 临时 profile 的生死管理 + 审计留痕。
 *
 * 状态机：`idle → starting → recording → stopping → idle`
 *   - `starting` 同步置位 ⇒ 并发第二次 `start` 立刻被挡（in-flight 互斥，不排队、不留悬挂 Promise）；
 *   - 对外 `state` 只有 `'recording'`（`stopping` 不外露，见契约 `[C-114]` `record:status` 定稿）。
 *
 * 六条硬约束（每条都能机械判定）：
 * 1. **清理不许误杀用户浏览器**（`[C-117]` 第 3 条 / `sec SEC-06`）：杀前双校验
 *    —— 进程 `CommandLine` 含**本会话的** `--user-data-dir=<profileDir>`，且 `CreationDate ≥ 会话启动时间`；
 *    任一不满足 → **不杀**，`killed:false` 落审计（宁可留进程，也不误杀用户带未保存表单的真实浏览器）。
 *    **禁止** `taskkill /IM chrome.exe` 这类按镜像名批量杀；一律 `spawn('taskkill', ['/PID', pid, '/T', '/F'], { shell:false })`。
 * 2. **临时 profile 建在应用数据目录下**（`[C-114b]` 第 3 条）：`<数据目录>/record-profiles/<sessionId>`，
 *    不是系统临时目录；会话结束即 `rmSync`。
 * 3. **端口只用 `--remote-debugging-port=0` + 读 `DevToolsActivePort`**（`[C-117]` 第 1 条）：
 *    禁止「先探空闲端口再传参」（TOCTOU）；启动总超时 15 s。
 * 4. **锁定即停录**（`[C-114a]`）：`lockStop(reason)` 是**主进程内部动作名**，不是 preload 通道、不计四通道四元组；
 *    由 main.js 挂到 `session:lock` / 自动锁 / 主窗口关闭 / 防截屏四个触发源。停录后 `status()` 必为 `null`。
 * 5. **审计只记 host**（`[C-119]` 第 7 款）：12 字段固定结构、`cleaned` 与审计同源、走主进程注入的既有
 *    `appendAudit`（**不经渲染层 `audit:log`**，那条通道没有 `pw()` 前置且 `detail` 被截到 200 字符）。
 * 6. **主进程是事件载荷的唯一强制点**（v20）：`seq` 单调（页面给的 `seq` / `sessionId` 一律丢弃重发）；
 *    `tag ≤ 32`、`role ≤ 64`、`selector ≤ 500`（超长**整条候选丢弃**，不截断成半截选择器）、
 *    `candidates ≤ 20`、未知键全丢；**`target.text` 一律不转发**（页面可见文本可能是手机号 / 身份证 / token）；
 *    `valueMeta` 只有两种形状（`{length, redacted:true}` / `{selectedIndex, redacted:true}`，数字必须有限）。
 *    页面绕过注入器直调 binding 的伪造载荷也必须被这套规则洗一遍（单测有该用例）。
 *
 * 事件传输：S2 的 `cdp-client` 只暴露 `evaluate(固定表达式)` / `callWithArgs(fn, args)` 两跳，**没有**通用
 * `onEvent` 钩子（改它不在本片 inScope）。所以页内用**闭包队列**（`window.__dshQueueTake`）收事件，
 * 主进程每 `FLUSH_MS`（16 ms）取一批（≤ `POLL_BATCH` 20 条）——语义与 `bindingCalled` 等价：
 * 队列对外只有 `take` 一个入口、页面无法向队列里塞任意串；`nonce` 仍是 binding 名（`__dsh_<nonce>`）。
 *
 * 全部外部能力经 `deps` 注入（spawn / fs / clock / 进程表 / CDP / 探针），单测不起真 Chrome、不写真盘。
 *
 * @module electron/record-session
 */

const crypto = require('crypto');
const fsDefault = require('fs');
const { spawn: spawnDefault, execFileSync } = require('child_process');

const { which: whichDefault } = require('./which');
const {
  buildChromeArgs,
  parseDevToolsActivePort,
  urlForLaunch,
  urlForStorage,
  validateSelectorItems,
  MAX_VALIDATE_ITEMS,
  MAX_SELECTOR_LENGTH,
  VALIDATE_STRATEGIES,
} = require('./record-args');
const { INSTALL_FN_SRC, VALIDATE_FN_SRC, bindingName } = require('./record-inject');
const { isChromiumExecutable, CHROMIUM_EXECUTABLES, probeAbilities: probeDefault } = require('./record-probe');
const { connect: cdpConnectDefault } = require('./cdp-client');
// R3-10：浏览器「装在哪」的真源是 ipc-browser.js 的 KNOWN_BROWSERS（应用级唯一清单）。
// 本模块只按它的安装布局 + 注入的 env 重新生根，**不再自己写一份路径表**。
const { KNOWN_BROWSERS } = require('./ipc-browser');

/** 启动总超时（契约 `[C-114]`：15 s，到点杀子进程并回「启动失败」） */
const START_TIMEOUT_MS = 15000;
/** 事件合批间隔（契约 `[C-114]`：16 ms） */
const FLUSH_MS = 16;
/** 单批上限（契约 `[C-114]`：单批 ≤ 20 条） */
const POLL_BATCH = 20;
/** 单会话事件上限（契约 `[C-114]`：5000，到顶置 `truncated` 并显式告警） */
const MAX_EVENTS = 5000;
/** 临时 profile 根目录名（放在应用数据目录下，见 `[C-114b]`） */
const PROFILE_ROOT_NAME = 'record-profiles';
/** 审计 action 固定串（`[C-119]` 第 7 款） */
const AUDIT_ACTION = 'record-session';
/** 等 DevToolsActivePort 的轮询间隔 */
const PORT_POLL_MS = 50;
/** 单条 validate 超时 / 整次 validate 超时（契约 `[C-114]`） */
const VALIDATE_ITEM_TIMEOUT_MS = 3000;
const VALIDATE_TOTAL_TIMEOUT_MS = 10000;
/** 页内事件 action 枚举（`session-ended` 只由主进程产生，页面发来一律丢弃） */
const PAGE_ACTIONS = ['navigate', 'click', 'fill', 'select', 'press', 'assert'];

/**
 * 停录的等待预算（毫秒）。**这是 D-2 的修复核心**：旧实现 `spawn('taskkill')` 之后**下一行就 `rmSync`**，
 * Windows 上 Chrome 的进程句柄还没释放，目录必然删不掉（现场 3/4 轮失败）。
 * 现在的顺序是：派发 taskkill → **轮询等进程树真的消失** → 再删目录 → 删不掉才重试 → 仍失败写原因。
 */
const EXIT_WAIT_MS = 800;
/** 删目录的有界重试间隔（第 1 次立即试；之后退让 120 / 240 ms） */
const PROFILE_RETRY_DELAYS = [0, 120, 240];
/** 轮询进程是否还活着的间隔 */
const EXIT_POLL_MS = 50;
/** 同步路径（锁定 / 关窗 / 应用退出）愿意阻塞的等待上限，比异步路径短得多 */
const SYNC_EXIT_WAIT_MS = 250;
/** 排障开关：置 `1` 时把 stop 链路的分段耗时打到 app.log（`PM_RECORD_TIMING=1`） */
const TIMING_ENV = 'PM_RECORD_TIMING';

/**
 * 事件管线的 tick 守卫（R3-07）。`poll()` 是 async，同步 try/catch 包不住它 ——
 * 一旦它返回的 promise reject（未来某次改动引入的），Node 会当成 unhandledRejection，
 * 会话既不收尾也不停轮询。这里同时兜住「同步抛」与「promise reject」。
 *
 * @param {() => unknown} run tick 本体
 * @param {(err: unknown) => void} onError 收敛回调（必须自己保证不再抛）
 * @returns {void}
 */
function guardTick(run, onError) {
  try {
    const result = run();
    if (result && typeof result.then === 'function') {
      result.then(undefined, (err) => { try { onError(err); } catch { /* 收敛失败也不许冒泡 */ } });
    }
  } catch (err) {
    try { onError(err); } catch { /* 同上 */ }
  }
}

/**
 * 幂等 stop 的最近会话 id 记忆条数（R3-09：**有界且仅进程内**，这是已知取舍）。
 *
 * 为什么不做成持久化/无界：`stop` 的幂等语义只需要覆盖「用户手抖连点两次」「渲染层重挂后补一次」
 * 这类**秒级重试**；把 N 个 id 写进盘等于多一份要加密、要迁移、要清理的状态，
 * 而「超出窗口的老 id 回 `会话已结束`」对用户是无害的（那个会话确实早就结束了）。
 * 取舍要写进契约：**进程生命周期内、最近 N 次 stop 幂等**（已报队长，t37 落契约）。
 */
const RECENT_STOP_LIMIT = 5;
/** 候选项上限（契约 `[C-114]`：candidates.length ≤ 20） */
const MAX_CANDIDATES = 20;
/** 进程创建时间与会话启动时间的容差（时钟精度/秒级截断） */
const CLOCK_SKEW_MS = 2000;
/** 单条事件 JSON 串的长度上限（SEC-R3-02：一个超大串也是一个 DoS 面） */
const MAX_EVENT_JSON_LENGTH = 8192;
/** ecord:probe 的 workspaceDir 长度上限（P3：防超长串进探针） */
const MAX_WORKSPACE_DIR_LENGTH = 1024;
/** 停止前排空页内队列的预算（RA3-02：**≤200 ms**，超时也不许把最后一批静默丢掉） */
const DRAIN_BUDGET_MS = 200;
/** 排空最多几轮（与预算双保险：假时钟/极端情况下也不会死循环） */
const MAX_DRAIN_ROUNDS = 20;

/**
 * 页内取事件通道被页面**换成了别的函数**时，表达式回这个哨兵串 → poll 判定「被篡改」并按停录收敛。
 * SEC-R3-07：不许表现成「录制中点不出事件」。
 */
const TAKE_TAMPERED = '__dshTakeTampered__';
/**
 * 页内取事件通道**整个不见了**（`typeof !== 'function'` 或标记缺失）—— D-4 的真凶。
 *
 * 它和「被替换」是**两件事**，必须分开判：
 *  - **函数根本不在**（`typeof !== 'function'`）= 文档换了（导航提交 / 站内跳转）
 *    → 正常现象，**重新注入**即可继续录（有界：`MAX_REINSTALL` 次）；
 *  - **槽里有函数但不是我们的**（没标记 / 标记与本会话不符）= 有人把它换掉了
 *    → 真篡改，收敛停录 + 写审计。
 *
 * t39 把两者都当「被替换」，于是 `record:start` 之后页面一导航（注入发生在 about:blank，
 * 导航提交后新文档里没有这些全局变量）就自我停录 —— 这就是 D-4 的根因。
 */
const TAKE_MISSING = '__dshTakeMissing__';
/** 每会话最多重新注入几次（页面每次导航注入一次是正常的；连续超限说明页面在跟我们抢，收敛） */
const MAX_REINSTALL = 5;
/** 等页面就绪的轮询间隔 */
const PAGE_READY_POLL_MS = 50;

/**
 * 取页内事件的**常量**表达式（绝不拼接外部输入）。
 *
 * 与旧版的区别：先确认 `window.__dshQueueTake` 仍是**本会话注入的那个函数**——注入时给它打了
 * `__dshTake = <nonce>` 标记、并另存 `window.__dshTakeMark`，两者比对。nonce 不在表达式里
 * （表达式保持常量），只在页内状态里比对。
 *
 * 能力边界（如实写明）：这只能发现「被换成了别的东西」（naive 替换、被框架/插件覆盖）。
 * 同源恶意页面本来就能伪造一切——真正的护栏是主进程侧的 `takeBatch` 截断 + 形状校验 + `normalizeEvent`。
 */
const POLL_EXPR = '(function () {'
  + 'var t = window.__dshQueueTake;'
  + 'var mark = window.__dshTakeMark;'
  // 函数不在 / 标记整个丢了 = 文档换了（导航）→ 判「缺失」，交给重新注入，不是篡改
  + 'if (typeof t !== "function") return "__dshTakeMissing__";'
  // 槽里有函数、但它不像我们的（没标记 / 标记对不上）= 有人把它换掉了 → 真篡改
  + 'if (!mark || !t.__dshTake || t.__dshTake !== mark) return "__dshTakeTampered__";'
  + 'return t(20);'
  + '})()';

/**
 * 页面是否已经就绪（D-4 的另一半）：注入**必须发生在目标文档里**，不能落进 `about:blank`。
 * 只读 `readyState` / `href`，不碰页面业务状态。
 */
const PAGE_READY_EXPR = '(function () { return JSON.stringify({'
  + 'ready: String(document.readyState || ""),'
  + 'href: String(location.href || "")'
  + '}); })()';

/** 页内闭包队列：`window.__dshQueueTake(max)` 是唯一出口，页面塞不进任意串 */
const QUEUE_FN_SRC = String.raw`function (name, nonce) {
  var q = [];
  var take = function (max) {
    var n = Math.max(0, Math.min(Number(max) || 0, q.length));
    return q.splice(0, n);
  };
  take.__dshTake = String(nonce);
  window.__dshQueueTake = take;
  window.__dshTakeMark = String(nonce);
  window[name] = function (json) {
    try { q.push(String(json)); } catch (e) { /* 忽略 */ }
  };
  return true;
}`;

/** 审计里 `profileRemovedError.code` 的清洗：只留短标识（EPERM / EBUSY / NO_DIR …） */
function sanitizeAuditCode(raw) {
  const text = String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return text || 'UNKNOWN';
}

/**
 * 审计里 `profileRemovedError.item` 的清洗：**只放相对子项**（`Default/Cookies`），绝不含绝对路径。
 * 任何看起来像盘符/绝对路径/带 `..` 的东西一律清空 —— 宁可少给线索，也不把用户目录写进可查询的审计。
 */
function sanitizeAuditItem(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\/g, '/').replace(/^\/+/, '').slice(0, 200);
  if (!text) return '';
  if (text.includes(':') || text.includes('..')) return '';
  return text;
}

/** 排障用的错误文案（只进 detail / 审计，不给界面当判据） */
const messageOf = (e) => String((e && e.message) || e || '未知错误');

/** 只用正斜杠拼路径（跨平台只作展示与存在性判断） */
function joinPath() {
  const parts = Array.prototype.slice.call(arguments).filter((p) => p !== '' && p != null);
  return parts
    .map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')))
    .join('/');
}

/** 比较命令行/路径时统一分隔符与大小写（Windows 大小写不敏感） */
const norm = (text) => String(text == null ? '' : text).replace(/\\/g, '/').toLowerCase();

/**
 * 解析进程表（纯函数，单测可 golden）。
 *
 * 输入是 `pid|创建时间(ISO)|命令行` 三列 TSV（默认依赖用 PowerShell 的 `Get-CimInstance Win32_Process`
 * 生成，见 `defaultDeps`）。**脏行一律跳过**——一行解析失败不该让整轮清理停摆。
 *
 * @param {unknown} text 原始输出
 * @returns {Array<{pid: number, commandLine: string, creationDate: number}>}
 */
function parseProcessList(text) {
  const out = [];
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const first = line.indexOf('|');
    if (first <= 0) continue;
    const second = line.indexOf('|', first + 1);
    if (second < 0) continue;
    const pid = Number(line.slice(0, first).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const creationDate = Date.parse(line.slice(first + 1, second).trim());
    if (!Number.isFinite(creationDate)) continue;
    const commandLine = line.slice(second + 1);
    if (!commandLine.trim()) continue;
    out.push({ pid, commandLine, creationDate });
  }
  return out;
}

/** 默认依赖：全部外部能力集中在这里，便于单测整体替换 */
function defaultDeps(overrides) {
  const base = {
    spawn: spawnDefault,
    fs: fsDefault,
    platform: process.platform,
    env: process.env,
    which: (name) => whichDefault(name),
    exists: (p) => {
      try { return fsDefault.existsSync(p); } catch { return false; }
    },
    randomBytes: (n) => crypto.randomBytes(n),
    /**
     * 进程表：Windows 用 PowerShell 输出 `pid|ISO 创建时间|命令行`；
     * 其它平台尽力而为（本产品只发 Windows 包，见 release/win-unpacked）。
     */
    listProcesses: () => {
      if (process.platform !== 'win32') return [];
      const script = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { '{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.CommandLine } }";
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parseProcessList(out);
    },
    connectCdp: (opts) => cdpConnectDefault(opts),
    probeAbilities: (input) => probeDefault(input),
    getDataDir: () => process.cwd(),
    getPassword: () => null,
    getMainWindow: () => null,
    appendAudit: () => undefined,
    onEvents: () => undefined,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      /**
       * 同步睡（只在**锁定 / 关窗 / 应用退出**这条同步路径上用，见 `SYNC_EXIT_WAIT_MS`）。
       * `Atomics.wait` 是唯一不依赖回调的同步睡眠手段（`scripts/release.js` 同款做法）。
       */
      sleepSync: (ms) => {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(ms) || 0));
        } catch { /* 环境不支持就退化成空转（宁可少等，也不卡死） */ }
      },
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    },
    /**
     * 进程是否还活着（`process.kill(pid, 0)` 只探测不发信号）。
     * Windows 上进程消失后抛 `ESRCH` → false。**不用进程表**：`listProcesses` 要起 PowerShell，
     * 在 stop 热路径上实测能吃掉 1–13 s（D-3 的长尾根因）。
     */
    isProcessAlive: (pid) => {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) return false;
      try {
        process.kill(n, 0);
        return true;
      } catch (e) {
        // EPERM = 进程存在但没权限发信号（照样算活）；ESRCH = 已消失
        return !!(e && e.code === 'EPERM');
      }
    },
    limits: {},
  };
  const merged = Object.assign(base, overrides || {});
  merged.limits = Object.assign({
    startTimeoutMs: START_TIMEOUT_MS,
    flushMs: FLUSH_MS,
    pollBatch: POLL_BATCH,
    maxEvents: MAX_EVENTS,
    validateItemMs: VALIDATE_ITEM_TIMEOUT_MS,
    validateTotalMs: VALIDATE_TOTAL_TIMEOUT_MS,
    exitWaitMs: EXIT_WAIT_MS,
    exitPollMs: EXIT_POLL_MS,
    syncExitWaitMs: SYNC_EXIT_WAIT_MS,
    profileRetryDelays: PROFILE_RETRY_DELAYS,
  }, (overrides && overrides.limits) || {});
  return merged;
}

/**
 * 从 `KNOWN_BROWSERS` 的一条绝对路径里抠出「安装目录 + 可执行文件名」的相对尾巴。
 *
 * `KNOWN_BROWSERS` 的路径是**在 ipc-browser.js 加载时**用真实 `process.env` 拼出来的绝对路径
 * （`C:\Program Files\...` / `%LOCALAPPDATA%\...`）。本模块要按**注入的 deps.env** 重新生根
 * （单测注入假 env，生产注入真 env），所以只取相对尾巴，不直接用那些绝对串。
 *
 * @param {unknown} raw 一条已知安装路径
 * @returns {string} 形如 `Google/Chrome/Application/chrome.exe`；认不出返回空串
 */
function browserInstallTail(raw) {
  const posix = String(raw == null ? '' : raw).replace(/\\/g, '/');
  const lower = posix.toLowerCase();
  for (const marker of ['program files (x86)/', 'program files/', 'appdata/local/', 'programdata/']) {
    const at = lower.indexOf(marker);
    if (at >= 0) return posix.slice(at + marker.length);
  }
  return '';
}

/** 非 Windows 平台的常见安装位置（`KNOWN_BROWSERS` 只维护 Windows 布局） */
const UNIX_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/brave-browser',
];

/**
 * 「本机可能装在哪」的候选路径清单（**真源 = `ipc-browser.js` 的 `KNOWN_BROWSERS`**，R3-10）。
 *
 * 为什么不再各写一份：`record-probe`（灯）与 `record-session`（启动）原先各有一张表且已经漂移
 * （darwin 下 probe 含 Brave、session 不含）——灯判绿而 start 找不到，靠 `which` 循环兜住属于侥幸。
 * 现在这里只做「按 deps.env 生根」，新增浏览器只需改 `KNOWN_BROWSERS` 一处。
 *
 * @param {{platform?: string, env?: Record<string, string|undefined>}} deps
 * @returns {string[]} 去重后的候选绝对路径（可能不存在，调用方自己 `exists`）
 */
function browserCandidates(deps) {
  const platform = (deps && deps.platform) || 'win32';
  if (platform !== 'win32') return UNIX_BROWSER_PATHS.slice();
  const env = (deps && deps.env) || {};
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA, env.PROGRAMDATA].filter(Boolean);
  const tails = [];
  for (const browser of Array.isArray(KNOWN_BROWSERS) ? KNOWN_BROWSERS : []) {
    for (const raw of (browser && browser.paths) || []) {
      const tail = browserInstallTail(raw);
      if (tail && !tails.includes(tail)) tails.push(tail);
    }
  }
  const out = [];
  for (const root of roots) {
    for (const tail of tails) {
      const candidate = joinPath(root, tail);
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * 浏览器可执行文件 → **展示名**（RA3-07）。
 *
 * `record:start` 的出参只给这个名字，**本机绝对路径不出主进程**（只进 app.log）：
 * 路径里带用户名与安装位置，属不必要的外泄。
 *
 * @param {unknown} exePath 绝对路径
 * @returns {string} 展示名；认不出时回可执行文件名（仍不含目录）
 */
function browserLabel(exePath) {
  const base = String(exePath == null ? '' : exePath).replace(/\\/g, '/').split('/').pop() || '';
  const stem = base.replace(/\.exe$/i, '').toLowerCase();
  const names = {
    chrome: 'Chrome',
    'chrome-proxy': 'Chrome',
    'google-chrome': 'Chrome',
    'google-chrome-stable': 'Chrome',
    msedge: 'Edge',
    'microsoft-edge': 'Edge',
    brave: 'Brave',
    'brave-browser': 'Brave',
    chromium: 'Chromium',
    'chromium-browser': 'Chromium',
    vivaldi: 'Vivaldi',
    opera: 'Opera',
    '360chrome': '360 浏览器',
    qqbrowser: 'QQ 浏览器',
    quark: '夸克',
  };
  return names[stem] || base || '未知浏览器';
}

/**
 * 找 Chromium 系可执行文件。白名单判定复用 `record-probe` 的 `isChromiumExecutable` / `CHROMIUM_EXECUTABLES`，
 * 安装位置来自 `browserCandidates()`（真源 `KNOWN_BROWSERS`，R3-10）。
 * @returns {string} 绝对路径；找不到回空串
 */
function findBrowser(deps) {
  for (const name of CHROMIUM_EXECUTABLES) {
    const found = deps.which(name);
    if (found && isChromiumExecutable(found)) return found;
  }
  for (const candidate of browserCandidates(deps)) {
    if (deps.exists(candidate) && isChromiumExecutable(candidate)) return candidate;
  }
  return '';
}

/** `nonce = sha256(sessionId).slice(0, 12)`（契约 `[C-117]` 第 4 条） */
function nonceOf(sessionId) {
  return crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12);
}

/**
 * 解析「启动 URL」与「入库 URL」——**两者不是同一个值**（RA2-03 / 契约 v20）。
 *
 * 真源是 `electron/record-args.js` 的两个函数（本函数只做组合，不再自己解析 URL）：
 * - `urlForLaunch(raw)`：交给 Chrome 的导航地址，**保留业务 query 与 fragment**（`?projectCode=` 丢了
 *   被测系统打开的就是坏链接、录制根本起不来），只剥 userinfo；
 * - `urlForStorage(raw)`：入库 / 审计 / 三产物 / `record:status` 用的脱敏版（`baseUrl` = origin + path）。
 */
function resolveUrls(raw) {
  const launch = urlForLaunch(raw);
  if (!launch.ok) return { ok: false, error: launch.error, detail: launch.detail };
  const storage = urlForStorage(raw);
  if (!storage.ok) return { ok: false, error: storage.error, detail: storage.detail };
  return { ok: true, urlForLaunch: launch.url, urlForStorage: storage.baseUrl, host: storage.host };
}

/** 事件 action 白名单判定 */
const isPageAction = (action) => PAGE_ACTIONS.includes(action);

/**
 * `valueMeta` 只有两种形状（契约 §9.1 / v19 四条不变量之 3）：
 * `{ length, redacted: true }` 或 `{ selectedIndex, redacted: true }`，数字必须是有限数。
 * 两种同时出现、都不出现、`redacted` 不是 `true`、数字非法 → 一律剥掉（返回 undefined）。
 */
function sanitizeValueMeta(input) {
  if (!input || typeof input !== 'object' || input.redacted !== true) return undefined;
  const hasLength = Object.prototype.hasOwnProperty.call(input, 'length');
  const hasIndex = Object.prototype.hasOwnProperty.call(input, 'selectedIndex');
  if (hasLength === hasIndex) return undefined;
  if (hasLength) {
    const n = input.length;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
    return { length: n, redacted: true };
  }
  const n = input.selectedIndex;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return { selectedIndex: n, redacted: true };
}

/** 候选定位器：只留契约字段；未登记策略、缺 selector、**selector > 500 字符**一律整条丢弃（不截断——半截选择器是错的） */
function sanitizeCandidates(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, MAX_CANDIDATES)) {
    if (!item || typeof item !== 'object') continue;
    if (!VALIDATE_STRATEGIES.includes(item.strategy)) continue;
    if (typeof item.selector !== 'string' || !item.selector) continue;
    if (item.selector.length > MAX_SELECTOR_LENGTH) continue;
    const candidate = {
      strategy: item.strategy,
      selector: item.selector,
      count: typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : null,
      precise: item.precise === true,
    };
    if (typeof item.roleName === 'string' && item.roleName) candidate.roleName = item.roleName.slice(0, 64);
    out.push(candidate);
  }
  return out;
}

/**
 * target：只留 `{ tag, role? }`。
 *
 * ⚠️ **`text` 一律不转发**（v20 主进程强制点条）：页面上可见文本随时可能是手机号、身份证、
 * token 或被测系统里的业务内容；`target.text` 只用于页内自我排障，不许出境。长度上限照强制点：
 * `tag ≤ 32`、`role ≤ 64`。
 */
function sanitizeTarget(input) {
  const rawTag = input && typeof input.tag === 'string' ? input.tag : '';
  const tag = rawTag ? rawTag.slice(0, 32) : '';
  if (!tag) return null;
  const target = { tag };
  const rawRole = input && typeof input.role === 'string' ? input.role : '';
  if (rawRole) target.role = rawRole.slice(0, 64);
  return target;
}

/**
 * 把一个页内上报的 JSON 串规整成「主进程可用」的事件（不含 sessionId / seq，那两键由主进程补）。
 * 返回 null = 该条丢弃（计入 dropped）。
 * @returns {{action: string, target: object, candidates: object[], ms: number, valueMeta?: object}|null}
 */
function normalizeEvent(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!isPageAction(parsed.action)) return null;
  const target = sanitizeTarget(parsed.target);
  if (!target) return null;
  const event = {
    action: parsed.action,
    target,
    candidates: sanitizeCandidates(parsed.candidates),
    ms: typeof parsed.ms === 'number' && Number.isFinite(parsed.ms) && parsed.ms >= 0 ? parsed.ms : 0,
  };
  const valueMeta = sanitizeValueMeta(parsed.valueMeta);
  if (valueMeta) event.valueMeta = valueMeta;
  return event;
}

/**
 * 建一个录制会话管理器。
 *
 * @param {object} [overrides] 依赖注入（单测替换 spawn / fs / clock / 进程表 / CDP）
 * @returns {{
 *   start: (input: {url?: unknown, pageId?: unknown}) => Promise<object>,
 *   stop: (input: {sessionId?: unknown}) => Promise<object>,
 *   status: () => object|null,
 *   validate: (input: {sessionId?: unknown, items?: unknown}) => Promise<object>,
 *   lockStop: (reason?: string) => {ok: boolean, killed: boolean, profileRemoved: boolean},
 *   scanOrphans: () => Promise<{scanned: number, killed: number, failed: number, errors: string[]}>,
 *   probe: (input?: object) => object,
 *   getState: () => string,
 *   dispose: () => void
 * }}
 */
function createRecordSession(overrides) {
  const deps = defaultDeps(overrides);
  const limits = deps.limits;

  /** @type {'idle'|'starting'|'recording'|'stopping'} */
  let state = 'idle';
  /** @type {null|object} */
  let session = null;
  let intervalId = null;
  /**
   * `starting` 窗口（最长 15 s）里收到 `record:stop` 时置位（R3-04）。
   * **旧实现回「会话已结束」但 start 随后照样成功并继续录** —— 那是说谎，比报错更糟。
   * 现在：stop 当场回「启动进行中，请稍候重试」并置此标志，start 在下一个检查点真中止
   * （杀 Chrome + 删 profile + 写审计），不会出现「回了拒绝、后台还在录」。
   */
  let cancelStart = false;
  const recentlyStopped = [];

  const isoNow = () => new Date(deps.clock.now()).toISOString();

  /** 推给渲染层（单批 ≤ pollBatch，由调用方保证） */
  function emit(events) {
    if (!events || !events.length) return;
    try { deps.onEvents(events); } catch { /* 推送失败不影响会话 */ }
  }

  /** 造一条「会话结束」事件（6 键 + 无 valueMeta） */
  function sessionEndedEvent(s) {
    s.seq += 1;
    return {
      sessionId: s.id,
      seq: s.seq,
      action: 'session-ended',
      target: { tag: 'session' },
      candidates: [],
      ms: Math.max(0, deps.clock.now() - s.startedMs),
    };
  }

  /**
   * 审计条目：**13 个必填字段固定结构**，只记 host（`[C-119]` 第 7 款；v20 补的 `truncated` 就在里面）。
   *
   * 契约 v23（t37）新增**一个可选字段** `profileRemovedError`：只在 `profileRemoved:false` 时出现，
   * 形状写死 `{ code, item }`，`item` 只放 `Default/Cookies` 这类**相对子项**、绝不含绝对路径。
   *
   * 为什么现在要写进审计（旧实现只走 `app.log` + `stop` 出参）：SEC-07 的原始诉求是「清理失败无痕」，
   * 而 `app.log` 会被截断、也不能经 `audit:list` 查询 —— 那等于没闭环。
   *
   * ⚠️ 历史注释说「不往这里塞原因，多一个键就算改契约」：**契约已改**（v23），这句话已作废。
   */
  function auditEntry(fields) {
    const entry = {
      action: AUDIT_ACTION,
      sessionId: fields.sessionId,
      host: fields.host || '',
      startedAt: fields.startedAt || '',
      stoppedAt: fields.stoppedAt || isoNow(),
      eventCount: fields.eventCount || 0,
      received: fields.received || 0,
      pushed: fields.pushed || 0,
      dropped: fields.dropped || 0,
      truncated: fields.truncated === true,
      killed: fields.killed === true,
      profileRemoved: fields.profileRemoved === true,
      ok: fields.ok === true,
    };
    // 契约 v23：删 profile 失败时补一个**可选**原因字段（仅 profileRemoved:false 时出现）
    const reason = fields.profileRemovedError;
    if (entry.profileRemoved === false && reason && typeof reason === 'object') {
      entry.profileRemovedError = {
        code: sanitizeAuditCode(reason.code),
        item: sanitizeAuditItem(reason.item),
      };
    }
    try { deps.appendAudit(entry); } catch { /* 审计失败不影响主流程，与 appendAudit 自身同口径 */ }
    return entry;
  }

  /** 打点开关（`PM_RECORD_TIMING=1`）：只写日志，不进返回值、不进审计 */
  const timingOn = () => /^(1|true|on)$/i.test(String((deps.env && deps.env[TIMING_ENV]) || ''));
  const timingT0 = () => (timingOn() ? deps.clock.now() : 0);
  /** @param {string} label @param {number} t0 @param {number} [since] */
  function timingMark(label, t0, since) {
    if (!timingOn() || !t0) return;
    const now = deps.clock.now();
    const line = `[record-timing] ${label} +${now - t0}ms${since ? ` (段内 ${now - since}ms)` : ''}`;
    try {
      if (typeof deps.log === 'function') deps.log(line);
      else console.log(line);
    } catch { /* 日志失败不影响停录 */ }
  }

  /**
   * 轮询等条件成立（有界）。**这是 D-2 的修法本体**：`taskkill` 是异步的，
   * 派发完必须等进程真的消失，再去删它占着的目录。
   */
  async function waitUntil(predicate, budgetMs, stepMs) {
    const budget = Math.max(0, Number(budgetMs) || 0);
    const step = Math.max(1, Number(stepMs) || EXIT_POLL_MS);
    let waited = 0;
    for (;;) {
      let done = false;
      try { done = predicate() === true; } catch { done = false; }
      if (done) return true;
      if (waited >= budget) return false;
      await deps.clock.sleep(Math.min(step, budget - waited));
      waited += step;
    }
  }

  /** 我们自己 spawn 的子进程：杀掉整棵树（taskkill /T + child.kill 兜底，两者都幂等） */
  function killOwnChild(child) {
    if (!child) return false;
    let ok = false;
    if (child.pid) {
      try {
        deps.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        ok = true;
      } catch {
        ok = false;
      }
    }
    try { if (typeof child.kill === 'function' && !child.killed) child.kill(); } catch { /* 已退出 */ }
    return ok;
  }

  /**
   * 把 Node 的删除异常翻成**可入日志/出参的占用原因**（不含绝对路径，只给相对子项）。
   *
   * `rmSync(recursive)` 在 Windows 上撞到被占用的文件会抛 `EPERM` / `EBUSY`，`e.path` 就是那个子项。
   * 只在失败时产出；成功时上层拿到的是 `{ removed: true }`。
   * Node 的 `message` 里也带绝对路径（`unlink 'C:\...'`），这里把 profile 目录段换成 `<profile>` 再出。
   */
  function describeRemoveFailure(err, profileDir) {
    const code = String((err && (err.code || err.errno)) || 'UNKNOWN');
    const raw = String((err && (err.path || err.dest)) || '');
    const dirPosix = String(profileDir).replace(/\\/g, '/').replace(/\/+$/, '');
    const full = raw.replace(/\\/g, '/');
    let item = '';
    if (dirPosix && full.startsWith(dirPosix + '/')) item = full.slice(dirPosix.length + 1);
    else if (dirPosix && full === dirPosix) item = '';
    const syscall = String((err && err.syscall) || 'rm');
    const message = messageOf(err).split(dirPosix).join('<profile>');
    return { code, item, syscall, message };
  }

  /** 让 `describeRemoveFailure` 的结果变成一行可读文本（日志用；不含绝对路径） */
  function describeRemoveFailureText(reason) {
    if (!reason) return '';
    const where = reason.item ? `${reason.item}` : '（未给具体子项）';
    return `${reason.code}@${where}`;
  }

  /** profile 目录的**标签**（只有末端 sessionId，不打绝对路径） */
  function profileLabel(profileDir) {
    return String(profileDir || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
  }

  /**
   * 删临时 profile：**先等进程退（调用方负责），再删；删不掉有界重试；仍失败带原因返回**。
   * @param {string} profileDir
   * @param {{retryDelays?: number[]}} [opts]
   * @returns {Promise<{removed: boolean, reason?: object}>}
   */
  async function removeProfile(profileDir, opts = {}) {
    if (!profileDir) return { removed: false, reason: { code: 'NO_DIR', item: '', syscall: 'rm', message: 'profileDir 为空' } };
    const delays = Array.isArray(opts.retryDelays) && opts.retryDelays.length ? opts.retryDelays : limits.profileRetryDelays;
    let last = null;
    for (let i = 0; i < delays.length; i += 1) {
      if (i > 0) await deps.clock.sleep(delays[i]);
      try {
        deps.fs.rmSync(profileDir, { recursive: true, force: true });
        return { removed: true };
      } catch (e) {
        last = e;
      }
    }
    const reason = describeRemoveFailure(last, profileDir);
    try {
      const line = `[record-session] 临时 profile 删不掉（${profileLabel(profileDir)}）：${describeRemoveFailureText(reason)}`;
      if (typeof deps.log === 'function') deps.log(line);
      else console.log(line);
    } catch { /* 日志失败不影响停录 */ }
    return { removed: false, reason };
  }

  /**
   * 同步删 profile：**与异步路径同等的有界重试**（D-2）。
   *
   * 旧实现只删一次：Windows 上刚 `taskkill` 完，`Default/Account Web Data` / `Cache/...journal`
   * 还被句柄占着，一次 `rmSync` 必抛 `EBUSY` —— 真机日志原文：
   * `临时 profile 删不掉（同步路径 30583c26...）：EBUSY@Default/Account Web Data`。
   * 现在按 `profileRetryDelays` 用 `clock.sleepSync` 做**同样的有界重试**，
   * 失败原因与异步路径**同源**（`describeRemoveFailure` 的 `{code, item}`），并进审计。
   *
   * @returns {{removed: boolean, attempts?: number, reason?: {code: string, item: string, syscall: string, message: string}}}
   */
  function removeProfileSync(profileDir, opts = {}) {
    if (!profileDir) return { removed: false, reason: { code: 'NO_DIR', item: '', syscall: 'rm', message: 'profileDir 为空' } };
    const delays = Array.isArray(opts.retryDelays) && opts.retryDelays.length ? opts.retryDelays : limits.profileRetryDelays;
    let last = null;
    for (let i = 0; i < delays.length; i += 1) {
      if (i > 0) deps.clock.sleepSync?.(delays[i]);
      try {
        deps.fs.rmSync(profileDir, { recursive: true, force: true });
        return { removed: true, attempts: i + 1 };
      } catch (e) {
        last = e;
      }
    }
    const reason = describeRemoveFailure(last, profileDir);
    try {
      const line = `[record-session] 临时 profile 删不掉（同步路径 ${profileLabel(profileDir)}，已试 ${delays.length} 次）：${describeRemoveFailureText(reason)}`;
      if (typeof deps.log === 'function') deps.log(line);
      else console.log(line);
    } catch { /* 同上 */ }
    return { removed: false, reason };
  }

  /** 进程行是否就是「本会话的那个浏览器」：命令行含本会话 profile 路径 + 创建时间不早于会话启动 */
  function matchesSession(row, s) {
    if (!row || !row.commandLine) return false;
    if (!norm(row.commandLine).includes(norm(s.profileDir))) return false;
    if (typeof row.creationDate === 'number' && Number.isFinite(row.creationDate)) {
      return row.creationDate >= s.startedMs - CLOCK_SKEW_MS;
    }
    return false;
  }

  /** 派发 `taskkill /T /F` 杀掉**我们自己 spawn 的那个 pid**（同步、不查进程表） */
  function dispatchKill(child) {
    if (!child || !child.pid) return false;
    let ok = false;
    try {
      deps.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      ok = true;
    } catch {
      ok = false;
    }
    try { if (typeof child.kill === 'function' && !child.killed) child.kill(); } catch { /* 已退出 */ }
    return ok;
  }

  /**
   * 杀掉本会话的浏览器并**等它真的消失**。
   *
   * 为什么不再查进程表做「双校验」：这个 pid 是我们自己 `spawn` 出来的，结构上不可能杀错人；
   * 而 `listProcesses()` 要起 PowerShell 拉全量 CIM，实测在 stop 热路径上吃 1–13 s（D-3 长尾根因），
   * 还会因为「表里没这一行」误报 `killed:false`。命令行的双校验保留在 `scanOrphans`（那里的 pid 不是我们的）。
   *
   * @returns {Promise<boolean>} taskkill 派发是否成功（不看进程是否真的退了，那是 `exitConfirmed`）
   */
  async function killSessionBrowser(s) {
    const killed = dispatchKill(s.child);
    const pid = s.child && s.child.pid;
    if (!pid) {
      s.exitConfirmed = false;
      return killed;
    }
    const gone = await waitUntil(() => !deps.isProcessAlive(pid), limits.exitWaitMs, limits.exitPollMs);
    s.exitConfirmed = gone;
    if (!gone) {
      try {
        const line = `[record-session] 进程 ${pid} 在 ${limits.exitWaitMs}ms 内未退出，继续尝试删 profile`;
        if (typeof deps.log === 'function') deps.log(line);
        else console.log(line);
      } catch { /* 忽略 */ }
    }
    return killed;
  }

  /** 收掉会话的全部「活体」：先弃端口（关 CDP）再杀进程（`[C-114a]`：未完成清理也不许继续持有调试端口） */
  function releaseLiveHandles(s) {
    if (intervalId !== null) {
      try { deps.clock.clearInterval(intervalId); } catch { /* 忽略 */ }
      intervalId = null;
    }
    if (s.cdp) {
      try { s.cdp.close(); } catch { /* 连接可能已断 */ }
      s.cdp = null;
    }
  }

  /**
   * 停录收尾的公共动作：置状态、写审计、推 session-ended、清会话引用。
   *
   * @param {object} s 会话
   * @param {string} reason 触发源（stop / lock-stop / pipeline-error / dispose …）
   * @param {{killed: boolean, profileRemoved: boolean, profileRemovedError?: object}} cleaned 清理结果
   * @param {string} stoppedAt ISO 时间
   * @param {{ok?: boolean}} [override] 需要覆盖审计 `ok` 时用（管线异常收敛：清理成功也算「这次录制失败」）
   */
  function finishSession(s, reason, cleaned, stoppedAt, override) {
    state = 'stopping';
    auditEntry({
      sessionId: s.id,
      host: s.host,
      startedAt: s.startedAt,
      stoppedAt,
      eventCount: s.pushed,
      received: s.received,
      pushed: s.pushed,
      dropped: s.dropped,
      truncated: s.truncated,
      killed: cleaned.killed,
      profileRemoved: cleaned.profileRemoved,
      profileRemovedError: cleaned.profileRemovedError,
      ok: override && typeof override.ok === 'boolean'
        ? override.ok
        : (cleaned.killed || !s.child) && cleaned.profileRemoved,
    });
    emit([sessionEndedEvent(s)]);
    const data = {
      ok: true,
      received: s.received,
      pushed: s.pushed,
      dropped: s.dropped,
      truncated: s.truncated,
      cleaned: { killed: cleaned.killed, profileRemoved: cleaned.profileRemoved },
    };
    if (cleaned.profileRemovedError) data.cleaned.profileRemovedError = cleaned.profileRemovedError;
    session = null;
    state = 'idle';
    recentlyStopped.push(s.id);
    while (recentlyStopped.length > RECENT_STOP_LIMIT) recentlyStopped.shift();
    if (reason) s.reason = reason;
    return data;
  }

  /**
   * 停录核心（异步，`record:stop` 用）：弃端口 → 派发 taskkill → **等进程真退** → 删 profile（有界重试）。
   * 顺序是 D-2 的修复本体；分段耗时在 `PM_RECORD_TIMING=1` 时打点（D-3 取证用）。
   */
  async function stopCore(s, reason) {
    const t0 = timingT0();
    // RA3-02：**先排空页内队列，再弃端口**（顺序反了就丢掉最后一批事件）
    await drainPageQueue(s);
    timingMark('stop:drained', t0);
    releaseLiveHandles(s);
    timingMark('stop:live-released', t0);
    const killed = await killSessionBrowser(s);
    timingMark('stop:kill-dispatched+exit-confirmed', t0);
    const removal = await removeProfile(s.profileDir);
    timingMark('stop:profile-removed', t0);
    const data = finishSession(s, reason, {
      killed,
      profileRemoved: removal.removed,
      profileRemovedError: removal.removed ? undefined : removal.reason,
    }, isoNow());
    timingMark('stop:audit+emitted+return', t0);
    return data;
  }

  /**
   * 停录核心（同步，锁定 / 关窗 / 应用退出用）：契约 `[C-114a]` 要求「同步停录、不得继续持有端口」。
   * 同步路径只做**有界**等待（`syncExitWaitMs`），删不掉就把原因写日志，并**挂一个异步收尾**再试一次
   * —— 应用退出的竞态里删不掉的目录，下一次启动的 `scanOrphans` 一定会清掉。
   */
  function stopCoreSync(s, reason, override) {
    const t0 = timingT0();
    releaseLiveHandles(s);
    const killed = dispatchKill(s.child);
    const pid = s.child && s.child.pid;
    if (pid) {
      const deadline = Math.max(0, Number(limits.syncExitWaitMs) || 0);
      const step = Math.max(1, Number(limits.exitPollMs) || EXIT_POLL_MS);
      let waited = 0;
      while (waited < deadline && deps.isProcessAlive(pid)) {
        deps.clock.sleepSync?.(step);
        waited += step;
      }
      s.exitConfirmed = !deps.isProcessAlive(pid);
    }
    let removal = removeProfileSync(s.profileDir);
    if (!removal.removed) {
      // 兜底：等进程退后再试（不阻塞调用方；日志留痕，audit 已按同步结果记过）
      void (async () => {
        const gone = await waitUntil(() => !deps.isProcessAlive(pid), limits.exitWaitMs, limits.exitPollMs);
        if (!gone) return;
        const retry = await removeProfile(s.profileDir);
        try {
          const line = `[record-session] 同步路径删不掉，异步收尾${retry.removed ? '已删除' : '仍失败'}（${s.id}）`;
          if (typeof deps.log === 'function') deps.log(line);
          else console.log(line);
        } catch { /* 忽略 */ }
        if (retry.removed) removal = retry;
      })();
    }
    timingMark('lockstop:sync-cleanup', t0);
    return finishSession(s, reason, {
      killed,
      profileRemoved: removal.removed,
      // D-2：同步路径的失败原因与异步路径**同源**（同一个 describeRemoveFailure 的 {code,item}），
      // 一并进审计（契约 v23 的可选字段），不再只落在会被截断的 app.log 里。
      profileRemovedError: removal.removed ? undefined : removal.reason,
    }, isoNow(), override);
  }

  /**
   * 事件管线异常时的收敛回调（R3-07）：**一律按停录收尾**（杀进程 + 删目录 + 写审计 + 回 idle）。
   *
   * 绝不能让它停留在「recording 但没有轮询」——那种状态下 `record:start` 永远回「已有会话在录制」，
   * 用户只能重启应用。最坏情况（连 stopCoreSync 都抛）也要把 `session`/`state`/定时器清干净。
   */
  function onPipelineError(err) {
    const s = session;
    try {
      const line = `[record-session] 事件管线异常，按停录收敛：${messageOf(err)}`;
      if (typeof deps.log === 'function') deps.log(line);
      else console.log(line);
    } catch { /* 日志失败不影响收敛 */ }
    if (!s) {
      if (intervalId !== null) {
        try { deps.clock.clearInterval(intervalId); } catch { /* 忽略 */ }
        intervalId = null;
      }
      return;
    }
    try {
      // 复用内部收尾路径，但审计的 ok 必须是 false：这次录制是**异常终止**的，
      // 只把「清理干净了」写成 ok:true 会让人以为录制正常结束。
      stopCoreSync(s, 'pipeline-error', { ok: false });
    } catch {
      try { if (intervalId !== null) deps.clock.clearInterval(intervalId); } catch { /* 忽略 */ }
      intervalId = null;
      session = null;
      state = 'idle';
    }
  }

  /** 等 `DevToolsActivePort` 出现（`--remote-debugging-port=0` 的配套读法，`[C-117]` 第 1 条） */
  async function waitForPort(child, profileDir) {
    const startedMs = deps.clock.now();
    const file = joinPath(profileDir, 'DevToolsActivePort');
    while (deps.clock.now() - startedMs < limits.startTimeoutMs) {
      if (child && child.exitCode !== null && child.exitCode !== undefined) {
        return { ok: false, detail: `浏览器启动即退出（退出码 ${child.exitCode}）` };
      }
      try {
        const parsed = parseDevToolsActivePort(deps.fs.readFileSync(file, 'utf8'));
        if (parsed.ok) return parsed;
      } catch { /* 还没生成，继续等 */ }
      await deps.clock.sleep(PORT_POLL_MS);
    }
    return { ok: false, detail: `等 DevToolsActivePort 超时（${limits.startTimeoutMs}ms）` };
  }

  /** 排障日志（有 deps.log 就用它，落 app.log） */
  function warn(line) {
    try {
      if (typeof deps.log === 'function') deps.log(line);
      else console.log(line);
    } catch { /* 日志失败不影响主流程 */ }
  }

  /**
   * 把页内返回值变成「可处理的事件数组」（SEC-R3-02：**主进程必须假设页面会作恶**）。
   *
   * - 哨兵串 → `tampered: true`（通道被换掉，走 `onTakeTampered` 收敛，不是静默空转）
   * - 非数组 → 空批
   * - 超过单批上限的部分**直接丢弃并计入 dropped**（否则页面让 `__dshQueueTake` 返回 10 万条就能拖死主进程）
   * - 元素不是普通对象 → 计数丢弃（形状校验第一道；语义校验在 `normalizeEvent`）
   *
   * @param {unknown} raw 页内表达式返回值
   * @param {number} limit 单批上限（`limits.pollBatch`）
   */
  function takeBatch(raw, limit) {
    if (raw === TAKE_TAMPERED) return { tampered: true, missing: false, list: [], over: 0, bad: 0, rawLength: 0 };
    if (raw === TAKE_MISSING) return { tampered: false, missing: true, list: [], over: 0, bad: 0, rawLength: 0 };
    if (!Array.isArray(raw)) return { tampered: false, missing: false, list: [], over: 0, bad: 0, rawLength: 0 };
    const max = Math.max(1, Number(limit) || POLL_BATCH);
    const over = Math.max(0, raw.length - max);
    const head = over > 0 ? raw.slice(0, max) : raw;
    const list = [];
    let bad = 0;
    for (const item of head) {
      // 正常形态是页内 binding 推上来的 **JSON 串**；伪造载荷也可能是对象（单测就是这么造的）。
      // 单个超大串同样算 DoS 面：超过上限直接丢（`normalizeEvent` 里有逐字段截断，这里先挡体积）。
      if (typeof item === 'string') {
        if (item.length > MAX_EVENT_JSON_LENGTH) {
          bad += 1;
          continue;
        }
        list.push(item);
        continue;
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        list.push(item);
        continue;
      }
      bad += 1;
    }
    return { tampered: false, missing: false, list, over, bad, rawLength: raw.length };
  }

  /**
   * 一批事件的入账（received / dropped / pushed / seq / emit）。`poll` 与「停止前排空」共用，
   * 保证两条路径的计数口径完全一致（否则审计里的 eventCount 会两套算法）。
   * @returns {number} 真正推给渲染层的条数
   */
  function ingestBatch(s, items) {
    const accepted = [];
    for (const raw of items) {
      s.received += 1;
      const event = normalizeEvent(raw);
      if (!event) {
        s.dropped += 1;
        continue;
      }
      if (s.pushed >= limits.maxEvents) {
        s.dropped += 1;
        s.truncated = true;
        continue;
      }
      s.pushed += 1;
      s.seq += 1;
      accepted.push(Object.assign({ sessionId: s.id, seq: s.seq }, event));
    }
    if (accepted.length) emit(accepted);
    return accepted.length;
  }

  /**
   * 页内注入物不见了（导航换了文档）时**重新注入**（D-4 的正面修法之一）。
   *
   * 为什么不能直接停：录制期间被测系统跳一次页（登录 → 首页）是**常态**，
   * 停掉等于「每次登录都断录」。所以：不见了 → 重注入；连续重注入 `MAX_REINSTALL` 次仍不见 → 收敛。
   *
   * 注意：旧文档里没取走的事件随旧文档消失，拿不回来（也无法计数）——这一点写日志，不假装没丢。
   */
  async function reinstallPageHooks(s) {
    if (!s || session !== s || state !== 'recording' || s.reinstalling) return;
    if (!s.cdp) return;
    if (s.reinstallCount >= MAX_REINSTALL) {
      warn(`[record-session] 页内注入物反复丢失（已重注入 ${s.reinstallCount} 次），按停录收敛：${s.id}`);
      stopCoreSync(s, 'reinstall-exhausted', { ok: false });
      return;
    }
    s.reinstalling = true;
    s.reinstallCount += 1;
    try {
      await s.cdp.callWithArgs(QUEUE_FN_SRC, [bindingName(s.nonce), s.nonce]);
      await s.cdp.callWithArgs(INSTALL_FN_SRC, [s.nonce]);
      warn(`[record-session] 页面文档已更换，已重新注入录制器（第 ${s.reinstallCount} 次）：${s.id}；`
        + '旧文档里未取走的事件已随旧文档丢失，不计入 received/dropped');
    } catch (e) {
      warn(`[record-session] 重新注入失败（第 ${s.reinstallCount} 次）：${messageOf(e)}`);
    } finally {
      s.reinstalling = false;
    }
  }

  /**
   * 取事件通道被页面换掉（SEC-R3-07）：**显式告警 + 收敛停录**（写审计 + 推 session-ended）。
   * 旧行为是「poll 静默返回空」→ 表现为「录制中点不出事件」，用户会以为是自己点错了。
   */
  function onTakeTampered(s) {
    if (!s || s.takeTampered) return;
    s.takeTampered = true;
    warn('[record-session] 页内取事件通道 __dshQueueTake 已被替换（不是本会话注入的那个函数）：按停录收敛，避免静默丢事件');
    try {
      stopCoreSync(s, 'take-tampered', { ok: false });
    } catch {
      // 最后兜底：至少别把会话卡在 recording
      try { if (intervalId !== null) deps.clock.clearInterval(intervalId); } catch { /* 忽略 */ }
      intervalId = null;
      session = null;
      state = 'idle';
    }
  }

  /**
   * 等目标文档就绪（D-4 根因修法）：`readyState === 'complete'` 且 `location.href` 已经不是
   * `about:blank`（当 URL 有 host 时还要求同源 host 命中）。有界：最多到 `startTimeoutMs`。
   *
   * 为什么要它：`DevToolsActivePort` 在页面还没导航时就出现了，早起注入会落进 `about:blank`，
   * 导航提交后新文档里没有这些全局变量 —— 守卫会说「通道不见了」，录制也收不到事件。
   */
  async function waitForPageReady(cdp, host, startedMs) {
    const wantHost = String(host || '').toLowerCase();
    const deadline = limits.startTimeoutMs;
    let last = { ready: '', href: '' };
    while (deps.clock.now() - startedMs < deadline) {
      try {
        const raw = await cdp.evaluate(PAGE_READY_EXPR);
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw);
          last = { ready: String(parsed.ready || ''), href: String(parsed.href || '') };
        }
      } catch { /* 页面还在切换文档：忽略，继续等 */ }
      const href = last.href;
      const navigated = !!href && href !== 'about:blank';
      const sameHost = !wantHost || href.toLowerCase().includes(wantHost);
      if (last.ready === 'complete' && navigated && sameHost) return { ok: true, href };
      await deps.clock.sleep(PAGE_READY_POLL_MS);
    }
    return { ok: false, detail: `readyState=${last.ready || '?'} href=${last.href || '?'}` };
  }

  /** 16 ms 轮询页内队列（合批 + 截断 + 计数 + 上限） */
  async function poll() {
    const s = session;
    if (!s || state !== 'recording' || s.polling) return;
    s.polling = true;
    try {
      const raw = await s.cdp.evaluate(POLL_EXPR);
      if (session !== s) return; // await 期间会话已被 stop/lockStop 收掉
      const taken = takeBatch(raw, limits.pollBatch);
      if (taken.tampered) {
        onTakeTampered(s);
        return;
      }
      if (taken.missing) {
        // 文档换了（导航 / 站内跳转）：注入物随旧文档一起没了。重新注入，别把它当篡改（D-4）。
        void reinstallPageHooks(s);
        return;
      }
      if (taken.over > 0) {
        // 超过上限的那些**已经从页内队列取走了**（splice），所以既算 received 也算 dropped
        s.received += taken.over;
        s.dropped += taken.over;
        s.truncated = true;
        warn(`[record-session] 页面一次返回 ${taken.rawLength} 条事件，超过单批上限 ${limits.pollBatch}：其余 ${taken.over} 条已丢弃并计入 dropped（SEC-R3-02）`);
      }
      if (taken.bad > 0) {
        s.received += taken.bad;
        s.dropped += taken.bad;
        warn(`[record-session] 页面返回了 ${taken.bad} 条非对象事件，已丢弃并计入 dropped`);
      }
      ingestBatch(s, taken.list);
    } catch {
      // 页面关掉 / CDP 超时：不炸，下一轮继续（会话仍由 stop / lockStop 收尾）
    } finally {
      s.polling = false;
    }
  }

  /**
   * 停止前把页内队列排空（RA3-02）。**有界**：≤200 ms 且 ≤20 轮。
   *
   * 根因：旧实现 stop 起手就 `releaseLiveHandles`（关 CDP + 停轮询），页面闭包队列里没取走的事件
   * **既不计 received 也不计 dropped** —— 用户点完立刻停，最后一步就没了，审计上也看不出丢过
   * （违反 `[C-09]`「禁止静默截断」）。现在先排空，排不掉的**计入 dropped + truncated**。
   *
   * @param {object|null} s 会话（cdp 已关时直接返回）
   * @returns {Promise<number>} 排空期间入账的事件数
   */
  async function drainPageQueue(s) {
    if (!s || !s.cdp) return 0;
    const started = deps.clock.now();
    let drained = 0;
    let exhausted = false;
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
      if (deps.clock.now() - started >= DRAIN_BUDGET_MS) break;
      let raw = null;
      try {
        raw = await s.cdp.evaluate(POLL_EXPR);
      } catch {
        return drained; // 页已关 / CDP 超时：排不动了，交给后面的「剩余计数」逻辑
      }
      const taken = takeBatch(raw, limits.pollBatch);
      if (taken.tampered) {
        onTakeTampered(s);
        return drained;
      }
      if (taken.missing) return drained; // 文档已换：旧闭包队列随旧文档消失，排也没有
      const total = taken.list.length + taken.over + taken.bad;
      if (total === 0) {
        exhausted = true;
        break;
      }
      drained += ingestBatch(s, taken.list);
      if (taken.over + taken.bad > 0) {
        s.received += taken.over + taken.bad;
        s.dropped += taken.over + taken.bad;
        s.truncated = true;
      }
    }
    if (exhausted) return drained;
    // 预算/轮数用完但可能还有剩：再取一次，把取到的算 dropped + truncated（不静默丢）
    try {
      const taken = takeBatch(await s.cdp.evaluate(POLL_EXPR), limits.pollBatch);
      const left = taken.list.length + taken.over + taken.bad;
      if (left > 0) {
        s.received += left;
        s.dropped += left;
        s.truncated = true;
        warn(`[record-session] 停止时页内队列仍有 ${left} 条事件未取走（drain 预算 ${DRAIN_BUDGET_MS}ms 用完）：已计入 dropped 并置 truncated（RA3-02）`);
      }
    } catch { /* 页已关：剩下的就是丢了，但至少 drained 的已经入账 */ }
    return drained;
  }

  /**
   * 校验 `record:validate` 的入参。**真源在 `record-args.js` 的 `validateSelectorItems`**（RA2-06：
   * 原来这里自己写了一套，与本文件「校验真源只有一处」的约定冲突）。页内注入器是纵深防御。
   */
  function checkValidateItems(items) {
    return validateSelectorItems(items);
  }

  /** 启动：校验 → 找浏览器 → 建 profile → spawn → 等端口 → 连 CDP 装注入器 */
  async function start(input) {
    const urls = resolveUrls(input && input.url);
    if (!urls.ok) return { ok: false, error: 'URL 不合法', detail: urls.detail };

    // 单会话单例 + in-flight 互斥：`starting` 已在同步段置位，这里能挡住并发第二次
    if (state === 'starting') return { ok: false, error: '启动进行中，请稍候重试' };
    if (state === 'recording' && session) return { ok: false, error: '已有会话在录制', data: { sessionId: session.id } };
    if (state === 'stopping') return { ok: false, error: '已有会话在录制' };

    const browser = findBrowser(deps);
    if (!browser) return { ok: false, error: '未检测到 Chromium 系浏览器' };

    const sessionId = deps.randomBytes(12).toString('hex');
    // SEC-R2-03 收口：**拿不到数据目录就拒绝启动**，不许静默降级成「只做前三道检查」——
    // profile 里是被测系统的 Cookie / localStorage，落到同步盘/共享盘等于外泄。
    const dataDir = String((typeof deps.getDataDir === 'function' ? deps.getDataDir() : '') || '');
    if (!dataDir) return { ok: false, error: '数据目录未就绪，无法启动录制', detail: 'getDataDir() 为空' };
    const profileDir = joinPath(dataDir, PROFILE_ROOT_NAME, sessionId);
    // R3-06 / M2：导航参数用 `resolveUrls()` 算出来的 **urlForLaunch**（保留业务 query/fragment）。
    // 旧实现传 `input.url` 让 buildChromeArgs 内部**再解析一次** → `urls.urlForLaunch` 成了死字段，
    // 在 resolveUrls 那层改坏（launch 换成 storage）测试也不会红。现在只解析一次，那条
    // 「末位参数保留 ?projectCode=ABC&from=uitest」的用例才真的守住这一层。
    const argsResult = buildChromeArgs({ url: urls.urlForLaunch, userDataDir: profileDir, dataDir });
    if (!argsResult.ok) return { ok: false, error: argsResult.error, detail: argsResult.detail };
    // 纵深防御：buildChromeArgs 明确告诉我们「没检查到底」就不许启动
    if (argsResult.containment !== 'checked') {
      return { ok: false, error: '数据目录未就绪，无法启动录制', detail: `containment=${argsResult.containment}` };
    }
    const args = argsResult.args;

    state = 'starting';
    cancelStart = false;
    const startedMs = deps.clock.now();
    const startedAt = new Date(startedMs).toISOString();
    let child = null;
    /**
     * 启动中途被 `record:stop` 取消（R3-04）：把已经做出去的副作用收干净（杀进程 + 删目录 + 审计），
     * 绝不能让「stop 已经回了拒绝」的那次 start 后来还成功进 recording。
     */
    const abortIfCancelled = async (detail) => {
      if (!cancelStart) return null;
      cancelStart = false;
      const killed = killOwnChild(child);
      const removal = await removeProfile(profileDir);
      state = 'idle';
      auditStartFailure({ killed: killed === true, profileRemoved: removal.removed, profileRemovedError: removal.removed ? undefined : removal.reason });
      return { ok: false, error: '启动失败', detail };
    };
    /**
     * 启动失败也要留痕（R3-02）：stop / lockStop / scanOrphans 都写审计，唯独 start 的失败分支不写，
     * 结果是「起了 chrome、又杀掉、又删了目录」全程无痕。这里统一出一条 13 字段审计（`ok:false`）。
     */
    const auditStartFailure = (extra) => auditEntry({
      sessionId,
      host: urls.host,
      startedAt,
      stoppedAt: isoNow(),
      eventCount: 0,
      received: 0,
      pushed: 0,
      dropped: 0,
      truncated: false,
      killed: (extra && extra.killed) === true,
      profileRemoved: (extra && extra.profileRemoved) === true,
      profileRemovedError: extra && extra.profileRemovedError,
      ok: false,
    });
    try {
      deps.fs.mkdirSync(profileDir, { recursive: true });
      child = deps.spawn(browser, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      const detail = messageOf(e);
      // spawn 就失败：进程没起、目录可能刚建出来，照样删一次 + 留审计（R3-02）
      const removal = await removeProfile(profileDir);
      state = 'idle';
      auditStartFailure({ killed: false, profileRemoved: removal.removed, profileRemovedError: removal.removed ? undefined : removal.reason });
      return { ok: false, error: '启动失败', detail };
    }

    const portInfo = await waitForPort(child, profileDir);
    if (!portInfo.ok) {
      const killed = killOwnChild(child);
      const removal = await removeProfile(profileDir);
      state = 'idle';
      auditStartFailure({ killed: killed === true, profileRemoved: removal.removed, profileRemovedError: removal.removed ? undefined : removal.reason });
      return { ok: false, error: '启动失败', detail: portInfo.detail };
    }

    // 检查点 ①：等端口的这段时间里用户可能已经点了「停止」
    const abortedAfterPort = await abortIfCancelled('启动过程中收到停止请求（等端口阶段已中止）');
    if (abortedAfterPort) return abortedAfterPort;

    const nonce = nonceOf(sessionId);
    let cdp = null;
    try {
      // 目标发现是 cdp-client 的唯一职责（port → GET /json/list → page target 的 ws）；
      // 这里**只给 port**，**绝不在会话层自己 /json/list、不拼 ws://、不碰 browser 端点**（契约 v21）。
      cdp = await deps.connectCdp({ port: portInfo.port, timeout: limits.startTimeoutMs });
      // D-4 的另一半（根因）：**等目标文档就绪再注入**。
      // 实测（t43 真机取证）：CDP 一连上就注入时，页面还在 `about:blank`，
      // 注入物落在旧文档里；导航一提交，新文档里什么都没有 → 守卫（和录制）全部失效。
      const readyInfo = await waitForPageReady(cdp, urls.host, startedMs);
      timingMark('start:page-ready', timingT0());
      if (!readyInfo.ok) {
        warn(`[record-session] 等页面就绪超时（${readyInfo.detail}），按当前文档继续注入；若随后导航，会走重新注入路径`);
      }
      // ① 先装页内闭包队列（参数 = binding 名，结构化传入）② 再装 S2 的注入器（参数 = nonce）
      // 第二个参数是通道标记（SEC-R3-07）：页内函数带 __dshTake = nonce，poll 用它识别「被替换」
      await cdp.callWithArgs(QUEUE_FN_SRC, [bindingName(nonce), nonce]);
      await cdp.callWithArgs(INSTALL_FN_SRC, [nonce]);
    } catch (e) {
      const detail = messageOf(e);
      try { if (cdp) cdp.close(); } catch { /* 忽略 */ }
      const killed = killOwnChild(child);
      const removal = await removeProfile(profileDir);
      state = 'idle';
      auditStartFailure({ killed: killed === true, profileRemoved: removal.removed, profileRemovedError: removal.removed ? undefined : removal.reason });
      return { ok: false, error: '启动失败', detail };
    }

    // 检查点 ②：连 CDP / 装注入器期间也可能被取消 —— 这里再查一次才允许进 recording
    const abortedBeforeRecording = await abortIfCancelled('启动过程中收到停止请求（连接阶段已中止）');
    if (abortedBeforeRecording) {
      try { if (cdp) cdp.close(); } catch { /* 忽略 */ }
      return abortedBeforeRecording;
    }

    session = {
      id: sessionId,
      startedMs,
      startedAt: new Date(startedMs).toISOString(),
      host: urls.host,
      baseUrl: urls.urlForStorage,
      profileDir,
      child,
      cdp,
      nonce,
      seq: 0,
      received: 0,
      pushed: 0,
      dropped: 0,
      truncated: false,
      polling: false,
      // D-4：导航换文档后重注入的次数与并发闸（不许两轮重注入叠在一起）
      reinstallCount: 0,
      reinstalling: false,
    };
    state = 'recording';
    /**
     * R3-07：`setInterval` **这次调用本身**抛错时，`session` 已建、`state='recording'`，但没有轮询——
     * ipc 层还会回「启动失败」，于是会话永久泄漏：之后每次 start 都回「已有会话在录制」，只能重启应用。
     * 所以调度失败必须当场收敛（杀进程 + 删目录 + 写审计 + 回 idle）。
     */
    try {
      intervalId = deps.clock.setInterval(() => { guardTick(poll, onPipelineError); }, limits.flushMs);
    } catch (e) {
      const detail = messageOf(e);
      intervalId = null;
      try { if (cdp) cdp.close(); } catch { /* 忽略 */ }
      stopCoreSync(session, 'pipeline-error', { ok: false });
      return { ok: false, error: '启动失败', detail: `事件管线启动失败：${detail}` };
    }
    // RA3-07：出参**只回浏览器名**（Chrome / Edge / Brave …），本机绝对路径只进 app.log ——
    // 渲染层不需要也拿不到用户目录结构。
    // RA3-07：出参**只回浏览器名**（Chrome / Edge / Brave …），本机绝对路径只进 app.log ——
    // 渲染层不需要也拿不到用户目录结构。
    warn(`[record-session] 录制浏览器：${browser}`);
    return { ok: true, data: { sessionId, browser: browserLabel(browser), port: portInfo.port } };
  }

  /**
   * 停录（幂等）：同 id 重复调用回零计数；未知 id 回「会话已结束」。
   *
   * `starting` 窗口（最长 15 s）例外：**不再回「会话已结束」**（R3-04：session 还是 null，
   * 但 start 随后会成功并继续录制 —— 那是说谎）。现在回「启动进行中，请稍候重试」并置
   * `cancelStart`，让这一轮 start 在下一个检查点真中止；用户看到的是「没停成，稍后再点」，
   * 而不是「显示已停止、实际还在录」。
   */
  async function stop(input) {
    const sessionId = String((input && input.sessionId) || '');
    if (state === 'starting') {
      cancelStart = true;
      return { ok: false, error: '启动进行中，请稍候重试' };
    }
    if (!session || session.id !== sessionId) {
      if (sessionId && recentlyStopped.includes(sessionId)) {
        return { ok: true, data: { ok: true, received: 0, pushed: 0, dropped: 0, truncated: false, cleaned: { killed: false, profileRemoved: false } } };
      }
      return { ok: false, error: '会话已结束' };
    }
    const data = await stopCore(session, 'stop');
    return { ok: true, data };
  }

  /** 只读状态：无活会话 → null；`state` 只出 `'recording'`（`stopping` 不外露） */
  function status() {
    if (state !== 'recording' || !session) return null;
    return {
      sessionId: session.id,
      state: 'recording',
      startedAt: session.startedAt,
      // url 只回脱敏后的 origin + path（不带 userinfo/query/fragment，v19）
      url: session.baseUrl,
    };
  }

  /** 元素级校验：selector 只经结构化参数传给页内常量函数（SEC-02） */
  async function validate(input) {
    const s = session;
    const sessionId = String((input && input.sessionId) || '');
    if (!s || state !== 'recording' || s.id !== sessionId) return { ok: false, error: '会话已结束' };
    const checked = checkValidateItems(input && input.items);
    if (!checked.ok) return { ok: false, error: checked.error };

    const startedMs = deps.clock.now();
    const results = [];
    for (const item of checked.items) {
      const itemStart = deps.clock.now();
      const base = { strategy: item.strategy, selector: item.selector };
      if (itemStart - startedMs >= limits.validateTotalMs) {
        results.push(Object.assign({}, base, { count: 0, precise: false, ms: 0, invalid: true, error: '超时' }));
        continue;
      }
      try {
        const res = await s.cdp.callWithArgs(VALIDATE_FN_SRC, [item.strategy, item.selector], { timeout: limits.validateItemMs });
        const row = Object.assign({}, base, {
          count: typeof res?.count === 'number' && Number.isFinite(res.count) ? res.count : 0,
          precise: res?.precise === true,
          ms: deps.clock.now() - itemStart,
        });
        if (res && res.invalid === true) {
          row.invalid = true;
          row.error = typeof res.error === 'string' && res.error ? res.error : '选择器语法错误';
        }
        results.push(row);
      } catch (e) {
        const reason = messageOf(e);
        results.push(Object.assign({}, base, {
          count: 0,
          precise: false,
          ms: deps.clock.now() - itemStart,
          invalid: true,
          error: /超时/.test(reason) ? '超时' : '执行失败',
        }));
      }
    }
    return { ok: true, data: { results } };
  }

  /**
   * 锁定 / 自动锁 / 关窗 / 防截屏 = 同步停录（`[C-114a]`）。**内部动作名，不是 preload 通道。**
   * 无活会话时是空操作（不写审计，避免锁定每次都留一条空记录）。
   *
   * 同步路径：弃端口 → 派发 taskkill → **有界同步等待**（`syncExitWaitMs`）→ 删 profile 一次；
   * 删不掉会写原因到日志并挂一个异步收尾（不阻塞关窗/退出），留下的目录由下次启动的 `scanOrphans` 清掉。
   */
  function lockStop(reason) {
    if (!session) return { ok: true, killed: false, profileRemoved: false };
    const data = stopCoreSync(session, reason || 'lock-stop');
    return { ok: true, killed: data.cleaned.killed, profileRemoved: data.cleaned.profileRemoved };
  }

  /** 从一条命令行里抠出「本应用临时 profile 根下的直接子目录名」（sessionId 形状才认） */
  function profileDirFromCommandLine(commandLine, root) {
    const text = String(commandLine || '');
    const m = /--user-data-dir=("([^"]+)"|'([^']+)'|([^\s"']+))/i.exec(text);
    const raw = m ? (m[2] || m[3] || m[4] || '') : '';
    if (!raw) return '';
    const full = norm(raw).replace(/\/+$/, '');
    const base = norm(root).replace(/\/+$/, '');
    if (!full.startsWith(base + '/')) return '';
    const name = raw.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
    return /^[0-9a-f]{24}$/i.test(name) ? joinPath(root, name) : '';
  }

  /** 列出 `record-profiles/` 下的直接子目录（只认 24 位十六进制的 sessionId，绝不误删别的东西） */
  function listProfileDirs(root) {
    const out = [];
    try {
      if (typeof deps.fs.existsSync === 'function' && !deps.fs.existsSync(root)) return out;
      const names = deps.fs.readdirSync(root) || [];
      for (const name of names) {
        if (/^[0-9a-f]{24}$/i.test(String(name))) out.push(joinPath(root, String(name)));
      }
    } catch { /* 目录不存在 / 无权限：当作没有 */ }
    return out;
  }

  /**
   * 启动扫残留（`[C-117]` 第 3 条）：命令行含**本应用临时 profile 根**的进程，先校验再杀，**然后删目录**；
   * 另外把「进程早没了但目录还在」的残留目录一并清掉（这才是「目录只增不减」的另一半）。
   * 读不到进程表（无权限）不重试、不抛，写审计后继续启动。
   */
  async function scanOrphans() {
    // P3 校验：**数据目录为空时一律不扫**。否则 root 会退化成 `record-profiles`（相对名），
    // 命令行前缀匹配与目录清理都会按目录名乱来 —— 极端情况下会误杀用户自己的 chrome。
    const dataDir = String((typeof deps.getDataDir === 'function' ? deps.getDataDir() : '') || '');
    if (!dataDir) {
      auditEntry({ sessionId: 'startup-scan', killed: false, profileRemoved: false, ok: false, host: '' });
      return { scanned: 0, killed: 0, failed: 0, removed: 0, errors: ['数据目录未就绪，已跳过启动清扫'] };
    }
    const root = joinPath(dataDir, PROFILE_ROOT_NAME);
    let rows;
    try {
      rows = deps.listProcesses();
    } catch (e) {
      auditEntry({ sessionId: 'startup-scan', killed: false, profileRemoved: false, ok: false, host: '' });
      return { scanned: 0, killed: 0, failed: 0, removed: 0, errors: [messageOf(e)] };
    }
    const list = Array.isArray(rows) ? rows : [];
    const ours = list.filter((row) => row && row.commandLine && norm(row.commandLine).includes(norm(root) + '/'));
    const errors = [];
    let killed = 0;
    const dirs = [];
    for (const row of ours) {
      const dir = profileDirFromCommandLine(row.commandLine, root);
      if (dir && !dirs.includes(dir)) dirs.push(dir);
      try {
        deps.spawn('taskkill', ['/PID', String(row.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killed += 1;
      } catch (e) {
        // 无权限 / 进程已消失：不重试
        errors.push(`${row.pid}: ${messageOf(e)}`);
      }
    }
    // 等这些进程真的退出，再删它们占着的目录（顺序错了就是 D-2 那个 bug）
    if (ours.length) {
      await waitUntil(() => ours.every((row) => !deps.isProcessAlive(row.pid)), limits.exitWaitMs, limits.exitPollMs);
    }
    // ① 有进程痕迹的目录 ② 进程早没了但目录还在的残留（排除当前会话）
    const current = session && session.profileDir ? norm(session.profileDir) : '';
    const targets = dirs.slice();
    for (const dir of listProfileDirs(root)) {
      if (current && norm(dir) === current) continue;
      if (!targets.includes(dir)) targets.push(dir);
    }
    let removed = 0;
    let firstFailure = null;
    for (const dir of targets) {
      if (current && norm(dir) === current) continue;
      const res = await removeProfile(dir);
      if (res.removed) removed += 1;
      else {
        if (!firstFailure) firstFailure = res.reason;
        errors.push(`${dir.split('/').pop()}: ${describeRemoveFailureText(res.reason)}`);
      }
    }
    auditEntry({
      sessionId: 'startup-scan',
      killed: killed > 0,
      profileRemoved: targets.length > 0 ? removed === targets.length : true,
      // 契约 v23：清扫也有「删不掉」的情形，同样带可选原因（只第一条，避免审计膨胀）
      profileRemovedError: firstFailure,
      ok: killed === ours.length && errors.length === 0,
      host: '',
    });
    return { scanned: list.length, killed, failed: ours.length - killed, removed, errors };
  }

  /**
   * 能力探针（`record:probe` 的数据源；`force` 跳过 60 s 缓存）。
   *
   * P3 校验（`workspaceDir` 入参）：必须是非空字符串以外也接受的**字符串**；长度 ≤1024、
   * 不含 NUL/CR/LF。不合法时**收敛为「未选工程目录」**（那几盏灯回 grey）并写日志 —— 不抛、
   * 也不改 `record:probe` 的出参形状（契约 §9.2 写死是 5 盏灯，不能因为一个坏入参变成错误包）。
   */
  function probe(input) {
    const raw = input && input.workspaceDir;
    let workspaceDir = '';
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'string') {
        warn('[record-session] record:probe 的 workspaceDir 不是字符串，按「未选工程目录」处理');
      } else if (raw.length > MAX_WORKSPACE_DIR_LENGTH) {
        warn(`[record-session] record:probe 的 workspaceDir 超过 ${MAX_WORKSPACE_DIR_LENGTH} 字符，按「未选工程目录」处理`);
      } else if (/[\u0000\r\n]/.test(raw)) {
        warn('[record-session] record:probe 的 workspaceDir 含控制字符，按「未选工程目录」处理');
      } else {
        workspaceDir = raw;
      }
    }
    return deps.probeAbilities({ workspaceDir, force: !!(input && input.force) });
  }

  /** 退出前兜底（main.js 的 before-quit / 窗口 closed 会调）：同步清理，不再等异步 */
  function dispose() {
    if (session) stopCoreSync(session, 'dispose');
    else releaseLiveHandles({ cdp: null });
  }

  return { start, stop, status, validate, lockStop, scanOrphans, probe, getState: () => state, dispose };
}

module.exports = {
  AUDIT_ACTION,
  MAX_EVENTS,
  FLUSH_MS,
  POLL_BATCH,
  POLL_EXPR,
  PROFILE_ROOT_NAME,
  START_TIMEOUT_MS,
  RECENT_STOP_LIMIT,
  EXIT_WAIT_MS,
  PROFILE_RETRY_DELAYS,
  PORT_POLL_MS,
  VALIDATE_ITEM_TIMEOUT_MS,
  VALIDATE_TOTAL_TIMEOUT_MS,
  MAX_VALIDATE_ITEMS,
  MAX_SELECTOR_LENGTH,
  VALIDATE_STRATEGIES,
  PAGE_ACTIONS,
  MAX_CANDIDATES,
  QUEUE_FN_SRC,
  parseProcessList,
  sanitizeValueMeta,
  sanitizeAuditCode,
  sanitizeAuditItem,
  sanitizeCandidates,
  sanitizeTarget,
  normalizeEvent,
  nonceOf,
  findBrowser,
  browserLabel,
  browserCandidates,
  TAKE_TAMPERED,
  TAKE_MISSING,
  MAX_REINSTALL,
  PAGE_READY_EXPR,
  DRAIN_BUDGET_MS,
  MAX_DRAIN_ROUNDS,
  guardTick,
  createRecordSession,
};

