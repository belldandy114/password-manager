/**
 * 1.5.0 回归：接口调试（历史可删 / Cookie 并入请求头 / 请求体分类发送）
 *             测试笔记自选目录、JSON 转化左右对齐
 * node scripts/ui-round6-test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
// 用 PM_USE_DIST=1 直接跑 dist（省一次打包）；EXE_PACKED 存在时可切回打包产物
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = path.join(APP_DIR, '测试工具.exe');
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9806;
const ECHO_PORT = 9831;
const PW = 'Round6#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/* ---------- 本地回显服务：验证请求体到底是怎么编码发出去的 ---------- */
const echo = { ct: '', body: '', method: '' };
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    echo.method = req.method;
    echo.ct = req.headers['content-type'] || '';
    echo.body = data;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ct: echo.ct, body: data, method: req.method }));
  });
});

(async () => {
  await new Promise((r) => server.listen(ECHO_PORT, '127.0.0.1', r));

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r6-'));
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r6-notes-'));
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
      // 开发模式下 DevTools 自己也是一个 page target，必须排除
      target = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
      if (target) break;
    } catch { /* 等待 */ }
    await sleep(400);
  }
  if (process.env.DEBUG6) console.log('DBG targets=', JSON.stringify(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().then(l => l.map(t => ({ type: t.type, url: t.url, title: t.title })))));
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); server.close(); return; }

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
    if (process.env.DEBUG6 && (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Runtime.consoleAPICalled')) {
      const d = msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.args?.map(a => a.value).slice(0, 3));
      console.log('DBG-CDP', String(d).slice(0, 300));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);

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
  const clickExact = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(t)});
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const clickHas = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    await sleep(800);
  };
  const setVal = async (sel, v) => ev(`(() => {
    const s = ${SETVAL};
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    s(el, ${JSON.stringify(v)});
    return true;
  })()`);

  const unlock = async () => {
    const locked = await ev(`(() => !!document.querySelector('input[type=password]'))()`);
    if (!locked) return;
    await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input[type=password]')]; if (ins[0]) s(ins[0], ${JSON.stringify(PW)}); return 1; })()`);
    await sleep(300);
    await clickHas('解锁');
    await sleep(2000);
  };

  // 首次启动：设置主密码
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await clickHas('设置主密码');
  await sleep(2400);
  if (process.env.DEBUG6) {
    console.log('DBG url=', String(await ev(`(() => location.href)()`)));
    console.log('DBG ready=', String(await ev(`(() => document.readyState)()`)));
    console.log('DBG root=', String(await ev(`(() => { const r = document.getElementById('root'); return r ? r.innerHTML.length : -1; })()`)));
    console.log('DBG locked=', await ev(`(() => !!document.querySelector('input[type=password]'))()`));
    console.log('DBG body=', String(await ev(`(() => document.body.textContent.slice(0, 200))()`)).replace(/\s+/g, ' '));
    console.log('DBG nav=', String(await ev(`(() => [...document.querySelectorAll('.nav-item')].map(n => n.textContent.trim()).join('|'))()`)));
  }

  /* ================= A. 接口调试：请求体分类 ================= */
  await navTo('接口调试');
  // GET/HEAD 不显示请求体类型，先切成 POST
  await ev(`(() => { const s = ${SETVAL}; const sel = document.querySelector('.url-bar select'); if (sel) s(sel, 'POST'); return !!sel; })()`);
  await sleep(400);

  const btns = await ev(`(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()))()`);
  const hasTypes = ['JSON', '表单', '文件', '原文', '无'].every((t) => (btns || []).includes(t));
  check('接口调试：请求体有 5 种发送类型', hasTypes, (btns || []).filter((b) => ['JSON', '表单', '文件', '原文', '无'].includes(b)).join('/'));

  const noCookieField = !(btns || []).some((t) => t === 'Cookie');
  const cookieBtn = (btns || []).filter((t) => t === 'Cookie').length;
  check('Cookie 不再单独一栏（并入请求头）', await ev(`(() => !document.body.textContent.includes('Cookie（一行一个'))()`));

  // 请求头里追加 Cookie 行
  await setVal('.kv-row input', 'X-Test');
  await clickHas('Cookie');
  await sleep(400);
  const cookieRow = await ev(`(() => [...document.querySelectorAll('.kv-row input')].map(i => i.value).join('|'))()`);
  check('请求头可一键加 Cookie 行', /Cookie/.test(String(cookieRow)), String(cookieRow));

  // 切「原文」→ 出现 Content-Type 输入框
  await clickExact('原文');
  await sleep(300);
  const rawCt = await ev(`(() => !!document.querySelector('input[placeholder*="Content-Type"]'))()`);
  check('请求体=原文：可自填 Content-Type', !!rawCt);

  // 切「文件」→ 出现选择文件按钮
  await clickExact('文件');
  await sleep(300);
  const mpBtn = await ev(`(() => !!document.querySelector('.mp-bar'))()`);
  const mpPh = await ev(`(() => { const t = document.querySelector('.api-io textarea'); return t ? t.placeholder : ''; })()`);
  check('请求体=文件：有选择文件入口且有提示', !!mpBtn && /@/.test(String(mpPh)), String(mpPh));

  // 切「无」→ 不显示正文框
  await clickExact('无');
  await sleep(300);
  check('请求体=无：隐藏正文输入框', await ev(`(() => !document.querySelector('.api-io textarea'))()`));

  /* ================= B. 真的发出去：三种编码 ================= */
  await clickExact('JSON');
  await sleep(200);
  await ev(`(() => { const s = ${SETVAL}; const sel = document.querySelector('.url-bar select'); s(sel, 'POST'); return 1; })()`);
  await setVal('.url-bar input', `http://127.0.0.1:${ECHO_PORT}/echo`);
  await setVal('.api-io textarea', '{"x":1}');
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.includes('发送')); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  check('JSON 发送：Content-Type=application/json', /application\/json/.test(echo.ct), echo.ct);
  check('JSON 发送：正文原样', echo.body === '{"x":1}', JSON.stringify(echo.body));

  await clickExact('表单');
  await sleep(200);
  await setVal('.api-io textarea', 'a=1\nb=2');
  await sleep(150);
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.includes('发送')); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  check('表单发送：x-www-form-urlencoded', /x-www-form-urlencoded/.test(echo.ct), echo.ct);
  check('表单发送：key=value 编码正确', echo.body === 'a=1&b=2', JSON.stringify(echo.body));

  // multipart：普通字段
  await clickExact('文件');
  await sleep(200);
  await setVal('.api-io textarea', 'desc=hello');
  await sleep(150);
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.includes('发送')); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  check('文件发送：multipart/form-data + boundary', /^multipart\/form-data; boundary=/.test(echo.ct), echo.ct.slice(0, 40));
  check('文件发送：普通字段进 body', /name="desc"[\s\S]*hello/.test(echo.body), echo.body.slice(0, 60).replace(/\r?\n/g, '\\n'));

  // multipart：真上传一个文件（value 以 @ 开头）
  const upFile = path.join(notesDir, 'upload.txt');
  fs.writeFileSync(upFile, 'hello-file-content');
  await setVal('.api-io textarea', `file=@${upFile.replace(/\\/g, '\\\\')}`);
  await sleep(150);
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.includes('发送')); if (b) b.click(); return !!b; })()`);
  await sleep(1600);
  check('文件发送：@路径会上传文件内容', /hello-file-content/.test(echo.body) && /filename="upload.txt"/.test(echo.body));

  // 响应面板正常
  const respText = await ev(`(() => { const p = document.querySelector('.code2'); return p ? p.textContent : ''; })()`);
  check('响应面板显示回显内容', /multipart|hello-file-content/.test(String(respText)));

  /* ================= C. 请求历史：单条删除 + 清空 ================= */
  await clickHas('历史');
  await sleep(600);
  const h1 = await ev(`(() => document.querySelectorAll('.api-side .api-list-item').length)()`);
  check('历史里有多条记录', h1 >= 4, `共 ${h1} 条`);
  await ev(`(() => { const it = document.querySelector('.api-side .api-list-item'); const b = it && it.querySelector('button'); if (b) b.click(); return !!b; })()`);
  await sleep(700);
  const h2 = await ev(`(() => document.querySelectorAll('.api-side .api-list-item').length)()`);
  check('历史单条可删除', h2 === h1 - 1, `${h1} → ${h2}`);

  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '清空请求历史'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  await clickHas('清空');
  await sleep(800);
  const h3 = await ev(`(() => document.querySelectorAll('.api-side .api-list-item').length)()`);
  const emptyTip = await ev(`(() => document.body.textContent.includes('还没有请求记录'))()`);
  check('历史可整体清空', h3 === 0 && !!emptyTip, `剩余 ${h3}`);

  /* ================= D. 测试笔记：自选目录 ================= */
  await ev(`(() => { localStorage.setItem('pm.notes.dir', ${JSON.stringify(notesDir)}); location.reload(); return 1; })()`).catch(() => {});
  await sleep(2500);
  await unlock();
  await navTo('测试笔记');
  const dirbar = await ev(`(() => { const b = document.querySelector('.notes-dirbar'); return b ? b.textContent : ''; })()`);
  check('笔记：显示当前笔记目录', String(dirbar).includes(path.basename(notesDir)), String(dirbar).slice(0, 60));

  // 新建 → 落盘成 .md
  await clickHas('新建笔记');
  await sleep(600);
  await ev(`(() => {
    const s = ${SETVAL};
    const m = document.querySelector('.modal');
    const ins = [...m.querySelectorAll('input')];
    s(ins[0], '登录偶发500排查');
    const ta = m.querySelector('textarea');
    s(ta, '## 现象\\n登录偶发 500');
    return 1;
  })()`);
  await sleep(300);
  await clickHas('保存到目录');
  await sleep(1200);
  const created = fs.existsSync(path.join(notesDir, '登录偶发500排查.md'));
  const content1 = created ? fs.readFileSync(path.join(notesDir, '登录偶发500排查.md'), 'utf8') : '';
  check('笔记：保存后目录里出现 .md 文件', created);
  check('笔记：文件内容正确', content1.includes('登录偶发 500'), content1.split('\n')[0]);

  // 卡片列出
  await sleep(600);
  const cardTitles = await ev(`(() => [...document.querySelectorAll('.card2-title')].map(x => x.textContent))()`);
  check('笔记：目录里的文件在页面上列出', (cardTitles || []).some((t) => t.includes('登录偶发500排查')), JSON.stringify(cardTitles));

  // 改标题 → 文件重命名
  await ev(`(() => { const b = [...document.querySelectorAll('.card2-actions button')][0]; if (b) b.click(); return !!b; })()`);
  await sleep(700);
  await ev(`(() => {
    const s = ${SETVAL};
    const m = document.querySelector('.modal');
    s([...m.querySelectorAll('input')][0], '登录500_已解决');
    return 1;
  })()`);
  await sleep(200);
  await clickHas('保存到目录');
  await sleep(1200);
  check('笔记：改标题会重命名文件',
    fs.existsSync(path.join(notesDir, '登录500_已解决.md')) && !fs.existsSync(path.join(notesDir, '登录偶发500排查.md')));

  // 删除 → 进回收站（文件不在目录里）
  await sleep(500);
  await ev(`(() => { const b = [...document.querySelectorAll('.card2-actions button')][1]; if (b) b.click(); return !!b; })()`);
  await sleep(600);
  await clickHas('删除');
  await sleep(1200);
  check('笔记：删除后文件从目录移除', !fs.existsSync(path.join(notesDir, '登录500_已解决.md')));

  // 改回本地库
  await clickHas('改回本地库');
  await sleep(700);
  check('笔记：可改回加密本地库', await ev(`(() => !document.querySelector('.notes-dirbar'))()`));

  /* ================= E. JSON 转化：左右对齐 ================= */
  await navTo('JSON 转化');
  await sleep(600);
  await ev(`(() => {
    const s = ${SETVAL};
    const ta = document.querySelector('textarea');
    s(ta, '{"name": "张三", "age": 25, "city": "北京"}');
    return 1;
  })()`);
  await sleep(300);
  await clickHas('转化');
  await sleep(800);

  const geo = await ev(`(() => {
    const heads = [...document.querySelectorAll('div')].filter(d => d.style.height === '36px');
    const panes = [...document.querySelectorAll('textarea, div')].filter(e => e.style.scrollbarGutter === 'stable');
    const r = (e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { heads: heads.map(r), panes: panes.map(r) };
  })()`);
  const H = geo.heads || [];
  const P = geo.panes || [];
  check('JSON 转化：左右标题条同高同行', H.length >= 2 && H[0].top === H[1].top && H[0].h === H[1].h,
    JSON.stringify(H));
  check('JSON 转化：输入/输出正文区同宽同行', P.length >= 2 && P[0].w === P[1].w && P[0].top === P[1].top,
    JSON.stringify(P));

  const outOk = await ev(`(() => { const p = [...document.querySelectorAll('div')].filter(e => e.style.scrollbarGutter === 'stable')[0]; return p ? p.textContent.includes('"name"') : false; })()`);
  check('JSON 转化：输出正常渲染', !!outOk);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.kill();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
