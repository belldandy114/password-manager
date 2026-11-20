/**
 * 自定义背景回归（1.30.0）
 *
 * 覆盖：设置页背景区块存在 / 背景层渲染（data-bg + <img>）/ 半透明卡片 / 取色写入设置 /
 *      移除后恢复默认。原生对话框无法自动化，所以先把图片直接放进数据目录 background/
 *      并通过 settingsSave 写进设置，再重载登录 —— 走的仍是真实的 bg:get 读取链路。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9813;
const PASSWORD = 'Bg#2026Test';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`✓ ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`); }
  else { fail += 1; console.log(`✗ ${name}  → ${JSON.stringify(detail)}`); }
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bg-ud-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bg-data-'));
  const casesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bg-cases-'));
  fs.writeFileSync(path.join(dataDir, 'cases.json'), JSON.stringify({ root: casesRoot }), 'utf8');
  const bgDir = path.join(dataDir, 'background');
  fs.mkdirSync(bgDir, { recursive: true });
  // 用仓库里的一张截图当测试图（真实 PNG）
  fs.copyFileSync(path.join(ROOT, '_shots-audit', 'bg-sample.png'), path.join(bgDir, 'bg-test.png'));

  const env = { ...process.env, PM_USE_DIST: '1', PM_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`], { env, cwd: ROOT, windowsHide: true });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find(t => t.type === 'page' && !t.url.startsWith('devtools://')); if (target) break; } catch { }
    await sleep(400);
  }
  if (!target) { console.log('✗ 应用没有起来'); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 160));
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1400);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails) console.log('  EXC ' + (r.exceptionDetails.exception?.description || '').slice(0, 200));
    return r?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '_shots-audit', name), Buffer.from(r.data, 'base64'));
  };
  const SETVAL = `(el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }`;

  // 1) 首次设置主密码
  await ev(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return true; })()`);
  await sleep(300);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); if (b) b.click(); return true; })()`);
  await sleep(2600);
  await ev(`(() => { const m = document.querySelector('.modal'); if (!m) return false; const b = [...m.querySelectorAll('button')].find(x => /稍后/.test(x.textContent || '')); if (b) b.click(); return true; })()`);
  await sleep(400);

  // 2) 写入背景设置 + 重载（模拟重启后加载）
  const saved = await ev(`window.electronAPI.settingsSave({ backgroundImage: 'bg-test.png', backgroundOpacity: 0.32, backgroundBlur: 8, backgroundDim: 0.42, backgroundAutoAccent: true, backgroundAccent: '' })`);
  check('settingsSave 接受背景字段', !!(saved && saved.success), saved);
  await send('Page.reload');
  await sleep(2600);

  // 3) 重新解锁（重载后回到登录页）
  await ev(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); if (ins[0]) set(ins[0], ${JSON.stringify(PASSWORD)}); return true; })()`);
  await sleep(200);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /解锁|登录/.test(x.textContent || '')); if (b) b.click(); return true; })()`);
  await sleep(3200);
  await ev(`(() => { const m = document.querySelector('.modal'); if (!m) return false; const b = [...m.querySelectorAll('button')].find(x => /稍后/.test(x.textContent || '')); if (b) b.click(); return true; })()`);
  await sleep(600);


  // 4) 背景层与半透明
  const state = await ev(`(() => {
    const img = document.querySelector('.app-bg-img');
    const side = getComputedStyle(document.querySelector('.sidebar') || document.body);
    return {
      dataBg: document.documentElement.getAttribute('data-bg'),
      hasImg: !!img,
      srcOk: !!img && img.src.startsWith('data:image/'),
      imgCover: img ? getComputedStyle(img).objectFit : '',
      sidebarBg: side.backgroundColor,
      contentBg: getComputedStyle(document.querySelector('.content-area') || document.body).backgroundColor,
      accentAttr: document.documentElement.getAttribute('data-accent'),
      accentVar: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    };
  })()`);
  check('解锁后 <html data-bg=image>', state.dataBg === 'image', state.dataBg);
  check('背景层用 <img> 渲染且是 data URL', state.hasImg && state.srcOk, { hasImg: state.hasImg, srcOk: state.srcOk });
  check('背景图 object-fit: cover（不拉伸）', state.imgCover === 'cover', state.imgCover);
  check('侧栏半透明（alpha < 1）', /\/ 0\.\d+\)|\/\s*0\.\d+\)/.test(state.sidebarBg) || state.sidebarBg.startsWith('rgba'), state.sidebarBg);
  check('内容区有半透明底色', state.contentBg.includes('/ 0.32') || state.contentBg.startsWith('rgba'), state.contentBg);
  await sleep(1200);
  await shot('bg-test-home.png');

  // 5) 取色：应写入 settings.json
  await sleep(1200);
  const accentAfter = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  const accentAttr2 = await ev(`document.documentElement.getAttribute('data-accent')`);
  const settingsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  check('从图片取到强调色并写入设置', /^#[0-9a-f]{6}$/i.test(settingsRaw.backgroundAccent || ''), settingsRaw.backgroundAccent);
  check(
    '图片强调色已接管 --accent',
    accentAttr2 === 'image' && /^#[0-9a-f]{6}$/i.test(accentAfter) && accentAfter.toLowerCase() === String(settingsRaw.backgroundAccent).toLowerCase(),
    { accentAfter, accentAttr2, saved: settingsRaw.backgroundAccent },
  );

  // 6) 设置页背景区块
  await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(e => e.textContent.includes('设置')); if (n) n.click(); return true; })()`);
  await sleep(1200);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('外观与交互')); if (b) b.click(); return true; })()`);
  await sleep(900);
  const ui = await ev(`(() => ({
    section: !!Array.from(document.querySelectorAll('.setting-label')).find(e => e.textContent.includes('背景图片')),
    sliders: document.querySelectorAll('input[aria-label="背景不透明度"], input[aria-label="背景模糊"], input[aria-label="背景压暗"]').length,
    thumb: !!document.querySelector('.bg-thumb'),
  }))()`);
  check('设置里出现「背景图片」区块', ui.section === true, ui.section);
  check('三个滑块都在（不透明度/模糊/压暗）', ui.sliders === 3, ui.sliders);
  check('缩略图使用当前背景', ui.thumb === true, ui.thumb);
  await shot('bg-test-settings.png');

  // 7) 点「移除」→ 恢复默认（走真实 UI 路径，保证渲染层 store 同步）
  const removed = await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find(r => r.textContent.includes('背景图片'));
    const btn = row && Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '移除');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  check('设置页有「移除」按钮且可点', removed === true, removed);
  await sleep(1200);
  const after = await ev(`({ dataBg: document.documentElement.getAttribute('data-bg'), hasImg: !!document.querySelector('.app-bg-img') })`);
  check('移除后背景层消失、data-bg 清空', !after.hasImg && after.dataBg !== 'image', after);
  const settingsAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  check('移除后 settings.backgroundImage 为空', !settingsAfter.backgroundImage, settingsAfter.backgroundImage);

  check('页面无未捕获异常', errors.length === 0, errors.slice(0, 3));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { app.kill(); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();

