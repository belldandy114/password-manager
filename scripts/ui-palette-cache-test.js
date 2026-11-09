'use strict';

/**
 * ui-palette-cache-test.js —— 锁住快速搜索小窗的「按版本号复用」逻辑。
 *
 * 背景：小窗每次弹出都要拼一份命令列表（页面/工具/网址/片段/笔记/账号/请求/用例/环境，
 * 上限约 1,600 条）。改成「先问主进程的 vaultEpoch，没变就复用上一次结果」后，
 * 最怕两件事，这里就是这两条断言：
 *   1. 新增条目后版本号必须变 → 再搜必须能搜到（否则用户刚存的网址搜不出来）；
 *   2. 锁定后版本号必须变 → 小窗必须切回「未解锁」，而不是还显示旧列表。
 *
 *   node scripts/ui-palette-cache-test.js
 *
 * 需要先 `npm run build:renderer`（脚本用 PM_USE_DIST=1 跑构建产物）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9733;
const PW = 'Palette#2026';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0; let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/** 连一个 CDP target，返回 { ev, close } */
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('  EX ' + String(r.exceptionDetails.exception?.description || '').slice(0, 160));
    return r.result?.value;
  };
  return { ev, close: () => { try { ws.close(); } catch { /* 忽略 */ } } };
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

/** 在小窗里输入查询并读取结果行 */
const queryPalette = async (pal, text) => {
  await pal.ev(`(() => {
    const el = document.querySelector('.cmdk-search input');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  return pal.ev(`(() => ({
    items: [...document.querySelectorAll('.cmdk-item')].map(x => x.querySelector('.cmdk-title')?.textContent || ''),
    empty: (document.querySelector('.cmdk-empty') || {}).textContent || '',
    cardH: Math.round((document.querySelector('.cmdk') || {}).getBoundingClientRect?.().height || 0),
  }))()`);
};

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-palcache-'));
  const env = { ...process.env, PM_USE_DIST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = spawn(EXE, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`],
    { env, cwd: ROOT, windowsHide: true });
  app.stderr.on('data', () => { /* 忽略 GPU 噪声 */ });

  const mainTarget = await findTarget(t => !String(t.url || '').includes('window=palette'));
  if (!mainTarget) { console.log('✗ 应用未启动'); app.kill(); process.exit(1); }
  const main = await attach(mainTarget);
  await sleep(1800);

  // 首次启动：设置主密码
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

  // ---- 1. 第一次弹出：搜不到不存在的词 ----
  // 注意：主进程只在小窗「从隐藏变为显示」时才发 palette:refresh（已显示时只 focus），
  // 所以每次重开都要先 hide，否则测的是「窗口一直开着」而不是「重新弹出」。
  const showPalette = async () => {
    await main.ev(`window.electronAPI.paletteHide()`);
    await sleep(350);
    await main.ev(`window.electronAPI.paletteShow()`);
    const t = await findTarget(x => String(x.url || '').includes('window=palette'), 40);
    if (!t) return null;
    if (!palTarget || palTarget.webSocketDebuggerUrl !== t.webSocketDebuggerUrl) {
      pal && pal.close();
      palTarget = t;
      pal = await attach(t);
    }
    await sleep(900);
    return t;
  };

  let palTarget = null;
  let pal = null;
  check('小窗已弹出（window=palette）', !!(await showPalette()));
  if (!palTarget) { app.kill(); process.exit(1); }

  const r1 = await queryPalette(pal, 'ZZCACHE');
  check('小窗能正常查询（未命中显示「没有匹配项」）',
    Array.isArray(r1 && r1.items) && r1.items.length === 0 && /没有匹配项/.test(String(r1.empty)),
    r1 && String(r1.empty).slice(0, 40));
  const epochBefore = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).epoch)()`);
  const loadMode = () => pal.ev(`document.documentElement.dataset.paletteLoad || ''`);

  // ---- 1b. 数据没变：再次弹出必须命中缓存（不再取 7 类数据） ----
  await showPalette();
  check('数据未变更时再次弹出命中缓存（不重复取数）', (await loadMode()) === 'cache', await loadMode());

  // ---- 2. 新增条目：版本号必须变，再搜必须能搜到 ----
  const added = await main.ev(`(async () => {
    const r = await window.electronAPI.entriesAdd({
      id: 'zzcache-' + Date.now(), name: 'ZZCACHE条目', username: 'u', password: 'p',
      url: 'https://zzcache.example.com', note: '', tags: [], updatedAt: new Date().toISOString(),
    });
    return !!r && r.success;
  })()`);
  check('准备：新增一条网址成功', added === true);

  const epochAfter = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).epoch)()`);
  check('新增后数据版本号递增（缓存会失效）', epochAfter > epochBefore, `${epochBefore} → ${epochAfter}`);

  await showPalette();
  check('数据变更后改为全量重取（缓存已失效）', (await loadMode()) === 'full', await loadMode());
  const r2 = await queryPalette(pal, 'ZZCACHE');
  check('新增后再次弹出能搜到新条目（不是复用了旧缓存）',
    Array.isArray(r2 && r2.items) && r2.items.some(t => String(t).includes('ZZCACHE')),
    r2 && (r2.items || []).join(' | ').slice(0, 60));

  // ---- 3. 锁定：版本号必须变；小窗不得再露旧数据 ----
  await main.ev(`window.electronAPI.sessionLock()`);
  await sleep(300);
  const epochLocked = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).epoch)()`);
  check('锁定后数据版本号递增', epochLocked > epochAfter, `${epochAfter} → ${epochLocked}`);

  // 设计上「锁定状态下按搜索键」不出小窗，而是把主窗口拉出来解锁（palette:show → locked）
  const showLocked = await main.ev(`(async () => await window.electronAPI.paletteShow())()`);
  check('锁定后按搜索键不出小窗，交给主窗口解锁',
    !!showLocked && showLocked.error === 'locked', JSON.stringify(showLocked));

  // 小窗里的「未解锁」分支靠重新加载来触发（隐藏窗口不发 palette:refresh，但挂载时仍会取数）
  await pal.ev(`location.reload()`);
  await sleep(1800);
  const r3 = await queryPalette(pal, 'ZZCACHE');
  check('锁定后小窗显示「未解锁」而不是旧列表',
    /还没解锁/.test(String(r3 && r3.empty)) && (r3.items || []).length === 0,
    r3 && String(r3.empty).replace(/\s+/g, ' ').slice(0, 40));

  const lockedFlag = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).unlocked)()`);
  check('palette:epoch 同时回传解锁状态', lockedFlag === false);

  pal.close();
  main.close();
  app.kill();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常：' + e.message); process.exit(1); });
