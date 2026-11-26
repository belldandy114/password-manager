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
 * 规则只有**一个包**（C-52 原本两个包共用 `scan:rules` 通道）：
 *   - `audit`：体检（UI 反模式 / 硬编码敏感 / 弱断言），≤30 条。
 *
 * 1.36.0：`coverage` 包（接口覆盖取数，5 条 `cov-*`）随「资产台账下线」整块删除。
 * 注意本文件里另有两处名字带 coverage 但**不是**规则包，别一起删：
 *   ① `SKIP_DIRS` 的 `coverage/`（`scan-collect.js`）是覆盖率工具的**目录**守卫；
 *   ② `src/components/codeaudit/scanModel.ts` 的 `coverageCut` 是截断告警。
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
 * 不是把文档当测试代码：
 *   - `ui-*`：README 里写「`div > div > div` 很脆」是说明文字（t58）；
 *   - `assert-*`：文档里写「这条用例以前没有断言」不是缺陷（RC-04）。
 * `sec-*` **不在此列**：文档里出现真内网地址/token 必须报，那正是扫文档的目的。
 */
const CODE_ONLY_RULE_RE = /^(?:ui|assert)-/;

/**
 * 「这段代码算不算测试代码」——W8 新增规则的前置条件（口径 §4.2）。
 *
 * 为什么必须加：新一批规则查的是**测试代码**里的反模式，而同一写法在应用代码里往往是合法的——
 * `try { fs.closeSync(fd) } catch {}`（关不掉就让 GC）、`Math.random()` 生成 id、`System.out` 打日志。
 * 本仓库实测（704 文件）：不加作用域时 `assert-swallow-catch` 命中 **139** 个文件、
 * `ui-print-instead-of-log` **115**、`assert-random-no-seed` **23**；加作用域后 **1 / 2 / 0**。
 * 误报率决定用户会不会把整类规则关掉，所以这里跟 `CODE_ONLY_RULE_RE` 一样按**前置条件**挡，
 * 而不是靠改正则去凑。
 *
 * 两个条件**同时**成立才算测试代码，避免把 `src/app.js` 里恰好有 `it(` 字符串的东西算进去：
 *   1. **内容**像测试（`@Test` / `describe(` / `it(` / `def test_` / `public void testXxx(`）；
 *   2. **路径**像测试（`test/`、`tests/`、`__tests__/`、`spec/`、`*.test.*`、`*.spec.*`、`*Test.java`）。
 *
 * 已知取舍：不在测试目录、文件名也不带 Test 的用例文件会漏报。这是**有意**的（漏报 < 误报），
 * 规则 `desc` 里已写明，用户看到「没报」时知道是作用域挡的。
 */
