'use strict';

/**
 * ui-digest-test.js —— 锁住「跨公司禅道 → 汇总页复制周报草稿」。
 *
 * 1.36.0（B2）改造：周报页与「从禅道生成」弹窗已下线（方案 §11.2 / 裁定 Z3），
 * 所以本脚本原来那 5 大段「弹窗选项 / 生成 / 合并 / 存盘 / 编辑器几何 / 阅读态」断言随页面一起删除，
 * 改成两条主线：
 *
 *   ① **数据层**：两家公司的禅道各自用自己的凭据（Token + Cookie 桶）拉数据，互不串号。
 *      桩会校验自己的会话：api.php 要本次实例的 Token，tree-ajax（模块名）要本次实例的 Cookie，
 *      串号就回 401 —— 这是原脚本最有价值的一半，原样保留。
 *   ② **界面层**：缺陷管理 → 汇总 → 选项目 → 点「复制周报草稿」→ 读剪贴板。
 *      新按钮不再跳页、不写 localStorage，只把 `buildWeeklyDraft` 的产物复制走。
 *
 *   node scripts/ui-digest-test.js
 *
 * 需要先 `npm run build:renderer`（脚本用 PM_USE_DIST=1 跑构建产物）。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9756;
const PW = 'Digest#2026';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/* ---------------- 两个禅道桩 ---------------- */

/** 今天 0 点起的第 n 小时，给「本周」口径造可复算的数据（日期动态，跑哪天都成立） */
const todayAt = (h) => {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

const STUBS = {
  A: {
    token: 'tok-A', sid: 'A',
    programs: [{ id: 10, name: '广科' }, { id: 20, name: '博思云方舟' }],
    // 项目特意多放几个（够触发搜索框），名字有长有短
    products: [
      { id: 1, name: '资产管理系统', program: 10 }, { id: 2, name: '学工平台', program: 10 },
      { id: 4, name: '高校教务平台', program: 20 }, { id: 5, name: '方舟校园版', program: 20 },
      { id: 6, name: '资产管理系统-管理后台V2.0.0', program: 10 }, { id: 7, name: '备查申报PC端V4.0.0', program: 10 },
      { id: 8, name: '采购管理系统', program: 10 },
    ],
    modules: {
      1: [{ value: 11, text: '/添置资产' }, { value: 12, text: '/资产台账' }],
      2: [{ value: 21, text: '/成绩管理' }],
    },
    // 101 / 104 的日期刻意落在「今天」：周报草稿的本周口径要能复算出非 0 数字，
    // 且不依赖跑脚本是哪一天（见下面的「新提 2 条、解决 1 条、关闭 1 条」断言）。
    bugs: [
      { id: 101, status: 'closed', resolution: 'fixed', product: 1, module: 11, title: 'A-添置1', severity: '3', pri: '3', openedDate: todayAt(1), resolvedDate: todayAt(2), closedDate: todayAt(3), openedBy: { account: 'zhang', realname: '张三' } },
      { id: 102, status: 'closed', resolution: 'fixed', product: 1, module: 11, title: 'A-添置2', severity: '3', pri: '3', openedDate: '2026-09-01T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 103, status: 'closed', resolution: 'fixed', product: 1, module: 12, title: 'A-台账1', severity: '4', pri: '4', openedDate: '2026-09-02T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 104, status: 'active', resolution: '', product: 1, module: 12, title: 'A-台账待修', severity: '2', pri: '2', openedDate: todayAt(4), openedBy: { account: 'li', realname: '李四' } },
      { id: 105, status: 'resolved', resolution: 'fixed', product: 1, module: 11, title: 'A-待验证', severity: '3', pri: '3', openedDate: '2026-09-03T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 106, status: 'closed', resolution: 'fixed', product: 2, module: 21, title: 'A-成绩1', severity: '3', pri: '3', openedDate: '2026-09-04T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 107, status: 'closed', resolution: 'fixed', product: 2, module: 21, title: 'A-成绩2', severity: '3', pri: '3', openedDate: '2026-09-05T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
    ],
  },
  B: {
    token: 'tok-B', sid: 'B',
    // 故意和 A 用同一个产品 id 和同名产品：跨实例必须靠复合键区分
    programs: [{ id: 30, name: '南博' }],
    products: [{ id: 1, name: '资产管理系统', program: 30 }, { id: 3, name: '指标平台', program: 30 }],
    modules: {
      1: [{ value: 11, text: '/组织权限' }],
      3: [{ value: 31, text: '/指标管理' }],
    },
    bugs: [
      { id: 201, status: 'closed', resolution: 'fixed', product: 1, module: 11, title: 'B-权限1', severity: '3', pri: '3', openedDate: '2026-09-10T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 202, status: 'closed', resolution: 'fixed', product: 1, module: 11, title: 'B-权限2', severity: '3', pri: '3', openedDate: '2026-09-11T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 203, status: 'active', resolution: '', product: 1, module: 11, title: 'B-权限待修', severity: '2', pri: '2', openedDate: '2026-11-03T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 204, status: 'active', resolution: '', product: 3, module: 31, title: 'B-指标待修', severity: '2', pri: '2', openedDate: '2026-09-12T01:00:00Z', openedBy: { account: 'wang', realname: '王五' } },
    ],
  },
};

function startStub(port, data) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = (req.method || 'GET').toUpperCase();
    log.push({ method, url });
    const cookie = String(req.headers.cookie || '');
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    // 登录三步
    if (/\/user-refreshRandom\.html$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('123456');
    }
    if (/\/user-login\.html$/.test(url) && method === 'POST') {
      return send(200, { result: 'success', locate: '/zentao/' }, { 'Set-Cookie': `zentaosid=${data.sid}; Path=/` });
    }
    if (/\/user-login\.html$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body><form><input name="referer" value="/" /></form></body></html>');
    }

    // 模块名走 HTML 会话：会话不对直接 401，模拟「串到别的公司」
    if (/tree-ajaxGetOptionMenu-(\d+)-bug\.html/.test(url)) {
      if (!cookie.includes(`zentaosid=${data.sid}`)) {
        return send(401, { error: `会话属于别家（期望 ${data.sid}，实际 ${cookie || '无'}）` });
      }
      const pid = url.match(/tree-ajaxGetOptionMenu-(\d+)-bug\.html/)[1];
      return send(200, { items: data.modules[pid] || [] });
    }

    // API 走 Token
    if (/\/api\.php\/v1\/tokens$/.test(url) && method === 'POST') return send(201, { token: data.token });
    if (/\/api\.php\/v1\/products/.test(url)) {
      if (req.headers.token !== data.token) return send(401, { error: `token 不对（期望 ${data.token}）` });
      return send(200, { total: data.products.length, products: data.products });
    }
    // 项目集：产品列表要靠它显示「项目集 / 项目名」
    if (/\/api\.php\/v1\/programs/.test(url)) {
      if (req.headers.token !== data.token) return send(401, { error: `token 不对（期望 ${data.token}）` });
      const list = data.programs || [];
      return send(200, { total: list.length, programs: list });
    }
    if (/\/api\.php\/v1\/bugs/.test(url)) {
      if (req.headers.token !== data.token) return send(401, { error: `token 不对（期望 ${data.token}）` });
      const q = new URL(url, 'http://x').searchParams;
      const pid = q.get('product');
      if (!pid) return send(400, { result: 'fail', message: 'Need product id.' });
      const rows = data.bugs.filter(b => String(b.product) === String(pid));
      return send(200, { total: rows.length, limit: 1000, page: 1, bugs: rows });
    }
    return send(404, 'not found');
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, log })));
}

