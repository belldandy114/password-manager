/**
 * 1.23.0 回归：六项功能
 *   ① 全局搜索补全（@history / @code）
 *   ② 数据生成器回填请求体（子应用 → tdg:to-api → 接口调试 body）
 *   ③ 附件集中管理（侧栏入口、卡片、引用者、未引用统计、导出/删除）
 *   ④ 导出加 Markdown（导出页有 md 选项，主进程能生成表格）
 *   ⑤ 汇总 tab 按提交人统计（页签、表格列、下钻）
 *   ⑥ 测试笔记钉小窗（图钉 → ?window=pin&kind=note）
 *
 * 跑法：node scripts/ui-round18-test.js（加 USE_PACKED=1 跑 release/win-unpacked）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickExe } = require('./pick-exe');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9818;
const PW = 'Probe#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/** 连一个 CDP target，返回 { ev, waitFor, close } */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
    if (r.exceptionDetails) console.log('EX', String(r.exceptionDetails.exception?.description || '').slice(0, 300));
    return r.result?.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(expr)) return true;
      await sleep(200);
    }
    return false;
  };
  return { ev, waitFor, send, close: () => ws.close() };
}

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-f6-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd: APP_DIR, windowsHide: true,
  });

  const listTargets = async () => {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; }
  };
  let target = null;
  for (let i = 0; i < 60; i++) {
    const list = await listTargets();
    target = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
    if (target) break;
    await sleep(400);
  }
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); return; }

  const M = await attach(target.webSocketDebuggerUrl);
  await M.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);
  const { ev, waitFor } = M;

  const gotoPage = async (label) => {
    await ev(`(() => {
      const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)}));
      if (n) n.click();
      return !!n;
    })()`);
    await sleep(1000);
  };

  // 建库
  const setup = await ev(`[...document.querySelectorAll('button')].some(b => /设置主密码并开始使用|开始使用/.test(b.textContent))`);
  if (setup) {
    await ev(`(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      [...document.querySelectorAll('input[type=password]')].forEach(i => set(i, ${JSON.stringify(PW)}));
      const btn = [...document.querySelectorAll('button')].find(b => /设置主密码并开始使用|开始使用/.test(b.textContent));
      if (btn) btn.click();
      return true;
    })()`);
    await sleep(2500);
  }

  // 预置数据：历史 / 代码片段 / 笔记（含一张图）
  const seeded = await ev(`(async () => {
    const api = window.electronAPI;
    const now = new Date().toISOString();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const img = await api.attachmentSaveImage({ dataUrl: 'data:image/png;base64,' + png, name: 'probe.png' });
    await api.wsSet('apiHistory', [
      { id: 'h1', name: '获取标准分页', method: 'POST', url: 'https://api.example.com/data/getStandardPage', status: 200, timeMs: 16, at: now },
    ]);
    await api.wsSet('codeSnippets', [
      { id: 'c1', name: '登录脚本', lang: 'javascript', code: 'console.log(1)', createdAt: now, updatedAt: now },
    ]);
    await api.wsSet('notes', [
      { id: 'n1', title: '接口联调步骤', content: '1. 先登录\\n2. 再取 token', tags: [], updatedAt: now },
      { id: 'n2', title: '带图的笔记', content: '看图\\n\\n![probe](pm-att:' + (img.data ? img.data.id : 'x') + ')', tags: [], updatedAt: now },
    ]);
    return { ok: true, attId: img.data ? img.data.id : '' };
  })()`);
  check('预置数据写入成功', seeded && seeded.ok === true, JSON.stringify(seeded));

  /* ---------- ① 全局搜索补全 ---------- */
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  const paletteOpen = await waitFor(`!!document.querySelector('.cmdk')`, 4000);
  check('命令面板可打开（Ctrl+K）', paletteOpen === true);

  const searchIn = async (q) => ev(`(async () => {
    const inp = document.querySelector('.cmdk input');
    if (!inp) return { err: 'no input' };
    const d = Object.getOwnPropertyDescriptor(inp.constructor.prototype, 'value');
    d.set.call(inp, ${JSON.stringify(q)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    return { rows: [...document.querySelectorAll('.cmdk-item, .cmdk-row, .cmdk li, .cmdk button')].map(x => x.textContent.trim()).filter(Boolean).slice(0, 10) };
  })()`);

  const hitHistory = await searchIn('获取标准分页');
  check('搜索能命中接口历史', JSON.stringify(hitHistory).includes('获取标准分页'), JSON.stringify(hitHistory).slice(0, 220));

  const hitCode = await searchIn('登录脚本');
  check('搜索能命中代码片段', JSON.stringify(hitCode).includes('登录脚本'), JSON.stringify(hitCode).slice(0, 220));

  const hitAlias = await searchIn('@history 分页');
  check('@history 限定词生效', JSON.stringify(hitAlias).includes('获取标准分页'), JSON.stringify(hitAlias).slice(0, 220));

  const hitAliasCode = await searchIn('@code 登录');
  check('@code 限定词生效', JSON.stringify(hitAliasCode).includes('登录脚本'), JSON.stringify(hitAliasCode).slice(0, 220));

  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);

  /* ---------- ③ 附件集中管理 ---------- */
  await gotoPage('附件管理');
  const attNav = await ev(`(() => ({
    active: [...document.querySelectorAll('.nav-item.active')].map(x => x.textContent.trim()),
    hasGrid: !!document.querySelector('.att-grid'),
    cards: document.querySelectorAll('.att-card').length,
  }))()`);
  check('侧栏有「附件管理」且能进入', (attNav.active || []).some(t => t.includes('附件管理')), JSON.stringify(attNav.active));
  check('附件卡片渲染出来', attNav.cards >= 1, JSON.stringify({ cards: attNav.cards }));

  const attCards = await ev(`(() => {
    const cards = [...document.querySelectorAll('.att-card')];
    const first = cards[0];
    return {
      n: cards.length,
      name: first ? (first.querySelector('.att-card-name') || {}).textContent : '',
      owners: first ? [...first.querySelectorAll('.att-owner')].map(x => x.textContent.trim()) : [],
      actions: first ? [...first.querySelectorAll('.att-card-actions button')].map(x => x.getAttribute('title') || x.textContent.trim()) : [],
      meta: (document.querySelector('.pnl-meta') || {}).textContent || '',
      thumb: first ? !!first.querySelector('.att-thumb') : false,
    };
  })()`);
  check('卡片显示引用者（笔记）', (attCards.owners || []).some(o => o.includes('带图的笔记')), JSON.stringify(attCards.owners));
  check('卡片有缩略图', attCards.thumb === true);
  check('卡片有导出/删除按钮', (attCards.actions || []).length >= 2, JSON.stringify(attCards.actions));
  // meta 只在「有孤儿」时才追加「N 个未引用」，所以这里只要求数量段存在
  check('面板 meta 显示数量', /个/.test(String(attCards.meta)), String(attCards.meta));

  // 「仅未引用」过滤：当前这张被引用，勾上后应为 0 张
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /仅未引用/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const orphanOnly = await ev(`document.querySelectorAll('.att-card').length`);
  check('「仅未引用」过滤生效（被引用的不显示）', orphanOnly === 0, String(orphanOnly));
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /仅未引用/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await sleep(400);

  /* ---------- ④ 导出加 Markdown ---------- */
  await gotoPage('网址管理');
  await sleep(600);
  // 导出页是「网址管理」的子页，切换按钮是 .tab2；默认导出类型是「加密备份」，
  // 格式下拉只在「明文导出」下渲染，所以要先切类型。
  const subOk = await ev(`(() => {
    const sub = [...document.querySelectorAll('.tabs .tab2')].find(x => /导出数据/.test(x.textContent));
    if (sub) sub.click();
    return !!sub;
  })()`);
  await sleep(900);
  const plainOk = await ev(`(() => {
    const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'plain'));
    if (!s) return false;
    s.value = 'plain';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  const mdOpt = await ev(`(() => {
    const sels = [...document.querySelectorAll('select')];
    const hit = sels.find(s => [...s.options].some(o => o.value === 'md'));
    return hit ? [...hit.options].map(o => o.value + ':' + o.textContent.trim()) : null;
  })()`);
  check('导出页能切到「导出数据」子页', subOk === true);
  check('导出页能切到「明文导出」', plainOk === true);
  check('导出页下拉有 Markdown 选项', !!mdOpt && JSON.stringify(mdOpt).includes('md:'), JSON.stringify(mdOpt));

  const mdBuild = await ev(`(async () => {
    // 直接验证主进程的 Markdown 生成（不弹保存框：走 exportSelectedPlain 的 md 分支会弹框，
    // 这里用 exportPlain 的返回值判断「格式被接受」）
    const r = await window.electronAPI.exportPlain({ format: 'md' });
    return { success: r.success, canceled: r.canceled, error: r.error };
  })()`);
  check('主进程接受 format=md', !mdBuild || mdBuild.error !== '不支持的格式', JSON.stringify(mdBuild));

  /* ---------- ⑤ 汇总 tab 按提交人 ---------- */
  // 汇总区只在有数据时渲染明细页签，所以先往禅道 store 的 IndexedDB 里塞一批 Bug，
  // 再 reload 让它 hydrate（reload 会重新上锁，需要再解一次）。
  const seededZt = await ev(`(async () => {
    const bugs = [
      { id: '901', title: '甲提的-1', status: 'active', severity: '3', product: '1', productName: '桩项目A', openedBy: '张三', assignedTo: '李四', openedDate: '2026-11-10 10:00', moduleName: '登录' },
      { id: '902', title: '甲提的-2', status: 'closed', severity: '4', product: '1', productName: '桩项目A', openedBy: '张三', assignedTo: '李四', openedDate: '2026-11-11 11:00', resolution: 'fixed', closedDate: '2026-11-12 09:00', moduleName: '登录' },
      { id: '903', title: '乙提的-1', status: 'resolved', severity: '2', product: '2', productName: '桩项目B', openedBy: '王五', assignedTo: '李四', openedDate: '2026-11-09 09:00', resolution: 'fixed', moduleName: '支付' },
    ];
    const payload = JSON.stringify({
      state: {
        sumBugs: bugs, sumProductIds: ['1', '2'], sumModules: {}, sumDataIds: ['1', '2'],
        sumFetchedAt: new Date().toISOString(),
      },
      version: 4,
    });
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pm-zentao', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(payload, 'pm.zentao.store');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    return { ok: true, n: bugs.length };
  })()`);
  check('预置禅道汇总数据', seededZt && seededZt.ok === true, JSON.stringify(seededZt));

  await ev(`location.reload()`);
  await sleep(2600);
  const needUnlock = await ev(`!!document.querySelector('input[placeholder="输入主密码解锁"]')`);
  if (needUnlock) {
    await ev(`(() => {
      const el = document.querySelector('input[placeholder="输入主密码解锁"]');
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, ${JSON.stringify(PW)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '解锁');
      if (btn) btn.click();
      return true;
    })()`);
    await sleep(2600);
  }
  await gotoPage('缺陷管理');
  await sleep(1200);
  const sumTab = await ev(`(() => {
    const t = [...document.querySelectorAll('button, .tab2, .zt-tab')].find(x => /^汇总/.test(x.textContent.trim()));
    if (t) t.click();
    return !!t;
  })()`);
  await sleep(1500);
  const creatorTab = await ev(`(() => {
    const tabs = [...document.querySelectorAll('.zt-detail-tab')].map(x => x.textContent.trim());
    const hit = tabs.find(t => /按提交人/.test(t));
    return { hit: hit || '', tabs };
  })()`);
  check('汇总区有「按提交人」页签', /按提交人/.test(creatorTab.hit), JSON.stringify(creatorTab));

  if (creatorTab.hit) {
    await ev(`(() => { const b = [...document.querySelectorAll('.zt-detail-tab')].find(x => /按提交人/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
    await sleep(700);
    const creatorTable = await ev(`(() => {
      const pnl = [...document.querySelectorAll('.pnl')].find(p => /按提交人/.test(p.textContent));
      const ths = pnl ? [...pnl.querySelectorAll('th')].map(x => x.textContent.trim()) : [];
      const rows = pnl ? pnl.querySelectorAll('tbody tr').length : 0;
      const empty = pnl ? (pnl.querySelector('.zt-sum-empty') || {}).textContent || '' : '';
      return { ths, rows, empty: String(empty).slice(0, 40) };
    })()`);
    check('按提交人表格列齐（提交人/提交/占比/已关闭/修复率）',
      ['提交人', '提交', '占比', '已关闭', '修复率'].every(h => (creatorTable.ths || []).includes(h)),
      JSON.stringify(creatorTable.ths));
    check('按提交人表格有数据行或明确空态', creatorTable.rows > 0 || !!creatorTable.empty, JSON.stringify({ rows: creatorTable.rows, empty: creatorTable.empty }));
  }

  /* ---------- ⑥ 笔记钉小窗 ---------- */
  await gotoPage('测试笔记');
  await sleep(1200);
  const notePin = await ev(`(() => {
    const cards = [...document.querySelectorAll('.card2')];
    const card = cards.find(c => /带图的笔记/.test(c.textContent));
    if (!card) return { err: 'no card', n: cards.length };
    const btns = [...card.querySelectorAll('.card2-actions button')];
    return { n: cards.length, btnTitles: btns.map(b => b.getAttribute('title') || ''), hasPin: btns.some(b => /钉成小窗/.test(b.getAttribute('title') || '')) };
  })()`);
  check('笔记卡片有「钉成小窗」按钮', notePin.hasPin === true, JSON.stringify(notePin).slice(0, 260));

  if (notePin.hasPin) {
    await ev(`(() => {
      const card = [...document.querySelectorAll('.card2')].find(c => /带图的笔记/.test(c.textContent));
      const pin = [...card.querySelectorAll('.card2-actions button')].find(b => /钉成小窗/.test(b.getAttribute('title') || ''));
      if (pin) pin.click();
      return !!pin;
    })()`);
    await sleep(2200);
    const pinTarget = (await listTargets()).find(t => String(t.url || '').includes('window=pin'));
    check('点图钉后出现笔记小窗', !!pinTarget, pinTarget ? String(pinTarget.url).replace(/^.*\?/, '?') : 'none');
    if (pinTarget) {
      const P = await attach(pinTarget.webSocketDebuggerUrl);
      await sleep(1500);
      const info = await P.ev(`(() => ({
        cls: document.documentElement.className,
        title: (document.querySelector('.pin-title, .pin-head-title') || {}).textContent || '',
        hasMd: !!document.querySelector('.pin-md'),
        body: (document.querySelector('.pin-note-body') || {}).textContent || '',
        foot: [...document.querySelectorAll('.pin-foot button, .pin-foot-btn')].map(b => b.textContent.trim()),
        hasPwd: !!document.querySelector('.pin-row'),
      }))()`);
      check('小窗带 note 类名', String(info.cls || '').includes('pin-window-note'), String(info.cls));
      check('小窗渲染笔记正文（Markdown）', info.hasMd === true && String(info.body).includes('看图'), JSON.stringify({ hasMd: info.hasMd, body: String(info.body).slice(0, 40) }));
      check('笔记小窗没有密码行', info.hasPwd === false);
      check('小窗有「复制正文」按钮', (info.foot || []).some(t => /复制正文/.test(t)), JSON.stringify(info.foot));
      P.close();
    }
  }

  /* ---------- ② 数据生成器回填请求体 ---------- */
  // 子应用是 webview，等它挂载后从它自己的 target 调 toApiBody，走真实链路
  await gotoPage('测试数据');
  await sleep(3500);
  const tdgTarget = (await listTargets()).find(t => String(t.url || '').includes('dist-tdg') || String(t.url || '').includes('test-data'));
  check('测试数据子应用已挂载（webview target 存在）', !!tdgTarget, tdgTarget ? String(tdgTarget.url).slice(0, 80) : 'none');

  if (tdgTarget) {
    const T = await attach(tdgTarget.webSocketDebuggerUrl);
    await sleep(1200);
    const hasApi = await T.ev(`!!(window.electronAPI && window.electronAPI.toApiBody)`);
    check('子应用暴露了 toApiBody', hasApi === true);
    const sent = await T.ev(`(async () => {
      const r = await window.electronAPI.toApiBody(['a@example.com', 'b@example.com']);
      return r;
    })()`);
    check('子应用调用 toApiBody 成功', sent && sent.success === true, JSON.stringify(sent));
    T.close();

    // 主窗口应已跳到接口调试，且请求体被填成 JSON 数组
    const jumped = await waitFor(`!!document.querySelector('.url-bar')`, 8000);
    check('主窗口自动跳到接口调试', jumped === true);
    await sleep(800);
    const bodyText = await ev(`(() => {
      const tas = [...document.querySelectorAll('textarea')];
      const hit = tas.find(t => /a@example\\.com/.test(t.value));
      return hit ? hit.value : (tas.map(t => t.value.slice(0, 40)).join(' | ') || 'none');
    })()`);
    check('请求体被填成 JSON 数组', String(bodyText).includes('a@example.com') && String(bodyText).includes('['), String(bodyText).slice(0, 120));
    const bodyType = await ev(`(() => {
      const b = [...document.querySelectorAll('.tab2, .seg-btn, button')].find(x => x.textContent.trim() === 'JSON' && x.className.includes('is-active'));
      return b ? b.textContent.trim() : '';
    })()`);
    check('请求体类型切到 JSON', bodyType === 'JSON', JSON.stringify(bodyType));
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  try { app.kill(); } catch { /* ignore */ }
  await sleep(500);
  process.exit(fail === 0 ? 0 : 1);
})();
