'use strict';

/**
 * hit-args.js —— 元素库 A₂「CDP 点验」纯函数层（契约 [A2-2][A2-3][A2-6][A2-7][A2-8][A2-9][A2-10]）。
 *
 * 设计参考：1148872017/test-tool（main @ v0.65.0，package.json 声明 MIT，作者已授权，2026-11-27 留痕）
 *   借鉴：shared/locatorModes.js 的 normalizeLocatorMode / splitRoleSelector / ariaRoleExpr 规则；
 *         electron/sniffer/highlight.js 的 parseSniffState 收口手法、accName 顺序、implicitRole 手法、
 *         byAttr/byLabel/byText/byRole 的匹配策略、MAX_NODES 护栏；
 *         electron/sniffer/browser-session.js 的 devToolsPortPath / clearDevToolsPort / readDevToolsPort /
 *         buildLaunchArgs / waitForDevTools 双 reason 结构、isOurProfileCommand 的命令行归一。
 * 本项目改造点（**勿照搬上游**）：
 *   1. 端口只走 --remote-debugging-port=0 + DevToolsActivePort 第一行；禁 --remote-debugging-address，
 *      禁「探空闲端口」（[A2-8]：探完到浏览器 bind 之间会被抢，TOCTOU）；
 *   2. 页内脚本是常量 HIT_SCRIPT，定位值只经 callFunctionOn 的 arguments 传值，**绝不拼进脚本文本**（[A2-7]）；
 *   3. visible 按 [A2-3]：getClientRects().length > 0 && visibility !== 'hidden'
 *      （opacity:0 仍算可见 —— 上游 isVisible 判不可见，那是另一套口径，已由单测钉住）；
 *   4. role 只认 8 个隐式角色；placeholder/alttext/title/testid 只做精确匹配
 *      （上游有 fuzzy 回退与 30+ 隐式角色，点验会比 Playwright 宽松）；
 *   5. 不进 iframe / shadow DOM（[N-2]），只回 iframes 计数用于 reason='iframe-only'；
 *   6. reason 是 7 值（ok/not-found/not-visible/iframe-only/login-required/unsupported/timeout），
 *      文案逐字契约，不沿用上游 factsMessage。
 * 逐条未照搬的原因：docs/方案-元素库-A0A1A2-移植清单.md §2.2 / §2.3。
 *
 * 本文件是**纯函数**：只 require('path') 与 ./element-args 的既有文案真源，
 * 不碰 fs / child_process / electron —— vitest 可以直接 require 它（AGENTS.md 纯函数下沉约定）。
 */

const path = require('path');
const {
  ERR,
  pwChainPlan,
  MAX_LOCATOR_LEN: ERR_MAX_LOCATOR_LEN,
  MAX_ROLE_NAME_LEN: ERR_MAX_ROLE_NAME_LEN,
} = require('./element-args');

/** 独立 profile 目录名（[A2-9]：不与 Playwright 试跑的 .pm-profile 复用） */
const HIT_PROFILE_DIR_NAME = 'el-hit-profile';
/** pid 账本文件名（[A2-10]：单 pid + 4 个校验字段） */
const HIT_PID_FILE_NAME = 'pm-hit.pid';
/** 唯一通道名（[A2-1]：1 条通道 + 3 个 op，不拆成三条） */
const HIT_CHANNEL = 'el:hit-test';

/** 三个合法 op（缺省 verify） */
const HIT_OPS = ['verify', 'status', 'stop'];

/**
 * 点验认的定位方式（[A2-7] 全表）。
 *
 * ⚠️ 这是本仓库的**第三份** kind 清单（另两份：`src/utils/codegen/pageobject.ts` 的
 * `POM_LOCATOR_KINDS`（真源）、`electron/element-args.js` 的 `KINDS`）。
 * 为什么不能直接引真源：这个文件要被 vitest 直接 require、也要在主进程跑，
 * 而真源是 TS（未编译），运行时 require 不到 —— 所以只能有一份 CJS 副本。
 * 因此**必须**由测试把「集合 + 顺序」双向锁死：`hitArgs.test.ts` 的
 * 「HIT_KINDS ↔ POM_LOCATOR_KINDS 同源门」会 `toEqual` 真源顺序（删一项/换一项/换顺序都红）。
 *
 * 顺序与 `POM_LOCATOR_KINDS` **逐项一致**（历史缺陷 AR-3：曾经自排成
 * `…/label/placeholder/text/…/role/pw`，与真源不同序，而漂移门只锁长度 → 扩 kind 时
 * `normalizeKind` 会把它静默降级成 css，`supportsHitTest` 还恒为 true，用户看不出来）。
 */
const HIT_KINDS = [
  'css',
  'xpath',
  'text',
  'role',
  'pw',
  'label',
  'placeholder',
  'alttext',
  'title',
  'testid',
];

/** 语义是**近似实现**的 kind（[A2-7]/[A2-3]：必须回 approx:true，界面不许暗示「等价」） */
const APPROX_KINDS = ['text', 'role', 'pw'];

/**
 * 点验的 8 个隐式角色（[A2-7]）。
 *
 * **只有这 8 个**：上游 implicitRole 认 30+ 个 tag/type，本项目只认这一张表，
 * 表外的角色一律 unsupported —— 否则点验比 Playwright 宽松，会出现
 * 「点验说命中、试跑说 0 命中」（[A2-7] 证伪形态）。
 * HIT_SCRIPT 里的 IMPLICIT 数组由本常量序列化生成，单测断言两者同步。
 */
const IMPLICIT_ROLE_NAMES = [
  'link',
  'button',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'heading',
  'img',
];

/** reason 的 7 个取值（[A2-3]，每个值只对应一种事实） */
const HIT_REASONS = [
  'ok',
  'not-found',
  'not-visible',
  'iframe-only',
  'login-required',
  'unsupported',
  'timeout',
];

