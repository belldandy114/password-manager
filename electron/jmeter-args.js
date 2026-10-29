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
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
function buildJmeterArgs({ jmxPath, jtlPath, mode = 'log', reportDir, threads, loops, extraArgs }) {
  if (!jmxPath) throw new Error('缺少 .jmx 脚本路径');
  if (!jtlPath) throw new Error('缺少 jtl 输出路径');
  if (!MODES.includes(mode)) throw new Error(`未知模式：${mode}`);
  if (mode === 'report' && !reportDir) throw new Error('报告模式缺少报告目录');

  const args = ['-n', '-t', String(jmxPath), '-l', String(jtlPath)];

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
 * 解析 JMeter CSV 结果（jtl 默认就是 CSV）。
 * 只依赖表头名字，不靠列序，避免「改了 save config 就解析错」。
 */
function parseJtl(csvText) {
  const text = String(csvText || '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;

  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const iElapsed = idx('elapsed');
  const iSuccess = idx('success');
  const iCode = idx('responsecode');
  const iLabel = idx('label');
  const iTs = idx('timestamp');
  if (iElapsed < 0 || iSuccess < 0) return null;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length <= Math.max(iElapsed, iSuccess)) continue;
    const elapsed = Number(cols[iElapsed]);
    if (!Number.isFinite(elapsed)) continue;
    rows.push({
      elapsed,
      ok: String(cols[iSuccess]).trim().toLowerCase() === 'true',
      code: iCode >= 0 ? String(cols[iCode]).trim() : '',
      label: iLabel >= 0 ? String(cols[iLabel]).trim() : '',
      ts: iTs >= 0 ? Number(cols[iTs]) : 0,
    });
  }
  if (!rows.length) return null;

  const durations = rows.map(r => r.elapsed).sort((a, b) => a - b);
  const sum = durations.reduce((a, b) => a + b, 0);
  const errors = rows.filter(r => !r.ok).length;
  const tsList = rows.map(r => r.ts).filter(Boolean);
  const wallMs = tsList.length > 1 ? Math.max(...tsList) - Math.min(...tsList) : 0;
  const pct = (p) => durations[Math.min(durations.length - 1, Math.max(0, Math.ceil((p / 100) * durations.length) - 1))];

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

module.exports = {
  MODES, stamp, scriptBase, pickPaths, buildJmeterArgs,
  validateJmxPath, validateOutDir, validateJmeterPath,
  parseSummary, parseJtl, splitCsvLine,
};