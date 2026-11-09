'use strict';

/**
 * ui-digest-test.js —— 锁住「跨公司禅道 → 周报自动成稿」。
 *
 * 这里用两个本地桩模拟两家公司的禅道，而且桩会**校验自己的会话**：
 *   - api.php 请求必须带本次实例的 Token（tok-A / tok-B）
 *   - tree-ajax（模块名，走 HTML 会话）必须带本次实例的 Cookie（zentaosid=A/B）
 * 一旦 cookie 桶没按实例隔离，请求就会带着另一家的凭据，桩直接回 401，
 * 表现为「某个公司拉不到数据」——这正是这个用例要防的回归。
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

const STUBS = {
  A: {
    token: 'tok-A', sid: 'A',
    programs: [{ id: 10, name: '广科' }, { id: 20, name: '博思云方舟' }],
    // 项目特意多放几个（够触发搜索框），名字有长有短，用来验「完整显示不打省略号」
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
    bugs: [
      { id: 101, status: 'closed', resolution: 'fixed', product: 1, module: 11, title: 'A-添置1', severity: '3', pri: '3', openedDate: '2026-11-03T01:00:00Z', resolvedDate: '2026-11-04T02:00:00Z', closedDate: '2026-11-05T03:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 102, status: 'closed', resolution: 'fixed', product: 1, module: 11, title: 'A-添置2', severity: '3', pri: '3', openedDate: '2026-09-01T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 103, status: 'closed', resolution: 'fixed', product: 1, module: 12, title: 'A-台账1', severity: '4', pri: '4', openedDate: '2026-09-02T01:00:00Z', openedBy: { account: 'zhang', realname: '张三' } },
      { id: 104, status: 'active', resolution: '', product: 1, module: 12, title: 'A-台账待修', severity: '2', pri: '2', openedDate: '2026-11-04T01:00:00Z', openedBy: { account: 'li', realname: '李四' } },
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
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const cookie = String(req.headers.cookie || '');

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
  return { ev, shot, close: () => { try { ws.close(); } catch { /* 忽略 */ } } };
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

  // ---- 1. 数据层：跨实例汇总 ----
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
      // 所有条目都要带正确的实例前缀 + 解析出模块名（主进程按 id 降序返回，
      // 取 bugs[0] 只是碰运气，逐条检查才可靠）
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

  // ---- 2. 界面：打开弹窗 ----
  /** 等某个表达式为真：页面切换、数据加载都有异步，固定 sleep 会偶发失败 */
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await main.ev(expr)) return true;
      await sleep(300);
    }
    return false;
  };

  // 周报目录用临时目录：「生成并保存」要往里写真实文件，绝不能碰使用者的周报
  const wkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-weekly-'));
  await main.ev(`localStorage.setItem('weekly.report.dir', ${JSON.stringify(wkDir)})`);

  const navOk = await main.ev(`(() => {
    const item = [...document.querySelectorAll('.nav-item')].find(x => (x.textContent || '').includes('周报'));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  check('准备：进入周报页', navOk === true);

  const hasBtn = await waitFor(`!![...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('从禅道生成'))`);
  check('周报页有「从禅道生成」按钮', hasBtn === true);

  const opened = hasBtn && await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('从禅道生成'));
    b.click();
    return true;
  })()`);
  check('按钮可点开', opened === true);

  await waitFor(`!!document.querySelector('.digest-inst')`, 10000);
  await sleep(600);

  const dlg = await main.ev(`(() => ({
    open: !!document.querySelector('.digest-modal'),
    insts: [...document.querySelectorAll('.digest-inst')].map(x => x.querySelector('.digest-inst-name')?.textContent || ''),
    products: document.querySelectorAll('.digest-prod').length,
    hasDate: !!document.querySelector('.digest-date'),
  }))()`);
  check('弹窗出现', dlg && dlg.open === true);
  check('列出一家公司一个区块', dlg && dlg.insts.length === 2, JSON.stringify(dlg && dlg.insts));
  check('公司名显示正确（甲公司 / 乙公司）',
    dlg && dlg.insts.includes('甲公司') && dlg.insts.includes('乙公司'), JSON.stringify(dlg && dlg.insts));
  check('项目列表已加载（A 7 个 + B 2 个 = 9 个复选框）', dlg && dlg.products === 9, dlg && String(dlg.products));
  check('有统计范围日期输入', dlg && dlg.hasDate === true);

  const initPicked = await main.ev(`[...document.querySelectorAll('.digest-inst')].map(x => {
    const boxes = [...x.querySelectorAll('.digest-prod input')];
    return { name: x.querySelector('.digest-inst-name')?.textContent || '', total: boxes.length, checked: boxes.filter(i => i.checked).length };
  })`);
  check('打开时项目默认一个都不勾（不会把 30 多个项目全算进去）',
    initPicked.length === 2 && initPicked.every(x => x.checked === 0) && initPicked.some(x => x.total > 0),
    JSON.stringify(initPicked));

  // 只点「全选」，别碰「全不选」（两者文案都含「全选」两个字，用全等判断）
  await main.ev(`(() => {
    [...document.querySelectorAll('.digest-inst')].forEach(x => {
      const b = x.querySelector('.digest-all');
      if (b && (b.textContent || '').trim() === '全选') b.click();
    });
    return true;
  })()`);
  await sleep(450);
  const afterFill = await main.ev(`[...document.querySelectorAll('.digest-inst')].map(x => {
    const boxes = [...x.querySelectorAll('.digest-prod input')];
    return boxes.filter(i => i.checked).length + '/' + boxes.length;
  })`);
  check('点「全选」能把两家公司的项目都勾上',
    afterFill.every(t => t.split('/')[0] === t.split('/')[1]), JSON.stringify(afterFill));

  /* ---- 2b. 公司由项目决定：勾了项目公司才勾上；点公司行只折叠 ---- */
  const instExpr = `[...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司')`;

  // 先清空甲公司（复选框此时是全选状态，点一下变清空）
  await main.ev(`(() => {
    const inst = ${instExpr};
    const cb = inst && inst.querySelector('.digest-inst-head input[type=checkbox]');
    if (cb) cb.click();
    return !!cb;
  })()`);
  await sleep(300);
  const cleared = await main.ev(`(() => {
    const inst = ${instExpr};
    if (!inst) return null;
    const boxes = [...inst.querySelectorAll('.digest-prod input')];
    return {
      on: inst.classList.contains('is-on'),
      box: !!inst.querySelector('.digest-inst-head input[type=checkbox]')?.checked,
      checked: boxes.filter(i => i.checked).length,
    };
  })()`);
  check('清空项目后公司自动取消勾选（不留「选中但空着」的中间态）',
    cleared && cleared.checked === 0 && cleared.on === false && cleared.box === false,
    JSON.stringify(cleared));

  // 勾一个项目：公司应当自动勾上
  await main.ev(`(() => {
    const inst = ${instExpr};
    const boxes = inst ? [...inst.querySelectorAll('.digest-prod input')] : [];
    if (boxes[0]) boxes[0].click();
    return boxes.length;
  })()`);
  await sleep(300);
  const oneOn = await main.ev(`(() => {
    const inst = ${instExpr};
    if (!inst) return null;
    return {
      on: inst.classList.contains('is-on'),
      box: !!inst.querySelector('.digest-inst-head input[type=checkbox]')?.checked,
      checked: [...inst.querySelectorAll('.digest-prod input')].filter(i => i.checked).length,
    };
  })()`);
  check('勾中一个项目后公司自动勾选',
    oneOn && oneOn.checked === 1 && oneOn.on === true && oneOn.box === true, JSON.stringify(oneOn));

  // 点公司复选框 = 全选这家
  await main.ev(`(() => {
    const inst = ${instExpr};
    const cb = inst && inst.querySelector('.digest-inst-head input[type=checkbox]');
    if (cb) cb.click();
    return !!cb;
  })()`);
  await sleep(300);
  const filled = await main.ev(`(() => {
    const inst = ${instExpr};
    const boxes = inst ? [...inst.querySelectorAll('.digest-prod input')] : [];
    return { total: boxes.length, checked: boxes.filter(i => i.checked).length };
  })()`);
  check('点公司复选框可一键全选这家', filled.total === 7 && filled.checked === 7, JSON.stringify(filled));

  // 点公司行只折叠
  await main.ev(`(() => {
    const inst = ${instExpr};
    if (inst) inst.querySelector('.digest-inst-head').click();
    return !!inst;
  })()`);
  await sleep(250);
  const folded = await main.ev(`(() => {
    const inst = ${instExpr};
    return inst ? { on: inst.classList.contains('is-on'), visible: inst.querySelectorAll('.digest-prod').length } : null;
  })()`);
  check('点公司行只是收起列表，不动勾选',
    folded && folded.on === true && folded.visible === 0, JSON.stringify(folded));

  await main.ev(`(() => {
    const inst = ${instExpr};
    if (inst) inst.querySelector('.digest-inst-head').click();
    return !!inst;
  })()`);
  await sleep(250);
  const unfolded = await main.ev(`(() => {
    const inst = ${instExpr};
    const boxes = inst ? [...inst.querySelectorAll('.digest-prod input')] : [];
    return { total: boxes.length, checked: boxes.filter(i => i.checked).length };
  })()`);
  check('展开后项目还是全选状态', unfolded.total === 7 && unfolded.checked === 7, JSON.stringify(unfolded));

  // 只取消两个：公司仍然是勾上的
  await main.ev(`(() => {
    const inst = ${instExpr};
    const boxes = inst ? [...inst.querySelectorAll('.digest-prod input')] : [];
    if (boxes[0]) boxes[0].click();
    if (boxes[1]) boxes[1].click();
    return true;
  })()`);
  await sleep(300);
  const partial = await main.ev(`(() => {
    const inst = ${instExpr};
    if (!inst) return null;
    const boxes = [...inst.querySelectorAll('.digest-prod input')];
    return {
      on: inst.classList.contains('is-on'),
      checked: boxes.filter(i => i.checked).length,
    };
  })()`);
  check('只勾一部分时公司仍算在内', partial && partial.checked === 5 && partial.on === true, JSON.stringify(partial));

  // 恢复全选，后面生成要用完整数据
  await main.ev(`(() => {
    const inst = ${instExpr};
    const b = inst && inst.querySelector('.digest-all');
    if (b && (b.textContent || '').trim() === '全选') b.click();
    return !!b;
  })()`);
  await sleep(300);

  /* ---- 2c. 项目搜索 + 完整显示 ---- */
  const labels = await main.ev(`[...document.querySelectorAll('.digest-prod span')].map(s => s.textContent || '')`);
  check('项目显示成「项目集 / 项目名」',
    labels.some(l => l.includes('广科 / 资产管理系统'))
    && labels.some(l => l.includes('博思云方舟 / 方舟校园版')),
    JSON.stringify(labels.slice(0, 3)));

  const typed = await main.ev(`(() => {
    const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
    const input = inst && inst.querySelector('.digest-search');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '校园');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(350);
  const filtered = await main.ev(`(() => {
    const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
    return inst ? [...inst.querySelectorAll('.digest-prod span')].map(s => s.textContent) : [];
  })()`);
  check('项目搜索能按关键字过滤（「校园」只剩方舟校园版）',
    typed === 'ok' && filtered.length === 1 && /方舟校园版/.test(filtered[0]), JSON.stringify(filtered));

  const clip = await main.ev(`(() => {
    const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
    const span = inst && inst.querySelector('.digest-prod span');
    if (!span) return null;
    const cs = getComputedStyle(span);
    return { textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace };
  })()`);
  check('项目名不打省略号（长名字换行完整显示）',
    clip && clip.textOverflow !== 'ellipsis' && clip.whiteSpace === 'normal', JSON.stringify(clip));

  // 清空搜索，回到完整列表（后面生成要用全选状态）
  await main.ev(`(() => {
    const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
    const input = inst && inst.querySelector('.digest-search');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);

  const shotDir = path.join(ROOT, '.tmp-digest');
  try { fs.mkdirSync(shotDir, { recursive: true }); } catch { /* 忽略 */ }
  await main.shot(path.join(shotDir, 'dialog.png'));

  // ---- 3. 点「生成草稿」 ----
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').includes('生成草稿'));
    if (b) b.click();
    return !!b;
  })()`);
  // 等编辑器里出现正文（两家公司串行拉取，慢的时候要几秒）
  await waitFor(`(() => {
    const ta = document.querySelector('.wk-editor textarea') || [...document.querySelectorAll('textarea')].pop();
    return !!(ta && ta.value && ta.value.length > 50);
  })()`, 30000);

  const body = await main.ev(`(() => {
    const ta = document.querySelector('.wk-editor textarea') || [...document.querySelectorAll('textarea')].pop();
    return ta ? ta.value : '';
  })()`);

  check('生成后进入编辑态（正文非空）', !!body && body.length > 50, body ? `${body.length} 字` : '空');
  check('正文用「一、二、」章节标题', /\*\*一、/.test(String(body)) && /\*\*二、/.test(String(body)),
    (String(body).match(/\*\*[一二三四]、[^*]+\*\*/g) || []).join(' / '));
  check('有累计缺陷那句',
    /累计缺陷 \d+ 个，已关闭 \d+ 个、已修复 \d+ 个、待修复 \d+ 个/.test(String(body)),
    (String(body).match(/累计缺陷[^\n]*/) || [''])[0].slice(0, 80));
  check('有「模块分布如下」和模块行', /模块分布如下/.test(String(body)) && /（1）/.test(String(body)));
  check('同名项目在两家公司下都出现（不会被合并成一条）',
    (String(body).match(/资产管理系统（[^）]+）/g) || []).length >= 2,
    (String(body).match(/资产管理系统（[^）]+）/g) || []).join(' / '));
  check('有结尾总结段', /整体测试与修复工作按计划推进/.test(String(body)));
  check('有「下周工作计划」骨架', /下周工作计划/.test(String(body)));

  // 截图留证
  await main.shot(path.join(shotDir, 'editor.png'));
  console.log('\n================ 生成的正文 ================\n' + String(body) + '\n===========================================\n');

  try {
    const shot = await main.ev(`(async () => {
      const ta = [...document.querySelectorAll('textarea')].pop();
      return ta ? ta.closest('.panel, .wk-editor') !== null : false;
    })()`);
    check('编辑器在页面里可见', shot === true);
  } catch { /* 截图失败不影响结论 */ }

  /* ---- 5. 按创建人统计（按公司分开） ---- */
  // 上一次生成后进入了编辑态，先退出编辑
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '取消');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(500);

  await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('从禅道生成'));
    if (b && !b.disabled) b.click();
    return !!(b && !b.disabled);
  })()`);
  await waitFor(`!!document.querySelector('.digest-inst')`, 10000);
  await sleep(700);

  // 项目默认不勾，先把两家公司的项目都选上
  // 只点「全选」，别碰「全不选」（两者文案都含「全选」两个字，用全等判断）
  await main.ev(`(() => {
    [...document.querySelectorAll('.digest-inst')].forEach(x => {
      const b = x.querySelector('.digest-all');
      if (b && (b.textContent || '').trim() === '全选') b.click();
    });
    return true;
  })()`);
  await sleep(450);

  const readBtn = await main.ev(`(() => {
    const b = [...document.querySelectorAll('.digest-section button')].find(x => (x.textContent || '').includes('读取候选'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('有「读取候选」按钮', readBtn === true);

  await waitFor(`document.querySelectorAll('.digest-people-group').length >= 2`, 30000);
  const groups = await main.ev(`[...document.querySelectorAll('.digest-people-group')].map(g => ({
    corp: g.querySelector('.digest-people-corp')?.textContent || '',
    chips: [...g.querySelectorAll('.digest-chip')].map(c => c.textContent || ''),
  }))`);
  check('创建人按公司分组列出（甲公司 / 乙公司）',
    groups.length === 2
    && groups.some(g => g.corp === '甲公司')
    && groups.some(g => g.corp === '乙公司'),
    JSON.stringify(groups.map(g => g.corp)));

  const gA = groups.find(g => g.corp === '甲公司') || { chips: [] };
  const gB = groups.find(g => g.corp === '乙公司') || { chips: [] };
  check('甲公司的候选是张三（6 条）和李四（1 条）',
    gA.chips.some(c => c.includes('张三') && c.includes('6')) && gA.chips.some(c => c.includes('李四')),
    JSON.stringify(gA.chips));
  check('乙公司的候选是张三（3 条）和王五（1 条）',
    gB.chips.some(c => c.includes('张三') && c.includes('3')) && gB.chips.some(c => c.includes('王五')),
    JSON.stringify(gB.chips));

  const reqAfterRead = stubA.log.length + stubB.log.length;

  await main.ev(`(() => {
    const g = [...document.querySelectorAll('.digest-people-group')].find(x => (x.querySelector('.digest-people-corp')?.textContent || '') === '甲公司');
    const c = g && [...g.querySelectorAll('.digest-chip')].find(x => (x.textContent || '').startsWith('张三'));
    if (c) c.click();
    return !!c;
  })()`);
  await sleep(300);
  const picked = await main.ev(`[...document.querySelectorAll('.digest-chip.is-on')].map(x => x.textContent || '')`);
  check('点甲公司下的张三，只选中这一家的这一个人',
    picked.length === 1 && picked[0].includes('张三'), JSON.stringify(picked));

  // 截图留证：先把创建人区域滚进视口，否则截到的是上半截
  await main.ev(`(() => {
    const el = document.querySelector('.digest-people-group');
    if (el) el.scrollIntoView({ block: 'center' });
    return !!el;
  })()`);
  await sleep(350);
  await main.shot(path.join(shotDir, 'dialog-people.png'));

  const genOk = await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').includes('生成草稿'));
    if (b) b.click();
    return !!b;
  })()`);
  check('带上创建人后仍能生成', genOk === true);

  await waitFor(`(() => {
    const ta = document.querySelector('.wk-editor textarea') || [...document.querySelectorAll('textarea')].pop();
    return !!(ta && ta.value && ta.value.startsWith('统计范围：'));
  })()`, 30000);

  const body2 = await main.ev(`(() => {
    const ta = document.querySelector('.wk-editor textarea') || [...document.querySelectorAll('textarea')].pop();
    return ta ? ta.value : '';
  })()`);
  const b2 = String(body2 || '');
  check('正文写明是哪家公司的谁',
    b2.startsWith('统计范围：创建人 甲公司：张三（'), b2.split('\n')[0]);
  check('乙公司没筛人，项目一个都没少（仍是 4 个章节，指标平台还在）',
    (b2.match(/\*\*[一二三四]、/g) || []).length === 4 && /指标平台/.test(b2),
    (b2.match(/\*\*[一二三四]、[^*]+\*\*/g) || []).join(' / '));
  check('甲公司按张三重算（资产 4 条、学工 2 条）',
    /累计缺陷 4 个/.test(b2) && /累计缺陷 2 个/.test(b2));

  const reqAfterGen = stubA.log.length + stubB.log.length;
  check('读候选拉过的数据被复用（生成不再重复请求）',
    reqAfterGen === reqAfterRead, `读候选后 ${reqAfterRead} 次 → 生成后 ${reqAfterGen} 次`);


  /* ---- 6. 生成一次之后再补充：合并进原草稿 ---- */
  await waitFor(`[...document.querySelectorAll('textarea')].length > 0`, 8000);
  const typedNote = await main.ev(`(() => {
    const list = [...document.querySelectorAll('textarea')];
    const ta = document.querySelector('.wk-editor textarea') || list[list.length - 1];
    if (!ta) return 'no-textarea(n=' + list.length + ')';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ta.value + '\\n【手写补充】这周还做了报表性能测试。\\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  check('准备：在已生成的草稿里手写一段', typedNote === 'ok', String(typedNote));
  await sleep(400);

  const openWhileEditing = await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('从禅道生成'));
    if (!b) return 'no-btn';
    if (b.disabled) return 'disabled';
    b.click();
    return 'ok';
  })()`);
  check('编辑态下也能直接点开「从禅道生成」（不用先取消）', openWhileEditing === 'ok', openWhileEditing);
  await waitFor(`!!document.querySelector('.digest-inst')`, 10000);
  await sleep(700);

  const modes = await main.ev(`[...document.querySelectorAll('.digest-write input[type="radio"]')].map(r => ({ on: r.checked, label: (r.parentElement?.textContent || '').trim() }))`);
  check('草稿非空时默认选「合并到现有草稿」',
    modes.length === 2 && modes[1].on === true && /合并/.test(modes[1].label), JSON.stringify(modes));

  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').includes('生成草稿'));
    if (b) b.click();
    return !!b;
  })()`);
  // 等编辑器换成合并后的内容（手写段落还在就说明写进去了）
  await waitFor(`(() => {
    const ta = document.querySelector('.wk-editor textarea') || [...document.querySelectorAll('textarea')].pop();
    return !!(ta && ta.value && ta.value.includes('【手写补充】'));
  })()`, 30000);
  await sleep(600);

  const merged = await main.ev(`(() => {
    const ta = document.querySelector('.wk-editor textarea') || [...document.querySelectorAll('textarea')].pop();
    return ta ? ta.value : '';
  })()`);
  const mv = String(merged || '');
  check('合并后手写内容还在', mv.includes('【手写补充】这周还做了报表性能测试'));
  check('合并后项目章节没有重复堆叠',
    (mv.match(/\*\*一、/g) || []).length === 1, (mv.match(/\*\*[一二三四]、[^*]+\*\*/g) || []).join(' / '));
  check('合并后「下周工作计划」也只有一份', (mv.match(/下周工作计划/g) || []).length === 1);

  const noticeText = await main.ev(`(() => {
    const p = [...document.querySelectorAll('.pill')].find(x => (x.textContent || '').includes('已合并'));
    return p ? (p.textContent || '') : '';
  })()`);
  check('页面上提示「已合并：更新 N 个章节」', /已合并/.test(String(noticeText)), String(noticeText).slice(0, 40));

  await main.shot(path.join(shotDir, 'merged.png'));

  /* ---- 7. 一个项目都不勾时，绝不能退化成「全部」---- */
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('从禅道生成'));
    if (b) b.click();
    return !!b;
  })()`);
  await waitFor(`!!document.querySelector('.digest-inst')`, 10000);
  await sleep(900);

  await main.ev(`(() => {
    [...document.querySelectorAll('.digest-inst')].forEach(x => {
      const b = x.querySelector('.digest-all');
      if (b && (b.textContent || '').includes('全不选')) b.click();
    });
    return true;
  })()`);
  await sleep(450);
  const zero = await main.ev(`[...document.querySelectorAll('.digest-inst')].map(x => {
    const boxes = [...x.querySelectorAll('.digest-prod input')];
    return boxes.filter(i => i.checked).length + '/' + boxes.length;
  })`);
  check('「全不选」能把所有项目清空',
    zero.length === 2 && zero.every(t => t.startsWith('0/')), JSON.stringify(zero));

  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').includes('生成草稿'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1500);
  const noPickErr = await main.ev(`(() => {
    const p = [...document.querySelectorAll('.pill-bad')].find(x => (x.textContent || '').includes('勾选'));
    return p ? (p.textContent || '') : '';
  })()`);
  check('没勾项目时直接拦下来，不会退化成生成全部',
    /还没有勾选任何项目/.test(String(noPickErr)), String(noPickErr).slice(0, 46));

  /* ---- 8. 记住上次选择 + 生成并保存 ---- */
  const clickCancel = async () => {
    await main.ev(`(() => {
      const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').trim() === '取消');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(500);
  };
  const openDigest = async () => {
    await main.ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('从禅道生成'));
      if (b && !b.disabled) b.click();
      return !!(b && !b.disabled);
    })()`);
    const ok = await waitFor(`!!document.querySelector('.digest-inst')`, 10000);
    await sleep(600);
    return ok;
  };
  const pickFirstTwo = async () => {
    // 精确设成「只勾前两个」：逐个对比目标状态，不依赖当前是全选还是全不选
    return main.ev(`(() => {
      const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
      if (!inst) return null;
      const boxes = [...inst.querySelectorAll('.digest-prod input')];
      boxes.forEach((b, i) => { if (b.checked !== (i < 2)) b.click(); });
      return boxes.length;
    })()`);
  };

  await clickCancel();
  await openDigest();
  await pickFirstTwo();
  await sleep(300);
  const beforeClose = await main.ev(`(() => {
    const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
    return inst ? [...inst.querySelectorAll('.digest-prod input')].filter(i => i.checked).length : -1;
  })()`);
  await clickCancel();

  const prefRaw = await main.ev(`localStorage.getItem('pm.weekly.digest')`);
  check('关闭弹窗时把选择存到本机', !!prefRaw && /productIds/.test(String(prefRaw)), String(prefRaw || '').slice(0, 56));

  await openDigest();
  const afterReopen = await main.ev(`(() => {
    const inst = [...document.querySelectorAll('.digest-inst')].find(x => (x.querySelector('.digest-inst-name')?.textContent || '') === '甲公司');
    if (!inst) return null;
    const boxes = [...inst.querySelectorAll('.digest-prod input')];
    return { on: inst.classList.contains('is-on'), checked: boxes.filter(i => i.checked).length, total: boxes.length };
  })()`);
  check('重新打开弹窗，上次勾的项目还在（不用每周重勾一遍）',
    beforeClose === 2 && afterReopen && afterReopen.checked === 2 && afterReopen.on === true,
    JSON.stringify(afterReopen));

  // ---- 8.2 生成并保存：目录为空时直接写盘，不问 ----
  await main.ev(`(() => {
    [...document.querySelectorAll('.digest-inst')].forEach(x => {
      const b = x.querySelector('.digest-all');
      if (b && (b.textContent || '').trim() === '全选') b.click();
    });
    return true;
  })()`);
  await sleep(400);

  const saveBtn = await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').includes('生成并保存'));
    if (b) b.click();
    return !!b;
  })()`);
  check('弹窗底部有「生成并保存」', saveBtn === true);

  // 等文件真的出现（最多 30 秒，第一次要拉全量）
  let written = [];
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { written = fs.readdirSync(wkDir).filter(f => f.endsWith('.md')); } catch { written = []; }
    if (written.length) break;
  }
  check('生成并保存后文件落到周报目录', written.length === 1, written.join(',') || '（空）');
  check('文件名就是统计结束日期', /^\d{4}-\d{2}-\d{2}\.md$/.test(written[0] || ''), written[0]);

  const savedBody = written[0] ? fs.readFileSync(path.join(wkDir, written[0]), 'utf8') : '';
  check('存进去的正文就是生成结果', /累计缺陷/.test(savedBody));

  const afterSaveDraft = await main.ev(`(() => {
    const input = document.querySelector('.wk-editor input');
    return { name: input ? input.value : '', editing: !!document.querySelector('.wk-md-input') };
  })()`);
  check('保存后仍停在编辑态，文件名与已存文件一致',
    afterSaveDraft.editing === true && afterSaveDraft.name === written[0],
    JSON.stringify(afterSaveDraft));

  // ---- 8.3 同名文件先问一句，不能悄悄覆盖 ----
  // 先退出编辑态（编辑态下 PageHead 换成了「预览/取消/保存」，没有「新建周报」）
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')]
      .filter(x => (x.textContent || '').trim() === '取消')
      .find(x => !x.closest('.modal'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(700);

  const newBtn = await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('新建周报'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  check('准备：能点「新建周报」回到空白草稿', newBtn === true);
  await sleep(500);

  await openDigest();
  await main.ev(`(() => {
    [...document.querySelectorAll('.digest-inst')].forEach(x => {
      const b = x.querySelector('.digest-all');
      if (b && (b.textContent || '').trim() === '全选') b.click();
    });
    return true;
  })()`);
  await sleep(300);
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').includes('生成并保存'));
    if (b) b.click();
    return !!b;
  })()`);

  const overwriteShown = await waitFor(
    `[...document.querySelectorAll('.modal-header span')].some(x => (x.textContent || '').trim() === '这个文件名已经存在')`,
    30000,
  );
  check('同名文件会先问一句「这个文件名已经存在」', overwriteShown === true);

  const beforeMtime = written[0] ? fs.statSync(path.join(wkDir, written[0])).mtimeMs : 0;
  await main.ev(`(() => {
    const b = [...document.querySelectorAll('.modal-footer button')].find(x => (x.textContent || '').trim() === '覆盖');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2500);
  const afterMtime = written[0] ? fs.statSync(path.join(wkDir, written[0])).mtimeMs : 0;
  check('确认后才覆盖，文件被更新', afterMtime >= beforeMtime && afterMtime > 0);

  // ---- 8.4 编辑器：固定高度 + 边框 + 框内滚动 ----
  const editorBox = await main.ev(`(() => {
    const ed = document.querySelector('.wk-editor');
    const ta = document.querySelector('.wk-md-input');
    if (!ed || !ta) return null;
    const cs = getComputedStyle(ta);
    return {
      h: Math.round(ed.getBoundingClientRect().height),
      expect: window.innerHeight - 300,
      border: cs.borderTopWidth,
      overflow: cs.overflowY,
    };
  })()`);
  check('编辑器有边框', editorBox && parseFloat(editorBox.border) >= 1, editorBox && editorBox.border);
  check('编辑器内部可上下滚动（不再是整页跟着滚）',
    editorBox && editorBox.overflow === 'auto', editorBox && editorBox.overflow);
  check('编辑器高度与左栏目录同一口径（视口 − 300）',
    editorBox && Math.abs(editorBox.h - editorBox.expect) < 90,
    editorBox ? `${editorBox.h}px / 期望 ${editorBox.expect}px` : '未取到');

  // 注入一段长文本，确认滚动条真的出现在框里而不是把框撑长
  const scrollInfo = await main.ev(`(() => {
    const ta = document.querySelector('.wk-md-input');
    if (!ta) return null;
    const before = Math.round(ta.getBoundingClientRect().height);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, Array.from({ length: 200 }, (_, i) => '第 ' + (i + 1) + ' 行内容').join('\\n'));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: Math.round(ta.getBoundingClientRect().height),
             scrollable: ta.scrollHeight > ta.clientHeight + 4 };
  })()`);
  check('内容变长也不会把编辑框撑长（超出部分框内滚动）',
    scrollInfo && Math.abs(scrollInfo.after - scrollInfo.before) <= 2 && scrollInfo.scrollable === true,
    JSON.stringify(scrollInfo));

  // ---- 8.5 阅读态（查看已保存的周报）也要是同一个框 ----
  const longFile = path.join(wkDir, '2026-01-02.md');
  fs.writeFileSync(longFile, [
    '**一、资产管理系统**',
    '',
    '累计缺陷 1033 个，已关闭 983 个，修复率 84.2%。模块分布如下：',
    '',
    ...Array.from({ length: 120 }, (_, i) => `- 模块${i + 1} ${100 - i} 个（待修复 ${i % 3} 个）`),
  ].join('\n'), 'utf8');

  await main.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '刷新');
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1200);

  const openedLong = await main.ev(`(() => {
    const item = [...document.querySelectorAll('.wk-item')].find(x => (x.textContent || '').includes('2026-01-02'));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  check('准备：列表里能点开长周报', openedLong === true);
  await sleep(1200);

  const readBox = await main.ev(`(() => {
    const el = document.querySelector('.wk-read');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      h: Math.round(el.getBoundingClientRect().height),
      expect: window.innerHeight - 300,
      border: cs.borderTopWidth,
      overflow: cs.overflowY,
      scrollable: el.scrollHeight > el.clientHeight + 4,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 8,
    };
  })()`);
  check('阅读态有边框、固定高度（与编辑态同一个框）',
    readBox && parseFloat(readBox.border) >= 1 && Math.abs(readBox.h - readBox.expect) < 90,
    readBox ? `${readBox.h}px / 期望 ${readBox.expect}px` : '未取到');
  check('长周报在框内滚动，不再把整页撑开',
    readBox && readBox.overflow === 'auto' && readBox.scrollable === true,
    readBox ? `scrollable=${readBox.scrollable}` : '未取到');

  await main.shot(path.join(shotDir, 'read.png'));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  console.log('桩服务请求量：A ' + stubA.log.length + ' 次，B ' + stubB.log.length + ' 次');
  cleanup();
  process.exit(fail ? 1 : 0);
})();
