'use strict';

/**
 * allure-parse.js —— Allure 结果解析（模块 5.1，契约 C-38 / C-39 / C-61〜C-64）。
 *
 * **纯函数**：输入是 `{ name, text }[]`（ipc 层读完文件后传进来），不 require fs / electron，
 * 所以能直接单测；目录遍历、上限钳制、超时都在 `ipc-allure.js`。
 *
 * 三个口径都不许自创（都有人踩过坑）：
 *   1. **flaky（C-38）**：同一用例（fullName）在**本次解析到的 ≥2 条 result** 里既出现过 passed、
 *      又出现过 failed/broken。`runs=1` 的用例**永不判 flaky**；「重试了两次全失败」是**稳定失败**不是 flaky。
 *   2. **聚类（C-39）**：按 `statusDetails.message` 归一（去堆栈、去耗时、去 UUID）后同 key 计数 ≥2 才进
 *      clusters；Top 50、count 降序、同 count 按 key 升序。
 *   3. **skippedFiles（C-63）**：**文件数**（没参与统计的文件，含坏 JSON），与 `skipped`（用例状态数）不同概念。
 *
 * `skippedFiles` 里「归一」的取舍：只去掉**易变**的数字（耗时、UUID、行号、端口），
 * **保留断言里的业务数值**（`expected discount 15.00`）——否则「同一报错聚了 3 次」就退化成
 * 「一堆看不出区别的 #」，聚类就失去意义了。
 */

/** C-62 上限 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_CASES = 2000;
const MAX_CLUSTERS = 50;
const MAX_KEY = 200;            // [C-34] key ≤ 200
const MAX_SAMPLE = 500;         // [C-34] sample / samples 每条 ≤ 500
const MAX_SAMPLES_PER_CLUSTER = 3; // [C-39] samples ≤ 3 条
const MAX_FLAKY = 500;
const MAX_NAME = 300;
const MAX_MESSAGE = 500;

const RESULT_RE = /-result\.json$/i;
const CONTAINER_RE = /-container\.json$/i;
const ENV_RE = /^environment\.(properties|xml)$/i;

const STATUS_ORDER = { failed: 0, broken: 1, skipped: 2, passed: 3 };

/**
 * `truncatedReason` 只允许这 5 个值（`[C-09]` 的 10 值枚举里属于 allure 的子集），
 * **顺序就是优先级**：多类同时触顶只报一个，`timeout > files > file-size > cases > flaky`。
 */
const TRUNCATED_REASONS = Object.freeze(['timeout', 'files', 'file-size', 'cases', 'flaky']);

/**
 * 按优先级挑一个 reason（index 越小优先级越高）。
 *
 * **未知取值视为最低优先级**（`indexOf` 返回 `-1`，比任何合法值都小——
 * 直接用 `indexOf` 比较会让一个拼错的 reason 压过 `timeout`，界面就报了个不存在的截断原因）。
 * RC-03 修的就是这个：未知值排到最后，合法值优先；两个都未知时保留先到的那个。
 */
const rankOfReason = (r) => {
  const i = TRUNCATED_REASONS.indexOf(r);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
};
const pickReason = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return rankOfReason(a) <= rankOfReason(b) ? a : b;
};

const isResultFile = (name) => RESULT_RE.test(String(name || ''));
const isContainerFile = (name) => CONTAINER_RE.test(String(name || ''));
const isEnvFile = (name) => ENV_RE.test(String(name || ''));

/**
 * 归一失败消息，**只用于聚类 key**（契约 `[C-39]` v12）。
 *
 * 一句话：**`key` 表达模式，不表达实例**。
 *   - 抹掉**所有数字**——含业务数值（`15.00` / `10`）：`expected discount 15.00 but was 10` 与
 *     `expected discount 20.00 but was 12` 是同一个 bug 的不同数据表现，按值拆开就违背聚类目的；
 *   - 去堆栈、去耗时/时间戳、去 UUID/长哈希；
 *   - **三类语义记号必须保留**（换一个值就换了一类根因）：URL 主机名+端口、文件扩展名、HTTP 状态码。
 *
 * 诊断信息不靠 key 承载——clusters 里的 `sample` / `samples` 存的是**未归一原文**。
 * 别再按「保留业务值才有诊断价值」改回去（契约 §C-39 已写明这条来由）。
 *
 * @param {string} msg
 * @returns {string}
 */
