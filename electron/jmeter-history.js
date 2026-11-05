'use strict';

/**
 * JMeter 运行历史（纯函数 + 文件读写）。
 *
 * 为什么需要：压测要看多轮趋势（调参前后对比），以前跑完只留在当前屏幕，
 * 关掉就没了；jtl/报告还在磁盘上，但没人记得是哪次、用的什么参数。
 *
 * 存 DATA_DIR/jmeter-history.json（**不加密**，但只存路径与统计，不含任何密钥）。
 */

const fs = require('fs');
const path = require('path');

const MAX_RECORDS = 50;

/** 追加一条记录，按时间倒序保留最近 MAX_RECORDS 条 */
function pushRecord(list, rec, max = MAX_RECORDS) {
  const rows = Array.isArray(list) ? list.slice() : [];
  if (!rec || !rec.id) return rows;
  rows.unshift(rec);
  const cap = Number(max) > 0 ? Number(max) : MAX_RECORDS;
  return rows.slice(0, cap);
}

/** 从「运行结果」里挑出要留存的字段（其余丢弃，避免历史文件膨胀） */
function recordFromRun(run, extra = {}) {
  const stats = run && run.stats ? run.stats : null;
  return {
    id: String((run && run.runId) || Date.now()),
    at: new Date().toISOString(),
    jmx: String(extra.jmxPath || ''),
    jmxName: path.basename(String(extra.jmxPath || '')),
    mode: String(extra.mode || 'log'),
    threads: Number(extra.threads) || 0,
    loops: Number(extra.loops) || 0,
    ok: !!(run && run.ok),
    code: run && run.code != null ? Number(run.code) : null,
    samples: stats ? Number(stats.samples) || 0 : 0,
    errors: stats ? Number(stats.errors) || 0 : 0,
    errorPct: stats ? Number(stats.errorPct) || 0 : 0,
    avg: stats ? Number(stats.avg) || 0 : 0,
    max: stats ? Number(stats.max) || 0 : 0,
    tps: stats ? Number(stats.tps) || 0 : 0,
    jtlPath: String((run && run.jtlPath) || ''),
    reportDir: String((run && run.reportDir) || ''),
    logPath: String((run && run.logPath) || ''),
  };
}

function historyFile(dataDir) {
  return path.join(dataDir, 'jmeter-history.json');
}

function loadHistory(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(historyFile(dataDir), 'utf8'));
    return Array.isArray(j) ? j.slice(0, MAX_RECORDS) : [];
  } catch {
    return [];
  }
}

function saveHistory(dataDir, list) {
  try {
    fs.writeFileSync(historyFile(dataDir), JSON.stringify((list || []).slice(0, MAX_RECORDS), null, 1), 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { MAX_RECORDS, pushRecord, recordFromRun, historyFile, loadHistory, saveHistory };
