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
 * ⚠️ 1.32.3（t4）两条改动（依据 docs/agents/glass-scan-modal-plan.md）：
 *
 *   1) 修首屏「页面自证不足 rows=0」竞态（原来连跑 2 次都红在
 *      `[light] 网址管理 · 列表视图`）。根因不在数据、也不在造数，而是**两个条件叠在一起**：
 *      · `lib/app.js` 的 navTo() 完成条件是
 *        `!document.querySelector('.page-loading') && !!document.querySelector('.pg')` ——
 *        前半 `.page-loading` **全仓库不存在**（恒真），后半 `.pg` 又被 PageSkeleton
 *        （`<div className="pg">`，App.tsx 的 Suspense fallback）满足；
 *        于是 navTo 在**骨架屏阶段**就返回（实测骨架 65ms→365ms，navTo ~326ms 返回）。
 *      · 紧接着的 `prep`（点「列表 / 卡片」切换视图）在骨架屏上**找不到按钮**，
 *        clickText 返回 false —— 而旧代码把返回值丢了，只 sleep(700) 了事。
 *        结果页面停在默认「卡片」视图，`rows` 恒 0 → 自证判据 `rows>=1` 红。
 *      修法：navTo 之后按页等「真就绪」（骨架屏消失 + 控件/内容到位，10s 超时并写清等什么/等多久），
 *      prep 返回 false 直接失败，prep 生效再等 5s；扫描前要求「两次采样签名一致」；
 *      固定 sleep(700)/sleep(600) 删除（不是因为「等得不够久」，是因为等错了东西）。
 *      ⚠️ 就绪判据**不能只写 rows>=1**：网址管理默认视图是卡片，卡片视图下 rows 恒 0，
 *      而「切到列表」正是下一步 prep 要做的事 —— 用结果等前置条件会死锁。
 *      实际判据取**视图无关**的一条：骨架屏消失 + 工具栏 + 三个视图按钮 +（卡片或行）>=1 + 分页条。
 *
 *   2) 新增「复制弹窗」扫描步骤：进「SQL 片段」页 → 点开带 {{变量}} 那行的复制入口 →
 *      按同一判据扫 `.modal` 子树（深浅两套主题各一次），并量 `pre.sql-var-preview` 的
 *      computed backgroundColor 当锚点（必须 = var(--glass-input-soft)）。
 *      为什么必须开弹窗扫：1.31.x 那两块实底（`.code2` 预览块 478×47、`.modal-footer` 518×67）
 *      就是「扫描从来不开弹窗」漏掉的 —— 不开弹窗，弹窗里的任何实底都不在门禁视野里。
 *      白名单**不新增条目**：弹窗子树里唯一的不透明块是底栏「替换并复制」（`.btn-primary`），
 *      命中既有条目；如果将来别的块变实底，门禁就该红，不许靠扩白名单消红。
 *
 *   3) 测量前先把 CSS 动画**收尾**（`document.getAnimations().forEach(a => a.finish())`）。
 *      来历是 t4 的第 2 次实跑：同一份脚本第 1 次 12/15 个白名单块、第 2 次每页只剩 1 个，
 *      而弹窗的 `computed opacity` 连续 10s 都是 0（inputs/preLen 都在，就是不可见）。
 *      根因不是脚本等得不够久：**窗口被遮挡/合成器被节流时，CSS 动画（fadeIn / modalIn）
 *      会停在起始帧**（动画从 opacity:0 起），而 walk 对 `opacity === 0` 的容器是「整棵子树跳过」，
 *      于是页面看起来「什么都没有」→ 白名单块全漏、弹窗永远「没打开」。
 *      用 CDP 把动画时间线钉死（Animation.setPlaybackRate=0）可以稳定复现：
 *      列表页 1 个块 / 弹窗 opacity 0；`finish()` 之后立刻回到 12 个块 / opacity 1。
 *      所以每次判定前（就绪后、prep 后、弹窗打开后、扫描前）都先 finish 一遍 ——
 *      它把动画推到**最终帧**（就是用户 0.2s 后看到的那个状态），比「等动画播完」可靠，也不改判据。
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
/** 「页面/弹窗真的渲染出来」的最长等待（超时即失败，消息里写清等什么、等了多久） */
const READY_TIMEOUT = 10000;
/** prep 点击后「视图真的切过去了」的最长等待 */
const APPLY_TIMEOUT = 5000;
/** 「扫描前页面稳定」的上限：连续两次采样签名一致才算稳定 */
const STABLE_TIMEOUT = 4000;
/** 条件轮询间隔（不是「等这么久再判定」，是「隔这么久再问一次」） */
const POLL_MS = 100;
/** 稳定性采样间隔 */
const STABLE_POLL_MS = 150;

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
      + '它尺寸小（单个按钮面积多在 600 上下），挡不住图。'
      + '弹窗里的「替换并复制」也是这一类（实测 93×34 = 3162px²，1.32.3 开弹窗扫描后命中的就是它）',
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
 * 每页「真的渲染出来了」的判据（1.32.3 / t4）。
 *
 * 为什么要按页写死、而不是复用 navTo 的完成条件：navTo 的 `!!document.querySelector('.pg')`
 * 会被 PageSkeleton 的 `.pg` 满足，它在骨架屏阶段就返回（见文件头 1.32.3 段）。
 * 为什么要「骨架屏消失 + 工具栏 + 三个视图按钮 +（卡片或行）>=1 + 分页条」而不是只等 rows>=1：
 * 网址管理默认是卡片视图，rows 恒 0，而「切到列表」是下一步 prep 的动作 —— 等它会死锁。
 *
 * 表达式返回 { ok, state }，state 会原样打进日志（失败时能看出到底缺哪一项）。
 */
