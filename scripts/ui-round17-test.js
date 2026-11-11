/**
 * 1.22.0 回归：12 项新功能（定时任务 / 库自检 / 片段库 / 变量提取 / 钉小窗 / 最近条）
 *
 * 覆盖：
 *   ① 设置 › 定时任务：四张卡都在，环境巡检有间隔输入与立即执行
 *   ② 设置 › 安全：库自检、恢复演练、导出诊断包入口都在，自检能出报告
 *   ③ 代码调试：片段库能存一条、能载入、能删
 *   ④ 接口调试：新建请求后出现「变量提取」区
 *   ⑤ 网址管理：卡片上的图钉能开出独立小窗，小窗里显示这条的名字
 *   ⑥ 工作台「最近」条：点过卡片后出现
 *   ⑦ 走一遍所有页面，收集 console error
 *
 * 跑法：node scripts/ui-round17-test.js   （默认 release/win-unpacked，先 npm run repack）
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pickExe } = require('./pick-exe');

const ROOT = path.join(__dirname, '..');
// 默认测打包版；PM_PROBE_ELECTRON=1 时直接跑源码（用 electron + PM_USE_DIST，省一次 repack）
const USE_SRC = process.env.PM_PROBE_ELECTRON === '1';
const EXE = USE_SRC
  ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  : pickExe(path.join(ROOT, 'release', 'win-unpacked'));
const PORT = 9817;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const consoleErrors = [];

async function connect(url) {
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
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 180));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push('exception: ' + String(d.exception?.description || d.text || '').slice(0, 180));
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Log.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EX:' + String(r.exceptionDetails.exception?.description || '').slice(0, 200);
    return r.result?.value;
  };
  // 会把自己关掉的调用（pinClose）不能等回包：窗口一关 CDP 就再也不回，await 会挂死
  const evNoWait = (expr) => Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: true }),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  return { ws, ev, evNoWait, send };
}

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('找不到 exe：' + EXE); process.exit(1); }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r17-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`];
  if (USE_SRC) { env.PM_USE_DIST = '1'; args.unshift('.'); }
  const app = spawn(EXE, args, {
    env, cwd: USE_SRC ? ROOT : path.dirname(EXE), stdio: 'ignore',
  });
  app.on('exit', (code, sig) => console.log(`[probe] app 进程退出 code=${code} sig=${sig}`));
  app.on('error', (e) => console.log('[probe] spawn 失败：' + e.message));

  let main = null;
  for (let i = 0; i < 80; i += 1) {
    const list = await targets();
    const t = list.find((x) => x.type === 'page' && !String(x.url).startsWith('devtools://'));
    if (t) { main = t; break; }
    await sleep(400);
  }
  if (!main) { console.error('连不上调试端口'); app.kill(); process.exit(1); }

  const M = await connect(main.webSocketDebuggerUrl);
  await M.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await M.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(2000);

  const clickBtn = (text) => M.ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(text)})); if (b) { b.click(); return true; } return false; })()`);
  const navTo = async (label) => {
    await M.ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) { n.click(); return true; } return false; })()`);
    await sleep(900);
  };

  // 首次运行要先设主密码
  await M.ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')].filter(x => x.type !== 'checkbox'); if (ins[0]) s(ins[0], 'Test@1234'); if (ins[1]) s(ins[1], 'Test@1234'); return 1; })()`);
  await sleep(300);
  await clickBtn('设置主密码并开始使用');
  await sleep(2600);

  /* ---------- ① 定时任务面板 ---------- */
  await navTo('设置');
  await clickBtn('定时任务');
  await sleep(700);
  const taskCards = await M.ev(`document.querySelectorAll('.task-card').length`);
  check('设置 › 定时任务：四张任务卡都在', taskCards === 4, `cards=${taskCards}`);
  const taskNames = await M.ev(`[...document.querySelectorAll('.task-name')].map(x => x.textContent.trim()).join(' | ')`);
  check('四张卡分别对应巡检 / 禅道 / 更新 / 备份', /巡检/.test(taskNames) && /禅道/.test(taskNames) && /更新/.test(taskNames) && /备份/.test(taskNames), taskNames);
  const envInterval = await M.ev(`(() => { const c = document.querySelector('.task-card'); const i = c && c.querySelector('input[type=number]'); return i ? i.value : null; })()`);
  check('环境巡检有间隔输入（默认 0 = 关）', envInterval === '0', `value=${envInterval}`);
  const immediate = await M.ev(`[...document.querySelectorAll('.task-card button')].some(b => b.textContent.includes('立即'))`);
  check('环境巡检有「立即巡检」按钮', immediate === true);

  /* ---------- ② 库自检 / 诊断包 ---------- */
  await clickBtn('安全');
  await sleep(700);
  const auditBtn = await M.ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('开始自检'))`);
  check('安全页有「开始自检」入口', auditBtn === true);
  await clickBtn('开始自检');
  await sleep(1200);
  const auditReport = await M.ev(`(() => { const a = document.querySelector('.vault-audit'); if (!a) return null; return { pills: a.querySelectorAll('.vault-audit-pill').length, sum: a.querySelector('.vault-audit-sum')?.textContent.trim().slice(0, 80) || '' }; })()`);
  check('自检能出报告（三枚计数丸 + 结构版本行）', !!auditReport && auditReport.pills >= 3, JSON.stringify(auditReport));
  // 诊断包入口在「通用 › 关于」，不在安全页
  await clickBtn('通用');
  await sleep(700);
  const diagBtn = await M.ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('导出诊断包'))`);
  check('通用页有「导出诊断包」入口', diagBtn === true);
  const logBtn = await clickBtn('查看日志');
  check('通用页有「查看日志」入口', logBtn === true);
  await sleep(1200);
  const logView = await M.ev(`(() => { const m = document.querySelector('.log-modal'); if (!m) return null; const pre = m.querySelector('.log-modal-body'); return { hasPre: !!pre, len: pre ? pre.textContent.length : 0, path: (m.querySelector('.log-modal-path')?.textContent || '').slice(-24) }; })()`);
  check('日志查看器能读出正文（不是空壳）', !!logView && logView.hasPre && logView.len > 0, JSON.stringify(logView));
  await M.ev(`(() => { const b = [...document.querySelectorAll('.log-modal button')].find(x => x.textContent.trim() === '关闭'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(500);
  const logClosed = await M.ev(`!document.querySelector('.log-modal')`);
  check('日志查看器能关掉', logClosed === true);

  /* ---------- ③ 代码调试片段库 ---------- */
  await navTo('代码调试');
  await sleep(1200);
  const snipBtn = await clickBtn('片段库');
  check('代码调试有「片段库」按钮', snipBtn === true);
  await sleep(500);
  const drawerOpen = await M.ev(`!!document.querySelector('.snip-drawer')`);
  check('片段库抽屉能展开', drawerOpen === true);
  await M.ev(`(() => { const s = ${SETVAL}; const i = document.querySelector('.snip-save input'); if (!i) return false; s(i, '冒烟片段'); return true; })()`);
  await sleep(300);
  const saved = await M.ev(`(() => { const b = [...document.querySelectorAll('.snip-save button')].find(x => x.textContent.includes('存')); if (!b) return false; b.click(); return true; })()`);
  check('能存一条片段', saved === true);
  await sleep(1200);
  const snipCount = await M.ev(`document.querySelectorAll('.snip-item').length`);
  const snipName = await M.ev(`document.querySelector('.snip-item .snip-name, .snip-item button, .snip-item')?.textContent.trim().slice(0, 40) || ''`);
  check('片段出现在列表里', snipCount === 1, `count=${snipCount} text=${snipName}`);
  // 落盘确认：vault 集合 codeSnippets
  const persisted = await M.ev(`(async () => { const r = await window.electronAPI.wsGet('codeSnippets'); return r && r.success ? (r.data || []).length : -1; })()`);
  check('片段进了 vault 集合 codeSnippets', persisted === 1, `n=${persisted}`);
  await M.ev(`(() => { const b = document.querySelector('.snip-item .snip-del'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(900);
  const afterDel = await M.ev(`document.querySelectorAll('.snip-item').length`);
  check('能删掉片段', afterDel === 0, `count=${afterDel}`);

  /* ---------- ④ 接口调试：变量提取 ---------- */
  await navTo('接口调试');
  await sleep(1400);
  await clickBtn('新建请求');
  await sleep(900);
  const extractToggle = await M.ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('变量提取'))`);
  check('新建请求后有「变量提取」区', extractToggle === true);

  /* ---------- ⑤ 钉小窗 ---------- */
  await navTo('网址管理');
  await sleep(900);
  // 造一条：空态里的「+ 新增网址」
  await clickBtn('新增网址');
  await sleep(700);
  await M.ev(`(() => { const s = ${SETVAL}; const n = document.querySelector('input[aria-label="名称"]'); const u = document.querySelector('input[aria-label="URL"]'); if (n) s(n, '钉窗测试'); if (u) s(u, 'http://127.0.0.1:9/pin'); return !!n; })()`);
  await sleep(300);
  const savedEntry = await M.ev(`(() => { const b = [...document.querySelectorAll('.modal button, .modal-footer button')].find(x => x.textContent.trim() === '保存' || x.textContent.includes('保存')); if (!b) return false; b.click(); return true; })()`);
  check('能新建一条网址', savedEntry === true);
  await sleep(1200);
  const cardCount = await M.ev(`document.querySelectorAll('.entry-card').length`);
  check('卡片出现在工作台', cardCount >= 1, `cards=${cardCount}`);

  const pinClicked = await M.ev(`(() => { const b = document.querySelector('.entry-card button[aria-label="钉成小窗"]'); if (!b) return false; b.click(); return true; })()`);
  check('卡片上有图钉按钮', pinClicked === true);
  await sleep(2200);
  const pinTarget = (await targets()).find((x) => String(x.url).includes('window=pin'));
  check('图钉开出了独立小窗（?window=pin）', !!pinTarget, pinTarget ? String(pinTarget.url).slice(0, 70) : 'no target');
  if (pinTarget) {
    const P = await connect(pinTarget.webSocketDebuggerUrl);
    await sleep(1200);
    const pinInfo = await P.ev(`(() => { const card = document.querySelector('.pin-card'); if (!card) return null; return { title: (card.querySelector('.pin-title')?.textContent || '').trim(), rows: card.querySelectorAll('.pin-row').length, hasPinClass: document.documentElement.classList.contains('pin-window') }; })()`);
    check('小窗里显示这条的名字与字段', !!pinInfo && pinInfo.title === '钉窗测试' && pinInfo.rows >= 2, JSON.stringify(pinInfo));
    check('小窗带 pin-window 类（透明背景生效）', !!pinInfo && pinInfo.hasPinClass === true);
    await P.evNoWait(`window.electronAPI.pinClose()`);
    await sleep(1200);
    const stillOpen = (await targets()).some((x) => String(x.url).includes('window=pin'));
    check('小窗能自己关掉', stillOpen === false);
  }

  /* ---------- ⑥ 最近使用条 ---------- */
  // 「最近」记的是「点开过这条」，所以要先点一下卡片本体（点图钉不算，它 stopPropagation）
  await M.ev(`(() => { const c = document.querySelector('.entry-card'); if (!c) return false; c.click(); return true; })()`);
  await sleep(700);
  const recent = await M.ev(`(() => { const s = document.querySelector('.recent-strip'); if (!s) return null; return { chips: s.querySelectorAll('.recent-chip').length, label: (s.querySelector('.recent-strip-label')?.textContent || '').trim(), first: (s.querySelector('.recent-chip-name')?.textContent || '').trim() }; })()`);
  check('工作台出现「最近」条且含刚才那条', !!recent && recent.chips >= 1 && recent.first === '钉窗测试', JSON.stringify(recent));

  /* ---------- ⑦ 逐页走一遍 ---------- */
  for (const label of ['测试账号', '环境矩阵', '周报', 'SQL 片段', '测试笔记', '缺陷管理', '测试数据', '工具箱', '压力测试', '代码调试', '接口调试', '设置']) {
    await navTo(label);
  }
  check('12 个页面切换无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.kill();
  await sleep(600);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('探针自身出错：', e); process.exit(1); });