const TESTISH_RE = /(?:@Test\b|@Before|@After|@ParameterizedTest|describe\s*\.?\s*\w*\s*\(|\bit\s*\.?\s*\w*\s*\(|\btest\s*\.?\s*\w*\s*\(|\bdef\s+test_|public\s+void\s+test\w+\s*\()/;
const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec)\/|[./](?:test|spec)\.\w+$|Test\.java$/i;

/**
 * 判定「这份文件是不是测试代码」。
 *
 * **每个文件只调一次**（`matchRules` 里算好后放进 ctx 传给所有规则）——
 * file 级规则要跑整文件正则，一条规则扫一遍 1 MB 文件就是浪费。
 *
 * @param {string} codeText 去掉注释后的全文
 * @param {string} filePath 相对路径（POSIX 分隔符；容忍反斜杠）
 * @returns {boolean}
 */
function isTestCode(codeText, filePath) {
  const code = String(codeText == null ? '' : codeText);
  const rel = String(filePath == null ? '' : filePath).replace(/\\/g, '/');
  return TESTISH_RE.test(code) && TEST_PATH_RE.test(rel);
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
  {
    id: 'ui-driver-no-quit',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '浏览器驱动未释放',
    desc: '建了 WebDriver 却看不到 quit()/close()：僵尸 chromedriver 进程会越积越多，几轮后端口和内存吃光，表现成「换台机器就好了」的偶发失败。在 @AfterMethod / afterAll 里释放；驱动在基类释放的，继承 BaseTest 即可不报。',
    kind: 'file',
    detect: (code, ctx) => !!ctx && ctx.isTest
      && /new\s+(?:Chrome|Firefox|Edge|Safari)Driver\s*\(|webdriver\.(?:Chrome|Firefox)\s*\(/.test(code)
      && !/\.quit\s*\(|\.dispose\s*\(|driver\s*\.\s*close\s*\(/i.test(code)
      && !/extends\s+\w*(?:Base|BaseTest|AbstractTest)\b/.test(code),
  },
  {
    id: 'ui-no-timeout',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: '缺显式超时',
    desc: '文件里发请求却看不到任何超时配置：服务端挂住时用例会无限等，CI 上表现为「卡住不退出」，比失败更难查。给 .timeout() / readTimeout / connectTimeout；超时若配在基类或全局，本条会误报，可以关掉。',
    kind: 'file',
    detect: (code, ctx) => !!ctx && ctx.isTest
      && /\b(?:given\s*\(\s*\)|restTemplate\.|requests\.(?:get|post|put|delete)\s*\(|axios\.(?:get|post|put|delete)\s*\(|fetch\s*\()/.test(code)
      && !/\btimeout\b|\.timeout\s*\(|readTimeout|connectTimeout|Duration\.of|page\.setDefaultTimeout/i.test(code),
  },
  {
    id: 'ui-url-concat-param',
    pack: 'audit',
    category: 'ui',
    severity: 'medium',
    title: 'URL 拼接未编码',
    desc: '把变量直接拼进 query 串（"?q=" + kw）：只要值里带 & / 空格 / 中文，参数语义就变了，用例本身写错却报在接口上。用 URLEncoder.encode / encodeURIComponent / queryParam。',
    // 只在「像测试代码」的文件里报：工具产物里的字符串拼接（coverage/prettify.js 那种）是误报
    testOnly: true,
    pattern: /["'`][^"'`]*\?(?:\w+=)?[^"'`]*["'`]\s*\+\s*[A-Za-z_$]|\+\s*["'`]&[^"'`]*["'`]/,
    negative: /encodeURI|URLEncoder|URLSearchParams|urlencode|UriComponentsBuilder/,
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
  {
    id: 'assert-swallow-catch',
    pack: 'audit',
    category: 'assert',
    severity: 'high',
    title: '吞异常',
    desc: '空 catch / 只 printStackTrace：异常没转成失败，这条用例永远绿——比报错危险得多。改成 throw / fail(e) 或至少断言失败。应用代码里的空 catch 不算（本规则只在测试代码里跑）。',
    kind: 'file',
    detect: (code, ctx) => !!ctx && ctx.isTest
      && /catch\s*(?:\([^)]*\))?\s*\{\s*\}|catch\s*(?:\([^)]*\))?\s*\{\s*[\w.]+\s*\.\s*printStackTrace\s*\([^)]*\)\s*;?\s*\}/.test(code),
  },
  {
    id: 'assert-random-no-seed',
    pack: 'audit',
    category: 'assert',
    severity: 'medium',
    title: '随机数据未固定种子',
    desc: '每次跑的数据都不同，失败无法复现——「昨天红了今天绿」只能靠重跑碰运气。用固定种子（new Random(42) / setSeed / random.seed）或固定的样例数据。',
    testOnly: true,
    pattern: /new\s+Random\s*\(\s*\)|Math\.random\s*\(\s*\)|\brandom\.(?:random|randint|choice|uniform)\s*\(/,
    negative: /seed\s*\(|setSeed|new\s+Random\s*\(\s*\d+\s*\)/,
  },
  {
    id: 'assert-json-string-compare',
    pack: 'audit',
    category: 'assert',
    severity: 'medium',
    title: 'JSON 用字符串比较',
    desc: '把整个响应体当字符串断言：字段顺序、空格、数字/字符串差异都会让它红，真出问题时又说不清哪个字段不对。用 jsonPath / JSON.parse 后逐字段断言。',
    testOnly: true,
    // `\{\s*\\` 里的反斜杠是实跑抓出来的：少了它就命中 `toBe('{{nope}}')` 这类模板串（纯误报）
    pattern: /(?:assertEquals?|assertThat|toBe|toEqual|assertEqual)\s*\([^)\n]*["'`]\{\s*\\/,
    negative: /jsonPath|JSON\.parse|\.json\b|jsonDecode/i,
  },
  {
    id: 'assert-skip-leftover',
    pack: 'audit',
    category: 'assert',
    severity: 'medium',
    title: '用例被静默跳过',
    desc: '@Ignore / @Disabled / enabled=false / it.skip / it.only 留在提交里：覆盖率虚高，没人知道这条根本没跑。有意跳过请补 reason 并加白名单；只留了 .only 的还会让整条套件只跑一条。',
    testOnly: true,
    // `enabled = false` 必须限定在注解括号内：普通属性赋值（clipHistory.test.ts:46）是误报
    pattern: /@\w+\s*\([^)]*enabled\s*=\s*false|@Ignore\b|@Disabled\b|\b(?:it|test|describe|suite)\.(?:skip|only)\s*\(|pytest\.mark\.skip/,
  },
];

const PACK_LABELS = { audit: '代码体检' };

/** `scan:rules` 直接把它给 UI（纯静态，不触盘） */
const SCAN_PACKS = ['audit'].map((id) => ({
  id,
  label: PACK_LABELS[id],
  rules: RULES.filter((r) => r.pack === id).map((r) => ({
    id: r.id,
    severity: r.severity,
    title: r.title,
    desc: r.desc,
    category: r.category,
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
  }));
}

/**
 * 在**一个文件**上跑规则。
 *
 * @param {string} text 文件全文
 * @param {string} filePath 相对路径（只用来判断注释语法，不读盘）
 * @param {string[]} [ruleIds] 只跑这些规则；缺省/空数组 = 跑全部
 * @returns {{ ok: true, hits: { ruleId: string, severity: string, category: string, title: string,
 *                              line: number, snippet: string }[],
 *             suppressed: number }}
 *          `line` 为 1-based，`0` 表示整文件级规则；`snippet` 只含该行原文（≤200 字符）。
 *          **`suppressed`** = 被 `MAX_HITS_PER_RULE`（每规则 3 条/文件）折叠掉、没有出现在 `hits` 里的条数；
 *          运行时**总会给**（无折叠时为 0），调用方要把它累加进 `scan:run` 的 `data.suppressed` 并置
 *          `truncatedReason: 'suppressed'`（RC-01：折叠必须可见；v16 起它与 `'findings'` 是两件事）。
 */
function matchRules(text, filePath, ruleIds) {
  const src = String(text == null ? '' : text);
  const wanted = Array.isArray(ruleIds) && ruleIds.length ? new Set(ruleIds.map(String)) : null;
  const codeLines = stripComments(src, filePath);
  const rawLines = src.split(/\r?\n/);
  const codeText = codeLines.join('\n');
  // W8：测试作用域**只算一次**，所有规则共享（口径 §4.2）。
  // 别让每条 file 级规则各自再扫一遍全文——1 MB 文件上那是成倍的浪费。
  const ctx = { isTest: isTestCode(codeText, filePath), filePath: String(filePath || '') };

  const hits = [];
  let suppressed = 0; // RC-01：被 MAX_HITS_PER_RULE 折掉的命中条数（必须能回传给用户）
  for (const rule of RULES) {
    if (wanted && !wanted.has(rule.id)) continue;
    // 扩展名守卫：ui-* / assert-* 只体检代码，不体检文档（见 CODE_ONLY_RULE_RE 注释）
    if (CODE_ONLY_RULE_RE.test(rule.id) && DOC_FILE_RE.test(String(filePath || ''))) continue;
    // 测试作用域守卫（W8）：行级规则里的「只在测试代码里才算缺陷」那批
    if (rule.testOnly && !ctx.isTest) continue;

    if (rule.kind === 'file') {
      if (typeof rule.detect === 'function' && rule.detect(codeText, ctx)) {
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
  isTestCode,
  matchRules,
  isInsideRoot,
};
