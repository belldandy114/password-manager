/**
 * 汇总 tab 截图（用于人工核对样式）
 * ZT_BASEURL/ZT_ACCOUNT/ZT_PASSWORD 环境变量必填
 * node scripts/shots-summary.js
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const ZT = require('./zt-config');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = pickExe(APP_DIR);
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9815;
const OUT = path.join(ROOT, '_shots-summary');
const PW = 'Shots#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETVAL = `(el, v) => {
  const isSel = el.tagName === 'SELECT';
  const p = isSel ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(p, 'value').set;
  d.call(el, v);
  el.dispatchEvent(new Event(isSel ? 'change' : 'input', { bubbles: true }));
}`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-shot-'));
  const env = { ...process.env, PM_USE_DIST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const cwd = usePacked ? APP_DIR : ROOT;
  const args = usePacked ? [] : ['.'];
  const app = spawn(EXE, [...args, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd, windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
      if (target) break;
    } catch { /* 等待 */ }
    await sleep(400);
  }
  if (!target) { console.log('应用未启动'); app.kill(); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', r.exceptionDetails.exception?.description?.slice(0, 150));
    return r.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log('saved', name);
  };
  const clickHas = (t) => ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)})); if (b) { b.click(); return true; } return false; })()`);
  const waitFor = async (expr, timeout = 30000, step = 400) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(step);
    }
    return false;
  };

  await waitFor(`(() => document.querySelectorAll('input[type=password]').length >= 2)()`, 30000);

  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await clickHas('设置主密码');
  await sleep(2600);

  await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('缺陷管理')); if (n) n.click(); return !!n; })()`);
  await sleep(900);

  await ev(`(() => {
    const s = ${SETVAL};
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { s(el, v); return true; } return false; };
    set('input[placeholder^="http://"]', ${JSON.stringify(ZT.baseUrl)});
    set('input[placeholder="用户名"]', ${JSON.stringify(ZT.account)});
    set('input[placeholder="密码"]', ${JSON.stringify(ZT.password)});
    return 1;
  })()`);
  await sleep(300);
  await shot('1-config');

  await clickHas('汇总');
  await sleep(900);
  await shot('2-empty');

  await clickHas('登录并保存');
  await sleep(11000);
  await clickHas('刷新项目列表');
  await sleep(7000);

  await clickHas('选择项目');
  await sleep(800);
  await shot('3-picker');
  await ev(`(() => {
    const s = ${SETVAL};
    const box = document.querySelector('.zt-proj-search input');
    if (box) s(box, '58');
    return 1;
  })()`);
  await sleep(500);
  await ev(`(() => {
    const it = [...document.querySelectorAll('.zt-proj-item')].find(x => x.textContent.includes('#58'));
    if (it) { it.querySelector('input').click(); return true; }
    return false;
  })()`);
  await sleep(300);
  await clickHas('确定（');
  await sleep(700);
  await clickHas('拉取并汇总');
  for (let i = 0; i < 60; i++) {
    if (await ev(`(() => document.querySelectorAll('.zt-sum-tbl tbody tr.zt-sum-row').length > 0)()`)) break;
    await sleep(900);
  }
  await sleep(600);
  await shot('4-summary');

  await ev(`(() => { const r = document.querySelector('.zt-sum-row'); if (r) r.click(); return !!r; })()`);
  await sleep(800);
  await shot('5-expanded');

  // 按人员面板在页面底部，单独滚过去拍一张
  await ev(`(() => {
    const p = [...document.querySelectorAll('.pnl')].find(x => /按人员/.test(x.textContent.slice(0, 40)));
    if (!p) return false;
    p.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await sleep(800);
  await shot('6-persons');

  // 人员下钻：点第一个人员行
  await ev(`(() => { const tr = document.querySelector('.zt-sum-prow'); if (tr) { tr.click(); return true; } return false; })()`);
  await sleep(1800);
  await shot('7-drill');
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '关闭'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(500);

  // 复制格式菜单：先滚到总计，再点开
  await ev(`(() => { const c = document.querySelector('.zt-sum-cards'); if (c) c.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(600);
  const menuOpened = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === '选择复制格式 / 导出');
    if (!b) return 'no-btn';
    b.click();
    return 'clicked';
  })()`);
  await sleep(700);
  const menuShown = await ev(`(() => { const m = document.querySelector('.zt-sum-menu'); return m ? m.getBoundingClientRect().toJSON() : null; })()`);
  console.log('menu:', menuOpened, JSON.stringify(menuShown));
  await shot('8-copy-menu');

  console.log('done');
  app.kill();
  process.exit(0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
