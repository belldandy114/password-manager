'use strict';

/**
 * ui-glass-opaque-scan.js —— 「背景图模式下还有没有不透明白块」的扫描门禁（1.32.0）
 *
 * 为什么要有它：背景图的玻璃化是「按类名一条条补」的（tokens.css 的 --glass-* + redesign.css 的
 * html[data-bg='image'] 段），补漏只能靠实测 —— 看截图会漏掉折叠区域，也说不清是哪条规则漏的。
 * 所以把人的判据固化成机器判据：
 *
 *   在 html[data-bg='image'] 下遍历可见元素，凡是
 *   **backgroundColor 的 alpha >= 0.999 且面积 > 600 px²** 的块都列出来；
 *   - 命中 WHITELIST（本应实心）→ 打 ✓ 放行，但必须逐条打印「为什么不算漏」；
 *   - 命中白名单外 → 打 ✗ 并打印 class + 尺寸 + 颜色，脚本以退出码 1 结束。
 *   深色 / 浅色两套主题各扫一遍（玻璃令牌分两套，可能只漏其中一套）。
 *
 * 顺带做第二件事：把补漏过的通用类（tag-sidebar-search / search-scope-btn /
 * view-toggle-btn / tb-main-head / .pager / .pm-pager-wrap）的 computed backgroundColor
 * 打印成实测值，并要求「找到了 且 alpha < 1」—— 面积判据会被窗口尺寸影响，这些是确定性的验收锚点。
 *
 * ⚠️ 1.32.2（t1）补的一条重要口径：**只验「alpha < 1」拦不住假绿**。
 *    .pager 的基础底色本来就是 `color-mix(--bg-input 35%, transparent)`（alpha 0.35），
 *    把玻璃规则整条注释掉它照样「半透明」—— 于是「注释掉 → 扫描仍然绿」，
 *    门禁看着在跑、其实一条都没拦。所以锚点可以再带一个 `token`：
 *    用**同父级的探针元素**解析 `var(--glass-*)` 的 computed 值，要求目标元素的
 *    backgroundColor 与该值**逐字符相等**（= 背景真的来自那条玻璃规则，而不是碰巧也是半透明）。
 *    变异验证（把 .pager 的玻璃规则注释掉）必须因此变红，见文件末尾的 PAGES/TARGETS 说明。
 *
 * 口径说明（为什么是 600px²）：
 *   400×1.5 的一条 1px 分隔线、图标按钮的 16×16 svg 都不影响读图；真正「像白板」的块
 *   （搜索框 200×32 = 6400、工具卡头部 600×80 = 48000）都在 600 以上。600 是「小徽标 / 键帽
 *   可能刚刚越过」的量级，所以白名单里也把徽标 / KBD 写清楚了，而不是放宽阈值蒙过去。
 *
 * 跑法：
 *   node scripts/ui-glass-opaque-scan.js              # 开发目录 + dist（先 npm run build:renderer）
 *   USE_PACKED=1 node scripts/ui-glass-opaque-scan.js # 打包版（先 npm run pack / npm run dist）
 * 已挂进 scripts/regress-all.js 的打包版回归清单。
 */
const path = require('path');
const {
  launch, waitForWindow, ensureUnlocked, applyBackground, reloadPage, prepareDataDir,
  navTo, clickText, setTheme, stop,
} = require('./lib/app');
const { sleep } = require('./lib/cdp');

const BG_FIXTURE = path.join(__dirname, '..', 'buildResources', 'icon.png');
/** 面积阈值（px²）：低于它的块即使全不透明也不影响「能不能看见背景图」 */
const AREA_MIN = 600;
/** 判定为「完全不透明」的 alpha 阈值（0.999 而不是 1：computed 值会带浮点误差） */
const ALPHA_OPAQUE = 0.999;
const THEMES = ['light', 'dark'];

/**
 * 白名单：这些块**本应实心**，玻璃化反而是错的。每条都必须写理由 ——
 * 没有理由的白名单等于把门禁关掉（check-stacking.js 对白名单也是这个规矩）。
 * test 收到的 e：{ cls, tag, id, bg, w, h, area }
 */
