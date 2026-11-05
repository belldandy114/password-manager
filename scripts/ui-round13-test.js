/**
 * 1.13.0 回归：缺陷管理「汇总」tab
 *
 * 覆盖：
 *   ① 多选项目 → 一次拉取所选项目的全部 Bug（含已关闭）
 *   ② 统计口径：缺陷总数 / 已修复 / 未修复 / 待验证 / 已关闭 / 修复率（已修复÷总数）
 *   ③ 按人员：人员指派共 N 个：某某 X 个；排除人员只改人员表（按指派人匹配），不动总数
 *   ④ 模块明细：展开项目行，看每个模块的未修复 / 未验证
 *   ⑤ 一键复制：整份汇总 + 单个项目
 *
 * 跑法（禅道配置走环境变量，仓库里不存账号）：
 *   ZT_BASEURL=http://<禅道>/zentao ZT_ACCOUNT=xxx ZT_PASSWORD=xxx \
 *   node scripts/ui-round13-test.js
 * 加 USE_PACKED=1 跑 release/win-unpacked，DEBUG13=1 打印 CDP 细节。
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
const PORT = 9813;
const PW = 'Round13#2026';
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

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r13-'));
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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (process.env.DEBUG13 && (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Runtime.consoleAPICalled')) {
      const d = msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.args?.map(a => a.value).slice(0, 3));
      console.log('DBG-CDP', String(d).slice(0, 300));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', r.exceptionDetails.exception?.description?.slice(0, 200));
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
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    await sleep(900);
  };
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

  // 基准：直接调接口统计，用来核对页面口径
  const cfg = { id: 'zentao', baseUrl: ZT.baseUrl, account: ZT.account, password: ZT.password };
  const api = await ev(`(async () => {
    const res = await window.electronAPI.zentaoSummary(${JSON.stringify(cfg)}, [${JSON.stringify(PID)}], true);
    if (!res.success) return { ok: false, error: res.error };
    const bugs = res.data || [];
    const mods = (res.modules || {})[${JSON.stringify(PID)}] || {};
    return {
      ok: true,
      total: bugs.length,
      fixed: bugs.filter(b => b.resolution === 'fixed').length,
      active: bugs.filter(b => b.status === 'active').length,
      resolved: bugs.filter(b => b.status === 'resolved').length,
      withModule: bugs.filter(b => b.moduleName).length,
      moduleCount: Object.keys(mods).length,
      sampleModule: (bugs.find(b => b.moduleName) || {}).moduleName || '',
    };
  })()`);
  check('汇总接口可用（拉全量 Bug）', !!api && api.ok, api && api.ok ? `${api.total} 条` : JSON.stringify(api));
  if (!api || !api.ok) {
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    app.kill();
    process.exit(1);
  }
  check('返回模块名映射', api.moduleCount > 3, `${api.moduleCount} 个模块，示例「${api.sampleModule}」`);
  check('Bug 带模块路径', api.withModule > 0, `${api.withModule}/${api.total} 条有模块名`);

  await navTo('缺陷管理');
  await sleep(700);

  const filled = await ev(`(() => {
    const s = ${SETVAL};
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { s(el, v); return true; } return false; };
    return [
      set('input[placeholder^="http://"]', ${JSON.stringify(ZT.baseUrl)}),
      set('input[placeholder="用户名"]', ${JSON.stringify(ZT.account)}),
      set('input[placeholder="密码"]', ${JSON.stringify(ZT.password)}),
    ].filter(Boolean).length;
  })()`);
  check('连接配置可填写', filled === 3, `${filled}/3`);
  await sleep(400);

  const tabs = await ev(`(() => [...document.querySelectorAll('.tabs .tab2')].map(b => b.textContent.trim()))()`);
  check('存在「汇总」tab', (tabs || []).includes('汇总'), JSON.stringify(tabs));

  await clickHas('汇总');
  await sleep(900);
  check('汇总面板已渲染', await ev(`(() => !!document.querySelector('.zt-sum-exclude'))()`));

  // 保存配置（顺带拉一次项目列表），再显式刷新一遍
  await clickHas('登录并保存');
  await sleep(11000);
  await clickHas('刷新项目列表');
  await sleep(7000);
  if (process.env.DEBUG13) {
    console.log('DBG err=', String(await ev(`(() => { const p = document.querySelector('.pill-bad'); return p ? p.textContent : ''; })()`)));
  }
  await clickHas('选择项目');
  await sleep(900);
  const prjCount = await ev(`(() => document.querySelectorAll('.zt-proj-item').length)()`);
  if (process.env.DEBUG13) {
    console.log('DBG modal=', String(await ev(`(() => { const m = document.querySelector('.modal'); return m ? m.textContent.slice(0, 120) : 'no-modal'; })()`)));
  }
  check('项目多选弹窗可用', Number(prjCount) > 0, `${prjCount} 个项目`);

  await ev(`(() => { const s = ${SETVAL}; const box = document.querySelector('.zt-proj-search input'); if (box) s(box, '${PID}'); return !!box; })()`);
  await sleep(500);
  await ev(`(() => {
    const it = [...document.querySelectorAll('.zt-proj-item')].find(x => x.textContent.includes('#${PID}'));
    if (it) { it.querySelector('input').click(); return true; }
    return false;
  })()`);
  await sleep(300);
  await clickHas('确定（');
  await sleep(800);
  const chip = await ev(`(() => { const c = document.querySelector('.zt-sum-chip-name'); return c ? c.textContent : ''; })()`);
  check('选中项目显示为标签', String(chip).length > 0, chip);

  await clickHas('拉取并汇总');
  const pulled = await waitFor(`(() => document.querySelectorAll('.zt-sum-tbl tbody tr.zt-sum-row').length > 0)()`, 120000, 900);
  check('拉取后出现项目行', pulled);

  const cards = await ev(`(() => [...document.querySelectorAll('.zt-sum-card')].map(c => ({ label: c.querySelector('.zt-sum-card-label').textContent, num: c.querySelector('.zt-sum-card-num').textContent })))()`);
  const val = (k) => Number(String(((cards || []).find(c => c.label === k) || {}).num || '0').replace('%', ''));
  const uiTotal = val('缺陷总数');
  const uiFixed = val('已修复');
  const uiActive = val('未修复');
  const uiResolved = val('待验证');
  const uiRate = val('修复率');
  check('缺陷总数 = 接口条数', uiTotal === api.total, `页面 ${uiTotal} / 接口 ${api.total}`);
  check('已修复对得上', uiFixed === api.fixed, `页面 ${uiFixed} / 接口 ${api.fixed}`);
  check('未修复对得上', uiActive === api.active, `页面 ${uiActive} / 接口 ${api.active}`);
  check('待验证对得上', uiResolved === api.resolved, `页面 ${uiResolved} / 接口 ${api.resolved}`);
  const expectRate = api.total ? Math.round((api.fixed / api.total) * 1000) / 10 : 0;
  check('修复率口径一致（已修复÷总数）', uiRate === expectRate, `页面 ${uiRate}% / 期望 ${expectRate}%`);

  await ev(`(() => { const r = document.querySelector('.zt-sum-row'); if (r) { r.click(); return true; } return false; })()`);
  await sleep(900);
  const modRows = await ev(`(() => [...document.querySelectorAll('.zt-sum-mtbl tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim())))()`);
  check('展开后有模块明细', (modRows || []).length > 0, `${(modRows || []).length} 个模块`);
  const named = (modRows || []).filter(r => r[0] && !/^模块\d+$/.test(r[0]) && r[0] !== '未指定模块').length;
  check('模块显示路径（不是「模块434」）', named > 0, JSON.stringify((modRows || []).slice(0, 3).map(r => r[0])));
  check('模块行含 缺陷/已修复/未修复/未验证/已关闭', (modRows[0] || []).length >= 6, JSON.stringify((modRows || [])[0] || []));
  const sumOfModules = (modRows || []).reduce((s, r) => s + Number(r[1] || 0), 0);
  check('模块缺陷数之和 = 项目缺陷数', sumOfModules === uiTotal, `${sumOfModules} / ${uiTotal}`);

  // ---- 按人员（谁身上还挂着缺陷）----
  const personLine0 = await ev(`(() => { const n = document.querySelector('.zt-sum-note'); return n ? n.textContent : ''; })()`);
  check('有「人员指派共 N 个：某某 X 个」这一行',
    /人员指派共 \d+ 个：/.test(String(personLine0)), String(personLine0).slice(0, 64));

  const lineN0 = Number((String(personLine0).match(/人员指派共 (\d+) 个/) || [])[1] || -1);
  const personRows0 = await ev(`(() => document.querySelectorAll('.zt-sum-prow').length)()`);
  const sum0 = await ev(`(() => [...document.querySelectorAll('.zt-sum-prow')].reduce((s, tr) => s + Number(tr.children[1].textContent.trim() || 0), 0))()`);
  check('人员表各人条数之和 = 人员指派共 N 个',
    personRows0 <= 12 ? sum0 === lineN0 : sum0 <= lineN0,
    `${personRows0} 人 · 表内和 ${sum0} / 行内 ${lineN0}`);

  // ---- 严重程度 / 修复率口径 ----
  const sevPills = await ev(`(() => [...document.querySelectorAll('.zt-sum-meta .pill')].map(p => p.textContent.trim()))()`);
  check('总计下方有严重程度分布', Array.isArray(sevPills) && sevPills.length > 0, JSON.stringify(sevPills));

  const rateLabel0 = await ev(`(() => { const c = [...document.querySelectorAll('.zt-sum-card')].find(x => /修复率/.test(x.textContent)); return c ? c.textContent : ''; })()`);
  await ev(`(() => { const c = [...document.querySelectorAll('.zt-sum-card.is-clickable')].find(x => /修复率/.test(x.textContent)); if (c) { c.click(); return true; } return false; })()`);
  await sleep(500);
  const rateLabel1 = await ev(`(() => { const c = [...document.querySelectorAll('.zt-sum-card')].find(x => /修复率/.test(x.textContent)); return c ? c.textContent : ''; })()`);
  check('修复率可切换成「未关闭」口径', /未关闭修复率/.test(rateLabel1) && !/未关闭修复率/.test(rateLabel0), `${rateLabel0} → ${rateLabel1}`);
  await ev(`(() => { const c = [...document.querySelectorAll('.zt-sum-card.is-clickable')].find(x => /修复率/.test(x.textContent)); if (c) { c.click(); return true; } return false; })()`);
  await sleep(400);

  // ---- 时间窗 ----
  const switchSince = (v) => ev(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.textContent === '近 7 天'));
    if (!s) return false;
    s.value = '${v}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const totalAll = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  await switchSince('7');
  await sleep(700);
  const total7 = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  check('时间窗「近 7 天」只统计窗口内提交的缺陷', total7 <= totalAll, `全部 ${totalAll} → 近 7 天 ${total7}`);
  await switchSince('0');
  await sleep(700);
  const totalBack = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  check('切回「全部时间」恢复原数字', totalBack === totalAll, `${total7} → ${totalBack}`);

  // ---- 人员下钻 ----
  const firstPersonTotal = await ev(`(() => {
    const tr = document.querySelector('.zt-sum-prow');
    if (!tr) return null;
    return { name: tr.querySelector('.zt-sum-name').textContent.trim(), n: Number(tr.children[1].textContent.trim()) };
  })()`);
  await ev(`(() => { const tr = document.querySelector('.zt-sum-prow'); if (tr) { tr.click(); return true; } return false; })()`);
  await sleep(800);
  const drillRows = await ev(`(() => document.querySelectorAll('.zt-sum-drill-row').length)()`);
  check('点人员行能看这人名下的缺陷清单',
    !!firstPersonTotal && Number(drillRows) === firstPersonTotal.n,
    `${firstPersonTotal && firstPersonTotal.name}：清单 ${drillRows} / 表内 ${firstPersonTotal && firstPersonTotal.n}`);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '关闭'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(500);

  // ---- 排除人员（选人弹窗）----
  const before = uiTotal;
  const person = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('选择人员（已选'));
    if (!b) return null;
    b.click();
    return 'opened';
  })()`);
  await sleep(800);
  const picked = await ev(`(() => {
    const it = document.querySelector('.modal .zt-proj-item');
    if (!it) return null;
    const name = it.querySelector('.zt-proj-name').textContent.trim();
    it.querySelector('input').click();
    return name;
  })()`);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.includes('确定（不计入')); if (b) { b.click(); return true; } return false; })()`);
  await sleep(900);

  check('选人弹窗可用并勾到了人', person === 'opened' && !!picked, String(picked));

  const afterTotal = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  check('排除人员不影响缺陷总数（只改人员表）', afterTotal === before, `${before} → ${afterTotal}`);

  const personRows1 = await ev(`(() => document.querySelectorAll('.zt-sum-prow').length)()`);
  check('被排除的人从人员表里消失', personRows1 === personRows0 - 1, `${personRows0} → ${personRows1} 行`);

  const personLine1 = await ev(`(() => { const n = document.querySelector('.zt-sum-note'); return n ? n.textContent : ''; })()`);
  // 只看「人员指派共 N 个：……」这段列表，末尾的「已排除 某某 名下 X 个」本来就会提到他
  const listed1 = String(personLine1).split('（')[0];
  check('人员分布行里不再有这个人的条数', !!picked && !listed1.includes(picked),
    `${picked} · ${listed1.slice(0, 50)}`);
  check('人员分布行注明已排除', /已排除/.test(String(personLine1)),
    (String(personLine1).match(/（.*?）/) || [''])[0].slice(0, 46));

  const skipTags = await ev(`(() => document.querySelectorAll('.zt-sum-skip').length)()`);
  check('项目行标注「排除 N」', Number(skipTags) > 0, `${skipTags} 个项目有标注`);

  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '全部恢复'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(800);
  const personRows2 = await ev(`(() => document.querySelectorAll('.zt-sum-prow').length)()`);
  const totalRestored = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  check('取消排除后人员表与总数都恢复', personRows2 === personRows0 && totalRestored === before,
    `${personRows2} 行 / ${totalRestored}`);

  // ---- 今日新增 + 统计日切换点 ----
  const todayCard = await ev(`(() => { const c=[...document.querySelectorAll('.zt-sum-card')].find(x=>x.textContent.includes('今日新增')); return c ? c.textContent.trim() : ''; })()`);
  check('总计里有「今日新增」卡片', /今日新增/.test(todayCard), todayCard);

  const dayBars = await ev(`(() => document.querySelectorAll('.zt-sum-day').length)()`);
  check('有按统计日切分的新增趋势柱', Number(dayBars) >= 5, `${dayBars} 天`);

  const dailyHead0 = await ev(`(() => { const h=document.querySelector('.zt-sum-daily-head'); return h ? h.textContent : ''; })()`);
  check('趋势条上方有「环比昨日」说明', /环比/.test(dailyHead0) && /昨日/.test(dailyHead0), String(dailyHead0).slice(0, 60));

  const cutExists = await ev(`(() => { const i=document.querySelector('.zt-sum-cutoff input[type=time]'); return i ? i.value : ''; })()`);
  check('统计日切换点默认 17:30', cutExists === '17:30', String(cutExists));

  await ev(`(() => {
    const s = ${SETVAL};
    const i = document.querySelector('.zt-sum-cutoff input[type=time]');
    if (!i) return false;
    s(i, '09:00');
    return true;
  })()`);
  await sleep(700);
  const dailyHead1 = await ev(`(() => { const h=document.querySelector('.zt-sum-daily-head'); return h ? h.textContent : ''; })()`);
  check('改切分点后说明文字同步变成 09:00', /09:00/.test(dailyHead1), String(dailyHead1).slice(-40));
  await ev(`(() => {
    const s = ${SETVAL};
    const i = document.querySelector('.zt-sum-cutoff input[type=time]');
    if (i) s(i, '17:30');
    return true;
  })()`);
  await sleep(500);

  // ---- 测试人员：标记 + 一键排除 ----
  const rowsBeforeTester = await ev(`(() => document.querySelectorAll('.zt-sum-prow').length)()`);
  const totalBeforeTester = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('选择人员（已选')); if(b){b.click();return true} return false; })()`);
  await sleep(800);
  const testerName = await ev(`(() => {
    const t = document.querySelector('.modal .zt-test-tag');
    if (!t) return null;
    const row = t.closest('.zt-proj-item');
    const name = row.querySelector('.zt-proj-name').textContent.trim();
    t.click();
    return name;
  })()`);
  await sleep(400);
  check('弹窗里能把人标成「测试」', !!testerName, String(testerName));
  await ev(`(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.includes('确定（不计入')); if(b){b.click();return true} return false; })()`);
  await sleep(600);

  const rosterChip = await ev(`(() => { const c=document.querySelector('.zt-sum-person.is-test'); return c ? c.textContent.trim() : ''; })()`);
  check('页面上能看到「测试人员」名单', !!rosterChip && rosterChip.includes(String(testerName)), String(rosterChip));

  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('排除测试人员')); if(b){b.click();return true} return false; })()`);
  await sleep(900);
  const rowsAfterTester = await ev(`(() => document.querySelectorAll('.zt-sum-prow').length)()`);
  const totalAfterTester = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  check('「排除测试人员」真的从人员表里去掉了', rowsAfterTester === rowsBeforeTester - 1,
    `${rowsBeforeTester} → ${rowsAfterTester} 行（${testerName}）`);
  check('排除测试人员不影响缺陷总数', totalAfterTester === totalBeforeTester, `${totalBeforeTester} → ${totalAfterTester}`);

  // 恢复：点掉测试人员名单里的 chip，再「全部恢复」
  await ev(`(() => { const c=document.querySelector('.zt-sum-person.is-test'); if(c){c.click();return true} return false; })()`);
  await sleep(500);
  const rosterGone = await ev(`(() => document.querySelectorAll('.zt-sum-person.is-test').length)()`);
  check('点测试人员 chip 能取消标记', Number(rosterGone) === 0, `${rosterGone} 个标记`);
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='全部恢复'); if(b){b.click();return true} return false; })()`);
  await sleep(800);
  const rowsRestored = await ev(`(() => document.querySelectorAll('.zt-sum-prow').length)()`);
  check('恢复后人员表回到原样', rowsRestored === rowsBeforeTester, `${rowsAfterTester} → ${rowsRestored}`);

  // 复制前把窗口带到前台：无焦点的文档读不了也写不了剪贴板
  await send('Page.bringToFront').catch(() => {});
  await sleep(600);
  await clickHas('一键复制');
  // 写剪贴板是异步的，提示可能在 1 秒后才出现
  await waitFor(`(() => !!document.querySelector('.zt-sum-tip'))()`, 5000, 200);
  const tip = await ev(`(() => { const t = document.querySelector('.zt-sum-tip'); return t ? t.textContent : ''; })()`);
  await send('Page.bringToFront').catch(() => {});
  const clip = await ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; } })()`);
  check('一键复制有提示', /已复制/.test(String(tip)), tip);
  if (/^ERR:/.test(String(clip))) {
    // 无窗口聚焦时读不到剪贴板，只有 writeText 成功才会出提示，按提示判定即可
    check('剪贴板为汇总文本（读取受限，按写入成功判定）', /已复制/.test(String(tip)), String(clip).slice(0, 40));
  } else {
    check('剪贴板为本次汇总（含合计与模块）',
      /【缺陷汇总】/.test(String(clip)) && new RegExp(`合计 缺陷 ${uiTotal}`).test(String(clip)) && /模块/.test(String(clip)),
      String(clip).slice(0, 70).replace(/\n/g, ' | '));
    check('剪贴板末尾带「人员指派共 N 个」',
      /人员指派共 \d+ 个：/.test(String(clip)),
      (String(clip).match(/人员指派共.*/) || [''])[0].slice(0, 60));
  }

  // ---- 复制为 Markdown ----
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('title') === '选择复制格式 / 导出'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(400);
  const menuOpen = await ev(`(() => !!document.querySelector('.zt-sum-menu'))()`);
  check('复制格式菜单能打开', !!menuOpen);
  await ev(`(() => { const b = [...document.querySelectorAll('.zt-sum-menu-item')].find(x => x.textContent.includes('Markdown')); if (b) { b.click(); return true; } return false; })()`);
  await waitFor(`(() => { const t = document.querySelector('.zt-sum-tip'); return !!t && /Markdown/.test(t.textContent); })()`, 5000, 200);
  const mdTip = await ev(`(() => { const t = document.querySelector('.zt-sum-tip'); return t ? t.textContent : ''; })()`);
  await send('Page.bringToFront').catch(() => {});
  const mdClip = await ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; } })()`);
  if (!/^ERR:/.test(String(mdClip))) {
    check('Markdown 格式带表格', /\| 项目 \| 缺陷 \|/.test(String(mdClip)), String(mdClip).slice(0, 60).replace(/\n/g, ' '));
  } else {
    check('Markdown 格式有提示（剪贴板读取受限）', /Markdown/.test(String(mdTip)), String(mdTip));
  }

  await ev(`(() => { const b = document.querySelector('.zt-sum-row .ibtn'); if (b) { b.click(); return true; } return false; })()`);
  await waitFor(`(() => !!document.querySelector('.zt-sum-tip'))()`, 5000, 200);
  const tip2 = await ev(`(() => { const t = document.querySelector('.zt-sum-tip'); return t ? t.textContent : ''; })()`);
  check('单个项目也能复制', /已复制/.test(String(tip2)), tip2);

  // 多项目：换两个项目一起汇总
  await clickHas('选择项目');
  await sleep(800);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '清空'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(400);
  const picked2 = await ev(`(() => {
    const items = [...document.querySelectorAll('.zt-proj-item')];
    const pick = (pid) => { const it = items.find(x => x.textContent.includes('#' + pid)); if (it) { it.querySelector('input').click(); return true; } return false; };
    return [pick('${PID}'), pick('4')].filter(Boolean).length;
  })()`);
  check('弹窗支持勾多个项目', picked2 === 2, `${picked2}/2`);
  await clickHas('确定（');
  await sleep(800);
  const chips = await ev(`(() => document.querySelectorAll('.zt-sum-chip').length)()`);
  check('选中项目以多个标签展示', chips === 2, `${chips} 个`);

  await clickHas('拉取并汇总');
  const rows2 = await waitFor(`(() => document.querySelectorAll('.zt-sum-tbl tbody tr.zt-sum-row').length === 2)()`, 120000, 900);
  check('两个项目各一行', rows2);
  const twoRows = await ev(`(() => [...document.querySelectorAll('.zt-sum-tbl tbody tr.zt-sum-row')].map(tr => [...tr.children].map(td => td.textContent.trim())))()`);
  const rowTotalSum = (twoRows || []).reduce((s, r) => s + Number(r[1] || 0), 0);
  const grandTotal = await ev(`(() => Number(document.querySelectorAll('.zt-sum-card-num')[0].textContent))()`);
  check('项目行之和 = 总计', rowTotalSum === grandTotal, `${rowTotalSum} / ${grandTotal}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e); process.exit(1); });
