/**
 * ui-round2-test.js —— 本轮改动的界面回归（CDP 驱动真实界面）
 *   ① 环境地址/用例清单已移除，周报在侧边栏
 *   ② 周报：新建 / 修改 / 删除（用临时目录，不动真实周报）
 *   ③ 禅道：我的 Bug + 项目 Bug 两个 tab，项目 Bug 是全量
 *   ④ 工具箱：正则提取 / JSON 提取
 *   ⑤ 接口调试：请求头逐行输入
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(APP_DIR, '测试工具.exe');
const PORT = 9622;
const PASSWORD = 'Round2#2026';
const ZT = { base: 'http://zentao.example.com/zentao', account: 'REDACTED_ACCOUNT', password: 'REDACTED_PASSWORD' };

if (!fs.existsSync(EXE)) { console.error('找不到主程序：' + EXE); process.exit(1); }

const tmpWeekly = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-weekly-'));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r2-'));
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
      new Promise(res => setTimeout(() => res(null), 30000)),
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
  const setInputs = `(root, vals) => { const set = ${SETVAL}; const ins = Array.from(root.querySelectorAll('input:not([type=checkbox]),textarea')); vals.forEach((v,i)=>{ if(ins[i]) set(ins[i], v); }); return ins.length; }`;
  const nav = (label) => evaluate(`(() => { const n = Array.from(document.querySelectorAll('.nav-item')).find(e => e.textContent.includes(${JSON.stringify(label)})); if (n) { n.click(); return true; } return false; })()`);
  const clickText = (text, scope = 'document') => evaluate(`(() => { const b = Array.from(${scope}.querySelectorAll('button')).find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (b) { b.click(); return true; } return false; })()`);
  const setSelect = (sel, val) => evaluate(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return false; const d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; d.call(s, ${JSON.stringify(val)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  try {
    // 解锁
    await evaluate(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return ins.length; })()`);
    await sleep(400);
    await evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); b.click(); return true; })()`);
    await sleep(2000);
    check('界面解锁', await evaluate(`!!document.querySelector('.sidebar')`));

    /* ---------- ① 侧边栏 ---------- */
    const navTexts = await evaluate(`(() => Array.from(document.querySelectorAll('.nav-item')).map(n => n.textContent.trim()).join('|'))()`);
    check('侧边栏已去掉环境地址/用例清单', !navTexts.includes('环境地址') && !navTexts.includes('用例清单'), navTexts);
    check('侧边栏有「周报」', navTexts.includes('周报'));

    /* ---------- ② 周报 CRUD（临时目录） ---------- */
    await evaluate(`localStorage.setItem('weekly.report.dir', ${JSON.stringify(tmpWeekly)})`);
    await nav('周报');
    await sleep(1200);
    check('周报：空目录提示', await evaluate(`(() => { const e = document.querySelector('.empty-title'); return e ? e.textContent : ''; })()`) !== '');

    // 新建
    await clickText('新建周报');
    await sleep(600);
    check('周报：新建弹窗是编辑态', await evaluate(`!!document.querySelector('.wk-md-input, .wk-editor')`));
    await evaluate(`(() => { const inp = document.querySelector('.wk-editor input'); const set = ${SETVAL}; set(inp, '2026-10-30.md'); const ta = document.querySelector('.wk-md-input'); set(ta, '**一、本周工作**\\n\\n1. 验证周报新建\\n2. 验证保存\\n\\n**二、下周计划**\\n\\n1. 继续'); return true; })()`);
    await sleep(300);
    await clickText('保存');
    await sleep(1800);
    const created = fs.existsSync(path.join(tmpWeekly, '2026-10-30.md'));
    check('周报：新建并写入文件', created, created ? fs.readFileSync(path.join(tmpWeekly, '2026-10-30.md'), 'utf8').slice(0, 20) : '文件不存在');
    check('周报：列表出现新条目', await evaluate(`(() => { const l = document.querySelector('.wk-list'); return l ? l.querySelectorAll('.wk-item').length : 0; })()`) === 1);
    const rendered = await evaluate(`(() => { const b = document.querySelector('.md-body'); return b ? b.innerText : ''; })()`);
    check('周报：正文渲染出内容', String(rendered).includes('验证周报新建'), String(rendered).slice(0, 40));

    // 修改
    await clickText('编辑');
    await sleep(500);
    await evaluate(`(() => { const set = ${SETVAL}; const ta = document.querySelector('.wk-md-input'); set(ta, ta.value + '\\n3. 追加一行'); return true; })()`);
    await sleep(300);
    await clickText('保存');
    await sleep(1500);
    const afterEdit = fs.readFileSync(path.join(tmpWeekly, '2026-10-30.md'), 'utf8');
    check('周报：修改已保存', afterEdit.includes('追加一行'));

    // 删除
    await clickText('删除');
    await sleep(500);
    await clickText('删除到回收站');
    await sleep(1800);
    check('周报：删除后文件不在目录', !fs.existsSync(path.join(tmpWeekly, '2026-10-30.md')));

    /* ---------- ④ 工具箱 ---------- */
    await nav('工具箱');
    await sleep(800);
    await clickText('正则提取');
    await sleep(500);
    // 用不含反斜杠的模式，避免多层字符串转义把正则弄坏
    await evaluate(`(() => { const set = ${SETVAL}; const root = document.querySelector('.pnl-body'); const ins = Array.from(root.querySelectorAll('input')); set(ins[0], 'id":"([0-9]+)'); const ta = root.querySelector('textarea'); set(ta, '{"id":"1001","name":"a"} {"id":"1002"} {"id":"1001"}'); return [ins[0].value, ta.value.length]; })()`);
    await sleep(600);
    const reOut = await evaluate(`(() => { const pre = document.querySelector('.pnl-body pre.code2'); return pre ? pre.textContent : ''; })()`);
    const reLines = String(reOut).split('\n').filter(Boolean);
    check('工具箱：正则提取（去重后 2 条）', reLines.length === 2 && reLines.some(l => l.includes('1001')) && reLines.some(l => l.includes('1002')), JSON.stringify(reOut).slice(0, 60));

    await clickText('JSON 提取');
    await sleep(500);
    await evaluate(`(() => { const set = ${SETVAL}; const root = document.querySelector('.pnl-body'); const ta = root.querySelector('textarea'); set(ta, '{"code":0,"data":{"list":[{"id":11,"name":"甲"},{"id":22,"name":"乙"}]}}'); return true; })()`);
    await sleep(300);
    await evaluate(`(() => { const set = ${SETVAL}; const root = document.querySelector('.pnl-body'); const ins = Array.from(root.querySelectorAll('input:not([type=checkbox])')); set(ins[0], 'data.list[*].name'); return ins[0].value; })()`);
    await sleep(600);
    const jsonOut = await evaluate(`(() => { const ps = Array.from(document.querySelectorAll('.pnl-body pre.code2')); return ps.length ? ps[ps.length-1].textContent : ''; })()`);
    check('工具箱：JSON 路径提取 data.list[*].name', String(jsonOut).includes('甲') && String(jsonOut).includes('乙'), JSON.stringify(jsonOut).slice(0, 60));

    /* ---------- ⑤ 接口调试：请求头逐行 ---------- */
    await nav('接口调试');
    await sleep(900);
    const rowsBefore = await evaluate(`document.querySelectorAll('.kv-row').length`);
    await evaluate(`(() => { const root = document.querySelector('.pnl-body'); const set = ${SETVAL}; const ins = Array.from(root.querySelectorAll('.kv-row input')); set(ins[0], 'Content-Type'); set(ins[1], 'application/json'); return true; })()`);
    await sleep(500);
    await clickText('添加一行');
    await sleep(400);
    const rowsAfter = await evaluate(`document.querySelectorAll('.kv-row').length`);
    check('接口调试：请求头是一行一行输入', rowsBefore >= 1 && rowsAfter > rowsBefore, `${rowsBefore} → ${rowsAfter} 行`);
    await evaluate(`(() => { const set = ${SETVAL}; const rows = Array.from(document.querySelectorAll('.kv-row')); const last = rows[rows.length-1]; if (!last) return 'no-row'; const ins = Array.from(last.querySelectorAll('input')); set(ins[0], 'X-Test'); set(ins[1], '1'); return true; })()`);
    await sleep(500);
    // 变量也逐行
    await clickText('变量');
    await sleep(400);
    const varRows = await evaluate(`(() => { const rows = Array.from(document.querySelectorAll('.kv-row')); return rows.length; })()`);
    check('接口调试：变量也是逐行', varRows > rowsAfter, `${varRows} 行`);

    /* ---------- ③ 禅道 ---------- */
    await nav('禅道');
    await sleep(900);
    await evaluate(`(() => { const set = ${SETVAL}; const root = document.querySelector('.pnl-body'); const ins = Array.from(root.querySelectorAll('input')); const vals = ${JSON.stringify([ZT.base, ZT.account, ZT.password])}; vals.forEach((v,i)=>{ if(ins[i]) set(ins[i], v); }); return ins.length; })()`);
    await sleep(300);
    await clickText('拉取我的 Bug');
    let mine = 0;
    for (let i = 0; i < 45; i++) {
      mine = await evaluate(`(() => { const t = document.querySelector('.zt-cards'); return t ? t.querySelectorAll('.zt-card').length : 0; })()`);
      if (mine > 0) break;
      await sleep(1000);
    }
    check('禅道：我的 Bug 拉取成功', mine > 0, `${mine} 张统计卡`);

    // 切到项目 Bug tab
    await clickText('项目 Bug');
    await sleep(600);
    await clickText('刷新项目列表');
    let projOptions = 0;
    for (let i = 0; i < 45; i++) {
      projOptions = await evaluate(`(() => { const s = document.querySelector('.zt-proj-pick select'); return s ? s.options.length : 0; })()`);
      if (projOptions > 1) break;
      await sleep(1000);
    }
    check('禅道：项目列表已加载', projOptions > 1, `${projOptions - 1} 个项目`);

    // 等项目 Bug 拉完；默认项目没数据就换下一个项目试
    let pRows = 0;
    for (let i = 0; i < 60; i++) {
      pRows = await evaluate(`(() => { const ts = document.querySelectorAll('.tbl'); return ts.length ? ts[ts.length-1].querySelectorAll('tbody tr').length : 0; })()`);
      if (pRows > 0) break;
      await sleep(1000);
    }
    if (pRows === 0) {
      console.log('  默认项目没有数据，依次换项目重试…');
      const opts = await evaluate(`(() => Array.from(document.querySelector('.zt-proj-pick select').options).slice(1, 8).map(o => o.value))()`);
      for (const pid of (opts || [])) {
        // 直接调用 React 的 onChange 不现实，用 select 的原生 change 触发
        await evaluate(`(() => { const s = document.querySelector('.zt-proj-pick select'); const d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; d.call(s, ${JSON.stringify(pid)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
        for (let i = 0; i < 25; i++) {
          pRows = await evaluate(`(() => { const ts = document.querySelectorAll('.tbl'); return ts.length ? ts[ts.length-1].querySelectorAll('tbody tr').length : 0; })()`);
          if (pRows > 0) break;
          await sleep(1000);
        }
        if (pRows > 0) { console.log('  命中项目:', pid); break; }
      }
    }
    const assignees = await evaluate(`(() => { const ts = document.querySelectorAll('.tbl'); const rows = ts.length ? Array.from(ts[ts.length-1].querySelectorAll('tbody tr')).slice(0, 40) : []; const names = new Set(); rows.forEach(r => { const c = r.children[4]; if (c) names.add(c.textContent.trim()); }); return Array.from(names).join(','); })()`);
    check('禅道：项目 Bug 是全量（多个指派人）', pRows > 0 && String(assignees).split(',').filter(Boolean).length > 1, `${pRows} 条，指派人：${assignees}`);

    // 切页回来数据还在
    await nav('测试笔记');
    await sleep(700);
    await nav('禅道');
    await sleep(900);
    await clickText('项目 Bug');
    await sleep(700);
    const backRows = await evaluate(`(() => { const ts = document.querySelectorAll('.tbl'); return ts.length ? ts[ts.length-1].querySelectorAll('tbody tr').length : 0; })()`);
    check('禅道：切页回来项目 Bug 仍在', backRows > 0, `${backRows} 条`);
  } catch (e) {
    console.error('测试出错：' + e.message);
    results.push({ name: '执行异常', ok: false });
  }

  try { ws.close(); } catch { /* ignore */ }
  app.kill();
  await sleep(1000);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpWeekly, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter(r => !r.ok);
  console.log('─'.repeat(48));
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
