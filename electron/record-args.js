'use strict';

/**
 * record-args.js —— 录制域的**唯一真源**：URL 白名单 / flag 正向白名单 / DevToolsActivePort 解析。
 *
 * 为什么单独一个模块：契约 `[C-114]`（v18）写死「校验真源只有一处」——
 * URL 白名单、flag 白名单、`selector` 形状校验的唯一真源在**本文件**（纯函数 + 单测）；
 * `electron/ipc-record.js`（主进程）与 `electron/record-inject.js`（页内）属**纵深防御**，
 * 不得扩规则、不得放宽；三处不一致时**以本文件为准**。
 *
 * 两条安全口径（对应 `review-sec` 的 SEC-05 / SEC-09）：
 * 1. flag 是**正向白名单**（`ALLOWED_FLAGS` 枚举全集，其余一律拒），不是「黑名单三条」。
 *    本模块只产出 **args 数组**，调用方必须 `spawn(exe, args, { shell: false })`，禁止拼命令行串。
 *    `--user-data-dir` 只由主进程拼（本模块从入参 `userDataDir` 拼，不接受外部 flag）。
 * 2. URL 入库前**必须脱敏**：丢弃 `username` / `password`；query **只在「键在白名单 + 值过值级校验」
 *    时原样保留，任一不合规就整条丢弃**（不留键名、不留 `<redacted>` 占位——键名本身泄露接口形态，
 *    SEC-R2-01/02）；`#fragment` 同口径整段丢弃（`#access_token=…` 是同一类凭据入口，契约
 *    `[C-119]` 第 5 款未列，本模块取更严的一侧——只丢不放宽）。
 * 3. 临时 profile 必须在**应用数据目录下**（拒 UNC / 拒 `..` / 拒越界前缀，SEC-R2-03）。
 *
 * 本文件不 require `electron`，不碰磁盘，可被渲染层单测直接 import（配 `record-args.d.ts`）。
 *
 * @module electron/record-args
 */

/** URL 长度上限（契约 `[C-114]` URL 条：≤ 500 字符） */
const MAX_URL_LENGTH = 500;
/** 只接受这两个 scheme */
const ALLOWED_SCHEMES = ['http:', 'https:'];
/** 显式黑名单：即使 `new URL()` 能解析也要拒（`file://` 读本地文件、`chrome://` 进内部页） */
const DENIED_SCHEMES = [
  'file:',
  'chrome:',
  'devtools:',
  'javascript:',
  'data:',
  'about:',
  'chrome-extension:',
  'view-source:',
  'blob:',
  'filesystem:',
];

/**
 * query 键白名单：只放**取值必定是「枚举值/序号」**、没有凭据语义也没有自由文本的键。
 *
 * ⚠️ 这里刻意**不**放（SEC-R2-01 / P1）：`from`（跳转目标，能夹带整条带 userinfo 的 URL）、
 * `q` / `keyword` / `filter`（自由文本，能夹带手机号/身份证）、`sort` / `view` / `mode`
 * （页面自定义枚举，语义不可控）。契约 `[C-119]` 5② 只允许「无凭据语义」的键，这 7 个是实现自加的。
 *
 * 而且**命中白名单还不够**：值还要过 `isSafeQueryValue()` 的值级校验（长度、嵌套 URL、`@`、
 * 11–19 位纯数字一律拒）。理由：`?page=http://u:p@h/` 这种「白名单键 + 恶意值」同样能把
 * userinfo 拼回已消毒 URL——剥了 userinfo 就以为安全是错的（间接键会把凭据重新引进来）。
 */
const QUERY_WHITELIST = ['page', 'id', 'tab', 'lang', 'locale'];
/** 白名单键值的长度上限（`page=2` / `tab=main` 这类枚举值远用不到 200） */
const MAX_QUERY_VALUE_LENGTH = 200;
/** `record:validate` 入参上限（契约 `[C-114]`：items ≤ 50、selector ≤ 500 字符） */
const MAX_VALIDATE_ITEMS = 50;
const MAX_SELECTOR_LENGTH = 500;
/** `record:validate` 支持的策略（契约 `[C-114]` 入参枚举） */
const VALIDATE_STRATEGIES = ['css', 'xpath', 'text', 'role'];