const READY_PRED = {
  // 列表 / 卡片共用：骨架屏没了、工具栏在了、三个视图按钮齐了、有内容（卡片或行）、分页条渲染了
  '网址管理 · 列表视图': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const state = { skel: !!document.querySelector('.page-skel'), toolbar: !!document.querySelector('.toolbar'),
      swBtn: q('.view-switch-btn'), cards: q('.entry-card'), rows: q('.entry-table tbody tr'), pagers: q('.pager') };
    const ok = !state.skel && state.toolbar && state.swBtn === 3
      && (state.cards >= 1 || state.rows >= 1) && state.pagers >= 1;
    return { ok, state };
  })()`,
  '网址管理 · 卡片视图': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const state = { skel: !!document.querySelector('.page-skel'), toolbar: !!document.querySelector('.toolbar'),
      swBtn: q('.view-switch-btn'), cards: q('.entry-card'), rows: q('.entry-table tbody tr'), pagers: q('.pager') };
    const ok = !state.skel && state.toolbar && state.swBtn === 3
      && (state.cards >= 1 || state.rows >= 1) && state.pagers >= 1;
    return { ok, state };
  })()`,
  '工具箱': `(() => {
    const state = { skel: !!document.querySelector('.page-skel'), tbHead: !!document.querySelector('.tb-main-head') };
    return { ok: !state.skel && state.tbHead, state };
  })()`,
  '笔记与附件': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const state = { skel: !!document.querySelector('.page-skel'), pagers: q('.pager'), chips: q('.chip') };
    return { ok: !state.skel && (state.pagers >= 1 || state.chips >= 1), state };
  })()`,
  'SQL 片段': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const state = { skel: !!document.querySelector('.page-skel'), stats: q('.home-stat'),
      tagItems: q('.tag-sidebar-item'), sqlRows: q('.sql-table tbody tr') };
    return { ok: !state.skel && state.stats === 3 && state.sqlRows >= 2, state };
  })()`,
};

/**
 * prep 点完之后「视图真的切过去了」的判据（1.32.3 / t4）。
 * 旧代码只看 clickText 的返回值、还把它丢了：点在骨架屏上 → 什么都没发生，日志里却和成功一模一样。
 */
const APPLIED_PRED = {
  '网址管理 · 列表视图': `(() => {
    const on = document.querySelector('.view-switch-btn.is-on');
    const state = { on: on ? on.textContent.trim() : '', rows: document.querySelectorAll('.entry-table tbody tr').length };
    return { ok: state.on === '列表' && state.rows >= 1, state };
  })()`,
  '网址管理 · 卡片视图': `(() => {
    const on = document.querySelector('.view-switch-btn.is-on');
    const state = { on: on ? on.textContent.trim() : '', cards: document.querySelectorAll('.entry-card').length };
    return { ok: state.on === '卡片' && state.cards >= 1, state };
  })()`,
};