/* ---------------- CDP ---------------- */

async function attach(target) {
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  EX ' + String(r.exceptionDetails.exception?.description || '').slice(0, 200));
    return r.result?.value;
  };
  /** 存一张 PNG，用来人工复核排版 */
  const shot = async (file) => {
    try {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      if (r && r.data) fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    } catch { /* 截图失败不影响断言 */ }
  };
  return { ev, shot, send, close: () => { try { ws.close(); } catch { /* 忽略 */ } } };
}

const listTargets = async () => {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch { return []; }
};

const findTarget = async (pred, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const list = await listTargets();
    const t = list.find(x => x.type === 'page' && !String(x.url || '').startsWith('devtools://') && pred(x));
    if (t) return t;
    await sleep(300);
  }
  return null;
};

/* ---------------- 主流程 ---------------- */

(async () => {
  const stubA = await startStub(9851, STUBS.A);
  const stubB = await startStub(9852, STUBS.B);

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-digest-'));
  const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-digest-shot-'));
  const env = { ...process.env, PM_USE_DIST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = spawn(EXE, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`],
    { env, cwd: ROOT, windowsHide: true });
  app.stderr.on('data', () => { /* 忽略 GPU 噪声 */ });

  const cleanup = () => { try { app.kill(); } catch { /* 忽略 */ } stubA.srv.close(); stubB.srv.close(); };

  const mainTarget = await findTarget(() => true);
  if (!mainTarget) { console.log('✗ 应用未启动'); cleanup(); process.exit(1); }
  const main = await attach(mainTarget);
  await sleep(1800);

  // 首次启动：设主密码
  await main.ev(`(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const ins = [...document.querySelectorAll('input')];
    set.call(ins[0], ${JSON.stringify(PW)});
    ins[0].dispatchEvent(new Event('input', { bubbles: true }));
    if (ins[1]) { set.call(ins[1], ${JSON.stringify(PW)}); ins[1].dispatchEvent(new Event('input', { bubbles: true })); }
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('设置主密码'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2600);

  const unlocked = await main.ev(`(async () => (await window.electronAPI.sessionIsUnlocked()).unlocked)()`);
  check('准备：密码库已解锁', unlocked === true);

  // 写入两家公司配置
  const okCfg = await main.ev(`(async () => {
    const list = [
      { id: 'instA', company: '甲公司', baseUrl: 'http://127.0.0.1:9851/zentao', account: 'ua', password: 'pa' },
      { id: 'instB', company: '乙公司', baseUrl: 'http://127.0.0.1:9852/zentao', account: 'ub', password: 'pb' },
    ];
    const r = await window.electronAPI.wsSet('integrations', list);
    return !!r && r.success;
  })()`);
  check('准备：写入两家公司的禅道配置', okCfg === true);

  /* ================= 1. 数据层：跨实例汇总（原样保留） ================= */
  const multi = await main.ev(`(async () => {
    const r = await window.electronAPI.zentaoSummaryMulti([
      { id: 'instA', name: '甲公司', cfg: { id: 'instA', baseUrl: 'http://127.0.0.1:9851/zentao', account: 'ua', password: 'pa' }, productIds: ['1', '2'] },
      { id: 'instB', name: '乙公司', cfg: { id: 'instB', baseUrl: 'http://127.0.0.1:9852/zentao', account: 'ub', password: 'pb' }, productIds: ['1', '3'] },
    ]);
    if (!r || !r.success) return { ok: false, error: r && r.error };
    return {
      ok: true,
      total: r.total,
      groups: r.groups.map(g => ({ id: g.instanceId, name: g.name, ok: g.ok, n: g.bugs.length, err: g.error })),
      sample: r.groups[0] && r.groups[0].bugs[0] ? {
        instanceId: r.groups[0].bugs[0].instanceId,
        instanceName: r.groups[0].bugs[0].instanceName,
        key: r.groups[0].bugs[0].key,
        moduleName: r.groups[0].bugs[0].moduleName,
      } : null,
      aKeys: r.groups[0] ? r.groups[0].bugs.map(b => String(b.key)) : [],
      aModules: r.groups[0] ? r.groups[0].bugs.map(b => String(b.moduleName || '')) : [],
      bKeys: r.groups[1] ? r.groups[1].bugs.map(b => b.key) : [],
    };
  })()`);

  check('跨实例汇总：调用成功', multi && multi.ok === true, multi && multi.error);
  if (multi && multi.ok) {
    check('两家公司都拉到数据（会话没有串号）',
      multi.groups.length === 2 && multi.groups.every(g => g.ok),
      JSON.stringify(multi.groups));
    check('甲公司 7 条、乙公司 4 条，互不污染',
      multi.groups[0] && multi.groups[0].n === 7 && multi.groups[1] && multi.groups[1].n === 4,
      `${multi.groups[0] && multi.groups[0].n} / ${multi.groups[1] && multi.groups[1].n}`);
    check('每条 Bug 带来源实例标记',
      multi.sample && multi.sample.instanceId === 'instA' && multi.sample.instanceName === '甲公司',
      JSON.stringify(multi.sample));
    check('复合键是「实例id::产品id」',
      (multi.aKeys || []).length === 7 && (multi.aKeys || []).every(k => /^instA::\d+$/.test(k)),
      (multi.aKeys || []).join(','));
    check('模块名全部解析成功（说明 HTML 会话带着正确的 cookie）',
      (multi.aModules || []).length === 7 && (multi.aModules || []).every(n => n && !/没有|未指定/.test(n)),
      (multi.aModules || []).join(','));
    check('乙公司的产品 1 用的是乙公司自己的键（不同实例同 id 不冲突）',
      (multi.bKeys || []).every(k => String(k).startsWith('instB::')),
      (multi.bKeys || []).slice(0, 3).join(','));
  }

  /* ================= 2. 界面：缺陷管理 → 汇总 → 选项目 ================= */
  const waitFor = async (expr, ms = 15000, step = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await main.ev(expr)) return true;
      await sleep(step);
    }
    return false;
  };
  const clickHas = async (text, rootSel = '') => main.ev(`(() => {
    const scope = ${rootSel ? `document.querySelector(${JSON.stringify(rootSel)}) || document` : 'document'};
    const b = [...scope.querySelectorAll('button')].find(x => (x.textContent || '').includes(${JSON.stringify(text)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const SETVAL = `(() => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); return d && d.set; })()`;

  await main.send('Page.bringToFront');
  await main.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const navOk = await main.ev(`(() => {
    const item = [...document.querySelectorAll('.nav-item')].find(x => (x.textContent || '').includes('缺陷管理'));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  check('准备：进入缺陷管理页', navOk === true);
  await sleep(1200);

  // 填甲公司的禅道配置并登录（汇总页取的是「当前实例」，甲公司桩有 7 个项目）
  await main.ev(`(() => {
    const s = ${SETVAL};
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true; } return false; };
    set('input[placeholder^="http://"]', 'http://127.0.0.1:9851/zentao');
    set('input[placeholder="用户名"]', 'ua');
    set('input[placeholder="密码"]', 'pa');
    return 1;
  })()`);
  await sleep(300);
  await clickHas('登录并保存');
  await sleep(6000);
  await clickHas('刷新项目列表');
  await sleep(3000);

  // 进「汇总」标签页
  const sumTab = await main.ev(`(() => {
    const b = [...document.querySelectorAll('.tabs .tab2')].find(x => (x.textContent || '').trim() === '汇总');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('缺陷管理有「汇总」页签且能点开', sumTab === true);
  await sleep(1200);

  // 选项目（多选弹窗）。页面上可能同时挂着别的 `.modal`，一律按「标题含选择要汇总的项目」定位
  const PICK_SCOPE = `(() => [...document.querySelectorAll('.modal')].find(m => /选择要汇总的项目/.test(m.textContent || '')) || null)()`;
  const openedPicker = await clickHas('选择项目', 'document');
  const pickerShown = await waitFor(`(() => !!${PICK_SCOPE})()`, 12000, 300);
  check('点「选择项目」能打开多选弹窗', openedPicker === true && pickerShown === true,
    JSON.stringify({ openedPicker, pickerShown }));

  const pickRows = await main.ev(`(() => { const m = ${PICK_SCOPE}; return m ? m.querySelectorAll('.zt-proj-item').length : -1; })()`);
  check('弹窗列出甲公司的项目（≥7 个）', Number(pickRows) >= 7, String(pickRows));

  await main.ev(`(() => {
    const m = ${PICK_SCOPE};
    if (!m) return false;
    const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes('全选（'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(400);
  const allPicked = await main.ev(`(() => {
    const m = ${PICK_SCOPE};
    return m ? [...m.querySelectorAll('.zt-proj-item input[type=checkbox]')].filter(i => i.checked).length : -1;
  })()`);
  check('「全选」把项目都勾上（与弹窗里的行数一致）',
    Number(allPicked) === Number(pickRows) && Number(pickRows) > 0, `${allPicked} / ${pickRows}`);

  await main.ev(`(() => {
    const m = ${PICK_SCOPE};
    if (!m) return false;
    const b = [...m.querySelectorAll('button')].find(x => (x.textContent || '').includes('确定（'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);
  const chips = await main.ev(`document.querySelectorAll('.zt-sum-chip').length`);
  check('确定后汇总工具条出现项目 chip', Number(chips) >= 7, String(chips));

  // 首次进页签时没有项目 → 自动拉取在挂载时就跳过了；选完项目后切走再回来触发一次
  await main.ev(`(() => { const b = [...document.querySelectorAll('.tabs .tab2')].find(x => (x.textContent || '').trim() === '我的 Bug'); if (b) b.click(); return !!b; })()`);
  await sleep(900);
  await main.ev(`(() => { const b = [...document.querySelectorAll('.tabs .tab2')].find(x => (x.textContent || '').trim() === '汇总'); if (b) b.click(); return !!b; })()`);
  const hasData = await waitFor(`(() => !!document.querySelector('.zt-sum-copybar'))()`, 40000, 500);
  check('汇总页拉到数据（出现概览工具条，可按「累计缺陷」文案判断）',
    hasData === true, hasData ? '' : '40s 内没出现概览');
  await main.shot(path.join(shotDir, 'summary.png'));

  /* ================= 3. 复制周报草稿 ================= */
  const locBefore = await main.ev(`location.href`);
  const titleBefore = await main.ev(`(document.querySelector('.pg-title')?.textContent || '').trim()`);
  await main.ev(`localStorage.removeItem('pm.weekly.pendingDraft')`);

  const hasBtn = await main.ev(`(() => {
    const b = [...document.querySelectorAll('.zt-sum-copybar button')].find(x => (x.textContent || '').includes('复制周报草稿'));
    return !!b;
  })()`);
  check('概览工具条有「复制周报草稿」按钮', hasBtn === true);

  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.zt-sum-copybar button')].find(x => (x.textContent || '').includes('复制周报草稿'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);

  const clip = String(await main.ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; } })()`) || '');
  check('剪贴板拿到内容（不是空串、不是 ERR）', clip.length > 20 && !clip.startsWith('ERR:'), clip.slice(0, 60).replace(/\n/g, '⏎'));

  // 本周区间由 buildWeeklyDraft 自己算（weekRange(0)），测试侧用同样的口径复算
  const range = await main.ev(`(() => {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const mon = new Date(now); mon.setDate(now.getDate() - dow); mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: fmt(mon), end: fmt(sun) };
  })()`);

  check('草稿含「**一、本周工作**」章节', clip.includes('**一、本周工作**'));
  check('草稿含「**二、问题与风险**」章节', clip.includes('**二、问题与风险**'));
  check('草稿含「**三、下周计划**」骨架', clip.includes('**三、下周计划**'));
  check('草稿的统计区间是本周（与 weekRange(0) 同口径）',
    clip.includes(`禅道缺陷（${range.start} ~ ${range.end}）`),
    `${range.start} ~ ${range.end}`);
  check('本周口径可复算：新提 2 条、解决 1 条、关闭 1 条（101 与 104 落在今天）',
    clip.includes('新提 2 条、解决 1 条、关闭 1 条'),
    (clip.match(/禅道缺陷（[^\n]*/) || [''])[0]);
  /**
   * 项目名**只有一个口径**：「项目集 / 项目名」（与汇总表格、项目选择器完全一致）。
   *
   * 口径曾经分叉过：主进程 `ipc-zentao.js:1373/:1423` 回的是**纯产品名**，表格用的是
   * `ZentaoSummary.tsx:145` 的「项目集 / 项目名」。t9 解包修复让 `productName` 从空变真值，
   * 于是渲染层「有值就不补」的兜底被跳过、草稿退化成纯产品名。
   * t27 已把渲染层的顺序反过来（`productNames[...] || b.productName || ''`，`copyWeeklyDraft`），
   * 所以这里**恢复单一断言**：只要出现纯产品名就说明口径又分叉了，应当红。
   */
  const projLine = (clip.match(/（1）[^\n]*/) || [''])[0];
  check('按项目分组那行带项目名（「项目集 / 项目名」与表格同一口径）且是 2/1/1',
    projLine.includes('（1）广科 / 资产管理系统：新提 2、解决 1、关闭 1'),
    projLine);
  check('风险段给出未关闭口径（2 条，致命 0 / 严重 1）',
    clip.includes('当前未关闭缺陷 2 条，其中致命 0 条、严重 1 条'),
    (clip.match(/当前未关闭缺陷[^\n]*/) || [''])[0]);

  // 不跳页 / 不写 localStorage（1.36.0 的改造口径）
  const locAfter = await main.ev(`location.href`);
  const titleAfter = await main.ev(`(document.querySelector('.pg-title')?.textContent || '').trim()`);
  check('点完不跳页（location 与页面标题都没变）',
    locAfter === locBefore && titleAfter === titleBefore && /缺陷管理/.test(String(titleAfter)),
    `${titleBefore} → ${titleAfter}`);
  const pending = await main.ev(`localStorage.getItem('pm.weekly.pendingDraft')`);
  check('不再写死数据 pm.weekly.pendingDraft（读者已随周报页删除）', pending === null, String(pending));
  const tipText = await main.ev(`(document.querySelector('.zt-sum-tip')?.textContent || '').trim()`);
  check('页面上给了「已复制周报草稿（…）」反馈', /已复制周报草稿/.test(String(tipText)), String(tipText).slice(0, 60));

  // 幂等：再点一次内容一致
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.zt-sum-copybar button')].find(x => (x.textContent || '').includes('复制周报草稿'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(800);
  const clip2 = String(await main.ev(`(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR:' + e.message; } })()`) || '');
  check('连点两次内容一致（幂等，不带累加状态）', clip2 === clip && clip2.length > 20, `${clip.length} / ${clip2.length} 字`);

  await main.shot(path.join(shotDir, 'copied.png'));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  console.log('桩服务请求量：A ' + stubA.log.length + ' 次，B ' + stubB.log.length + ' 次');
  console.log('截图目录：' + shotDir);
  cleanup();
  process.exit(fail ? 1 : 0);
})();
