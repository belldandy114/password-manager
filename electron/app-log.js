'use strict';

/**
 * 主进程日志落盘（1.9.0）。
 *
 * 为什么需要：之前排查「JMeter 找不到 Java」「禅道拉不到数据」只能靠猜，
 * 用户那边看到的只有界面提示。有了 app.log，下一次直接要日志就行。
 *
 * 约定：
 * - 只记**技术日志**（异常、子进程退出码、启动阶段），不记密码/请求体等敏感内容；
 * - 单文件超过 2MB 就滚一份 app.log.1（只保留一份历史），避免无限增长；
 * - 任何写盘失败都吞掉——日志不能影响主流程。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
let logFile = '';
let installed = false;

function stamp() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(logFile);
    if (st.size < MAX_BYTES) return;
    const old = `${logFile}.1`;
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch { /* 忽略 */ }
    fs.renameSync(logFile, old);
  } catch { /* 文件还不存在 */ }
}

function write(level, parts) {
  if (!logFile) return;
  try {
    rotateIfNeeded();
    const line = `[${stamp()}] [${level}] ${parts.map((x) => {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch { return String(x); }
    }).join(' ')}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch { /* 日志失败不影响业务 */ }
}

/**
 * 安装日志：劫持 console 并把未捕获异常也记下来。
 * @param {string} dir 日志目录（一般是 DATA_DIR/logs）
 */
function installFileLogging(dir) {
  if (installed) return logFile;
  installed = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'app.log');
    fs.appendFileSync(logFile, `\n===== 启动 v${process.env.PM_APP_VERSION || ''} ${stamp()} =====\n`, 'utf8');
  } catch {
    return '';
  }

  const wrap = (level, orig) => (...args) => {
    try { orig.apply(console, args); } catch { /* 忽略 */ }
    write(level, args);
  };
  console.log = wrap('info', console.log.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));

  process.on('uncaughtException', (err) => {
    write('fatal', ['uncaughtException:', err && (err.stack || err.message || String(err))]);
  });
  process.on('unhandledRejection', (reason) => {
    write('fatal', ['unhandledRejection:', reason && (reason.stack || reason.message || String(reason))]);
  });
  return logFile;
}

function logPath() {
  return logFile;
}

/** 读最近 N 行（设置页「查看日志」用，避免一次把几 MB 塞进界面） */
function tail(lines = 200) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const all = text.split('\n');
    return all.slice(Math.max(0, all.length - lines - 1)).join('\n');
  } catch {
    return '';
  }
}

module.exports = { installFileLogging, logPath, tail, MAX_BYTES };