/** 上限（[A2-1]/[A2-3]） */
/**
 * 定位值 / 角色名的字符上限（**单一真源**：`element-args.js`）。
 *
 * C-09（review-code P2）：这两处上限曾经各写一份（电子侧 100 / 渲染层 `validatePage` 与输入框 40），
 * 结果是「界面能填 40、主进程放到 100」，同一条元素在两处得到不同结论。
 * 现在 electron/ 两个模块共用一个定义；渲染层那两处（`pomModel.validatePage` 的 40、
 * `ElementTable` 的 `maxLength={40}`）由 S3 分片对齐到同一个 40，不在本任务 inScope。
 * 取值 40 的依据：AriaRole 的 role 名 + 可访问名在界面上本来就限 40，写端比读端严是既定的分工
 * （[M-2] 表格最后两行）。
 */
const MAX_LOCATOR_LEN = ERR_MAX_LOCATOR_LEN;
const MAX_ROLE_NAME_LEN = ERR_MAX_ROLE_NAME_LEN;
const MAX_TOTAL = 50;
const MAX_LABEL_LEN = 40;

/** 页内脚本的节点上限（上游同款护栏：真实页面 `*` 遍历会卡死主线程） */
const MAX_NODES = 20000;

/**
 * 三段超时预算（[A2-6]）：调用方只能**压小** total，单段上限写死不让突破。
 * idleStop = 10 分钟无 verify 自动关浏览器（[C-114b] 缩短会话存在时间）。
 */
const HIT_BUDGET = Object.freeze({
  launch: 15000,
  attach: 10000,
  query: 5000,
  total: 30000,
  idleStop: 600000,
});

/**
 * 点验的错误文案（与 `element-args.js` 的 ERR 同构：**文案逐字**，单测全等断言）。
 *
 * 「错误码与用户提示分离」：`code` 只进日志/审计，`error` 只给人看；
 * 两者都不许带真实用户目录（[A2-13]：日志与文案不落全路径）。
 */
const ERR_HIT = {
  // —— 入参（[A2-2] 9 步，顺序固定，文案是契约）——
  badOp: (op) => `未知的点验操作：${op}`,
  needSource: '请给出要验的元素：pageId + elementId，或 locator + kind',
  notInVault: '这条元素在元素库中不存在（可能已被删除）',
  locked: '密码库未解锁：请先解锁再点验',
  // 复用既有文案真源（不复制字符串，[A2-2]）
  badUrl: ERR.badUrl,
  emptyLocator: ERR.emptyLocator,
  longLocator: ERR.longLocator,
  roleNeedsName: ERR.roleNeedsName,  longRoleName: ERR.longRoleName,
  busy: ERR.busy,
  pwUnsupported: ERR.pwUnsupported,

  // —— 会话与通道（[A2-4] 硬口径：这些一律 success:false，**不带 hit 字段**）——
  noBrowser: '没找到可用的浏览器（需要本机装有 Chrome 或 Edge）',
  launchFailed: '浏览器没能启动',
  noDevToolsPort: '浏览器起来了但没拿到调试端口（DevToolsActivePort 未生成），请重试',
  attachFailed: '连不上浏览器的调试通道',
  noPage: '浏览器里没有可用的页面标签',
  queryFailed: '页面里没能完成这次查询',
  /** C-03：非法选择器的固定文案（用户动作 = 改写法，不是改元素） */
  invalidSelector: '定位器写法不合法（选择器语法错误），请检查后重试',
  timeout: '点验超时（已返回已完成的事实），请重试',
  stopFailed: '浏览器没能关掉（已放弃调试端口），请手动关闭那个窗口',

  // —— 面板文案（[A2-3] 表，逐字）——
  reasonText: {
    ok: '命中',
    'not-found': '没命中：页面上找不到这条定位器',
    'not-visible': '命中了但不可见（可能被折叠 / 隐藏）',
    'iframe-only': '主文档没命中，但页面有 iframe；本版不进 iframe',
    'login-required': '页面需要登录：在打开的浏览器里登录后再点一次',
    unsupported: '这条定位器暂不支持浏览器点验（请在 Playwright 试跑里验证）',
    timeout: '点验超时（已返回已完成的事实），请重试',
  },
};

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/* ================================================================
   定位方式归一（[A0-3] / [A2-2] 第 6 步）
   ================================================================ */

/**
 * 归一 kind：无值 / 空串 / 脏值 / 大小写不一致 → 一律 `css`。
 *
 * 与 `[A0-3]` 同一口径（`shared/locatorModes.js` 的 normalizeLocatorMode）：
 * **不做**「以 / 开头就当 xpath」这种推断，脏值绝不让调用方抛异常。
 * 注意 `[A2-2]` 第 6 步与 `el:trial-run` 的 `ERR.badKind` 口径**不同**（那里拒绝、这里当 css），
 * 差异是有意的：点验单条且只读，脏 kind 当 css 最保守。
 */
function normalizeKind(kind) {
  const v = String(kind === undefined || kind === null ? '' : kind)
    .trim()
    .toLowerCase();
  return HIT_KINDS.indexOf(v) >= 0 ? v : 'css';
}

/**
 * 这个 kind 是不是**真的**在点验清单里（`pw` 还要求能解析出白名单链，见 `pwPlanOf`）。
 *
 * ⚠️ 这里**不做 normalizeKind 兜底**（历史缺陷 AR-3 的一半）：`normalizeKind` 对任何脏值都回
 * `'css'`，若先归一成员再判，函数恒为 `true` —— 将来 `POM_LOCATOR_KINDS` 扩到第 11 种、
 * 这里忘了同步，调用方会以为「支持」，实际被静默当 css 验、然后报「没命中」（[A0-6] 同类假红）。
 * 现在：只有原样命中清单才是 true；脏值/未知值 false，由调用方明确处理。
 * （入参校验那条仍走 `normalizeKind` 的「脏 kind 当 css」，那是 [A2-2] 第 6 步的既定口径，两者不冲突。）
 */