const WHITELIST = [
  {
    id: 'app-bg-dim',
    test: (e) => hasWord(e.cls, 'app-bg-dim'),
    why: '压暗遮罩本体：它就是盖在图上的一层纯色，浓度由 opacity（滑块 --bg-dim）控制；'
      + '把它的背景改半透明等于取消压暗，浅色/深色文字立刻看不清',
  },
  {
    id: '主按钮 (btn-primary / btn-add / btn-empty-add)',
    test: (e) => /(^|\s)(btn-primary|btn-add|btn-empty-add)(\s|$)/.test(e.cls),
    why: '主行动按钮：实心底是「这里点这里」的视觉锚点，玻璃化后与次级按钮拉不开层次；'
      + '它尺寸小（单个按钮面积多在 600 上下），挡不住图',
  },
  {
    id: 'KBD 键帽',
    test: (e) => e.tag === 'KBD',
    why: '快捷键键帽：靠实心底 + 内阴影画「凸起的键」，半透明会糊成一团；且键帽都是 20~60px 宽',
  },
  {
    id: 'env 徽标 (env-badge / env-badge-table)',
    test: (e) => /(^|\s)env-badge/.test(e.cls),
    why: '环境徽标（生产/测试/开发/预发布）：底色本身是语义色（红/黄/蓝），要保证与白字的'
      + '确定对比度，掺背景会让「生产」和「测试」看起来一样；单个徽标 ~40×20',
  },
  {
    id: '图表色块 / 进度条填充',
    test: (e) => /(^|\s)(bar-fill|chart-fill|chart-bar|donut-seg|progress-fill|dl-bar-fill|stat-bar-fill)(\s|$)/.test(e.cls),
    why: '图表色块与进度条填充：颜色就是数据，半透明后「占比」会被背景图干扰而读错',
  },
];

/** 本轮补漏的通用类：确定性的验收锚点（面积判据受窗口尺寸影响，这些不受） */
const TARGETS = [
  { sel: '.tag-sidebar-search', label: 'tag-sidebar-search' },
  { sel: '.toolbar-search .search-scope-btn', label: 'search-scope-btn' },
  { sel: '.toolbar-actions .view-toggle-btn', label: 'view-toggle-btn' },
  { sel: '.tb-main-head', label: 'tb-main-head' },
  // 1.32.2（t1）：分页条玻璃补漏。两个锚点都要带 token —— 只比 alpha 的话，
  // .pager 的基础底色（color-mix … 35%）本来就是半透明，注释掉玻璃规则也不会红。
  // .pager 只在「笔记与附件」页是独立元素（网址管理里它被 .pm-pager-wrap 包着、
  // 内层故意 transparent），所以两个锚点各自限定页面，避免量错对象。
  { sel: '.pager', label: '.pager（笔记页独立分页条）', token: '--glass-side', pages: ['笔记与附件'] },
  { sel: '.pm-pager-wrap', label: '.pm-pager-wrap（网址管理吸底容器）', token: '--glass-side',
    pages: ['网址管理 · 列表视图', '网址管理 · 卡片视图'] },
  // 分页条内部的两个控件：任务书要求用 --glass-control。
  // 按钮锚点必须带 :not(:disabled) —— 第 1 页时「«」「‹」是禁用的，
  // 而禁用态**刻意**保持「透明底 + opacity .35」（见 redesign.css 1.32.2 的注释），
  // 量到它就会得出「背景不是 --glass-control」的假红。
  { sel: '.pager-btn:not(:disabled)', label: '.pager-btn:not(:disabled)', token: '--glass-control',
    pages: ['笔记与附件', '网址管理 · 列表视图'] },
  { sel: '.pager-size', label: '.pager-size（每页条数下拉）', token: '--glass-control',
    pages: ['笔记与附件', '网址管理 · 列表视图'] },
  // 标签胶囊（扫描在笔记页抓到 24 个实底白片，1.32.2 一并补玻璃）
  { sel: '.chip', label: '.chip（笔记页标签胶囊）', token: '--glass-input', pages: ['笔记与附件'] },
];

/**
 * 要扫的页面与进入方式（都不依赖网络/账号：网址管理用预置样本条目，工具箱与笔记是本地页）。
 * `min`：该页「必须有多少个内容元素」才算真的渲染出来了 —— 空页面扫出 0 违规是假绿，
 *       这一轮就是被这个坑过一次（临时脚本没造条目 → 列表空 → 斑马纹行根本不存在，扫不出来）。
 * 命中不到的，按违规处理（见下面的自证检查），不允许「页面没内容所以 0 违规」混过去。
 *
 * ⚠️ 1.32.2（t1）加 `pagers` 的来由：分页条 .pager 只有在「超过一页」时才渲染
 *    （Dashboard 是 filteredEntries.length > pageSize，默认 10 条/页；
 *      笔记页是 filtered.length > pageSize，默认 24 条/页）。
 *    之前只造 2 条数据 → 分页条根本没出现在 DOM 里 → 「.pager 是白板」这件事
 *    **扫描门禁完全盖不到**，exit=0 也没证明任何东西。现在网址管理与笔记都造到 ≥2 页，
 *    并把 `.pager` 计数写进自证行（< 1 直接红）。
 */
