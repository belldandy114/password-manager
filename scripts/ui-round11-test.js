/**
 * round11 回归：1.10.0
 *   1) 「指派给我」拉取后不再显示「未按账号复核」（走 REST + 本地账号过滤）
 *   2) 缺陷管理项目选择器显示所属项目集；禅道配置带「公司」字段并按公司显示
 *   3) 代码调试页：能检测运行时、跑 JS/Python/Java 并显示输出
 *
 * 禅道部分默认用本地桩（scripts/zt-stub.js），没配 ZT_* 也能跑。
 * 用法：node scripts/ui-round11-test.js   （先 npm run pack）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickExe } = require('./pick-exe');
const { ensureZt } = require('./zt-stub');

const APP_DIR = path.join(__dirname, '..', 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9855;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } else {
    fail += 1;
    problems.push(name);
    console.log(`✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

async function main() {
  const ztEnv = await ensureZt(9856);
  const zt = ztEnv.ZT || ztEnv;
  if (ztEnv.stub) console.log('· 未配置 ZT_* 环境变量，禅道使用本地桩服务');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r11-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = spawn(EXE, ['--user-data-dir=' + userData, `--remote-debugging-port=${PORT}`], {
    env,
    cwd: APP_DIR,
    stdio: 'ignore',
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  if (!target) {
    console.log('FAIL 应用未启动');
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(2500);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EX:' + String(r.exceptionDetails.exception?.description || '').slice(0, 140);
    return r.result?.value;
  };
  const SETVAL = `(el, v) => { const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(p, 'value').set; d.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }`;
  const setVal = (sel, v) => ev(`(() => { const s = ${SETVAL}; const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; s(el, ${JSON.stringify(v)}); return true; })()`);
  const clickHas = (txt) => ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(txt)})); if (b) { b.click(); return true; } return false; })()`);
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    for (let i = 0; i < 60; i++) {
      const t = await ev(`(() => (document.querySelector('.pg-title') || {}).textContent || '')()`);
      if (String(t).includes(label)) return true;
      await sleep(100);
    }
    return false;
  };

  // ---- 建库 ----
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')].filter(x => x.type !== 'checkbox'); s(ins[0], 'Test@1234'); if (ins[1]) s(ins[1], 'Test@1234'); return 1; })()`);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /设置主密码并开始使用/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await sleep(3000);

  /* ================= A. 代码调试 ================= */
  await navTo('代码调试');
  await sleep(600);
  const det = await ev(`window.electronAPI.codelabDetect().then(r => r.data)`);
  check('代码调试：能检测 Node / Python / JDK',
    !!det && det.node && det.node.ok === true && typeof det.python?.ok === 'boolean' && typeof det.java?.ok === 'boolean',
    JSON.stringify({ node: det && det.node && det.node.ok, python: det && det.python && det.python.ok, java: det && det.java && det.java.ok }));

  const pageBits = await ev(`(() => ({
    nav: [...document.querySelectorAll('.nav-item')].some(n => /代码调试/.test(n.textContent)),
    code: !!document.querySelector('.codelab-code'),
    out: !!document.querySelector('.codelab-out'),
    gutter: !!document.querySelector('.codelab-gutter'),
    dot: !!document.querySelector('.codelab-term-dot'),
    langs: document.querySelectorAll('.lang-select option').length,
    warn: /不是沙箱/.test(document.body.innerText),
  }))()`);
  check('代码调试：页面结构完整（导航/编辑器/行号/终端/语言/安全提示）',
    !!pageBits && pageBits.nav === true && pageBits.code === true && pageBits.out === true && pageBits.gutter === true && pageBits.dot === true && pageBits.langs >= 3 && pageBits.warn === true,
    JSON.stringify(pageBits));

  // 上下布局：代码区在上、输出区在下（用户明确要求改上下）
  const layout = await ev(`(() => {
    const ed = document.querySelector('.codelab-editor');
    const out = document.querySelector('.codelab-out');
    if (!ed || !out) return null;
    const a = ed.getBoundingClientRect(), b = out.getBoundingClientRect();
    return { above: Math.round(b.top - a.bottom), edH: Math.round(a.height), outH: Math.round(b.height) };
  })()`);
  check('代码调试：上下布局（代码在上、输出在下）',
    !!layout && layout.above >= -2 && layout.above < 200,
    JSON.stringify(layout));

  // 粘贴一大段代码后，「运行」按钮仍要在视口内（以前会被顶出去）
  const bigCode = Array.from({ length: 400 }, (_, i) => "console.log('line " + i + "')").join('\n');
  await setVal('.codelab-code', bigCode);
  await sleep(400);
  const btnPos = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '运行');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight };
  })()`);
  check('代码调试：400 行代码不会把「运行」按钮顶出视口',
    !!btnPos && btnPos.visible === true,
    JSON.stringify(btnPos));

  // 代码区自身滚动，页面高度不跟着暴涨
  const scrollState = await ev(`(() => {
    const ed = document.querySelector('.codelab-code');
    return { docH: document.documentElement.scrollHeight, codeScrolls: ed ? ed.scrollHeight > ed.clientHeight : false, codeH: ed ? ed.clientHeight : 0 };
  })()`);
  check('代码调试：代码区内部滚动（长代码不撑高编辑器）',
    !!scrollState && scrollState.codeScrolls === true && scrollState.codeH <= 420,
    JSON.stringify(scrollState));

  // 跑 JS：stdout 与 stderr 都要显示
  await setVal('.codelab-code', 'console.log("r11-out", 6 * 7); console.error("r11-err");');
  await sleep(200);
  await clickHas('运行');
  let lines = [];
  for (let i = 0; i < 80; i++) {
    lines = await ev(`(() => [...document.querySelectorAll('.codelab-line')].map(l => l.className.replace('codelab-line ', '') + ':' + l.textContent))()`);
    if (Array.isArray(lines) && lines.some((l) => /r11-err/.test(l))) break;
    await sleep(200);
  }
  const joined = Array.isArray(lines) ? lines.join('\n') : '';
  check('代码调试：JavaScript 运行并输出 stdout', /is-stdout:r11-out 42/.test(joined), joined.slice(0, 120));
  check('代码调试：stderr 单独标色显示', /is-stderr:r11-err/.test(joined), joined.slice(0, 120));

  // 语法错误要能给出非 0 退出码，而不是静默成功
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /清空输出/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await setVal('.codelab-code', 'console.log(');
  await sleep(150);
  await clickHas('运行');
  await sleep(4000);
  const errState = await ev(`(() => ({ text: document.body.innerText.slice(0, 400), meta: [...document.querySelectorAll('.pnl-meta')].map(m => m.textContent.trim()).join('|') }))()`);
  check('代码调试：语法错误显示为非零退出（不谎报成功）',
    /退出码 [1-9]|SyntaxError|is-error/.test(JSON.stringify(errState)), String(errState && errState.meta).slice(0, 80));

  // HTML 模式：不起进程，直接 iframe 预览 + console 回显
  const htmlLangs = await ev(`(() => [...document.querySelectorAll('.lang-select option')].map(o => o.value))()`);
  check('代码调试：语言里有 HTML', Array.isArray(htmlLangs) && htmlLangs.includes('html'), JSON.stringify(htmlLangs));
  await ev(`(() => { const s = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; d.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); }; const sel = document.querySelector('.lang-select'); s(sel, 'html'); return !!sel; })()`);
  await sleep(400);
  const htmlCode = '<!doctype html><html><head><title>t</title></head><body><h1 id="h">r11-html</h1>'
    + '<scr' + 'ipt>console.log("r11-html-log", 1 + 1)</scr' + 'ipt></body></html>';
  await setVal('.codelab-code', htmlCode);
  await sleep(300);
  await clickHas('预览');
  await sleep(1800);
  const htmlState = await ev(`(() => ({
    iframe: !!document.querySelector('.codelab-preview'),
    tabs: [...document.querySelectorAll('.codelab-tab')].map(b => b.textContent.trim()).join('|'),
  }))()`);
  check('代码调试：HTML 运行后出现预览 iframe 与「预览/控制台」页签',
    !!htmlState && htmlState.iframe === true && /预览/.test(htmlState.tabs) && /控制台/.test(htmlState.tabs),
    JSON.stringify(htmlState));
  await ev(`(() => { const b = [...document.querySelectorAll('.codelab-tab')].find(x => /控制台/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  const htmlLogs = await ev(`(() => [...document.querySelectorAll('.codelab-line')].map(l => l.textContent).join(' | '))()`);
  console.log('· HTML 控制台内容：', String(htmlLogs).slice(0, 120));
  check('代码调试：HTML 里的 console 输出回显到控制台',
    /r11-html-log/.test(String(htmlLogs)), String(htmlLogs).slice(0, 120));

  /* ================= B. 缺陷管理配置：公司字段 & 项目集 ================= */
  await navTo('缺陷管理');
  await sleep(800);
  const cfgUi = await ev(`(() => ({
    companyField: [...document.querySelectorAll('.field-label')].map(x => x.textContent.trim()),
    cfgChips: document.querySelectorAll('.zt-cfg-chip').length,
  }))()`);
  check('缺陷管理：配置面板有「名称」字段（不再叫公司 / 客户）',
    !!cfgUi && Array.isArray(cfgUi.companyField) && cfgUi.companyField.includes('名称') && !cfgUi.companyField.some(t => /公司/.test(t)),
    JSON.stringify(cfgUi));

  // 配置显示：直接写入 integrations（登录流程需要真实禅道，桩服务只覆盖 REST）
  await ev(`(async () => {
    await window.electronAPI.wsSet('integrations', [
      { id: 'cfg1', company: '示例科技', baseUrl: 'http://a.example.com/zentao', account: 'u1', password: 'p1', updatedAt: new Date().toISOString() },
      { id: 'cfg2', company: '另一家公司', baseUrl: 'http://b.example.com/zentao', account: 'u2', password: 'p2', updatedAt: new Date().toISOString() },
    ]);
    return 1;
  })()`);
  await navTo('网址管理');
  await sleep(300);
  await navTo('缺陷管理');
  await sleep(1200);
  const chipText = await ev(`(() => [...document.querySelectorAll('.zt-cfg-chip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim()).join(' | '))()`);
  check('缺陷管理：已保存配置按名称显示（不再显示地址）',
    /示例科技/.test(String(chipText)) && /另一家公司/.test(String(chipText)) && !/example\.com/.test(String(chipText)),
    String(chipText).slice(0, 120));

  // 项目集：桩服务给 products 带了 program，/programs 给了名字
  const projItem = await ev(`(async () => {
    const r = await window.electronAPI.zentaoProjects({ company: 'C', baseUrl: ${JSON.stringify(zt.baseUrl)}, account: ${JSON.stringify(zt.account)}, password: ${JSON.stringify(zt.password)} });
    return r && r.data ? r.data.map(p => ({ n: p.name, pr: p.programName || '' })) : null;
  })()`);
  check('缺陷管理：项目带项目集名称（重名项目可区分）',
    Array.isArray(projItem) && projItem.length > 0 && projItem.every(p => !!p.pr),
    JSON.stringify(projItem).slice(0, 140));
  /* ================= C. 切换不同地址的配置：项目不能串 ================= */
  // 起第二个桩，项目 id 与第一个完全不同（9001），用来暴露「拿旧地址的项目 id 去查新地址」
  const http = require('http');
  const B_PORT = 9862;
  const bServer = http.createServer((req, res) => {
    const url = req.url || '/';
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (/\/user-login\.html$/.test(url)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html></html>'); }
    if (/\/api\.php\/v1\/tokens$/.test(url)) return send(201, { token: 'b-token' });
    if (/\/api\.php\/v1\/programs/.test(url)) return send(200, { programs: [{ id: 70, name: 'B项目集' }] });
    if (/\/api\.php\/v1\/products/.test(url)) return send(200, { total: 1, products: [{ id: 9001, name: 'B项目', program: 70 }] });
    if (/\/api\.php\/v1\/bugs/.test(url)) {
      const q = new URL(url, 'http://x').searchParams;
      if (!q.get('product')) return send(400, { result: 'fail', message: 'Need product id.' });
      return send(200, {
        total: 1,
        bugs: [{ id: 9001, title: 'B项目的Bug', status: 'active', severity: '3', pri: '3', type: 'codeerror', product: 9001, assignedTo: { account: 'bstub', realname: 'B' }, openedBy: { account: 'bstub', realname: 'B' }, openedDate: '2026-11-01', resolution: '' }],
      });
    }
    return send(404, 'not found');
  });
  await new Promise((r) => bServer.listen(B_PORT, '127.0.0.1', r));
  const B_BASE = 'http://127.0.0.1:' + B_PORT + '/zentao';
  const B_CFG = { id: 'cfgB', company: '公司B', baseUrl: B_BASE, account: 'bstub', password: 'bp' };
  const A_CFG = { id: 'cfgA', company: '公司A', baseUrl: zt.baseUrl, account: zt.account, password: zt.password };

  // 两套地址的项目 id 必须不同（这是复现「选了 22 报不在列表」的前提）
  const aIds = await ev('(async () => { const r = await window.electronAPI.zentaoProjects(' + JSON.stringify({ baseUrl: zt.baseUrl, account: zt.account, password: zt.password }) + '); return (r.data || []).map(p => String(p.id)); })()');
  const bIds = await ev('(async () => { const r = await window.electronAPI.zentaoProjects(' + JSON.stringify({ baseUrl: B_BASE, account: 'bstub', password: 'bp' }) + '); return (r.data || []).map(p => String(p.id)); })()');
  check('配置切换：A/B 两套地址的项目 id 不同（可用于验证不串数据）',
    Array.isArray(aIds) && Array.isArray(bIds) && aIds.length > 0 && bIds.length > 0 && aIds.every(id => !bIds.includes(id)),
    'A=' + JSON.stringify(aIds) + ' B=' + JSON.stringify(bIds));

  // 后端行为：拿 A 的项目 id 去查 B 地址必须被明确拒绝（而不是静默返回空）
  const staleErr = await ev('(async () => { const r = await window.electronAPI.zentaoMyBugs(' + JSON.stringify({ baseUrl: B_BASE, account: 'bstub', password: 'bp' }) + ", 'assigned', " + JSON.stringify(aIds) + "); return { ok: r.success, err: r.error || '' }; })()");
  check('配置切换：旧地址的项目 id 查新地址会被明确拒绝',
    !!staleErr && /不在项目列表里/.test(String(staleErr.err)), JSON.stringify(staleErr));

  // 界面：切到 B 配置后自动用新项目重试，不把旧 id 的报错甩给用户
  await ev('(async () => { await window.electronAPI.wsSet(\'integrations\', ' + JSON.stringify([A_CFG, B_CFG]) + '); return 1; })()');
  await navTo('网址管理');
  await sleep(300);
  await navTo('缺陷管理');
  await sleep(1200);
  await ev('(() => { const c = [...document.querySelectorAll(\'.zt-cfg-chip\')].find(x => /公司A/.test(x.textContent)); if (c) { c.click(); return true; } return false; })()');
  await sleep(600);
  await clickHas('登录并保存');
  await sleep(1200);
  await ev('(() => { const b = [...document.querySelectorAll(\'button\')].find(x => /拉取「/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()');
  await sleep(1800);
  await ev('(() => { const c = [...document.querySelectorAll(\'.zt-cfg-chip\')].find(x => /公司B/.test(x.textContent)); if (c) { c.click(); return true; } return false; })()');
  await sleep(800);
  await clickHas('登录并保存');
  await sleep(1500);
  await ev('(() => { const b = [...document.querySelectorAll(\'button\')].find(x => /拉取「/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()');
  await sleep(2200);
  const afterSwitch = await ev('(() => ({ err: (document.querySelector(\'.pill-bad\') || {}).textContent || \'\', label: (document.querySelector(\'.zt-mine-proj\') || {}).textContent || \'\', rows: document.querySelectorAll(\'.tbl tbody tr\').length }))()');
  check('配置切换：切到另一套地址后不报「所选项目不在项目列表里」',
    !/不在项目列表里/.test(String(afterSwitch.err)), JSON.stringify(afterSwitch));
  check('配置切换：项目标签跟着换成新地址的项目（或提示未选择）',
    /B项目|未选择项目|全部/.test(String(afterSwitch.label)), String(afterSwitch.label));

  bServer.close();

  /* ================= D. 测试数据页面（1.24.2 起原生 React，无 webview） ================= */
  await navTo('测试数据');
  await sleep(1500);
  const tdgState = await ev(`(() => ({
    groups: document.querySelectorAll('.tdg-group').length,
    webview: !!document.querySelector('webview'),
    host: document.documentElement.getAttribute('data-theme')
  }))()`);
  check('测试数据：原生页面已渲染且不再有 webview',
    !!tdgState && tdgState.groups >= 4 && tdgState.webview === false, JSON.stringify(tdgState));

  // 页面现在和主应用共用一套 CSS 令牌，不需要主题桥：确认主题属性与页面节点都在
  const themeSync = await ev(`(() => {
    const el = document.querySelector('.tdg-group');
    if (!el) return { skip: true };
    return { host: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(el).backgroundColor };
  })()`);
  check('测试数据：页面与主应用共用主题（无独立主题桥）',
    !!themeSync && (themeSync.skip === true || (!!themeSync.host && !!themeSync.bg)),
    JSON.stringify(themeSync).slice(0, 140));

  /* ================= E. 工具箱：JSON 转化已并入 ================= */
  const sideNav = await ev(`(() => [...document.querySelectorAll('.nav-item')].map(x => x.textContent.trim()))()`);
  check('侧栏：JSON 转化已从菜单移除（并入工具箱）',
    Array.isArray(sideNav) && sideNav.every(t => !/JSON 转化/.test(t)), JSON.stringify(sideNav).slice(0, 160));

  await navTo('工具箱');
  await sleep(900);
  const toolTabs = await ev(`(() => [...document.querySelectorAll('.tb-rail-item')].map(b => b.textContent.trim()))()`);
  check('工具箱：页签里有「JSON 转化」',
    Array.isArray(toolTabs) && toolTabs.some(t => /JSON 转化/.test(t)), JSON.stringify(toolTabs).slice(0, 200));
  check('工具箱：左侧导航渲染出工具项',
    await ev(`(() => { const el = document.querySelector('.tb-rail-scroll'); return el ? el.scrollHeight > 0 : false; })()`),
    await ev(`(() => { const el = document.querySelector('.tool-tabs'); return el ? el.scrollWidth + '/' + el.clientWidth : 'none'; })()`));

  // 点进 JSON 转化，修一段脏 JSON
  await clickHas('JSON 转化');
  await sleep(700);
  await setVal('.json-io', "{ 'a': 1, b: 'x', c: [1,2,] }");
  await sleep(200);
  await ev(`(() => { const b = document.querySelector('.json-run'); if (b) { b.click(); return true; } return false; })()`);
  await sleep(700);
  const jsonOut = await ev(`(() => { const pre = document.querySelector('.json-out .json-pre'); return pre ? pre.textContent : ''; })()`);
  check('工具箱：JSON 转化能修复脏 JSON 并给出结果',
    /"a"/.test(String(jsonOut)) && /"b"/.test(String(jsonOut)), String(jsonOut).slice(0, 80));
  check('工具箱：JSON 转化是左右双栏（输入/结果并排）',
    await ev(`(() => { const p1 = document.querySelectorAll('.json-pane'); if (p1.length < 2) return false; const a = p1[0].getBoundingClientRect(), b = p1[1].getBoundingClientRect(); return Math.abs(a.top - b.top) < 4 && b.left > a.right - 4; })()`),
    await ev(`(() => { const p1 = document.querySelectorAll('.json-pane'); return p1.length + ' pane'; })()`));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (problems.length) console.log('失败项：\n - ' + problems.join('\n - '));
  ws.close();
  app.kill();
  if (ztEnv.stop) ztEnv.stop();
  await sleep(800);
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('ERR', e);
  process.exit(1);
});
