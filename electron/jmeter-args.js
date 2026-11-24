'use strict';

/**
 * JMeter 命令行拼装与结果解析（纯函数，便于单测）。
 *
 * 为什么不把这些写在 ipc 里：参数拼错的表现是「命令跑了但结果不对」——
 * 比如漏了 -e 就没报告、-o 目录非空直接报错、-Jthreads 拼错就覆盖不到线程数。
 * 这些都能离线测。
 */

const fs = require('fs');
const path = require('path');

/** 允许的模式：log=只出 jtl；report=出 jtl + HTML 报告 */
const MODES = ['log', 'report'];

const pad = (n) => String(n).padStart(2, '0');

/** 时间戳（本地时区），用于输出文件/目录命名：20261029-1603 */
function stamp(d = new Date()) {
  // 可读时间戳：文件名里一眼能看出是哪天跑的（旧格式 20261030-173645 不好认）
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** 从 .jmx 路径取一个安全的基名（去掉扩展名与非法字符） */
function scriptBase(jmxPath) {
  const base = path.basename(String(jmxPath || ''), path.extname(String(jmxPath || '')));
  const safe = base.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return safe || 'jmeter';
}

/**
 * 规划输出路径。
 * - log 模式：<outDir>/<script>-<stamp>.jtl
 * - report 模式：报告放 <outDir>/report-<stamp>/（JMeter 要求 -o 目录为空或不存在），
 *   jtl 放它旁边；这样「一次运行 = 一个目录 + 一个 jtl」，不会互相覆盖。
 */
function pickPaths({ jmxPath, outDir, mode = 'log', stampStr }) {
  const st = stampStr || stamp();
  const base = scriptBase(jmxPath);
  const root = String(outDir || '');
  if (mode === 'report') {
    const reportDir = path.join(root, `report-${st}`);
    return { mode, jtlPath: path.join(root, `${base}-${st}.jtl`), reportDir };
  }
  return { mode: 'log', jtlPath: path.join(root, `${base}-${st}.jtl`), reportDir: '' };
}

/**
 * 拼 JMeter 参数（不含 jmeter.bat 本身）。
 * 线程数/循环数是「临时覆盖」——通过 -J 传属性，脚本里要用 ${__P(threads,默认值)} 才生效。
 */
function buildJmeterArgs({ jmxPath, jtlPath, mode = 'log', reportDir, threads, loops, extraArgs, logPath }) {
  if (!jmxPath) throw new Error('缺少 .jmx 脚本路径');
  if (!jtlPath) throw new Error('缺少 jtl 输出路径');
  if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}`);
  if (mode === 'report' && !reportDir) throw new Error('报告模式缺少报告目录');

  const args = ['-n', '-t', String(jmxPath), '-l', String(jtlPath)];

  // -j：把 **JMeter 引擎自己的** jmeter.log 钉到指定路径。
  // 为什么必须有：spawn 的 cwd 已经改成 JMX 所在目录（C-75 第 3 条，CSV 相对路径才能解析），
  // 而 JMeter 默认把 jmeter.log 写进进程 cwd —— 不传 -j 就会往用户的脚本库里扔日志文件，每次运行还可能互相覆盖。
  // 传空/空白视为「不指定」，保持旧行为（调用方在目录不可写时就是这么退化的）。
  const log = String(logPath == null ? '' : logPath).trim();
  if (log) args.push('-j', log);

  const asPositiveInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const th = asPositiveInt(threads);
  const lp = asPositiveInt(loops);
  if (th) args.push(`-Jthreads=${th}`);
  if (lp) args.push(`-Jloops=${lp}`);

  if (mode === 'report') args.push('-e', '-o', String(reportDir));

  if (Array.isArray(extraArgs)) {
    for (const a of extraArgs) {
      const s = String(a == null ? '' : a).trim();
      if (s) args.push(s);
    }
  }
  return args;
}

/**
 * JMeter 引擎日志（`-j`）的目标路径：`<dir>/jmeter-<时间戳>-engine.log`。
 *
 * 纯函数（不碰盘）：目录能不能写由调用方用 `canWriteDir()` 探，探不到就不传 `-j`。
 * 名字里带 `-engine` 是刻意的：应用自己还会把捕获的 stdout 写成 `<outDir>/jmeter-<时间戳>.log`
 * （见 ipc-jmeter.js 的 logPath），两个同名会互相覆盖，引擎日志就白留了。
 *
 * @param {string} dir jtl 同目录
 * @param {string} [stampStr] 时间戳（缺省用 stamp()）
 * @returns {{ ok: true, path: string } | { ok: false, reason: 'no-dir' }}
 */
function pickJmeterLogPath(dir, stampStr) {
  const d = String(dir == null ? '' : dir).trim();
  if (!d) return { ok: false, reason: 'no-dir' };
  return { ok: true, path: path.join(d, `jmeter-${stampStr || stamp()}-engine.log`) };
}

/**
 * 目录可写探测（不创建任何文件）。不可写/不存在一律 false —— 调用方据此退化为不传 `-j`，
 * 绝不能让「日志放不下」把压测本身弄失败。
 * @param {string} dir
 * @returns {boolean}
 */
function canWriteDir(dir) {
  const d = String(dir == null ? '' : dir).trim();
  if (!d) return false;
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 校验 .jmx：存在 + 扩展名正确 */
function validateJmxPath(p) {
  const s = String(p || '').trim();
  if (!s) return { ok: false, error: '请先选择 .jmx 脚本' };
  if (path.extname(s).toLowerCase() !== '.jmx') return { ok: false, error: '脚本必须是 .jmx 文件' };
  try {
    if (!fs.statSync(s).isFile()) return { ok: false, error: '脚本路径不是文件' };
  } catch {
    return { ok: false, error: `脚本不存在：${s}` };
  }
  return { ok: true };
}

/** 校验输出目录：存在且是目录（报告模式的子目录由我们创建） */
function validateOutDir(p) {
  const s = String(p || '').trim();
  if (!s) return { ok: false, error: '请选择输出目录' };
  try {
    if (!fs.statSync(s).isDirectory()) return { ok: false, error: '输出路径不是目录' };
  } catch {
    return { ok: false, error: `输出目录不存在：${s}` };
  }
  return { ok: true };
}

/** 校验 jmeter.bat / jmeter 可执行文件 */
function validateJmeterPath(p) {
  const s = String(p || '').trim();
  if (!s) return { ok: false, error: '还没配置 JMeter 路径（设置里可选 jmeter.bat）' };
  try {
    if (!fs.statSync(s).isFile()) return { ok: false, error: 'JMeter 路径不是文件' };
  } catch {
    return { ok: false, error: `JMeter 不存在：${s}` };
  }
  return { ok: true };
}

/**
 * 从控制台输出里抽汇总行，例如：
 *   summary =    200 in 00:00:12 =   16.7/s Avg:   145 Min:    88 Max:   402 Err: 0 (0.00%)
 * 取最后一次（多线程会有多行）。
 */
function parseSummary(text) {
  const s = String(text || '');
  const re = /summary\s*=\s*(\d+)\s+in\s+([\d:.]+)\s*=\s*([\d.]+)\/s\s+Avg:\s*(\d+)\s+Min:\s*(\d+)\s+Max:\s*(\d+)\s+Err:\s*(\d+)\s*\(([\d.]+)%\)/g;
  let m;
  let last = null;
  while ((m = re.exec(s)) !== null) {
    last = {
      samples: Number(m[1]),
      duration: m[2],
      tps: Number(m[3]),
      avg: Number(m[4]),
      min: Number(m[5]),
      max: Number(m[6]),
      errors: Number(m[7]),
      errorPct: Number(m[8]),
    };
  }
  return last;
}

/**
 * 解析 JMeter CSV 结果（jtl 默认就是 CSV）的**表头**：按表头名字取列下标，不靠列序。
 * 契约 [C-71]：缺 elapsed / success 任一 → null（与 parseJtl 的失败条件一致）。
 * @param {string} line 表头行
 * @returns {{ elapsed: number, success: number, code: number, label: number, ts: number } | null}
 */
function parseJtlHeader(line) {
  const text = String(line == null ? '' : line);
  if (!text.trim()) return null;
  const header = splitCsvLine(text).map((h) => h.trim().toLowerCase());
  const at = (name) => header.indexOf(name);
  const idx = {
    elapsed: at('elapsed'),
    success: at('success'),
    code: at('responsecode'),
    label: at('label'),
    ts: at('timestamp'),
  };
  if (idx.elapsed < 0 || idx.success < 0) return null;
  return idx;
}

/**
 * 解析一行数据 → 行对象。空行 / 列不足 / elapsed 非有限数 → null（坏行由调用方丢弃）。
 * 缺 ts / code / label 列时给 0 / '' / ''，不报错。
 * @param {string} line
 * @param {{ elapsed: number, success: number, code: number, label: number, ts: number } | null} header
 * @returns {{ elapsed: number, ok: boolean, code: string, label: string, ts: number } | null}
 */
function parseJtlRow(line, header) {
  if (!header) return null;
  const text = String(line == null ? '' : line);
  if (!text.trim()) return null;
  const cols = splitCsvLine(text);
  if (cols.length <= Math.max(header.elapsed, header.success)) return null;
  const elapsed = Number(cols[header.elapsed]);
  if (!Number.isFinite(elapsed)) return null;
  return {
    elapsed,
    ok: String(cols[header.success]).trim().toLowerCase() === 'true',
    code: header.code >= 0 ? String(cols[header.code]).trim() : '',
    label: header.label >= 0 ? String(cols[header.label]).trim() : '',
    // ts 列可能是空串或脏值：统一收敛成 0，聚合时按「没有时间戳」处理
    ts: header.ts >= 0 ? Number(cols[header.ts]) || 0 : 0,
  };
}

/**
 * 整段文本 → { header, rows }。
 * 文本空 / 不足两行 / 表头不合格 / 零有效行 → null（**不返回空数组冒充成功**，
 * 否则 UI 会显示「跑完了 0 个样本」而不是「这不是 .jtl」）。
 * @param {string} text
 * @returns {{ header: { elapsed: number, success: number, code: number, label: number, ts: number },
 *            rows: { elapsed: number, ok: boolean, code: string, label: string, ts: number }[] } | null}
 */
function parseJtlRows(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return null;
  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = parseJtlHeader(lines[0]);
  if (!header) return null;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseJtlRow(lines[i], header);
    if (row) rows.push(row);
  }
  return rows.length ? { header, rows } : null;
}

/** 最近秩法分位：升序数组取 ceil(p/100*n)-1 下标，n=1 时取唯一值（契约 C-70） */
function rankOf(sorted, p) {
  const n = sorted.length;
  if (!n) return 0;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
}

/**
 * 行数组 → 聚合统计（私有）。parseJtl 的唯一出口，保证 12 个字段与重构前逐字一致。
 * @param {{ rows: { elapsed: number, ok: boolean, code: string, label: string, ts: number }[] } | null} parsed
 * @returns {null | { samples: number, errors: number, errorPct: number, avg: number, min: number, max: number,
 *   p90: number, p95: number, p99: number, wallMs: number, tps: number,
 *   topErrorCode: { code: string, count: number } | null }}
 */
function aggregate(parsed) {
  if (!parsed) return null;
  const { rows } = parsed;

  const durations = rows.map((r) => r.elapsed).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const errors = rows.filter((r) => !r.ok).length;
  const tsList = rows.map((r) => r.ts).filter(Boolean);
  const wallMs = tsList.length > 1 ? Math.max(...tsList) - Math.min(...tsList) : 0;
  const pct = (p) => rankOf(durations, p);

  // 出错最多的 responseCode（方便判断是 500 还是 401）
  const codeCount = new Map();
  for (const r of rows) if (!r.ok) codeCount.set(r.code || 'ERR', (codeCount.get(r.code || 'ERR') || 0) + 1);
  const topErrorCode = [...codeCount.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  return {
    samples: rows.length,
    errors,
    errorPct: Number(((errors / rows.length) * 100).toFixed(2)),
    avg: Math.round(sum / rows.length),
    min: durations[0],
    max: durations[durations.length - 1],
    p90: pct(90),
    p95: pct(95),
    p99: pct(99),
    wallMs,
    tps: wallMs > 0 ? Number((rows.length / (wallMs / 1000)).toFixed(2)) : 0,
    topErrorCode: topErrorCode ? { code: topErrorCode[0], count: topErrorCode[1] } : null,
  };
}

/**
 * 解析 JMeter CSV 结果（jtl 默认就是 CSV）。
 * **对外签名与 12 个返回字段一个不许改**（ipc-jmeter.js 的 stats 消费方与 PerfTest 的趋势图在用）；
 * 内部改为复用行级解析：`aggregate(parseJtlRows(text))`（契约 C-73：不许把行解析复制成第二份）。
 * @param {string} csvText
 * @returns {ReturnType<typeof aggregate>}
 */
function parseJtl(csvText) {
  return aggregate(parseJtlRows(csvText));
}

/** byLabel 默认最多返回多少个接口（契约 C-09/C-70 的 `labels` 截断） */
const MAX_BY_LABEL = 100;

/**
 * 行数组 → 指标（契约 C-70 / C-71）。空数组返回全 0，不抛。
 * - 分位：最近秩法（与 parseJtl 同算法，保证同一份 .jtl 两个通道口径一致）
 * - spanMs：时间戳极差，沿用既有 `wallMs` 语义（**不改名**，下游已在用）；ts 缺失或只有 1 行 → 0 且 tps 0
 * - byLabel：按 label 分组，排序 errors 降序 → samples 降序 → label 升序（确定性，[C-10]）
 * @param {{ elapsed: number, ok: boolean, code: string, label: string, ts: number }[]} rows
 * @param {{ maxLabels?: number }} [opts]
 */
function computeMetrics(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const empty = {
    samples: 0, errors: 0, errorPct: 0, avg: 0, min: 0, max: 0,
    p50: 0, p90: 0, p95: 0, p99: 0, spanMs: 0, tps: 0,
    byLabel: [], truncated: false,
  };
  if (!list.length) return empty;

  const durations = list.map((r) => r.elapsed).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const errors = list.filter((r) => !r.ok).length;
  const tsList = list.map((r) => r.ts).filter(Boolean);
  const spanMs = tsList.length > 1 ? Math.max(...tsList) - Math.min(...tsList) : 0;

  // byLabel 分组
  const groups = new Map();
  for (const r of list) {
    const key = String(r.label == null ? '' : r.label);
    let g = groups.get(key);
    if (!g) { g = { label: key, durations: [], errors: 0 }; groups.set(key, g); }
    g.durations.push(r.elapsed);
    if (!r.ok) g.errors += 1;
  }
  const all = [...groups.values()].map((g) => {
    g.durations.sort((a, b) => a - b);
    const n = g.durations.length;
    return {
      label: g.label,
      samples: n,
      errors: g.errors,
      errorPct: Number(((g.errors / n) * 100).toFixed(2)),
      p90: rankOf(g.durations, 90),
    };
  });
  // errors 降序 → samples 降序 → label 升序（同值必须给二级键，否则两次调用顺序可能不同）
  all.sort((a, b) => (b.errors - a.errors) || (b.samples - a.samples) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  // maxLabels 缺省 100；给了就 clamp 到 [1,100]（0 / 负数 / 非数字都不会被当成「无限」）
  const raw = opts && opts.maxLabels;
  const wanted = Number(raw);
  const maxLabels = raw === undefined || raw === null || !Number.isFinite(wanted)
    ? MAX_BY_LABEL
    : Math.max(1, Math.min(Math.floor(wanted), MAX_BY_LABEL));
  const byLabel = all.slice(0, maxLabels);
  const truncated = all.length > byLabel.length;

  return {
    samples: list.length,
    errors,
    errorPct: Number(((errors / list.length) * 100).toFixed(2)),
    avg: Math.round(sum / list.length),
    min: durations[0],
    max: durations[durations.length - 1],
    p50: rankOf(durations, 50),
    p90: rankOf(durations, 90),
    p95: rankOf(durations, 95),
    p99: rankOf(durations, 99),
    spanMs,
    tps: spanMs > 0 ? Number((list.length / (spanMs / 1000)).toFixed(2)) : 0,
    byLabel,
    truncated,
    ...(truncated ? { truncatedReason: 'labels' } : {}),
  };
}

/** 极简 CSV 行拆列（支持双引号包裹与 "" 转义；jtl 的 label 里常见逗号） */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------- 输出解码

/**
 * 子进程输出是字节流：中文 Windows 上 cmd / jmeter.bat 吐的是 **GBK**，
 * 按 UTF-8 硬解就成了乱码（「请按任意键继续」→ `맜...`，1.7.5 的用户反馈）。
 * 按行解码：先试严格 UTF-8，不是 UTF-8 再按 GBK —— 行边界处不可能切坏多字节字符。
 */
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
let gbkDecoder = null;
try { gbkDecoder = new TextDecoder('gbk'); } catch { gbkDecoder = null; }

function decodeOutputLine(bytes) {
  let b = bytes;
  if (b && b.length && b[b.length - 1] === 0x0d) b = b.subarray(0, b.length - 1);
  if (!b || !b.length) return '';
  try { return utf8Fatal.decode(b); } catch { /* 不是 UTF-8，按 GBK 再试 */ }
  if (gbkDecoder) return gbkDecoder.decode(b);
  return new TextDecoder('utf-8').decode(b);
}

// ---------------------------------------------------------------- Java 检查

/**
 * 找 JDK 目录里的 java 可执行文件。
 * `jmeter.bat` 要的是 **JAVA_HOME 这种目录**（不是 java.exe 本身），所以这里配的是目录。
 * Windows 上同时接受 `bin\java.exe` 与包装脚本 `bin\java.cmd`（回归测试用的假 JDK 就是 cmd）。
 */
function javaExeInHome(home) {
  const h = String(home || '').trim();
  if (!h) return '';
  const names = process.platform === 'win32' ? ['java.exe', 'java.cmd'] : ['java'];
  for (const n of names) {
    const exe = path.join(h, 'bin', n);
    try { if (fs.statSync(exe).isFile()) return exe; } catch { /* 继续找 */ }
  }
  return '';
}

/** 校验 JDK 目录：只做结构检查（是否真能跑 java 由调用方执行一次 -version 验证） */
function validateJavaHome(home) {
  const h = String(home || '').trim();
  if (!h) return { ok: false, error: '未指定 JDK 目录' };
  const exe = javaExeInHome(h);
  if (!exe) return { ok: false, error: `该目录下没有 bin/java：${h}` };
  return { ok: true, home: h, exe };
}

module.exports = {
  MODES, stamp, scriptBase, pickPaths, buildJmeterArgs,
  validateJmxPath, validateOutDir, validateJmeterPath,
  parseSummary, parseJtl, splitCsvLine,
  parseJtlHeader, parseJtlRow, parseJtlRows, computeMetrics, MAX_BY_LABEL,
  pickJmeterLogPath, canWriteDir,
  decodeOutputLine, javaExeInHome, validateJavaHome,
};