const PAGES = [
  {
    label: '网址管理 · 列表视图', nav: '网址管理', prep: (s) => clickText(s, '列表'),
    // 25 条样本 / 每页 10 条 = 3 页，分页条必须渲染出来
    min: { cards: 0, rows: 1, pagers: 1 }, hint: 'pagers=0 说明没超过一页，分页条没渲染 = 这一页没真的扫到',
  },
  { label: '网址管理 · 卡片视图', nav: '网址管理', prep: (s) => clickText(s, '卡片'), min: { cards: 1, pagers: 1 } },
  { label: '工具箱', nav: '工具箱' },
  // 25 条笔记 / 每页 24 条 = 2 页（笔记页的 .pager 是独立元素，玻璃档位在这里量）
  {
    label: '笔记与附件', nav: '笔记与附件', min: { pagers: 1 },
    hint: 'pagers=0 说明笔记没超过一页（默认 24 条/页），分页条没渲染',
  },
  // 1.30.2 新增的 SQL 片段独立页：KPI 三卡（复用 .home-stat）+ 标签栏（.tag-sidebar-item）
  // + 表格（.sql-table，2 条样本条目才会渲染行）都要出现，缺一个就说明这一页没真的扫到。
  {
    label: 'SQL 片段',
    nav: 'SQL 片段',
    min: { stats: 3, tagItems: 2, sqlRows: 2 },
    hint: '若 sqlRows=0，多半是落进了「目录模式」（该模式只渲染提示、不渲染表格）',
  },
];

/**
 * 页面内扫描：遍历 body 起的全部元素，收集「可见 + 面积 > 阈值 + 背景全不透明」的块。
 * 只取前 40 个（按面积降序），避免某个极端页面把输出刷爆。
 */
const SCAN_EXPR = `(() => {
  const AREA_MIN = ${AREA_MIN};
  const ALPHA_OPAQUE = ${ALPHA_OPAQUE};
  // 页面「有没有内容」的自证：空页面扫出 0 违规毫无意义，所以把这几项的条数一起带回去
  const ctx = { theme: document.documentElement.dataset.theme, bg: document.documentElement.dataset.bg,
    cards: document.querySelectorAll('.entry-card').length,
    rows: document.querySelectorAll('.entry-table tbody tr').length,
    badges: document.querySelectorAll('.env-badge, .env-badge-table').length,
    primaryBtns: document.querySelectorAll('.btn-primary, .btn-add, .btn-empty-add').length,
    kbds: document.querySelectorAll('kbd').length,
    // SQL 片段独立页专用（1.30.2）：KPI 卡 / 标签栏项 / 表格行
    stats: document.querySelectorAll('.home-stat').length,
    tagItems: document.querySelectorAll('.tag-sidebar-item').length,
    sqlRows: document.querySelectorAll('.sql-table tbody tr').length,
    // 分页条（1.32.2）：通用组件 .pager 只有超过一页才渲染，这一项是「这一页真的翻页了」的自证
    pagers: document.querySelectorAll('.pager').length,
    pagerCur: (document.querySelector('.pager .pager-cur') || {}).textContent || '',
    pagerInfo: (document.querySelector('.pager .pager-info') || {}).textContent || '' };
  // Chromium 的 computed backgroundColor 有两种序列化：rgba(r, g, b, a) 与 color(srgb r g b / a)
  const alphaOf = (c) => {
    const s = String(c || '').trim();
    if (!s || s === 'transparent') return 0;
    let m = s.match(/\\/\\s*([\\d.]+)\\s*\\)/);
    if (m) return Number(m[1]);
    m = s.match(/^rgba?\\(([^)]*)\\)$/);
    if (m) {
      const parts = m[1].split(/[,\\s/]+/).filter(Boolean);
      return parts.length > 3 ? Number(parts[3]) : 1;
    }
    return 1;
  };
  const out = [];
  const walk = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    const bg = cs.backgroundColor;
    if (area > AREA_MIN && alphaOf(bg) >= ALPHA_OPAQUE) {
      const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
      out.push({ cls: String(cls || '').replace(/\\s+/g, ' ').trim(), tag: el.tagName, id: el.id || '',
        bg, w: Math.round(r.width), h: Math.round(r.height), area: Math.round(area) });
    }
    for (const c of el.children) walk(c);
  };
  // 从 body 起（不含 html：html 的底色被 .app-bg 的图盖住，报它只会制造噪声）
  walk(document.body);
  return { ctx, rows: out.sort((a, b) => b.area - a.area).slice(0, 40) };
})()`;

