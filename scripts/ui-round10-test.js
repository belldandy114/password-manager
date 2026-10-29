/**
 * ui-round10-test.js —— JMeter 压力测试页的端到端回归。
 *
 * 为什么用「假 JMeter」：CI 和大多数开发机没有装 JMeter + JDK，
 * 但我们要验证的是「参数拼装 → 子进程 → 流式日志 → 结果解析 → 文件落盘」这条链路。
 * 所以造一个 .cmd → node 的假 jmeter：它按真实 JMeter 的约定写 jtl、建报告、打印 summary。
 *
 * 覆盖：
 *   1) 页面能进、四块面板在；
 *   2) run → 控制台行流式出现在界面上（含回显的命令行）；
 *   3) 退出后解析出统计（样本/错误率/响应时间），jtl 与 HTML 报告真的落盘；
 *   4) report 模式的报告目录是新建的空目录（JMeter -o 的硬要求）；
 *   5) stop：长时间任务能被杀掉并回报结束。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = path.join(APP_DIR, '测试工具.exe');
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9811;
const PW = 'Round10#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/** 造假 JMeter：.cmd 转调 node，node 里按 JMeter 的约定做事 */
function makeFakeJmeter(dir) {
  const js = path.join(dir, 'fake-jmeter.js');
  const cmd = path.join(dir, 'fake-jmeter.cmd');
  fs.writeFileSync(js, `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const jtl = get('-l');
const reportDir = get('-o');
const threads = (argv.find(a => a.startsWith('-Jthreads=')) || '').split('=')[1] || '';
const loops = (argv.find(a => a.startsWith('-Jloops=')) || '').split('=')[1] || '';

const log = (s) => process.stdout.write(s + '\\n');
log('Creating summariser <summary(200 in 00:00:06 = 33.3/s Avg: 120 Min: 90 Max: 300 Err: 2 (1.00%))>' + '');
log('Created the tree successfully using ' + get('-t'));
log('Starting standalone test @ ' + new Date().toISOString());
if (threads) log('Overriding threads=' + threads);
if (loops) log('Overriding loops=' + loops);

const header = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';
const rows = [
  '1000,100,登录,200,OK,TG 1-1,text,true,,,1,0,1,1,http://h/login,95,0,3',
  '1100,120,登录,200,OK,TG 1-1,text,true,,,1,0,1,1,http://h/login,115,0,3',
  '1200,300,查询,500,ERR,TG 1-1,text,false,,,1,0,1,1,http://h/list,295,0,3',
  '1300,90,查询,200,OK,TG 1-1,text,true,,,1,0,1,1,http://h/list,85,0,3',
  '1400,110,查询,200,OK,TG 1-1,text,true,,,1,0,1,1,http://h/list,105,0,3',
];
if (jtl) { fs.mkdirSync(path.dirname(jtl), { recursive: true }); fs.writeFileSync(jtl, [header, ...rows].join('\\n') + '\\n'); }
if (reportDir) {
  fs.mkdirSync(path.join(reportDir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'index.html'), '<html><body>fake report</body></html>');
}
log('summary =      5 in 00:00:00 =   20.0/s Avg:   144 Min:    90 Max:   300 Err: 1 (20.00%)');
// 中文 Windows 上 cmd 输出是 GBK：这一行按 GBK 编码「请按任意键继续. . .」\nprocess.stdout.write(Buffer.from([0xC7,0xEB,0xB0,0xB4,0xC8,0xCE,0xD2,0xE2,0xBC,0xFC,0xBC,0xCC,0xD0,0xF8,0x2E,0x20,0x2E,0x20,0x2E]));\nprocess.stdout.write("\\n");\nlog('... end of run');
process.exit(0);
`, 'utf8');
  fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0fake-jmeter.js" %*\r\n`, 'utf8');

  const jmx = path.join(dir, 'fake-plan.jmx');
  fs.writeFileSync(jmx, '<?xml version="1.0" encoding="UTF-8"?><jmeterTestPlan version="1.2"/>', 'utf8');
  return { exe: cmd, jmx, outDir: dir };
}