function supportsHitTest(kind) {
  const v = String(kind === undefined || kind === null ? '' : kind)
    .trim()
    .toLowerCase();
  return HIT_KINDS.indexOf(v) >= 0;
}

/** 语义是否为近似实现（[A2-3] 的 approx 字段） */
function isApproxKind(kind) {
  return APPROX_KINDS.indexOf(normalizeKind(kind)) >= 0;
}

/**
 * 拆 role 定位器的「角色:可访问名称」——按**第一个冒号**切。
 *
 * 名称里自己可能还有冒号（`button:登录:备注`）。与生成器 `pageobject.ts` 的 role 语义对齐：
 * `locator` 存角色、`roleName` 存可访问名。（上游 `splitRoleSelector` 同款。）
 */
function splitRoleSelector(selector) {
  const s = String(selector === undefined || selector === null ? '' : selector);
  const i = s.indexOf(':');
  if (i < 0) return { role: s.trim(), name: '' };
  return { role: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
}

/* ================================================================
   端口协商（[A2-8]）
   ================================================================ */

/** `<profile>/DevToolsActivePort` 路径 */
function devToolsPortPath(profileDir) {
  return path.join(String(profileDir || ''), 'DevToolsActivePort');
}

/** `<profile>/pm-hit.pid` 路径 */
function pidFilePath(profileDir) {
  return path.join(String(profileDir || ''), HIT_PID_FILE_NAME);
}

/**
 * 解析 `DevToolsActivePort` 的**第一行**（端口）。
 *
 * 契约 [A2-8] 第 2 步：**只取第一行**；第二行是 browser 端点路径，只在 stop 的
 * `Browser.close` 例外路径里用（`parseBrowserWsPath`）。直连第二行会让
 * `Runtime.enable` 被拒（browser 端点没有 Runtime 域），现象是「连上了但什么都收不到」。
 */
function parseDevToolsPort(text) {
  const lines = String(text === undefined || text === null ? '' : text)
    .trim()
    .split(/\r?\n/);
  const raw = String(lines[0] || '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

/** 解析 `DevToolsActivePort` 的**第二行**（browser 端点路径），只用于 stop 的 Browser.close */
function parseBrowserWsPath(text) {
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
  const p = String(lines[1] || '').trim();
  if (!p.startsWith('/devtools/browser/')) return '';
  return p;
}

/**
 * 浏览器启动参数（**纯函数**，可单测）。
 *
 * 只允许这五个（[A2-8] 第 1 条）：
 *   --remote-debugging-port=0      让浏览器自己挑端口，我们读 DevToolsActivePort
 *   --user-data-dir=<本 profile>   独立 profile，绝不碰用户日常浏览器数据
 *   --no-first-run / --no-default-browser-check  别弹「设为默认」
 *   <url>                          启动即打开目标页
 *
 * ⚠️ 上游 `electron/sniffer/browser-session.js:buildLaunchArgs`（759 行）带
 * `--remote-debugging-address=127.0.0.1`，本项目**明禁**：只绑回环由 port=0 本身保证，
 * 多一个参数只扩大参数面。也**不许**「先探空闲端口再传参」（上游 pickFreePort 那套是
 * TOCTOU：探完到浏览器 bind 之间会被别的进程抢走，于是你连的是别人的浏览器）。
 */
function buildLaunchArgs(options) {
  const opt = options || {};
  const profileDir = str(opt.profileDir);
  if (!profileDir) throw new TypeError('buildLaunchArgs 需要 profileDir');
  return [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    str(opt.url) || 'about:blank',
  ];
}

/* ================================================================
   路径与 profile（[A2-9]）
   ================================================================ */

/**
 * 路径包含性校验（与 `element-args.js:isInsideProfile` 同一算法，[A2-9]）。
 *
 * 先 `path.resolve` 归一（消掉 `..`、重复分隔符、末尾反斜杠），再比较 `===` 或
 * `startsWith(base + path.sep)`，最后用 `path.relative` 反证一次（防 win32 大小写/尾分隔符边缘差异）。
 */
function isInsidePath(base, target) {
  const b = str(base);
  const t = str(target);
  if (!b || !t) return false;
  let resolvedBase;
  let resolved;
  try {
    resolvedBase = path.resolve(b);
    resolved = path.resolve(t);
  } catch {
    return false;
  }
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) return false;
  const rel = path.relative(resolvedBase, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 点验 profile 目录：`<DATA_DIR>/el-hit-profile`（不是系统临时目录，也不是 .pm-profile） */
function hitProfileDirOf(dataDir) {
  const base = str(dataDir);
  if (!base) return '';
  return path.join(path.resolve(base), HIT_PROFILE_DIR_NAME);
}

/** 目标是否落在点验 profile 里（清理/读取前的包含性校验） */
function isInsideHitProfile(dataDir, target) {
  const dir = hitProfileDirOf(dataDir);
  if (!dir) return false;
  return isInsidePath(dir, target);
}

/* ================================================================
   进程校验（[A2-10]：pid 文件是不可信输入，kill 前必须双校验）
   ================================================================ */

const BROWSER_EXE_RE = /^(msedge|chrome|chromium)\.exe$/i;

/** 进程名是否属于白名单（msedge / chrome / chromium，大小写不敏感） */
function isBrowserProcessName(name) {
  return BROWSER_EXE_RE.test(str(name));
}

/**
 * 命令行里是否含本次 profile 的绝对路径。
 *
 * Windows 的命令行是 `--user-data-dir="C:\Users\x\el-hit-profile"` —— 带引号。
 * 所以先做**归一**再判包含：小写 + 去引号 + 反斜杠统一 + 折叠重复分隔符。
 * （上游 `isOurProfileCommand`/`normalizeForMatch` 同款；不归一就会漏判，进而误杀/漏杀。）
 */
function commandHasProfile(cmd, profileDir) {
  const base = str(profileDir);
  if (!base) return false;
  const norm = (v) =>
    String(v === undefined || v === null ? '' : v)
      .toLowerCase()
      .replace(/["']/g, '')
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\');
  const hay = norm(cmd);
  const needle = norm(base).replace(/\\+$/, '');
  if (!hay || !needle) return false;

  /**
   * SEC-07（review-sec P3）：不能只做子串匹配。
   *
   * 老实现 `hay.indexOf(needle) >= 0` 会让 `--user-data-dir=…\el-hit-profile-backup`
   * 也命中 `…\el-hit-profile` —— 「命令行含本次 profile」这条 kill 前置校验可以被**同前缀目录**
   * 满足，等于放行一个不是本会话的浏览器。现在要求**路径段边界**：
   * 命中位置之后的下一个字符必须是 `\`（子路径）、`"`、空格、或串末；前一个字符必须是
   * `=`、`"`、空格、`(` 或串首，避免命中 `xxxel-hit-profile` 这类尾巴。
   */
  const isEndBoundary = (ch) => ch === '' || ch === '\\' || ch === '"' || ch === ' ' || ch === '/';
  const isStartBoundary = (ch) => ch === '' || ch === '=' || ch === '"' || ch === ' ' || ch === '/' || ch === '(';
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay.slice(at + needle.length, at + needle.length + 1);
    if (isStartBoundary(before) && isEndBoundary(after)) return true;
    from = at + 1;
  }
}

/**
 * 进程创建时间是否晚于（或等于）本次会话开始时间。
 *
 * 用来挡「pid 被复用」：pid 文件是手工可改的，光有 pid 不能证明「这个进程是我起的」。
 * 解析失败（取不到 CreationDate）按 false 处理 —— 宁可少杀，不许错杀。
 */
function isCreationAfter(creation, startedAt) {
  const c = parsePowerShellDate(creation);
  const s = parsePowerShellDate(startedAt);
  if (!Number.isFinite(c) || !Number.isFinite(s)) return false;
  // PowerShell 的 CreationDate 精度到毫秒，允许 2 秒时钟抖动
  return c + 2000 >= s;
}

/**
 * 解析 PowerShell 的日期字符串 —— **两种格式都要认**（C-02 的第二个坑）。
 *
 *   pwsh 7（PowerShell Core）：`2026-11-27T04:01:10.068Z` 这种 ISO 串 → `Date.parse` 直接可用
 *   Windows PowerShell 5.1：`ConvertTo-Json` 把 DateTime 序列化成 `/Date(1795754066982)/`
 *
 * 只认 ISO 时，回退到 `powershell.exe` 之后 `Date.parse('/Date(...)/')` = NaN →
 * `isCreationAfter` 恒 false → `verifyProcess` 恒不通过 → stop 的 L2/L3 仍然永不执行。
 * 也就是说：**只换 shell 不换日期解析，C-02 并没有修好**（本机实测两处都能复现）。
 */
function parsePowerShellDate(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return NaN;
  const msMatch = raw.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (msMatch) return Number(msMatch[1]);
  return Date.parse(raw);
}

/* ================================================================
   进程查询用的 PowerShell（C-02：不许硬编码 pwsh）
   ================================================================ */

/**
 * 挑一个能用的 PowerShell：**pwsh（7+）优先，没有就回退 `powershell.exe`（Windows 自带）**。
 *
 * 为什么必须回退（review-code C-02，P1）：Win10/11 **默认不带 pwsh**。老实现把 `'pwsh'` 写死，
 * `spawnSync` 直接失败 → `parseCimJson` 拿到空 → `verifyProcess` 恒 `{ok:false}` →
 * stop 的 L2/L3 永不执行（「校验不过就不动手」的方向是对的，但结果是**留一个带调试端口的
 * 浏览器进程**）。t21 量的 382ms 是在**装了 pwsh 的本机**上跑出来的，属环境侥幸。
 *
 * 探测复用仓库既有实现 `electron/which.js`（`where`/`which` 取第一行），与
 * `browser-focus.js` / `ipc-codelab.js` 同一套做法，不自造第二份。
 *
 * @param {(name: string) => string} whichFn 形如 `which(name)`：命中回绝对路径，否则 ''
 * @returns {'pwsh'|'powershell.exe'}
 */
function pickProcShell(whichFn) {
  try {
    if (typeof whichFn === 'function' && String(whichFn('pwsh') || '').trim()) return 'pwsh';
  } catch {
    /* 探测本身失败就当没有 pwsh */
  }
  return 'powershell.exe';
}

/**
 * 从一份进程快照里挑出「可以杀」的和「绝不碰」的（**纯函数**，夹具可直接喂）。
 *
 * 三项全过才算 ours（[A2-10]）：进程名白名单 + 命令行含本 profile + 创建时间。
 * 其余全部进 skipped 并给出理由 —— **未通过校验的 pid 一律不进 taskkill 的入参**。
 * （上游 `collectOwnedPids` 是「按 profile 扫全机」，本项目只校验「已知的那几个 pid」。）
 *
 * @param {Array<{pid:number,name:string,cmd:string,creation?:string}>} procs
 * @param {{profileDir:string, startedAt?:string}} ctx
 * @returns {{ours:Array<{pid:number,name:string}>, skipped:Array<{pid:*,why:string}>}}
 */
function pickKillable(procs, ctx) {
  const o = ctx || {};
  const profileDir = str(o.profileDir);
  const startedAt = str(o.startedAt);
  const ours = [];
  const skipped = [];
  for (const p of Array.isArray(procs) ? procs : []) {
    const pid = count(p && p.pid);
    if (!pid) {
      skipped.push({ pid: p && p.pid, why: '不是有效 pid' });
      continue;
    }
    const name = str(p && p.name);
    if (!isBrowserProcessName(name)) {
      skipped.push({ pid, why: `不是 msedge/chrome/chromium 进程（${name || '未知'}）` });
      continue;
    }
    if (!profileDir) {
      skipped.push({ pid, why: '没有本次 profile 路径，无法校验命令行' });
      continue;
    }
    if (!commandHasProfile(p && p.cmd, profileDir)) {
      skipped.push({ pid, why: '命令行里没有本次 profile，不认识的 pid 不碰' });
      continue;
    }
    if (!startedAt) {
      // SEC-06（review-sec P3）：`startedAt` 来自 `pm-hit.pid`（**不可信输入**，手改/写坏即为空）。
      // 老实现 `if (startedAt && !isCreationAfter(...))` 在空值时会**静默跳过**创建时间校验，
      // 「pid 复用」这道防线就没了，只剩进程名 + 命令行两条。现在缺时间一律视为校验失败：
      // **宁可跳过、不杀**（与 [A2-10]「宁可少杀，不许错杀」同向）。
      skipped.push({ pid, why: '没有本次会话的开始时间（账本不可信），无法排除 pid 复用' });
      continue;
    }
    if (!isCreationAfter(p && p.creation, startedAt)) {
      skipped.push({ pid, why: '创建时间早于本次会话（pid 可能被复用）' });
      continue;
    }
    ours.push({ pid, name });
  }
  return { ours, skipped };
}

/* ================================================================
   入参校验（[A2-2]：9 步，顺序固定，文案是契约）
   ================================================================ */

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value === undefined || value === null ? '' : value).trim());
}

/**
 * 校验并归一 `el:hit-test` 的入参。
 *
 * 错误一律**返回**不抛（IPC 层回 `{success:false, error}`，抛出去会变未捕获异常）。
 * `ctx` 提供两件事，都由 ipc 层注入（本文件不碰 vault）：
 *   `ctx.unlocked`        —— 密码库是否解锁
 *   `ctx.findElement(p,e)` —— 按 pageId+elementId 取元素（取不到回 null）
 *
 * ⚠️ 第 8 步（元素不存在）与第 9 步（未解锁）在**实现上必须 9 先**：
 * 未解锁时读不到库，若先判「找不到」就会把「没验成」说成「元素不存在」——
 * 这与 [A2-4]「没连上不许写成没命中」是同一类假结论。契约里两条并列，本函数按此定序。
 *
 * @returns {{ok:true, op:string, plan:object|null} | {ok:false, error:string, code:string}}
 */
function validateHitTestArgs(input, ctx) {
  const raw = input && typeof input === 'object' ? input : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};

  // 1) op
  const opRaw = raw.op === undefined || raw.op === null || raw.op === '' ? 'verify' : String(raw.op);
  const op = opRaw.trim();
  if (HIT_OPS.indexOf(op) < 0) return { ok: false, error: ERR_HIT.badOp(op), code: 'bad-op' };
  // 2) status / stop 不需要 url 与定位器
  if (op !== 'verify') return { ok: true, op, plan: null };

  // 3) 来源恰好一组
  const pageId = str(raw.pageId);
  const elementId = str(raw.elementId);
  const draftLocator = str(raw.locator);
  const draftKind = str(raw.kind);
  const fromVault = !!(pageId || elementId);
  const fromDraft = !!(draftLocator || draftKind);
  if (fromVault === fromDraft) return { ok: false, error: ERR_HIT.needSource, code: 'bad-source' };
  if (fromVault && !(pageId && elementId)) {
    return { ok: false, error: ERR_HIT.needSource, code: 'bad-source' };
  }

  // 4) url 只放行 http/https（file:// / chrome:// / devtools:// / javascript: 全在这里被拒）
  const url = str(raw.url);
  if (!isHttpUrl(url)) return { ok: false, error: ERR_HIT.badUrl, code: 'bad-url' };

  /**
   * 8) **未解锁 → 直接拒**（契约 v5 `[A2-2]` 第 8 步，**先于**第 9 步的元素存在性判定）。
   *
   * `[SEC-01]`（队长裁定收紧）：闸门对**任何来源**生效，不再区分「落库」与「草稿」。
   * 理由（契约 v5 §8）：① 元素库是 vault 数据，锁定态不该由库驱动联网动作；
   * ② `label`（≤40 字页面文本）+ `text` 的 indexOf 子串判定 = **布尔 oracle**，
   * 锁定态 + 渲染层被攻破时等价「内网页面文本读取器」，审计/限速只留痕不消除能力；
   * ③ 草稿来源的自然场景（从 codegen 粘一条）本来就已解锁，收紧不损失正常路径。
   *
   * **顺序必须是「未解锁」先于「元素不存在」**：否则锁定态会得到「这条元素在元素库中不存在」
   * 这种假事实（[A2-4] 同类结论）。这一处也是「闸门在起浏览器之前」的落点 ——
   * `hit-session.handle()` 先校验、后 `verify()`，所以锁定态下 `spawn` 计数恒为 0。
   */
  if (c.unlocked !== true) return { ok: false, error: ERR_HIT.locked, code: 'locked' };

  // 9) 取元素（只在已解锁时可达）
  let plan;
  if (fromVault) {
    const el = typeof c.findElement === 'function' ? c.findElement(pageId, elementId) : null;
    if (!el) return { ok: false, error: ERR_HIT.notInVault, code: 'not-in-vault' };
    plan = {
      source: 'vault',
      pageId,
      elementId,
      kind: el.kind,
      locator: el.locator,
      roleName: el.role === undefined || el.role === null ? '' : String(el.role),
    };
  } else {
    plan = {
      source: 'draft',
      kind: draftKind,
      locator: draftLocator,
      roleName: str(raw.roleName),
    };
  }

  // 5) 定位值
  plan.kind = normalizeKind(plan.kind); // 6) 脏 kind → css（不报错）
  plan.locator = String(plan.locator === undefined || plan.locator === null ? '' : plan.locator);
  if (!plan.locator.trim()) return { ok: false, error: ERR_HIT.emptyLocator, code: 'empty-locator' };
  if (plan.locator.length > MAX_LOCATOR_LEN) {
    return { ok: false, error: ERR_HIT.longLocator, code: 'long-locator' };
  }
  // 7) role 必须有可访问名
  plan.roleName = String(plan.roleName || '');
  if (plan.kind === 'role' && !plan.roleName.trim()) {
    return { ok: false, error: ERR_HIT.roleNeedsName, code: 'role-needs-name' };
  }
  if (plan.roleName.length > MAX_ROLE_NAME_LEN) {
    return { ok: false, error: ERR_HIT.longRoleName, code: 'long-role-name' };
  }

  plan.url = url;
  plan.timeoutMs = Number(raw.timeoutMs);
  plan.budget = computeHitBudget(plan.timeoutMs);
  return { ok: true, op, plan };
}

/**
 * 三段超时预算（[A2-6]）：`total = min(30000, max(5000, timeoutMs))`，三段各自 `min(单段上限, total)`。
 * 与 `element-args.js:computeBudget` 同构（复用同一形状，不引它以免把 goto/items 语义混进来）。
 */
function computeHitBudget(timeoutMs) {
  const asked = Number(timeoutMs);
  const total =
    Number.isFinite(asked) && asked > 0
      ? Math.min(HIT_BUDGET.total, Math.max(5000, Math.floor(asked)))
      : HIT_BUDGET.total;
  return {
    total,
    launch: Math.min(HIT_BUDGET.launch, total),
    attach: Math.min(HIT_BUDGET.attach, total),
    query: Math.min(HIT_BUDGET.query, total),
  };
}

/* ================================================================
   事实归一（[A2-3] / [A2-4]）
   ================================================================ */

/**
 * 页内事实里「这次查询根本没做成」的那一类 → 返回失败回执；正常则回 null（C-03）。
 *
 * 为什么要有这个函数：页内脚本对**语法错的选择器**会置 `selectorInvalid`。老实现叫 `invalid`
 * 且 `normalizeHitFacts` 的白名单里没有它 → 被静默丢弃 → 面板显示 `not-found`「没命中」，
 * 用户会去改元素而不是改写法（[A2-4]「没验成不许说成没命中」的同类假结论）。
 *
 * 这里**不新增 reason 值**：reason 的 7 值是 UI 12 态状态机的输入（`src/components/codegen/`），
 * 扩它要同时改状态机与 qa 计数；而「没验成」本来就有 `success:false` 这条既有通道。
 *
 * @param {object} raw 页内脚本返回的原始 JSON
 * @returns {{error:string, code:string}|null}
 */
function queryFailureOf(raw) {
  if (raw && typeof raw === 'object' && raw.selectorInvalid === true) {
    return { error: ERR_HIT.invalidSelector, code: 'query-failed' };
  }
  return null;
}

/**
 * 把页内脚本回的原 JSON 收口成可信的事实对象。
 *
 * 为什么要收口（上游 parseSniffState 同款理由）：那是**页面里的值**，我们只是客人，
 * 页面自己的脚本可以把它改坏。所以只认白名单字段、数字做范围收敛、label 截断去换行。
 *
 * 三条硬做法（照抄上游）：
 *   ① 只认白名单字段；② 数字收敛成 0/正整数；③ 不变式：`total === 0` 一定不是 'ok'。
 * 三条本项目改造：`total` 截到 50 并置 `truncated`（[A2-1]）、`label` 截 40（[A2-3]）、
 * `unsupported` 由「页内解析不了」或「调用方事前判不支持」两路汇入。
 *
 * @param {object} raw 页内脚本返回值
 * @param {object} meta `{ kind, locator, roleName?, source, pageId?, elementId?, ms, approx?, reason? }`
 */
function normalizeHitFacts(raw, meta) {
  const m = meta || {};
  const r = raw && typeof raw === 'object' ? raw : {};
  const total0 = count(r.total);
  const truncated = total0 > MAX_TOTAL;
  const total = Math.min(total0, MAX_TOTAL);
  const visible = r.visible === true;
  const iframes = count(r.iframes);
  const login = r.login === true;
  const label = String(r.label === undefined || r.label === null ? '' : r.label)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LEN);

  const preUnsupported = m.reason === 'unsupported' || r.unsupported === true;
  let reason;
  if (preUnsupported) reason = 'unsupported';
  else if (total > 0) reason = visible ? 'ok' : 'not-visible';
  // 「页面要登录」比「有 iframe」更可操作，所以登录页优先（两者同时成立时选这条）
  else if (login) reason = 'login-required';
  else if (iframes > 0) reason = 'iframe-only';
  else reason = 'not-found';

  const facts = {
    found: total > 0,
    total,
    truncated,
    visible,
    // [N-2]：本期不进 iframe，所以 inIframe **恒为 false**（如实取值，不是「没实现所以瞎填」）
    inIframe: false,
    iframes,
    reason,
    label,
    approx: m.approx === true || isApproxKind(m.kind),
    kind: String(m.kind || ''),
    locator: String(m.locator === undefined || m.locator === null ? '' : m.locator),
    source: m.source === 'vault' ? 'vault' : 'draft',
    ms: count(m.ms),
  };
  if (m.roleName) facts.roleName = String(m.roleName);
  if (m.pageId) facts.pageId = String(m.pageId);
  if (m.elementId) facts.elementId = String(m.elementId);
  return facts;
}

