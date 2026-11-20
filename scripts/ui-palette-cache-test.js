'use strict';

/**
 * ui-palette-cache-test.js —— 锁住快速搜索小窗的「按版本号复用」逻辑（已迁移到 lib/{cdp,app}；12 条断言与迁移前一致）。
 * 背景：小窗每次弹出都要拼一份命令列表（页面/工具/网址/片段/笔记/账号/请求/用例/环境，上限约 1,600 条）。
 * 改成「先问主进程的 vaultEpoch，没变就复用上一次结果」后，最怕两件事，这里就是这两条断言：
 *   1. 新增条目后版本号必须变 → 再搜必须能搜到（否则用户刚存的网址搜不出来）；2. 锁定后版本号必须变 →
 * 小窗必须切回「未解锁」，而不是还显示旧列表。主密码由 lib/app.js 每次随机生成（或 PM_TEST_PASSWORD 指定）。
 * 跑法：node scripts/ui-palette-cache-test.js（先 npm run build:renderer；USE_PACKED=1 跑打包版）。
 */
const { launch, waitForWindow, ensureUnlocked, prepareDataDir, stop } = require('./lib/app');
const { attach, waitForTarget, sleep } = require('./lib/cdp');
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); } else { fail += 1; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};
/** 在小窗里输入查询并读取结果行 */
const queryPalette = async (pal, text) => {
  await pal.ev(`(() => { const el = document.querySelector('.cmdk-search input'); if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(500);
  return pal.ev(`(() => ({
    items: [...document.querySelectorAll('.cmdk-item')].map(x => x.querySelector('.cmdk-title')?.textContent || ''),
    empty: (document.querySelector('.cmdk-empty') || {}).textContent || '',
    cardH: Math.round((document.querySelector('.cmdk') || {}).getBoundingClientRect?.().height || 0) }))()`);
};

(async () => {
  const { dataDir } = prepareDataDir({ prefix: 'pm-palcache-' });
  const handle = await launch({ port: 9733, dataDir });
  const main = await waitForWindow(handle);
  let pal = null;
  let palTarget = null;
  try {
    await ensureUnlocked(main);
    check('准备：密码库已解锁', (await main.ev(`(async () => (await window.electronAPI.sessionIsUnlocked()).unlocked)()`)) === true);

    // ---- 1. 第一次弹出：搜不到不存在的词 ----
    // 注意：主进程只在小窗「从隐藏变为显示」时才发 palette:refresh（已显示时只 focus），
    // 所以每次重开都要先 hide，否则测的是「窗口一直开着」而不是「重新弹出」。
    const showPalette = async () => {
      await main.ev(`window.electronAPI.paletteHide()`);
      await sleep(350);
      await main.ev(`window.electronAPI.paletteShow()`);
      const t = await waitForTarget(handle.port, (x) => String(x.url || '').includes('window=palette'), { timeout: 12000 });
      if (!t) return null;
      if (!palTarget || palTarget.webSocketDebuggerUrl !== t.webSocketDebuggerUrl) { if (pal) pal.close(); palTarget = t; pal = await attach(t); }
      await sleep(900);
      return t;
    };

    check('小窗已弹出（window=palette）', !!(await showPalette()));
    if (!palTarget) { stop(handle); process.exit(1); }
    const r1 = await queryPalette(pal, 'ZZCACHE');
    check('小窗能正常查询（未命中显示「没有匹配项」）', Array.isArray(r1 && r1.items) && r1.items.length === 0 && /没有匹配项/.test(String(r1.empty)), r1 && String(r1.empty).slice(0, 40));
    const epochBefore = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).epoch)()`);
    const loadMode = () => pal.ev(`document.documentElement.dataset.paletteLoad || ''`);

    // ---- 1b. 数据没变：再次弹出必须命中缓存（不再取 7 类数据） ----
    await showPalette();
    check('数据未变更时再次弹出命中缓存（不重复取数）', (await loadMode()) === 'cache', await loadMode());

    // ---- 2. 新增条目：版本号必须变，再搜必须能搜到 ----
    const added = await main.ev(`(async () => {
      const r = await window.electronAPI.entriesAdd({ id: 'zzcache-' + Date.now(), name: 'ZZCACHE条目', username: 'zzcache-user',
        url: 'https://zzcache.example.com', note: '', tags: [], updatedAt: new Date().toISOString() });
      return !!r && r.success; })()`);
    check('准备：新增一条网址成功', added === true);
    const epochAfter = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).epoch)()`);
    check('新增后数据版本号递增（缓存会失效）', epochAfter > epochBefore, `${epochBefore} → ${epochAfter}`);
    await showPalette();
    check('数据变更后改为全量重取（缓存已失效）', (await loadMode()) === 'full', await loadMode());
    const r2 = await queryPalette(pal, 'ZZCACHE');
    check('新增后再次弹出能搜到新条目（不是复用了旧缓存）', Array.isArray(r2 && r2.items) && r2.items.some(t => String(t).includes('ZZCACHE')), r2 && (r2.items || []).join(' | ').slice(0, 60));

    // ---- 3. 锁定：版本号必须变；小窗不得再露旧数据 ----
    await main.ev(`window.electronAPI.sessionLock()`);
    await sleep(300);
    const epochLocked = await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).epoch)()`);
    check('锁定后数据版本号递增', epochLocked > epochAfter, `${epochAfter} → ${epochLocked}`);
    // 设计上「锁定状态下按搜索键」不出小窗，而是把主窗口拉出来解锁（palette:show → locked）
    const showLocked = await main.ev(`(async () => await window.electronAPI.paletteShow())()`);
    check('锁定后按搜索键不出小窗，交给主窗口解锁', !!showLocked && showLocked.error === 'locked', JSON.stringify(showLocked));
    // 小窗里的「未解锁」分支靠重新加载来触发（隐藏窗口不发 palette:refresh，但挂载时仍会取数）
    await pal.ev(`location.reload()`);
    await sleep(1800);
    const r3 = await queryPalette(pal, 'ZZCACHE');
    check('锁定后小窗显示「未解锁」而不是旧列表', /还没解锁/.test(String(r3 && r3.empty)) && (r3.items || []).length === 0, r3 && String(r3.empty).replace(/\s+/g, ' ').slice(0, 40));
    check('palette:epoch 同时回传解锁状态', (await main.ev(`(async () => (await window.electronAPI.paletteEpoch()).unlocked)()`)) === false);
  } finally {
    if (pal) pal.close();
    main.close();
    stop(handle);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常：' + e.message); process.exit(1); });