/** 造一个「跑很久」的假 JMeter，用来验证 stop 能杀掉 */
/** 假 JDK：bin\\java.cmd 能跑 `-version` 并返回 0（回归机不一定装了 JDK） */
function makeFakeJdk(dir) {
  const home = path.join(dir, 'fake-jdk');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'bin', 'java.cmd'),
    [
      '@echo off',
      'echo openjdk version "17.0.9" 2023-10-17',
      'exit /b 0',
    ].join('\r\n') + '\r\n',
    'utf8',
  );
  return home;
}
function makeSlowJmeter(dir) {
  const js = path.join(dir, 'slow-jmeter.js');
  const cmd = path.join(dir, 'slow-jmeter.cmd');
  fs.writeFileSync(js, `
process.stdout.write('starting slow run\\n');
setInterval(() => process.stdout.write('still running...\\n'), 400);
setTimeout(() => { process.stdout.write('done\\n'); process.exit(0); }, 30000);
`, 'utf8');
  fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0slow-jmeter.js" %*\r\n`, 'utf8');
  return cmd;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r10-'));
  const fake = makeFakeJmeter(tmp);
  const fakeJdk = makeFakeJdk(tmp);
  const slowExe = makeSlowJmeter(tmp);
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r10-ud-'));
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
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
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
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    for (let i = 0; i < 40; i++) {
      if (await ev(`(() => !document.querySelector('.page-loading') && !!document.querySelector('.pg'))()`)) break;
      await sleep(100);
    }
    await sleep(400);
  };

  // 首次启动：设置主密码
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /创建|下一步|开始/.test(x.textContent)); if (b) b.click(); return true; })()`);
  await sleep(1200);
  for (let i = 0; i < 30; i++) {
    if (await ev(`(() => !!document.querySelector('.nav-item'))()`)) break;
    await sleep(300);
  }

  /* ================= 1. 页面结构 ================= */
  await navTo('压力测试');
  const title = await ev(`(() => { const t = document.querySelector('.pg-title'); return t ? t.textContent.trim() : ''; })()`);
  const panels = await ev(`[...document.querySelectorAll('.pnl-title')].map(x => x.textContent.trim())`);
  check('压力测试：页面能打开', /压力/.test(String(title)), String(title));

  // 1.7.4 的 bug：.pg 纵向 flex 把面板压到比内容还矮，内容被 overflow:hidden 裁掉。
  // 这条断言专门盯「面板高度 ≥ 内容高度」，防止再犯。
  const layout = await ev(`(() => {
    const H = (el) => el ? Math.round(el.getBoundingClientRect().height) : -1;
    const wrap = document.querySelector(".perf-page");
    const clipped = [...document.querySelectorAll(".perf-page .pnl")].filter(p => {
      const b = p.querySelector(".pnl-body");
      return b && b.scrollHeight > H(b) + 1;
    }).length;
    return {
      wrapper: !!wrap,
      clipped,
      inputs: document.querySelectorAll(".perf-form input").length,
      modeItems: document.querySelectorAll(".perf-mode-item").length,
      headButtons: [...document.querySelectorAll(".pg-head button")].map(b => b.textContent.trim()).join("|"),
      scrollable: wrap ? wrap.scrollHeight > wrap.clientHeight : false,
      threadsVisible: (() => { const el = [...document.querySelectorAll(".perf-form input")].find(i => i.placeholder === "如 50"); return el ? H(el) > 0 : false; })(),
    };
  })()`);
  check('压力测试：面板没有被裁切（高度 ≥ 内容）', !!layout && layout.clipped === 0, `clipped=${layout && layout.clipped}`);
  check('压力测试：运行配置控件齐全（≥7 输入 / 2 个输出模式 / 线程数可见）',
    !!layout && layout.inputs >= 7 && layout.modeItems === 2 && layout.threadsVisible === true,
    layout && JSON.stringify([layout.inputs, layout.modeItems, layout.threadsVisible]));
  check('压力测试：头部有「重新探测 + 开始运行」',
    !!layout && /探测/.test(String(layout.headButtons)) && /开始运行/.test(String(layout.headButtons)),
    layout && layout.headButtons);
  check('压力测试：内容区可滚动（不是把面板压扁）', !!layout && layout.scrollable === true);
  check('压力测试：四块面板都在（环境/运行配置/运行输出）',
    Array.isArray(panels) && panels.some(p => /环境/.test(p)) && panels.some(p => /运行配置/.test(p)) && panels.some(p => /运行输出/.test(p)),
    JSON.stringify(panels));

  /* ================= 2. 运行 + 流式日志 ================= */
  const runRes = await ev(`(async () => {
    return await window.electronAPI.jmeterRun({
      jmeterPath: ${JSON.stringify(fake.exe)},
      javaHome: ${JSON.stringify(fakeJdk)},
      jmxPath: ${JSON.stringify(fake.jmx)},
      mode: 'report',
      outDir: ${JSON.stringify(fake.outDir)},
      threads: 50,
      loops: 10,
    });
  })()`);
  check('压力测试：run 接口返回成功', !!runRes && runRes.success === true, runRes && (runRes.error || ''));

  // 等 done（页面的监听器负责渲染，这里同时读 DOM 与 IPC 结果）
  let done = null;
  for (let i = 0; i < 60; i++) {
    const st = await ev(`window.electronAPI.jmeterStatus().then(x => JSON.stringify(x))`);
    if (!st || JSON.parse(st).data === null) {
      done = await ev(`(() => { const el = document.querySelector('.perf-stats'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
      if (done) break;
    }
    await sleep(300);
  }

  const logLines = await ev(`[...document.querySelectorAll('.perf-line')].map(x => x.textContent).join('\\n')`);
  check('压力测试：命令回显了（能看到实际执行的参数）', /-Jthreads=50/.test(String(logLines)) && /-e/.test(String(logLines)), String(logLines).slice(0, 80));
  check('压力测试：JMeter 输出流式显示在界面上', /Starting standalone test/.test(String(logLines)), String(logLines).slice(0, 60));
  check('压力测试：GBK 输出被正确解码（不再是乱码）',
    /请按任意键继续/.test(String(logLines)) && !/맜|\uFFFD/.test(String(logLines)),
    String(logLines).slice(-40).replace(/\n/g, ' '));
  check('压力测试：日志里说明了使用的 JAVA_HOME', /\[env\] JAVA_HOME=/.test(String(logLines)),
    (String(logLines).match(/\[env\][^\n]*/) || [''])[0]);
  check('压力测试：结果区出现统计', /样本数/.test(String(done)) && /错误率|TPS/.test(String(done)), String(done).slice(0, 120));

  const stats = await ev(`(() => {
    const nums = [...document.querySelectorAll('.perf-stat b')].map(x => x.textContent.trim());
    return nums.join('|');
  })()`);
  check('压力测试：统计值解析正确（样本 5、错误 1）', /^5\|/.test(String(stats)) && /1/.test(String(stats)), String(stats));

  /* ================= 3. 文件真的落盘 ================= */
  const files = await ev(`window.electronAPI.jmeterStatus().then(x => JSON.stringify(x))`);
  const jtlFiles = fs.readdirSync(fake.outDir).filter(f => f.endsWith('.jtl'));
  check('压力测试：jtl 结果文件已生成', jtlFiles.length === 1, jtlFiles.join(','));
  const reportDirs = fs.readdirSync(fake.outDir).filter(f => f.startsWith('report-'));
  const hasIndex = reportDirs.length === 1 && fs.existsSync(path.join(fake.outDir, reportDirs[0], 'index.html'));
  check('压力测试：HTML 报告目录已生成且有 index.html', hasIndex, reportDirs.join(','));
  const logFiles = fs.readdirSync(fake.outDir).filter(f => f === 'jmeter-' + '' || /^jmeter-\d+\.log$/.test(f));
  check('压力测试：完整运行日志已落盘', logFiles.length === 1, logFiles.join(','));

  const jtlText = fs.readFileSync(path.join(fake.outDir, jtlFiles[0]), 'utf8');
  check('压力测试：jtl 是假 JMeter 写的那份（5 行样本）', jtlText.split('\n').filter(Boolean).length === 6);

  /* ================= 4. report 模式要求空目录 ================= */
  const freshOut = path.join(tmp, 'out2');
  fs.mkdirSync(freshOut, { recursive: true });
  const run2 = await ev(`(async () => {
    return await window.electronAPI.jmeterRun({
      jmeterPath: ${JSON.stringify(fake.exe)},
      javaHome: ${JSON.stringify(fakeJdk)},
      jmxPath: ${JSON.stringify(fake.jmx)},
      mode: 'report',
      outDir: ${JSON.stringify(freshOut)},
    });
  })()`);
  check('压力测试：连续运行不会撞「报告目录非空」', !!run2 && run2.success === true, run2 && (run2.error || ''));

  /* ================= 5. stop 杀掉长任务 ================= */
  for (let i = 0; i < 40; i++) {
    const st = await ev(`window.electronAPI.jmeterStatus().then(x => JSON.stringify(x))`);
    if (JSON.parse(st).data === null) break;
    await sleep(300);
  }
  const run3 = await ev(`(async () => {
    return await window.electronAPI.jmeterRun({
      jmeterPath: ${JSON.stringify(slowExe)},
      javaHome: ${JSON.stringify(fakeJdk)},
      jmxPath: ${JSON.stringify(fake.jmx)},
      mode: 'log',
      outDir: ${JSON.stringify(freshOut)},
    });
  })()`);
  await sleep(1200);
  const runningHead = await ev(`[...document.querySelectorAll('.pg-head button')].map(b => b.textContent.trim()).join('|')`);
  check('压力测试：运行中头部出现「停止运行」', /停止运行/.test(String(runningHead)), String(runningHead));
  const stopRes = await ev(`window.electronAPI.jmeterStop()`);
  check('压力测试：stop 能停掉正在运行的任务', !!run3 && run3.success === true && !!stopRes && stopRes.success === true,
    JSON.stringify([run3 && run3.success, stopRes && stopRes.error]));

  let ended = false;
  for (let i = 0; i < 40; i++) {
    const st = await ev(`window.electronAPI.jmeterStatus().then(x => JSON.stringify(x))`);
    if (JSON.parse(st).data === null) { ended = true; break; }
    await sleep(300);
  }
  check('压力测试：停止后运行状态被清空', ended === true);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch((e) => {
  console.log('ERR', e && e.message);
  process.exit(1);
});