/**
 * ui-bg-glass-test.js —— 玻璃层（data-bg='image'）实际计算样式回归（t2/P1 新增，替代「肉眼看截图」）
 *
 * 验四类玻璃层 + 模态框：卡片 / 侧栏 / 浮层 / 输入框 / 模态框的 getComputedStyle 结果必须与
 * tokens.css 里对应 --glass-* 令牌**求值后的颜色**一致，且真的半透明（alpha < 1）、该带模糊的有 blur。
 * 深色 / 浅色两套主题各验一遍（令牌在 :root 与 [data-theme='light'] 两块分别定义）。
 *
 * ⚠️ 为什么不用「读 token 字符串比字符串」：自定义属性没注册 @property，getPropertyValue('--glass-card')
 * 返回的是 var() 替换后的原文 `color-mix(in srgb, ...)`，而元素 computed backgroundColor 是被解析过的
 * `color(srgb ... / 0.52)`——两者永远不相等，那样写必然假红。这里用 1×1 探针把令牌求值成 computed 颜色，
 * 再和真实元素比（格式无关：color-mix 换成 rgba/oklch 也不会误报）。
 *
 * 跑法：node scripts/ui-bg-glass-test.js（需先 npm run build:renderer；USE_PACKED=1 跑打包版）
 * 失败即退出码 1；截图落在 scripts/.tmp-shots/（.gitignore 已忽略，可随时重跑覆盖）。
 */
const path = require('path');
const {
  launch, waitForWindow, ensureUnlocked, applyBackground, reloadPage, prepareDataDir, dismissOnboarding, navTo, setTheme, stop,
} = require('./lib/app');
const { sleep } = require('./lib/cdp');

const BG_FIXTURE = path.join(__dirname, '..', 'buildResources', 'icon.png');
const SHOT_DIR = path.join(__dirname, '.tmp-shots');
const THEMES = ['light', 'dark'];
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`✓ ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`); } else { fail += 1; console.log(`✗ ${name}  → ${JSON.stringify(detail)}`); }
};

