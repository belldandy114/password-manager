'use strict';

/**
 * record-probe.js —— 录制域的**本机能力探针**（`record:probe` 的数据源）。
 *
 * 四类探针 → 五盏灯（`[C-114]` 的 `id` 固定集合）：
 *   - Chromium 系（白名单判定）→ `chrome`
 *   - PATH 上的 `node`（**必须** `which('node')`，不许拿 `process.execPath` 冒充）→ `node`
 *   - JDK + Playwright jar 两级 → `jdk-jar`
 *   - 工程内 `@playwright/test` → `playwright`
 *   - 工程目录本身 → `workspace`（**未选目录 = `grey`，不是 `red`**，裁定 J-6）
 *
 * 三条硬约束：
 * 1. **灯 5 未选目录必须 `grey`**（J-6）：把「没选」判成「坏了」会让新手以为环境有问题。
 * 2. **仅测试可用的探针注入口**（J-9）：`PM_RECORD_PROBE_STUB=<json 路径>`；`app.isPackaged`
 *    为真时**强制忽略**（打包版永不走桩），生效时返回值带 `stubbed: true`，并打一行日志
 *    显式标识「使用桩数据」（界面标识归 S5）。为什么要有：AC-14 的四类反例（无 node /
 *    只有 Firefox / 缺 jar / 未选目录）在本机造不出来，没有注入口就只能靠人眼看。
 * 3. **超时与缓存**：单条外部命令 3 s、整体快照缓存 60 s（`force` 跳过），
 *    且**任何单灯失败都不许抛**（探针炸了等于界面永远白灯）。
 *
 * 本文件不 require `electron`（除 `app.isPackaged` 的惰性探测，失败按「非打包」处理），
 * 全部外部能力经 `deps` 注入，单测不起真实子进程、不读真实磁盘。
 *
 * @module electron/record-probe
 */

const { which: whichDefault } = require('./which');

/** 灯 id 固定 5 个（顺序即界面展示顺序） */
const ABILITY_IDS = ['chrome', 'node', 'jdk-jar', 'playwright', 'workspace'];
/** 灯态四值 */
const STATES = ['green', 'yellow', 'red', 'grey'];
/** 快照缓存时长（契约 `[C-114]`：缓存 60 s，`force` 跳过） */
const PROBE_TTL_MS = 60000;
/** 单条外部命令（`node --version` 之类）的超时：探针不能把界面拖住 */
const PROBE_EXEC_TIMEOUT_MS = 3000;
/** 探针注入口环境变量名（J-9） */
const STUB_ENV = 'PM_RECORD_PROBE_STUB';
/** 证据里的本机路径占位符（契约 `[C-114]` record:probe 条） */
const HOME_PLACEHOLDER = '<用户目录>';
const WORKSPACE_PLACEHOLDER = '<工程目录>';
/** 桩文件大小上限（SEC-R2-07：指到 2 GB 文件不许把主进程拖死） */
const MAX_STUB_BYTES = 64 * 1024;
/** detail / fixHint 长度上限（进渲染层、会被截图外带） */
const MAX_ABILITY_TEXT = 200;
/** evidence[].cmd / out 长度上限 */
const MAX_EVIDENCE_TEXT = 200;
/** 单灯 evidence 条数上限 */
const MAX_STUB_EVIDENCE = 10;
/** Node 运行时的最低版本（契约 `[C-118]`：**Node ≥ 22**，18/20 没有全局 WebSocket；本版不再对外宣传 `.mjs` 产物） */
const NODE_MIN_MAJOR = 22;

/** Chromium 系可执行文件名白名单（正向）：不在表里的一律不认，Firefox 永不通过 */
const CHROMIUM_EXECUTABLES = [
  'chrome',
  'chrome-proxy',
  'google-chrome',
  'google-chrome-stable',
  'msedge',
  'brave',
  'brave-browser',
  'chromium',
  'chromium-browser',
  'vivaldi',
  'opera',
];
/** 反例提示用：这些名字说明「装了浏览器但 CDP 用不了」 */
const NON_CHROMIUM_EXECUTABLES = ['firefox', 'firefox-esr', 'safari', 'iexplore'];

/** 60 s 快照缓存：key = workspaceDir（空串代表「未选工程目录」） */
const cache = new Map();