/**
 * 扫一条样本页（1.32.3）：`rootSel` 决定从哪儿开始遍历。
 * 页面扫描传 `document.body`，弹窗扫描传 `document.querySelector('.modal')`（只扫弹窗子树）。
 *
 * 判据与 1.32.0 完全一致：可见 && backgroundColor alpha >= 0.999 && 面积 > 600px²。
 * ctx 里的计数是「页面有没有内容」的自证，空页面扫出 0 违规没有意义。
 *
 * @param {string} rootSel 扫描根（页面内执行的 JS 表达式）
 * @returns {string} 在页面里执行的表达式
 */
const buildScanExpr = (rootSel) => `(() => {
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
  const root = ${rootSel};
  if (!root) return { ctx, rows: out, missingRoot: true };
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
  // 页面扫描从 body 起（不含 html：html 的底色被 .app-bg 的图盖住，报它只会制造噪声）
  walk(root);
  return { ctx, rows: out.sort((a, b) => b.area - a.area).slice(0, 40) };
})()`;

/** 页面扫描（body 起） */
const SCAN_EXPR = buildScanExpr('document.body');
/** 弹窗扫描（只在 .modal 子树里走，1.32.3 新增） */
const MODAL_SCAN_EXPR = buildScanExpr("document.querySelector('.modal')");

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

/* ════════════════════════════════════════════════════════════════════
 * 1.32.3（t4）「复制弹窗」扫描（E 片）
 * ----------------------------------------------------------------
 * 为什么单独一段：`.modal` 是**portal 到 body 的节点**，只有弹窗打开时才存在；
 * 1.32.0~1.32.2 的扫描从来不开弹窗，于是弹窗里的实底（1.31.x 修过的 `.code2` 预览块
 * 478×47、`.modal-footer` 518×67）**根本不在门禁视野里**。这一段把「开弹窗 → 扫 .modal」固化下来。
 * ════════════════════════════════════════════════════════════════════ */

/** 造数里那条带变量的样本标题（与 seed 里 opaque-sql-1 的 title 必须一致） */
const COPY_SNIPPET_TITLE = '查某天未支付的订单';

/**
 * 打开复制弹窗：找到带 {{变量}} 的那一行 → 点行内「复制」图标按钮。
 * 定位失败要**明确失败**（返回 ok:false + 原因），不允许静默跳过 —— 跳过等于这一段的门禁没装。
 */
const OPEN_COPY_MODAL_EXPR = `(() => {
  const TITLE = ${JSON.stringify(COPY_SNIPPET_TITLE)};
  const rows = [...document.querySelectorAll('.sql-table tbody tr')];
  if (!rows.length) return { ok: false, why: 'SQL 表格里没有行（可能落进了目录模式）', rows: 0 };
  const row = rows.find((r) => (r.textContent || '').includes(TITLE))
    || rows.find((r) => r.querySelector('button[title*="复制"]'));
  if (!row) return { ok: false, why: '没有找到带「复制」入口的行', rows: rows.length };
  const btn = row.querySelector('button[title*="复制"]')
    || [...row.querySelectorAll('button')].find((b) => (b.title || '').includes('复制'));
  if (!btn) {
    return { ok: false, why: '这一行没有「复制」按钮', rows: rows.length,
      titles: [...row.querySelectorAll('button')].map((b) => b.title || (b.textContent || '').trim()) };
  }
  btn.click();
  return { ok: true, title: btn.title, rowText: (row.textContent || '').slice(0, 40) };
})()`;

/** 弹窗「挂上了」：只看 DOM 存在与尺寸（不判 opacity —— 进场动画可能停在起始帧，要先收尾动画） */
const MODAL_EXISTS_EXPR = `(() => {
  const m = document.querySelector('.modal');
  if (!m) return { ok: false, state: { modal: 0 } };
  const r = m.getBoundingClientRect();
  return { ok: r.width > 0 && r.height > 0,
    state: { modal: 1, w: Math.round(r.width), h: Math.round(r.height), opacity: Number(getComputedStyle(m).opacity) } };
})()`;

