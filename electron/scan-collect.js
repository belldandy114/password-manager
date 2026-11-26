'use strict';

/**
 * scan-collect.js —— 扫描结果的「收集 + 截断原因分流」（契约 C-09 / C-29 / C-30 / C-53 的 v16 口径）。
 *
 * **纯函数模块**：不 require fs / electron，输入是命中数组与原因字符串，输出是 finding 列表与计数。
 * ipc-scan.js 只保留「遍历目录 + 读文件」（IO），这里只做状态机，因此可以被单测直接锁住。
 *
 * 为什么值得单独一个模块（v16 修的两件事）：
 *   1. **原因优先级**：`truncatedReason` 只能装一个值，一次扫描却可能同时撞上几个原因。
 *      旧实现是「先到先得」（`if (!truncatedReason) truncatedReason = reason`），先遇到的**折叠**
 *      会把后来的 **timeout** 盖掉，界面报的截断原因是假的。现在照 `electron/allure-parse.js:52-60`
 *      的 `rankOfReason` 取优先级最高的一个；未知取值按**最低**优先级处理（否则一个拼错的原因
 *      会压过 timeout，界面就报了个不存在的值）。
 *   2. **明细 / 总数分离**：明细最多 2000 条，到顶后**不停扫描**，只累加 `totalFindings` 与 `counts`。
 *      于是「到底命中多少」变成算得出来的数，而不是「物理上不可知」。
 *
 * 三条可断言不变量（C-30 v16）：
 *   ① `counts.high + counts.medium + counts.low === totalFindings`
 *   ② `findings.length <= totalFindings`（未到明细上限时两者相等）
 *   ③ 折叠只置 `suppressed`；`findings` 只表示明细被砍
 */

/**
 * `truncatedReason` 允许的取值，**数组顺序就是优先级**（C-09 v16 队长裁决）：
 * `timeout > max-files > depth > file-size > suppressed > findings`。
 */
const TRUNCATED_REASONS = Object.freeze([
  'timeout',
  'max-files',
  'depth',
  'file-size',
  'suppressed',
  'findings',
]);

/** 单次扫描**明细**上限（C-53 v16；落库上限另算，是渲染层的 SCAN_HISTORY_FINDINGS_CAP = 300） */
const FINDINGS_DETAIL_CAP = 2000;

/** 合法 severity 三档（C-30 v14：只有三级，别新增第四级） */
const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/**
 * 压缩/打包产物路径（C-54 v16 污染源守卫）：命中的文件**不进统计**（既不计数、也不留 fileList）。
 *
 * 实测理由：本仓库 `run/resources/app.asar.unpacked/` 下的 `exceljs.min-*.js` 单文件耗 80 ms，
 * `Math.random` / `console.log` 上百处；这些命中的 `snippet` 是压缩后的一行，截到 200 字符也没法读，
 * 属于「报了也没用」。注意 `coverage/` 是**目录**级跳过（`ipc-scan.js` 的 `SKIP_DIRS`），不在这里。
 */
const ARTIFACT_PATH_RE = /\.min\.|\.bundle\.|app\.asar\.unpacked/i;

/** 该路径是不是压缩/打包产物（纯字符串，不碰盘） */
function isArtifactPath(filePath) {
  return ARTIFACT_PATH_RE.test(String(filePath == null ? '' : filePath));
}

/**
 * C-54：遍历必须跳过的目录名。
 *
 * v16 增补 `coverage`（覆盖率工具产物）：本仓库实测 `coverage/prettify.js` 会被
 * `ui-url-concat-param` 命中，而那是一条压缩过的工具代码，报了也没用。
 *
 * 放在这个纯函数模块里（而不是 `ipc-scan.js`），是为了让「哪些目录被跳过」可被单测直接断言
 * （第 1 轮评审 S-03：跳过必须可见；R-05：常量不许两侧各写一份）。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'release', 'build', 'target', '.venv', 'vendor', 'out', 'coverage',
]);

/** 单次扫描的固定上限（契约 C-53 v16；ipc-scan 从这里取，渲染层文案由门禁测试对账） */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_DEPTH = 12;
const SCAN_TIMEOUT_MS = 60000;

/**
 * 守卫计数器（第 1 轮评审 S-03：**跳过也必须可见**）。
 *
 * `coverage` 目录跳过与 `.min./.bundle./app.asar.unpacked` 文件守卫在 v16 是静默生效的：
 * 结果里只有 `skippedSymlinks`，用户读到「0 命中」会误判仓库干净，而 `sec-*` 若正好落在
 * 被挡掉的产物里就永远不会报。C-09「禁止静默截断」是同一个原则，所以这里回传
 * `skippedByGuard`（照 `skippedSymlinks` 的做法）。
 *
 * **计数单位是「条目」**：目录守卫每跳过一个目录计 1，产物 negative 每跳过一个文件计 1。
 * 目录内部的文件**不递归统计**——为了报一个数字去遍历 `node_modules` 会把 60 s 预算吃光，
 * 而且那个数对用户没有意义（他要判断的是「有没有东西没扫」，不是「node_modules 里有多少文件」）。
 *
 * @param {{ skipDirs?: Set<string> }} [opts]
 */
function createScanGuards(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const skipDirs = options.skipDirs instanceof Set ? options.skipDirs : SKIP_DIRS;
  let skipped = 0;

  /** @returns {boolean} true = 这个目录被守卫跳过（并已计数） */
  const skipDir = (name) => {
    if (!skipDirs.has(String(name))) return false;
    skipped += 1;
    return true;
  };

  /** @returns {boolean} true = 这个文件是产物、被 negative 挡掉（并已计数） */
  const skipFile = (relPath) => {
    if (!isArtifactPath(relPath)) return false;
    skipped += 1;
    return true;
  };

  return {
    skipDir,
    skipFile,
    count: () => skipped,
    /** 直接可摊进 `scan:run` 的 data：字段名逐字是 `skippedByGuard` */
    snapshot: () => ({ skippedByGuard: skipped }),
  };
}