/** 各灯的中文名 */
const LABELS = {
  chrome: '浏览器（Chromium 系）',
  node: 'Node.js',
  'jdk-jar': 'JDK + Playwright jar',
  playwright: '@playwright/test',
  workspace: '工程目录',
};

/** 清空缓存（单测用；生产只会被 60 s TTL 与 force 影响） */
function resetProbeCache() {
  cache.clear();
}

/** 取文件名（不引 path，避免 Windows/Unix 分隔符差异影响判定） */
function baseName(p) {
  const text = String(p || '');
  const idx = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return idx >= 0 ? text.slice(idx + 1) : text;
}

/** 去 .exe / 小写后的可执行名 */
function exeStem(p) {
  return baseName(p).replace(/\.exe$/i, '').toLowerCase();
}

/**
 * Chromium 系白名单判定（逐字比对可执行名）。
 * @param {string} executable 路径或文件名
 * @returns {boolean}
 */
function isChromiumExecutable(executable) {
  const stem = exeStem(executable);
  return !!stem && CHROMIUM_EXECUTABLES.includes(stem);
}

/** 是否「非 Chromium 系浏览器」（只为把反例讲清楚，不参与判定） */
function isNonChromiumExecutable(executable) {
  const stem = exeStem(executable);
  return !!stem && NON_CHROMIUM_EXECUTABLES.includes(stem);
}

/** 替换所有出现（含正反斜杠两种写法） */
function replaceAll(text, from, to) {
  if (!from) return text;
  let out = text.split(from).join(to);
  const flipped = from.indexOf('\\') >= 0 ? from.split('\\').join('/') : from.split('/').join('\\');
  if (flipped !== from) out = out.split(flipped).join(to);
  return out;
}

/**
 * 证据脱敏：把本机绝对路径换成占位符（契约 `[C-114]`：`evidence[].out` 回渲染层前必须替换）。
 * @param {string} text
 * @param {{homeDir?: string, workspaceDir?: string}} ctx
 * @returns {string}
 */