/** 弹窗「真的打开了」：宽度 > 0 + modalIn 动画结束（opacity===1）+ 变量输入框 + 预览有文本 */
const MODAL_READY_EXPR = `(() => {
  const m = document.querySelector('.modal');
  if (!m) return { ok: false, state: { modal: 0 } };
  const r = m.getBoundingClientRect();
  const cs = getComputedStyle(m);
  const pre = m.querySelector('pre.sql-var-preview');
  const inputs = m.querySelectorAll('.modal-body input:not([type=checkbox]):not([type=radio])').length;
  const state = { modal: 1, w: Math.round(r.width), h: Math.round(r.height), opacity: Number(cs.opacity),
    inputs, pre: !!pre, preLen: pre ? (pre.textContent || '').length : 0,
    theme: document.documentElement.dataset.theme };
  const ok = r.width > 0 && Number(cs.opacity) === 1 && inputs >= 1 && !!pre && state.preLen > 0;
  return { ok, state };
})()`;

/** 关掉弹窗（点右上角 ×） */
const CLOSE_MODAL_EXPR = `(() => {
  const b = document.querySelector('.modal .close-btn');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** 弹窗是否已经关掉（给 waitUntil 用） */
const MODAL_GONE_EXPR = `(() => ({
  ok: !document.querySelector('.modal'),
  state: { modal: document.querySelectorAll('.modal').length },
}))()`;

/**
 * 把当前所有 CSS 动画/过渡推到**最终帧**（1.32.3 / t4 第 2 次实跑修的那颗雷）。
 *
 * 为什么必须有它：窗口被遮挡 / 合成器被节流时，Chromium 会让 CSS 动画停在起始帧。
 * `fadeIn` 从 `opacity: 0` 起、`modalIn` 也从 `opacity: 0` 起，而扫描器对 `opacity === 0`
 * 的容器是整棵子树跳过 —— 于是「页面里什么都没有」被当成「0 违规」，弹窗则永远「没打开」。
 * 实测（CDP 把播放速率设为 0 复现）：列表页只数到 1 个块、弹窗 opacity=0；
 * `finish()` 之后立刻回到 12 个块、opacity=1。
 *
 * 注意：`finish()` 只对**有限时长**的动画有效；`pulse-border` 这类 infinite 动画会抛
 * InvalidStateError，这里按「跳过」处理（它只动边框色，不影响可见性/底色判定）。
 *
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {string} where 日志用的位置（「页面就绪后」「弹窗打开后」…）
 * @returns {Promise<{total: number, done: number, failed: number}>} 收尾统计
 */
async function settleAnimations(ev, where) {
  const r = await ev(`(() => {
    const list = document.getAnimations ? document.getAnimations() : [];
    let done = 0;
    let failed = 0;
    for (const a of list) { try { a.finish(); done += 1; } catch (e) { failed += 1; } }
    return { total: list.length, done, failed };
  })()`);
  // 只在真的收尾了动画时打一行（正常可见窗口里动画早就播完，不该刷屏）
  if (r && r.total > 0) {
    console.log(`  · 动画收尾（${where}）：${r.total} 个已推到最终帧（动画停在起始帧会让元素整棵子树被当成不可见）`);
  }
  return r || { total: 0, done: 0, failed: 0 };
}

/**
 * 弹窗锚点：面积判据会被窗口尺寸影响，这几个是确定性的验收点。
 * - 带 token 的：背景必须**逐字符等于**该 var(--glass-*) 的 computed 值（证明规则真的命中）；
 * - `.modal-footer` 的 token 是空串，另按「alpha === 0（透底 + border-top 分隔）」判。
 */
const MODAL_TARGETS = [
  { sel: '.modal', label: '.modal（弹窗面板）', token: '--glass-modal' },
  // 任务书点名的锚点：pre 的 computed backgroundColor 必须来自 var(--glass-input-soft)，
  // 实测值要打进输出（浅色 color(srgb 1 1 1 / 0.42) / 深色 … / 0.54）
  { sel: 'pre.sql-var-preview', label: 'pre.sql-var-preview（预览块）', token: '--glass-input-soft' },
  // 弹窗单行输入框：redesign.css:8203 的 `html[data-bg='image'] .modal .form-group > input` 是它的玻璃底；
  // 一旦有人把 input 再包一层 div，那条选择器就失效（CopyVarsModal 里有同款注释）。
  { sel: '.modal .modal-body .form-group > input', label: '弹窗变量输入框', token: '--glass-input' },
  { sel: '.modal-footer', label: '.modal-footer（底栏）', token: '' },
];

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

/**
 * 轮询条件表达式直到 ok（1.32.3 / t4）。
 *
 * **这是条件等待，不是固定 sleep**：页面快就立刻返回，页面慢就一直问到超时；
 * 超时抛错，消息里写清「等什么、等了多久、最后一次实测什么」。
 * 旧写法 `sleep(600/700)` 的毛病不是「等得不够久」，是「等错了东西」：
 * 首屏骨架屏 365ms 才换成真实页面，而 navTo 在 ~326ms 就返回了
 * （它的 `.pg` 条件被 PageSkeleton 满足，见文件头），点视图按钮必然落空。
 *
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {string} expr 返回 { ok, state } 的表达式
 * @param {{timeout?: number, label: string}} opts label 用于失败文案（「等什么」）
 * @returns {Promise<{ms: number, state: any}>} 等到时返回耗时与最后一次 state
 * @throws {Error} 超时：消息含 label、timeout、最后一次实测 state
 */
async function waitUntil(ev, expr, opts) {
  const timeout = opts.timeout || READY_TIMEOUT;
  const label = opts.label || expr;
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await ev(expr);
    if (last && last.ok) return { ms: Date.now() - t0, state: last.state };
    await sleep(POLL_MS);
  }
  throw new Error(`等 ${timeout}ms「${label}」仍未就绪；最后一次实测 ${JSON.stringify(last)}`);
}

/**
 * 扫描前要求「页面稳定」：同一份签名连续两次相同才认定稳定（1.32.3 / t4）。
 *
 * 为什么需要它：实测同一页两次跑到的不透明块数是 1 和 12 —— 元素在 DOM 里（自证行写「环境徽标 10」），
 * 但 `getBoundingClientRect()` 还没量出尺寸（面积 0 → 判据不成立 → 漏判）。
 * 这就是「扫在重排中间」的假绿。签名 = 不透明块列表（class/尺寸/颜色）+ 自证计数。
 *
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {string} expr 扫描表达式
 * @param {(res: any) => string} sigFn 从扫描结果提取签名
 * @param {string} label 用于失败文案
 * @returns {Promise<{res: any, samples: number, ms: number}>} 稳定后的扫描结果与采样信息
 * @throws {Error} STABLE_TIMEOUT 内一直不稳定
 */
async function stableScan(ev, expr, sigFn, label) {
  let prevSig = '';
  let last = null;
  let samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < STABLE_TIMEOUT) {
    last = await ev(expr);
    samples += 1;
    const sig = sigFn(last);
    if (sig === prevSig) return { res: last, samples, ms: Date.now() - t0 };
    prevSig = sig;
    await sleep(STABLE_POLL_MS);
  }
  throw new Error(`「${label}」${STABLE_TIMEOUT}ms 内页面没稳定（采样 ${samples} 次，签名一直在变），`
    + '扫描结果不可信（多半还在重排 / 换视图 / 布局未完成）');
}

/** 页面扫描的稳定性签名：不透明块列表 + 页面自证计数 */
const pageSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.cards, res.ctx.rows, res.ctx.pagers]);

/** 弹窗扫描的稳定性签名：块列表 + 弹窗自证（输入框数 / 预览字数） */
const modalSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.modalInputs, res.ctx.preLen]);

/**
 * 等「页面真的渲染出来」+（有 prep 的）等「视图真的切过去了」（1.32.3 / t4）。
 * @param {object} session cdp 会话
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {object} page PAGES 里的一项
 * @returns {Promise<void>}
 */
async function waitPageReady(session, ev, page) {
  const readyExpr = READY_PRED[page.label];
  if (!readyExpr) {
    throw new Error(`没有为「${page.label}」定义就绪判据（READY_PRED）—— 新增页面时必须同时写一条，`
      + '否则又回到「navTo 返回就扫」的老毛病');
  }
  const ready = await waitUntil(ev, readyExpr, { timeout: READY_TIMEOUT, label: `${page.label} 渲染就绪` });
  console.log(`  · 就绪：等 ${ready.ms}ms（${JSON.stringify(ready.state)}）`);
  // 动画收尾：窗口被遮挡时入场动画会停在起始帧（opacity:0），而扫描对 opacity===0 的容器整棵子树跳过
  await settleAnimations(ev, '页面就绪后');
  if (!page.prep) return;
  const clicked = await page.prep(session);
  if (clicked !== true) {
    throw new Error(`「${page.label}」的 prep 点击落空：DOM 里没有可点的按钮（页面还在骨架屏时点会这样；`
      + '就绪判据刚刚才通过，说明判据漏了控件）');
  }
  const appliedExpr = APPLIED_PRED[page.label];
  if (!appliedExpr) {
    throw new Error(`「${page.label}」有 prep 但没有生效判据（APPLIED_PRED）`);
  }
  const applied = await waitUntil(ev, appliedExpr, { timeout: APPLY_TIMEOUT, label: `${page.label} prep 生效` });
  console.log(`  · prep 生效：等 ${applied.ms}ms（${JSON.stringify(applied.state)}）`);
  // 切视图会起新的入场动画，再收一次尾
  await settleAnimations(ev, 'prep 生效后');
}

/**
 * 扫一次「复制弹窗」：打开 → 钉主题 → 扫 .modal 子树 → 量锚点 → 关掉（1.32.3 / t4，E 片）。
 *
 * 判据与页面扫描完全一致（可见 && alpha >= 0.999 && 面积 > 600px²），只是根换成 `.modal`；
 * 白名单不新增条目（弹窗里唯一的不透明块是 `.btn-primary` 的「替换并复制」，命中既有条目）。
 *
 * @param {object} session cdp 会话
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {'light'|'dark'} theme 当前主题
 * @param {Array<object>} violations 违规收集数组（与页面扫描共用一个）
 * @returns {Promise<void>}
 */
async function scanCopyModal(session, ev, theme, violations) {
  const pageLabel = '复制弹窗（SQL 片段）';
  // 1) 进 SQL 片段页并等真就绪（目录模式 / 表格没渲染都会在这里红，不会静默跳过）
  const ok = await navTo(session, 'SQL 片段', { timeout: 15000 });
  if (!ok) throw new Error('导航不到「SQL 片段」');
  await waitPageReady(session, ev, PAGES.find((p) => p.label === 'SQL 片段'));

  // 2) 点开带 {{变量}} 那一行的复制入口
  const opened = await ev(OPEN_COPY_MODAL_EXPR);
  if (!opened || !opened.ok) {
    throw new Error(`找不到复制入口，弹窗扫不了：${JSON.stringify(opened)}`
      + '（造数里的样本标题/行内按钮 title 变了就会这样）');
  }
  const mounted = await waitUntil(ev, MODAL_EXISTS_EXPR, { timeout: 5000, label: '复制弹窗挂载（.modal 出现且有尺寸）' });
  // 先进场动画收尾，再判「弹窗真的打开了」：窗口被遮挡时 modalIn 会停在 opacity:0，
  // 不收尾就会一直读到 opacity=0（t4 第 2 次实跑就是这么红的）。
  await settleAnimations(ev, '弹窗挂载后');
  const ready = await waitUntil(ev, MODAL_READY_EXPR, {
    timeout: READY_TIMEOUT,
    label: '复制弹窗打开（.modal 可见 + 变量输入框 + 预览有文本；若 opacity 一直为 0，多半是动画停在起始帧）',
  });
  console.log(`  · 弹窗打开：等 ${mounted.ms + ready.ms}ms（${JSON.stringify(ready.state)}）`);

  // 3) 弹窗刚挂载时可能被组件自己按 settings.theme 重写一次 data-theme，钉一次并复验
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await setTheme(session, theme);
    await sleep(250);
    const probe = await ev(`document.documentElement.dataset.theme`);
    if (probe === theme) break;
    if (attempt === 1) throw new Error(`无法把 data-theme 固定成 ${theme}（实读 ${probe}），本次弹窗扫描不可信`);
  }

  // 4) 稳定采样后扫 .modal 子树（只扫弹窗，不扫 .modal-overlay：那是全窗口压暗层，本来就该半透明）
  //    钉主题可能带来颜色过渡/重渲染，判定前再收一次动画尾
  await settleAnimations(ev, '弹窗钉主题后');
  const { res, samples, ms } = await stableScan(ev, MODAL_SCAN_EXPR, modalSig, `${pageLabel} · ${theme}`);
  console.log(`  · 稳定：${samples} 次采样，${ms}ms 后签名不再变`);
  const modalCtx = await ev(`(() => {
    const m = document.querySelector('.modal');
    const pre = document.querySelector('.modal pre.sql-var-preview');
    const r = m ? m.getBoundingClientRect() : { width: 0, height: 0 };
    return { w: Math.round(r.width), h: Math.round(r.height),
      opacity: m ? Number(getComputedStyle(m).opacity) : -1,
      inputs: document.querySelectorAll('.modal .modal-body input:not([type=checkbox]):not([type=radio])').length,
      preLen: pre ? (pre.textContent || '').length : 0,
      theme: document.documentElement.dataset.theme };
  })()`);
  if (modalCtx.theme !== theme) {
    throw new Error(`${pageLabel} 扫描时的页面状态不对：data-theme=${modalCtx.theme}（期望 ${theme}）`);
  }

  const rows = res.rows || [];
  const bad = [];
  const good = [];
  for (const r of rows) {
    const w = whitelistOf(r);
    if (w) good.push({ r, w }); else bad.push(r);
  }
  console.log(`\n──── ${pageLabel}：不透明块 ${rows.length} 个（白名单 ${good.length} / 违规 ${bad.length}）`);
  console.log(`  · 弹窗自证：主题 ${theme} / 背景 ${res.ctx.bg} / 弹窗 ${modalCtx.w}×${modalCtx.h}`
    + ` / opacity ${modalCtx.opacity} / 变量输入框 ${modalCtx.inputs} / 预览 ${modalCtx.preLen} 字`);
  for (const { r, w } of good) {
    console.log(`  \u2713 ${pad(r.area, 7)} ${pad(`${r.w}×${r.h}`, 11)} ${pad(r.bg, 26)} ${r.cls || r.tag}`);
    console.log(`      ↑ 白名单「${w.id}」：${w.why}`);
  }
  for (const r of bad) {
    console.log(`  \u2717 ${pad(r.area, 7)} ${pad(`${r.w}×${r.h}`, 11)} ${pad(r.bg, 26)} ${r.cls || r.tag}`);
    violations.push({ theme, page: pageLabel, ...r });
  }
  if (bad.length) {
    console.log('      ↑ 弹窗里的实底同样会挡住背景图：在 redesign.css 的 html[data-bg=\'image\'] 段补一条');
    console.log('        var(--glass-*) 背景（容器不要加 backdrop-filter），或（确实本应实心）加进 WHITELIST 并写理由');
  }

  // 5) 锚点：pre 的 computed backgroundColor 必须来自 var(--glass-input-soft)（任务书点名的判据）
  for (const t of MODAL_TARGETS) {
    const m = await ev(targetExpr(t.sel, t.token));
    const label = pad(t.label, 30);
    if (!m || !m.found) {
      violations.push({ theme, page: pageLabel, cls: `${t.label}（未出现）`, bg: '-', w: 0, h: 0, area: 0 });
      console.log(`  \u2717 ${pad(theme, 6)} ${label} 弹窗里没找到这类元素，无法证明已玻璃化`);
      continue;
    }
    const a = alphaOf(m.bg);
    if (t.token) {
      const provOk = m.tokenMatch === true && a < 1;
      if (provOk) {
        console.log(`  \u2713 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a}  ${m.w}×${m.h}  ← var(${t.token})`);
        continue;
      }
      violations.push({ theme, page: pageLabel, cls: t.label, bg: m.bg, w: m.w, h: m.h, area: m.area });
      if (a >= 1) {
        console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 仍然全不透明（期望 var(${t.token})）`);
      } else {
        console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 是半透明，但不是 var(${t.token})`
          + `（该 token 的 computed 值 ${m.tokenBg}）`);
      }
      continue;
    }
    // 无 token：.modal-footer 要求 alpha === 0（1.31.x 起改成透底 + border-top 分隔）
    if (a === 0) {
      console.log(`  \u2713 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a}  ${m.w}×${m.h}  （透底 + border-top 分隔）`);
      continue;
    }
    violations.push({ theme, page: pageLabel, cls: t.label, bg: m.bg, w: m.w, h: m.h, area: m.area });
    console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 底栏仍是实底，会挡住背景图`);
  }

  // 6) 关掉弹窗，免得影响下一套主题 / 后续收尾（关不掉也按失败处理：残留弹窗会让后面的页面扫描失真）
  const closed = await ev(CLOSE_MODAL_EXPR);
  if (!closed) throw new Error('复制弹窗关不掉（找不到 .modal .close-btn），后面的扫描不可信');
  await waitUntil(ev, MODAL_GONE_EXPR, { timeout: 3000, label: '复制弹窗关闭' });
}

