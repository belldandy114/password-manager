/**
 * ui-round4-test.js —— 1.3.0 新功能回归
 *   ① Bug 详情抽屉   ② 筛选预设   ③ 周报生成草稿
 *   ④ 接口调试：环境 + 历史   ⑤ 命令面板 Ctrl+K   ⑥ 工具箱新增 4 个工具
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(APP_DIR, '测试工具.exe');
const PORT = 9741;
const PASSWORD = 'Round4#2026';
const ZT = { base: 'http://zentao.example.com/zentao', account: 'REDACTED_ACCOUNT', password: 'REDACTED_PASSWORD' };

if (!fs.existsSync(EXE)) { console.error('找不到主程序：' + EXE); process.exit(1); }
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r4-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? '  → ' + detail : ''}`);
};

(async () => {
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    { env, cwd: APP_DIR, windowsHide: true });
  app.on('exit', code => { if (code !== null && code !== 0) console.log(`[应用退出] code=${code}`); });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* starting */ }
    await sleep(400);
  }
  if (!target) { console.error('连不上应用'); app.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise(resolve => {
    const i = ++id; pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') console.log('  [页面异常] ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 180));
  };
  ws.onclose = () => console.log('  [!!] 调试连接断开');
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);

  const evaluate = async (expr, tag = '') => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      new Promise(res => setTimeout(() => res(null), 40000)),
    ]);
    if (!r) { console.log('  [超时] ' + tag); return undefined; }
    if (r.exceptionDetails) console.log('  [异常] ' + tag + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 180));
    return r.result ? r.result.value : undefined;
  };
  const SETVAL = `(el, v) => {
    const isSel = el.tagName === 'SELECT';
    const isArea = el.tagName === 'TEXTAREA';
    const proto = isSel ? window.HTMLSelectElement.prototype : isArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value').set;
    d.call(el, v);
    el.dispatchEvent(new Event(isSel ? 'change' : 'input', { bubbles: true }));
  }`;
  const nav = (label) => evaluate(`(() => { const n = Array.from(document.querySelectorAll('.nav-item')).find(e => e.textContent.includes(${JSON.stringify(label)})); if (n) { n.click(); return true; } return false; })()`);
  const clickText = (text, scope = 'document') => evaluate(`(() => { const b = Array.from(${scope}.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (b) { b.click(); return true; } return false; })()`);

  try {
    // 解锁
    await evaluate(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return ins.length; })()`);
    await sleep(400);
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); b.click(); return true; })()`);
    await sleep(2200);
    check('界面解锁', await evaluate(`!!document.querySelector('.sidebar')`));

    /* ---------- 禅道：拉数据 ---------- */
    await nav('禅道');
    await sleep(900);
    await evaluate(`(() => { const ins = Array.from(document.querySelectorAll('.pnl-body input')); if (ins.length < 3) { const head = Array.from(document.querySelectorAll('.pnl-head.is-clickable')).find(h => h.textContent.includes('连接配置')); if (head) head.click(); } return ins.length; })()`);
    await sleep(400);
    await evaluate(`(() => { const set = ${SETVAL}; const root = document.querySelector('.pnl-body'); const ins = Array.from(root.querySelectorAll('input')); const vals = ${JSON.stringify([ZT.base, ZT.account, ZT.password])}; vals.forEach((v, i) => { if (ins[i]) set(ins[i], v); }); return ins.length; })()`);
    await sleep(300);
    await clickText('拉取我的 Bug');
    let bugRows = 0;
    for (let i = 0; i < 45; i++) {
      bugRows = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`);
      if (bugRows > 0) break;
      await sleep(1000);
    }
    check('我的 Bug 已加载', bugRows > 0, `${bugRows} 行`);

    /* ---------- ① Bug 详情抽屉 ---------- */
    await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); const tr = t[t.length - 1].querySelector('tbody tr'); if (tr) { tr.click(); return true; } return false; })()`);
    let drawerSteps = '';
    for (let i = 0; i < 30; i++) {
      drawerSteps = await evaluate(`(() => { const el = document.querySelector('.drawer-steps'); return el ? el.textContent : ''; })()`);
      if (drawerSteps) break;
      await sleep(700);
    }
    check('Bug 详情抽屉打开并加载重现步骤', !!drawerSteps, String(drawerSteps).slice(0, 40).replace(/\n/g, ' '));
    check('抽屉里有复制汇报文本按钮', await evaluate(`(() => Array.from(document.querySelectorAll('.drawer-foot button')).some(b => b.textContent.includes('复制汇报文本')))()`));
    await evaluate(`(() => { const b = document.querySelector('.drawer .ibtn'); if (b) b.click(); return true; })()`);
    await sleep(400);

    /* ---------- ② 筛选预设 ---------- */
    await clickText('存预设');
    await sleep(500);
    await evaluate(`(() => { const set = ${SETVAL}; const inp = document.querySelector('.modal input'); set(inp, '我的未关闭'); return true; })()`);
    await sleep(200);
    await clickText('保存', 'document.querySelector(".modal")');
    await sleep(900);
    const presetOpts = await evaluate(`(() => { const s = document.querySelector('.zt-preset'); return s ? s.options.length : 0; })()`);
    check('筛选预设保存成功', presetOpts > 1, `${presetOpts - 1} 个预设`);

    /* ---------- ③ 周报生成草稿 ---------- */
    await nav('周报');
    await sleep(1000);
    await clickText('生成草稿');
    await sleep(800);
    const draft = await evaluate(`(() => { const ta = document.querySelector('.wk-md-input'); return ta ? ta.value : ''; })()`);
    check('周报草稿已生成', String(draft).includes('本周工作') && String(draft).includes('禅道缺陷'), JSON.stringify(draft).slice(0, 60));

    /* ---------- ④ 接口调试：环境 + 历史 ---------- */
    await nav('接口调试');
    await sleep(900);
    // 发一个真实请求（禅道登录页）
    await evaluate(`(() => { const set = ${SETVAL}; const bar = document.querySelector('.url-bar input'); set(bar, '${ZT.base}/user-login.html'); return true; })()`);
    await sleep(200);
    await clickText('发送');
    let histCount = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(800);
      histCount = await evaluate(`(() => { const b = Array.from(document.querySelectorAll('.tab2')).find(x => x.textContent.trim() === '历史'); if (b) b.click(); return 1; })()`);
      const n = await evaluate(`(() => document.querySelectorAll('.api-hist').length)()`);
      if (n > 0) { histCount = n; break; }
    }
    check('请求历史已记录', histCount > 0, `${histCount} 条`);

    // 新建环境
    await clickText('环境');
    await sleep(600);
    await evaluate(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('.modal input')); if (ins[0]) set(ins[0], '测试环境'); const ta = document.querySelector('.modal textarea'); if (ta) set(ta, 'baseUrl=${ZT.base}'); return true; })()`);
    await sleep(300);
    await clickText('保存', 'document.querySelector(".modal")');
    await sleep(800);
    const envOpts = await evaluate(`(() => { const s = document.querySelector('.api-env-row select'); return s ? s.options.length : 0; })()`);
    check('接口环境保存成功', envOpts > 1, `${envOpts - 1} 个环境`);

    /* ---------- ⑤ 命令面板 ---------- */
    await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()`);
    await sleep(600);
    check('Ctrl+K 打开命令面板', await evaluate(`!!document.querySelector('.cmdk')`));
    await evaluate(`(() => { const set = ${SETVAL}; const inp = document.querySelector('.cmdk-search input'); set(inp, '工具箱'); return true; })()`);
    await sleep(500);
    const cmdItems = await evaluate(`(() => document.querySelectorAll('.cmdk-item').length)()`);
    await evaluate(`(() => { const it = document.querySelector('.cmdk-item'); if (it) it.click(); return true; })()`);
    await sleep(900);
    const pageTitle = await evaluate(`(() => { const t = document.querySelector('.pg-title'); return t ? t.textContent.trim() : ''; })()`);
    check('命令面板可搜索并跳转', cmdItems > 0 && pageTitle === '工具箱', `${cmdItems} 项 → ${pageTitle}`);

    /* ---------- ⑥ 工具箱新工具 ---------- */
    // AES：加密 → 解密
    await clickText('AES 加解密');
    await sleep(600);
    await evaluate(`(() => {
      const set = ${SETVAL};
      const root = document.querySelector('.pnl-body');
      const pass = root.querySelector('input[type=password]');
      const ta = root.querySelector('textarea');
      set(pass, 'test-pass-123');
      set(ta, 'hello aes');
      return true;
    })()`);
    await sleep(300);
    await evaluate(`(() => { const b = document.querySelector('.aes-run'); if (b) b.click(); return !!b; })()`);
    await sleep(900);
    const cipher = await evaluate(`(() => { const tas = Array.from(document.querySelectorAll('.pnl-body textarea')); return tas[1] ? tas[1].value : ''; })()`);
    if (!String(cipher).length) {
      const hint = await evaluate(`(() => { const h = document.querySelector('.pnl-body .input-hint'); return h ? h.textContent : '(无提示)'; })()`);
      console.log('  AES 失败提示:', hint);
    }
    check('AES 加密出结果', String(cipher).length > 20, String(cipher).slice(0, 24));

    // 解密回去
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('.pnl-body button')).find(x => x.textContent.trim() === '解密模式'); if (b) b.click(); return true; })()`);
    await sleep(400);
    await evaluate(`(() => { const set = ${SETVAL}; const tas = Array.from(document.querySelectorAll('.pnl-body textarea')); set(tas[0], tas[1].value); return true; })()`);
    await sleep(200);
    await evaluate(`(() => { const b = document.querySelector('.aes-run'); if (b) b.click(); return !!b; })()`);
    await sleep(900);
    const plain = await evaluate(`(() => { const tas = Array.from(document.querySelectorAll('.pnl-body textarea')); return tas[1] ? tas[1].value : ''; })()`);
    check('AES 解密还原', plain === 'hello aes', plain);

    // cron
    await clickText('Cron 解析');
    await sleep(700);
    const cronRows = await evaluate(`(() => { const cells = document.querySelectorAll('.pnl-body .kv-table tr'); return cells.length; })()`);
    check('Cron 解析出未来执行时间', cronRows >= 5, `${cronRows} 行`);

    // 时区
    await clickText('时区换算');
    await sleep(600);
    const tzRows = await evaluate(`(() => document.querySelectorAll('.pnl-body .kv-table tbody tr').length)()`);
    check('时区换算列出多时区', tzRows >= 6, `${tzRows} 个时区`);

    // URL 参数
    await clickText('URL 参数');
    await sleep(500);
    await evaluate(`(() => { const set = ${SETVAL}; const ta = document.querySelector('.pnl-body textarea'); set(ta, 'https://a.com/p?x=1&y=%E4%B8%AD'); return true; })()`);
    await sleep(700);
    const urlRows = await evaluate(`(() => document.querySelectorAll('.pnl-body .kv-table tbody tr').length)()`);
    check('URL 参数解析', urlRows >= 5, `${urlRows} 行`);
  } catch (e) {
    console.error('测试出错：' + e.message);
    results.push({ name: '执行异常', ok: false });
  }

  try { ws.close(); } catch { /* ignore */ }
  app.kill();
  await sleep(1000);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter(r => !r.ok);
  console.log('─'.repeat(48));
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