function redactEvidenceText(text, ctx = {}) {
  let out = String(text == null ? '' : text);
  // 先替换更长的路径（工程目录常是用户目录的子目录）
  const pairs = [
    [ctx.workspaceDir, WORKSPACE_PLACEHOLDER],
    [ctx.homeDir, HOME_PLACEHOLDER],
  ].filter(([from]) => !!from);
  for (const [from, to] of pairs) out = replaceAll(out, String(from), to);
  // SEC-R2-09：`os.homedir()` 取不到（服务账号 / 精简环境）时上面的精确替换等于零生效，
  // 于是 `C:\Users\<名>` / `/home/<名>` / `/Users/<名>` 会原样回渲染层。这里按**路径形态**兜底。
  out = out
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi, HOME_PLACEHOLDER)
    .replace(/\/home\/[^/\s"']+/g, HOME_PLACEHOLDER)
    .replace(/\/Users\/[^/\s"']+/g, HOME_PLACEHOLDER);
  return out;
}

/** 拼路径（只用正斜杠，跨平台只作展示与存在性判断） */
function joinPath() {
  const parts = Array.prototype.slice.call(arguments).filter((p) => p !== '' && p != null);
  return parts
    .map((p, i) => (i === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')))
    .join('/');
}

/** 默认依赖：全部外部能力集中在这里，便于单测整体替换 */
function defaultDeps(overrides) {
  const os = require('os');
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  let homeDir = '';
  try { homeDir = os.homedir(); } catch { homeDir = ''; }

  const base = {
    platform: process.platform,
    homeDir,
    env: process.env,
    which: (name) => whichDefault(name),
    exec: (cmd, args) => {
      try {
        const out = execFileSync(cmd, args, {
          encoding: 'utf8',
          timeout: PROBE_EXEC_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return { ok: true, out: String(out).trim() };
      } catch (e) {
        return { ok: false, out: '', timedOut: !!(e && (e.killed || e.signal)) };
      }
    },
    exists: (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    },
    readdir: (p) => {
      try { return fs.readdirSync(p); } catch { return []; }
    },
    readTextFile: (p) => fs.readFileSync(p, 'utf8'),
    now: () => Date.now(),
    isPackaged: null,
    // 桩生效时**必须**显式标识（J-9）；只打桩路径，不打任何探针载荷
    log: (...args) => console.log(...args),
  };
  return Object.assign(base, overrides || {});
}

/**
 * 打包版探测（**失败即按打包处理**，宁严勿宽 —— SEC-R2-07）。
 *
 * 旧实现 `catch → false` 的风险：`require('electron')` 出异常（或有人传了 `isPackaged:false`）
 * 时打包版会被判成开发版，桩通道就在交付物里生效了。现在的优先级：
 *   1. 显式注入的 `deps.isPackaged`（只给单测用）；
 *   2. 真 `app.isPackaged`；
 *   3. 取不到 → **true**（= 桩失效）。
 */
function detectPackaged(deps) {
  if (typeof deps.isPackaged === 'boolean') return deps.isPackaged;
  try {
    const { app } = require('electron');
    // 拿得到 electron 但没有 `app` ⇒ 不在主进程里（渲染层 / 纯 node）⇒ 同样按打包处理，桩失效
    if (!app) return true;
    return !!app.isPackaged;
  } catch {
    return true;
  }
}

/** 桩只在「非打包 + 非 production」时允许（SEC-R2-07：生效条件写死） */
function stubAllowed(deps) {
  if (detectPackaged(deps)) return false;
  const nodeEnv = String((deps.env && deps.env.NODE_ENV) || '').toLowerCase();
  return nodeEnv !== 'production';
}

/** 造一个灯 */
function ability(id, state, detail, evidence, fixHint) {
  const out = { id, state, label: LABELS[id], detail: String(detail || ''), evidence: evidence || [] };
  if (fixHint) out.fixHint = fixHint;
  return out;
}

/** Windows 常见安装位置 */
function windowsInstallCandidates(env) {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.PROGRAMW6432, env.LOCALAPPDATA].filter(Boolean);
  const rels = [
    'Google/Chrome/Application/chrome.exe',
    'Microsoft/Edge/Application/msedge.exe',
    'BraveSoftware/Brave-Browser/Application/brave.exe',
  ];
  const out = [];
  for (const root of roots) for (const rel of rels) out.push(String(root).replace(/[\\/]+$/, '') + '/' + rel);
  return out;
}

/** 类 Unix / macOS 常见安装位置 */
function posixInstallCandidates(platform) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

/**
 * 灯 1：Chromium 系浏览器。先看 PATH 上的白名单名，再看常见安装位置，最后做白名单判定。
 * @returns {{state: string, detail: string, evidence: Array<{cmd: string, out: string}>, fixHint?: string}}
 */
function probeChrome(deps) {
  const pathNames = ['chrome', 'google-chrome', 'msedge', 'brave', 'chromium', 'vivaldi'];
  for (const name of pathNames) {
    const found = deps.which(name);
    if (found && isChromiumExecutable(found)) {
      return { state: 'green', detail: '已找到 Chromium 系浏览器', evidence: [{ cmd: `which ${name}`, out: found }] };
    }
  }

  const installDirs = deps.platform === 'win32' ? windowsInstallCandidates(deps.env) : posixInstallCandidates(deps.platform);
  for (const candidate of installDirs) {
    if (deps.exists(candidate) && isChromiumExecutable(candidate)) {
      return { state: 'green', detail: '已找到 Chromium 系浏览器', evidence: [{ cmd: '安装位置探测', out: candidate }] };
    }
  }

  // 反例说清楚：装了浏览器但 CDP 用不了，比「没装」更让人困惑
  const others = ['firefox', 'safari'].map((n) => deps.which(n)).filter(Boolean);
  const nonChromium = others.find((p) => isNonChromiumExecutable(p));
  if (nonChromium) {
    return {
      state: 'red',
      detail: '只找到 Firefox 等非 Chromium 系浏览器：CDP 录制需要 Chromium 内核',
      evidence: [{ cmd: 'which firefox', out: nonChromium }],
      fixHint: '安装 Chrome / Edge / Brave 后重试',
    };
  }
  return {
    state: 'red',
    detail: '未检测到 Chromium 系浏览器',
    evidence: [{ cmd: 'which chrome', out: '' }],
    fixHint: '安装 Chrome / Edge / Brave 后重试',
  };
}

/**
 * 灯 2：PATH 上的 node（**必须** 走 which；不许拿 `process.execPath` 冒充）。
 * @returns {{state: string, detail: string, evidence: Array<{cmd: string, out: string}>, fixHint?: string}}
 */
function probeNode(deps) {
  const nodePath = deps.which('node');
  if (!nodePath) {
    return {
      state: 'red',
      detail: 'PATH 上找不到 node（应用自带的 Node 不算：部分能力要在用户自己的 Node 上跑）',
      evidence: [{ cmd: 'which node', out: '' }],
      fixHint: '安装 Node.js 22 或更高版本',
    };
  }
  const run = deps.exec(nodePath, ['--version']);
  if (!run || !run.ok) {
    return {
      state: 'red',
      detail: run && run.timedOut ? `node --version 超时（>${PROBE_EXEC_TIMEOUT_MS}ms）` : 'node 无法执行（可能是损坏的安装）',
      evidence: [{ cmd: 'node --version', out: String((run && run.out) || '') }],
      fixHint: '重新安装 Node.js 22 或更高版本',
    };
  }
  const version = String(run.out || '').trim();
  const matched = /v?(\d+)\./.exec(version);
  const major = matched ? Number(matched[1]) : 0;
  if (!major) {
    return { state: 'red', detail: `无法识别 node 版本：${version}`, evidence: [{ cmd: 'node --version', out: version }] };
  }
  if (major < NODE_MIN_MAJOR) {
    return {
      state: 'yellow',
      detail: `node 版本过低（${version}）：需要 Node ≥ ${NODE_MIN_MAJOR}`,
      evidence: [{ cmd: 'node --version', out: version }],
      fixHint: `升级到 Node.js ${NODE_MIN_MAJOR} 或更高版本`,
    };
  }
  return { state: 'green', detail: `node ${version} 可用`, evidence: [{ cmd: 'node --version', out: version }] };
}

/** 找 Playwright 的 jar：只扫工程目录与它的 lib / jars 子目录（不扫全盘） */
function findPlaywrightJar(deps, workspaceDir) {
  const dirs = [];
  if (workspaceDir) dirs.push(workspaceDir, joinPath(workspaceDir, 'lib'), joinPath(workspaceDir, 'jars'));
  const extra = deps.env && deps.env.PM_PLAYWRIGHT_JAR_DIR;
  if (extra) dirs.push(String(extra));
  for (const dir of dirs) {
    const names = deps.readdir(dir) || [];
    const hit = names.find((name) => /^playwright-.*\.jar$/i.test(name));
    if (hit) return joinPath(dir, hit);
  }
  return '';
}

/**
 * 灯 3：JDK + Playwright jar **两级**（缺哪一级要说清，否则用户不知道该装什么）。
 */
function probeJdkJar(deps, workspaceDir) {
  const javac = deps.which('javac');
  const jar = findPlaywrightJar(deps, workspaceDir);
  const evidence = [
    { cmd: 'which javac', out: javac },
    { cmd: '查找 playwright-*.jar', out: jar },
  ];
  if (javac && jar) return { state: 'green', detail: 'JDK 与 Playwright jar 都可用', evidence };
  if (javac && !jar) {
    return { state: 'yellow', detail: '有 JDK，但没找到 playwright-<版本>.jar（Java POM 编译前置）', evidence, fixHint: '把 playwright jar 放到工程目录或其 lib/ 下' };
  }
  if (!javac && jar) {
    return { state: 'yellow', detail: '有 playwright jar，但没有 javac（JRE 不够，需要 JDK）', evidence, fixHint: '安装 JDK 并配好 PATH 上的 javac' };
  }
  return { state: 'red', detail: 'JDK 与 playwright jar 都没有', evidence, fixHint: '安装 JDK 并准备 playwright jar' };
}

/** 灯 4：工程内 `@playwright/test`（没选工程目录 → grey，见 J-6） */
function probePlaywright(deps, workspaceDir) {
  if (!workspaceDir) {
    return { state: 'grey', detail: '未选择工程目录，无法判断', evidence: [{ cmd: '读 node_modules', out: '' }] };
  }
  // RA2-07：判的是**装了 `@playwright/test` 这个包**，不是 `node_modules/@playwright` 目录存在
  // （装了 `@playwright/experimental-utils` 之类的子包就判绿 = 假绿，产出的 *.spec.ts 根本跑不起来）。
  const testPkg = joinPath(workspaceDir, 'node_modules', '@playwright', 'test');
  const exists = typeof deps.exists === 'function' ? deps.exists : () => false;
  if (exists(testPkg)) {
    return { state: 'green', detail: '工程内已安装 @playwright/test', evidence: [{ cmd: '读 node_modules/@playwright/test', out: '@playwright/test' }] };
  }
  return {
    state: 'red',
    detail: '工程内没有 @playwright/test（*.spec.ts 产物执行前置）',
    evidence: [{ cmd: '读 node_modules/@playwright/test', out: '' }],
    fixHint: '在工程里执行 npm i -D @playwright/test',
  };
}

/** 灯 5：工程目录本身（**未选 = grey**，J-6） */
function probeWorkspace(deps, workspaceDir) {
  if (!workspaceDir) {
    return { state: 'grey', detail: '未选择工程目录', evidence: [{ cmd: '工程目录', out: '' }] };
  }
  if (!deps.exists(workspaceDir)) {
    return { state: 'red', detail: '选择的工程目录不存在或无权限访问', evidence: [{ cmd: '工程目录', out: workspaceDir }], fixHint: '重新选择一个有效的工程目录' };
  }
  return { state: 'green', detail: '工程目录可用', evidence: [{ cmd: '工程目录', out: workspaceDir }] };
}

/** 截断为字符串（非字符串 → 空串），供桩内容 / evidence 使用 */
function clipText(value, maxLength) {
  const text = String(value == null ? '' : value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** 给证据与 detail 统一脱敏 + 长度上限 */
function redactAbility(item, ctx) {
  return {
    ...item,
    detail: clipText(redactEvidenceText(item.detail, ctx), MAX_ABILITY_TEXT),
    ...(item.fixHint ? { fixHint: clipText(redactEvidenceText(item.fixHint, ctx), MAX_ABILITY_TEXT) } : {}),
    evidence: (item.evidence || []).slice(0, MAX_STUB_EVIDENCE).map((e) => ({
      cmd: clipText(redactEvidenceText((e && e.cmd) || '', ctx), MAX_EVIDENCE_TEXT),
      out: clipText(redactEvidenceText((e && e.out) || '', ctx), MAX_EVIDENCE_TEXT),
    })),
  };
}

/** 桩数据里的一项：允许写字符串灯态，也允许写对象（部分覆盖） */
/**
 * 桩数据里的一项：允许写字符串灯态，也允许写对象（部分覆盖）。
 *
 * 桩内容来自**本地文件**，但一样是「不可信输入」（谁都能改那个 JSON）：`detail` / `fixHint` /
 * `evidence` 都会进渲染层并被截图外带，所以在这里就截断 + 只留 `{cmd, out}` 两键（SEC-R2-07）。
 */
function normalizeStubAbility(id, raw) {
  const base = ability(id, 'grey', '桩数据未覆盖（PM_RECORD_PROBE_STUB）', []);
  if (typeof raw === 'string') {
    return STATES.includes(raw) ? { ...base, state: raw, detail: '桩数据（PM_RECORD_PROBE_STUB）' } : base;
  }
  if (raw && typeof raw === 'object') {
    const state = STATES.includes(raw.state) ? raw.state : base.state;
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.slice(0, MAX_STUB_EVIDENCE).map((e) => ({
        cmd: clipText(e && e.cmd, MAX_EVIDENCE_TEXT),
        out: clipText(e && e.out, MAX_EVIDENCE_TEXT),
      }))
      : base.evidence;
    return {
      ...base,
      state,
      detail: typeof raw.detail === 'string' ? clipText(raw.detail, MAX_ABILITY_TEXT) : '桩数据（PM_RECORD_PROBE_STUB）',
      evidence,
      ...(typeof raw.fixHint === 'string' ? { fixHint: clipText(raw.fixHint, MAX_ABILITY_TEXT) } : {}),
    };
  }
  return base;
}

/**
 * 读探针桩（J-9）。生效条件写死三条（SEC-R2-07）：
 *   ① 环境变量 `PM_RECORD_PROBE_STUB` 指了一个路径；
 *   ② **非打包版且 `NODE_ENV !== 'production'`**（`detectPackaged` 取不到 electron 时按打包处理）；
 *   ③ 文件 ≤ 64 KB、是合法 JSON、且是**普通对象**（数组 / 标量一律不算）。
 * @returns {object|null}
 */
function readStub(deps) {
  const env = deps.env || {};
  const stubPath = env[STUB_ENV];
  if (!stubPath) return null;
  if (!stubAllowed(deps)) return null; // 打包版 / production 强制忽略：桩永不出现在交付物里
  let text = '';
  try {
    text = deps.readTextFile(String(stubPath));
  } catch {
    return null;
  }
  const body = String(text == null ? '' : text);
  if (body.length > MAX_STUB_BYTES) return null; // 指到 2 GB 文件也不会把主进程拖死
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  try {
    // 只打**文件名**：绝对路径里带用户名，`app.log` 是要被导出的（SEC-R2-08）
    deps.log(`[record-probe] 使用桩数据（${STUB_ENV}=${baseName(String(stubPath))}）：本机能力灯不是真实探测结果`);
  } catch { /* 日志失败不影响探针 */ }
  return parsed;
}

/** 复制一份结果，避免调用方改到缓存里的对象 */
function cloneResult(result) {
  return {
    probedAt: result.probedAt,
    ...(result.stubbed ? { stubbed: true } : {}),
    abilities: result.abilities.map((a) => ({
      ...a,
      evidence: (a.evidence || []).map((e) => ({ ...e })),
    })),
  };
}

/**
 * 探测本机能力（`record:probe` 的数据源）。
 *
 * @param {{workspaceDir?: string, force?: boolean}} [input]
 * @param {object} [overrides] 仅单测注入的依赖替身
 * @returns {{probedAt: string, stubbed?: true, abilities: Array<object>}}
 */
function probeAbilities(input, overrides) {
  const opts = input || {};
  const deps = defaultDeps(overrides);
  const ctx = { homeDir: deps.homeDir, workspaceDir: opts.workspaceDir };
  const probedAt = new Date(deps.now()).toISOString();

  // ① 桩通道优先：生效时**完全不碰真实探针**（否则「反例」会被真实环境里的 chrome 覆盖）
  const stub = readStub(deps);
  if (stub) {
    const abilities = ABILITY_IDS.map((id) => redactAbility(normalizeStubAbility(id, stub[id]), ctx));
    return { probedAt, stubbed: true, abilities };
  }

  // ② 60 s 快照缓存（key = workspaceDir，空串 = 未选目录）
  const key = String(opts.workspaceDir || '');
  const cached = cache.get(key);
  if (cached && !opts.force && deps.now() - cached.at < PROBE_TTL_MS) return cloneResult(cached.result);

  // ③ 真实探测：每盏灯独立 try/catch —— 单灯失败降级成 red，绝不让整个探针抛
  const probes = [
    ['chrome', () => probeChrome(deps)],
    ['node', () => probeNode(deps)],
    ['jdk-jar', () => probeJdkJar(deps, opts.workspaceDir)],
    ['playwright', () => probePlaywright(deps, opts.workspaceDir)],
    ['workspace', () => probeWorkspace(deps, opts.workspaceDir)],
  ];
  const abilities = probes.map(([id, fn]) => {
    let item;
    try {
      item = fn();
    } catch (e) {
      item = ability(id, 'red', `探测异常：${(e && e.message) || e}`, []);
    }
    return redactAbility({ ...item, id, label: LABELS[id] }, ctx);
  });

  const result = { probedAt, abilities };
  cache.set(key, { at: deps.now(), result });
  return cloneResult(result);
}

module.exports = {
  ABILITY_IDS,
  STATES,
  PROBE_TTL_MS,
  PROBE_EXEC_TIMEOUT_MS,
  STUB_ENV,
  NODE_MIN_MAJOR,
  HOME_PLACEHOLDER,
  WORKSPACE_PLACEHOLDER,
  MAX_STUB_BYTES,
  MAX_ABILITY_TEXT,
  MAX_EVIDENCE_TEXT,
  CHROMIUM_EXECUTABLES,
  resetProbeCache,
  isChromiumExecutable,
  redactEvidenceText,
  probeAbilities,
};
