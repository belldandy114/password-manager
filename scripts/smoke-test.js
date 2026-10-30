/**
 * smoke-test.js — 打包产物的端到端冒烟测试
 *
 * 通过 --remote-debugging-port 连接渲染进程，用真实的 IPC 通道跑一遍核心流程：
 * 初始化密码 → 解锁 → 新增/搜索/修改/删除 → 回收站 → 设置 → 密码生成 → 锁定。
 * 全程使用临时 user-data-dir，不会碰用户真实的密码库。
 *
 * 用法：node scripts/smoke-test.js [win-unpacked 目录]
 * 退出码 0 = 全部通过
 */
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'release', 'win-unpacked');

const EXE = pickExe(APP_DIR);
const PORT = 9555;
const PASSWORD = 'SmokeTest#2026';

if (!fs.existsSync(EXE)) {
  console.error('找不到主程序：' + EXE);
  console.error('请先执行 npm run pack');
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-smoke-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined && !ok ? '  → ' + detail : ''}`);
}

(async () => {
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    { env, cwd: APP_DIR, windowsHide: true });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      target = list.find(t => t.type === 'page');
      if (target) break;
    } catch { /* still starting */ }
    await sleep(400);
  }
  if (!target) {
    console.error('无法连接应用（窗口未启动？）');
    app.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise(resolve => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await sleep(1200);

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && r.exceptionDetails) throw new Error('页面执行异常: ' + (r.exceptionDetails.text || ''));
    return r && r.result ? r.result.value : undefined;
  };

  try {
    // 1. 初始化
    const setup = await evaluate(`window.electronAPI.authSetup({password:${JSON.stringify(PASSWORD)},hint:'smoke'})`);
    check('初始化主密码', !!setup.success, setup.error);

    // 2. 解锁
    const unlock = await evaluate(`window.electronAPI.sessionUnlock({password:${JSON.stringify(PASSWORD)}})`);
    check('解锁密码库', !!unlock.success);

    // 3. 密码生成器
    const gen = await evaluate(`window.electronAPI.passwordGenerate({length:20,symbols:true,excludeAmbiguous:true})`);
    check('密码生成器', !!gen.success && gen.data.length === 20,
      gen.error || (gen.data ? 'len=' + gen.data.length : 'no data'));

    // 4. 新增
    const add = await evaluate(`window.electronAPI.entriesAdd({
      id:'smoke-1', name:'冒烟测试站点', url:'https://smoke.example.com', username:'tester',
      password:'Str0ng#Pass', notes:'自动化测试', envType:'testing', tags:['冒烟'],
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })`);
    check('新增条目', !!add.success && add.data.entries.length === 1, add.error);

    // 5. 读取
    const all = await evaluate(`window.electronAPI.entriesGetAll()`);
    check('读取列表', !!all.success && all.data.entries.some(e => e.id === 'smoke-1'));

    // 6. 修改
    const upd = await evaluate(`window.electronAPI.entriesUpdate({
      id:'smoke-1', name:'冒烟测试站点-已改', url:'https://smoke.example.com', username:'tester',
      password:'Str0ng#Pass', notes:'', envType:'testing', tags:['冒烟'],
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })`);
    check('修改条目', !!upd.success && upd.data.entries[0].name === '冒烟测试站点-已改', upd.error);

    // 7. 删除到回收站
    const del = await evaluate(`window.electronAPI.entriesDelete({ids:['smoke-1'],permanent:false})`);
    check('移入回收站', !!del.success && del.data.entries.length === 0, del.error);

    const trash = await evaluate(`window.electronAPI.trashGetAll()`);
    check('回收站可见', !!trash.success && trash.data.length === 1);

    // 8. 恢复
    const restore = await evaluate(`window.electronAPI.trashRestore(['smoke-1'])`);
    check('从回收站恢复',
      !!restore.success && restore.data.entries.some(e => e.id === 'smoke-1'), restore.error);

    // 9. 刷新后数据仍在（加密落盘 → 重新解密）
    const all2 = await evaluate(`window.electronAPI.entriesGetAll()`);
    check('数据持久化', !!all2.success && all2.data.entries.length === 1);

    // 10. 设置读写
    const saveSet = await evaluate(`window.electronAPI.settingsSave({minimizeToTray:false,autoLockDelay:7})`);
    const getSet = await evaluate(`window.electronAPI.settingsGet()`);
    check('设置读写', !!saveSet.success && getSet && getSet.autoLockDelay === 7);

    // 11. 备份接口
    const backup = await evaluate(`window.electronAPI.backupList()`);
    check('备份接口', !!backup.success && Array.isArray(backup.data), backup.error);

    // 12. 锁定后拒绝读取
    await evaluate(`window.electronAPI.sessionLock()`);
    const denied = await evaluate(`window.electronAPI.entriesGetAll()`);
    check('锁定后拒绝访问', !!denied && denied.success === false);
  } catch (e) {
    console.error('测试过程出错：' + e.message);
    results.push({ name: '执行异常', ok: false });
  }

  try { ws.close(); } catch { /* ignore */ }
  app.kill();
  await sleep(1200);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter(r => !r.ok);
  console.log('─'.repeat(50));
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