/**
 * 允许透传的 Chrome flag（**正向白名单**，逐条登记）。
 *
 * 加一条 flag 必须在本表登记并补一条单测；未登记的 flag 一律 `浏览器启动被拦截`。
 * 刻意**不**登记（列出是为了让评审看清这是有意的，不是漏了）：
 * `--no-sandbox` / `--disable-web-security` / `--remote-allow-origins=*` / `--proxy-server` /
 * `--ignore-certificate-errors` / `--load-extension` / `--remote-debugging-address` / `--user-data-dir`，
 * 以及 **`--headless=new`**（RA2-08：无头会话里用户点不到页面，而录制器的全部价值就是真人点击；
 * 探针/校验会话若将来需要无头，按「会话类型」维度另开，不许在录制会话里放行）。
 *
 * @type {Array<{name: string, sample?: string, valuePattern?: RegExp}>}
 */
const ALLOWED_FLAGS = [
  { name: '--disable-gpu' },
  { name: '--mute-audio' },
  { name: '--hide-scrollbars' },
  { name: '--window-size', sample: '1280,800', valuePattern: /^\d{1,4},\d{1,4}$/ },
  { name: '--lang', sample: 'zh-CN', valuePattern: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/ },
];

/** 控制字符（含 NUL / CR / LF）：URL、flag、目录名里出现一律拒，这是参数注入的原料 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 手机号 / 身份证 / 卡号形态：11–19 位纯数字（含 18 位末位 X 的身份证在 URL 里通常是大写 X，单独判） */
const PII_DIGITS = /^\d{11,19}$/;
const PII_ID_CARD = /^\d{17}[\dXx]$/;

/**
 * 白名单键的**值级校验**（SEC-R2-01，P1）。
 *
 * 判据（任一命中即判该值不安全 → 整条 query 丢弃，不做占位）：
 * - 长度 > 200（值本身可能是被塞进来的长文本 / 编码后的整条 URL）；
 * - 含 `://`（嵌套 URL —— `?from=http://u:p@h/` 就是这么把 userinfo 带回来的）；
 * - 含 `@`（userinfo / 邮箱 / 手机号掩码的分隔符）；
 * - 形如 11–19 位纯数字或 18 位身份证（`?q=13800138000`）。
 *
 * @param {string} value 已解码的值
 * @returns {boolean} true = 可以原样保留
 */
function isSafeQueryValue(value) {
  const text = String(value == null ? '' : value);
  if (text.length > MAX_QUERY_VALUE_LENGTH) return false;
  if (text.includes('://')) return false;
  if (text.includes('@')) return false;
  if (PII_DIGITS.test(text)) return false;
  if (PII_ID_CARD.test(text)) return false;
  return true;
}

/**
 * 统一的拒绝形状。`error` 是契约 `[C-114]` 表里的**固定中文文案**（渲染层只按它相等匹配），
 * `detail` 只进日志与排障，不许给界面当判据。
 * @param {string} error
 * @param {string} detail
 * @param {object} [extra]
 */
function deny(error, detail, extra) {
  return Object.assign({ ok: false, error, detail }, extra || {});
}

/**
 * URL 的**安全启动校验**（两个用途共用的一段）：类型 / 空白 / 长度 / `-` 开头 / 控制字符 /
 * scheme 黑名单 / 可解析性 / scheme 白名单 / 主机名。不碰 query 与 fragment。
 *
 * @param {unknown} raw
 * @returns {{ok: boolean, parsed?: URL, error?: string, detail?: string}}
 */
function checkUrlShape(raw) {
  if (typeof raw !== 'string') return deny('URL 不合法', '入参不是字符串');
  const text = raw.trim();
  if (!text) return deny('URL 不合法', '空 URL');
  if (text.length > MAX_URL_LENGTH) return deny('URL 不合法', `超过 ${MAX_URL_LENGTH} 字符`);
  if (text.startsWith('-')) return deny('URL 不合法', '不能以 - 开头（命令行参数注入）');
  if (CONTROL_CHARS.test(text)) return deny('URL 不合法', '含控制字符');

  const lower = text.toLowerCase();
  for (const scheme of DENIED_SCHEMES) {
    if (lower.startsWith(scheme)) return deny('URL 不合法', `拒绝的 scheme：${scheme}`);
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return deny('URL 不合法', '无法解析');
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return deny('URL 不合法', `只接受 http / https，收到 ${parsed.protocol}`);
  }
  if (!parsed.hostname) return deny('URL 不合法', '缺少主机名');
  return { ok: true, parsed };
}