/* ================================================================
   页内注入脚本（[A2-7]：只读事实，不拼串，不碰凭证，不读整页文本）
   ================================================================ */

/**
 * `visible` 的判据源码（[A2-3] 逐字）：
 *   `el.getClientRects().length > 0 && vis !== 'hidden'`
 *
 * 与 Playwright `isVisible()` 对齐：**`opacity:0` 仍算 visible**，`display:none` / 零尺寸 /
 * `visibility:hidden` 算不可见。上游 `isVisible` 把 opacity:0 判成不可见，那是另一套口径。
 * 单独抽成常量是为了让单测能 `new Function('el', 'vis', ...)` **直接执行这段源码**——
 * 不是断言注释、不是断言镜像函数，跑的就是注入脚本里那一行。
 */
const VISIBLE_PREDICATE_SRC = "el.getClientRects().length > 0 && vis !== 'hidden'";

/**
 * 页内固定脚本（**唯一一段**，[A2-7]）。
 *
 * 契约硬约束（逐条对应）：
 *   · 定位值只经 `arguments` 以 JSON 进来（`argsJson`），脚本里**没有任何字符串拼接**；
 *   · 只用 DOM 查询 / `getClientRects` / `getComputedStyle` / 属性读取；
 *   · **不**读凭证类存储、**不**读整页文本（`textContent` 只按元素用于 label/text 匹配，
 *     那是 [A2-7] 的 `text` / `label` 能力本身要求的）；
 *   · **不**写页面状态（不画框、不加属性、不 scrollIntoView）—— 高亮由 Overlay.highlightNode 做；
 *   · `wantElement=true` 时只回元素本身（给 DOM.requestNode/Overlay 用），否则回事实对象。
 *
 * 调用两次、脚本只有一段：第一次要事实（returnByValue），第二次要元素（objectId）。
 */