/**
 * 量目标类：命中数 + computed backgroundColor + 面积；带 token 时额外验「背景是不是真的来自那条玻璃规则」。
 *
 * 为什么要 token 溯源（1.32.2 t1）：.pager 的基础底色是
 * `color-mix(in srgb, var(--bg-input) 35%, transparent)`，alpha 天生 0.35 < 1。
 * 只看「alpha < 1」的话，把玻璃规则整条注释掉它照样过 —— 门禁等于没装。
 * 做法：在**目标元素的同一个父节点**下插一个 0×0 的探针元素，让它把同样的 var(--glass-*)
 * 解析成 computed 颜色（同一继承上下文，深浅主题 / 作用域覆盖都一致），再和目标的
 * computed backgroundColor **逐字符比较**。相等 = 背景确实来自这条规则；
 * 不等 = 落回了基础色或别的规则，直接红。
 *
 * @param {string} sel 目标选择器
 * @param {string} [token] 期望来源的 CSS 变量（如 '--glass-side'）
 * @returns {string} 在页面里执行的表达式
 */
const targetExpr = (sel, token) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const vis = els.filter((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width * r.height > 0;
  });
  if (!vis.length) return { found: 0 };
  const el = vis[0];
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const out = { found: vis.length, bg: cs.backgroundColor, w: Math.round(r.width), h: Math.round(r.height),
    area: Math.round(r.width * r.height), cls: String(el.className || '') };
  const token = ${JSON.stringify(token || '')};
  if (token) {
    // 探针挂在目标元素自己的父节点上：.pager 在 .pnl / .pm-pager-wrap 里都可能被作用域规则覆盖，
    // 挂到 body 上量到的 token 值和目标位置不一定同源
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;'
      + 'background-color:var(' + token + ')';
    (el.parentNode || document.body).appendChild(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    out.token = token;
    out.tokenBg = want;
    out.tokenMatch = cs.backgroundColor === want;
  }
  return out;
})()`;

/**
 * 量压暗遮罩 .app-bg-dim 的**实际** opacity：
 * 浅色主题下它应当是「设置值 × 0.67」（白遮罩减淡，见 redesign.css 里 1.32.0 的注释），
 * 深色主题保持设置值（黑遮罩是压暗，不需要折）。
 */
const DIM_EXPR = `(() => {
  const el = document.querySelector('.app-bg-dim');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  return { found: true, opacity: Number(cs.opacity), bg: cs.backgroundColor,
    setting: getComputedStyle(document.documentElement).getPropertyValue('--bg-dim').trim(),
    theme: document.documentElement.dataset.theme };
})()`;

/**
 * class 名按空白切词后精确匹配（避免 `.foo` 命中 `.foo-bar` 这种子串误判）
 * @param {string} cls className 原文
 * @param {string} word 目标类名
 * @returns {boolean} 是否包含该类
 */
function hasWord(cls, word) {
  return String(cls || '').split(/\s+/).includes(word);
}

/**
 * 取颜色 alpha（与页面内同一套规则，用于 node 侧复核 4 个目标类）
 * @param {string} c computed 颜色字符串
 * @returns {number} alpha（0~1）
 */
function alphaOf(c) {
  const s = String(c || '').trim();
  if (!s || s === 'transparent') return 0;
  let m = s.match(/\/\s*([\d.]+)\s*\)/);
  if (m) return Number(m[1]);
  m = s.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    return parts.length > 3 ? Number(parts[3]) : 1;
  }
  return 1;
}

/**
 * 归类一个不透明块：命中白名单返回该条理由，否则返回 null
 * @param {{cls: string, tag: string}} e 扫描到的元素
 * @returns {object|null} 白名单条目
 */
function whitelistOf(e) {
  return WHITELIST.find((w) => w.test(e)) || null;
}

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const { dataDir, backgroundName } = prepareDataDir({
    prefix: 'pm-opaque-data-', casesRoot: true, background: { srcFile: BG_FIXTURE, name: 'bg-opaque.png' },
  });
  const handle = await launch({ port: 9841, dataDir });
  const session = await waitForWindow(handle);
  const { ev } = session;
  /** 本轮全部违规（白名单外的不透明块） */
  const violations = [];
  /** 4 个目标类在每套主题下的实测值 */
  const measured = {};
  /** 压暗遮罩在每套主题下的实测 opacity */
  const dim = {};
  let scanned = 0;

  try {
    await ensureUnlocked(session);
    // 预置样本：没有条目时列表/卡片页是空状态，扫的是「空页面」，漏的块反而看不到。
    // 只造能渲染出卡片/行/环境徽标/表格行/分页条的最小字段，不含任何真实账号口令。
    // ⚠️ 1.32.2（t1）：造数量必须**超过一页**，否则 .pager 根本不进 DOM（见 PAGES 的注释）。
    //   - 网址清单 entries：25 条（默认 10 条/页 → 3 页），envType 轮转三种环境，环境徽标继续有样本；
    //   - 笔记 notes：25 条 kind='note'（笔记页一页 24 条 → 2 页）+ 2 条 kind='sql'
    //     （SQL 片段页的 KPI 三卡 / 标签栏 / 表格行；其中一条故意给超长库名，
    //       让「库/环境列定宽 + 省略号」也在扫描范围内）。
    // 全部走 app 自己的通道（entries:add / ws:set），跑完在 finally 里按 id 前缀 opaque 清理，并打印前后条数。
    const seed = await ev(`(async () => {
      const now = Date.now();
      const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
      const envs = [['production', '生产'], ['testing', '测试'], ['staging', '预发布']];
      const before = await window.electronAPI.entriesGetAll();
      const beforeList = (before && before.success && before.data && Array.isArray(before.data.entries))
        ? before.data.entries : [];
      const ENTRIES = 25;
      for (let i = 1; i <= ENTRIES; i += 1) {
        const [envType, envLabel] = envs[i % envs.length];
        await window.electronAPI.entriesAdd({ id: 'opaque-entry-' + i,
          name: '背景样本 ' + String(i).padStart(2, '0') + ' · ' + envLabel,
          username: 'user-' + i, url: 'https://example.com/entry/' + i, note: '',
          tags: [], envType, updatedAt: iso(i) });
      }
      const cur = await window.electronAPI.wsGet('notes');
      const kept = ((cur && cur.success && Array.isArray(cur.data)) ? cur.data : [])
        .filter((n) => !String(n && n.id || '').startsWith('opaque-'));
      const notes = [];
      for (let i = 1; i <= 25; i += 1) {
        notes.push({ id: 'opaque-note-' + i, kind: 'note',
          title: '背景样本笔记 ' + String(i).padStart(2, '0'),
          content: '第 ' + i + ' 条样本正文，用来把笔记页的分页条撑到第 2 页。',
          tags: ['造数'], updatedAt: iso(i + 120) });
      }
      const sql = [
        { id: 'opaque-sql-1', kind: 'sql', title: '查某天未支付的订单', dbOrEnv: 'test_order / 预发',
          tags: ['造数', '订单'], starred: true, content: "SELECT * FROM t_order WHERE created_at >= '{{today}}';",
          varHint: '{{today}} = 今天 0 点', remark: '造数后回滚', updatedAt: iso(0) },
        { id: 'opaque-sql-2', kind: 'sql', title: '统计各环境接口平均耗时', dbOrEnv: 'perf_log / 压测库-独立实例-只读副本（故意很长）',
          tags: ['性能'], starred: false, content: 'SELECT 2;', varHint: '', remark: '', updatedAt: iso(1) },
      ];
      await window.electronAPI.wsSet('notes', [...kept, ...notes, ...sql]);
      const after = await window.electronAPI.entriesGetAll();
      const afterList = (after && after.success && after.data && Array.isArray(after.data.entries))
        ? after.data.entries : [];
      return { entriesBefore: beforeList.length, entriesAfter: afterList.length,
        notesBefore: kept.length, notesAfter: kept.length + notes.length + sql.length,
        notes: notes.length, sql: sql.length }; })()`);
    console.log(`\n（造数）entries ${seed.entriesBefore} → ${seed.entriesAfter} 条（+${seed.entriesAfter - seed.entriesBefore}）`
      + ` / notes ${seed.notesBefore} → ${seed.notesAfter} 条（普通笔记 +${seed.notes}、SQL +${seed.sql}）`
      + ' —— 分页条必须渲染出来，否则下面的自证会红');
    const saved = await applyBackground(session, {
      name: backgroundName,
      // 压暗取默认 0.42（浅色下 CSS 会再乘 0.67）：扫描要按用户的实际默认配置来
      settings: { backgroundOpacity: 0.32, backgroundBlur: 8, backgroundDim: 0.42, backgroundAutoAccent: true, backgroundAccent: '' },
    });
    if (!saved || !saved.success) throw new Error(`settingsSave 失败：${JSON.stringify(saved)}`);
    await reloadPage(session, { settleMs: 2400 });
    await ensureUnlocked(session);

    // data-bg 是异步链写上去的（settingsSave → bg:get → <img> load → applyBackground）。
    // 等不到就直接判失败：没有 data-bg=image 时玻璃规则一条都不生效，扫出来的「全不透明」是假象。
    const bgOk = await session.waitFor({ expr: `document.documentElement.dataset.bg === 'image'` }, { timeout: 10000, throwOnTimeout: false });
    if (bgOk !== true) {
      throw new Error(`等 10s 仍未进入 data-bg=image（读到 ${await ev(`document.documentElement.getAttribute('data-bg')`)}），`
        + '玻璃规则没生效，这次扫描没有意义');
    }

    for (const theme of THEMES) {
      await setTheme(session, theme);
      console.log(`\n════════ 主题 ${theme}（html[data-bg='image']）`);
      for (const page of PAGES) {
        const ok = await navTo(session, page.nav, { timeout: 15000 });
        if (!ok) throw new Error(`导航不到「${page.nav}」`);
        if (page.prep) { await page.prep(session); await sleep(700); } else { await sleep(600); }
        // ⚠️ 主题必须在「导航之后」再钉一次：渲染层有些动作会按 settings.theme 重新 applyTheme
        // （实测：从网址管理切到工具箱时，data-theme 被写回设置里的 'dark'），
        // 只在外层 setTheme 一次，后面那些页面量的其实是深色 —— 标签写着 light 却测深色，是假绿。
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await setTheme(session, theme);
          await sleep(250);
          const probe = await ev(`document.documentElement.dataset.theme`);
          if (probe === theme) break;
          if (attempt === 1) throw new Error(`无法把 data-theme 固定成 ${theme}（实读 ${probe}），本次扫描不可信`);
        }
        const { ctx, rows } = await ev(SCAN_EXPR);
        scanned += 1;
        if (ctx.theme !== theme || ctx.bg !== 'image') {
          throw new Error(`${page.label} 扫描时的页面状态不对：data-theme=${ctx.theme} / data-bg=${ctx.bg}`
            + `（期望 ${theme} / image）`);
        }
        // 页面内容自证：空页面扫出 0 违规是没有意义的绿。
        // 除了打印条数，还要**卡住下限**（page.min）：SQL 片段页要求有 KPI 卡 / 标签栏项 / 表格行，
        // 分页页要求 .pager 真的渲染出来，拿不到就按违规处理，
        // 不允许「页面没渲染出来 → 0 违规」混成绿。
        const ctxLine = `  · 页面自证：主题 ${ctx.theme} / 背景 ${ctx.bg} / 卡片 ${ctx.cards} / 列表行 ${ctx.rows}`
          + ` / 环境徽标 ${ctx.badges} / 主按钮 ${ctx.primaryBtns} / KBD ${ctx.kbds}`
          + ` / KPI 卡 ${ctx.stats} / 标签栏项 ${ctx.tagItems} / SQL 行 ${ctx.sqlRows}`
          + ` / 分页条 ${ctx.pagers}${ctx.pagers ? `（${String(ctx.pagerCur).trim()} · ${String(ctx.pagerInfo).trim()}）` : ''}`;
        const minFail = [];
        for (const [key, min] of Object.entries(page.min || {})) {
          const got = Number(ctx[key]) || 0;
          if (got < min) minFail.push(`${key}=${got} < ${min}`);
        }
        const bad = [];
        const good = [];
        for (const r of rows) {
          const w = whitelistOf(r);
          if (w) good.push({ r, w }); else bad.push(r);
        }
        console.log(`\n──── ${page.label}：不透明块 ${rows.length} 个（白名单 ${good.length} / 违规 ${bad.length}）`);
        console.log(ctxLine);
        if (minFail.length) {
          console.log(`  \u2717 页面自证不足：${minFail.join('，')}${page.hint ? `（${page.hint}）` : ''}`);
          violations.push({ theme, page: page.label, cls: `(页面自证不足 ${minFail.join(',')})`, bg: '-', w: 0, h: 0, area: 0 });
        }
        for (const { r, w } of good) {
          console.log(`  \u2713 ${pad(r.area, 7)} ${pad(`${r.w}×${r.h}`, 11)} ${pad(r.bg, 26)} ${r.cls || r.tag}`);
          console.log(`      ↑ 白名单「${w.id}」：${w.why}`);
        }
        for (const r of bad) {
          console.log(`  \u2717 ${pad(r.area, 7)} ${pad(`${r.w}×${r.h}`, 11)} ${pad(r.bg, 26)} ${r.cls || r.tag}`);
          violations.push({ theme, page: page.label, ...r });
        }
        if (bad.length) console.log(`      ↑ 白名单外的不透明块：在 redesign.css 的 html[data-bg=\'image\'] 段补一条玻璃底，`);
        if (bad.length) console.log(`        或（确实是「本应实心」）加进本脚本的 WHITELIST 并写清理由`);

        // 目标类：谁在当前页面出现就量谁（记录每套主题的第一次实测）。
        // t.pages 限定只在指定页面量：.pager 在网址管理里被 .pm-pager-wrap 包着、内层故意
        // transparent，量到它会得出「背景和后端 token 不一致」的假红 —— 所以 .pager 只在笔记页量。
        for (const t of TARGETS) {
          if (Array.isArray(t.pages) && !t.pages.includes(page.label)) continue;
          const m = await ev(targetExpr(t.sel, t.token));
          if (!m || !m.found) continue;
          const key = `${theme}`;
          measured[t.label] = measured[t.label] || {};
          if (!measured[t.label][key]) measured[t.label][key] = { ...m, page: page.label };
        }
        // 压暗遮罩的实测 opacity：每套主题记第一次（页面不换它，取一次就够）
        if (!dim[theme]) {
          const d = await ev(DIM_EXPR);
          if (d && d.found) dim[theme] = { ...d, page: page.label };
        }
      }
    }

    // ── 压暗遮罩：浅色下应当是「设置值 × 0.67」（1.32.0 修的白雾冲淡图） ──
    console.log('\n════════ 压暗遮罩 .app-bg-dim 的实际 opacity（浅色 = 设置值 × 0.67，深色 = 设置值）');
    for (const theme of THEMES) {
      const d = dim[theme];
      if (!d) {
        violations.push({ theme, page: '(未出现)', cls: '.app-bg-dim', bg: '-', w: 0, h: 0, area: 0 });
        console.log(`  \u2717 ${pad(theme, 6)} 页面上没有 .app-bg-dim，无法证明压暗层生效`);
        continue;
      }
      const setting = Number(d.setting);
      const expect = theme === 'light' ? setting * 0.67 : setting;
      const okDim = Number.isFinite(setting) && Math.abs(d.opacity - expect) <= 0.002;
      const formula = theme === 'light'
        ? `设置值 ${setting} × 0.67 = ${expect.toFixed(4)}，实测 ${d.opacity}`
        : `设置值 ${setting}（深色不折），实测 ${d.opacity}`;
      if (okDim) console.log(`  \u2713 ${pad(theme, 6)} opacity=${d.opacity}  ${pad(d.bg, 22)} ${formula}`);
      else {
        violations.push({ theme, page: d.page, cls: '.app-bg-dim opacity', bg: d.bg, w: 0, h: 0, area: 0 });
        console.log(`  \u2717 ${pad(theme, 6)} opacity=${d.opacity}  ${pad(d.bg, 22)} 期望 ${expect.toFixed(4)}（${formula}）`);
      }
    }

    // ── 补漏类的实测值（验收锚点：找到了 + alpha < 1 + 背景确实来自指定的玻璃 token） ──
    console.log('\n════════ 补漏类的实测 backgroundColor（要求 alpha < 1；带 token 的要求背景 = 该 token 的 computed 值）');
    for (const theme of THEMES) {
      for (const t of TARGETS) {
        const m = measured[t.label] && measured[t.label][theme];
        const label = pad(t.label, 34);
        if (!m) {
          violations.push({ theme, page: '(未出现)', cls: t.label, bg: '-', w: 0, h: 0, area: 0, missing: true });
          console.log(`  \u2717 ${pad(theme, 6)} ${label} 页面上没找到这类元素，无法证明已玻璃化`
            + (t.pages ? `（只在 ${t.pages.join(' / ')} 量）` : ''));
          continue;
        }
        const a = alphaOf(m.bg);
        // token 溯源：alpha < 1 只证明「半透明」，证明不了「这条玻璃规则在生效」
        // （.pager 的基础底色天生 alpha 0.35）。带 token 的锚点要求逐字符相等。
        const provOk = !t.token || m.tokenMatch === true;
        if (a < 1 && provOk) {
          const prov = t.token ? `  ← var(${t.token})` : '';
          console.log(`  \u2713 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a}  ${m.w}×${m.h}（${m.page}）${prov}`);
          continue;
        }
        violations.push({ theme, page: m.page, cls: t.label, bg: m.bg, w: m.w, h: m.h, area: m.area });
        if (a >= 1) {
          console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 仍然全不透明`);
        } else {
          console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 是半透明，但不是 var(${t.token})`
            + `（该 token 的 computed 值 ${m.tokenBg}）`);
          console.log('      ↑ 说明这条玻璃规则没命中：选择器被更具体的规则压掉，或规则被删/注释掉了');
        }
      }
    }
    if (session.errors.length) {
      console.log(`\n页面未捕获异常 ${session.errors.length} 条：${JSON.stringify(session.errors.slice(0, 3))}`);
      violations.push({ theme: '-', page: '-', cls: '(页面异常)', bg: '-', w: 0, h: 0, area: 0 });
    }
  } finally {
    // 清掉本轮造的数据（按 id 前缀删，不动用户自己的条目/笔记）：数据目录虽然是临时目录，
    // 但「造数不清」如果哪天换成复用目录就会污染下一次快照，所以这里显式收尾并打印前后条数。
    // 1.32.2（t1）起 entries 也造了 25 条，同样按前缀 opaque-entry- 删（permanent，不进回收站）。
    try {
      const cleaned = await ev(`(async () => {
        const cur = await window.electronAPI.wsGet('notes');
        const all = (cur && cur.success && Array.isArray(cur.data)) ? cur.data : [];
        const keepNotes = all.filter((n) => !String(n && n.id || '').startsWith('opaque-'));
        if (keepNotes.length !== all.length) await window.electronAPI.wsSet('notes', keepNotes);
        const got = await window.electronAPI.entriesGetAll();
        const entries = (got && got.success && got.data && Array.isArray(got.data.entries)) ? got.data.entries : [];
        const del = entries.filter((e) => String(e && e.id || '').startsWith('opaque-entry-')).map((e) => e.id);
        if (del.length) await window.electronAPI.entriesDelete({ ids: del, permanent: true });
        const after = await window.electronAPI.entriesGetAll();
        const entriesAfter = (after && after.success && after.data && Array.isArray(after.data.entries))
          ? after.data.entries.length : -1;
        return { notesBefore: all.length, notesAfter: keepNotes.length,
          entriesBefore: entries.length, entriesAfter, deleted: del.length }; })()`);
      if (cleaned) {
        console.log(`\n（收尾）清掉造的数据：entries ${cleaned.entriesBefore} → ${cleaned.entriesAfter} 条`
          + `（删 ${cleaned.deleted} 条）/ notes ${cleaned.notesBefore} → ${cleaned.notesAfter} 条`);
        if (cleaned.entriesAfter !== 0 || cleaned.notesAfter !== 0) {
          console.log('  ⚠️ 前缀 opaque- 的样本没清干净（应为 0），下次扫描前要检查通道是否还按 id 落盘');
          violations.push({ theme: '-', page: '(造数未清理)', cls: '.pager 扫描样本残留', bg: '-', w: 0, h: 0, area: 0 });
        }
      }
    } catch (e) {
      console.log(`\n（收尾）清样本失败（不影响判定）：${e && e.message}`);
    }
    stop(handle);
  }

  console.log(`\n扫描 ${scanned} 个「主题 × 页面」组合（面积 > ${AREA_MIN}px² 且背景 alpha >= ${ALPHA_OPAQUE} 计为不透明块）`);
  if (violations.length) {
    console.error(`\n\u2717 违规 ${violations.length} 条：`);
    for (const v of violations) {
      console.error(`    [${v.theme}] ${v.page}  ${v.w}×${v.h}(${v.area}px²)  ${v.bg}  ${v.cls}`);
    }
    console.error('\n  背景图模式下这些块会把图挡成白板。改法：在 src/styles/redesign.css 的');
    console.error("  html[data-bg='image'] 段给它们一条 var(--glass-*) 背景（容器不要加 backdrop-filter）。");
    setTimeout(() => process.exit(1), 200);
    return;
  }
  console.log('\n\u2713 0 违规：白名单外没有 alpha=1 且面积 > 600 的块，补漏类都是半透明（带 token 的还验了背景来源）');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error(`\n\u2717 扫描失败：${e && e.message}`);
  try { stop(null); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(1), 200);
});
