/**
 * 1.7.0 回归：① cURL 互转  ② 禅道「我提交的 / 待我验证」  ③ 备份异地
 * node scripts/ui-round9-test.js
 *
 * 禅道相关断言需要真实地址；没配 ZT_BASEURL/ZT_ACCOUNT/ZT_PASSWORD 时自动跳过那一段。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = path.join(APP_DIR, '测试工具.exe');
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
  const clickHas = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
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
  await clickHas('解析并填入');
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

  const clip = await ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; } })()`);
  if (String(clip).startsWith('ERR:')) {
    skipped('cURL：剪贴板内容校验', '剪贴板读取被拒绝');
  } else {
    check('cURL：剪贴板里是完整 curl 命令',
      /^curl -X POST '/.test(String(clip)) && String(clip).includes("--data-raw '{\"name\":\"张三\"") && String(clip).includes("X-Trace: t-001"),
      String(clip).slice(0, 90));
  }

  // 错误输入要有可读提示
  await clickHas('从 cURL 导入');
  await sleep(350);
  await setVal('.curl-input', 'wget https://a/b');
  await sleep(150);
  await clickHas('解析并填入');
  await sleep(400);
  const errText = await ev(`(() => { const p = document.querySelector('.curl-import .pill-bad'); return p ? p.textContent.trim() : ''; })()`);
  check('cURL：非 curl 输入给出错误提示且不关闭弹窗', /不是 curl/.test(String(errText)), String(errText).slice(0, 40));
  await clickHas('取消');
  await sleep(300);

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

  /* ================= C. 禅道：我提交的 / 待我验证 ================= */
  if (want('zentao')) {
    await navTo('禅道');
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

    // 我提交的（REST openedBy + status=all）
    await clickHas('我提交的');
    const openedRows = await waitRows();
    check('禅道：我提交的 → 拉到 2 条', openedRows === 2, `${openedRows} 行`);
    const openedHit = zt.log.some(l => /\/api\.php\/v1\/bugs/.test(l.url) && /openedBy=stub-user/.test(l.url) && /status=all/.test(l.url));
    check('禅道：我提交的用的是 openedBy + status=all', openedHit,
      zt.log.filter(l => /v1\/bugs/.test(l.url)).slice(-1)[0]?.url || '');
    const openedTitle = await ev(`(() => { const p = [...document.querySelectorAll('.pnl-title')].map(x => x.textContent.trim()); return p.join(' | '); })()`);
    check('禅道：切视图后标题跟着变', /我提交的/.test(String(openedTitle)), String(openedTitle).slice(0, 60));

    // 待我验证（REST assignedTo + status=resolved）
    await clickHas('待我验证');
    const verifyRows = await waitRows();
    check('禅道：待我验证 → 拉到 2 条', verifyRows === 2, `${verifyRows} 行`);
    const verifyHit = zt.log.some(l => /\/api\.php\/v1\/bugs/.test(l.url) && /assignedTo=stub-user/.test(l.url) && /status=resolved/.test(l.url));
    check('禅道：待我验证用的是 assignedTo + status=resolved', verifyHit,
      zt.log.filter(l => /v1\/bugs/.test(l.url)).slice(-1)[0]?.url || '');

    // 切页面回来视图要保留（状态在 store 里）
    await navTo('周报');
    await navTo('禅道');
    const kept = await ev(`(() => { const b = document.querySelector('.zt-scope-btn.is-active'); return b ? b.textContent.trim() : ''; })()`);
    check('禅道：切换页面后视图选择保留', kept === '待我验证', String(kept));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skip.length ? ` / ${skip.length} 跳过` : ''}`);
  app.kill();
  zt.stop();
  echo.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
