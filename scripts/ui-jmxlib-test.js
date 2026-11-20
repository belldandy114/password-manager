/**
 * ui-jmxlib-test.js —— 压力测试「脚本库」回归（开发目录 + PM_USE_DIST=1）
 *
 * 覆盖：目录树读取 → 展开 → 点脚本自动填 JMX 路径/输出目录/线程/循环 →
 *       脚本检查（线程组 / 缺失数据文件）→ 脚本设置弹窗 → 新建文件夹 → 重复导入加 (2) → 无页面异常。
 *
 * 用法：npm run build:renderer && node scripts/ui-jmxlib-test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9801;
const PASSWORD = 'Round4#2026';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const JMX = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.5">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="支付并发">
      <stringProp name="TestPlan.comments">脚本库冒烟</stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="用户">
        <stringProp name="ThreadGroup.num_threads">200</stringProp>
        <stringProp name="ThreadGroup.ramp_time">5</stringProp>
      </ThreadGroup>
      <hashTree>
        <LoopController guiclass="LoopControlPanel" testclass="LoopController" testname="循环">
          <stringProp name="LoopController.loops">30</stringProp>
        </LoopController>
        <hashTree>
          <stringProp name="env">\${__P(env,test)}</stringProp>
          <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="账号">
            <stringProp name="filename">users.csv</stringProp>
          </CSVDataSet>
          <hashTree/>
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-jmxlib-ud-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-jmxlib-data-'));
  const libRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-jmxlib-lib-'));
  fs.mkdirSync(path.join(libRoot, '支付系统'), { recursive: true });
  fs.writeFileSync(path.join(libRoot, '支付系统', '支付-压测.jmx'), JMX, 'utf8');
  // 数据文件预检：只有 3 行，远少于线程数，应该被提示
  fs.writeFileSync(path.join(libRoot, '支付系统', 'users.csv'), 'user,pwd\nu1,p1\nu2,p2\nu3,p3\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'jmxlib.json'), JSON.stringify({
    root: libRoot,
    items: { '支付系统/支付-压测.jmx': { threads: 300, loops: 20, note: '冒烟用', params: { env: 'uat' } } },
  }, null, 2), 'utf8');

  const env = { ...process.env, PM_USE_DIST: '1', PM_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], { env, cwd: ROOT, windowsHide: true });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (target) break;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  if (!target) { console.error('连不上渲染进程'); app.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1400);

  const ev = async (expr) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), new Promise(r2 => setTimeout(() => r2(null), 20000))]);
    if (!r || r.exceptionDetails) { if (r?.exceptionDetails) console.log('  [异常] ' + (r.exceptionDetails.exception?.description || '').slice(0, 200)); return undefined; }
    return r.result ? r.result.value : null;
  };
  const SETVAL = `(el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }`;
  const check = (name, ok, detail) => console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT, '_shots-audit', name), Buffer.from(r.data, 'base64')); };

  // 登录（首次要设置主密码）
  await ev(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return true; })()`);
  await sleep(300);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); if (b) b.click(); return true; })()`);
  await sleep(2400);
  await ev(`(() => { const m = document.querySelector('.modal'); if (!m) return false; const b = [...m.querySelectorAll('button')].find(x => /稍后/.test(x.textContent || '')); if (b) b.click(); return true; })()`);
  await sleep(500);

  await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('压力测试')); if (n) n.click(); return true; })()`);
  await sleep(1600);

  check('压力测试页出现「脚本库」面板', await ev(`!!document.querySelector('.jmxlib')`));
  check('脚本库读到系统文件夹', await ev(`!!document.querySelector('.jmxlib-dir') && document.querySelector('.jmxlib-dir').textContent.includes('支付系统')`), await ev(`document.querySelector('.jmxlib-dir')?.textContent.replace(/\\s+/g,' ').trim()`));

  // 展开 → 点脚本
  await ev(`(() => { const d = Array.from(document.querySelectorAll('.jmxlib-dir')).find(e => e.textContent.includes('支付系统')); if (d) d.click(); return true; })()`);
  await sleep(700);
  check('展开后看到脚本', await ev(`!!document.querySelector('.jmxlib-row')`), await ev(`document.querySelector('.jmxlib-row')?.textContent.replace(/\\s+/g,' ').trim()`));
  // 等页面把记住的输出目录读回来（jmeterDefaults 要探测 Java，比较慢）
  let outInitial = '';
  for (let i = 0; i < 30; i++) {
    outInitial = await ev(`document.querySelector('input[aria-label="输出目录"]')?.value || ''`);
    if (outInitial) break;
    await sleep(300);
  }
  await ev(`(() => { const r = document.querySelector('.jmxlib-row'); if (r) r.click(); return true; })()`);
  await sleep(900);

  const filled = await ev(`(() => ({
    jmx: document.querySelector('input[aria-label="JMX 文件路径"]')?.value || '',
    out: document.querySelector('input[aria-label="输出目录"]')?.value || '',
    threads: document.querySelector('input[aria-label="线程数"]')?.value || '',
    loops: document.querySelector('input[aria-label="循环次数"]')?.value || '',
  }))()`);
  check('点脚本自动填好 JMX 路径', !!filled && filled.jmx.includes('支付-压测.jmx'), filled && filled.jmx);
  // 1.28.2：脚本没存输出目录时不碰用户当前选择（之前会被默认目录冲掉）
  check('脚本没存输出目录时不覆盖当前目录', !!filled && filled.out === outInitial, { outInitial, out: filled && filled.out });
  check('自动带出脚本保存的线程/循环', !!filled && filled.threads === '300' && filled.loops === '20', filled);

  // 1.28.2：脚本自己存了输出目录 → 切到它
  const customOut = path.join(dataDir, '报告A');
  fs.mkdirSync(customOut, { recursive: true });
  await ev(`window.electronAPI.jmxlibMetaSet('支付系统/支付-压测.jmx', { outDir: ${JSON.stringify(customOut)} })`);
  await ev(`(() => { const r = document.querySelector('.jmxlib-row'); if (r) r.click(); return true; })()`);
  await sleep(900);
  const outAfterMeta = await ev(`document.querySelector('input[aria-label="输出目录"]')?.value || ''`);
  check('脚本存了输出目录时自动带出它', String(outAfterMeta).includes('报告A'), outAfterMeta);

  // 脚本检查
  await ev(`(() => { const b = [...document.querySelectorAll('.jmxlib-row button')].find(x => (x.title || '') === '检查脚本'); if (b) b.click(); return true; })()`);
  await sleep(600);
  const notice = await ev(`document.querySelector('.jmxlib-notice')?.textContent.replace(/\\s+/g,' ').trim() || ''`);
  check('脚本检查报出线程组与数据文件行数不足', /线程组/.test(notice) && /只有 4 行/.test(notice), notice);
  await shot('jmxlib-checked.png');

  // 参数面板：脚本里的 ${__P(env,test)} 应该出现在运行配置里，并带出库里存的值 uat
  const paramInputs = await ev(`Array.from(document.querySelectorAll('.perf-param')).map(x => ({
    name: x.querySelector('.perf-param-name')?.textContent || '',
    value: x.querySelector('input')?.value || '',
  }))`);
  check('参数面板列出 __P 参数并带出上次的值', Array.isArray(paramInputs) && paramInputs.some(p => p.name === 'env' && p.value === 'uat'), paramInputs);

  // 脚本设置弹窗
  await ev(`(() => { const b = [...document.querySelectorAll('.jmxlib-row button')].find(x => (x.title || '') === '脚本设置'); if (b) b.click(); return true; })()`);
  await sleep(500);
  const modal = await ev(`(() => { const m = document.querySelector('.modal'); return m ? { title: (m.querySelector('.modal-header')?.textContent || '').trim(), note: m.querySelector('textarea')?.value || '' } : null; })()`);
  check('脚本设置弹窗带出备注', !!modal && modal.note === '冒烟用', modal);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return true; })()`);
  await sleep(300);

  // 新建文件夹 + 重复导入
  const mk = await ev(`window.electronAPI.jmxlibMkdir('', '新系统')`);
  check('新建一级文件夹成功', !!mk && mk.success, mk && (mk.data || mk.error));
  const dup = await ev(`window.electronAPI.jmxlibImport('新系统', ${JSON.stringify([path.join(libRoot, '支付系统', '支付-压测.jmx')])})`);
  const dup2 = await ev(`window.electronAPI.jmxlibImport('新系统', ${JSON.stringify([path.join(libRoot, '支付系统', '支付-压测.jmx')])})`);
  check('同目录重复导入自动加 (2)', !!dup?.success && !!dup2?.success && (dup2.data.imported[0] || '').includes('(2)'), dup2 && dup2.data.imported);

  // 1.28.1：导入到根目录的脚本必须出现在列表里（之前只渲染目录里的，根目录脚本"导入成功但看不见"）
  const rootJmx = path.join(libRoot, '根目录脚本.jmx');
  fs.writeFileSync(rootJmx, JMX, 'utf8');
  await ev(`window.electronAPI.jmxlibImport('', ${JSON.stringify([rootJmx])})`);
  // 原生对话框没法自动化：导入后发刷新事件（等价于界面上点「导入脚本」完成后的刷新）
  await ev(`window.dispatchEvent(new Event('pm:jmxlib-refresh'))`);
  await sleep(800);
  const rootShown = await ev(`Array.from(document.querySelectorAll('.jmxlib-row .jmxlib-name')).map(e => e.textContent)`);
  check('导入到根目录的脚本能在列表里看到', Array.isArray(rootShown) && rootShown.some(n => n.includes('根目录脚本')), rootShown);

  // 环境两行都必须是单行（value 与按钮同一行）
  const envRows = await ev(`Array.from(document.querySelectorAll('.perf-env-row')).map(r => ({ h: Math.round(r.getBoundingClientRect().height), display: getComputedStyle(r).display, value: r.querySelector('.perf-env-value')?.getBoundingClientRect().top, btn: r.querySelector('button')?.getBoundingClientRect().top }))`);
  check('环境每行都是单行（高度 < 44 且值/按钮同一行）', Array.isArray(envRows) && envRows.length >= 2 && envRows.every(r => r.h < 44 && Math.abs((r.value || 0) - (r.btn || 0)) < 12), envRows);

  // 历史只保留一份：页签已移除
  check('历史记录页签已移除（只保留运行历史）', await ev(`document.querySelectorAll('.perf-tab').length === 0`));

  // 点另一个脚本要更新 JMX 路径（之前会停留在上一次运行用的脚本）
  await ev(`(() => { const r = Array.from(document.querySelectorAll('.jmxlib-row')).find(e => e.textContent.includes('根目录脚本')); if (r) r.click(); return true; })()`);
  await sleep(900);
  const pickedJmx = await ev(`document.querySelector('input[aria-label="JMX 文件路径"]')?.value || ''`);
  const pickedOut = await ev(`document.querySelector('input[aria-label="输出目录"]')?.value || ''`);
  check('点另一个脚本会更新 JMX 路径', String(pickedJmx).includes('根目录脚本'), pickedJmx);
  check('换脚本时保留已选的输出目录', String(pickedOut).includes('报告A'), pickedOut);

  // 模板新建：生成一个最小 HTTP 脚本，并且能被检查器读回来
  const tpl = await ev(`window.electronAPI.jmxlibCreateTemplate('', { name: '模板脚本', url: 'https://example.com/api/x', threads: 20, loops: 2 })`);
  check('模板新建生成 .jmx', !!tpl && tpl.success && String(tpl.data.name).endsWith('.jmx'), tpl && (tpl.data || tpl.error));
  const tplVal = tpl?.success ? await ev(`window.electronAPI.jmxlibValidate(${JSON.stringify(tpl.data.rel)})`) : null;
  check('模板脚本可被检查（含 threads/loops 参数）', !!tplVal?.success && tplVal.data.ok && tplVal.data.params.map(p => p.name).sort().join(',') === 'loops,threads', tplVal && tplVal.data && tplVal.data.params);

  // 历史趋势：写入两次运行记录，脚本设置的弹窗里应该出现走势图
  await ev(`window.electronAPI.jmxlibMarkRun('支付系统/支付-压测.jmx', { ok: true, durationMs: 10000, stats: { samples: 5000, errors: 0, errorPct: 0, avg: 120 } })`);
  await ev(`window.electronAPI.jmxlibMarkRun('支付系统/支付-压测.jmx', { ok: false, durationMs: 8000, stats: { samples: 4000, errors: 240, errorPct: 6, avg: 900 } })`);
  const cfgDbg = await ev(`window.electronAPI.jmxlibConfig()`);
  await ev(`(() => { const b = [...document.querySelectorAll('.jmxlib-row button')].find(x => (x.title || '') === '脚本设置'); if (b) b.click(); return true; })()`);
  await sleep(900);
  const trend = await ev(`(() => {
    const t = document.querySelector('.jmxlib-trend');
    const m = document.querySelector('.modal');
    if (!t) return { noTrend: true, modal: m ? (m.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : 'no-modal' };
    return { legend: t.querySelector('.jmxlib-trend-legend')?.textContent.replace(/\\s+/g, ' ').trim() || '', dots: t.querySelectorAll('.jmxlib-trend-dot').length, files: document.querySelectorAll('.jmxlib-file').length };
  })()`);
  check('脚本设置里出现运行趋势与数据文件预检', !!trend && trend.dots >= 2 && /TPS/.test(trend.legend) && trend.files >= 1, trend);
  await shot('jmxlib-settings.png');
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return true; })()`);
  await sleep(300);

  // 模态在视口中央（1.27.0 修：不能再被页面 transform 带到页面底部）
  await ev(`(() => { const b = [...document.querySelectorAll('.jmxlib-bar button')].find(x => x.textContent.includes('新建文件夹')); if (b) b.click(); return true; })()`);
  await sleep(500);
  const center = await ev(`(() => {
    const ov = document.querySelector('.modal-overlay');
    if (!ov) return null;
    const r = ov.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), vw: window.innerWidth };
  })()`);
  check('弹窗遮罩覆盖整个视口（不再偏移）', !!center && center.top === 0 && center.left === 0 && center.w === center.vw, center);
  await ev(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.trim() === '取消'); if (b) b.click(); return true; })()`);
  await sleep(300);

  check('无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  try { app.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 400);
})();









