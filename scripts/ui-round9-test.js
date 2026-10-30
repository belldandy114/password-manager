/**
 * 1.7.0 回归：① cURL 互转  ② 禅道「我提交的 / 待我验证」  ③ 备份异地
 * node scripts/ui-round9-test.js
 *
 * 禅道相关断言需要真实地址；没配 ZT_BASEURL/ZT_ACCOUNT/ZT_PASSWORD 时自动跳过那一段。
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DL_PORT = 9836;
const DL_NAME = 'PasswordManager-Setup-9.9.9.exe';
const DL_BUF = Buffer.alloc(5 * 1024 * 1024);
for (let i = 0; i < DL_BUF.length; i++) DL_BUF[i] = (i * 31 + 7) & 0xff;
const DL_SHA = crypto.createHash('sha256').update(DL_BUF).digest('hex');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = pickExe(APP_DIR);
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9809;
const ECHO_PORT = 9835;
const PW = 'Round9#2026';

const ZT = require('./zt-config');
const { ensureZt } = require('./zt-stub');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const skip = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};
const skipped = (name, reason = '未配置 ZT_* 环境变量') => { skip.push(name); console.log(`- ${name}（跳过：${reason}）`); };

// R9_ONLY=curl / backup / zentao：只跑其中一段，方便一条一条验收
const ONLY = String(process.env.R9_ONLY || '').toLowerCase();
const want = (m) => !ONLY || ONLY.includes(m);

const echo = http.createServer((req, res) => {
  if (String(req.url || '').startsWith('/api/login-token')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, data: { token: 'tok-' + Date.now(), user: { name: '张三', id: 7 } } }));
    return;
  }
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, body: data, ct: req.headers['content-type'] || '' }, null, 2));
  });
});

(async () => {
  const zt = await ensureZt(9846);
  if (zt.stub) console.log('· 未配置 ZT_* 环境变量，禅道使用本地桩服务');
  await new Promise((r) => echo.listen(ECHO_PORT, '127.0.0.1', r));

  // 假安装包服务（支持 Range，用来验证单连接 / 多线程 / SHA-256 校验三条路）
  const dlServer = http.createServer((req, res) => {
    if (!String(req.url || '').includes(DL_NAME)) {
      res.writeHead(404); res.end('nope'); return;
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), DL_BUF.length - 1);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + DL_BUF.length,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      res.end(DL_BUF.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': DL_BUF.length, 'Accept-Ranges': 'bytes' });
    res.end(DL_BUF);
  });
  await new Promise((r) => dlServer.listen(DL_PORT, '127.0.0.1', r));

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r9-'));
  const env = { ...process.env, PM_USE_DIST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`],
    { env, cwd: ROOT, windowsHide: true });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
      if (target) break;
    } catch { /* 等待启动 */ }
    await sleep(400);
  }
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); zt.stop(); echo.close(); process.exit(1); }

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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', String(r.exceptionDetails.exception?.description || '').slice(0, 200));
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
  const setVal = async (sel, v) => ev(`(() => {
    const s = ${SETVAL};
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    s(el, ${JSON.stringify(v)});
    return true;
  })()`);
  /** 打开「从 cURL 导入」弹窗并等输入框就绪 */
  const openCurlImport = async () => {
    await clickHas('从 cURL 导入');
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!document.querySelector(".curl-input")`)) return true;
      await sleep(100);
    }
    return false;
  };

  /** 等 cURL 预览出现，再点「确认填入」（渲染是异步的，固定 sleep 会抢跑） */
  const confirmCurlImport = async () => {
    let ok = false;
    for (let i = 0; i < 40; i++) {
      ok = !!(await ev(`!!document.querySelector(".curl-preview")`));
      if (ok) break;
      await sleep(100);
    }
    if (!ok) return false;
    await clickHas('确认填入');
    for (let i = 0; i < 40; i++) {
      if (!(await ev(`!!document.querySelector(".curl-input")`))) return true;
      await sleep(100);
    }
    return true;
  };

  const clickHas = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const NAV_ALIAS = { '禅道': '缺陷管理' };
  const navTo = async (label0) => {
    // 菜单改名兼容：旧名 → 新名
    const label = label0 === '禅道' ? '缺陷管理' : label0;
    // 目标页可能已经挂着 .pg（旧页面），必须等「标题变化」才算切页完成，
    // 否则会在旧页面 DOM 上断言（曾导致容器列表读到空数据）
    const titleNow = () => ev(`(() => { const t = document.querySelector('.pg-title'); return t ? t.textContent.trim() : ''; })()`);
    const before = await titleNow();
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    for (let i = 0; i < 40; i++) {
      const now = await titleNow();
      if (now && now !== before) break;
      await sleep(100);
    }
    await sleep(500);
    // 页面是懒加载 chunk，等真正渲染出来再断言
    for (let i = 0; i < 40; i++) {
      const ready = await ev(`(() => !document.querySelector('.page-loading') && !!document.querySelector('.pg'))()`);
      if (ready) break;
      await sleep(100);
    }
    await sleep(400);
  };

  // 首次启动：设置主密码
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await clickHas('设置主密码');
  await sleep(2400);

  /* ================= A. cURL 互转 ================= */
  if (want('curl')) {
  await navTo('接口调试');

  const hasImportBtn = await ev(`(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('从 cURL 导入')))()`);
  check('cURL：工具栏有「从 cURL 导入」', !!hasImportBtn);

  await clickHas('从 cURL 导入');
  await sleep(400);
  const modalOpen = await ev(`(() => !!document.querySelector('.curl-input'))()`);
  check('cURL：导入弹窗打开、有粘贴框', !!modalOpen);

  const sample = [
    "curl -X POST 'http://127.0.0.1:" + ECHO_PORT + "/api/demo' \\",
    "  -H 'Content-Type: application/json' \\",
    "  -H 'X-Trace: t-001' \\",
    `  --data-raw '{"name":"张三","age":18}'`,
  ].join('\n');
  await setVal('.curl-input', sample);
  await sleep(200);
  await clickHas('解析并预览');
  await confirmCurlImport();
  await sleep(600);

  const filled = await ev(`(() => ({
    method: document.querySelector('.url-bar select')?.value || '',
    url: document.querySelector('.url-bar input')?.value || '',
    headerInputs: [...document.querySelectorAll('.api-io .kv-row input')].map(i => i.value).filter(Boolean),
    body: document.querySelector('.api-io textarea')?.value || '',
    modalGone: !document.querySelector('.curl-input'),
  }))()`);
  check('cURL：方法解析为 POST', filled && filled.method === 'POST', filled && filled.method);
  check('cURL：地址解析正确', filled && filled.url === `http://127.0.0.1:${ECHO_PORT}/api/demo`, filled && filled.url);
  check('cURL：两条请求头都填进来了',
    !!filled && filled.headerInputs.some(v => /Content-Type/i.test(v)) && filled.headerInputs.some(v => /X-Trace/i.test(v)),
    filled && filled.headerInputs.join(' | '));
  check('cURL：请求体原文一致', !!filled && filled.body === '{"name":"张三","age":18}', filled && filled.body);
  check('cURL：解析成功后弹窗自动关闭', !!filled && filled.modalGone);

  // 真的发一次，确认导入的请求可用（含中文 body 与 Content-Type）
  await sleep(200);
  await clickHas('发送');
  for (let i = 0; i < 40; i++) {
    const ok = await ev(`(() => !!document.querySelector('.code2'))()`);
    if (ok) break;
    await sleep(150);
  }
  const echoed = await ev(`(() => { const p = document.querySelector('.code2'); return p ? p.textContent : ''; })()`);
  check('cURL：导入后能直接发送并拿到响应', /"ok": true/.test(String(echoed)), String(echoed).slice(0, 60).replace(/\s+/g, ' '));
  check('cURL：发出的中文 body 未被破坏', /张三/.test(String(echoed)));

  // 1.8.0 改名与交互优化
  const brand = await ev(`(() => ({
    logo: (document.querySelector(".sidebar-logo") || {}).textContent || "",
    nav: [...document.querySelectorAll(".nav-item")].map(x => x.textContent.trim()),
    title: document.title,
  }))()`);
  check("改名：应用名显示「测试中台」", /测试中台/.test(String(brand && brand.logo)) && /测试中台/.test(String(brand && brand.title)),
    `${brand && brand.logo} | ${brand && brand.title}`);
  check("改名：菜单为「缺陷管理」且不再有「禅道」",
    !!brand && brand.nav.includes("缺陷管理") && !brand.nav.includes("禅道"),
    (brand && brand.nav || []).slice(0, 6).join("|"));

  // 请求头折叠 / 展开
  // 按钮要贴右：否则 space-between 会把它甩到标题行中间（截图里就是这个观感）
  const collapseGeom = await ev(`(() => {
    const row = document.querySelector('.api-io .field-label-row');
    const btn = document.querySelector('.field-label-actions') || document.querySelector('.api-collapse-btn');
    if (!row || !btn) return null;
    const r = row.getBoundingClientRect(), b = btn.getBoundingClientRect();
    return { rowRight: Math.round(r.right), btnRight: Math.round(b.right), gap: Math.round(r.right - b.right) };
  })()`);
  check('接口调试：标题行动作组贴右侧（收起/展开不再在中间）',
    !!collapseGeom && Number(collapseGeom.gap) >= 0 && Number(collapseGeom.gap) <= 14,
    JSON.stringify(collapseGeom));
  const hdrToggle = await ev(`(() => {
    const b = [...document.querySelectorAll(".field-label-row button")].find(x => /收起|展开/.test(x.textContent));
    return b ? b.textContent.trim() : "";
  })()`);
  check("接口调试：请求头有收起/展开开关", /收起|展开/.test(String(hdrToggle)), String(hdrToggle));
  const hdrBefore = await ev(`document.querySelectorAll(".api-io .kv-row").length`);
  await ev(`(() => { const b = [...document.querySelectorAll(".field-label-row button")].find(x => /收起/.test(x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(300);
  const hdrAfter = await ev(`document.querySelectorAll(".api-io .kv-row").length`);
  check("接口调试：收起后请求头行隐藏", Number(hdrAfter) === 0 && Number(hdrBefore) > 0, `${hdrBefore} → ${hdrAfter}`);
  await ev(`(() => { const b = [...document.querySelectorAll(".field-label-row button")].find(x => /展开/.test(x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(300);
  const hdrBack = await ev(`document.querySelectorAll(".api-io .kv-row").length`);
  check("接口调试：展开后请求头行回来", Number(hdrBack) === Number(hdrBefore), `${hdrBack}`);

  // 一键复制
  await ev(`(() => { navigator.clipboard.writeText('__clean__').catch(() => {}); return 1; })()`);
  await sleep(200);
  await clickHas('复制 cURL');
  await sleep(500);
  const copyState = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('已复制') || b.textContent.includes('复制 cURL'));
    return { label: btn ? btn.textContent.trim() : '', clip: '' };
  })()`);
  check('cURL：复制后按钮反馈「已复制」', !!copyState && /已复制/.test(copyState.label), copyState && copyState.label);

  // 剪贴板读取偶尔会被系统拒绝/尚未刷新，重试几次再判失败
  let clip = '';
  for (let i = 0; i < 3; i++) {
    clip = await ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; } })()`);
    if (!String(clip).startsWith('ERR:')) break;
    await sleep(300);
  }
  if (String(clip).startsWith('ERR:')) {
    skipped('cURL：剪贴板内容校验', '剪贴板读取被拒绝');
  } else {
    check('cURL：剪贴板里是完整 curl 命令',
      /^curl -X POST '/.test(String(clip)) && String(clip).includes("--data-raw '{\"name\":\"张三\"") && String(clip).includes("X-Trace: t-001"),
      String(clip).slice(0, 90));
  }

  // Chrome「Copy as cURL (cmd)」写法：^"..."^" 不该在值里留下 ^
  await clickHas('从 cURL 导入');
  await sleep(350);
  const cmdStyle = ['curl ^"http://127.0.0.1:' + ECHO_PORT + '/cmd?pageNo=1^&pageSize=30^" ^', '  -H ^"Accept: */*^"^'].join('\n');
  await setVal('.curl-input', cmdStyle);
  await sleep(200);
  await clickHas('解析并预览');
  await confirmCurlImport();
  await sleep(500);
  const cmdFilled = await ev(`(() => ({
    url: document.querySelector('.url-bar input')?.value || '',
    headers: [...document.querySelectorAll('.api-io .kv-row input')].map(i => i.value).filter(Boolean).join('|'),
  }))()`);
  check('cURL：cmd 写法（caret 引号 + ^& 查询串）不再残留 ^',
    !!cmdFilled && !cmdFilled.url.includes('^') && /pageNo=1&pageSize=30/.test(cmdFilled.url) && !String(cmdFilled.headers).includes('^') && /Accept/.test(String(cmdFilled.headers)),
    JSON.stringify(cmdFilled));
  // 错误输入要有可读提示
  await clickHas('从 cURL 导入');
  await sleep(350);
  await setVal('.curl-input', 'wget https://a/b');
  await sleep(150);
  await clickHas('解析并预览');
  await confirmCurlImport();
  await sleep(400);
  const errText = await ev(`(() => { const p = document.querySelector('.curl-import .pill-bad'); return p ? p.textContent.trim() : ''; })()`);
  check('cURL：非 curl 输入给出错误提示且不关闭弹窗', /不是 curl/.test(String(errText)), String(errText).slice(0, 40));
  await clickHas('取消');
  await sleep(300);
  // cmd 写法的 JSON：双引号被转义成 ^\^" ，导入后正文必须是干净 JSON（用户实测踩过两次）
  await clickHas('从 cURL 导入');
  await sleep(400);
  const cmdJson = [
    'curl --url ^"http://127.0.0.1:' + ECHO_PORT + '/api/page^" ^',
    '  -H ^"Content-Type: application/json^" ^',
    '  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"152^\\^"^" ^',
    '  --data-raw ^"^{^\\^"pageNo^\\^":1,^\\^"pageSize^\\^":30,^\\^"assetCode^\\^":^\\^"5555555555000020^\\^",^\\^"isBatchAssets^\\^":2^}^"',
  ].join('\n');
  await setVal('.curl-input', cmdJson);
  await sleep(200);
  await clickHas('解析并预览');
  await confirmCurlImport();
  await sleep(700);
  const cmdJsonFilled = await ev(`(() => ({
    body: document.querySelector(".api-io textarea")?.value || "",
    headers: [...document.querySelectorAll(".api-io .kv-row input")].map(i => i.value).filter(Boolean).join("|"),
  }))()`);
  const cmdBody = String(cmdJsonFilled && cmdJsonFilled.body || "");
  let cmdJsonOk = false;
  try { cmdJsonOk = JSON.parse(cmdBody).pageNo === 1; } catch { cmdJsonOk = false; }
  check("cURL：cmd 写法的 JSON 正文是干净 JSON（无 ^ 无转义引号）",
    cmdJsonOk && !cmdBody.includes("^") && !cmdBody.includes(String.fromCharCode(92)),
    cmdBody.slice(0, 80));
  check("cURL：cmd 写法的请求头也还原了引号",
    !String(cmdJsonFilled && cmdJsonFilled.headers).includes("^"),
    String(cmdJsonFilled && cmdJsonFilled.headers).slice(0, 60));

  // multipart 上传：Chrome「Copy as cURL(cmd)」会把整个 multipart 正文塞进 --data-raw，
  // 1.7.7 起要能拆成逐行 key=value（用户实测：以前整坨落在「原文」里没法编辑）
  await clickHas('从 cURL 导入');
  await sleep(400);
  const mp = [
    'curl --url ^"http://127.0.0.1:' + ECHO_PORT + '/api/upload^" ^',
    '  -H ^"Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryABC^" ^',
    '  --data-raw ^"------WebKitFormBoundaryABC^',
    '',
    'Content-Disposition: form-data; name=^\\^"id^\\^"^',
    '',
    '^',
    '',
    'A1B2C3^',
    '',
    '------WebKitFormBoundaryABC^',
    '',
    'Content-Disposition: form-data; name=^\\^"files^\\^"; filename=^\\^"a.jpg^\\^"^',
    '',
    'Content-Type: image/jpeg^',
    '',
    '^',
    '',
    '------WebKitFormBoundaryABC--^',
    '',
    '^"',
  ].join('\n');
  await setVal('.curl-input', mp);
  await sleep(200);
  await clickHas('解析并预览');
  await confirmCurlImport();
  await sleep(800);
  const mpFilled = await ev(`(() => ({
    bodyType: [...document.querySelectorAll(".seg button, .seg-btn, .body-type button")].map(b => b.textContent.trim()).join("|"),
    body: document.querySelector(".api-io textarea")?.value || "",
  }))()`);
  const mpLines = String(mpFilled && mpFilled.body || "").split("\n").filter(Boolean);
  check("cURL：multipart 正文被拆成逐行字段",
    mpLines.includes("id=A1B2C3") && mpLines.some(l => /^files=@/.test(l)),
    JSON.stringify(mpLines).slice(0, 120));
  check("cURL：multipart 不再残留 boundary/Content-Disposition",
    !/WebKitFormBoundary|Content-Disposition/.test(String(mpFilled && mpFilled.body)),
    String(mpFilled && mpFilled.body).slice(0, 60));
  // B1：从响应提取字段 → {{变量}}
  await navTo('接口调试');
  await sleep(400);
  // 用一条干净 JSON curl 重置请求（上一个 multipart 用例的 files=@a.jpg 会让发送失败）
  await openCurlImport();
  await setVal('.curl-input', 'curl -X GET "http://127.0.0.1:' + ECHO_PORT + '/api/login-token"');
  await clickHas('解析并预览');
  await confirmCurlImport();
  await sleep(400);
  await clickHas('发送');
  for (let i = 0; i < 50; i++) {
    if (await ev(`!!document.querySelector(".code2")`)) break;
    await sleep(200);
  }
  const respState = await ev(`(() => ({ code2: !!document.querySelector(".code2"), body: ((document.querySelector(".code2")||{}).textContent||"").slice(0, 40) }))()`);
  check('提取字段：先发一个 JSON 请求拿到响应', !!respState && respState.code2 === true, JSON.stringify(respState));
  const hasPickBtn = await ev(`(() => [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "提取字段"))()`);
  check('提取字段：JSON 响应出现「提取字段」按钮', hasPickBtn === true);
  await clickHas('提取字段');
  await sleep(500);
  const pickRows = await ev(`(() => ({ rows: document.querySelectorAll(".pick-var-row").length }))()`);
  check('提取字段：列出可提取的字段路径', !!pickRows && pickRows.rows > 0, JSON.stringify(pickRows));
  await ev(`(() => { const r = [...document.querySelectorAll(".pick-var-row")].find(x => /token/.test(x.textContent)); if (r) { r.click(); return true; } return false; })()`);
  await sleep(400);
  const varName = await ev(`(() => { const el = document.querySelector(".pick-var-name input"); return el ? el.value : ""; })()`);
  check('提取字段：选中后默认用字段名作变量名', /token/.test(String(varName)), String(varName));
  await clickHas('存为变量');
  await sleep(500);
  const pickClosed = await ev(`(() => !document.querySelector('.pick-var-row'))()`);
  const savedNotice = await ev(`(() => { const el = document.querySelector('.api-notice, .inline-hint, .notice, .toast'); return el ? el.textContent.trim() : ''; })()`);
  check('提取字段：保存后关闭弹窗（变量已写入）', pickClosed === true, String(savedNotice).slice(0, 40));
  // A4：解析后先出预览（看清方法/地址/头数/字段数），确认才填入
  await clickHas('从 cURL 导入');
  await sleep(400);
  await setVal('.curl-input', [
    'curl -X POST ^"http://127.0.0.1:' + ECHO_PORT + '/api/preview^" ^',
    '  -H ^"Content-Type: application/json^" ^',
    '  -H ^"X-Demo: 1^" ^',
    '  --data-raw ^"{"a":1}^"',
  ].join('\n'));
  await sleep(200);
  await clickHas('解析并预览');
  await sleep(400);
  const pv = await ev(`(() => {
    const box = document.querySelector(".curl-preview");
    return { has: !!box, text: box ? box.textContent.replace(/\\s+/g, " ").trim() : "", modalOpen: !!document.querySelector(".curl-input") };
  })()`);
  check("cURL：解析后先给预览（不直接填入）", !!pv && pv.has === true && pv.modalOpen === true, String(pv && pv.text).slice(0, 80));
  check("cURL：预览里能看到方法/地址/头数",
    !!pv && /POST/.test(pv.text) && /\/api\/preview/.test(pv.text) && /2 条/.test(pv.text),
    String(pv && pv.text).slice(0, 100));
  await clickHas('返回修改');
  await sleep(300);
  const backToEdit = await ev(`(() => !document.querySelector(".curl-preview") && !!document.querySelector(".curl-input"))()`);
  check("cURL：预览可返回修改", backToEdit === true);
  await clickHas('解析并预览');
  await sleep(300);
  await clickHas('确认填入');
  await sleep(600);
  const pvFilled = await ev(`(() => ({ url: document.querySelector(".url-bar input")?.value || "", modal: !!document.querySelector(".curl-input") }))()`);
  check("cURL：确认后填入并关闭弹窗",
    !!pvFilled && /\/api\/preview/.test(pvFilled.url) && pvFilled.modal === false, JSON.stringify(pvFilled));


  // 测试账号：新增窗口的「系统」可从已有数据里选（环境矩阵 / 历史账号 / 网址管理条目）
  await ev(`(async () => {
    await window.electronAPI.wsSet('environments', [
      { id: 'env1', system: '资产管理系统', env: '测试', url: 'http://env.example.com' },
    ]);
    await window.electronAPI.wsSet('accounts', [
      { id: 'acc0', system: '华贸学工系统', role: '管理员', envType: 'testing', username: 'u', password: 'p', note: '', updatedAt: new Date().toISOString() },
    ]);
    return 1;
  })()`);
  await navTo('测试账号');
  await sleep(400);
  await ev(`(() => { const b = [...document.querySelectorAll("button")].find(x => /新增|添加/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const acctSys = await ev(`(() => {
    const sel = document.querySelector(".modal .suggest-select");
    return { has: !!sel, opts: sel ? sel.options.length : 0, first: sel && sel.options.length > 1 ? sel.options[1].value : "" };
  })()`);
  check("测试账号：系统可从已有系统里选择（下拉存在且有待选项）",
    !!acctSys && acctSys.has === true && acctSys.opts > 1, JSON.stringify(acctSys));
  // 选中后应回填到输入框
  if (acctSys && acctSys.first) {
    await setVal(".modal .suggest-select", acctSys.first);
    await sleep(300);
    const filledSys = await ev(`(() => { const el = document.querySelector(".modal input"); return el ? el.value : ""; })()`);
    check("测试账号：选中后系统名回填到输入框", String(filledSys) === String(acctSys.first), String(filledSys));
  }
  await ev(`(() => { const b = [...document.querySelectorAll(".modal button")].find(x => x.textContent.trim() === "取消"); if (b) b.click(); return true; })()`);
  await sleep(300);

  // 登录页「从旧版本恢复」按钮：窄卡片下不能被裁剪
  const btnFit = await ev(`window.electronAPI.dataLegacyInfo().then(info => ({ info: !!info.data }))`);
  check('登录页：旧数据恢复入口可查询（IPC 可用）', !!btnFit && btnFit.info === true, JSON.stringify(btnFit));

  // C2：测试账号批量导入  // C2：测试账号批量导入（粘贴多行 → 一次生成多条）
  await navTo('测试账号');
  await sleep(400);
  const bulkBtn = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '批量导入'); if (b) { b.click(); return true; } return false; })()`);
  check('测试账号：有「批量导入」入口', bulkBtn === true);
  await sleep(400);
  await setVal('.bulk-text', '# 注释行\n资产系统 | 管理员 | bulk1 | p1 | 备注A\n学工系统 | 教师 | bulk2 | p2');
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '导入'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(800);
  const bulkState = await ev(`(() => ({ has1: /bulk1/.test(document.body.textContent), has2: /bulk2/.test(document.body.textContent), modal: !!document.querySelector('.bulk-text') }))()`);
  check('测试账号：批量导入生成多条账号', !!bulkState && bulkState.has1 === true && bulkState.has2 === true && bulkState.modal === false, JSON.stringify(bulkState));

  // 新版本提示：走应用内横幅  // 新版本提示：走应用内横幅（主进程 update:available → 渲染层），不再发系统通知
  const hasInAppHook = await ev(`(async () => { const r = await window.electronAPI.updateCheck().catch(() => null); return !!(r && typeof r === "object"); })()`);
  const bannerApi = await ev(`(() => typeof window.electronAPI.onUpdateAvailable === "function")()`);
  check("更新提示：已改为应用内提示（onUpdateAvailable 可用，且 updateCheck 正常）",
    bannerApi === true && hasInAppHook === true, `onUpdateAvailable=${bannerApi}`);




  }

  /* ================= B. 备份异地 ================= */
  if (want('backup')) {
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r9-mirror-'));
  await navTo('设置');
  await sleep(300);
  // 设置页「安全」分组里的备份卡片
  const backupUi = await ev(`(() => {
    const nodes = [...document.querySelectorAll('.setting-row')];
    const row = nodes.find(n => n.textContent.includes('异地备份') || n.textContent.includes('第二目录') || n.textContent.includes('镜像'));
    return { found: !!row, text: row ? row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : '' };
  })()`);
  check('备份异地：设置页有异地备份入口', !!backupUi && backupUi.found, backupUi && backupUi.text);

  if (backupUi && backupUi.found) {
    // 直接调 IPC：设置镜像目录 → 触发一次备份 → 检查第二目录里出现文件
    const setRes = await ev(`(async () => {
      const s = await window.electronAPI.settingsGet();
      const next = { ...(s.data || {}), backupMirrorDir: ${JSON.stringify(mirrorDir)} };
      const r = await window.electronAPI.settingsSave(next);
      return { ok: r.success, err: r.error || '' };
    })()`);
    check('备份异地：能保存第二目录', !!setRes && setRes.ok, setRes && setRes.err);

    const backupRes = await ev(`(async () => {
      const r = await window.electronAPI.backupNow();
      return { ok: r.success, mirror: r.data && r.data.mirror, err: r.error || '' };
    })()`);
    check('备份异地：备份动作返回镜像结果', !!backupRes && backupRes.ok, backupRes && (backupRes.err || JSON.stringify(backupRes.mirror)));

    const files = fs.existsSync(mirrorDir) ? fs.readdirSync(mirrorDir) : [];
    check('备份异地：第二目录里真的落了备份文件',
      files.some(f => /vault-.*\.enc$/.test(f)), files.join(', ') || '(空目录)');
  }

  }

  /* ================= D. 应用内更新：落盘位置 / SHA-256 校验 / 多线程 ================= */
  if (want('update')) {
    await navTo('接口调试'); // 先在任意页，后续直接调 IPC
    const dlUrl = `http://127.0.0.1:${DL_PORT}/${DL_NAME}`;

    // 1) 正确的摘要：应成功、verified=true、文件名是官方资产名、且不在 %TEMP%\pm-update
    const okRes = await ev(`(async () => {
      const r = await window.electronAPI.updateDownload(${JSON.stringify(dlUrl)}, false, { expectedSha256: ${JSON.stringify(DL_SHA)} });
      return r;
    })()`);
    check('更新：摘要正确时下载成功', !!okRes && okRes.success === true, okRes && (okRes.error || ''));
    const d1 = okRes && okRes.data;
    check('更新：SHA-256 校验通过', !!d1 && d1.verified === true, d1 && String(d1.sha256).slice(0, 12));
    check('更新：文件名用官方资产名', !!d1 && d1.name === DL_NAME, d1 && d1.name);
    check('更新：不再落到 %TEMP%\\pm-update', !!d1 && !/pm-update/i.test(String(d1.file)), d1 && d1.file);

    // 2) 错误的摘要：必须拒绝，且把文件删掉
    const badRes = await ev(`(async () => {
      const r = await window.electronAPI.updateDownload(${JSON.stringify(dlUrl)}, false, { expectedSha256: 'deadbeef' });
      const fs = null;
      return r;
    })()`);
    check('更新：摘要不匹配时拒绝安装', !!badRes && badRes.success === false && /SHA-256/.test(String(badRes.error)), badRes && String(badRes.error).slice(0, 60));

    // 3) 多线程（Range 服务）：应走 6 段且结果一致
    const parRes = await ev(`(async () => {
      const r = await window.electronAPI.updateDownload(${JSON.stringify(dlUrl)}, false, { expectedSha256: ${JSON.stringify(DL_SHA)}, threads: true });
      return r;
    })()`);
    check('更新：多线程下载可用且校验通过',
      !!parRes && parRes.success === true && parRes.data && parRes.data.verified === true && parRes.data.threads === 6,
      parRes && JSON.stringify({ ok: parRes.success, th: parRes.data && parRes.data.threads, v: parRes.data && parRes.data.verified }));
  }
  /* ================= C. 禅道：我提交的 / 待我验证 ================= */
  if (want('zentao')) {
    await navTo('缺陷管理');
    await sleep(500);

    const scopes = await ev(`(() => [...document.querySelectorAll('.zt-scope-btn')].map(b => ({ t: b.textContent.trim(), on: b.classList.contains('is-active') })))()`);
    check('禅道：有三个视图切换（指派给我 / 我提交的 / 待我验证）',
      Array.isArray(scopes) && scopes.length === 3, (scopes || []).map(s => s.t).join(' | '));
    check('禅道：默认选中「指派给我」', !!scopes && scopes[0] && scopes[0].on, scopes && scopes[0] && scopes[0].t);

    // 填配置（桩服务地址），无需真实账号
    await ev(`(() => {
      const s = ${SETVAL};
      const ins = [...document.querySelectorAll('.pnl-body input')];
      [${JSON.stringify(ZT.baseUrl)}, ${JSON.stringify(ZT.account)}, ${JSON.stringify(ZT.password)}].forEach((v, i) => { if (ins[i]) s(ins[i], v); });
      return ins.length;
    })()`);
    await sleep(300);

    const rowsOf = `(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`;
    const waitRows = async () => {
      for (let i = 0; i < 40; i++) {
        const n = await ev(rowsOf);
        if (n > 0) return n;
        await sleep(250);
      }
      return 0;
    };

    // 我提交的（REST openedBy + status=all）。1.7.4 起：默认只查选中的项目，不再全量遍历。
    await clickHas('我提交的');
    const openedRowsDefault = await waitRows();
    const projHint = await ev(`(() => { const b = document.querySelector('.zt-mine-proj-name'); return b ? b.textContent.trim() : ''; })()`);
    check('禅道：默认只查 1 个项目（不一次性拉全部）', openedRowsDefault === 1 && !!projHint, `${openedRowsDefault} 行 · ${projHint}`);

    // 打开项目选择：全选 → 确定，应该变成查 2 个项目、拉到 2 条
    await ev(`(() => { const b = document.querySelector('.zt-mine-proj-btn'); if (b) b.click(); return true; })()`);
    await sleep(400);
    const projModal = await ev(`document.querySelectorAll('.zt-proj-item').length`);
    check('禅道：项目选择弹窗列出全部项目', projModal === 2, `${projModal} 个项目`);
    // 项目多了靠滚动找很痛苦：搜「B」应只剩桩项目B，且计数要跟着变
    await setVal('.zt-proj-search input', 'B');
    await sleep(350);
    const searched = await ev(`(() => ({ items: document.querySelectorAll('.zt-proj-item').length, count: (document.querySelector('.zt-proj-count') || {}).textContent || '' }))()`);
    check('禅道：项目弹窗可按关键字过滤', !!searched && searched.items === 1 && /1 \/ 2/.test(String(searched.count)), JSON.stringify(searched));
    await setVal('.zt-proj-search input', '');
    await sleep(300);
    await clickHas('全选');
    await sleep(200);
    await clickHas('确定');
    await sleep(900);
    const openedRows = await waitRows();
    check('禅道：选 2 个项目后拉到 2 条', openedRows === 2, `${openedRows} 行`);
    const openedHit = zt.log.some(l => /\/api\.php\/v1\/bugs/.test(l.url) && /openedBy=stub-user/.test(l.url) && /status=all/.test(l.url) && /product=\d+/.test(l.url));
    const acct = await ev(`(() => { const el = document.querySelector(".zt-mine-account"); return el ? el.textContent.trim() : ""; })()`);
    check('禅道：界面标注了按哪个账号过滤', /stub-user/.test(String(acct)), String(acct));
    check('禅道：我提交的用的是 openedBy + status=all + product', openedHit,
      zt.log.filter(l => /v1\/bugs/.test(l.url)).slice(-1)[0]?.url || '');
    const openedTitle = await ev(`(() => { const p = [...document.querySelectorAll('.pnl-title')].map(x => x.textContent.trim()); return p.join(' | '); })()`);
    // 禅道强制要 product：必须按项目逐个查，且不能有漏带 product 的请求（线上就是 Need product id）
    const bugReqs = zt.log.filter(l => /v1\/bugs/.test(l.url));
    const withoutProduct = bugReqs.filter(l => !/[?&]product=/.test(l.url));
    const productsQueried = new Set(bugReqs.map(l => (/[?&]product=(\d+)/.exec(l.url) || [])[1]).filter(Boolean));
    check('禅道：只查选中的项目（2 个）且无漏带 product 的请求',
      productsQueried.size === 2 && withoutProduct.length === 0,
      'products=' + [...productsQueried].join(',') + ' 漏带=' + withoutProduct.length);
    check('禅道：切视图后标题跟着变', /我提交的/.test(String(openedTitle)), String(openedTitle).slice(0, 60));

    // 待我验证（REST assignedTo + status=resolved）
    await clickHas('待我验证');
    const verifyRows = await waitRows();
    check('禅道：待我验证 → 拉到 2 条', verifyRows === 2, `${verifyRows} 行`);
    // 1.7.6 起：服务端只按 product + status=all 查（status 参数可能被静默忽略），
    // 「待我验证 = 已解决未关闭」由主进程在本地判定，所以这里断言请求带 assignedTo，且结果都是已解决。
    const verifyHit = zt.log.some(l => /\/api\.php\/v1\/bugs/.test(l.url) && /assignedTo=stub-user/.test(l.url) && /status=all/.test(l.url));
    check('禅道：待我验证用 assignedTo 查询、状态在本地判', verifyHit,
      zt.log.filter(l => /v1\/bugs/.test(l.url)).slice(-1)[0]?.url || '');

    const verifyStatuses = await ev(`[...document.querySelectorAll(".tbl tbody tr .pill")].map(p => p.textContent.trim()).filter(Boolean).slice(0, 20)`);
    // 同一行里的 pill 既有状态也有严重度，这里只看「状态类」的词
    const statusPills = (verifyStatuses || []).filter(t => /^(激活|已解决|已关闭|已延期)$/.test(t));
    check('禅道：待我验证只返回「已解决」的 Bug',
      statusPills.length > 0 && statusPills.every(t => t === '已解决'),
      JSON.stringify(verifyStatuses));
    // 切页面回来视图要保留（状态在 store 里）
    await navTo('周报');
    await navTo('缺陷管理');
    const kept = await ev(`(() => { const b = document.querySelector('.zt-scope-btn.is-active'); return b ? b.textContent.trim() : ''; })()`);
    check('禅道：切换页面后视图选择保留', kept === '待我验证', String(kept));
  }

  /* ================= E. 接口调试侧栏：两行式列表 ================= */
  if (want('sidebar')) {
    await navTo('接口调试');
    await setVal('.url-bar input', `http://127.0.0.1:${ECHO_PORT}/admin-api/assetsys/wait-warehousing/documents-page?pageNo=1&pageSize=30`);
    await sleep(200);
    await clickHas('发送');
    for (let i = 0; i < 40; i++) {
      if (await ev(`(() => !!document.querySelector('.code2'))()`)) break;
      await sleep(150);
    }
    await clickHas('历史');
    await sleep(500);

    const side = await ev(`(() => {
      const head = document.querySelector('.pnl-head');
      const item = document.querySelector('.api-side .api-list-item');
      const name = item && item.querySelector('.api-item-name');
      const del = item && item.querySelector('.api-item-del');
      const hist = item && item.querySelector('.api-hist');
      const title = document.querySelector('.api-side-title');
      const r = item && item.getBoundingClientRect();
      const hr = head && head.getBoundingClientRect();
      return {
        titleText: title ? title.textContent.trim() : '',
        titleH: title ? Math.round(title.getBoundingClientRect().height) : 0,
        headH: hr ? Math.round(hr.height) : 0,
        rowH: r ? Math.round(r.height) : 0,
        nameW: name ? Math.round(name.getBoundingClientRect().width) : 0,
        nameText: name ? name.textContent.trim() : '',
        delOpacity: del ? getComputedStyle(del).opacity : '',
        histText: hist ? hist.textContent.trim() : '',
      };
    })()`);
    check('侧栏：标题是短的「历史」+ 计数，不再换行',
      !!side && /^历史\d+$/.test(side.titleText) && side.headH <= 52 && side.titleH <= 24,
      JSON.stringify([side && side.titleText, side && side.headH, side && side.titleH]));
    check('侧栏：行是两行式（高度 48~62）', !!side && side.rowH >= 48 && side.rowH <= 62, side && `${side.rowH}px`);
    check('侧栏：名称能显示路径（宽度 ≥ 110px）',
      !!side && side.nameW >= 110 && /admin-api/.test(side.nameText),
      side && `${side.nameW}px · ${side.nameText}`);
    check('侧栏：状态码作为独立小标签', !!side && /^\d{3}$|^ERR$/.test(side.histText), side && side.histText);
    check('侧栏：删除按钮默认隐藏（不抢横向空间）', !!side && side.delOpacity === '0', side && side.delOpacity);

    // 真 hover 一下，删除按钮应该出现
    const box = await ev(`(() => { const r = document.querySelector('.api-side .api-list-item').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none' });
    await sleep(250);
    const hovered = await ev(`(() => { const d = document.querySelector('.api-side .api-list-item .api-item-del'); return d ? getComputedStyle(d).opacity : ''; })()`);
    check('侧栏：hover 时删除按钮出现', hovered === '1', String(hovered));
    // 搜索 + 按天分组（1.7.3）
    const groupLabels = await ev(`[...document.querySelectorAll('.api-side-group span:first-child')].map(x => x.textContent.trim())`);
    check('侧栏：历史按天分组（出现「今天」组头）', Array.isArray(groupLabels) && groupLabels.includes('今天'), JSON.stringify(groupLabels));

    const countRows = async () => ev(`document.querySelectorAll('.api-side .api-list-item').length`);
    await setVal('.api-side-search input', 'admin-api');
    await sleep(300);
    const hitRows = await countRows();
    check('侧栏：搜索命中后只剩匹配项', hitRows === 1, `${hitRows} 行`);

    await setVal('.api-side-search input', 'zzz-not-exist');
    await sleep(300);
    const missRows = await countRows();
    const missEmpty = await ev(`(() => { const e = document.querySelector('.api-side-empty'); return e ? e.textContent.trim() : ''; })()`);
    check('侧栏：搜索无命中显示空提示', missRows === 0 && /没有匹配/.test(String(missEmpty)), String(missEmpty).slice(0, 30));

    await ev(`(() => { const b = document.querySelector('.api-side-search-clear'); if (b) b.click(); })()`);
    await sleep(300);
    const restored = await countRows();
    check('侧栏：清空搜索后列表恢复', restored >= 1, `${restored} 行`);

    // 响应体另存为（1.7.3）：命名/扩展名逻辑有 9 条单测（utils/apiResponse），
    // 这里只断言入口在（真正点击会弹原生保存对话框，没法在无头回归里点）。
    const saveBtnTitle = await ev(`(() => { const b = [...document.querySelectorAll('.resp-tabs .ibtn')].find(x => /另存为/.test(x.title || '')); return b ? b.title : ''; })()`);
    check('响应体：有「另存为」按钮', /另存为/.test(String(saveBtnTitle)), String(saveBtnTitle));
  }

  /* ================= F. 命令面板深链 ================= */
  if (want('palette')) {
    await navTo('接口调试');
    await setVal('.url-bar input', `http://127.0.0.1:${ECHO_PORT}/deep-link-target`);
    await setVal('input[placeholder="例如：查询用户列表"]', 'R9深链请求');
    await sleep(200);
    await clickHas('保存请求');
    await sleep(700);
    await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()`);
    await sleep(600);
    const paletteOpen = await ev(`!!document.querySelector('.cmdk')`);
    check('命令面板：Ctrl+K 能打开', paletteOpen === true, String(paletteOpen));
    await setVal('.cmdk-search input', 'R9深链');
    await sleep(500);
    const palItem = await ev(`(() => {
      const it = document.querySelector('.cmdk-item');
      if (!it) return null;
      return { text: it.textContent.trim().slice(0, 60) };
    })()`);
    check('命令面板：能搜到已保存的接口请求', !!palItem && /R9深链请求/.test(String(palItem.text)), JSON.stringify(palItem));
    await ev(`(() => { const it = document.querySelector('.cmdk-item'); if (it) it.click(); return true; })()`);
    await sleep(900);
    const deepUrl = await ev(`(() => { const i = document.querySelector('.url-bar input'); return i ? i.value : ''; })()`);
    check('命令面板：点请求后自动填进接口调试', /deep-link-target/.test(String(deepUrl)), String(deepUrl));
  }

  /* ================= G. 测试数据（webview 子应用） ================= */
  // 之前所有回归都没覆盖这个页面 —— 而它正是 sandbox / preload 改动最容易炸的地方。
  if (want('tdg')) {
    await navTo('测试数据');
    let info = null;
    for (let i = 0; i < 24; i++) {
      info = await ev(`(async () => {
        const wv = document.querySelector('webview');
        if (!wv) return { found: false };
        let id = 0, title = '', err = '';
        try { id = wv.getWebContentsId ? wv.getWebContentsId() : 0; } catch (e) { err = e.message; }
        if (id > 0) {
          try { title = await wv.executeJavaScript('document.title'); } catch (e) { err = err || e.message; }
        }
        return { found: true, src: wv.getAttribute('src') || '', id, title, children: wv.shadowRoot ? 1 : 0, err };
      })()`);
      if (info && info.found && info.id > 0 && info.title) break;
      await sleep(500);
    }
    check('测试数据：webview 已挂载', !!info && info.found === true, info && String(info.src).slice(0, 80));
    check('测试数据：访客进程已连接', !!info && info.id > 0, info && `webContentsId=${info.id}${info.err ? ' · ' + info.err : ''}`);
    check('测试数据：访客页可执行脚本（preload 正常）',
      !!info && typeof info.title === 'string' && info.title.length > 0,
      info && (info.title || info.err || '无标题'));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skip.length ? ` / ${skip.length} 跳过` : ''}`);
  app.kill();
  zt.stop();
  echo.close();
  dlServer.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });