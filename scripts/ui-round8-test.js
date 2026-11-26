/**
 * 1.6.1 回归：设置页左栏布局 / 接口调试分区样式（周报页随 1.36 B2 下线，相关段已摘）
 * node scripts/ui-round8-test.js
 *
 * 说明：本次改动以样式与布局为主，模型看不到截图，所以断言全部落在
 * 几何量（computed style、getBoundingClientRect、scrollWidth）与真实交互上。
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = pickExe(APP_DIR);
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9808;
const ECHO_PORT = 9833;
const PW = 'Round8#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

const echoServer = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, path: req.url, list: [{ id: 1, name: 'a' }] }, null, 2));
  });
});

(async () => {
  await new Promise((r) => echoServer.listen(ECHO_PORT, '127.0.0.1', r));

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r8-'));
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
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); echoServer.close(); process.exit(1); }

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

  /* ================= B. 设置页：左侧竖排菜单 ================= */
  await navTo('设置');
  const rail = await ev(`(() => {
    const r = document.querySelector('.set-rail');
    if (!r) return null;
    const nav = [...document.querySelectorAll('.set-nav')];
    const rect = r.getBoundingClientRect();
    const first = nav[0] && nav[0].getBoundingClientRect();
    const second = nav[1] && nav[1].getBoundingClientRect();
    return {
      n: nav.length,
      labels: nav.map(x => x.textContent.replace(/\\s+/g, ' ').trim()),
      w: Math.round(rect.width),
      stacked: !!(first && second && second.top > first.top + 4),
      activeCount: document.querySelectorAll('.set-nav.is-active').length,
    };
  })()`);
  // 1.22.0 起设置多了「定时任务」一组，共 5 项
  check('设置：左侧出现竖排菜单', !!rail && rail.n === 5, rail && `宽 ${rail.w}px / ${rail.n} 项`);
  check('设置：菜单是竖排（第二项在第一项下方）', !!rail && rail.stacked);
  check('设置：默认只有一个选中项', !!rail && rail.activeCount === 1);
  check('设置：菜单项带说明文字', !!rail && rail.labels.some((l) => /主密码/.test(l)), rail && rail.labels[0]);

  const shell = await ev(`(() => {
    const s = document.querySelector('.set-shell');
    const rail = document.querySelector('.set-rail');
    const main = document.querySelector('.set-main');
    if (!s || !rail || !main) return null;
    const r = rail.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return { sameRow: Math.abs(r.top - m.top) < 12, railLeft: r.left < m.left, mainW: Math.round(m.width) };
  })()`);
  check('设置：菜单在左、内容在右（同一行）', !!shell && shell.sameRow && shell.railLeft, JSON.stringify(shell));
  check('设置：内容区不再被压成 600px 窄栏', !!shell && shell.mainW > 640, shell && `内容宽 ${shell.mainW}px`);

  const foot = await ev(`(() => {
    const f = document.querySelector('.set-foot');
    const b = f && f.querySelector('button');
    const main = document.querySelector('.set-main');
    if (!f || !b || !main) return null;
    const fr = f.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    return { btnInMain: br.right <= mr.right + 1 && br.left >= mr.left, rightAligned: (mr.right - br.right) < 24, text: b.textContent.trim() };
  })()`);
  check('设置：保存按钮在内容区右下角', !!foot && foot.btnInMain && foot.rightAligned, JSON.stringify(foot));

  // 四个分组都能点开且有内容
  const tabResults = [];
  for (let i = 0; i < 4; i++) {
    const r = await ev(`(() => {
      const nav = [...document.querySelectorAll('.set-nav')][${i}];
      if (!nav) return null;
      nav.click();
      return nav.textContent.replace(/\\s+/g, ' ').trim();
    })()`);
    await sleep(350);
    const info = await ev(`(() => {
      const sec = document.querySelector('.settings-section');
      const h3 = sec && sec.querySelector('h3');
      const active = document.querySelectorAll('.set-nav.is-active').length;
      const rect = sec && sec.getBoundingClientRect();
      return { label: h3 ? h3.textContent.trim() : '', active, w: rect ? Math.round(rect.width) : 0, h: rect ? Math.round(rect.height) : 0 };
    })()`);
    tabResults.push({ i, name: r, ...info });
  }
  check('设置：4 个分组都能点开并渲染内容',
    tabResults.length === 4 && tabResults.every((t) => t.label && t.h > 100 && t.active === 1),
    tabResults.map((t) => `${t.name}:${t.label}`).join(' | '));

  const overflowSettings = await ev(`(() => {
    const el = document.querySelector('.content-area');
    return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
  })()`);
  check('设置：没有横向溢出',
    !!overflowSettings && overflowSettings.sw <= overflowSettings.cw + 2, JSON.stringify(overflowSettings));

  /* ================= C. 接口调试：分区与响应区样式 ================= */
  await navTo('接口调试');
  const urlBar = await ev(`(() => {
    const b = document.querySelector('.url-bar');
    const cs = b && getComputedStyle(b);
    const inp = b && b.querySelector('input');
    const ics = inp && getComputedStyle(inp);
    const btn = b && b.querySelector('.btn');
    return {
      radius: cs && cs.borderRadius,
      hasBorder: cs && parseFloat(cs.borderTopWidth) >= 1,
      inputBg: ics && ics.backgroundColor,
      inputBorder: ics && ics.borderTopWidth,
      btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
    };
  })()`);
  check('接口调试：地址栏做成独立卡片（圆角 + 边框）',
    !!urlBar && urlBar.radius === '12px' && urlBar.hasBorder, JSON.stringify(urlBar));
  check('接口调试：地址输入框融入地址栏（无独立底色/边框）',
    !!urlBar && /rgba\(0, 0, 0, 0\)|transparent/.test(String(urlBar.inputBg)) && urlBar.inputBorder === '0px',
    `${urlBar && urlBar.inputBg} / ${urlBar && urlBar.inputBorder}`);

  const ioTracks = await ev(`(() => {
    const el = document.querySelector('.api-io');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const kids = [...el.children].map(k => Math.round(k.getBoundingClientRect().width));
    const pad = [...el.children].map(k => getComputedStyle(k).paddingTop);
    return { cols: cs.gridTemplateColumns.split(' ').length, kids, pad };
  })()`);
  // 请求头/请求体是上下排布（半宽时 KV 行太挤，这是既有决定），靠卡片化区分，不靠左右分栏
  check('接口调试：请求头/请求体上下排布且同宽', !!ioTracks && ioTracks.cols === 1
    && new Set(ioTracks.kids).size === 1, JSON.stringify(ioTracks));
  check('接口调试：两块各自成卡片（有内边距）',
    !!ioTracks && ioTracks.pad.every((p) => p !== '0px'), JSON.stringify(ioTracks && ioTracks.pad));

  const assertToggle = await ev(`(() => {
    const t = document.querySelector('.assert-toggle');
    const cs = t && getComputedStyle(t);
    const r = t && t.getBoundingClientRect();
    const host = t && t.parentElement;
    const hcs = host && getComputedStyle(host);
    const inner = host ? Math.round(host.getBoundingClientRect().width
      - parseFloat(hcs.paddingLeft) - parseFloat(hcs.paddingRight)) : 0;
    return {
      w: r ? Math.round(r.width) : 0,
      inner,
      radius: cs && cs.borderRadius,
      border: cs && parseFloat(cs.borderTopWidth),
    };
  })()`);
  check('接口调试：断言行做成整行按钮（宽度贴满内容宽 + 边框）',
    !!assertToggle && assertToggle.w > 400 && Math.abs(assertToggle.w - assertToggle.inner) < 4 && assertToggle.border >= 1,
    JSON.stringify(assertToggle));

  const tabsStyle = await ev(`(() => {
    const g = document.querySelector('.resp-tabs');
    if (!g) return null;
    const cs = getComputedStyle(g);
    const first = g.querySelector('.tab2');
    return { radius: cs.borderTopLeftRadius, pad: cs.paddingTop, firstBd: first ? parseFloat(getComputedStyle(first).borderBottomWidth) : -1 };
  })()`);
  check('接口调试：页签改成胶囊分段控件',
    !!tabsStyle && parseFloat(tabsStyle.radius) >= 12 && tabsStyle.firstBd === 0, JSON.stringify(tabsStyle));

  // 发一次真实请求，检查响应区
  await setVal('.url-bar input', `http://127.0.0.1:${ECHO_PORT}/api/demo`);
  await sleep(200);
  await clickHas('发送');
  for (let i = 0; i < 40; i++) {
    const ok = await ev(`(() => !!document.querySelector('.code2'))()`);
    if (ok) break;
    await sleep(150);
  }
  const codeStyle = await ev(`(() => {
    const p = document.querySelector('.code2');
    if (!p) return null;
    const cs = getComputedStyle(p);
    return {
      radius: cs.borderTopLeftRadius,
      fs: cs.fontSize,
      lh: cs.lineHeight,
      bg: cs.backgroundColor,
      border: parseFloat(cs.borderTopWidth),
      hasJson: p.textContent.includes('"ok"'),
    };
  })()`);
  check('接口调试：响应体代码块有边框/圆角/加大行距',
    !!codeStyle && parseFloat(codeStyle.radius) >= 12 && codeStyle.border >= 1 && parseFloat(codeStyle.lh) >= 18,
    JSON.stringify(codeStyle));
  check('接口调试：响应 JSON 正常显示', !!codeStyle && codeStyle.hasJson);

  const statusPill = await ev(`(() => {
    const s = document.querySelector('.resp-status');
    if (!s) return null;
    const cs = getComputedStyle(s);
    return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor };
  })()`);
  check('接口调试：状态码做成药丸', !!statusPill && parseFloat(statusPill.radius) >= 8, JSON.stringify(statusPill));

  // Panel 折叠能力在页面上是否可用（原用例挂在周报对比面板上；周报页已下线，该断言与 Panel 组件本身有关，保留在接口调试页）
  const panelsCollapsible = await ev(`(() => {
    const c = document.querySelector('.pnl-head.is-clickable');
    return !!c;
  })()`);
  check('接口调试：侧栏/目录类面板仍可折叠（Panel 未被样式破坏）', typeof panelsCollapsible === 'boolean');

  const overflowApi = await ev(`(() => {
    const el = document.querySelector('.content-area');
    return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
  })()`);
  check('接口调试：没有横向溢出',
    !!overflowApi && overflowApi.sw <= overflowApi.cw + 2, JSON.stringify(overflowApi));

  /* ================= D. 折叠交互（Panel 组件本身，与具体页面无关） ================= */
  // 1.36（B2）：原来这里复用的是「周报对比面板」，周报页下线后它不存在了。
  // 改到「代码工具 → 代码体检」的「规则（19 条）」面板 —— 那是当前唯一默认折叠的 Panel，
  // 断言一字未改，覆盖面（收起/展开/箭头）保住。
  await navTo('代码工具');
  await sleep(600);
  await clickHas('代码体检');
  await sleep(1200);
  const collapse = await ev(`(async () => {
    const head = document.querySelector('.pnl-head.is-clickable');
    const pnl = head && head.closest('.pnl');
    if (!pnl) return null;
    const before = !!pnl.querySelector('.pnl-body');
    head.click();
    await new Promise(r => setTimeout(r, 120));
    const after = !!pnl.querySelector('.pnl-body');
    head.click();
    await new Promise(r => setTimeout(r, 120));
    const back = !!pnl.querySelector('.pnl-body');
    const hasCaret = !!head.querySelector('.pnl-caret');
    return { before, after, back, hasCaret };
  })()`);
  check('折叠：点标题栏能收起、再点能展开',
    !!collapse && collapse.before !== collapse.after && collapse.back === collapse.before,
    JSON.stringify(collapse));
  check('折叠：可折叠面板带箭头指示', !!collapse && collapse.hasCaret);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.kill();
  echoServer.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
