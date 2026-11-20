/**
 * 自定义背景回归（1.30.0）—— 已迁移到 scripts/lib/{cdp,app}.js（t2/P1 示范 1）；15 条断言与迁移前逐条一致。
 * 覆盖：背景层渲染（data-bg + <img> + object-fit）/ 侧栏与内容区半透明 / 取色写入设置并接管 --accent /
 * 设置页背景区块与三个滑块 / 移除后恢复默认 / 页面无未捕获异常。原生对话框无法自动化：图片直接放进
 * 数据目录 background/ 再用 settingsSave 落设置，重载后走真实 bg:get 链路。跑法：node scripts/ui-bg-test.js
 *（先 npm run build:renderer；USE_PACKED=1 跑打包版）。背景图用仓库内 buildResources/icon.png（tracked）。
 */
const fs = require('fs');
const path = require('path');
const {
  launch, waitForWindow, ensureUnlocked, applyBackground, reloadPage, prepareDataDir, clickText, navTo, stop,
} = require('./lib/app');
const { sleep } = require('./lib/cdp');
const BG_FIXTURE = path.join(__dirname, '..', 'buildResources', 'icon.png');
let pass = 0; let fail = 0;
/** 取颜色 alpha：兼容 rgba(r,g,b,a) 与 color(srgb r g b / a) 两种序列化 */
const alpha = (c) => { const m = String(c).match(/\/\s*([\d.]+)\s*\)/) || String(c).match(/rgba\([^)]*,\s*([\d.]+)\)/); return m ? Number(m[1]) : 1; };
/** 断言器：沿用各 ui-*.js 自己的输出风格，不并入公共库（避免一次性统一 28 个脚本的断言口径） */
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`✓ ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`); } else { fail += 1; console.log(`✗ ${name}  → ${JSON.stringify(detail)}`); }
};

(async () => {
  const { dataDir, backgroundName } = prepareDataDir({ prefix: 'pm-bg-data-', casesRoot: true, background: { srcFile: BG_FIXTURE, name: 'bg-test.png' } });
  const handle = await launch({ port: 9813, dataDir });
  const session = await waitForWindow(handle, { shotDir: path.join(__dirname, '..', '_shots-audit') });
  const { ev, shot } = session;
  try {
    await ensureUnlocked(session); // 首次启动：设主密码 + 关引导弹窗
    const saved = await applyBackground(session, { name: backgroundName,
      settings: { backgroundOpacity: 0.32, backgroundBlur: 8, backgroundDim: 0.42, backgroundAutoAccent: true, backgroundAccent: '' } });
    check('settingsSave 接受背景字段', !!(saved && saved.success), saved);
    await reloadPage(session, { settleMs: 2400 });
    await ensureUnlocked(session); // 重载后回到登录页，再解锁（模拟重启后加载）

    // ⚠️ data-bg 是异步链写上去的（settingsSave → bg:get 取图 → <img> load → applyBackground），
    // 探针实测：解锁那一刻读它有时还是 null，8ms 后才变 'image'。只读一次快照会偶发红，而且一红就是
    // 这条 + 侧栏 + 内容区三条一起红（后两条的玻璃值就挂在 html[data-bg='image'] 下面）。
    // 这里等到位再读 —— 但「等不到」绝不等于通过：throwOnTimeout:false 只是把失败落回下面那条断言
    // （超时 → state.dataBg 不是 'image' → 断言红 → 退出码 1），断言条数仍是 15 条。
    const bgSeen = await session.waitFor({ expr: `document.documentElement.dataset.bg === 'image'` }, { timeout: 10000, throwOnTimeout: false });

    // 1) 背景层与半透明
    const state = await ev(`(() => { const img = document.querySelector('.app-bg-img'); const cs = (s) => getComputedStyle(document.querySelector(s) || document.body);
      return { dataBg: document.documentElement.getAttribute('data-bg'), hasImg: !!img, srcOk: !!img && img.src.startsWith('data:image/'),
        imgCover: img ? getComputedStyle(img).objectFit : '', sidebarBg: cs('.sidebar').backgroundColor, contentBg: cs('.content-area').backgroundColor,
        accentAttr: document.documentElement.getAttribute('data-accent'), accentVar: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }; })()`);
    check('解锁后 <html data-bg=image>', state.dataBg === 'image', bgSeen ? state.dataBg : `等 10000ms 仍未出现 data-bg=image，读到 ${state.dataBg}`);
    check('背景层用 <img> 渲染且是 data URL', state.hasImg && state.srcOk, { hasImg: state.hasImg, srcOk: state.srcOk });
    check('背景图 object-fit: cover（不拉伸）', state.imgCover === 'cover', state.imgCover);
    check('侧栏半透明（alpha < 1）', alpha(state.sidebarBg) < 1, state.sidebarBg);
    check('内容区有半透明底色', alpha(state.contentBg) > 0 && alpha(state.contentBg) < 1, state.contentBg);
    await sleep(1200);
    await shot('bg-test-home.png');
    // 2) 取色：应写入 settings.json
    await sleep(1200);
    const accentAfter = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    const accentAttr2 = await ev(`document.documentElement.getAttribute('data-accent')`);
    const settingsRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    check('从图片取到强调色并写入设置', /^#[0-9a-f]{6}$/i.test(settingsRaw.backgroundAccent || ''), settingsRaw.backgroundAccent);
    check('图片强调色已接管 --accent', accentAttr2 === 'image' && /^#[0-9a-f]{6}$/i.test(accentAfter) && accentAfter.toLowerCase() === String(settingsRaw.backgroundAccent).toLowerCase(), { accentAfter, accentAttr2, saved: settingsRaw.backgroundAccent });
    // 3) 设置页背景区块
    await navTo(session, '设置');
    await clickText(session, '外观与交互');
    await sleep(900);
    const ui = await ev(`(() => ({ section: !!Array.from(document.querySelectorAll('.setting-label')).find(e => e.textContent.includes('背景图片')),
      sliders: document.querySelectorAll('input[aria-label="背景不透明度"], input[aria-label="背景模糊"], input[aria-label="背景压暗"]').length,
      thumb: !!document.querySelector('.bg-thumb') }))()`);
    check('设置里出现「背景图片」区块', ui.section === true, ui.section);
    check('三个滑块都在（不透明度/模糊/压暗）', ui.sliders === 3, ui.sliders);
    check('缩略图使用当前背景', ui.thumb === true, ui.thumb);
    await shot('bg-test-settings.png');
    // 4) 点「移除」→ 恢复默认（走真实 UI 路径，保证渲染层 store 同步）
    const removed = await ev(`(() => { const row = Array.from(document.querySelectorAll('.setting-row')).find(r => r.textContent.includes('背景图片'));
      const btn = row && Array.from(row.querySelectorAll('button')).find(b => b.textContent.trim() === '移除');
      if (btn) { btn.click(); return true; } return false; })()`);
    check('设置页有「移除」按钮且可点', removed === true, removed);
    await sleep(1200);
    const after = await ev(`({ dataBg: document.documentElement.getAttribute('data-bg'), hasImg: !!document.querySelector('.app-bg-img') })`);
    check('移除后背景层消失、data-bg 清空', !after.hasImg && after.dataBg !== 'image', after);
    const settingsAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    check('移除后 settings.backgroundImage 为空', !settingsAfter.backgroundImage, settingsAfter.backgroundImage);
    check('页面无未捕获异常', session.errors.length === 0, session.errors.slice(0, 3));
  } finally {
    stop(handle);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
