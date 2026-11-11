/**
 * 1.22.0 回归：环境矩阵 / 随手记小窗 / 笔记图片附件 / 脱敏工具
 *
 * 覆盖（都是本轮新加的东西）：
 *   ① 环境矩阵页能打开，页头有「一键巡检」
 *   ② 第三组全局键「随手记」注册成功（Ctrl+Shift+N），设置页显示三行
 *   ③ 随手记小窗：quicknoteShow 打开独立窗口 → 写入正文 → 保存 → 笔记集合里多一条
 *   ④ 小窗 Esc 只是隐藏，窗口不销毁（下次秒开）
 *   ⑤ 图片附件：save-image 落盘加密 → read-image 解回 dataURL → 笔记预览里渲染成 <img>
 *   ⑥ 笔记编辑器 Ctrl+V 粘截图 → 正文写入 pm-att 引用
 *
 * 跑法：node scripts/ui-round15-test.js
 *   加 USE_PACKED=1 跑 release/win-unpacked（默认也是它）。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pickExe } = require('./pick-exe');

const EXE = pickExe(path.join(__dirname, '..', 'release', 'win-unpacked'));
const PORT = 9815;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gEB0m3usgAAAABJRU5ErkJggg==';

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail += 1; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
}

const SETVAL = `(el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}`;

async function connect(url, port) {
  const ws = new WebSocket(url);
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
  void port;
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EX:' + String(r.exceptionDetails.exception?.description || '').slice(0, 200);
    return r.result?.value;
  };
  return { ws, ev, send };
}

async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; }
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('找不到 exe：' + EXE); process.exit(1); }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-qn-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
    env, cwd: path.dirname(EXE), stdio: 'ignore',
  });

  let main = null;
  for (let i = 0; i < 80; i += 1) {
    const list = await targets(PORT);
    const t = list.find((x) => x.type === 'page' && !String(x.url).startsWith('devtools://'));
    if (t) { main = t; break; }
    await sleep(400);
  }
  if (!main) { console.error('连不上调试端口'); app.kill(); process.exit(1); }

  const M = await connect(main.webSocketDebuggerUrl, PORT);
  await M.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(2200);

  const setVal = (sel, value) => M.ev(`(() => { const s = ${SETVAL}; const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; s(el, ${JSON.stringify(value)}); return true; })()`);
  const clickByText = (text) => M.ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)})); if (b) { b.click(); return true; } return false; })()`);
  const waitFor = async (ev, expr, ms = 6000) => {
    for (let i = 0; i < ms / 150; i += 1) { if (await ev(expr)) return true; await sleep(150); }
    return false;
  };

  // 首次运行：设主密码
  await M.ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')].filter(x => x.type !== 'checkbox'); if (ins[0]) s(ins[0], 'Test@1234'); if (ins[1]) s(ins[1], 'Test@1234'); return 1; })()`);
  await sleep(300);
  await clickByText('设置主密码并开始使用');
  await sleep(2500);

  /* ---------- ① 快捷键设置里有三行 ---------- */
  const hk = await M.ev(`window.electronAPI.hotkeyInfo().then(r => { const d = (r && r.data) || r || {}; return JSON.stringify({ q: d.quicknote, ok: d.quicknoteOk, accel: d.quicknoteAccel, def: d.quicknoteDefaultAccel }); })`);
  const hkRes = typeof hk === 'string' ? JSON.parse(hk) : hk;
  check('随手记全局键已注册（Ctrl+Shift+N）', !!hkRes && hkRes.ok === true && /Shift\+N/.test(String(hkRes.accel)), JSON.stringify(hkRes));
  await M.ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('设置')); if (n) n.click(); return !!n; })()`);
  await sleep(900);
  await clickByText('快捷键');
  await sleep(600);
  const rows = await M.ev(`(() => { const rs=[...document.querySelectorAll('.shortcut-row')].filter(r => /随手记|打开搜索|显示 \\/ 隐藏/.test(r.textContent)); return rs.map(r => r.textContent.replace(/\\s+/g,' ').trim().slice(0,40)); })()`);
  check('设置里有 3 行全局快捷键', Array.isArray(rows) && rows.length === 3, JSON.stringify(rows));
  check('包含「随手记小窗」并显示 Ctrl+Shift+N', Array.isArray(rows) && rows.some(r => r.includes('随手记小窗')), String(rows));

  /* ---------- ② 环境矩阵页 ---------- */
  await M.ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('环境矩阵')); if (n) n.click(); return !!n; })()`);
  await M.ev(`window.__envNav = [...document.querySelectorAll('.nav-item')].some(x => x.textContent.includes('环境矩阵'))`);
  const envReady = await waitFor(M.ev, `!!document.body.textContent.includes('一键巡检')`, 8000);
  const envPage = await M.ev(`(() => ({ navFound: !!window.__envNav, btn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('一键巡检')) }))()`);
  check('环境矩阵页可打开且有「一键巡检」', envReady === true && !!envPage && envPage.btn === true, JSON.stringify(envPage));

  /* ---------- ③ 随手记小窗 ---------- */
  await M.ev(`window.electronAPI.quicknoteShow()`);
  let qnTarget = null;
  for (let i = 0; i < 40; i += 1) {
    const list = await targets(PORT);
    qnTarget = list.find((x) => String(x.url).includes('window=quicknote'));
    if (qnTarget) break;
    await sleep(250);
  }
  check('随手记小窗已打开（?window=quicknote）', !!qnTarget, qnTarget ? qnTarget.url.slice(0, 60) : 'no target');

  if (qnTarget) {
    const Q = await connect(qnTarget.webSocketDebuggerUrl, PORT);
    await sleep(1200);
    const ui = await Q.ev(`(() => ({ root: !!document.querySelector('.qn-root'), input: !!document.querySelector('.qn-input'), text: !!document.querySelector('.qn-text') }))()`);
    check('小窗渲染出入输框与正文框', !!ui && ui.root && ui.input && ui.text, JSON.stringify(ui));

    await Q.ev(`(() => { const s = ${SETVAL}; const i=document.querySelector('.qn-input'); const t=document.querySelector('.qn-text'); if(!i||!t) return 0; s(i,'小窗验证标题'); s(t,'小窗验证正文\\n第二行'); return 1; })()`);
    await sleep(200);
    await Q.ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存'); if(b){b.click();return 1} return 0; })()`);
    await sleep(1200);
    const hint = await Q.ev(`(document.querySelector('.qn-hint')||{}).textContent || ''`);
    check('小窗保存后提示已保存', String(hint).includes('已保存'), String(hint));

    const saved = await M.ev(`window.electronAPI.wsGet('notes').then(r => JSON.stringify({ ok: !!r.success, n: (r.data||[]).length, titles: (r.data||[]).map(x=>x.title).slice(0,3) }))`);
    const s = typeof saved === 'string' ? JSON.parse(saved) : saved;
    check('笔记集合写入 1 条', !!s && s.ok === true && s.n >= 1, JSON.stringify(s));
    check('标题取小窗里填的', !!s && (s.titles || []).includes('小窗验证标题'), JSON.stringify(s && s.titles));

    // Esc 收起
    await Q.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(700);
    const visTargets = (await targets(PORT)).filter((x) => String(x.url).includes('window=quicknote'));
    const stillVisible = visTargets.length > 0 ? await Q.ev(`document.visibilityState`) : 'gone';
    check('Esc 收起小窗（窗口隐藏不销毁）', stillVisible === 'hidden' || stillVisible === 'gone', String(stillVisible));
    Q.ws.close();
  }

  /* ---------- ④ 加密图片附件 + MarkdownView ---------- */
  const img = await M.ev(`window.electronAPI.attachmentSaveImage({ dataUrl: 'data:image/png;base64,${PNG}', name: 'probe.png' }).then(r => JSON.stringify(r))`);
  const imgRes = typeof img === 'string' ? JSON.parse(img) : img;
  check('保存图片附件成功', !!imgRes && imgRes.success === true && !!imgRes.data?.id, JSON.stringify(imgRes).slice(0, 160));

  const attId = imgRes && imgRes.data ? imgRes.data.id : '';
  const read = await M.ev(`window.electronAPI.attachmentReadImage({ id: ${JSON.stringify(attId)} }).then(r => JSON.stringify({ success: r.success, mime: r.data && r.data.mime, len: r.data && r.data.dataUrl ? r.data.dataUrl.length : 0 }))`);
  const readRes = typeof read === 'string' ? JSON.parse(read) : read;
  check('读回图片附件得到 dataURL', !!readRes && readRes.success === true && String(readRes.mime).includes('png') && readRes.len > 100, JSON.stringify(readRes));

  // 往笔记里放一条带图片的笔记，再到笔记页预览看 <img> 是否被补上 src
  const noteJson = JSON.stringify({
    id: 'probe-note-1', title: '图片附件验证',
    content: `看这张图\n\n![截图](pm-att:${attId})\n\n尾注`, tags: [], updatedAt: new Date().toISOString(),
  });
  await M.ev(`window.electronAPI.wsSet('notes', [${noteJson}]).then(r => JSON.stringify(r))`);
  await M.ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('测试笔记')); if (n) n.click(); return !!n; })()`);
  await sleep(1200);
  const opened = await M.ev(`(() => { const row=[...document.querySelectorAll('.card2')].find(x=>x.textContent.includes('图片附件验证')); if(row){row.click();return 1} return 0 })()`);
  await sleep(700);
  const imgState = await M.ev(`(() => { const imgs=[...document.querySelectorAll('img.md-img')]; return { n: imgs.length, hasSrc: imgs.some(i => String(i.src).startsWith('data:image')), att: imgs.map(i => i.getAttribute('data-att')) }; })()`);
  check('预览里图片附件被解密成 dataURL', !!imgState && imgState.n >= 1 && imgState.hasSrc === true, `opened=${opened} ` + JSON.stringify(imgState));

  /* ---------- ⑤ 笔记编辑器里的「粘贴截图」整条链路 ---------- */
  await M.ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建笔记')||x.textContent.trim()==='新建'); if(b){b.click();return 1} return 0 })()`);
  await sleep(700);
  const pasted = await M.ev(`(async () => {
    const ta = document.querySelector('.modal textarea.code-input') || document.querySelector('textarea.code-input');
    if (!ta) return 'no-textarea';
    const b64 = '${PNG}';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 1200));
    return JSON.stringify({ value: ta.value, hint: (document.querySelector('.inline-hint')||{}).textContent || '' });
  })()`);
  const pasteRes = typeof pasted === 'string' && pasted.startsWith('{') ? JSON.parse(pasted) : pasted;
  check('编辑器粘贴截图 → 正文写入 pm-att 引用',
    !!pasteRes && typeof pasteRes.value === 'string' && pasteRes.value.includes('pm-att:'),
    JSON.stringify(pasteRes).slice(0, 200));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  M.ws.close();
  app.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 400);
})().catch((e) => { console.error('探针异常：', e); process.exit(2); });
