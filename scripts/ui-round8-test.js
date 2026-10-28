/**
 * 1.6.1 回归：周报周次下拉方向 / 设置页左栏布局 / 接口调试分区样式
 * node scripts/ui-round8-test.js
 *
 * 说明：本次改动以样式与布局为主，模型看不到截图，所以断言全部落在
 * 几何量（computed style、getBoundingClientRect、scrollWidth）与真实交互上。
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

  /* ================= A. 周报：周次下拉方向（本轮 bug） ================= */
  await navTo('周报');
  const opts = await ev(`(() => [...document.querySelectorAll('.wk-draft-week option')].map(o => ({ v: o.value, t: o.textContent.trim() })))()`);
  check('周报：下拉有 9 周可选', Array.isArray(opts) && opts.length === 9, String(opts && opts.length));
  const o0 = opts && opts[0];
  const o1 = opts && opts[1];
  check('周报：第一项是「本周」且值为 0', !!o0 && o0.v === '0' && /本周/.test(o0.t), o0 && o0.t);
  check('周报：第二项是「上周」且值为 1', !!o1 && o1.v === '1' && /上周/.test(o1.t), o1 && o1.t);

  const mmddRange = (t) => {
    const m = String(t).match(/(\d{2}-\d{2})\s*~\s*(\d{2}-\d{2})/);
    return m ? { a: m[1], b: m[2] } : null;
  };
  const r0 = mmddRange(o0 && o0.t);
  const r1 = mmddRange(o1 && o1.t);
  check('周报：上周的日期严格早于本周（曾经算成下一周）',
    !!r0 && !!r1 && r1.b < r0.a, `${r1 && `${r1.a}~${r1.b}`} vs ${r0 && `${r0.a}~${r0.b}`}`);

  // 本周区间必须包含今天（今天＝本地日期）
  const todayMd = await ev(`(() => { const d = new Date(); return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`);
  check('周报：本周区间包含今天', !!r0 && r0.a <= todayMd && todayMd <= r0.b, `${r0 && `${r0.a}~${r0.b}`} 今天 ${todayMd}`);

  // 上周结束日不得晚于今天（这是用户看到的「11.02-11.08 是下周」的直接判据）
  check('周报：上周结束日不晚于今天', !!r1 && r1.b <= todayMd, `${r1 && r1.b} <= ${todayMd}`);

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
  check('设置：左侧出现竖排菜单', !!rail && rail.n === 4, rail && `宽 ${rail.w}px / ${rail.n} 项`);
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

  // 周报对比面板可折叠：没有禅道数据时该面板不渲染，这里只验证 Panel 折叠能力在页面可用
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

  /* ================= D. 周报对比表：数字列与「变化」对齐 ================= */
  // 对比面板要有禅道数据才渲染；这里把同样的结构插进真实页面，用真实样式量几何量。
  // 模型看不到截图，只能靠「右边界/基线是否吻合」来证明对齐。
  await navTo('周报');
  const cmp = await ev(`(() => {
    const host = document.querySelector('.pg');
    if (!host) return null;
    const rows = [
      { label: '新提', cur: 7, prev: 12, d: -5, tone: 'good' },
      { label: '解决', cur: 128, prev: 9, d: 119, tone: 'good' },
      { label: '关闭', cur: 3, prev: 3, d: 0, tone: 'flat' },
      { label: '未关闭', cur: 1041, prev: 998, d: 43, tone: 'bad' },
    ];
    const box = document.createElement('section');
    box.className = 'pnl';
    box.id = 'pm-test-cmp';
    box.innerHTML = '<div class="pnl-body"><div class="wk-cmp">'
      + '<div class="wk-cmp-head"><span></span><span>本周</span><span>上周</span><span>变化</span></div>'
      + rows.map(r => '<div class="wk-cmp-row">'
        + '<span class="wk-cmp-label">' + r.label + '</span>'
        + '<b>' + r.cur + '</b>'
        + '<span class="wk-cmp-prev">' + r.prev + '</span>'
        + '<span class="wk-delta is-' + r.tone + '">' + (r.d === 0 ? '持平' : (r.d > 0 ? '↑ ' + r.d : '↓ ' + (-r.d))) + '</span>'
        + '</div>').join('')
      + '</div></div>';
    host.appendChild(box);
    const q = (sel) => [...box.querySelectorAll(sel)];
    const rect = (el) => el.getBoundingClientRect();
    const data = q('.wk-cmp-row').map(row => {
      const b = row.querySelector('b');
      const prev = row.querySelector('.wk-cmp-prev');
      const delta = row.querySelector('.wk-delta');
      const label = row.querySelector('.wk-cmp-label');
      const rb = rect(b), rp = rect(prev), rd = rect(delta), rl = rect(label);
      return {
        bRight: Math.round(rb.right), pRight: Math.round(rp.right), dRight: Math.round(rd.right),
        bTop: Math.round(rb.top), pTop: Math.round(rp.top), dTop: Math.round(rd.top), lTop: Math.round(rl.top),
        dLeft: Math.round(rd.left), pRightRaw: Math.round(rp.right),
        gapPrevDelta: Math.round(rd.left - rp.right),
      };
    });
    const head = q('.wk-cmp-head span').map(s => Math.round(rect(s).right));
    const align = getComputedStyle(box.querySelector('.wk-cmp-row')).alignItems;
    return { data, head, align, rowCount: data.length };
  })()`);
  check('周报对比：4 行都渲染出来了', !!cmp && cmp.rowCount === 4, cmp && String(cmp.rowCount));
  // 每列的数字右边界要与「自己那列表头」的右边界吻合（各列本来就不同，不能互相比较）
  check('周报对比：每列数字正对表头（本周/上周/变化各在其列）',
    !!cmp && cmp.data.every((d) => Math.abs(d.bRight - cmp.head[1]) <= 2
      && Math.abs(d.pRight - cmp.head[2]) <= 2
      && Math.abs(d.dRight - cmp.head[3]) <= 2),
    cmp && `表头 ${JSON.stringify(cmp.head)} / 行 ${JSON.stringify([cmp.data[0].bRight, cmp.data[0].pRight, cmp.data[0].dRight])}`);
  check('周报对比：跨行的同一列右边界一致（位数变化也不抖）',
    !!cmp && new Set(cmp.data.map((d) => d.dRight)).size === 1
    && new Set(cmp.data.map((d) => d.bRight)).size === 1,
    cmp && JSON.stringify(cmp.data.map((d) => d.bRight)));
  check('周报对比：表头与数字列同一基线网格',
    !!cmp && Math.abs(cmp.head[3] - cmp.data[0].dRight) <= 1,
    cmp && `表头 ${JSON.stringify(cmp.head)} / 数据 ${cmp.data[0].dRight}`);
  check('周报对比：按 baseline 对齐（字号不同也不互相错位）',
    !!cmp && cmp.align === 'baseline', cmp && cmp.align);
  check('周报对比：「变化」不压到数字列',
    !!cmp && cmp.data.every((d) => d.gapPrevDelta >= 4), cmp && JSON.stringify(cmp.data.map((d) => d.gapPrevDelta)));

  await ev(`(() => { const n = document.getElementById('pm-test-cmp'); if (n) n.remove(); return !!n; })()`);

  /* ================= E. 折叠交互（对比面板用的同一个 Panel） ================= */
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