// ────────────────────────────────────────────────────────────────────

(async () => {
  const { dataDir, backgroundName } = prepareDataDir({
    prefix: 'pm-opaque-data-', casesRoot: true, background: { srcFile: BG_FIXTURE, name: 'bg-opaque.png' },
  });
  const handle = await launch({ port: 9841, dataDir });
  const session = await waitForWindow(handle);
  const { ev } = session;
  /** 本轮全部违规（白名单外的不透明块 / 锚点不符 / 自证不足） */
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
    //   - 1.32.3（t4）：SQL 样本第一条必须**带 {{变量}}**（`{{today}}` + 一段变量说明），
    //     弹窗扫描就是靠它把「变量输入框 / 预览块 / 底栏」都渲染出来。
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
        { id: 'opaque-sql-1', kind: 'sql', title: ${JSON.stringify(COPY_SNIPPET_TITLE)}, dbOrEnv: 'test_order / 预发',
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
      + ' —— 分页条与复制弹窗都必须渲染出来，否则下面的自证会红');
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
        // 1.32.3（t4）：把「固定 sleep」换成按页的就绪/生效条件等待（见文件头与 READY_PRED）。
        // navTo 的完成条件会被骨架屏的 .pg 满足，所以它返回时页面可能还没真的渲染出来。
        await waitPageReady(session, ev, page);
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
        // 稳定采样（1.32.3）：页面刚换完视图时元素可能还没量出尺寸（面积 0 → 漏判），
        // 要求「同一份签名连续两次相同」再判定，避免扫在重排中间出假绿。
        // 钉主题可能带来颜色过渡，判定前先把动画/过渡收尾（窗口被遮挡时它们会停在起始帧）。
        await settleAnimations(ev, `${page.label} 钉主题后`);
        const { res, samples, ms } = await stableScan(ev, SCAN_EXPR, pageSig, `${page.label} · ${theme}`);
        const { ctx, rows } = res;
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
        console.log(`  · 稳定：${samples} 次采样，${ms}ms 后签名不再变`);
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

      // 1.32.3（t4）：每套主题再扫一次「复制弹窗」（.modal 子树）。
      // 放在页面循环之后：此时 store 里已有 SQL 样本，导航与渲染都是热的；弹窗自己会钉主题。
      await scanCopyModal(session, ev, theme, violations);
      scanned += 1;
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

  console.log(`\n扫描 ${scanned} 个「主题 × 页面/弹窗」组合（面积 > ${AREA_MIN}px² 且背景 alpha >= ${ALPHA_OPAQUE} 计为不透明块）`);
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
  console.log('\n\u2713 0 违规：白名单外没有 alpha=1 且面积 > 600 的块（含复制弹窗子树），补漏类都是半透明（带 token 的还验了背景来源）');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error(`\n\u2717 扫描失败：${e && e.message}`);
  try { stop(null); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(1), 200);
});