/** 原因优先级：index 越小越优先；**未知取值排到最后**（`indexOf` 的 -1 会让它压过 timeout） */
function rankOfReason(reason) {
  const i = TRUNCATED_REASONS.indexOf(String(reason || ''));
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

/**
 * 在两个候选原因里取优先级更高的一个（C-09 v16）。
 *
 * - 任一为空 → 取另一个；两个都空 → `''`（调用方据此决定不带 `truncatedReason` 字段）；
 * - 两个都未知 → 保留先到的那个（确定性，C-10）。
 */
function pickReason(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return rankOfReason(a) <= rankOfReason(b) ? a : b;
}

/** severity 窄化：只认三档，认不出的一律按最低档 `low`（保证不变量①，C-30 v14） */
function normalizeSeverity(severity) {
  const s = String(severity == null ? '' : severity).toLowerCase();
  return SEVERITIES.indexOf(s) >= 0 ? s : 'low';
}

/** 明细上限 clamp：缺省 2000，非法值不许把明细关成 0 条（C-08：实现必须自己 clamp） */
function clampMaxFindings(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return FINDINGS_DETAIL_CAP;
  return Math.max(1, Math.floor(n));
}

/**
 * 建一个收集器（一次扫描一个；不跨扫描复用）。
 *
 * @param {{ maxFindings?: number }} [opts] 明细上限，缺省 {@link FINDINGS_DETAIL_CAP}
 */
function createFindingCollector(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const cap = clampMaxFindings(options.maxFindings);

  /** @type {any[]} 明细（最多 cap 条） */
  const findings = [];
  /** 全量分布：与 totalFindings 同源、同一遍循环里 +1（C-30） */
  const counts = { high: 0, medium: 0, low: 0 };
  let totalFindings = 0; // 全量命中数（含明细已满之后只计数的那些）
  let suppressed = 0; // 被「同文件同规则最多 3 条」折叠掉的条数（RC-01：必须可见）
  let truncated = false;
  let truncatedReason = '';

  /** 记一个截断原因：**按优先级取一个**，不是先到先得（v16） */
  const markTruncated = (reason) => {
    truncated = true;
    truncatedReason = pickReason(truncatedReason, reason);
  };

  /**
   * 收一条命中。
   *
   * @param {any} hit scan-rules 的一条命中
   * @param {string} file 相对扫描根目录的 POSIX 路径
   * @returns {boolean} 是否进了明细（false = 明细已满，只计了数）
   */
  const addHit = (hit, file) => {
    const h = hit && typeof hit === 'object' ? hit : {};
    const severity = normalizeSeverity(h.severity);
    totalFindings += 1;
    counts[severity] += 1;

    // 明细满：只计数（**不停止扫描**，v16 的核心改动），并且只在**真要丢一条**时才置 'findings'
    if (findings.length >= cap) {
      markTruncated('findings');
      return false;
    }

    const finding = {
      ruleId: String(h.ruleId == null ? '' : h.ruleId),
      severity,
      title: String(h.title == null ? '' : h.title),
      file: String(file == null ? '' : file),
      line: Number(h.line) || 0,
      snippet: String(h.snippet == null ? '' : h.snippet),
    };
    // 历史字段透传（1.36.0 起 `coverage` 包已下线、规则引擎不再产出 method/path）：
    // **有值才带**，别塞 undefined（结构化克隆会把它变成 null）；旧 scanRuns 记录仍可能有这两键。
    if (h.method) finding.method = String(h.method);
    if (h.path) finding.path = String(h.path);
    findings.push(finding);
    return true;
  };

  /**
   * 收一个文件的全部命中（`matchRules` 的返回）。
   *
   * @returns {number} 真正进了明细的条数（不是命中条数）
   */
  const addHits = (hits, file) => {
    const list = Array.isArray(hits) ? hits : [];
    let added = 0;
    for (const hit of list) if (addHit(hit, file)) added += 1;
    return added;
  };

  /**
   * 记一个文件的折叠条数（`matchRules` 的 `suppressed`）。
   * **只置 `suppressed` 原因**——折叠不等于明细被砍（v16 的 bug 回归锁）。
   *
   * @returns {number} 实际计入的条数（0 / 负数 / 非数字一律忽略）
   */
  const addSuppressed = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return 0;
    const add = Math.floor(v);
    suppressed += add;
    markTruncated('suppressed');
    return add;
  };

  /** 取当前状态（副本：之后继续收集不会改到已经取走的那份） */
  const snapshot = () => ({
    findings: findings.slice(),
    counts: { high: counts.high, medium: counts.medium, low: counts.low },
    totalFindings,
    suppressed,
    truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  });

  return { cap, addHit, addHits, addSuppressed, markTruncated, snapshot };
}

module.exports = {
  TRUNCATED_REASONS,
  FINDINGS_DETAIL_CAP,
  SEVERITIES,
  ARTIFACT_PATH_RE,
  SKIP_DIRS,
  SCAN_MAX_FILES,
  SCAN_MAX_DEPTH,
  SCAN_TIMEOUT_MS,
  isArtifactPath,
  createScanGuards,
  rankOfReason,
  pickReason,
  normalizeSeverity,
  clampMaxFindings,
  createFindingCollector,
};
