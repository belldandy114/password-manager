/**
 * ui-features-test.js —— 验证本轮改动：
 *   ① 环境地址新增不再崩溃且能落盘
 *   ② 周报页能读到本地目录并渲染
 *   ③ 禅道：项目筛选 / 标签点击筛选 / 按项目统计 / 切页数据不丢
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9601;
const PASSWORD = 'Feat#2026';

const ZT = require('./zt-config');

if (!fs.existsSync(EXE)) { console.error('找不到主程序：' + EXE); process.exit(1); }
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-feat-'));
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
  await sleep(1500);

  const evaluate = async (expr, tag = '') => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
      new Promise(res => setTimeout(() => res(null), 25000)),
    ]);
    if (!r) { console.log('  [超时] ' + tag); return undefined; }
    if (r.exceptionDetails) console.log('  [异常] ' + tag + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 250));
    return r.result ? r.result.value : undefined;
  };
  const SETVAL = `(el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }`;
  const setInputs = `(root, vals) => { const set = ${SETVAL}; const ins = Array.from(root.querySelectorAll('input,textarea')); vals.forEach((v, i) => { if (ins[i]) set(ins[i], v); }); return ins.length; }`;
  const nav = (label) => evaluate(`(() => { const n = Array.from(document.querySelectorAll('.nav-item')).find(e => e.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
  const clickText = (text, scope = 'document') => evaluate(`(() => { const b = Array.from(${scope}.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b; })()`);

  try {
    // 界面解锁
    await evaluate(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return ins.length; })()`);
    await sleep(400);
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); b.click(); return true; })()`);
    await sleep(2000);
    check('界面解锁进入主界面', await evaluate(`!!document.querySelector('.sidebar')`));

    /* ---------- ① 环境地址新增 ---------- */
    await nav('环境地址');
    await sleep(800);
    await clickText('新增地址');
    await sleep(600);
    await evaluate(`(() => { const m = document.querySelector('.modal'); (${setInputs})(m, ['功能测试系统', 'https://feat.example.com', '自动化']); return true; })()`);
    await sleep(300);
    await clickText('保存', 'document.querySelector(".modal")');
    await sleep(1500);
    check('环境地址：保存后应用未崩溃', ws.readyState === 1);
    const envData = await evaluate(`(async () => JSON.stringify((await window.electronAPI.wsGet('environments')).data || []))()`);
    check('环境地址：数据已落盘', !!envData && envData.includes('功能测试系统'), envData);
    check('环境地址：矩阵出现新行', (await evaluate(`(() => { const t = document.querySelector('.envx'); return t ? t.querySelectorAll('tbody tr').length : -1; })()`)) === 1);

    /* ---------- ② 周报 ---------- */
    await nav('周报');
    await sleep(2500);
    const wkFiles = await evaluate(`(() => { const l = document.querySelector('.wk-list'); return l ? l.querySelectorAll('.wk-item').length : -1; })()`);
    check('周报：列表读到文件', typeof wkFiles === 'number' && wkFiles > 0, `${wkFiles} 篇`);
    const mdLen = await evaluate(`(() => { const b = document.querySelector('.md-body'); return b ? b.innerText.length : -1; })()`);
    check('周报：正文已渲染', typeof mdLen === 'number' && mdLen > 100, `${mdLen} 字`);
    const hasSection = await evaluate(`(() => { const b = document.querySelector('.md-body'); return b ? b.querySelectorAll('.md-h').length : -1; })()`);
    check('周报：小节标题已解析', typeof hasSection === 'number' && hasSection > 0, `${hasSection} 个小节`);
    // 点第二篇
    await evaluate(`(() => { const items = document.querySelectorAll('.wk-item'); if (items[1]) items[1].click(); return items.length; })()`);
    await sleep(1200);
    const mdLen2 = await evaluate(`(() => { const b = document.querySelector('.md-body'); return b ? b.innerText.length : -1; })()`);
    check('周报：切换另一篇', typeof mdLen2 === 'number' && mdLen2 > 100, `${mdLen2} 字`);

    /* ---------- ③ 禅道 ---------- */
    await nav('禅道');
    await sleep(900);
    await evaluate(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('.panel-body input, .pnl-body input')); const vals = ${JSON.stringify([ZT.base, ZT.account, ZT.password])}; vals.forEach((v,i)=>{ if (ins[i]) set(ins[i], v); }); return ins.length; })()`);
    await sleep(300);
    await clickText('拉取我的 Bug');
    await sleep(1);
    // 等待拉取完成（最长 60s）
    let ztReady = false;
    for (let i = 0; i < 60; i++) {
      const n = await evaluate(`(() => { const t = document.querySelector('.zt-cards'); return t ? t.querySelectorAll('.zt-card').length : 0; })()`);
      if (n > 0) { ztReady = true; break; }
      await sleep(1000);
    }
    check('禅道：拉取成功并显示统计卡片', ztReady);
    if (ztReady) {
      const totalTxt = await evaluate(`(() => { const c = document.querySelector('.zt-card .zt-card-num'); return c ? c.textContent : ''; })()`);
      const projRows = await evaluate(`(() => { const t = document.querySelector('.zt-proj'); return t ? t.querySelectorAll('tbody tr').length : -1; })()`);
      check('禅道：按项目统计表有数据', projRows > 0, `${projRows} 个项目（共 ${totalTxt} 条）`);
      const bugRows = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length-1].querySelectorAll('tbody tr').length : -1; })()`);

      // 点击「已解决」卡片
      console.log('  卡片:', await evaluate(`(() => Array.from(document.querySelectorAll('.zt-card')).map(c => c.textContent).join(' , '))()`));
      await evaluate(`(() => { const c = Array.from(document.querySelectorAll('.zt-card')).find(x => x.textContent.includes('已解决')); if (c) c.click(); return !!c; })()`);
      await sleep(1000);
      console.log('  激活卡片:', await evaluate(`(() => { const c = document.querySelector('.zt-card.is-active'); return c ? c.textContent : 'none'; })()`));
      console.log('  筛选条:', await evaluate(`(() => { const f = document.querySelector('.zt-active-filter'); return f ? f.textContent : 'none'; })()`));
      const afterFilter = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length-1].querySelectorAll('tbody tr').length : -1; })()`);
      const statusCells = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); const rows = t.length ? Array.from(t[t.length-1].querySelectorAll('tbody tr')) : []; return rows.slice(0,20).every(r => r.textContent.includes('已解决')); })()`);
      check('禅道：点「已解决」标签后列表只剩已解决', afterFilter > 0 && statusCells, `${bugRows} → ${afterFilter} 条，全部为已解决=${statusCells}`);

      // 清除筛选
      await clickText('清除筛选');
      await sleep(600);
      const restored = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length-1].querySelectorAll('tbody tr').length : -1; })()`);
      check('禅道：清除筛选后恢复', restored === bugRows, `${restored} 条`);

      // 项目筛选
      const projName = await evaluate(`(() => { const b = document.querySelector('.zt-proj-name'); return b ? b.textContent : ''; })()`);
      await evaluate(`(() => { const b = document.querySelector('.zt-proj-name'); if (b) b.click(); return !!b; })()`);
      await sleep(700);
      const byProj = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length-1].querySelectorAll('tbody tr').length : -1; })()`);
      check('禅道：按项目筛选生效', byProj > 0 && byProj <= bugRows, `${projName} → ${byProj} 条`);

      // 切页再回来，数据不丢
      await nav('测试笔记');
      await sleep(700);
      await nav('禅道');
      await sleep(900);
      const afterSwitch = await evaluate(`(() => { const t = document.querySelector('.zt-cards'); return t ? t.querySelectorAll('.zt-card').length : 0; })()`);
      const rowsAfterSwitch = await evaluate(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length-1].querySelectorAll('tbody tr').length : -1; })()`);
      check('禅道：切换页面后数据仍在', afterSwitch > 0 && rowsAfterSwitch > 0, `${rowsAfterSwitch} 条`);
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