const HIT_SCRIPT = `function (argsJson) {
  var ARGS = JSON.parse(String(argsJson));
  var KIND = String(ARGS.kind || 'css');
  var LOC = String(ARGS.locator || '');
  var RNAME = String(ARGS.roleName || '');
  var WANT = ARGS.wantElement === true;
  var MAXN = ${MAX_NODES};
  var IMPLICIT = ${JSON.stringify(IMPLICIT_ROLE_NAMES)};
  var MAXLABEL = ${MAX_LABEL_LEN};

  function norm(v) {
    return String(v === undefined || v === null ? '' : v).replace(/\\s+/g, ' ').trim();
  }
  function attr(el, n) {
    try {
      if (!el || !el.getAttribute) return '';
      var v = el.getAttribute(n);
      return v === null || v === undefined ? '' : String(v);
    } catch (e) { return ''; }
  }
  function toArr(list) {
    var out = [];
    if (!list) return out;
    if (typeof list.length === 'number') {
      for (var i = 0; i < list.length; i++) out.push(list[i]);
      return out;
    }
    var n = Number(list.snapshotLength) || 0;
    for (var j = 0; j < n; j++) out.push(list.snapshotItem(j));
    return out;
  }
  function unique(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) < 0) out.push(list[i]);
    return out;
  }
  function textOf(el) {
    try { return el ? norm(el.textContent) : ''; } catch (e) { return ''; }
  }
  function ariaLabelledBy(el) {
    var ids = attr(el, 'aria-labelledby');
    if (!ids) return '';
    var parts = [];
    var list = ids.split(/\\s+/);
    for (var i = 0; i < list.length; i++) {
      var t = document.getElementById ? document.getElementById(list[i]) : null;
      if (t) parts.push(textOf(t));
    }
    return norm(parts.join(' '));
  }
  function labelsText(el) {
    try {
      if (!el || !el.labels || !el.labels.length) return '';
      var parts = [];
      for (var i = 0; i < el.labels.length; i++) parts.push(textOf(el.labels[i]));
      return norm(parts.join(' '));
    } catch (e) { return ''; }
  }
  function accName(el) {
    if (!el) return '';
    var aria = norm(attr(el, 'aria-label'));
    if (aria) return aria;
    var by = ariaLabelledBy(el);
    if (by) return by;
    return textOf(el);
  }
  function labelOf(el) {
    var name = accName(el);
    if (name) return name.slice(0, MAXLABEL);
    var tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
    return tag;
  }
  function implicitRole(el) {
    var tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
    var type = norm(attr(el, 'type')).toLowerCase();
    if (tag === 'a') return attr(el, 'href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'img';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    return '';
  }
  function roleOf(el) {
    var r = norm(attr(el, 'role')).split(/\\s+/)[0];
    return r ? r.toLowerCase() : implicitRole(el);
  }
  function byAttr(name, value) {
    var want = norm(value);
    var all = toArr(document.querySelectorAll('[' + name + ']'));
    if (!want) return all;
    var out = [];
    for (var i = 0; i < all.length && i < MAXN; i++) {
      if (norm(attr(all[i], name)) === want) out.push(all[i]);
    }
    return out;
  }
  function byLabel(value) {
    var want = norm(value).toLowerCase();
    var out = [];
    var labels = toArr(document.getElementsByTagName('label'));
    for (var i = 0; i < labels.length && i < MAXN; i++) {
      var t = textOf(labels[i]).toLowerCase();
      if (!want || t === want || t.indexOf(want) >= 0) {
        var ctl = labels[i].control || (labels[i].querySelector ? labels[i].querySelector('input,select,textarea,button') : null);
        if (ctl) out.push(ctl);
      }
    }
    return unique(out);
  }
  function byText(value) {
    var want = norm(value).toLowerCase();
    if (!want || !document.createTreeWalker) return [];
    var walker = document.createTreeWalker(document.body || document.documentElement, 4, null);
    var out = [];
    var guard = 0;
    var node = walker.nextNode();
    while (node && guard < MAXN) {
      guard++;
      var t = norm(node.nodeValue).toLowerCase();
      var el = node.parentElement;
      if (t && el && t.indexOf(want) >= 0) out.push(el);
      node = walker.nextNode();
    }
    return unique(out);
  }
  function byRole(role, name) {
    var wantRole = norm(role).toLowerCase();
    if (!wantRole || IMPLICIT.indexOf(wantRole) < 0) return [];
    var wantName = norm(name).toLowerCase();
    var all = toArr(document.querySelectorAll('*'));
    var out = [];
    for (var i = 0; i < all.length && i < MAXN; i++) {
      if (roleOf(all[i]) !== wantRole) continue;
      if (!wantName) { out.push(all[i]); continue; }
      var nm = norm(accName(all[i])).toLowerCase();
      if (nm === wantName || nm.indexOf(wantName) >= 0) out.push(all[i]);
    }
    return out;
  }
  function visibilityOf(el) {
    var cs = null;
    try {
      var v = el && el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
      cs = v.getComputedStyle(el);
    } catch (e) { cs = null; }
    return cs ? String(cs.visibility) : '';
  }
  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    var vis = visibilityOf(el);
    return ${VISIBLE_PREDICATE_SRC};
  }
  function find() {
    if (KIND === 'css') return toArr(document.querySelectorAll(LOC));
    if (KIND === 'xpath') {
      var res = document.evaluate(LOC, document, null, 7, null);
      return toArr(res);
    }
    if (KIND === 'label') return byLabel(LOC);
    if (KIND === 'text') return byText(LOC);
    if (KIND === 'placeholder') return byAttr('placeholder', LOC);
    if (KIND === 'alttext') return byAttr('alt', LOC);
    if (KIND === 'title') return byAttr('title', LOC);
    if (KIND === 'testid') return byAttr('data-testid', LOC);
    if (KIND === 'role') return byRole(LOC, RNAME);
    return null;
  }

  var hits = [];
  var bad = '';
  if (KIND === 'pw') {
    bad = 'pw';
  } else {
    try {
      hits = find() || [];
    } catch (e) {
      hits = [];
      bad = 'selector';
    }
  }
  if (WANT) return hits.length ? hits[0] : null;

  var first = hits.length ? hits[0] : null;
  var iframes = 0;
  try { iframes = document.getElementsByTagName('iframe').length; } catch (e) { iframes = 0; }
  var login = false;
  try {
    var pw = document.querySelector('input[type="password"]');
    var href = String(location.href);
    login = !!pw || /(login|signin|sign-in|sso|passport|auth)/i.test(href);
  } catch (e) { login = false; }
  var hrefOut = '';
  try { hrefOut = String(location.href); } catch (e) { hrefOut = ''; }
  return {
    total: hits.length,
    visible: first ? isVisible(first) : false,
    label: first ? labelOf(first) : '',
    iframes: iframes,
    login: login,
    // C-03（review-code P1）：字段名从 invalid 改成 selectorInvalid —— 原来的 invalid 在
    // normalizeHitFacts 的白名单里**没有消费方**，被静默丢弃，于是「定位器打错一个字符」
    // 最终显示成 not-found「没命中」（用户会去改元素而不是改写法，属 [A2-4] 同类假结论）。
    // 现在由 hit-session 显式消费，转成「没验成」的失败回执。
    selectorInvalid: bad === 'selector',
    unsupported: bad === 'pw',
    href: hrefOut
  };
}`;