/**
 * **入库用 URL**（v19 / `[C-119]` ⑤）：剥 userinfo、query 白名单 + 值级校验、丢 fragment。
 * 落库 / 审计 / 三产物 / `record:status` 都用这一版的 `baseUrl` 或 `url`。
 *
 * @param {unknown} raw 用户输入
 * @returns {{ok: boolean, error?: string, detail?: string, url?: string, baseUrl?: string,
 *            origin?: string, host?: string, path?: string}}
 */
function urlForStorage(raw) {
  const base = checkUrlShape(raw);
  if (!base.ok) return base;
  const parsed = base.parsed;

  // ① username / password 直接丢弃（不 re-add，下面整段都是重建的）
  // ② query：**只有「键在白名单 + 值过值级校验」才保留原值；任一不合规 → 整条 query 丢弃**。
  //    不做 `token=<redacted>` 这类占位——键名本身泄露接口形态（与 v19 对 #fragment 的口径一致，SEC-R2-02）。
  // ③ #fragment 整段丢弃（v19）。
  let queryKept = true;
  const query = [];
  for (const [key, value] of parsed.searchParams) {
    if (!QUERY_WHITELIST.includes(key) || !isSafeQueryValue(value)) {
      queryKept = false;
      break;
    }
    query.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  if (!queryKept) query.length = 0;

  const origin = parsed.origin;
  const path = parsed.pathname;
  const url = origin + path + (query.length ? '?' + query.join('&') : '');
  return { ok: true, url, baseUrl: origin + path, origin, host: parsed.host, path };
}

/**
 * **启动用 URL**（RA2-03）：只做**安全启动校验**，**保留业务 query 与 fragment**，只剥 `userinfo`。
 *
 * 为什么必须与 `urlForStorage` 分开：`[C-119]`⑤ 的约束对象是「**入库**」，不是「启动」。
 * 拿脱敏后的 URL 去启动 Chrome，带 `?projectCode=` / `?from=` 这类业务参数的被测系统打开的是
 * 一条**坏链接**，录制直接起不来（实现把两件事合二为一踩过的坑）。
 *
 * ⚠️ 返回值**只许进 `spawn` 的参数数组**：禁止回渲染层、禁止入库、禁止进日志/审计
 * （argv 里带业务 token 是已接受的残余风险，见 `[C-114b]`）。
 *
 * @param {unknown} rawUrl 用户输入的原始 URL
 * @returns {{ok: boolean, url?: string, origin?: string, host?: string, error?: string, detail?: string}}
 */
function urlForLaunch(rawUrl) {
  const base = checkUrlShape(rawUrl);
  if (!base.ok) return base;
  const parsed = base.parsed;
  // 只剥凭据：query / fragment / path 原样保留（被测系统要靠它们才能打开正确页面）
  parsed.username = '';
  parsed.password = '';
  return { ok: true, url: parsed.toString(), origin: parsed.origin, host: parsed.host };
}

/**
 * 校验临时 profile 目录（`--user-data-dir` 的值）。
 *
 * 契约 `[C-117]` 第 2 条：**建在应用数据目录下**（不是系统临时目录、不是共享盘，继承应用 ACL、
 * 仅当前用户可读）。profile 里是被测系统的 Cookie / localStorage / 已填表单，落到 `\\share\...`
 * 或同步盘等于外泄（SEC-R2-03）。
 *
 * 四道检查（顺序即报错顺序）：
 *   1. 绝对路径、无控制字符、≤ 260；
 *   2. **拒 UNC**（`\\server\share` / `//server/share`）—— 共享盘；
 *   3. **拒 `..` 段**（归一化前先拒，避免 `record-profiles/../../Windows/Temp` 逃逸）；
 *   4. 给了 `dataDir` 时做**包含性校验**：归一化后必须落在 `dataDir` 之内（不是前缀字符串相等，
 *      `C:/data/pm-evil` 不算 `C:/data/pm` 的子目录）。
 *
 * ⚠️ 没传 `dataDir` 时第 4 道**无法执行**，此时返回值里 `containment: 'skipped'` —— 显式标出来，
 * 不许假装查过（调用方 `buildChromeArgs` 会把 `dataDir` 透传下来；S3 接线见任务回执）。
 *
 * @param {unknown} dir
 * @param {{dataDir?: unknown}} [opts]
 * @returns {{ok: boolean, dir?: string, containment?: 'checked'|'skipped', error?: string, detail?: string}}
 */
function validateUserDataDir(dir, opts = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return deny('浏览器启动被拦截', '缺少临时 profile 目录');
  const text = dir.trim();
  if (CONTROL_CHARS.test(text)) return deny('浏览器启动被拦截', '临时 profile 目录含控制字符');
  if (text.length > 260) return deny('浏览器启动被拦截', '临时 profile 目录过长');
  // UNC：共享盘 / 网络路径
  if (/^[\\/]{2}/.test(text)) return deny('浏览器启动被拦截', '临时 profile 不允许放在网络共享盘（UNC 路径）');
  const absolute = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/');
  if (!absolute) return deny('浏览器启动被拦截', '临时 profile 目录必须是绝对路径');
  // `..` 段：归一化前先拒（`C:/data/record-profiles/../../Windows/Temp` 归一化后就合法了）
  if (text.split(/[\\/]/).some((seg) => seg === '..')) {
    return deny('浏览器启动被拦截', '临时 profile 目录不允许包含 .. 段');
  }
  const normalized = text.replace(/\\/g, '/').replace(/\/+$/, '');

  const dataDir = opts && typeof opts.dataDir === 'string' ? opts.dataDir.trim() : '';
  if (!dataDir) return { ok: true, dir: normalized, containment: 'skipped' };
  const normalizedRoot = dataDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const lowerDir = normalized.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();
  if (lowerDir !== lowerRoot && !lowerDir.startsWith(lowerRoot + '/')) {
    return deny('浏览器启动被拦截', '临时 profile 目录必须位于应用数据目录下');
  }
  return { ok: true, dir: normalized, containment: 'checked' };
}

/**
 * 把一个 flag 字符串匹配到白名单条目；名字对但值不合法也要拒（返回 null）。
 * @param {string} flag
 * @returns {{name: string, sample?: string, valuePattern?: RegExp}|null}
 */
function matchAllowedFlag(flag) {
  for (const spec of ALLOWED_FLAGS) {
    if (!spec.valuePattern) {
      if (flag === spec.name) return spec;
      continue;
    }
    const prefix = spec.name + '=';
    if (!flag.startsWith(prefix)) continue;
    return spec.valuePattern.test(flag.slice(prefix.length)) ? spec : null;
  }
  return null;
}

/**
 * 拼 Chrome 启动参数。**只产出数组**，调用方必须 `spawn(exe, args, { shell: false })`。
 *
 * 导航参数用 **`urlForLaunch`（启动版，保留业务 query/fragment）**，不是脱敏版（RA2-03）。
 *
 * @param {{url: unknown, userDataDir: unknown, flags?: unknown, dataDir?: unknown}} input
 * @returns {{ok: boolean, args?: string[], containment?: 'checked'|'skipped',
 *            error?: string, detail?: string}}
 */
function buildChromeArgs(input) {
  const { url, userDataDir, flags, dataDir } = input || {};

  const launch = urlForLaunch(url);
  if (!launch.ok) return deny(launch.error, launch.detail);

  const dirResult = validateUserDataDir(userDataDir, { dataDir });
  if (!dirResult.ok) return deny(dirResult.error, dirResult.detail);

  if (flags !== undefined && flags !== null && !Array.isArray(flags)) {
    return deny('浏览器启动被拦截', 'flags 必须是数组');
  }
  const extra = [];
  for (const flag of Array.isArray(flags) ? flags : []) {
    if (typeof flag !== 'string') return deny('浏览器启动被拦截', 'flag 必须是字符串');
    if (!flag) return deny('浏览器启动被拦截', '空 flag');
    // args 数组里出现空白（含换行）说明调用方想塞「两个参数」，一律拒
    if (/\s/.test(flag) || CONTROL_CHARS.test(flag)) return deny('浏览器启动被拦截', `flag 含空白或控制字符：${flag}`);
    if (!matchAllowedFlag(flag)) return deny('浏览器启动被拦截', `未登记的浏览器参数：${flag}`);
    extra.push(flag);
  }

  const args = [
    // 契约 [C-117] 第 1 条：端口 0 = 由 Chrome 自己选，禁止「先探空闲端口再传参」（TOCTOU）
    '--remote-debugging-port=0',
    // 契约 [C-117] 第 3 条：--user-data-dir 只由主进程拼，不接受外部 flag
    `--user-data-dir=${dirResult.dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-features=Translate',
    ...extra,
    launch.url,
  ];
  return { ok: true, args, containment: dirResult.containment };
}

/**
 * **`record:validate` 入参校验的唯一真源**（RA2-06：原来落在 `record-session.js`，
 * 与本文件头部「真源在本文件」的声明自相矛盾，两处各写一套）。
 *
 * 判据（契约 `[C-114]`）：`items` 必须是数组、≤ 50 条；每条 `strategy` ∈ 枚举、
 * `selector` 是非空字符串、≤ 500 字符、不含 NUL / CR / LF。
 * 任何一条不合规 → **整批** `入参不合法`（不做部分放行：半批校验会让人以为都校验过了）。
 *
 * @param {unknown} items
 * @returns {{ok: boolean, items?: Array<{strategy: string, selector: string}>, error?: string}}
 */
function validateSelectorItems(items) {
  if (!Array.isArray(items)) return { ok: false, error: '入参不合法' };
  if (items.length > MAX_VALIDATE_ITEMS) return { ok: false, error: '入参不合法' };
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return { ok: false, error: '入参不合法' };
    const strategy = item.strategy;
    const selector = item.selector;
    if (!VALIDATE_STRATEGIES.includes(strategy)) return { ok: false, error: '入参不合法' };
    if (typeof selector !== 'string' || !selector) return { ok: false, error: '入参不合法' };
    if (selector.length > MAX_SELECTOR_LENGTH) return { ok: false, error: '入参不合法' };
    if (/[\u0000\r\n]/.test(selector)) return { ok: false, error: '入参不合法' };
    out.push({ strategy, selector });
  }
  return { ok: true, items: out };
}

/**
 * 解析 profile 目录下的 `DevToolsActivePort`（两行：端口 / devtools 路径）。
 *
 * 契约 `[C-117]` 第 1 条：只用 `--remote-debugging-port=0` + 读这个文件取**第一行的端口**。
 * 第二行的 `/devtools/browser/<id>` 是 **browser 端点**，只挂 `Browser`/`Target`/`SystemInfo` 域，
 * 连它再发 `Runtime.enable` 会回 `-32601`（t18 的 blocker）——所以本函数**只回端口**，
 * 不再拼 `/json/list` 之外的任何可连接地址（目标发现是 `cdp-client` 的唯一职责，契约 v20/v21）。
 *
 * @param {unknown} text 文件内容
 * @returns {{ok: boolean, port?: number, error?: string, detail?: string}}
 */
function parseDevToolsActivePort(text) {
  if (typeof text !== 'string') return deny('启动失败', 'DevToolsActivePort 不是文本');
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return deny('启动失败', 'DevToolsActivePort 不足两行');
  if (!/^\d{1,5}$/.test(lines[0])) return deny('启动失败', '端口不是数字');
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return deny('启动失败', '端口越界');
  const wsPath = lines[1];
  // 只认 `/devtools/<安全字符>`：`..` / `?` / `#` / 空白 / 百分号编码一律拒（SEC-R2-11）。
  // 这三行是 Chrome 自己写的文件，正常形态就是 /devtools/browser/<uuid>，收紧不会误杀。
  // ⚠️ 只做**形状校验**，不把这条路径回给调用方（它指向 browser 端点，连不得）。
  if (!/^\/devtools\/[A-Za-z0-9/_.\-]+$/.test(wsPath)) return deny('启动失败', '第二行不是合法的 devtools 路径');
  if (wsPath.split('/').some((seg) => seg === '..') || /%2e/i.test(wsPath)) return deny('启动失败', '第二行不是合法的 devtools 路径');
  // 只回端口：目标发现（GET /json/list → page target）是 cdp-client 的唯一职责
  return { ok: true, port };
}

module.exports = {
  MAX_URL_LENGTH,
  ALLOWED_SCHEMES,
  DENIED_SCHEMES,
  QUERY_WHITELIST,
  MAX_QUERY_VALUE_LENGTH,
  MAX_VALIDATE_ITEMS,
  MAX_SELECTOR_LENGTH,
  VALIDATE_STRATEGIES,
  ALLOWED_FLAGS,
  checkUrlShape,
  urlForStorage,
  urlForLaunch,
  validateSelectorItems,
  validateUserDataDir,
  matchAllowedFlag,
  buildChromeArgs,
  parseDevToolsActivePort,
};