function normalizeMessage(msg) {
  const src = String(msg == null ? '' : msg);
  // ① 去堆栈：`at ...` / `... 23 more` 整行丢弃，只留 message 本体
  let s = src.split(/\r?\n/).filter((line) => !/^\s*(?:at\s|\.\.\.\s*\d+\s+more)/.test(line)).join('\n');

  // ② 三类语义记号先「寄存」起来，最后原样放回（占位符不含数字，不会被后续抹数字吃掉）
  const kept = [];
  const stash = (text) => {
    kept.push(text);
    return `\uE000${String.fromCharCode(0xE100 + kept.length - 1)}\uE001`;
  };
  // URL / 主机名（含端口）：`https://api.pay.example.com:8080`、`api.pay.example.com:9090`、`report.csv`
  s = s.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?/gi, (m) => stash(m));
  // ③ 耗时**先于**状态码处理：`after 3000 ms` / `100 ms` 里的三位数不是状态码，
  //    否则 `100 ms`→`100`、`200 ms`→`200` 会被当成 HTTP 状态码保护起来，同一个超时错误被拆成好几簇
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(ms|millis|毫秒|s|sec|secs|seconds|秒)\b/gi, (_m, _n, unit) => `# ${unit}`);

  // ④ HTTP 状态码：独立的 3 位数字（100–599），如 401 / 500 / 503
  s = s.replace(/(?<![\w.])[1-5]\d{2}(?![\w.])/g, (m) => stash(m));

  // ⑤ 去时间戳 / UUID / 长哈希
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, '#');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#');
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, '#');

  // ⑥ 其余所有数字（整数/小数/百分比/金额/条数/序号）一律抹成 #
  s = s.replace(/\d+(?:[.,]\d+)*%?/g, '#');

  // ⑦ 放回语义记号
  s = s.replace(/\uE000([\uE100-\uEFFF])\uE001/g, (_m, ch) => kept[ch.charCodeAt(0) - 0xE100] || '');

  // ⑧ 空白折叠
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/** 解析 properties / xml 两种 environment（C-61：不引 XML 解析器，只取 key/value） */
function parseEnvironment(name, text) {
  const out = {};
  const src = String(text == null ? '' : text);
  if (/\.xml$/i.test(String(name || ''))) {
    const re = /<parameter>\s*<key>([\s\S]*?)<\/key>\s*<value>([\s\S]*?)<\/value>\s*<\/parameter>/gi;
    let m = re.exec(src);
    while (m) {
      out[m[1].trim()] = m[2].trim();
      m = re.exec(src);
    }
    return out;
  }
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** 空结果的统一形状（失败/空目录都用它，保证字段齐全） */
function emptyResult(extra) {
  return {
    ok: false,
    total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, retries: 0,
    cases: [], flaky: [], environment: {}, clusters: [],
    skippedFiles: 0, truncated: false,
    ...extra,
  };
}

/**
 * 解析一目录的 Allure 结果。
 *
 * @param {{ name: string, text: string }[]} files ipc 层读到的文件（只传 result/container/environment 即可）
 * @param {{ maxFiles?: number, maxCases?: number, skippedFiles?: number }} [opts]
 *        `skippedFiles`：ipc 层**没有**传进来的文件数（附件等），会加进返回值
 * @returns {{
 *   ok: boolean, error?: string,
 *   total: number, passed: number, failed: number, broken: number, skipped: number, retries: number,
 *   cases: { name: string, fullName: string, status: string, durationMs: number, retries: number,
 *            runs: number, pass: number, fail: number, flaky: boolean, message?: string }[],
 *   flaky: { name: string, fullName: string, runs: number, pass: number, fail: number }[],
 *   environment: Record<string, string>,
 *   clusters: { key: string, count: number, cases: string[] }[],
 *   skippedFiles: number, truncated: boolean, truncatedReason?: string
 * }}
 */
function parseAllure(files, opts = {}) {
  const list = Array.isArray(files) ? files : [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxFiles = Math.max(1, Math.min(Number(o.maxFiles) || MAX_FILES, MAX_FILES));
  const maxCases = Math.max(1, Math.min(Number(o.maxCases) || MAX_CASES, MAX_CASES));

  let skippedFiles = Math.max(0, Number(o.skippedFiles) || 0);
  let truncated = false;
  let truncatedReason = '';

  const markTruncated = (reason) => { truncated = true; truncatedReason = pickReason(truncatedReason, reason); };

  const environment = {};
  const byCase = new Map(); // fullName → { entries[] }
  let resultsSeen = 0;
  let resultsUsed = 0;

  for (const f of list) {
    const name = String((f && f.name) || '');
    const text = String((f && f.text) || '');
    if (isEnvFile(name)) {
      Object.assign(environment, parseEnvironment(name, text));
      continue;
    }
    if (isContainerFile(name)) continue; // C-61：只用于识别重跑，本轮不参与统计
    if (!isResultFile(name)) { skippedFiles += 1; continue; } // C-61：附件/HTML 一律不读

    resultsSeen += 1;
    if (resultsSeen > maxFiles) { markTruncated('files'); break; }
    if (text.length > MAX_FILE_BYTES) { skippedFiles += 1; markTruncated('file-size'); continue; }

    let j;
    try {
      j = JSON.parse(text);
    } catch {
      skippedFiles += 1; // C-63：坏文件计入同一个计数，不另开字段
      continue;
    }
    const fullName = String((j && (j.fullName || j.name)) || '').trim();
    const status = String((j && j.status) || '').trim();
    if (!fullName || !status) { skippedFiles += 1; continue; }

    resultsUsed += 1;
    const start = Number(j.start) || 0;
    const stop = Number(j.stop) || 0;
    const entry = {
      status,
      durationMs: start && stop && stop > start ? stop - start : 0,
      message: String((j.statusDetails && j.statusDetails.message) || '').trim(),
      fullName,
      shortName: String(j.name || fullName.split('.').pop() || '').trim(),
    };
    if (!byCase.has(fullName)) byCase.set(fullName, []);
    byCase.get(fullName).push(entry);
  }

  if (!resultsUsed) {
    return emptyResult({
      error: '不是 allure-results 目录（未找到 *-result.json）',
      skippedFiles,
      truncated,
      ...(truncatedReason ? { truncatedReason } : {}),
    });
  }

  // 计数（结果级，不是用例级：同一条用例重试两次就是两条 result）
  let passed = 0; let failed = 0; let broken = 0; let skipped = 0; let retries = 0;
  const cases = [];
  const flaky = [];
  const clusterMap = new Map();

  for (const [fullName, entries] of byCase) {
    const runs = entries.length;
    let pass = 0; let fail = 0;
    for (const e of entries) {
      if (e.status === 'passed') { pass += 1; passed += 1; }
      else if (e.status === 'failed') { fail += 1; failed += 1; }
      else if (e.status === 'broken') { fail += 1; broken += 1; } // broken 计入「不通过」，供 flaky 判定
      else if (e.status === 'skipped') { skipped += 1; }
    }
    retries += Math.max(0, runs - 1);
    // C-38：runs ≥2 且 既 pass 过、又不通过过 → flaky；runs=1 永不 flaky
    const isFlaky = runs >= 2 && pass > 0 && fail > 0;
    const last = entries[entries.length - 1];
    const c = {
      name: String(last.shortName || '').slice(0, MAX_NAME),
      fullName: fullName.slice(0, MAX_NAME),
      status: last.status,
      durationMs: last.durationMs,
      retries: Math.max(0, runs - 1),
      runs,
      pass,
      fail,
      flaky: isFlaky,
    };
    const msg = entries.map((e) => e.message).filter(Boolean).sort((a, b) => b.length - a.length)[0];
    if (msg) c.message = msg.slice(0, MAX_MESSAGE);
    cases.push(c);

    if (isFlaky && flaky.length < MAX_FLAKY) {
      flaky.push({ name: c.name, fullName: c.fullName, runs, pass, fail });
    } else if (isFlaky) {
      markTruncated('flaky');
    }

    // 聚类只统计「不通过」的 result
    for (const e of entries) {
      if (e.status !== 'failed' && e.status !== 'broken') continue;
      if (!e.message) continue;
      const key = normalizeMessage(e.message).slice(0, MAX_KEY);
      if (!key) continue;
      if (!clusterMap.has(key)) clusterMap.set(key, []);
      clusterMap.get(key).push(String(e.message).slice(0, MAX_SAMPLE)); // 存原文（未归一），给 sample/samples 用
    }
  }

  // C-64：cases 按状态降序（failed→broken→skipped→passed）、同状态按 fullName 升序
  cases.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));

  let casesOut = cases;
  if (cases.length > maxCases) {
    casesOut = cases.slice(0, maxCases);
    markTruncated('cases');
  }

  // sample = 该簇里出现次数最多的原文（同次数按文本升序，保证确定性 [C-10]）
  // samples = 最多 3 条**不同**原文（同排序规则），用来看「确实是同一类不同值」或发现 key 抹过头
  const summarize = (raws) => {
    const freq = new Map();
    for (const r of raws) freq.set(r, (freq.get(r) || 0) + 1);
    const ordered = [...freq.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([text]) => text);
    return { sample: ordered[0] || '', samples: ordered.slice(0, MAX_SAMPLES_PER_CLUSTER) };
  };

  const clusters = [...clusterMap.entries()]
    .filter(([, cs]) => cs.length >= 2) // C-39：同 key 计数 ≥2 才进 clusters
    .map(([key, cs]) => ({ key, count: cs.length, ...summarize(cs) }))
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, MAX_CLUSTERS);

  const total = resultsUsed;
  return {
    ok: true,
    total,
    passed,
    failed,
    broken,
    skipped,
    retries,
    cases: casesOut,
    flaky,
    environment,
    clusters,
    skippedFiles,
    truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  };
}

module.exports = {
  parseAllure,
  normalizeMessage,
  parseEnvironment,
  isResultFile,
  isContainerFile,
  isEnvFile,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_CASES,
  MAX_CLUSTERS,
  MAX_FLAKY,
  MAX_KEY,
  MAX_SAMPLE,
  MAX_SAMPLES_PER_CLUSTER,
  TRUNCATED_REASONS,
  rankOfReason,
  pickReason,
};