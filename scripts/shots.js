/**
 * shots.js —— 给各页面截图，用于视觉走查
 * 用法：node scripts/shots.js <输出目录> [dark|light]
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'pm-shots');
const THEME = process.argv[3] || 'dark';
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9666;
const PASSWORD = 'Shots#2026';

const PAGES = [
  ['网址管理', 'passwordManager'],
  ['周报', 'weekly'],
  ['测试笔记', 'notes'],
  ['禅道', 'zentao'],
  ['JSON 转化', 'json'],
  ['工具箱', 'toolbox'],
  ['接口调试', 'api'],
  ['设置', 'settings'],
];

fs.mkdirSync(OUT, { recursive: true });
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-shot-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    { env, cwd: APP_DIR, windowsHide: true });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* starting */ }
    await sleep(400);
  }
  if (!target) { console.error('连不上'); app.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise(resolve => {
    const i = ++id; pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) console.log('  [异常] ' + (r.exceptionDetails.exception?.description || '').slice(0, 160));
    return r && r.result ? r.result.value : undefined;
  };
  const SET = `(el,v)=>{const p=el.tagName==='SELECT'?HTMLSelectElement.prototype:el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const d=Object.getOwnPropertyDescriptor(p,'value').set;d.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));}`;

  await ev(`(()=>{const s=${SET};const ins=[...document.querySelectorAll('input')];s(ins[0],'${PASSWORD}');if(ins[1])s(ins[1],'${PASSWORD}');return 1})()`);
  await sleep(400);
  await ev(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.includes('设置主密码')).click();return 1})()`);
  await sleep(2200);
  await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(THEME)})`);
  await sleep(400);

  const shot = async (name) => {
    const r = await send('Page.enable');
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (!s || !s.data) { console.log('截图失败', name); return; }
    fs.writeFileSync(path.join(OUT, `${THEME}-${name}.png`), Buffer.from(s.data, 'base64'));
    console.log('shot:', path.join(OUT, `${THEME}-${name}.png`));
  };

  for (const [label, key] of PAGES) {
    if (key !== 'passwordManager') {
      await ev(`(()=>{const n=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(n){n.click();return true}return false})()`);
      await sleep(1200);
    }
    await shot(key);
  }
  // 设置页滚动一点，看到更多控件
  await ev(`(()=>{const n=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('设置'));if(n)n.click();return 1})()`);
  await sleep(1000);
  await shot('settings-2');

  app.kill();
  await sleep(800);
  try { ws.close(); } catch { /* ignore */ }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
})();