/** 交给 `Runtime.callFunctionOn` 的参数（JSON 字符串：定位值只走 arguments，不进脚本文本） */
function buildHitScriptArgs(plan, wantElement) {
  const p = plan || {};
  const args = {
    kind: normalizeKind(p.kind),
    locator: String(p.locator === undefined || p.locator === null ? '' : p.locator),
    roleName: String(p.roleName || ''),
  };
  if (wantElement === true) args.wantElement = true;
  return JSON.stringify(args);
}

/**
 * `pw` 链的点验支持判定：只有能解析成白名单方法链、且方法都在点验白名单里才算支持。
 * 解析不出 → `reason:'unsupported'` + 既有文案（[A2-7]），绝不硬拼进脚本。
 */
const PW_HIT_METHODS = [
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByTestId',
  'getByAltText',
  'getByTitle',
  'filter',
  'first',
  'last',
  'nth',
];

function pwPlanOf(locator) {
  const r = pwChainPlan(locator);
  if (!r || r.ok !== true) return { ok: false, error: ERR_HIT.pwUnsupported };
  const steps = Array.isArray(r.plan) ? r.plan : [];
  if (!steps.length) return { ok: false, error: ERR_HIT.pwUnsupported };
  for (const s of steps) {
    if (PW_HIT_METHODS.indexOf(s && s.name) < 0) return { ok: false, error: ERR_HIT.pwUnsupported };
  }
  return { ok: true, plan: steps };
}

module.exports = {
  HIT_CHANNEL,
  HIT_OPS,
  HIT_KINDS,
  HIT_REASONS,
  HIT_BUDGET,
  HIT_PROFILE_DIR_NAME,
  HIT_PID_FILE_NAME,
  IMPLICIT_ROLE_NAMES,
  APPROX_KINDS,
  MAX_LOCATOR_LEN,
  MAX_ROLE_NAME_LEN,
  MAX_TOTAL,
  MAX_LABEL_LEN,
  MAX_NODES,
  PW_HIT_METHODS,
  VISIBLE_PREDICATE_SRC,
  HIT_SCRIPT,
  ERR_HIT,
  normalizeKind,
  supportsHitTest,
  isApproxKind,
  splitRoleSelector,
  isHttpUrl,
  devToolsPortPath,
  pidFilePath,
  parseDevToolsPort,
  parseBrowserWsPath,
  buildLaunchArgs,
  isInsidePath,
  hitProfileDirOf,
  isInsideHitProfile,
  isBrowserProcessName,
  commandHasProfile,
  isCreationAfter,
  parsePowerShellDate,
  pickProcShell,
  queryFailureOf,
  pickKillable,
  validateHitTestArgs,
  computeHitBudget,
  normalizeHitFacts,
  buildHitScriptArgs,
  pwPlanOf,
};
