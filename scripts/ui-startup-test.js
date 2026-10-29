/**
 * 启动回归：应用启动后 8 秒会跑一次「静默检查更新」的定时器。
 *
 * 为什么单独一个脚本：这条路径只有在启动 8 秒后才会执行，普通 UI 回归（几十条断言）几十秒就跑完了，
 * 沙箱 smoke 也只测首屏 13 条 —— 之前就是因为没有任何回归跑到 8 秒之后，
 * autoCheckUpdate 被写在 setupIpcHandlers 内部（函数作用域）导致启动即 ReferenceError 崩溃，
 * 是用户手动打开 app 才发现的。
 *
 * 断言：
 *   1) 进程在 16 秒后仍然活着；
 *   2) 定时器真的执行到了（PM_DEBUG_AUTO_UPDATE=1 打印 [auto-update] start）；
 *   3) 输出里没有 Uncaught Exception / ReferenceError。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const USE_PACKED = process.env.USE_PACKED === '1';
const DEBUG_WAIT_MS = Number(process.env.STARTUP_WAIT_MS || 16000);

const exe = USE_PACKED
  ? path.join('release', 'win-unpacked', '测试工具.exe')
  : path.join('node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(exe)) {
  console.error(`找不到可执行文件：${exe}（打包版请先 npm run pack）`);
  process.exit(1);
}

const env = { ...process.env, PM_DEBUG_AUTO_UPDATE: '1' };
if (!USE_PACKED) env.PM_USE_DIST = '1';
delete env.ELECTRON_RUN_AS_NODE;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-startup-'));
const app = spawn(exe, USE_PACKED ? [`--user-data-dir=${userDataDir}`] : ['.', `--user-data-dir=${userDataDir}`], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
app.stdout.on('data', (d) => { out += d.toString(); });
app.stderr.on('data', (d) => { out += d.toString(); });

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  try { app.kill(); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(code), 200);
};

app.on('exit', (code) => {
  // 没有主动 kill 就退出 = 崩了
  if (!finished) {
    console.log('✗ 应用在启动检查前就退出了，exitCode=' + code);
    console.log(out.slice(-1500));
    finish(1);
  }
});

setTimeout(() => {
  const crashed = /Uncaught Exception|ReferenceError|TypeError:/.test(out);
  const started = /\[auto-update\] start/.test(out);
  const stage = (out.match(/\[auto-update\][^\r\n]*/) || [''])[0];

  const results = [
    ['启动 16 秒后进程仍存活', !crashed, crashed ? '输出里有未捕获异常' : ''],
    ['静默检查更新的定时器真的执行了', started, started ? stage : '没看到 [auto-update] 日志'],
    ['主进程没有未捕获异常', !crashed, crashed ? out.slice(-400) : ''],
  ];

  let fail = 0;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  → ' + String(detail).slice(0, 160) : ''}`);
    if (!ok) fail++;
  }
  console.log(`\n结果：${results.length - fail} 通过 / ${fail} 失败`);
  finish(fail ? 1 : 0);
}, DEBUG_WAIT_MS);
