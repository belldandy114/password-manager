/**
 * ui-round3-test.js —— 本轮（全部项目 + 全站样式重设计）回归
 *   ① 网址管理页改造后仍可用（tab 切换、新增弹窗）
 *   ② 禅道「项目 Bug → 全部项目」能拿到总 Bug 数与按项目统计
 *   ③ 其余页面渲染正常
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(APP_DIR, '测试工具.exe');
const PORT = 9690;
const PASSWORD = 'Round3#2026';
const ZT = { base: 'http://zentao.example.com/zentao', account: 'REDACTED_ACCOUNT', password: 'REDACTED_PASSWORD' };

if (!fs.existsSync(EXE)) { console.error('找不到主程序：' + EXE); process.exit(1); }
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r3-'));
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
    if (msg.method === 'Runtime.exceptionThrown') console.log('  [页面异常] ' + (msg.params.exceptionDetails?.exception?.description || '').slice(0, 200));
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
    if (r.exceptionDetails) console.log('  [异常] ' + tag + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200));
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
    await evaluate(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return ins.length; })()`);
    await sleep(400);
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); b.click(); return true; })()`);
    await sleep(2200);
    check('解锁后进入主界面', await evaluate(`!!document.querySelector('.sidebar')`));

    /* ① 网址管理页 */
    check('网址管理：页面标题存在', await evaluate(`(() => { const t = document.querySelector('.pg-title'); return t ? t.textContent.trim() : ''; })()`) === '网址管理');
    check('网址管理：子 tab 渲染', (await evaluate(`document.querySelectorAll('.tabs .tab2').length`)) === 4);
    await clickText('回收站');
    await sleep(700);
    check('网址管理：切到回收站', await evaluate(`document.body.innerText.includes('回收站')`));
    await clickText('所有网址');
    await sleep(700);
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /新增/.test(x.textContent) && !x.closest('.modal')); if (b) { b.click(); return true; } return false; })()`);
    await sleep(700);
    check('网址管理：新增弹窗可打开', await evaluate(`!!document.querySelector('.modal')`));
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim() === '取消'); if (b) b.click(); return true; })()`);
    await sleep(400);

    /* ② 禅道 全部项目 */
    await nav('禅道');
    await sleep(900);
    // 连接配置可能是折叠状态：先确保输入框在 DOM 里
    await evaluate(`(() => {
      const set = ${SETVAL};
      const ins = Array.from(document.querySelectorAll('.pnl-body input'));
      if (ins.length < 3) {
        const head = Array.from(document.querySelectorAll('.pnl-head.is-clickable')).find(h => h.textContent.includes('连接配置'));
        if (head) head.click();
      }
      return ins.length;
    })()`);
    await sleep(500);
    await evaluate(`(() => { const set = ${SETVAL}; const root = document.querySelector('.pnl-body'); const ins = Array.from(root.querySelectorAll('input')); const vals = ${JSON.stringify([ZT.base, ZT.account, ZT.password])}; vals.forEach((v, i) => { if (ins[i]) set(ins[i], v); }); return ins.length; })()`);
    await sleep(300);
    await clickText('项目 Bug');
    await sleep(500);
    await clickText('刷新项目列表');
    let opts = 0;
    for (let i = 0; i < 40; i++) {
      opts = await evaluate(`(() => { const s = document.querySelector('.zt-proj-pick select'); return s ? s.options.length : 0; })()`);
      if (opts > 1) break;
      await sleep(1000);
    }
    check('禅道：项目列表加载', opts > 1, `${opts - 2} 个项目`);

    // 先选「资产管理系统-管理后台V2.0.0」(58)，验证是全量（禅道网页显示 680+）
    const picked = await evaluate(`(() => {
      const s = document.querySelector('.zt-proj-pick select');
      const opt = Array.from(s.options).find(o => /管理后台V2\.0\.0/.test(o.textContent));
      if (!opt) return 'no-option';
      const d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      d.call(s, opt.value);
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    })()`);
    let cnt58 = 0;
    for (let i = 0; i < 60; i++) {
      cnt58 = Number(await evaluate(`(() => { const c = document.querySelector('.zt-card .zt-card-num'); return c ? c.textContent : 0; })()`) || 0);
      if (cnt58 > 0) break;
      await sleep(1000);
    }
    check('禅道：单个项目是全量（含已关闭）', cnt58 >= 680, `${picked} → ${cnt58} 条`);

    // 再切到「全部项目」
    await evaluate(`(() => { const s = document.querySelector('.zt-proj-pick select'); const d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; d.call(s, '__all__'); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
    let totalTxt = '';
    let projRows = 0;
    for (let i = 0; i < 60; i++) {
      totalTxt = await evaluate(`(() => { const c = document.querySelector('.zt-card .zt-card-num'); return c ? c.textContent : ''; })()`);
      projRows = await evaluate(`(() => { const t = document.querySelector('.zt-proj'); return t ? t.querySelectorAll('tbody tr').length : 0; })()`);
      if (totalTxt && Number(totalTxt) > 0) break;
      await sleep(1000);
    }
    check('禅道：全部项目显示总 Bug 数', Number(totalTxt) > 5000, `总 ${totalTxt} 条`);
    check('禅道：全部项目有按项目统计表', projRows > 5, `${projRows} 个项目行`);

    /* ③ 其余页面渲染 */
    for (const label of ['周报', '工具箱', '接口调试', '测试笔记', 'SQL 片段', '测试账号']) {
      await nav(label);
      await sleep(700);
      const ok = await evaluate(`(() => { const t = document.querySelector('.pg-title'); return t ? t.textContent.trim() : ''; })()`);
      check(`页面可渲染：${label}`, !!ok, ok);
    }
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
