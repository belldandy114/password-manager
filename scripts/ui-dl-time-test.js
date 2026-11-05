/**
 * 验证两件事：
 * 1) 禅道「· HH:mm 拉取」是本地时间（北京时间），不是 UTC
 * 2) 更新下载改用 Electron net 后能不能真的下下来（直连 / 镜像）
 *
 * node scripts/ui-dl-time-test.js [--download]
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9791;
const PASSWORD = 'DtTest#2026';
const ZT = require('./zt-config');
const DO_DOWNLOAD = process.argv.includes('--download');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-dt-'));
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

  // ---------- 1) 禅道拉取时间 ----------
  await ev(`(() => { [...document.querySelectorAll('.nav-item')].find(n => n.textContent.includes('禅道')).click(); return 1; })()`);
  await sleep(800);
  await ev(`(() => {
    const s = ${SETVAL};
    const root = document.querySelector('.pnl-body');
    const ins = [...root.querySelectorAll('input')];
    ['${ZT.baseUrl}', '${ZT.account}', '${ZT.password}'].forEach((v, i) => { if (ins[i]) s(ins[i], v); });
    return 1;
  })()`);
  await sleep(300);
  await ev(`(() => { [...document.querySelectorAll('button')].find(b => b.textContent.includes('拉取我的 Bug')).click(); return 1; })()`);
  for (let i = 0; i < 40; i++) {
    const n = await ev(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`);
    if (n > 0) break;
    await sleep(1000);
  }
  await sleep(600);
  const meta = await ev(`(() => {
    const list = [...document.querySelectorAll('.pnl-meta')].map(e => e.textContent);
    const hit = list.find(t => /拉取/.test(t));
    return hit || ('(没找到拉取时间: ' + list.join(' | ') + ')');
  })()`);
  const nowLocal = await ev(`(() => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); })()`);
  console.log(`禅道统计面板 → ${meta}`);
  console.log(`本机当前时间 → ${nowLocal}`);
  console.log(`>> 拉取时间是否为本地时间: ${String(meta).includes(nowLocal) ? 'PASS' : 'CHECK（可能跨分钟）'}`);

  // ---------- 2) 更新下载 ----------
  const info = await ev(`(async () => JSON.stringify(await window.electronAPI.updateCheck()))()`);
  console.log('updateCheck →', info);
  let dlUrl = '';
  try { dlUrl = JSON.parse(info)?.data?.downloadUrl || ''; } catch { /* 忽略 */ }

  // 兜底文案：传一个不存在的地址，应返回中文说明 + canMirror
  const bad = await ev(`(async () => {
    const r = await window.electronAPI.updateDownload('https://github.com/belldandy114/password-manager/releases/download/v9.9.9/none.exe');
    return JSON.stringify({ ok: r.success, canMirror: r.canMirror, error: (r.error || '').slice(0, 160) });
  })()`);
  console.log('坏地址兜底 →', bad);

  if (DO_DOWNLOAD && dlUrl) {
    const r = await ev(`(async () => {
      const t = Date.now();
      const r = await window.electronAPI.updateDownload(${JSON.stringify(dlUrl)});
      return JSON.stringify({ ms: Date.now() - t, ...r });
    })()`);
    console.log('直连下载 →', r);
    const obj = JSON.parse(r);
    if (!obj.success) {
      const m = await ev(`(async () => {
        const t = Date.now();
        const r = await window.electronAPI.updateDownload(${JSON.stringify(dlUrl)}, true);
        return JSON.stringify({ ms: Date.now() - t, ...r });
      })()`);
      console.log('镜像下载 →', m);
    }
  }

  app.kill();
  await sleep(600);
  try { ws.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
})();
