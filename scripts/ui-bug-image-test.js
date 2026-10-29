/**
 * 验证：Bug 详情抽屉能把重现步骤里的截图拉回来（file-read-*.png 需要登录态）
 * 单独跑：node scripts/ui-bug-image-test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(APP_DIR, '测试工具.exe');
const PORT = 9781;
const PASSWORD = 'ImgTest#2026';
const ZT = require('./zt-config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-img-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], {
    env, cwd: APP_DIR, windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', r.exceptionDetails.exception?.description?.slice(0, 200));
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

  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], '${PASSWORD}'); if (ins[1]) s(ins[1], '${PASSWORD}'); return 1; })()`);
  await sleep(300);
  await ev(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置主密码')).click(); return 1; })()`);
  await sleep(2200);

  // 直接调用 IPC：确认图片是否真的取回来了
  const cfg = { id: 'zentao', ...ZT };
  const res = await ev(`(async () => {
    const r = await window.electronAPI.zentaoBugDetail(${JSON.stringify(cfg)}, '14165');
    if (!r.success) return JSON.stringify({ ok: false, error: r.error });
    const d = r.data;
    return JSON.stringify({
      ok: true,
      steps: d.steps.slice(0, 120),
      hasPlaceholder: /\\[图\\d+\\]/.test(d.steps),
      imageTotal: d.imageTotal,
      imageFailed: d.imageFailed,
      got: (d.images || []).length,
      sizes: (d.images || []).map(i => i.dataUrl.length),
      head: (d.images || [])[0]?.dataUrl.slice(0, 32) || '',
    });
  })()`);
  console.log('详情接口 →', res);

  // 打开界面抽屉并截图
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await ev(`(() => { [...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('禅道')).click(); return 1; })()`);
  await sleep(800);
  await ev(`(() => {
    const s = ${SETVAL};
    const root = document.querySelector('.pnl-body');
    const ins = [...root.querySelectorAll('input')];
    ['${ZT.baseUrl}', '${ZT.account}', '${ZT.password}'].forEach((v, i) => { if (ins[i]) s(ins[i], v); });
    return ins.length;
  })()`);
  await sleep(300);
  await ev(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('拉取我的 Bug')).click(); return 1; })()`);
  for (let i = 0; i < 40; i++) {
    const n = await ev(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`);
    if (n > 0) break;
    await sleep(1000);
  }
  // 点第一行打开抽屉
  await ev(`(() => { const t = document.querySelectorAll('.tbl'); const tr = t[t.length - 1].querySelector('tbody tr'); if (tr) tr.click(); return 1; })()`);
  await sleep(3500);

  const ui = await ev(`(() => JSON.stringify({
    drawer: !!document.querySelector('.drawer'),
    thumbs: document.querySelectorAll('.shot-thumb').length,
    imgsLoaded: [...document.querySelectorAll('.shot-thumb img')].filter(i => i.naturalWidth > 0).length,
    firstSize: (() => { const i = document.querySelector('.shot-thumb img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'none'; })(),
    steps: (document.querySelector('.drawer-steps')?.textContent || '').slice(0, 80),
  }))()`);
  console.log('抽屉界面 →', ui);

  const shotDir = path.join(ROOT, 'release', '_img-test');
  fs.mkdirSync(shotDir, { recursive: true });
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shotDir, 'drawer-images.png'), Buffer.from(png.data, 'base64'));
  console.log('截图 →', path.join(shotDir, 'drawer-images.png'));

  app.kill();
  await sleep(600);
  try { ws.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
})();
