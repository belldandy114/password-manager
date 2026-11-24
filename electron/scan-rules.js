'use strict';

/**
 * scan-rules.js —— 代码体检的规则引擎（模块 3，契约 C-52〜C-54）。**纯函数**：
 * 本模块不 require fs / electron，输入是「文件内容 + 相对路径」，输出是命中列表。
 *
 * 三条设计约束（都来自契约）：
 *   1. **只做正则，不做 AST**（与仓库既有约定一致）。因此误报控制靠 `negative` / `requires`
 *      两个前置条件，而不是语法分析。
 *   2. **注释里的代码不算问题**。`// Thread.sleep(3000)` 是说明不是缺陷——注释先被
 *      `stripComments` 抹掉，再拿「只剩代码的那一行」去匹配；但命中行原文（snippet）取自原文件。
 *      字符串内部的 `//`（如 `"https://a"`）不能被当注释截断，所以剥离时带引号状态。
 *   3. **snippet 只留命中行原文并截 200 字符**：扫的是用户私有代码，不能把整段拼出去。
 *
 * 规则分两个包（C-52：同一个通道两个包，不新增通道）：
 *   - `audit`：体检（UI 反模式 / 硬编码敏感 / 弱断言），≤30 条；
 *   - `coverage`：接口覆盖取数，只抽「请求路径原文」作为 `key`，≤8 条。
 */

const path = require('path');

/** 单条规则在一个文件里最多记几条（findings 300 上限的前置约束，避免一个坏文件刷满） */
const MAX_HITS_PER_RULE = 3;
/** snippet 最大长度：只给命中行，且截断 */
const SNIPPET_MAX = 200;

/** `#` 是注释起始的语言（Java/JS 里 `#` 不是注释，别把整行吞掉） */
const HASH_COMMENT_EXTS = /\.(?:py|pyw|sh|bash|zsh|rb|pl|yml|yaml|properties|conf|ini|txt|cfg)$/i;

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * `ui-*`（UI 自动化反模式）**不扫文档**。
 *
 * `.md` / `.txt` 进 `SCAN_EXTS` 的初衷是扫文档里的**硬编码 URL / token**（`sec-*`），
 * 不是把文档当测试代码体检：README 里写「`div > div > div` 这种选择器很脆」是**说明文字**，
 * 报成 `ui-deep-css` 只会让用户觉得工具在胡说（t55 集成验收实测：allure/README.md:230 被误报）。
 * 误报率决定这个功能会不会被用户直接关掉，所以这里按扩展名守卫，而不是靠改正则去凑。
 */
const DOC_FILE_RE = /\.(?:md|txt)$/i;

/**
 * **只体检代码、不体检文档**的规则族（RC-04 / RC-06）。
 *
 * `.md` / `.txt` 进 `SCAN_EXTS` 的初衷是扫文档里的**硬编码 URL / token**（`sec-*`），
 * 不是把文档当测试代码/覆盖证据：
 *   - `ui-*`：README 里写「`div > div > div` 很脆」是说明文字（t58）；
 *   - `assert-*`：文档里写「这条用例以前没有断言」不是缺陷（RC-04）；
 *   - `cov-*`：**危害最大**——文档里的示例路径会被当成「已覆盖」证据，
 *     假 covered 比假 missing 更危险，它让用户以为测过了而漏测（RC-06）。
 * `sec-*` **不在此列**：文档里出现真内网地址/token 必须报，那正是扫文档的目的。
 */
const CODE_ONLY_RULE_RE = /^(?:ui|assert|cov)-/;

/**
 * coverage 规则的 HTTP method 归一：
 *   - 命名组 `method` 有值 → 大写（`.get(` / `requests.post(`）；
 *   - `@XxxMapping` → 注解名大写（`RequestMapping` → ANY）；
 *   - 都拿不到（`.url(` / 纯路径字面量）→ `ANY`。
 * **只做大小写归一，不做路径归一化**——路径归一在渲染层 coverage.ts（契约明文）。
 */
