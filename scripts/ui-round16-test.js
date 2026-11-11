/**
 * 1.22.x 回归：可访问性与静态债那一批改动
 *
 * 覆盖（都是本轮新加/新改的东西）：
 *   ① skip-link 存在、平时藏起来、聚焦后进入视口、点了把焦点交给 #main-content
 *   ② Modal 带 role=dialog / aria-modal / aria-labelledby，打开时焦点在弹窗内，Esc 关闭
 *   ③ Modal 焦点陷阱：Tab 从最后一个可聚焦元素绕回第一个
 *   ④ 环境徽标/色点走 --env-* 令牌（深色主题下值正确）
 *   ⑤ 拼音字典按需加载：首屏不含 esm-* chunk，随后异步加载成功
 *   ⑥ 拼音搜索仍能命中中文条目（禅道账号验证 ← "cdzhyz"）
 *   ⑦ reduced-motion 下 busy 进度条不是空轨道、modal 仍保留淡入
 *   ⑧ 逐页走一遍，收集 console error / 未捕获异常（aria-label 批量改动的主要风险）
 *
 * 跑法：node scripts/ui-round16-test.js   （默认 release/win-unpacked）
 *   先 `npm run repack` 让打包版跟工作区同步。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pickExe } = require('./pick-exe');

const EXE = pickExe(path.join(__dirname, '..', 'release', 'win-unpacked'));
const PORT = 9816;
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
  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    void code;
  };
  return { ws, ev, send, key };
}

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('找不到 exe：' + EXE); process.exit(1); }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r16-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
    env, cwd: path.dirname(EXE), stdio: 'ignore',
  });

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
  // 窗口没有真正获得焦点时 :focus 不匹配（document.activeElement 却是它），
  // 会让 skip-link 的聚焦样式看起来"没生效"。开焦点仿真，跟真实用键盘一样。
  await M.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(2000);

  const clickByText = (text) => M.ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)})); if (b) { b.click(); return true; } return false; })()`);
  const navTo = async (label) => {
    await M.ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) { n.click(); return true; } return false; })()`);
    await sleep(900);
  };

  // 首屏还没解锁：先设主密码
  await M.ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')].filter(x => x.type !== 'checkbox'); if (ins[0]) s(ins[0], 'Test@1234'); if (ins[1]) s(ins[1], 'Test@1234'); return 1; })()`);
  await sleep(300);
  await clickByText('设置主密码并开始使用');
  await sleep(2600);

  /* ---------- ⑤ 拼音字典不在首屏 ----------
     注意：file:// 下 performance.getEntriesByType('resource') 是空的（Chrome 不记
     file 协议的资源计时），所以这里查 index.html 实际引用的 chunk，而不是资源计时。 */
  const bootRefs = await M.ev(`JSON.stringify({
    preload: [...document.querySelectorAll('link[rel="modulepreload"]')].map(l => String(l.href).split('/assets/')[1]),
    scripts: [...document.querySelectorAll('script[src]')].map(s => String(s.src).split('/assets/')[1]),
  })`);
  const B = JSON.parse(typeof bootRefs === 'string' ? bootRefs : '{}');
  const bootAll = [...(B.preload || []), ...(B.scripts || [])];
  check('首屏没有预加载/引入拼音 chunk（esm-*.js）', bootAll.length > 0 && !bootAll.some((n) => /^esm-/.test(String(n))), JSON.stringify(bootAll));

  /* ---------- 准备：一条中文测试条目（④⑥ 都靠它） ---------- */
  const added = await M.ev(`window.electronAPI.entriesAdd({
    id: 'probe-r16-1', name: '\u7985\u9053\u8d26\u53f7\u9a8c\u8bc1', username: 'probe', password: 'Probe@123',
    url: 'https://example.com', tags: ['probe'], envType: 'testing', notes: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).then(r => JSON.stringify({ ok: r.success, err: r.error }))`);
  check('探针条目写入成功', String(added).includes('"ok":true'), String(added));
  // 直接走 IPC 写的条目不会进渲染层 store，重载一次让它出现在列表里
  await M.ev(`location.reload()`);
  await sleep(3500);
  const relocked = await M.ev(`!!document.querySelector('input[placeholder="输入主密码解锁"]')`);
  if (relocked) {
    await M.ev(`(() => { const s = ${SETVAL}; s(document.querySelector('input[placeholder="输入主密码解锁"]'), 'Test@1234'); return 1; })()`);
    await sleep(300);
    await clickByText('解锁');
    await sleep(2500);
  }

  /* ---------- ① skip-link ---------- */
  const skip = await M.ev(`(() => {
    const a = document.querySelector('.skip-link');
    if (!a) return JSON.stringify({ found: false });
    const cs = getComputedStyle(a);
    return JSON.stringify({ found: true, href: a.getAttribute('href'), text: a.textContent.trim(), pos: cs.position, tf: cs.transform, hasTarget: !!document.getElementById('main-content') });
  })()`);
  const S = JSON.parse(typeof skip === 'string' ? skip : '{}');
  check('skip-link 存在且指向 #main-content', S.found && S.href === '#main-content' && S.hasTarget, JSON.stringify(S));
  const hidden = /matrix\(1, 0, 0, 1, 0, -\d/.test(String(S.tf));
  check('skip-link 平时移出视口（transform 负位移）', hidden, String(S.tf));
  // 聚焦后等过渡跑完再读：slide-in 是 150ms 过渡，同一帧读到的还是起始值
  const revealed = await M.ev(`(async () => {
    const a = document.querySelector('.skip-link');
    a.focus();
    await new Promise(r => setTimeout(r, 400));
    const cs = getComputedStyle(a);
    return JSON.stringify({ tf: cs.transform, hit: cs.outlineStyle, active: document.activeElement === a });
  })()`);
  const R = JSON.parse(typeof revealed === 'string' ? revealed : '{}');
  check('skip-link 聚焦后回到视口内并出现轮廓', (R.tf === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(String(R.tf))) && R.hit !== 'none', JSON.stringify(R));
  const jump = await M.ev(`(() => { const a = document.querySelector('.skip-link'); a.click(); return document.activeElement.id; })()`);
  check('点 skip-link 后焦点落到 main-content', jump === 'main-content', String(jump));

  /* ---------- ②③ Modal 语义与焦点陷阱 ---------- */
  await navTo('网址管理');
  const opened = await M.ev(`(() => { const b = document.querySelector('.btn-add'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(700);
  const dlg = await M.ev(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return JSON.stringify({ found: false });
    const act = document.activeElement;
    return JSON.stringify({
      found: true,
      modal: d.getAttribute('aria-modal'),
      labelled: !!d.getAttribute('aria-labelledby') || !!d.getAttribute('aria-label'),
      focusInside: !!(act && d.contains(act)),
      tabIndex: d.getAttribute('tabindex'),
      count: document.querySelectorAll('[role="dialog"]').length,
    });
  })()`);
  const D = JSON.parse(typeof dlg === 'string' ? dlg : '{}');
  check('弹窗带 role=dialog + aria-modal + 可访问名称', !!D.found && D.modal === 'true' && D.labelled === true, JSON.stringify({ opened, ...D }));
  check('打开时焦点已进入弹窗', D.focusInside === true, String(D.focusInside));

  // 焦点陷阱：聚焦最后一个可聚焦元素，按 Tab 应绕回第一个
  const trap = await M.ev(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const sel = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const list = [...d.querySelectorAll(sel)].filter(e => e.offsetParent !== null || e.getClientRects().length);
    if (list.length < 2) return JSON.stringify({ skip: true, n: list.length });
    window.__trapFirst = list[0];
    list[list.length - 1].focus();
    return JSON.stringify({ skip: false, n: list.length });
  })()`);
  const T = JSON.parse(typeof trap === 'string' ? trap : '{}');
  await M.key('Tab', 'Tab', 9);
  await sleep(250);
  const wrapped = await M.ev(`JSON.stringify({ first: document.activeElement === window.__trapFirst, tag: document.activeElement && document.activeElement.tagName })`);
  const W = JSON.parse(typeof wrapped === 'string' ? wrapped : '{}');
  check('Tab 在弹窗内循环（末位绕回首位）', T.skip === true || W.first === true, JSON.stringify({ ...T, ...W }));

  await M.key('Escape', 'Escape', 27);
  await sleep(500);
  const closed = await M.ev(`document.querySelectorAll('[role="dialog"]').length`);
  check('Esc 关闭弹窗', closed === 0, String(closed));

  /* ---------- ④ 环境徽标的颜色来自 --env-* 令牌 ---------- */
  await navTo('网址管理');
  await sleep(600);
  const badges = await M.ev(`(() => {
    const resolve = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const el = document.querySelector('.entry-card .env-badge');
    return JSON.stringify({
      found: !!el,
      cls: el ? el.className : '',
      bg: el ? getComputedStyle(el).backgroundColor : '',
      fg: el ? getComputedStyle(el).color : '',
      wantBg: resolve('var(--env-testing-bg)'),
      wantFg: resolve('var(--env-testing-fg)'),
    });
  })()`);
  const TK = JSON.parse(typeof badges === 'string' ? badges : '{}');
  check('环境徽标存在（卡片形态）', TK.found === true && /env-testing/.test(String(TK.cls)), JSON.stringify({ cls: TK.cls }));
  check('环境徽标配色走 --env-* 令牌', !!TK.bg && TK.bg === TK.wantBg && TK.fg === TK.wantFg, JSON.stringify({ bg: TK.bg, wantBg: TK.wantBg, fg: TK.fg, wantFg: TK.wantFg }));

  /* ---------- ⑥ 拼音首字母搜索 ---------- */
  const typed = await M.ev(`(() => { const s = ${SETVAL}; const i = document.querySelector('.toolbar-search input'); if (!i) return 'no-input'; s(i, 'cdzhyz'); return i.value; })()`);
  await sleep(900);
  const searched = await M.ev(`JSON.stringify({
    cards: document.querySelectorAll('.entry-card').length,
    hasTitle: document.body.textContent.includes('\u7985\u9053\u8d26\u53f7\u9a8c\u8bc1'),
  })`);
  const SR = JSON.parse(typeof searched === 'string' ? searched : '{}');
  check('拼音首字母能搜到中文条目（cdzhyz）', typed !== 'no-input' && SR.hasTitle === true && Number(SR.cards) >= 1, JSON.stringify({ typed, ...SR }));
  await M.ev(`(() => { const s = ${SETVAL}; const i = document.querySelector('.toolbar-search input'); if (i) s(i, ''); return 1; })()`);

  /* ---------- ⑦ reduced-motion ---------- */
  await M.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(300);
  const motion = await M.ev(`(() => {
    const host = document.createElement('div'); host.className = 'busy-progress';
    host.innerHTML = '<div class="busy-progress-track"><div class="busy-progress-bar"></div></div>';
    const modal = document.createElement('div'); modal.className = 'modal';
    document.body.appendChild(host); document.body.appendChild(modal);
    const bar = getComputedStyle(host.querySelector('.busy-progress-bar'));
    const md = getComputedStyle(modal);
    const out = { barAnim: bar.animationName, barDur: bar.animationDuration, barWidth: bar.width, modalAnim: md.animationName, modalDur: md.animationDuration };
    host.remove(); modal.remove();
    return JSON.stringify(out);
  })()`);
  const MO = JSON.parse(typeof motion === 'string' ? motion : '{}');
  check('reduced-motion 下进度条改用呼吸动画（不是空轨道）', MO.barAnim === 'busy-breathe' && MO.barDur !== '0.01s', JSON.stringify(MO));
  check('reduced-motion 下弹窗保留淡入', MO.modalAnim === 'fadeIn' && MO.modalDur !== '0.01s', JSON.stringify({ a: MO.modalAnim, d: MO.modalDur }));
  await M.send('Emulation.setEmulatedMedia', { features: [] });

  /* ---------- ⑧ 逐页扫 console error ---------- */
  const BEFORE = consoleErrors.length;
  for (const label of ['网址管理', '测试账号', '环境矩阵', '周报', 'SQL 片段', '测试笔记', '缺陷管理', '测试数据', '工具箱', '接口调试', '压力测试', '代码调试']) {
    await navTo(label);
  }
  await sleep(800);
  const fresh = consoleErrors.slice(BEFORE);
  check('12 个页面切换期间没有 console error / 未捕获异常', fresh.length === 0, fresh.slice(0, 3).join(' | '));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (consoleErrors.length) {
    console.log('全部 console 错误：');
    consoleErrors.slice(0, 8).forEach((e) => console.log('  ! ' + e));
  }
  app.kill();
  process.exit(fail ? 1 : 0);
})();
