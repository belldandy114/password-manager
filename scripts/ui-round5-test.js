/**
 * 1.4.0 新功能回归：分页 / 导出 / 缓存 / 断言 / 批量 / 体检 / 审计 / Esc / 趋势图
 * node scripts/ui-round5-test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = path.join(APP_DIR, '测试工具.exe');
const PORT = 9801;
const PW = 'Round5#2026';
const ZT = require('./zt-config');
const { ensureZt } = require('./zt-stub');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

(async () => {
  // 没配真实禅道就用本地桩，回归不依赖内网地址与账号
  const zt = await ensureZt(9845);
  if (zt.stub) console.log('· 未配置 ZT_* 环境变量，使用本地禅道桩服务');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r5-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd: APP_DIR, windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 等待 */ }
    await sleep(400);
  }
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); zt.stop(); process.exit(1); }

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
  await sleep(1600);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', r.exceptionDetails.exception?.description?.slice(0, 180));
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
  const clickText = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    await sleep(500);
    // 页面是懒加载 chunk，等真正渲染出来再断言
    for (let i = 0; i < 40; i++) {
      const ready = await ev(`(() => !document.querySelector('.page-loading') && !!document.querySelector('.pg'))()`);
      if (ready) break;
      await sleep(100);
    }
    await sleep(400);
  };

  // 登录
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], '${PW}'); if (ins[1]) s(ins[1], '${PW}'); return 1; })()`);
  await sleep(300);
  await clickText('设置主密码');
  await sleep(2200);

  // ---------- C1 安全体检 ----------
  await ev(`(async () => {
    const mk = (id, name, pwd, days) => ({
      id, name, url: 'https://' + id + '.example.com', username: id, password: pwd,
      envType: 'testing', notes: '', tags: [], favorite: false,
      createdAt: new Date(Date.now() - days * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - days * 86400000).toISOString(),
    });
    await window.electronAPI.entriesAdd(mk('a1', '重复A', 'SamePwd123', 5));
    await window.electronAPI.entriesAdd(mk('a2', '重复B', 'SamePwd123', 5));
    await window.electronAPI.entriesAdd(mk('a3', '弱密码', '123456', 5));
    await window.electronAPI.entriesAdd(mk('a4', '老密码', 'Strong#Pass9', 400));
    const all = await window.electronAPI.entriesGetAll();
    return all.data ? all.data.entries.length : -1;
  })()`);
  await sleep(400);
  await ev(`(async () => { const r = await window.electronAPI.entriesGetAll(); if (r.data) { const W = window; } return 1; })()`);
  // 刷新 store
  await navTo('网址管理');
  await ev(`(() => location.reload())()`).catch(() => {});
  await sleep(1800);
  // reload 后重新解锁
  const locked = await ev(`(() => !!document.querySelector('input[type=password]'))()`);
  if (locked) {
    await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; if (ins[0]) s(ins[0], '${PW}'); return 1; })()`);
    await sleep(300);
    await clickText('解锁');
    await sleep(1800);
    await navTo('网址管理');
  }
  const auditOpened = await clickText('安全体检');
  await sleep(700);
  const auditText = await ev(`(() => { const m = document.querySelector('.modal'); return m ? m.textContent : ''; })()`);
  check('网址管理：安全体检能打开', auditOpened && /安全体检/.test(String(auditText)), String(auditText).slice(0, 40).replace(/\s+/g, ' '));
  check('体检识别重复密码', /重复密码/.test(String(auditText)));
  check('体检识别弱密码', /弱密码/.test(String(auditText)));
  check('体检识别长期未改', /180 天/.test(String(auditText)));
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return 1; })()`);
  await sleep(400);

  // ---------- C3 审计日志 ----------
  const auditRes = await ev(`(async () => {
    await window.electronAPI.auditLog('复制密码', '测试条目');
    const r = await window.electronAPI.auditList(10);
    return JSON.stringify({ ok: r.success, n: (r.data || []).length, first: (r.data || [])[0] });
  })()`);
  check('审计日志可写入并读回', /"ok":true/.test(auditRes) && /复制密码/.test(auditRes), auditRes.slice(0, 80));

  // ---------- B2 断言 ----------
  await navTo('接口调试');
  await sleep(600);
  // 打开断言面板
  await ev(`(() => { const b = [...document.querySelectorAll('.assert-toggle')].find(x => x.textContent.includes('断言')); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  // 1.6.0 起断言从 5 个固定槽位改成可增删的规则行
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('添加断言')); if (b) b.click(); return !!b; })()`);
  await sleep(350);
  const assertUi = await ev(`(() => document.querySelectorAll('.assert-rule').length)()`);
  check('接口调试：断言改成可增删的规则行', assertUi >= 1, `${assertUi} 行`);

  // 用 127.0.0.1 的本地服务做一次真实请求：起一个临时 HTTP 服务不方便，改用 data 不现实
  // 直接调用 apiSend 走 httpbin 之类不稳定，改为对 GitHub API 发一次 GET 并断言
  const urlOk = await ev(`(() => {
    const s = ${SETVAL};
    const inputs = [...document.querySelectorAll('.url-bar input')];
    if (inputs[0]) s(inputs[0], '${ZT.baseUrl}/user-login.html');
    return inputs.length;
  })()`);
  await sleep(300);
  // 填断言：状态码 200（新格式第一行就是状态码）
  await ev(`(() => {
    const s = ${SETVAL};
    const row = document.querySelector('.assert-rule');
    if (!row) return 'no-row';
    const ins = [...row.querySelectorAll('input:not([disabled])')];
    if (ins[0]) s(ins[0], '200');
    return 'filled';
  })()`);
  await sleep(200);
  await clickText('发送');
  for (let i = 0; i < 25; i++) {
    const has = await ev(`(() => !!document.querySelector('.assert-bar'))()`);
    if (has) break;
    await sleep(800);
  }
  const assertBar = await ev(`(() => { const b = document.querySelector('.assert-bar'); return b ? b.textContent : ''; })()`);
  check('断言执行并显示结果', /断言 \d+ \/ \d+/.test(String(assertBar)), String(assertBar).slice(0, 50).replace(/\s+/g, ' '));
  check('状态码 200 断言通过', /全部通过/.test(String(assertBar)), String(assertBar).slice(0, 40));

  // ---------- B3 批量运行 ----------
  // 保存两条请求后批量跑
  await ev(`(async () => {
    const base = { headers: '', body: '', variables: '', cookies: '', assertions: { status: '200' } };
    await window.electronAPI.wsSet('apiRequests', [
      { ...base, id: 'r1', name: '禅道登录页', method: 'GET', url: '${ZT.baseUrl}/user-login.html', updatedAt: new Date().toISOString() },
      { ...base, id: 'r2', name: '断言故意不成立', method: 'GET', url: '${ZT.baseUrl}/no-such-page-xyz.html', assertions: { status: '201' }, updatedAt: new Date().toISOString() },
    ]);
    return 1;
  })()`);
  await navTo('禅道');
  await sleep(300);
  await navTo('接口调试');
  await sleep(900);
  const pickedOk = await ev(`(() => {
    const boxes = [...document.querySelectorAll('.api-pick input')];
    boxes.forEach(b => b.click());
    return boxes.length;
  })()`);
  await sleep(400);
  const batchBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('.api-batch-bar button')].find(x => x.textContent.includes('批量运行'));
    if (b) { b.click(); return b.textContent; }
    return 'not-found';
  })()`);
  check('批量运行按钮可用', String(batchBtn).includes('批量运行'), String(batchBtn));
  for (let i = 0; i < 30; i++) {
    const n = await ev(`(() => document.querySelectorAll('.batch-row').length)()`);
    if (n >= 2) break;
    await sleep(1000);
  }
  const batchText = await ev(`(() => { const m = document.querySelector('.modal'); return m ? m.textContent : ''; })()`);
  check('批量运行出结果（含通过率）', /通过 \d+ \/ \d+/.test(String(batchText)), String(batchText).slice(0, 60).replace(/\s+/g, ' '));
  check('批量识别出失败项', /失败 [1-9]\d* 条/.test(String(batchText)) && /通过 1 \/ 2/.test(String(batchText)));
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return 1; })()`);
  await sleep(400);

  // ---------- Esc 关闭 ----------
  await ev(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
  await sleep(300);
  const modalGone = await ev(`(() => document.querySelectorAll('.modal-overlay').length)()`);
  check('Esc 关闭弹窗', modalGone === 0, `剩余 ${modalGone} 个弹层`);

  // ---------- A1/A2/A3 禅道 ----------
  await navTo('禅道');
  await sleep(700);
  const cfgInputs = await ev(`(() => {
    const ins = [...document.querySelectorAll('.pnl-body input')];
    return ins.length;
  })()`);
  if (cfgInputs >= 3 && !zt.stub) {
    await ev(`(() => {
      const s = ${SETVAL};
      const root = document.querySelector('.pnl-body');
      const ins = [...root.querySelectorAll('input')];
      ['${ZT.baseUrl}', '${ZT.account}', '${ZT.password}'].forEach((v, i) => { if (ins[i]) s(ins[i], v); });
      return 1;
    })()`);
    await sleep(300);
    await clickText('拉取我的 Bug');
    for (let i = 0; i < 40; i++) {
      const n = await ev(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`);
      if (n > 0) break;
      await sleep(1000);
    }
    await sleep(600);

    const pagerInfo = await ev(`(() => { const p = document.querySelector('.pager-info'); return p ? p.textContent : ''; })()`);
    check('禅道：分页器显示条数范围', /第 \d+–\d+ 条，共 \d+ 条/.test(String(pagerInfo)), String(pagerInfo));
    const rows1 = await ev(`(() => { const t = document.querySelectorAll('.tbl'); return t.length ? t[t.length - 1].querySelectorAll('tbody tr').length : 0; })()`);
    check('禅道：单页最多 100 行', rows1 <= 100, `${rows1} 行`);

    const nextOk = await ev(`(() => {
      const b = [...document.querySelectorAll('.pager-btn')].find(x => x.title === '下一页');
      if (!b) return 'no-btn';
      b.click();
      return b.disabled ? 'disabled' : 'clicked';
    })()`);
    await sleep(500);
    const pagerCur = await ev(`(() => { const p = document.querySelector('.pager-cur'); return p ? p.textContent : ''; })()`);
    check('禅道：翻页生效', nextOk === 'clicked' || /2 \/ \d+/.test(String(pagerCur)), `${nextOk} · ${pagerCur}`);

    const trend = await ev(`(() => {
      const s = document.querySelector('.trend-svg');
      return s ? s.querySelectorAll('path').length : 0;
    })()`);
    check('禅道：趋势图有折线', Number(trend) >= 3, `${trend} 条路径`);

    // 导出：绕过系统保存对话框，直接验证 CSV 生成接口存在
    const exportBtn = await ev(`(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出')))()`);
    check('禅道：有导出按钮', !!exportBtn);

    // 缓存：连续两次拉全部项目，第二次应命中
    await clickText('项目 Bug');
    await sleep(400);
    await ev(`(() => { const s = document.querySelector('.zt-proj-pick select'); return s ? s.options.length : 0; })()`);
    await clickText('刷新项目列表');
    for (let i = 0; i < 40; i++) {
      const n = await ev(`(() => { const s = document.querySelector('.zt-proj-pick select'); return s ? s.options.length : 0; })()`);
      if (n > 1) break;
      await sleep(1000);
    }
    const pickAll = await ev(`(() => {
      const s = document.querySelector('.zt-proj-pick select');
      if (!s) return 'no-select';
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      d.call(s, '__all__');
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'switched';
    })()`);
    for (let i = 0; i < 60; i++) {
      const t = await ev(`(() => { const c = document.querySelector('.zt-card .zt-card-num'); return c ? Number(c.textContent) : 0; })()`);
      if (t > 0) break;
      await sleep(1000);
    }
    const cacheCheck = await ev(`(async () => {
      const cfg = { id: 'zentao', baseUrl: '${ZT.baseUrl}', account: '${ZT.account}', password: '${ZT.password}' };
      const a = await window.electronAPI.zentaoAllBugs(cfg);
      const b = await window.electronAPI.zentaoAllBugs(cfg);
      return JSON.stringify({
        firstCached: !!a.cached, secondCached: !!b.cached,
        total: b.total, age: b.ageMs,
      });
    })()`);
    check('禅道：全量 Bug 第二次命中缓存', /"secondCached":true/.test(String(cacheCheck)), String(cacheCheck).slice(0, 90));
    const meta1 = '';
    // 再切一次项目再看，应显示缓存
    await ev(`(() => {
      const s = document.querySelector('.zt-proj-pick select');
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      const opt = [...s.options].find(o => o.value && o.value !== '__all__');
      d.call(s, opt.value); s.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    })()`);
    await sleep(2500);
    await ev(`(() => {
      const s = document.querySelector('.zt-proj-pick select');
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      d.call(s, '__all__'); s.dispatchEvent(new Event('change', { bubbles: true }));
      return 1;
    })()`);
    await sleep(1200);
    void meta1;
  } else if (cfgInputs >= 3 && zt.stub) {
    console.log('- 禅道：分页 / 翻页 / 趋势图 / 导出 / 缓存（跳过：本地桩登不进真实禅道）');
  } else {
    check('禅道：连接配置可展开', false, '输入框数量不足');
  }

  console.log('─'.repeat(50));
  console.log(`${pass}/${pass + fail} 通过`);

  app.kill();
  await sleep(600);
  try { ws.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* 忽略 */ }
  zt.stop();
  process.exit(fail ? 1 : 0);
})();