/** 在页面里量一层的实际计算样式，并把对应 --glass-* 令牌用探针求值成可比的颜色 */
const MEASURE = (selector, token) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false, selector: ${JSON.stringify(selector)} };
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
  probe.style.backgroundColor = 'var(${token})';
  document.body.appendChild(probe);
  const expected = getComputedStyle(probe).backgroundColor;
  const tokenRaw = getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(token)}).trim();
  probe.remove();
  const cs = getComputedStyle(el);
  const parse = (s) => {
    s = String(s || '').trim();
    let m = s.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    m = s.match(/^color\\(srgb\\s+([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[\\s/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
    return null;
  };
  return { found: true, token: ${JSON.stringify(token)}, tokenRaw, expected, actual: cs.backgroundColor, backdrop: cs.backdropFilter,
    expectedRgba: parse(expected), actualRgba: parse(cs.backgroundColor), theme: document.documentElement.dataset.theme };
})()`;

/** 颜色等价：分量差 ≤1（0-255 取整误差），alpha 差 ≤0.01 */
const sameColor = (a, b) => Array.isArray(a) && Array.isArray(b) && Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1
  && Math.abs(a[2] - b[2]) <= 1 && Math.abs(a[3] - b[3]) <= 0.01;

/**
 * 对一层玻璃做 4~5 条断言：命中 / 令牌已定义 / 实际值 == 令牌值 / 半透明 / （可选）带 blur
 * @param {string} label 人类可读层名
 * @param {object} m MEASURE 的返回
 * @param {{blur?: boolean}} [opts] blur 默认 true：该层是否应该带 backdrop-filter
 */
const assertLayer = (label, m, opts = {}) => {
  const tag = `${label}(${m && m.token ? m.token : '?'}${m && m.theme ? ' · ' + m.theme : ''})`;
  check(`${tag} 选择器命中`, !!(m && m.found), m && (m.selector || m.token));
  if (!m || !m.found) return;
  check(`${tag} 令牌 ${m.token} 已定义且能解析成颜色`, !!m.tokenRaw && !!m.expectedRgba, m.tokenRaw.slice(0, 90));
  check(`${tag} 实际背景 == 令牌期望`, sameColor(m.actualRgba, m.expectedRgba), { actual: m.actual, expected: m.expected });
  check(`${tag} 真的半透明（0 < alpha < 1）`, !!m.actualRgba && m.actualRgba[3] > 0 && m.actualRgba[3] < 1, m.actualRgba && m.actualRgba[3]);
  if (opts.blur !== false) check(`${tag} 带 backdrop-filter blur`, /blur\(/.test(String(m.backdrop)), m.backdrop);
};

(async () => {
  const { dataDir, backgroundName } = prepareDataDir({ prefix: 'pm-glass-data-', background: { srcFile: BG_FIXTURE, name: 'bg-test.png' } });
  const handle = await launch({ port: 9831, dataDir });
  const session = await waitForWindow(handle, { shotDir: SHOT_DIR });
  const { ev } = session;
  try {
    await ensureUnlocked(session); // 首次启动：设主密码（引导弹窗先关掉，落盘背景设置后再重载）
    // 预置 3 条网址：默认 viewMode=card，列表才有 .entry-card（真卡片，带 --glass-blur-card）可量。
    // 条目字段只造"能渲染成卡片"的最小集合，不含任何真实账号/口令（entries:add 只做 push，不校验字段）。
    await ev(`(async () => { const now = new Date().toISOString();
      for (let i = 1; i <= 3; i += 1) await window.electronAPI.entriesAdd({ id: 'glass-' + i, name: '玻璃层样本 ' + i,
        username: 'user-' + i, url: 'https://example.com/' + i, note: '', tags: [], updatedAt: now });
      return true; })()`);
    await applyBackground(session, { name: backgroundName, settings: { backgroundOpacity: 0.45, backgroundBlur: 0, backgroundDim: 0.1, backgroundAutoAccent: false } });
    await reloadPage(session, { settleMs: 2400 });
    await ensureUnlocked(session, { dismissOnboarding: false }); // 重载后再解锁：这次留住引导弹窗当模态框样本

    // 背景层是异步取图后才写 data-bg 的（bg:get → <img> → effect），必须等一下再断言
    const bgOk = await session.waitFor({ expr: `document.documentElement.dataset.bg === 'image'` }, { timeout: 10000, throwOnTimeout: false });
    check('data-bg=image（玻璃规则生效的前提）', bgOk === true, await ev(`document.documentElement.getAttribute('data-bg')`));

    // 1) 模态框：登录后立刻出现的引导弹窗，深色主题下测一眼（tokens.css 的默认深色在 :root）
    await setTheme(session, 'dark');
    assertLayer('模态框', await ev(MEASURE('.modal', '--glass-modal')));
    await dismissOnboarding(session);
    await sleep(400);

    // 2) 卡片 / 侧栏 / 输入框 / 浮层：网址管理页一页齐活（卡片视图 + 工具栏搜索框 + 搜索范围下拉）
    await navTo(session, '网址管理');
    const opened = await ev(`(() => { const b = document.querySelector('.toolbar-search .search-scope-btn'); if (!b) return false; b.click(); return true; })()`);
    await session.waitFor({ selector: '.search-scope-menu' }, { timeout: 8000 });
    check('浮层已展开（搜索范围下拉）', opened === true, opened);
    for (const theme of THEMES) {
      await setTheme(session, theme);
      console.log(`\n──── 主题 ${theme}：网址管理`);
      assertLayer('卡片', await ev(MEASURE('.entry-card', '--glass-card')));
      assertLayer('侧栏', await ev(MEASURE('.sidebar', '--glass-side')));
      assertLayer('输入框', await ev(MEASURE('input:not([type=checkbox]):not([type=radio])', '--glass-input')), { blur: false });
      assertLayer('浮层', await ev(MEASURE('.search-scope-menu', '--glass-overlay')));
      await session.shot(`glass-${theme}.png`);
    }
    check('页面无未捕获异常', session.errors.length === 0, session.errors.slice(0, 3));
  } finally {
    stop(handle);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
