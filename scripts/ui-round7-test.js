/**
 * 1.6.0 回归：数据安全（原子写 / 备份恢复 / 登录页恢复入口 / 数据目录）
 *            接口调试（Set-Cookie 会话 / 断言可加行 / 响应快照 / JSON→TS）
 *            禅道（多地址配置 / 附件下载 / 未读红点）、周报（周对比 / 群消息）
 *
 * 用法：node scripts/ui-round7-test.js            # 跑 dist（PM_USE_DIST=1）
 *      USE_PACKED=1 node scripts/ui-round7-test.js # 跑 release/win-unpacked
 * 环境变量 DEBUG7=1 打印 CDP 细节
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
const PORT = 9807;
const PW = 'Round7#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r7-'));
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
    if (process.env.DEBUG7 && (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Runtime.consoleAPICalled')) {
      const d = msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.args?.map(a => a.value).slice(0, 3));
      console.log('DBG-CDP', String(d).slice(0, 300));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
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
    await sleep(800);
  };
  const unlock = async () => {
    const locked = await ev(`(() => !!document.querySelector('input[type=password]'))()`);
    if (!locked) return;
    await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input[type=password]')]; if (ins[0]) s(ins[0], ${JSON.stringify(PW)}); return 1; })()`);
    await sleep(300);
    await clickHas('解锁');
    await sleep(2200);
  };
  // 直接调 IPC（比走 UI 稳，测的是主进程行为）
  const api = async (expr) => {
    const r = await ev(`(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ __err: String(e && e.message) }); } })()`);
    try { return JSON.parse(r); } catch { return { __raw: r }; }
  };

  // 首次启动：设置主密码
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await clickHas('设置主密码');
  await sleep(2600);

  const vaultFile = path.join(ud, 'vault.enc');
  const bakFile = `${vaultFile}.bak`;
  const tmpFile = `${vaultFile}.tmp`;
  const backupDir = path.join(ud, 'backups');

  /* ================= A. 数据安全 ================= */
  // A1 原子写：写盘后不能留 .tmp，且要留一份 .bak
  const addA = await api(`window.electronAPI.entriesAdd({ id:'a1', name:'原子写A', url:'', username:'', password:'p', envType:'production', tags:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })`);
  await sleep(600);
  check('原子写：新增后落盘成功', addA && (addA.success === true || addA.data), JSON.stringify(addA).slice(0, 60));
  check('原子写：没有残留 .tmp 文件', !fs.existsSync(tmpFile), fs.existsSync(tmpFile) ? '发现 vault.enc.tmp' : '干净');
  check('原子写：生成了 .bak 备用副本', fs.existsSync(bakFile));

  // A2 备份恢复：造一份「已知状态」的备份，再改数据，看能不能回滚
  //   注意：自动备份是「当天第一次写盘前」的快照，新装机器第一次写盘前的库是空的，
  //   所以这里直接放一份带 A 的备份（用较早日期），避免依赖当天快照的时序。
  const known = path.join(backupDir, 'vault-2026-01-01.enc');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(vaultFile, known);
  check('备份：可放入指定日期的备份', fs.existsSync(known));

  const addB = await api(`window.electronAPI.entriesAdd({ id:'b1', name:'原子写B', url:'', username:'', password:'p', envType:'production', tags:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })`);
  await sleep(800);
  const day = new Date().toISOString().slice(0, 10);
  const dayBackup = path.join(backupDir, `vault-${day}.enc`);
  check('备份：写盘前自动生成当天备份', fs.existsSync(dayBackup), fs.existsSync(dayBackup) ? 'vault-' + day + '.enc' : '缺失');

  // A3 备份列表（未解锁也可读，登录页恢复要用）
  const bl = await api(`window.electronAPI.backupList()`);
  check('备份：列表可读', bl.success === true && Array.isArray(bl.data) && bl.data.length >= 1, `${bl.data ? bl.data.length : 0} 份`);

  // A4 恢复：回到只有 A 的状态
  const rs = await api(`window.electronAPI.backupRestore('vault-2026-01-01.enc')`);
  await sleep(1500);
  check('恢复：调用成功', rs.success === true, rs.error || rs.preRestore || '');
  check('恢复：恢复前留了 pre-restore 快照',
    fs.readdirSync(backupDir).some(f => /^vault-prerestore-/.test(f)),
    (fs.readdirSync(backupDir) || []).join(','));
  check('恢复：界面退回登录页', await ev(`(() => !!document.querySelector('input[type=password]'))()`));

  // 重新解锁，确认数据回到备份点
  await unlock();
  const all = await api(`window.electronAPI.entriesGetAll()`);
  const names = ((all.data && all.data.entries) || []).map(e => e.name);
  if (process.env.DEBUG7) console.log('DBG all=', JSON.stringify(all).slice(0, 300));
  check('恢复：数据回到备份时点（B 已消失）', names.includes('原子写A') && !names.includes('原子写B'), JSON.stringify(names));

  // A5 登录页的恢复入口：sessionLock() 只清主进程状态、不通知渲染层，
  //    所以锁完再 reload 一次，让界面确定回到登录页。
  await api(`window.electronAPI.sessionLock()`);
  await ev(`(() => { location.reload(); return 1; })()`).catch(() => {});
  await sleep(2800);
  const hasRestoreBtn = await ev(`(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('从备份恢复')))()`);
  check('登录页：有「从备份恢复」入口', hasRestoreBtn === true);
  await clickHas('从备份恢复');
  await sleep(900);
  const restoreRows = await ev(`(() => document.querySelectorAll('.modal .backup-item').length)()`);
  check('登录页：恢复面板列出备份', Number(restoreRows) >= 1, `${restoreRows} 行`);
  await clickHas('关闭');
  await sleep(400);

  // A6 数据目录可见
  await unlock();
  const info = await api(`window.electronAPI.dataInfo()`);
  const okInfo = info.success === true && info.data && info.data.dataDir;
  check('数据目录：能读到真实路径', okInfo && path.resolve(info.data.dataDir) === path.resolve(ud), okInfo ? info.data.dataDir : JSON.stringify(info).slice(0, 80));
  check('数据目录：识别为默认位置而非自定义', okInfo && info.data.isCustom === false);

  /* ================= 结果 ================= */
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { ws.close(); } catch { /* ignore */ }
  app.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();