function methodOf(rule, groups) {
  const raw = String((groups && (groups.method || groups.anno)) || '').trim();
  if (!raw) return 'ANY';
  if (/^request$/i.test(raw)) return 'ANY';
  return raw.toUpperCase();
}

/** 规则表（id 一经发布不得改：UI 勾选、历史统计、白名单都按 id 记） */
const RULES = [
  // ---------------- UI 自动化反模式 ----------------
  {
    id: 'ui-hard-sleep',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '硬编码等待',
    desc: '写死 sleep / waitForTimeout，慢机器上偶发失败、快机器上白等。改成显式等待（等元素可见/可点）或轮询条件。',
    pattern: /\b(?:Thread\s*\.\s*sleep|time\s*\.\s*sleep|sleep|waitForTimeout|setTimeout)\s*\(\s*(?:\d|["'`]\d)/,
  },
  {
    id: 'ui-abs-xpath',
    pack: 'audit',
    category: 'ui',
    severity: 'high',
    title: '绝对 XPath',
    desc: '以 /html 开头的绝对路径，页面结构一变就整条失效。改用相对定位（//）或 data-testid。',
    pattern: /["'`]\s*\/html\b/,
  },
  {
    id: 'ui-deep-css',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '深层 CSS 子选择器',
    desc: '三级以上 a > b > c > d 对 DOM 层级高度敏感，加一层包裹就全挂。减少层级，或给关键节点加 data-testid。',
    pattern: /["'`][^"'`]*>[^"'`]*>[^"'`]*>[^"'`]*["'`]/,
  },
  {
    id: 'ui-fragile-locator',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '按下标定位',
    desc: '用 [n] / :nth-child 按下标取元素，列表里插一个节点就会错位。改用 data-testid 或稳定业务属性。',
    pattern: /\[\s*\d+\s*\]|:nth-child\s*\(/,
    requires: /\/\/|By\s*\.|find_element|selector|xpath/i,
    negative: /data-testid|data-test|data-qa/,
  },
  {
    id: 'ui-text-locator',
    pack: 'audit',
    category: 'ui',
    severity: 'low',
    title: '按界面文案定位',
    desc: 'linkText / partialLinkText / By.text 依赖文案，改个字或被翻译就挂。改用 data-testid。',
    pattern: /\b(?:linkText|partialLinkText|By\s*\.\s*text|text\s*=\s*)\s*\(?\s*["'`][^"'`]+["'`]/,
  },

  // ---------------- 硬编码敏感 ----------------
  {
    id: 'sec-hardcoded-url',
    pack: 'audit',
    category: 'secret',
    severity: 'medium',
    title: '硬编码地址',
    desc: '把环境地址写进代码，换环境要改代码、提测/上线容易打错环境。改成配置或 ${变量} 占位。',
    pattern: /https?:\/\/[^\s"'`)]{4,}/i,
    negative: /localhost|127\.0\.0\.1|example\.(?:com|org|net)|https?:\/\/\$\{|https?:\/\/:\d+\/?\$?\{/i,
  },
  {
    id: 'sec-token-literal',
    pack: 'audit',
    category: 'secret',
    severity: 'high',
    title: '硬编码令牌',
    desc: 'token / secret / apiKey 直接写字符串，提交进仓库即泄露。改成从环境变量或密钥管理读取。',
    pattern: /\b(?:token|secret|api[_-]?key|access[_-]?key|app[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'`][^"'`]{8,}["'`]/i,
  },
  {
    id: 'sec-password-literal',
    pack: 'audit',
    category: 'secret',
    severity: 'high',
    title: '硬编码口令',
    desc: 'password / passwd / pwd 写成字面量，等于把测试账号公开。改成参数化或从配置注入。',
    pattern: /\b(?:password|passwd|pwd)\b\s*[:=]\s*["'`][^"'`]{1,}["'`]/i,
  },
  {
    id: 'sec-intranet-ip',
    pack: 'audit',
    category: 'secret',
    severity: 'medium',
    title: '内网 IP 直连',
    desc: '10./192.168./172.16-31. 网段写死在脚本里，换环境即不可用，也会泄露内网拓扑。改用域名或环境变量。',
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
  },

  // ---------------- 弱断言 ----------------
  {
    id: 'assert-status-only',
    pack: 'audit',
    category: 'assert',
    severity: 'high',
    title: '只断言状态码',
    desc: '只看 200 不看响应体，接口返回 {"code":500,"msg":"内部错误"} 也能过。补一条业务字段断言（code/关键数据）。',
    kind: 'file',
    detect: (code) => /assert(?:Equals?|Equal)?\s*\(\s*200\b|\.statusCode\(\)\s*\)?\s*;|status(?:_code)?\s*(?:==|===|,)\s*200\b|expect\([^)]*\bstatus\b[^)]*\)\s*\.\s*toBe\(\s*200/i.test(code)
      && !/\.json(?:Path)?\s*\(|\.body\(\)|\.text\(\)|\bjsonPath\b|\.get(?:String|Int|Boolean|List|JSONObject)\s*\(|\.data\.|\[["'][\w_]+["']\]/i.test(code),
  },
  {
    id: 'assert-truthy-only',
    pack: 'audit',
    category: 'assert',
    severity: 'medium',
    title: '只判真假/非空',
    desc: 'assertTrue(ok) / assertNotNull(x) 只证明「有值」，证明不了「值对」。补上具体字段与取值断言。',
    pattern: /assertTrue\s*\(\s*[\w.$]+(?:\s*\.\s*\w+)*\s*\)|assertNotNull\s*\(|assert\s+[\w.$]+\s+is\s+not\s+None|\.toBeTruthy\(\s*\)/,
    negative: /[=!<>]=|\.json\(|\.body\(|\.get\(|\[["']/,
  },
  {
    id: 'assert-no-assertion',
    pack: 'audit',
    category: 'assert',
    severity: 'high',
    title: '断言缺失',
    desc: '调了接口/打开了页面却一条断言都没有：这条用例永远「通过」，等于没测。至少断一个状态码 + 一个业务字段。',
    kind: 'file',
    // `\bassert\b` 匹配不到 assertEquals/assertThat（后面跟的是单词字符），
    // 而 Java/TestNG/REST Assured 的主力断言恰好就是这两个前缀——用 `assert\w*\s*\(` 覆盖，
    // 再加 Python 的 `assert x == 1` 写法。这条是实跑时抓到的误报，别改回去。
    detect: (code) => /\b(?:requests\.(?:get|post|put|delete)|axios\.(?:get|post|put|delete)|driver\.get|WebDriver|restTemplate\.|given\(\))/i.test(code)
      && !/\bassert\w*\s*\(|\bassert\s+\w|\bexpect\s*\(|\bshould\b/i.test(code),
  },

  // ---------------- 覆盖取数（coverage 包：只抽路径原文） ----------------
  {
    id: 'cov-spring-mapping',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: 'Spring 映射路径',
    desc: '从 @GetMapping/@PostMapping/@RequestMapping 抽 method + 路径原文；方法名取自注解名（RequestMapping 记 ANY），归一化留给渲染层 coverage.ts。',
    coverage: true,
    pattern: /@(?<anno>Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["'`](?<path>[^"'`]+)["'`]/,
  },
  {
    id: 'cov-restassured',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: '链式客户端调用（.get/.post…）',
    desc: 'RestAssured / axios 一类的 .get("/x") 链式调用：从调用的方法名拿到 HTTP method，路径原文照抄。',
    coverage: true,
    pattern: /\.(?<method>get|post|put|delete|patch)\s*\(\s*["'`](?<path>\/[^"'`]*)["'`]/i,
  },
  {
    id: 'cov-python-requests',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: 'Python requests 调用',
    desc: 'requests.get/post/put/delete("…")（含 f""/r""/b"" 前缀），路径可以是绝对 URL 或相对路径。',
    coverage: true,
    pattern: /\brequests\.(?<method>get|post|put|delete|patch)\s*\(\s*[fFrRbB]*["'`](?<path>[^"'`]+)["'`]/i,
  },
  {
    id: 'cov-url-literal',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: '.url("/x") 字面量',
    desc: 'HttpRequest.url("/x") 这类显式设置路径的写法；method 不在这一行，记 ANY。',
    coverage: true,
    pattern: /\.url\s*\(\s*["'`](?<path>[^"'`]+)["'`]/,
  },
  {
    id: 'cov-path-literal',
    pack: 'coverage',
    category: 'coverage',
    severity: 'low',
    title: '路径字面量',
    desc: '兜底：任何形如 "/api/..."、"/rest/..."、"/v1/..." 的字符串都当作候选路径，method 记 ANY。',
    coverage: true,
    pattern: /["'`](?<path>\/(?:api|rest|v\d|open)\/[^"'`\s]*)["'`]/,
  },
];

const PACK_LABELS = { audit: '代码体检', coverage: '接口覆盖取数' };

/** `scan:rules` 直接把它给 UI（纯静态，不触盘） */
const SCAN_PACKS = ['audit', 'coverage'].map((id) => ({
  id,
  label: PACK_LABELS[id],
  rules: RULES.filter((r) => r.pack === id).map((r) => ({
    id: r.id,
    severity: r.severity,
    title: r.title,
    desc: r.desc,
    category: r.category,
    keyFrom: !!r.keyFrom,
  })),
}));

/**
 * 抹掉注释，返回与输入**行数一致**的「只剩代码」的文本行。
 *
 * 为什么不用简单 replace：字符串里的 `//`（`"https://a"`）会被误当注释，
 * 于是「写死的 URL」这条最重要的规则反而永不命中。所以带引号状态 + 块注释 / 三引号文档串状态。
 *
 * @param {string} text
 * @param {string} [filePath] 决定 `#` 是不是注释起始（.py/.yml/.properties 等是，.java/.js 不是）
 * @returns {string[]}
 */
function stripComments(text, filePath) {
  const src = String(text == null ? '' : text);
  const hashIsComment = HASH_COMMENT_EXTS.test(String(filePath || ''));
  const lines = src.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let triple = '';
  for (const raw of lines) {
    let code = '';
    let quote = '';
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i);
        if (end === -1) { i = raw.length; break; }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (triple) {
        const end = raw.indexOf(triple, i);
        if (end === -1) { i = raw.length; break; }
        triple = '';
        i = end + 3;
        continue;
      }
      const ch = raw[i];
      if (quote) {
        code += ch;
        if (ch === '\\') { // 转义字符原样带过
          if (i + 1 < raw.length) { code += raw[i + 1]; i += 2; continue; }
        } else if (ch === quote) {
          quote = '';
        }
        i += 1;
        continue;
      }
      if (raw.startsWith("'''", i) || raw.startsWith('"""', i)) {
        triple = raw.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (raw.startsWith('/*', i)) { inBlock = true; i += 2; continue; }
      if (raw.startsWith('//', i)) break;
      if (hashIsComment && ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) break;
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; code += ch; i += 1; continue; }
      code += ch;
      i += 1;
    }
    out.push(code);
  }
  return out;
}

const ruleOf = (id) => RULES.find((r) => r.id === id) || null;

/** 某个包的规则（给 `scan:rules` 与 UI 勾选列表用） */
function rulesOf(pack) {
  return RULES.filter((r) => r.pack === String(pack || '')).map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    title: r.title,
    desc: r.desc,
    coverage: !!r.coverage,
  }));
}

/**
 * 在**一个文件**上跑规则。
 *
 * @param {string} text 文件全文
 * @param {string} filePath 相对路径（只用来判断注释语法，不读盘）
 * @param {string[]} [ruleIds] 只跑这些规则；缺省/空数组 = 跑全部
 * @returns {{ ok: true, hits: { ruleId: string, severity: string, category: string, title: string,
 *                              line: number, snippet: string, key?: string }[] }}
 *          `line` 为 1-based，`0` 表示整文件级规则；`snippet` 只含该行原文（≤200 字符）
 */
function matchRules(text, filePath, ruleIds) {
  const src = String(text == null ? '' : text);
  const wanted = Array.isArray(ruleIds) && ruleIds.length ? new Set(ruleIds.map(String)) : null;
  const codeLines = stripComments(src, filePath);
  const rawLines = src.split(/\r?\n/);
  const codeText = codeLines.join('\n');

  const hits = [];
  let suppressed = 0; // RC-01：被 MAX_HITS_PER_RULE 折掉的命中条数（必须能回传给用户）
  for (const rule of RULES) {
    if (wanted && !wanted.has(rule.id)) continue;
    // 扩展名守卫：ui-* / assert-* / cov-* 只体检代码，不体检文档（见 CODE_ONLY_RULE_RE 注释）
    if (CODE_ONLY_RULE_RE.test(rule.id) && DOC_FILE_RE.test(String(filePath || ''))) continue;

    if (rule.kind === 'file') {
      if (typeof rule.detect === 'function' && rule.detect(codeText)) {
        hits.push({
          ruleId: rule.id,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          line: 0,
          snippet: '',
        });
      }
      continue;
    }

    let n = 0;
    for (let i = 0; i < codeLines.length; i += 1) {
      const line = codeLines[i];
      if (!line.trim()) continue;
      if (rule.negative && rule.negative.test(line)) continue;
      if (rule.requires && !rule.requires.test(line)) continue;
      const m = rule.pattern.exec(line);
      if (!m) continue;
      // RC-01：超过每规则上限的命中**不能静默消失**——计数并回传，让界面能说「还有 N 条没展示」
      if (n >= MAX_HITS_PER_RULE) {
        suppressed += 1;
        continue;
      }
      const snippet = String(rawLines[i] == null ? '' : rawLines[i]).trim().slice(0, SNIPPET_MAX);
      const hit = {
        ruleId: rule.id,
        severity: rule.severity,
        category: rule.category,
        title: rule.title,
        line: i + 1,
        snippet,
      };
      // coverage 包：契约要求 findings 带 { method, path, file, line }（file 由调用方补）
      if (rule.coverage) {
        const g = m.groups || {};
        hit.method = methodOf(rule, g);
        hit.path = String(g.path || m[1] || '').slice(0, SNIPPET_MAX);
      }
      hits.push(hit);
      n += 1;
    }
  }

  hits.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (a.line - b.line));
  return { ok: true, hits, suppressed };
}

/**
 * root 归属校验（契约 C-16 第 1 条）：`target` 是否落在 `rootReal` 之内。
 *
 * 纯字符串 + path 归一化，**不碰 fs**（realpath 由调用方先做）。
 * 必须按路径分隔符比较：`C:\work\proj-evil` 不能被判成 `C:\work\proj` 的子路径。
 *
 * @param {string} rootReal 已 realpath 过的根目录
 * @param {string} target 待校验路径（可含 `..`，本函数负责归一化）
 * @returns {boolean}
 */
function isInsideRoot(rootReal, target) {
  const r = String(rootReal == null ? '' : rootReal).trim();
  const t = String(target == null ? '' : target).trim();
  if (!r || !t) return false;
  const norm = (p) => {
    let s = path.resolve(p);
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  const nr = norm(r);
  const nt = norm(t);
  if (nt === nr) return true;
  const prefix = nr.endsWith(path.sep) ? nr : nr + path.sep;
  return nt.startsWith(prefix);
}

module.exports = {
  RULES,
  SCAN_PACKS,
  SEVERITY_ORDER,
  MAX_HITS_PER_RULE,
  SNIPPET_MAX,
  ruleOf,
  rulesOf,
  stripComments,
  matchRules,
  isInsideRoot,
};