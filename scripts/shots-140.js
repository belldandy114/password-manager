/** 1.4.0 界面截图：禅道分页+趋势图 / 接口断言 / 安全体检 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9821;
const PW = 'Shot140#2026';
const ZT = require('./zt-config');
const OUT = './_shots';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-s8-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd: APP_DIR, windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 等待 */ }
    await sleep(400);
  }
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1600);

  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', r.exceptionDetails.exception?.description?.slice(0, 140));
    return r.result?.value;
  };
  const SETVAL = `(el, v) => {
    const isSel = el.tagName === 'SELECT';
    const isArea = el.tagName === 'TEXTAREA';
    const p = isSel ? HTMLSelectElement.prototype : isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(p, 'value').set;
    d.call(el, v);
    el.dispatchEvent(new Event(isSel ? 'change' : 'input', { bubbles: true }));
  }`;
  const shot = async (n) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${n}.png`), Buffer.from(s.data, 'base64'));
    console.log('saved', n);
  };
  const nav = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return 1; })()`);
    await sleep(800);
  };

  // 解锁
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], '${PW}'); if (ins[1]) s(ins[1], '${PW}'); return 1; })()`);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('设置主密码')); if (b) b.click(); return 1; })()`);
  await sleep(2200);
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);

  // 塞几条测试条目（安全体检用）
  await ev(`(async () => {
    const mk = (id, name, pwd, days) => ({ id, name, url: 'https://' + id + '.example.com', username: id, password: pwd,
      envType: 'testing', notes: '', tags: ['演示'], favorite: false,
      createdAt: new Date(Date.now() - days * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - days * 86400000).toISOString() });
    await window.electronAPI.entriesAdd(mk('demo1', '教务系统', 'SamePwd#2026', 4));
    await window.electronAPI.entriesAdd(mk('demo2', '图书系统', 'SamePwd#2026', 6));
    await window.electronAPI.entriesAdd(mk('demo3', '旧考试系统', '123456', 420));
    return 1;
  })()`);
  await sleep(300);
  await nav('网址管理');
  await ev(`(() => location.reload())()`).catch(() => {});
  await sleep(1800);
  const needUnlock = await ev(`(() => !!document.querySelector('input[type=password]'))()`);
  if (needUnlock) {
    await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; if (ins[0]) s(ins[0], '${PW}'); return 1; })()`);
    await sleep(200);
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('解锁')); if (b) b.click(); return 1; })()`);
    await sleep(1800);
    await nav('网址管理');
  }
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await sleep(400);

  // 安全体检
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('安全体检')); if (b) b.click(); return 1; })()`);
  await sleep(700);
  await shot('security-audit');
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return 1; })()`);
  await sleep(400);

  // 禅道：我的 Bug（分页 + 趋势图）
  await nav('禅道');
  await sleep(600);
  const cfgShown = await ev(`(() => document.querySelectorAll('.pnl-body input').length)()`);
  if (cfgShown < 3) {
    await ev(`(() => { const h = [...document.querySelectorAll('.pnl-head.is-clickable')].find(x => x.textContent.includes('连接配置')); if (h) h.click(); return 1; })()`);
    await sleep(400);
  }
  await ev(`(() => {
    const s = ${SETVAL};
    const root = document.querySelector('.pnl-body');
    const ins = [...root.querySelectorAll('input')];
    ['${ZT.baseUrl}', '${ZT.account}', '${ZT.password}'].forEach((v, i) => { if (ins[i]) s(ins[i], v); });
    return 1;
  })()`);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('拉取我的 Bug')); if (b) b.click(); return 1; })()`);
  for (let i = 0; i < 40; i++) {
    const n = await ev(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`);
    if (n > 0) break;
    await sleep(1000);
  }
  await sleep(900);
  await shot('zentao-pager-trend');

  // 接口调试：断言 + 批量
  await nav('接口调试');
  await sleep(700);
  await ev(`(async () => {
    const base = { headers: '', body: '', variables: '', cookies: '', assertions: { status: '200' } };
    await window.electronAPI.wsSet('apiRequests', [
      { ...base, id: 'r1', name: '禅道登录页', method: 'GET', url: '${ZT.baseUrl}/user-login.html', updatedAt: new Date().toISOString() },
      { ...base, id: 'r2', name: '资源列表', method: 'GET', url: '${ZT.baseUrl}/index.php?m=my&f=index', updatedAt: new Date().toISOString() },
    ]);
    return 1;
  })()`);
  await nav('禅道');
  await sleep(300);
  await nav('接口调试');
  await sleep(900);
  await ev(`(() => { const bs = [...document.querySelectorAll('.api-pick input')]; bs.forEach(b => b.click()); return bs.length; })()`);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('.api-batch-bar button')].find(x => x.textContent.includes('批量运行')); if (b) b.click(); return 1; })()`);
  for (let i = 0; i < 30; i++) {
    const n = await ev(`(() => document.querySelectorAll('.batch-row').length)()`);
    if (n >= 2) break;
    await sleep(1000);
  }
  await sleep(600);
  await shot('api-batch');
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return 1; })()`);
  await sleep(500);

  // 单条发送 + 断言条
  await ev(`(() => {
    const s = ${SETVAL};
    const inputs = [...document.querySelectorAll('.url-bar input')];
    if (inputs[0]) s(inputs[0], '${ZT.baseUrl}/user-login.html');
    return 1;
  })()`);
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('.assert-toggle')].find(x => x.textContent.includes('断言')); if (b) b.click(); return 1; })()`);
  await sleep(300);
  await ev(`(() => {
    const s = ${SETVAL};
    const g = document.querySelector('.assert-grid');
    const ins = g ? [...g.querySelectorAll('input')] : [];
    if (ins[0]) s(ins[0], '200');
    if (ins[1]) s(ins[1], '2000');
    if (ins[2]) s(ins[2], '');
    if (ins[4]) s(ins[4], 'zentao');
    return ins.length;
  })()`);
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '发送'); if (b) b.click(); return 1; })()`);
  for (let i = 0; i < 20; i++) {
    const has = await ev(`(() => !!document.querySelector('.assert-bar'))()`);
    if (has) break;
    await sleep(800);
  }
  await sleep(500);
  await shot('api-assert');

  app.kill();
  await sleep(600);
  try { ws.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* 忽略 */ }
})();
