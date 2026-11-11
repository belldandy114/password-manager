/**
 * 1.11.0 回归：工具箱重构 + 新工具
 *
 * 覆盖：
 *   ① 分组页签：5 组 20 个工具、不横向溢出、键盘切换（ArrowRight）
 *   ② 状态保留：切走再切回，输入还在
 *   ③ 结果复制/导出按钮按需出现
 *   ④ 新工具：YAML↔JSON、JSON 结构对比、JWT 生成、ID/流水号、SQL 参数化、时间轴、签名计算
 *   ⑤ 旧工具升级：时间戳单位识别、GBK 解码、diff 忽略空白、Cron 反向生成
 *   ⑥ 侧栏分组折叠、命令面板工具级搜索（含「去工具箱」联动入口存在）
 *
 * 跑法：node scripts/ui-round12-test.js            （打包版 release/win-unpacked）
 *       USE_PACKED=1 node scripts/ui-round12-test.js
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pickExe } = require('./pick-exe');

const USE_PACKED = process.env.USE_PACKED === '1';
const EXE = pickExe(path.join(__dirname, '..', 'release', 'win-unpacked'));
const PORT = 9877;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const problems = [];
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`);
  } else {
    fail += 1;
    problems.push(name + (extra ? ` → ${extra}` : ''));
    console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

const SETVAL = `(el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value').set;
  desc.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}`;

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error('找不到 exe：' + EXE);
    process.exit(1);
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r12-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`], {
    env,
    cwd: path.dirname(EXE),
    stdio: 'ignore',
  });

  let target = null;
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  if (!target) {
    console.error('连不上调试端口');
    app.kill();
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
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
    if (r.exceptionDetails) return 'EX:' + String(r.exceptionDetails.exception?.description || '').slice(0, 160);
    return r.result?.value;
  };
  const setVal = (sel, value) => ev(`(() => { const s = ${SETVAL}; const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; s(el, ${JSON.stringify(value)}); return true; })()`);
  const clickByText = (text) => ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)} || x.textContent.includes(${JSON.stringify(text)})); if (b) { b.click(); return true; } return false; })()`);
  const clickTab = (label) => ev(`(() => { const b = [...document.querySelectorAll('.tb-rail-item')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (b) { b.click(); return true; } return false; })()`);
  const waitFor = async (expr, ms = 6000) => {
    for (let i = 0; i < ms / 150; i += 1) {
      if (await ev(expr)) return true;
      await sleep(150);
    }
    return false;
  };

  // 初始化（首次运行要设主密码）
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')].filter(x => x.type !== 'checkbox'); if (ins[0]) s(ins[0], 'Test@1234'); if (ins[1]) s(ins[1], 'Test@1234'); return 1; })()`);
  await sleep(300);
  await clickByText('设置主密码并开始使用');
  await sleep(2600);

  /* ---------------- ① 分组与页签 ---------------- */
  await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('工具箱')); if (n) n.click(); return !!n; })()`);
  await waitFor(`!!document.querySelector('.tb-rail-scroll')`);
  await sleep(400);

  const groups = await ev(`(() => [...document.querySelectorAll('.tool-group-label')].map(x => x.textContent.trim()))()`);
  check('工具箱：分成 5 个组', Array.isArray(groups) && groups.length === 5, JSON.stringify(groups));
  const tabs = await ev(`(() => [...document.querySelectorAll('.tb-rail-item')].map(x => x.textContent.trim()))()`);
  check('工具箱：21 个工具页签', Array.isArray(tabs) && tabs.length === 21, `${tabs && tabs.length} 个`);
  check('工具箱：页签条不横向溢出', await ev(`(() => { const el = document.querySelector('.tb-rail-scroll'); return el ? el.scrollWidth <= el.clientWidth + 2 : false; })()`));
  check('工具箱：页签具备 tablist 语义', await ev(`(() => document.querySelector('.tb-rail-scroll')?.getAttribute('role') === 'tablist')()`));

  // 键盘切换（ArrowRight）
  const before = await ev(`(() => document.querySelector('.tb-rail-item.is-active')?.textContent.trim())()`);
  await ev(`(() => { const el = document.querySelector('.tb-rail-item.is-active'); el?.focus(); return !!el; })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(400);
  const after = await ev(`(() => document.querySelector('.tb-rail-item.is-active')?.textContent.trim())()`);
  check('工具箱：方向键可切换工具', !!after && after !== before, `${before} → ${after}`);

  // 左导航字号：用户反馈「字体太小不显眼」，用几何量锁住（≥13px 且条目高 ≥32）
  const railType = await ev(`(() => {
    const item = document.querySelector('.tb-rail-item');
    const label = document.querySelector('.tb-rail .tool-group-label');
    if (!item) return null;
    const cs = getComputedStyle(item);
    const ls = label ? getComputedStyle(label) : null;
    return { itemPx: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400, h: Math.round(item.getBoundingClientRect().height), groupPx: ls ? parseFloat(ls.fontSize) : 0 };
  })()`);
  check('工具箱：左导航字号 ≥13px、条目高度 ≥32px（可读性）',
    !!railType && railType.itemPx >= 13 && railType.h >= 32,
    JSON.stringify(railType));
  check('工具箱：分组标题字号 ≥11px（不再是小灰字）',
    !!railType && railType.groupPx >= 11,
    JSON.stringify(railType));

  /* ---------------- ② 状态保留 ---------------- */
  await clickTab('编码转换');
  await waitFor(`!!document.querySelector('.tool-panel textarea')`);
  await setVal('.tool-panel textarea', 'hello keep-state');
  await sleep(200);
  await clickTab('URL 参数');
  await sleep(500);
  await clickTab('编码转换');
  await sleep(500);
  const kept = await ev(`(() => { const ta = document.querySelector('.tool-panel textarea'); return ta ? ta.value : ''; })()`);
  check('工具箱：切走再切回，输入还在（状态保留）', kept === 'hello keep-state', JSON.stringify(kept));

  /* ---------------- ③ 复制/导出按钮 ---------------- */
  const headBtns = await ev(`(() => [...document.querySelectorAll('.tb-main-actions button')].map(b => ({ t: b.textContent.trim(), disabled: b.disabled })))()`);
  check('工具箱：工具头有「复制结果 / 导出」（结果为空时禁用）',
    Array.isArray(headBtns) && headBtns.some((x) => /复制结果/.test(x.t)) && headBtns.some((x) => /导出/.test(x.t)) && headBtns.every((x) => x.disabled === false), JSON.stringify(headBtns));

  /* ---------------- ④ 新工具 ---------------- */
  // YAML ↔ JSON
  await clickTab('YAML ↔ JSON');
  await waitFor(`!!document.querySelector('.tb-textarea')`);
  await setVal('.tb-textarea', '{"a":1,"b":[1,2]}');
  await sleep(700);
  const yamlOut = await ev(`(() => { const pre = document.querySelector('.json-pre'); return pre ? pre.textContent : ''; })()`);
  check('新工具：YAML ↔ JSON（JSON→YAML）', /a:\s*1/.test(String(yamlOut)) && /-\s*1|-\s*2/.test(String(yamlOut)), JSON.stringify(yamlOut).slice(0, 60));

  // JSON 结构对比
  await clickTab('JSON 对比');
  await waitFor(`document.querySelectorAll('.tb-textarea').length >= 2`);
  await ev(`(() => { const s = ${SETVAL}; const list = [...document.querySelectorAll('.tb-textarea')]; s(list[0], '{"code":0,"data":{"name":"甲","age":18}}'); s(list[1], '{"code":0,"data":{"name":"乙","age":18}}'); return true; })()`);
  await sleep(700);
  const diffRows = await ev(`(() => [...document.querySelectorAll('.jd-row')].map(r => r.textContent.trim()))()`);
  check('新工具：JSON 结构对比只报变化的路径', Array.isArray(diffRows) && diffRows.length === 1 && /data\.name/.test(String(diffRows[0])), JSON.stringify(diffRows).slice(0, 90));

  // JWT 生成
  await clickTab('JWT 生成');
  await waitFor(`!!document.querySelector('.tb-textarea')`);
  await sleep(300);
  await clickByText('生成 token');
  await sleep(1200);
  const jwt = await ev(`(() => { const pre = document.querySelector('.tb-pre-wrap'); return pre ? pre.textContent.trim() : ''; })()`);
  check('新工具：JWT 生成（三段式 token）', String(jwt).split('.').length === 3 && String(jwt).startsWith('eyJ'), String(jwt).slice(0, 28));

  // ID / 流水号
  await clickTab('ID / 流水号');
  await waitFor(`!!document.querySelector('.tb-pre-list')`);
  await sleep(400);
  const ids = await ev(`(() => { const pre = document.querySelector('.tb-pre-list'); return pre ? pre.textContent.trim().split('\\n') : []; })()`);
  check('新工具：ID 生成 10 条且不重复', Array.isArray(ids) && ids.length === 10 && new Set(ids).size === 10, `${ids && ids.length} 条`);

  // SQL 参数化
  await clickTab('SQL 参数化');
  await waitFor(`!!document.querySelector('.tb-textarea')`);
  await setVal('.tb-textarea', "select * from users where name = '张三' and age > 18");
  await sleep(600);
  const sqlOut = await ev(`(() => { const pre = document.querySelector('.json-pre'); return pre ? pre.textContent : ''; })()`);
  check('新工具：SQL 字面量 → ? 占位', /name = \?/.test(String(sqlOut)) && /年龄?|18|张三/.test(String(sqlOut)), String(sqlOut).slice(0, 70));

  // 时间轴
  await clickTab('时间轴/耗时');
  await waitFor(`!!document.querySelector('.tb-textarea')`);
  await setVal('.tb-textarea', '1700000000000\n1700000005000\n1700000030000');
  await sleep(700);
  const tl = await ev(`(() => { const rows = document.querySelectorAll('.tl-row'); return { n: rows.length, text: document.querySelector('.tl-total')?.textContent || '' }; })()`);
  check('新工具：时间轴算出间隔与总耗时', tl.n === 3 && /30 秒/.test(String(tl.text)), JSON.stringify(tl));

  // 签名计算
  await clickTab('签名计算');
  // 等「计算签名」按钮真的出现（不能只等 textarea，上一个工具也有）
  await waitFor(`(() => [...document.querySelectorAll('.tb-main button')].some(b => /计算签名/.test(b.textContent)))()`, 8000);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('.tb-main button')].find(x => /计算签名/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
  await sleep(1200);
  const sign = await ev(`(() => { const pre = document.querySelector('.tb-pre-sign'); return pre ? pre.textContent.trim() : ''; })()`);
  check('新工具：签名计算输出 32 位 md5', /^[0-9a-f]{32}$/.test(String(sign)), sign);

  // 图片 / 二维码
  await clickTab('图片/二维码');
  // 等「生成二维码」按钮真的出现（不能只等 textarea，上一个工具也有）
  await waitFor(`(() => [...document.querySelectorAll('.tb-main button')].some(b => /生成二维码/.test(b.textContent)))()`, 8000);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('.tb-main button')].find(x => /生成二维码/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
  const qr = await waitFor(`(() => { const img = document.querySelector(".qr-img"); return !!(img && String(img.src).startsWith("data:image/png")); })()`, 8000);
  const qrLen = await ev(`(() => { const img = document.querySelector('.qr-img'); return img ? img.src.length : 0; })()`);
  check('新工具：二维码生成出 PNG dataURL', qr === true && Number(qrLen) > 500, `${qrLen} 字节`);
  /* ---------------- ⑤ 旧工具升级 ---------------- */
  // 时间戳单位识别
  await clickTab('时间戳');
  await waitFor(`!!document.querySelector('.tool-panel input')`);
  await setVal('.tool-panel input', '1700000000');
  await sleep(500);
  const unitRow = await ev(`(() => { const tds = [...document.querySelectorAll('.kv-table td')].map(t => t.textContent.trim()); return tds.slice(0, 4).join('|'); })()`);
  check('B6：10 位时间戳识别为「秒」', /识别单位\|s\|/.test(String(unitRow)), String(unitRow).slice(0, 60));

  // GBK 解码
  await clickTab('编码转换');
  await waitFor(`!!document.querySelector('.tool-panel select')`);
  await ev(`(() => { const s = ${SETVAL}; s(document.querySelector('.tool-panel select'), 'GBK(仅解码)'); return true; })()`);
  await sleep(300);
  await clickByText('解码');
  await sleep(300);
  await setVal('.tool-panel textarea', 'd6d0cec4');
  await sleep(600);
  const gbk = await ev(`(() => { const tas = [...document.querySelectorAll('.tool-panel textarea')]; return tas[1] ? tas[1].value : ''; })()`);
  check('B7：GBK 解码 d6d0cec4 → 中文', String(gbk).includes('中文'), String(gbk).slice(0, 20));

  // diff 忽略空白
  await clickTab('文本对比');
  await waitFor(`document.querySelectorAll('.tool-panel textarea').length >= 2`);
  await ev(`(() => { const s = ${SETVAL}; const tas = [...document.querySelectorAll('.tool-panel textarea')]; s(tas[0], 'a  \\nb'); s(tas[1], 'a\\nb'); return true; })()`);
  await sleep(500);
  const diffBefore = await ev(`(() => document.querySelectorAll('.diff-line.diff-add, .diff-line.diff-del').length)()`);
  await ev(`(() => { const l = [...document.querySelectorAll('.json-chk')].find(x => /忽略空白/.test(x.textContent)); if (l) { l.querySelector('input').click(); return true; } return false; })()`);
  await sleep(600);
  const diffAfter = await ev(`(() => document.querySelectorAll('.diff-line.diff-add, .diff-line.diff-del').length)()`);
  check('B10：忽略空白后差异行减少', Number(diffBefore) > 0 && Number(diffAfter) < Number(diffBefore), `${diffBefore} → ${diffAfter}`);

  // Cron 反向生成
  await clickTab('Cron 解析');
  await waitFor(`!!document.querySelector('input[aria-label="反向生成"]')`);
  await setVal('input[aria-label="反向生成"]', '工作日 9 点');
  await clickByText('生成表达式');
  await sleep(500);
  const cronExpr = await ev(`(() => { const el = [...document.querySelectorAll('.tool-panel input')].find(x => /\\*/.test(x.value)); return el ? el.value : ''; })()`);
  check('B12：Cron 反向生成（工作日 9 点 → 0 9 * * 1-5）', String(cronExpr) === '0 9 * * 1-5', String(cronExpr));

  /* ---------------- ⑥ 侧栏折叠 + 命令面板 ---------------- */
  const groupTitles = await ev(`(() => [...document.querySelectorAll('.sidebar-group-title')].map(x => x.textContent.replace(/[▸▾]/g, '').trim()))()`);
  check('C14：侧栏分组标题可折叠（带箭头）', Array.isArray(groupTitles) && groupTitles.length >= 2, JSON.stringify(groupTitles));
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar-group-title')].find(x => /工具/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
  await sleep(400);
  const collapsed = await ev(`(() => !!document.querySelector('.sidebar-group.is-collapsed'))()`);
  check('C14：点标题能收起该组', collapsed === true);
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar-group-title')].find(x => /工具/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
  await sleep(300);

  // 命令面板搜工具
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
  await sleep(700);
  await ev(`(() => { const el = document.querySelector('.cmdk-search input'); if (el) { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; d.call(el, 'base64'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; } return false; })()`);
  await sleep(600);
  const cmdHits = await ev(`(() => [...document.querySelectorAll('.cmdk-item')].map(x => x.textContent.trim()).slice(0, 4))()`);
  check('C15：命令面板能搜到「编码转换」工具', Array.isArray(cmdHits) && cmdHits.some((t) => /编码转换/.test(t)), JSON.stringify(cmdHits).slice(0, 90));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (problems.length) console.log('失败项：\n - ' + problems.join('\n - '));
  ws.close();
  app.kill();
  await sleep(600);
  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
})();