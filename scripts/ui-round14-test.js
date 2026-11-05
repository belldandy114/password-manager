/**
 * 1.14.0 回归：「我的 Bug」「项目 Bug」两个标签页的修复
 *
 * 覆盖（都是本轮修的问题）：
 *   ① 项目 Bug 有「模块」列与模块筛选，筛选后行数与列值自洽
 *   ② 「全部项目」里点「致命」列不再筛出空列表（以前把严重程度当状态传了）
 *   ③ 不勾选直接复制 → 复制的是「当前筛选后的全部」，不再偷偷截断到 50 条
 *   ④ 切换标签页会清空勾选（以前会带着上一个页签的 id，按钮写着"复制 N"却复制不出东西）
 *   ⑤ 「我的 Bug」的「全部项目」开关两个方向都会重拉，标签与真实查询一致
 *
 * 跑法（禅道配置走环境变量，仓库里不存账号）：
 *   ZT_BASEURL=http://<禅道>/zentao ZT_ACCOUNT=xxx ZT_PASSWORD=xxx \
 *   node scripts/ui-round14-test.js
 *   加 USE_PACKED=1 跑 release/win-unpacked。
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const ZT = require('./zt-config');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = pickExe(APP_DIR);
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9814;
const PW = 'Round14#2026';
const PID = process.env.ZT_PRODUCT || '58';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

(async () => {
  if (!ZT.ready) {
    console.log('跳过：没有设置 ZT_BASEURL / ZT_ACCOUNT / ZT_PASSWORD 环境变量');
    process.exit(0);
  }

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r14-'));
  const env = { ...process.env, PM_USE_DIST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const cwd = usePacked ? APP_DIR : ROOT;
  const args = usePacked ? [] : ['.'];
  const app = spawn(EXE, [...args, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd, windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
      if (target) break;
    } catch { /* 等待 */ }
    await sleep(400);
  }
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false });
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
  const clickHas = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const waitFor = async (expr, timeout = 60000, step = 600) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(step);
    }
    return false;
  };

  // 首次使用：设置主密码
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await clickHas('设置主密码');
  await sleep(2600);

  // 进缺陷管理 + 填配置 + 保存（顺带拉项目列表）
  await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('缺陷管理')); if (n) n.click(); return !!n; })()`);
  await sleep(900);
  await ev(`(() => {
    const s = ${SETVAL};
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { s(el, v); return true; } return false; };
    set('input[placeholder^="http://"]', ${JSON.stringify(ZT.baseUrl)});
    set('input[placeholder="用户名"]', ${JSON.stringify(ZT.account)});
    set('input[placeholder="密码"]', ${JSON.stringify(ZT.password)});
    return 1;
  })()`);
  await sleep(300);
  await clickHas('登录并保存');
  await sleep(11000);
  await clickHas('刷新项目列表');
  await sleep(7000);

  /* ---------------- 项目 Bug ---------------- */
  await ev(`(() => { const b = [...document.querySelectorAll('.tabs .tab2')].find(x => x.textContent.includes('项目 Bug')); if (b) b.click(); return !!b; })()`);
  await sleep(900);

  // 选 58（下拉 change 会触发拉取）
  await ev(`(() => { const s = ${SETVAL}; const el = document.querySelector('.zt-proj-pick select'); if (!el) return false; s(el, ${JSON.stringify(PID)}); return true; })()`);
  const loaded = await waitFor(`(() => document.querySelectorAll('.zt-row').length > 0)()`, 120000, 800);
  check('项目 Bug 拉取到数据', loaded, `${await ev(`(() => document.querySelectorAll('.zt-row').length)()`)} 行`);

  const headers = await ev(`(() => [...document.querySelectorAll('.tbl thead th')].map(t => t.textContent.trim()))()`);
  check('表格有「模块」列', (headers || []).includes('模块'), JSON.stringify(headers));

  const modOpts = await ev(`(() => {
    const sels = [...document.querySelectorAll('.zt-filters select')];
    const s = sels.find(x => [...x.options].some(o => /全部模块/.test(o.textContent)));
    if (!s) return null;
    return { total: s.options.length - 1, sample: s.options[1] ? s.options[1].textContent : '' };
  })()`);
  check('有模块筛选下拉', !!modOpts && modOpts.total > 0, modOpts ? `${modOpts.total} 个模块，示例 ${modOpts.sample}` : '无');

  // 选第一个模块 → 行数应等于该模块条数，且每行模块列都是它
  const beforeRows = await ev(`(() => document.querySelectorAll('.zt-row').length)()`);
  const modPick = await ev(`(() => {
    const sels = [...document.querySelectorAll('.zt-filters select')];
    const s = sels.find(x => [...x.options].some(o => /全部模块/.test(o.textContent)));
    if (!s || !s.options[1]) return null;
    const name = s.options[1].value;
    const count = Number((s.options[1].textContent.match(/（(\\d+)）/) || [])[1] || 0);
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    d.call(s, name);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return { name, count };
  })()`);
  await sleep(900);
  const afterRows = await ev(`(() => document.querySelectorAll('.zt-row').length)()`);
  // 表格列序：勾选 / ID / 标题 / 状态 / 严重程度 / 模块 / 指派给 / 优先级 / 项目 / 创建日期
  const modCells = await ev(`(() => [...document.querySelectorAll('.zt-row')].map(tr => tr.children[5] ? tr.children[5].textContent.trim() : ''))()`);
  const metaAfter = await ev(`(() => {
    const m = [...document.querySelectorAll('.pnl-meta')].map(x => x.textContent).find(t => /\\/ \\d+ 条/.test(t));
    const mm = m && m.match(/(\\d+) \\/ (\\d+) 条/);
    return mm ? Number(mm[1]) : -1;
  })()`);
  check('按模块筛选后「筛选后条数」= 该模块条数', !!modPick && metaAfter === modPick.count,
    `模块「${modPick && modPick.name}」${modPick && modPick.count} 条 → 面板显示 ${metaAfter} 条（每页 ${afterRows} 行）`);
  check('筛选后每行的模块列都是它', !!modPick && (modCells || []).length > 0 && modCells.every(v => v === modPick.name),
    JSON.stringify((modCells || []).slice(0, 3)));
  check('模块筛选后行数不多于全部', afterRows <= beforeRows, `${beforeRows} → ${afterRows}`);

  // 清掉模块筛选（点 FilterBar 的 chip）
  await ev(`(() => { const c = [...document.querySelectorAll('.filter-bar button, .zt-chips button')].find(x => /模块：/.test(x.textContent)); if (c) { c.click(); return true; } return false; })()`);
  await sleep(700);
  const cleared = await ev(`(() => document.querySelectorAll('.zt-row').length)()`);
  check('清掉模块筛选后行数恢复', cleared === beforeRows, `${afterRows} → ${cleared}`);

  // 复制（不勾选）→ 应为「当前筛选后的全部」，不是 50 条
  const visibleCount = await ev(`(() => {
    const m = [...document.querySelectorAll('.pnl-meta')].map(x => x.textContent).find(t => /\\/ \\d+ 条/.test(t));
    const mm = m && m.match(/(\\d+) \\/ (\\d+) 条/);
    return mm ? Number(mm[1]) : -1;
  })()`);
  await send('Page.bringToFront').catch(() => {});
  await sleep(400);
  await clickHas('复制');
  await waitFor(`(() => !!document.querySelector('.zt-sum-tip, .toast, .copied-tip') || /已复制|复制失败/.test(document.body.textContent))()`, 5000, 200);
  const copyTip = await ev(`(() => (document.body.textContent.match(/已复制 (\\d+) 条/) || [])[1] || '')()`);
  const copied = Number(copyTip || 0);
  check('不勾选复制的是筛选后的全部（不再是 50 条）',
    copied > 50 ? copied === visibleCount : copied > 0,
    `可见 ${visibleCount} 条 / 复制 ${copied} 条`);

  const clip = await ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR'; } })()`);
  if (String(clip) !== 'ERR') {
    const lines = String(clip).split('\n').filter(l => /#\d+/.test(l)).length;
    check('剪贴板行数与提示一致', lines === copied || copied === 0, `剪贴板 ${lines} 行 / 提示 ${copied} 条`);
  }

  // 勾一条 → 切到「我的 Bug」→ 勾选应被清空
  await ev(`(() => { const c = document.querySelector('.zt-row .tbl-check'); if (c) { c.click(); return true; } return false; })()`);
  await sleep(400);
  const selBar1 = await ev(`(() => !!document.querySelector('.zt-selectbar'))()`);
  await ev(`(() => { const b = [...document.querySelectorAll('.tabs .tab2')].find(x => x.textContent.includes('我的 Bug')); if (b) b.click(); return !!b; })()`);
  await sleep(900);
  const selBar2 = await ev(`(() => !!document.querySelector('.zt-selectbar'))()`);
  check('勾选在切换标签页后被清空', selBar1 && !selBar2, `切换前 ${selBar1} / 切换后 ${selBar2}`);

  /* ---------------- 我的 Bug ---------------- */
  // 先切到「我提交的」并拉取（默认视图「指派给我」不显示指派给列，也还没拉过数据）
  await clickHas('我提交的');
  await sleep(600);
  await clickHas('拉取「我提交的」');
  const mineLoaded = await waitFor(`(() => document.querySelectorAll('.zt-row').length > 0)()`, 90000, 800);
  check('我的 Bug（我提交的）有数据', mineLoaded, `${await ev(`(() => document.querySelectorAll('.zt-row').length)()`)} 行`);

  const assigneeCol = await ev(`(() => [...document.querySelectorAll('.tbl thead th')].some(t => t.textContent.trim() === '指派给'))()`);
  check('「我提交的」显示「指派给」列', !!assigneeCol, JSON.stringify(await ev(`(() => [...document.querySelectorAll('.tbl thead th')].map(t => t.textContent.trim()))()`)));

  // 「全部项目」开关：两个方向都要重拉
  const allBefore = await ev(`(() => (document.body.textContent.match(/全部 (\\d+) 个项目/) || [])[1] || '')()`);
  await ev(`(() => { const b = document.querySelector('.zt-mine-proj-all'); if (b) { b.click(); return true; } return false; })()`);
  const allOn = await waitFor(`(() => !!document.querySelector('.zt-mine-proj-all.is-on'))()`, 5000, 200);
  await sleep(1200);
  const allAfter = await ev(`(() => (document.body.textContent.match(/全部 (\\d+) 个项目/) || [])[1] || '')()`);
  check('「全部项目」开关能打开且标签带上项目数', allOn && Number(allAfter) > 1, `全部 ${allAfter} 个项目（之前 ${allBefore || '单项目'}）`);

  const pulledAll = await waitFor(`(() => !/拉取中/.test(document.body.textContent))()`, 180000, 1000);
  check('「全部项目」拉取完成（没有卡在拉取中）', pulledAll);

  await ev(`(() => { const b = document.querySelector('.zt-mine-proj-all'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(1500);
  const allOff = await ev(`(() => !document.querySelector('.zt-mine-proj-all.is-on'))()`);
  check('「全部项目」能关回单项目', !!allOff);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('EXCEPTION', e && e.message);
  process.exit(1);
});
