/**
 * verify-packaged-csv.js —— 只在打包产物上验证一件事：
 * 应用内的 CSV 导入到底还能不能用（1.6.0 把 parseCsv/normalizeImportRecords 挪到了 electron/csv.js，
 * 必须确认它真的被打进 asar 且 require 得到——repo 里跑通不等于装完能跑）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', 'release', 'win-unpacked');
const EXE = path.join(APP_DIR, '测试工具.exe');
const PORT = 9566;
const PASSWORD = 'CsvPack#2026';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${detail ? '  → ' + detail : ''}`); }
  else { fail++; console.log(`✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

async function main() {
  if (!fs.existsSync(EXE)) { console.error('找不到打包后的 exe：' + EXE); process.exit(1); }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-csvpack-'));
  const csvPath = path.join(userDataDir, 'import.csv');
  // 故意带引号、逗号、中文表头：走的是 RFC4180 + 别名归一化两条最容易坏的路径
  fs.writeFileSync(csvPath, [
    '名称,网址,账号,密码,标签,环境类型',
    '"逗号,站",https://a.example.com,user1,"pa,ss123",测试|内网,测试',
    '普通站,https://b.example.com,user2,simplepwd,备注,正式',
  ].join('\n'), 'utf8');

  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
    env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })(),
    cwd: APP_DIR,
    windowsHide: true,
  });

  let targets = [];
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = (await r.json()).filter(t => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
      if (targets.length) break;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  if (!targets.length) { console.error('连不上调试端口'); app.kill(); process.exit(1); }

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const evaluate = (expr) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, (m) => resolve(m.result?.result?.value));
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });

  try {
    for (let i = 0; i < 30; i++) {
      const ready = await evaluate(`!!window.electronAPI`);
      if (ready) break;
      await sleep(300);
    }
    await evaluate(`window.electronAPI.authSetup({password:${JSON.stringify(PASSWORD)},hint:'csv'})`);
    await evaluate(`window.electronAPI.sessionUnlock({password:${JSON.stringify(PASSWORD)}})`);
    await sleep(400);

    const res = await evaluate(`window.electronAPI.importCsvJson({filePath:${JSON.stringify(csvPath)}})`);
    const records = (res && res.data) || [];
    check('打包后 CSV 导入仍可用（csv.js 已进 asar）', res && res.success === true, JSON.stringify(res).slice(0, 120));
    check('引号里的逗号没被拆坏', records.some(r => r.password === 'pa,ss123'), records.map(r => r.password).join(' / '));
    check('中文表头别名仍能识别', records[0] && records[0].name === '逗号,站' && records[0].username === 'user1', records[0] ? records[0].name : '无');
    check('标签按 | 拆分、环境别名归一化', records[0] && records[0].tags.length === 2 && records[0].envType === 'testing', records[0] ? `${records[0].tags.join('+')}/${records[0].envType}` : '无');
  } finally {
    try { ws.close(); } catch { /* 忽略 */ }
    try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }

  console.log('─'.repeat(50));
  console.log(`${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });