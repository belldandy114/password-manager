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
 * ⚠️ 1.32.5（t6/D1，依据 docs/agents/glass-scan-tab-plan.md）三处新增：
 *
 *   1) **「网址管理 · 成员账号」tab 进扫描组合**。它是 `PasswordManagerPage` 的 `pmSubPage`
 *      （tab 键 `members`），不是 Dashboard 的视图 —— 所以：
 *      · 就绪判据必须**与「当前在哪个 tab」无关**（只验页面真的挂载 + tab 栏齐 + 有内容），
 *        否则「切到成员账号」是下一步 prep 的动作，用结果等前置条件会死锁
 *        （与 1.32.3 那个「等 rows>=1 再切列表」同一种坑）；
 *      · 切 tab 由 `prep`（点 tab2）做、由 `APPLIED_PRED` 验（tab 文案 + 表格行 >= 1）；
 *      · 扫描完必须 `restore` 回「所有网址」：`pmSubPage` 是 store 状态、侧栏导航不重置，
 *        扫完留在 members 的话，**下一套主题**的首个网址管理页会落在成员账号 tab 上，
 *        而它的就绪判据要 `.toolbar` + 三个 `.view-switch-btn` → 必然 10s 超时红。
 *      · 自证用 `maRows`（`.mem-acc table.tbl tbody tr`，B 片复用既有 `.tbl`；限定在 `.mem-acc`
 *        容器里，否则 SQL 片段页的 `.tbl` 表格行也会被算进来）而不是猜类名；
 *        造数必须带 `accounts`（否则是空态，空表扫出 0 违规没有意义）。
 *
 *   2) **「网址管理 · 详情抽屉」进扫描组合**（契约 §8-5）。扫描根只取
 *      `document.querySelector('.drawer.entry-drawer')` **子树**（`.drawer-mask` 是全窗口压暗层，
 *      本来就该半透明，扫进来只是噪声）；打开方式是**点卡片主体**（勾选框是另一个元素，
 *      点它只切选中、不开抽屉）；关闭**只点抽屉头部的关闭按钮**，绝不「点第一个按钮」——
 *      抽屉底栏第一个按钮是「编辑」，点了会弹出 EntryForm，把后面的扫描全搞脏。
 *      锚点：`.drawer.entry-drawer` 的背景必须**逐字符等于** `var(--glass-modal)` 且 alpha < 1
 *      （1.32.2 的口径：只验 alpha<1 拦不住「玻璃规则没命中、但底色恰好半透明」的假绿）。
 *
 *   3) **修掉稳定判据的一个既存漏洞**：`modalSig` 用了 `ctx.modalInputs / ctx.preLen`，
 *      但 `buildScanExpr` 的 ctx 里从来没有这两个字段 → `JSON.stringify([undefined, undefined])`
 *      恒为 `"[null,null]"`，**弹窗的稳定判据实际上只等于「命中块列表」**（自证那一半永远相等）。
 *      现在把 `modalInputs / preLen / drawerKv / drawerTitle` 补进 ctx，并让 `pageSig` / `drawerSig`
 *      真正引用它们 —— 改了这些字段，签名就会跟着变，不再有恒等的一半。
 *
 * ⚠️ 1.33.0（t54/W7-A）**新增 8 个扫描单元：开发辅助 4 个新页 × 2 个页签**。
 *
 * 为什么必须单独登记而不能「顺手就扫到了」：本脚本是**按 `PAGES` 白名单逐页扫**的。
 * 4 个新页（CodeGen / CodeAudit / AssetLedger / ResultHub）不登记时，脚本照常 `exit 0`、
 * 报告「0 个不透明块」—— 但它**一条都没扫**，属于本脚本自己注释里记着的那类假绿
 * （和「只验 alpha<1」同级）。所以本轮把 8 个页签单元逐个登记，并把组合数抬到
 * **16（现有 8 组/主题 + 8 新单元/主题）× 2 主题 = 32**；日志末尾的「扫描 N 个组合」
 * 就是分母，N ≤ 16 说明新页根本没进扫描。
 *
 * 三件配套的事（缺一条，登记就等于自欺）：
 *   1) **每个单元一条 READY_PRED（与当前 tab 无关）+ 一条 APPLIED_PRED（点完 tab 后生效）**。
 *      就绪判据不能依赖「当前在哪个页签」：切 tab 是下一步 prep 的动作，用结果等前置条件会死锁
 *      （1.32.3 / 1.32.5 两次踩过：等 rows>=1 再切列表 = 永远等不到）。
 *   2) **每个单元一条 `min` 自证**：空页面扫出 0 违规没有意义。新页里几个页签的数据来自
 *      vault 集合（`pomPages` / `scanRuns` / `coverageRuns` 里的历史 / `caseMaps`），
 *      所以下面加了一段**新页造数**（`opaque-dev-` 前缀，收尾按前缀删），让表格真的有行；
 *      另外几个「表单+空态」的页签（OpenAPI 粘贴区 / .jtl 取数）本身没有表格数据，
 *      自证卡在「面板+输入框/横幅真的渲染出来」，并把实测计数打进日志（见 ctx 的 dev* 字段）。
 *   3) **TARGETS 锚点带 token**：每个新单元至少一个锚点，要求 computed backgroundColor
 *      **逐字符等于** `var(--glass-*)` 的解析值（`.pnl`→`--glass-card`、`.tbl th`→`--glass-side`、
 *      `.tab2`→`--glass-control`）。只验 alpha<1 会被 `.pager` 那类基础半透明色骗过。
 *
 * ⚠️ 1.34.0（W8 / t5）**页签透明化**：`.tabs`/`.tab2` 不再是玻璃块（`redesign.css` 末尾
 *    1.34.0 段：`.tabs` 只留 1px 底边、玻璃模式下 `.tab2` 背景收回 transparent），于是
 *    「`.tab2` = `--glass-control`」这两条锚点（单元 2 / 单元 8）**必然变红**，已改挂到
 *    既有玻璃规则的落点（`.pg .tbl th`→`--glass-side`、`.pg input`→`--glass-input`）。
 *    同时新增 `TAB_STRIP_EXPR` 不变量：面积判据只能证明「没有白块」，**证明不了**「药丸底
 *    被收回了」（删掉透明规则扫描只会更绿），所以单独断言 `.pg .tabs` 与激活页签的背景为
 *    `rgba(0, 0, 0, 0)`、上/左/右边框 0px、下边框 1px。变异验证（M-1.34.0）就靠它变红。
 *
 * ⚠️ 1.35.0（W3 / S5-t23）**新增 2 个扫描单元：UI 录制器 × 2 个页签**，组合数 32 → **36**
 *    （9 组/主题 + 9 新单元/主题）× 2 主题）。录制器与上面 4 页有三处不同，四处登记都按它写：
 *    1) **表单在 `.toolbar` 里、灯面板在 `.tabs` 之前**（都是 `.pg` 直下），不在 `[role=tabpanel]`
 *       内 —— 所以 ctx 的 dev* 那组「限定 tabpanel」的计数对本页恒 0，另加 `recToolbar /
 *       recInputs / recLamps / recLampStates` 四个字段做自证（min 用前三个）。
 *    2) **两个 tabpanel 始终在 DOM 里**、靠 `hidden` 互斥（Recorder.tsx:11-13：AC-1 停止后
 *       还要读候选锚点，卸载会读出「0 条推荐」的假绿）。所以 APPLIED_PRED 除了判激活页签文案，
 *       还要判「非 hidden 的 tabpanel 恰好 1 个」—— 只判文案会漏掉「tab 切了但 hidden 没更新」。
 *    3) ✅ **1.36.0（t27）：灯面板已挂载（t26），`min.recLamps: 5` 已补进两条单元**，
 *       并把「5 盏灯在 DOM 里」并进 READY_PRED。补 min 前那两条 min 是 2/2/2/1/1，**没有一项能
 *       证明灯渲染出来了** —— 灯不在 DOM 时扫描只会更绿（透明底、没有白块），这正是本文件
 *       1.32.2 记的 `.pager` 同款假绿。可证伪的命令：
 *       `PM_SCAN_DROP_LAMPS=1 node scripts/ui-glass-opaque-scan.js` → 必须 exit=1 且两条单元
 *       红在 `recLamps=0 < 5`（该 hook 见下面 `DROP_LAMPS` 的注释：为什么不直接改 Recorder.tsx）。
 *
 * ⚠️ 1.36.0（B1）**结果中心下线，摘 2 个扫描单元，组合数 36 → 32**（每主题 18 → 16）：
 *    - 页面 `ResultHub.tsx` 已删，`.jtl 指标` 搬进「压力测试」页右栏（老页，**不在**
 *      `DEV_PAGE_LABEL` 里，本脚本不覆盖它 —— 要覆盖压测页得另开一轮，方案 §3.6 的边界）。
 *    - 五处登记一起摘：`ANCHORS` 2 条（`.pg .tbl th` → --glass-side / `.pg input` → --glass-input）、
 *      `PAGES` 2 个单元、`READY_PRED` 2 条、`APPLIED_PRED` 2 条、`DEV_PAGE_LABEL` 里的前缀。
 *    - `devSeed` 的「④ allureRuns 造数」一并摘除（没有页面读它了），收尾的按前缀删集合同步
 *      缩到 `pomPages / scanRuns / caseMaps` 三个。
 *    - **自证口径不变**：每个单元仍要「就绪判据 + APPLIED_PRED + min + 锚点」四件，删单元不等于
 *      放宽判据 —— 剩余单元的 min / 锚点一条不动（本批只删不改）。
 *
 * ⚠️ 1.36.0（B3）**代码体检改单页，摘 1 个扫描单元，组合数 32 → 30**（每主题 16 → 15）：
 *    - `src/pages/CodeAudit.tsx` 不再有页签（Git 影响面下线，方案 §11.1 判它该删），所以：
 *      · `PAGES` 删「Git 影响面」1 个单元；剩下的单元改名 `代码体检`（不再是「代码体检 · 代码体检」）；
 *      · 该单元 `min.devTabs` 从 2 改成 **0** —— 单页就该一个页签壳都没有，留壳会红；
 *      · `READY_PRED` 要求 `devTabs === 0 && panel === 0`（没有 `.tabs`、也没有 `[role=tabpanel]`）；
 *      · `APPLIED_PRED` 改成「`.pg .tabs`=0、`.pg .tab2`=0、面板有内容」（原来判激活页签文案，
 *        单页后那条必然红）。
 *    - `ANCHORS` 删「代码体检 · Git 影响面」那条，剩「代码体检」一条；`DEV_PAGE_LABEL` 不用动。
 *    - 可证伪：把 `CodeAudit.tsx` 里加回一个单页签的 `.tabs` 壳 → 该单元必红在 `devTabs=1`。
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
 * 变异验证用的临时 CSS 注入（**默认关闭**，只给「这条门禁到底会不会红」的验证用）。
 *
 * 为什么要这个开关：要证明「扫描组合不是空跑」，最直接的办法是给被测元素临时加一条实底，
 * 看门禁是否真的把它列出来（本仓库的历史做法是「临时改 src/styles → 跑 → 改回来」）。
 * 改 `src/` 会把「只改 scripts/」的边界打破（还可能和并行片抢同一个 CSS 文件），
 * 所以改成运行时往 `<head>` 追加一条 `<style>`：效果等价（同样的 alpha=1 实底），
 * 但仓库文件一个字节都不动，跑完进程一退就没了。
 *
 *   PM_SCAN_INJECT_CSS=".mem-acc-table{background-color:#fff !important}" node scripts/ui-glass-opaque-scan.js
 *
 * 变异验证的正常预期：**必须 exit=1**，且违规清单里出现被注入的那个元素/类名。
 * 不加这个环境变量时它恒为空串，对正常扫描零影响。
 */
const MUTATION_CSS = String(process.env.PM_SCAN_INJECT_CSS || '').trim();

/**
 * 变异验证之二（默认关闭）：`PM_SCAN_DROP_LAMPS=1` —— 每次「页面扫描」求值**之前**，
 * 先把 `.rec-page .rec-lamp` 从 DOM 里摘掉。
 *
 * 为什么需要它：`min` 自证计数的唯一作用是拦「元素从没进过 DOM → 0 违规 → 假绿」
 * （1.32.2 的 `.pager` 就是这么漏的）。灯面板是本批最该被量的块，所以必须有一条
 * **可反复执行**的命令证明 `min.recLamps: 5` 真的会红，而不是「改成 5 就算过」。
 *
 * 为什么不直接去 `Recorder.tsx` 里注释掉 `<AbilityBar/>`（任务书里的朴素做法）：
 *   1) 那个文件属 frontend 面（本片 outOfScope），一次性改+回滚是越界操作；
 *   2) 它**尚未进 git**（`?? src/pages/Recorder.tsx`），改坏了没有 `git checkout --` 兜底，
 *      风险与收益完全不成比例；
 *   3) 摘节点与「组件没挂载」在扫描眼里是**同一个可观测量**（`querySelectorAll` 计数为 0），
 *      而这条 hook 是可复跑、可交给 QA 长期驻留的判据。
 *
 * 正常预期：**exit=1**，且录制器两条单元都红在「页面自证不足 recLamps=0 < 5」。
 * 注意摘节点发生在**就绪判据之后**：就绪时灯必须是 5（否则 READY_PRED 先 10s 超时），
 * 所以这条变异精确地只打 min，不会连累就绪判据 —— 两条断言各自可证伪。
 */
const DROP_LAMPS = process.env.PM_SCAN_DROP_LAMPS === '1';

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
    // 1.32.7（t11）：破坏性按钮。与「主按钮」同一类判断，但理由不同 ——
    // 主按钮是「这里点这里」的引流锚点，破坏性按钮是「别乱点这里」的警示锚点；
    // 玻璃化会把红色实底掺进背景图，警示强度直接掉一档（用户看不出危险动作）。
    // 实测只在「网址管理 · 详情抽屉」底栏出现（64×34 = 2176px²，深浅各 1 条）。
    id: '破坏性按钮 (btn-danger)',
    test: (e) => /(^|\s)btn-danger(\s|$)/.test(e.cls),
    why: '破坏性按钮（删除 / 清空 / 彻底删除）：实色红底是「这一步不可逆」的视觉锚点，'
      + '玻璃化后与普通次级按钮拉不开层次、警示被背景图冲淡，用户更容易误点；'
      + '而且单个按钮面积很小（实测 64×34 = 2176px²，与主按钮同量级），挡不住图。'
      + '注意：这条只放行按类名判定的按钮本身，不给抽屉里的容器/行放行（那些必须补玻璃，见 1.32.7 的 .role-acc-row）',
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
  {
    // 1.34.0（W8 / t5）：开发辅助四页的「生成代码区」。
    //
    // 这是**设计**，不是漏修 —— 与 .codelab-editor（redesign.css:8054 的注释）同一口径：
    // 代码/终端区保持实底。理由是可读性硬约束：语法高亮的每个语义色都要在一个稳定底上
    // 过 4.5:1。压 --glass-input-soft 后的合成底（浅色 + 深色背景图 ≈ 219/219/220）下，
    // 四个稳定色相实测只有 --ok 3.63 / --warn 3.25 / --bad 3.85 / --info 3.91
    // （docs/acceptance/W8-视觉口径.md §2.3 的反证表）—— 半透明即等于关掉高亮。
    // 颜色全部走既有 token（--info/--ok/--bad/--text-1/--text-2/--text-3），0 新增令牌。
    id: '代码区 (.dev-code)',
    test: (e) => hasWord(e.cls, 'dev-code'),
    why: '生成代码区的语法高亮需要稳定实底：压 --glass-input-soft 时四个语义色相在浅色主题'
      + '（最差合成底 ≈ 219/219/220）只有 3.25~3.91，全部 <4.5:1，半透明会让高亮失效。'
      + '与 .codelab-editor「代码/终端区保持实底」同口径（redesign.css:8054）。'
      + '它不是待修项：改法若要玻璃化，等于同时删掉语法高亮。',
  },
];

/**
 * 白名单里「声明了就必须真被命中一次」的条目（1.34.1 / review-arch 阻断项）。
 *
 * 为什么需要这份清单：白名单是**保护声明**（「这个块本应实心」），而面积判据只在
 * 元素真的出现在 DOM 里时才会走到白名单判定 —— 元素不出现，这条保护既不通过也不失败，
 * 等于**装饰品**。1.34.0 的 `.dev-code` 就是这样：代码块只在点过「生成」后才挂载
 * （`OpenApiTab.tsx:346` / `ElementLibTab.tsx:383` 都是 `files.length > 0` 才渲染
 * `GeneratedFilesView`），而当时的扫描单元只切页签、不点生成 → 一次都没命中。
 *
 * 判据（照同文件 TAB_STRIP_EXPR 的范式：量不到就判红）：每套主题下，本清单里的每个
 * 白名单条目至少要命中 1 次，否则整次扫描判违规。**加了这条之后，白名单再也不能
 * 靠「元素没出现」蒙混过关** —— 要么命中，要么红。
 */
const WHITELIST_MUST_HIT = [
  {
    id: '代码区 (.dev-code)',
    label: '.dev-code（生成代码区）',
    why: '代码块只在点「生成 POM」之后才挂载（OpenApiTab.tsx:346 / ElementLibTab.tsx:383 都是 files.length>0）；'
      + '扫描单元必须先把它渲染出来，否则「代码区刻意实底」这条保护永远不表态',
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
  // ── 1.33.0（t54/W7-A）：8 个新单元各一条锚点，全部带 token ──
  // 为什么每个单元都要一条：面积判据（alpha≥0.999 且 >600px²）只证明「没白块」，
  // 证明不了「玻璃规则真的命中在这个新页上」。锚点用同父级 0×0 探针解析 var(--glass-*)，
  // 要求逐字符相等 —— 注释掉规则时它会红在「是半透明，但不是 var(--glass-xxx)」，
  // 这是本轮变异验证（M3）唯一能走通的那条通路。
  // `.pnl`→--glass-card（redesign.css:7863）；`.tbl th`→--glass-side（:7944/:8233）；
  // `.tab2`→--glass-control（:7973）。
  //
  // ⚠️ 1.34.0（W8 / t5）：**页签已经不是玻璃块了**，`.tab2` 不能再当玻璃锚点。
  // 1.34.0 把 `.tabs`/`.tab2` 透明化（`.tabs` 只留 1px 底边、玻璃模式下 `.tab2`
  // 的背景收回 transparent，见 redesign.css 末尾 1.34.0 段），所以原来挂在
  // `.pg .tabs .tab2.is-active` 上的两条 `--glass-control` 锚点会**必然变红**
  // （透明底 alpha=0，tokenMatch 不可能等于 --glass-control）。改挂既有玻璃规则的
  // 落点：单元 2 → `.pg .tbl th`（元素表是 `.tbl`，ElementTable.tsx:37）。
  // （原「单元 8 → `.pg input`」那条已在 1.36.0（B1）随对应页面下线一起摘除；当时不用
  //  契约里写的 `.home-stat` 的原因也一并作废：`.home-stat` 只在 .jtl **解析成功后**才挂载。）
  // 页签透明化本身改用下面的 TAB_STRIP_INVARIANT 断言（面积判据盖不到「变透明」）。
  { sel: '.pg .pnl', label: '新页面板 .pnl（代码生成·OpenAPI）', token: '--glass-card',
    pages: ['代码生成 · OpenAPI → 骨架'] },
  { sel: '.pg .tbl th', label: '新页表头 .tbl th（代码生成·元素库）', token: '--glass-side',
    pages: ['代码生成 · 元素库 → POM'] },
  { sel: '.pg .pnl', label: '新页面板 .pnl（代码体检）', token: '--glass-card',
    pages: ['代码体检'] },
  // ── 1.36.0（B3）：Git 影响面下线（页面改单页），这条锚点随单元一起摘除。
  { sel: '.pg .pnl', label: '新页面板 .pnl（资产台账·覆盖矩阵）', token: '--glass-card',
    pages: ['资产台账 · 覆盖矩阵'] },
  { sel: '.pg .tbl th', label: '新页表头 .tbl th（资产台账·用例映射）', token: '--glass-side',
    pages: ['资产台账 · 用例映射'] },
  // ── 1.36.0（B1）：两个已删单元的原锚点（`.pg .tbl th` → --glass-side / `.pg input` → --glass-input）
  // 随单元一起摘除；剩下的锚点一条不动。**不要**在本批给搬走的那个页签另登记新单元
  // （它现在在「压力测试」页＝老页，玻璃行为另开一轮）。
  // ── 1.35.0（W3 / S5-t23）：UI 录制器 2 个单元各一条锚点 ──
  // 录制器这张页的表单**在 `.toolbar` 里**（`.pg` 直下、不在 `[role=tabpanel]` 内），
  // 所以 `dev*` 那组「限定 tabpanel」的计数看不到它 —— 三个锚点分别落三个玻璃档位：
  //   `.toolbar` → `--glass-side`（redesign.css:7944）
  //   `.rec-row input` → `--glass-input`（:7964）
  //   `.pnl` → `--glass-card`（:7863）
  // 只比 alpha 不够：`.toolbar` 的基础底色是 `--surface-1` 实底、`.pnl` 是 `--surface-2` 实底，
  // 两者在**普通模式**下也都是不透明的；带 token 才能证明「背景确实来自那条玻璃规则」。
  { sel: '.rec-page .toolbar', label: '录制器工具条 .toolbar（含 .rec-row 表单行）', token: '--glass-side',
    pages: ['UI 录制器 · 录制', 'UI 录制器 · 校验报告'] },
  { sel: '.rec-page .rec-row input:not([type=checkbox]):not([type=radio])',
    label: '录制页输入框 input（目标页址）', token: '--glass-input',
    pages: ['UI 录制器 · 录制'] },
  { sel: '.rec-page .pnl', label: '录制页面板 .pnl（本机能力 / 空态面板）', token: '--glass-card',
    pages: ['UI 录制器 · 录制', 'UI 录制器 · 校验报告'] },
];

/**
 * 「页签必须透明」不变量（1.34.0 / W8，t5）。
 *
 * 为什么必须单独写一条：面积判据（alpha≥0.999 且 >600px²）只能证明「没有白块」，
 * **证明不了「页签底被收回了」** —— 页签从药丸底变成透明，扫描只会变得更绿，
 * 谁把 `html[data-bg='image'] .tabs .tab2{background-color:transparent}` 删掉，
 * 面积判据也不会红（半透明的药丸底 alpha 远低于 0.999）。这就是「门禁在跑、
 * 一条没拦」的典型形态（本文件 1.32.3 记过同类）。
 *
 * 断言三件事：
 *   1. `.pg .tabs` 与 `.pg .tabs .tab2.is-active` 的背景都是 rgba(0, 0, 0, 0)；
 *   2. `.pg .tabs` 的上/左/右边框为 0px（pages.css:479 的圆角框被覆盖掉）；
 *   3. `.pg .tabs` 的下边框仍是 1px（下划线页签要有一条基线，别连带删了）。
 *
 * 只在开发辅助四页量（DEV_PAGE_LABEL）：别的页面没有 `.pg .tabs`，量到的是 null。
 */
const TAB_STRIP_EXPR = `(() => {
  const info = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { bg: cs.backgroundColor, bt: cs.borderTopWidth, bl: cs.borderLeftWidth,
      br: cs.borderRightWidth, bb: cs.borderBottomWidth,
      w: Math.round(r.width), h: Math.round(r.height) };
  };
  const strip = info('.pg .tabs');
  const act = info('.pg .tabs .tab2.is-active');
  return { found: !!(strip && act), strip, act };
})()`;
/** 开发辅助四页的 label 前缀（TAB_STRIP_EXPR 只在这些页面上量） */
const DEV_PAGE_LABEL = /^(代码生成|代码体检|资产台账)/;

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
  // 1.32.5（t6/D1）：「成员账号」是 PasswordManagerPage 的 pmSubPage tab（键 members），
  // 不是 Dashboard 的视图 —— prep 点顶部 tab、restore 必须切回「所有网址」（见文件头 1.32.5 第 1 条）。
  // min.maRows：空表扫出 0 违规没有意义，所以要求账号行 >= 1（造数里 entries 1/2/3 带 accounts）。
  {
    label: '网址管理 · 成员账号', nav: '网址管理',
    prep: (s) => clickText(s, '成员账号'),
    restore: (s) => clickText(s, '所有网址'),
    min: { maRows: 1 },
    hint: 'maRows=0 说明成员账号表没渲染：造数没带 accounts，或 tab 落进了空态',
  },
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
  // ── 1.33.0（t54/W7-A）：开发辅助 4 页 × 2 页签 = 8 个扫描单元 ──
  // 为什么逐个登记而不是登记 4 条：每页 2 个页签是**互斥渲染**的（条件渲染），
  // 只登记 1 条就只扫到默认页签，另一个页签永远不在门禁视野里 = 一半假绿。
  // `min` 是「这一页签真的有内容」的下限；空页面扫出 0 违规不算通过。
  // prep 一律用 `root: '.pg .tabs'` 限定：`clickText` 只搜 button 且按文档顺序取第一个命中，
  // 而侧栏 `.nav-item` 也是 button 且文案可能和页签同名（「代码体检」就是），
  // 不限定就会点到侧栏导航（点了也不报错，但 tab 没切 → 扫的还是默认页签）。
  {
    label: '代码生成 · OpenAPI → 骨架', nav: '代码生成',
    prep: (s) => clickText(s, 'OpenAPI → 骨架', { root: '.pg .tabs' }),
    min: { devPanel: 1, devTabs: 2, devTextareas: 1 },
    hint: 'devTextareas=0 说明「① 取数」的粘贴区没渲染出来（该页签是表单页：选文件/粘贴 + 按钮）',
  },
  {
    label: '代码生成 · 元素库 → POM', nav: '代码生成',
    // 1.34.1（review-arch 阻断项）：**这个单元必须点一次「生成 POM」**。
    // 代码块只在 `files.length > 0` 之后才挂载（ElementLibTab.tsx:383 → GeneratedFilesView
    // → ui.tsx:306 `<pre class="tb-pre dev-code">`），而扫描原来只切页签不点生成 → 白名单
    // 「代码区 (.dev-code)」永远走不到，那条保护等于装饰。选「点生成」而不是「只加自证」的理由：
    // 只加自证只会让门禁天天红（或逼我们删掉白名单 = 丢掉保护）；点生成才能真的把元素请进 DOM，
    // 自证（WHITELIST_MUST_HIT）则负责「将来点不到时立刻喊」。两者一起才既可达又能表态。
    prep: async (s) => {
      const onTab = await clickText(s, '元素库 → POM', { root: '.pg .tabs' });
      if (!onTab) return false;
      // ⚠️ 等「生成 POM」这个按钮本身，而不是等 `.pnl`：左侧「页面」面板在 `loading` 期间就挂上了，
      // 而右侧编辑面板要等 useCollection 读完、draft 自动选中第一条之后才渲染（ElementLibTab.tsx:56-62）——
      // 第一版等 `.pnl` 就点，正好点在「还没有按钮」的那一刻，prep 返回 false（这就是本仓那类「等错了东西」）。
      const hasGen = await s.waitFor({
        expr: `[...document.querySelectorAll('[role=tabpanel] button')].some((b) => (b.textContent || '').includes('生成 POM'))`,
      }, { timeout: 8000, throwOnTimeout: false });
      if (hasGen !== true) {
        throw new Error('「代码生成 · 元素库 → POM」等 8s 也没出现「生成 POM」按钮：'
          + '多半是 pomPages 造数没读到（左侧列表空态 → 右侧是 .empty 占位，没有编辑面板）');
      }
      const onGen = await clickText(s, '生成 POM', { root: '[role=tabpanel]' });
      if (!onGen) return false; // 按钮真的不在 → 交给调用方的通用「prep 点击落空」文案
      const shown = await s.waitFor({ expr: `!!document.querySelector('.dev-code')` },
        { timeout: 5000, throwOnTimeout: false });
      if (shown !== true) {
        throw new Error('「代码生成 · 元素库 → POM」点了「生成 POM」但 5s 内没有出现 .dev-code：'
          + '白名单「代码区 (.dev-code)」会因此一次都命中不到（生成失败/校验不通过会走 .dev-banner 分支）。'
          + '先看页面上有没有 is-error 横幅，再看造数 pomPages 是否通过 validatePage');
      }
      // ⚠️ 等成功 toast 自己消失再让扫描采样：点生成会弹「已生成 Page Object」（duration 3000ms，
      // useToast.ts:15）。toast 是**浮层**、按本仓口径刻意不透明（redesign.css:8008 的「浮层类…
      // 刻意不在此列」），留着它会被面积判据记成一条「白名单外的不透明块」—— 那是时序噪声，
      // 不是这一页的玻璃缺陷。等它消失（≤8s）比给它加白名单更诚实：真·常驻不透明浮层仍会被拦。
      const toastGone = await s.waitFor({ expr: `document.querySelectorAll('.toast').length === 0` },
        { timeout: 8000, throwOnTimeout: false });
      if (toastGone !== true) {
        throw new Error('「代码生成 · 元素库 → POM」等 8s 后 .toast 仍在（3s 应自动消失）：'
          + '要么 toast 定时器坏了，要么页面上叠了常驻浮层 —— 后者会让面积判据把浮层记成违规');
      }
      return true;
    },
    min: { devPanel: 1, devTabs: 2, devInputs: 1, devCode: 1 },
    hint: 'devInputs=0 说明元素库表单没渲染；devCode=0 说明「生成 POM」后代码块没挂载（白名单会空转）',
  },
  {
    // 1.36.0（B3）：代码体检改单页（Git 影响面下线），**没有页签可点**了 —— prep 退化成 no-op，
    // 但保留这个字段（框架按 prep 是否存在决定要不要点，删掉反而要改框架）。
    // devTabs 期望从 2 改成 **0**：单页就该一个页签壳都没有（方案 §3.5 不允许留空壳）。
    label: '代码体检', nav: '代码体检',
    prep: async () => true,
    min: { devPnlAll: 1, devTabs: 0, devRowsAll: 1 },
    hint: 'devRowsAll=0 说明 scanRuns 历史表没渲染（造数没写进 vault，或页面落进了空态）；'
      + 'devTabs≠0 说明单页又长出了页签壳',
  },
  {
    label: '资产台账 · 覆盖矩阵', nav: '资产台账',
    prep: (s) => clickText(s, '覆盖矩阵', { root: '.pg .tabs' }),
    min: { devPanel: 1, devTabs: 2, devInputs: 1 },
    hint: 'devInputs=0 说明「① 取数与运行」表单没渲染（覆盖矩阵没有历史表，价值主要在面板+表单的玻璃）',
  },
  {
    label: '资产台账 · 用例映射', nav: '资产台账',
    prep: (s) => clickText(s, '用例映射', { root: '.pg .tabs' }),
    min: { devPanel: 1, devTabs: 2, devRows: 1 },
    hint: 'devRows=0 说明 caseMaps 造数没读到（映射清单是空态，表头行也应有 1 行）',
  },
  // ── 1.36.0（B1）：两个已删单元（Allure / .jtl 指标）随页面下线一并摘除。
  // 不在这里补 `.jtl` 的替代单元：它现在挂在「压力测试」页（老页，不在 DEV_PAGE_LABEL 里），
  // 要覆盖它得另开一轮（方案 §3.6 的边界）。组合数 36 → 32。
  // ── 1.35.0（W3 / S5-t23）：UI 录制器 × 2 页签 = 2 个扫描单元（32 → 36 组合）──
  // 为什么也是 2 条而不是 1 条：录制页两个 tabpanel **始终都在 DOM 里**（非激活的 `hidden`，
  // Recorder.tsx:11-13 写死了理由：AC-1 在停止后才读候选锚点，卸载会读出「0 条推荐」的假绿），
  // 但 `hidden` 的子树在扫描里是**不可见 → 整棵跳过**，所以只扫默认页签等于只测一半。
  // `min` 用两张卡：
  //   · `devTabs/devPanel/devEmpty` 证明页签栏与两个面板真的挂上了（来自 ctx 的通用字段）；
  //   · `recToolbar/recInputs/recLamps` 证明**表单行与灯面板**真的渲染了 —— 表单在 `.toolbar` 里、
  //     灯面板在 `.tabs` 之前，两者都不在 tabpanel 内，`dev*` 那组计数恒 0。
  // ✅ 1.36.0（t27）：`AbilityBar` 已由 t26 挂进 Recorder.tsx，`ctx.recLamps` 实测 **5**，
  // 所以 `recLamps: 5` 已写进下面两条 min。这条计数存在的唯一理由就是拦
  // 「元素从没进过 DOM → 0 违规 → 假绿」（1.32.2 的 `.pager` 就是这么漏的：
  // 造数只造了 2 条、分页条根本没渲染，门禁 exit=0 却一条都没量到）。
  // 判据可证伪：`PM_SCAN_DROP_LAMPS=1 node scripts/ui-glass-opaque-scan.js` 会在每次扫描前
  // 把 `.rec-lamp` 从 DOM 里摘掉（等价于 AbilityBar 没挂载），两条单元必须红在 `recLamps=0 < 5`。
  {
    label: 'UI 录制器 · 录制', nav: '录制器',
    prep: (s) => clickText(s, '录制', { root: '.pg .tabs' }),
    min: { devTabs: 2, devPanel: 2, devEmpty: 1, recToolbar: 1, recInputs: 1, recLamps: 5 },
    hint: 'recToolbar=0 说明 .rec-page .toolbar 没渲染；recInputs=0 说明 .rec-row 里的目标页址输入框没渲染'
      + '（.rec-row 的样式在 redesign.css 末尾 1.35.0 段，量不到它就是样式没加载）；'
      + 'recLamps=0 说明 AbilityBar 没挂载/渲染炸了 —— 灯不在 DOM 里，灯面板的玻璃行为等于没量',
  },
  {
    label: 'UI 录制器 · 校验报告', nav: '录制器',
    prep: (s) => clickText(s, '校验报告', { root: '.pg .tabs' }),
    min: { devTabs: 2, devPanel: 2, devEmpty: 1, recToolbar: 1, recLamps: 5 },
    hint: 'devEmpty=0 说明报告面板没落进空态（会话残留或报告还在渲染中）；'
      + 'recLamps=0 说明 AbilityBar 没挂载 —— 灯是页面级元素，与本页签无关，两条单元都必须量到 5',
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
  // 1.32.5（t6/D1）：**与「当前在哪个 tab」无关**（切 tab 是下一步 prep 的动作，用它等前置条件会死锁）。
  // 只证明：网址管理页真的挂载了、页签栏齐了（>= 5 个 tab2：所有网址/成员账号/回收站/导入/导出）、有任意内容。
  '网址管理 · 成员账号': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const state = { skel: !!document.querySelector('.page-skel'), pmTabs: q('.tabs .tab2'),
      toolbar: !!document.querySelector('.toolbar'), cards: q('.entry-card'),
      rows: q('.entry-table tbody tr'), maRows: q('.mem-acc table.tbl tbody tr') };
    const ok = !state.skel && state.pmTabs >= 5 && (state.cards >= 1 || state.rows >= 1);
    return { ok, state };
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
  // ── 1.33.0（t54/W7-A）：4 个新页 × 2 页签。就绪判据**与当前在哪个页签无关** ──
  // 只证明：骨架屏没了、页标题是这一页、页签栏两个按钮都在、tabpanel 挂载了 1 个。
  // 切页签是下一步 prep 的动作，拿「目标页签已激活」当就绪条件会死锁（1.32.3 的同类坑）。
  '代码生成 · OpenAPI → 骨架': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]') };
    return { ok: !state.skel && state.title === '代码生成' && state.devTabs === 2 && state.panel === 1, state };
  })()`,
  '代码生成 · 元素库 → POM': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]') };
    return { ok: !state.skel && state.title === '代码生成' && state.devTabs === 2 && state.panel === 1, state };
  })()`,
  // 1.36.0（B3）：代码体检改单页 —— 就绪判据要求「无页签壳且页面有内容」。
  // 注意 devTabs 用 `.pg .tabs .tab2`，单页时必须是 0；panel（[role=tabpanel]）也必须是 0。
  '代码体检': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]'), pnl: q('.pg .pnl') };
    return { ok: !state.skel && state.title === '代码体检' && state.devTabs === 0 && state.panel === 0 && state.pnl >= 1, state };
  })()`,
  '资产台账 · 覆盖矩阵': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]') };
    return { ok: !state.skel && state.title === '资产台账' && state.devTabs === 2 && state.panel === 1, state };
  })()`,
  '资产台账 · 用例映射': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]') };
    return { ok: !state.skel && state.title === '资产台账' && state.devTabs === 2 && state.panel === 1, state };
  })()`,
  // ── 1.36.0（B1）：上面两个已删单元的就绪判据一并摘除（页面已下线）。
  // ── 1.35.0（W3 / S5-t23）：UI 录制器 ──
  // 与「哪个页签在前台」无关（切页签是 prep 的事，用它当就绪会死锁）：
  // 只证明骨架屏没了 + 页标题对 + `.rec-page` 根在 + 两个页签 + 两个 tabpanel + 工具条 + 5 盏灯。
  // `.rec-page` 是 Recorder.tsx:463 写死的根类（AC-15 的几何断言也按它取数）。
  // ✅ 1.36.0（t27）：把「5 盏灯在 DOM 里」并进就绪判据。理由有两条：
  //   1) 灯面板是页面级元素（`.tabs` 之前），与页签无关 —— 它不在就不是「这一页渲染好了」；
  //   2) 灯如果渲染时抛错，`recLamps` 恒 0，就绪判据会**当场 10s 超时并说缺哪一项**，
  //      比让 min 在采样阶段报「自证不足」快一步、也更好定位。
  // AbilityBar 的 5 个槽位是固定的（abilities 为空时全部落 grey），首屏就齐，不会闪 0。
  'UI 录制器 · 录制': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      recPage: q('.pg.rec-page'), devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]'),
      toolbar: q('.rec-page .toolbar'), lamps: q('.rec-page .rec-lamp') };
    return { ok: !state.skel && state.title === 'UI 录制器' && state.recPage === 1
      && state.devTabs === 2 && state.panel === 2 && state.toolbar === 1 && state.lamps === 5, state };
  })()`,
  'UI 录制器 · 校验报告': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const t = document.querySelector('.pg-title');
    const state = { skel: !!document.querySelector('.page-skel'), title: t ? (t.textContent || '').trim() : '',
      recPage: q('.pg.rec-page'), devTabs: q('.pg .tabs .tab2'), panel: q('[role=tabpanel]'),
      toolbar: q('.rec-page .toolbar'), lamps: q('.rec-page .rec-lamp') };
    return { ok: !state.skel && state.title === 'UI 录制器' && state.recPage === 1
      && state.devTabs === 2 && state.panel === 2 && state.toolbar === 1 && state.lamps === 5, state };
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
  // 1.32.5（t6/D1）：真的切到「成员账号」tab 且表格里真的有行（空态不算就绪 —— 空表扫 0 违规没意义）
  '网址管理 · 成员账号': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const on = document.querySelector('.tabs .tab2.is-active');
    const sel = document.querySelector('.mem-acc-bar select[aria-label="按网址筛选"]') || document.querySelector('.mem-acc-bar select');
    const state = { tab: on ? on.textContent.trim() : '', maRows: q('.mem-acc table.tbl tbody tr'),
      maFilterOpts: sel ? sel.options.length : 0, empty: !!document.querySelector('.mem-acc .tbl-empty') };
    const ok = state.tab === '成员账号' && state.maRows >= 1;
    return { ok, state };
  })()`,
  // ── 1.33.0（t54/W7-A）：8 个新单元「点完页签真的切过去了」 ──
  // 判据 = 激活页签文案对 + tabpanel 里真的有内容（面板数 ≥1，且横幅/输入框/表格/滚动容器至少一项）。
  // 只判文案会漏掉「tab 切了但内容空着」的情况 —— 空页扫 0 违规等于没测。
  '代码生成 · OpenAPI → 骨架': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const a = document.querySelector('.pg .tabs .tab2.is-active');
    const state = { tab: a ? (a.textContent || '').trim() : '', panels: q('[role=tabpanel] .pnl'),
      banners: q('[role=tabpanel] .dev-banner'), inputs: q('[role=tabpanel] input:not([type=checkbox]):not([type=radio])'),
      tables: q('[role=tabpanel] table.tbl'), scroll: q('[role=tabpanel] .dev-scroll'),
      textareas: q('[role=tabpanel] textarea'), empty: q('[role=tabpanel] .empty') };
    return { ok: state.tab === 'OpenAPI → 骨架' && state.panels >= 1
      && (state.banners + state.inputs + state.textareas + state.tables + state.scroll + state.empty) >= 1, state };
  })()`,
  '代码生成 · 元素库 → POM': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const a = document.querySelector('.pg .tabs .tab2.is-active');
    const state = { tab: a ? (a.textContent || '').trim() : '', panels: q('[role=tabpanel] .pnl'),
      banners: q('[role=tabpanel] .dev-banner'), inputs: q('[role=tabpanel] input:not([type=checkbox]):not([type=radio])'),
      tables: q('[role=tabpanel] table.tbl'), scroll: q('[role=tabpanel] .dev-scroll'),
      textareas: q('[role=tabpanel] textarea'), empty: q('[role=tabpanel] .empty') };
    return { ok: state.tab === '元素库 → POM' && state.panels >= 1
      && (state.banners + state.inputs + state.textareas + state.tables + state.scroll + state.empty) >= 1, state };
  })()`,
  // 1.36.0（B3）：代码体检单页 —— 断言「没有页签栏」+「面板里有内容」。
  // 原来的判据是「激活页签文案 === 代码体检」，单页后没有激活页签，那条必然红。
  '代码体检': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const state = { tabs: q('.pg .tabs'), tab2: q('.pg .tab2'), panels: q('.pg .pnl'),
      banners: q('.pg .dev-banner'), inputs: q('.pg input:not([type=checkbox]):not([type=radio])'),
      tables: q('.pg table.tbl'), scroll: q('.pg .dev-scroll'),
      textareas: q('.pg textarea'), empty: q('.pg .empty') };
    return { ok: state.tabs === 0 && state.tab2 === 0 && state.panels >= 1
      && (state.banners + state.inputs + state.textareas + state.tables + state.scroll + state.empty) >= 1, state };
  })()`,
  '资产台账 · 覆盖矩阵': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const a = document.querySelector('.pg .tabs .tab2.is-active');
    const state = { tab: a ? (a.textContent || '').trim() : '', panels: q('[role=tabpanel] .pnl'),
      banners: q('[role=tabpanel] .dev-banner'), inputs: q('[role=tabpanel] input:not([type=checkbox]):not([type=radio])'),
      tables: q('[role=tabpanel] table.tbl'), scroll: q('[role=tabpanel] .dev-scroll'),
      textareas: q('[role=tabpanel] textarea'), empty: q('[role=tabpanel] .empty') };
    return { ok: state.tab === '覆盖矩阵' && state.panels >= 1
      && (state.banners + state.inputs + state.textareas + state.tables + state.scroll + state.empty) >= 1, state };
  })()`,
  '资产台账 · 用例映射': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const a = document.querySelector('.pg .tabs .tab2.is-active');
    const state = { tab: a ? (a.textContent || '').trim() : '', panels: q('[role=tabpanel] .pnl'),
      banners: q('[role=tabpanel] .dev-banner'), inputs: q('[role=tabpanel] input:not([type=checkbox]):not([type=radio])'),
      tables: q('[role=tabpanel] table.tbl'), scroll: q('[role=tabpanel] .dev-scroll'),
      textareas: q('[role=tabpanel] textarea'), empty: q('[role=tabpanel] .empty') };
    return { ok: state.tab === '用例映射' && state.panels >= 1
      && (state.banners + state.inputs + state.textareas + state.tables + state.scroll + state.empty) >= 1, state };
  })()`,
  // ── 1.36.0（B1）：两个已删单元的 APPLIED_PRED 随单元摘除（页面已下线）。下面接录制器。
  // ── 1.35.0（W3 / S5-t23）：UI 录制器 2 个单元 ──
  // 判据 = 激活页签文案对 + **非 hidden 的 tabpanel 恰好 1 个** + 该面板里有内容。
  // 「恰好 1 个」是本页特有的：Recorder.tsx 把两个 tabpanel 都挂在 DOM 里、靠 `hidden` 互斥
  // （AC-1 停止后还要能读到候选锚点）。只判文案的话，「tab 切了但面板没换」这种
  // （hidden 没更新）会漏过去，而扫到的仍是旧面板 —— 假绿。
  'UI 录制器 · 录制': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const a = document.querySelector('.pg .tabs .tab2.is-active');
    const state = { tab: a ? (a.textContent || '').trim() : '',
      shown: q('[role=tabpanel]:not([hidden])'), hidden: q('[role=tabpanel][hidden]'),
      empty: q('[role=tabpanel]:not([hidden]) .empty'), panels: q('[role=tabpanel]:not([hidden]) .pnl'),
      toolbar: q('.rec-page .toolbar') };
    return { ok: state.tab === '录制' && state.shown === 1 && state.hidden === 1
      && (state.empty + state.panels) >= 1 && state.toolbar === 1, state };
  })()`,
  'UI 录制器 · 校验报告': `(() => {
    const q = (x) => document.querySelectorAll(x).length;
    const a = document.querySelector('.pg .tabs .tab2.is-active');
    const state = { tab: a ? (a.textContent || '').trim() : '',
      shown: q('[role=tabpanel]:not([hidden])'), hidden: q('[role=tabpanel][hidden]'),
      empty: q('[role=tabpanel]:not([hidden]) .empty'), panels: q('[role=tabpanel]:not([hidden]) .pnl'),
      toolbar: q('.rec-page .toolbar') };
    return { ok: state.tab === '校验报告' && state.shown === 1 && state.hidden === 1
      && (state.empty + state.panels) >= 1 && state.toolbar === 1, state };
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
    pagerInfo: (document.querySelector('.pager .pager-info') || {}).textContent || '',
    // 1.32.5（t6/D1）：成员账号 tab 的自证（页签数 / 账号行 / 按网址筛选选项）
    //   maRows 限定在 .mem-acc 容器里：.pm-main table.tbl 会把 SQL 片段页的 .tbl 表格行
    //   也算进来（实测 2 行），自证值就不专属于这一页了。
    pmTabs: document.querySelectorAll('.tabs .tab2').length,
    maRows: document.querySelectorAll('.mem-acc table.tbl tbody tr').length,
    maFilterOpts: (() => {
      const s = document.querySelector('.mem-acc-bar select[aria-label="按网址筛选"]') || document.querySelector('.mem-acc-bar select');
      return s ? s.options.length : 0;
    })(),
    // 1.32.5（t6/D1）：修掉「modalSig 引用了 ctx 里不存在的字段」这个恒等漏洞 ——
    // 以前 modalSig 的 [modalInputs, preLen] 恒为 [null,null]，弹窗的稳定判据只剩命中块列表。
    modalInputs: document.querySelectorAll('.modal .modal-body input:not([type=checkbox]):not([type=radio])').length,
    preLen: (() => { const p = document.querySelector('pre.sql-var-preview'); return p ? (p.textContent || '').length : 0; })(),
    drawerKv: document.querySelectorAll('.drawer.entry-drawer .drawer-kv dt').length,
    drawerTitle: (() => { const t = document.querySelector('.drawer.entry-drawer .drawer-title-text'); return t ? (t.textContent || '').slice(0, 40) : ''; })(),
    // 1.33.0（t54/W7-A）：开发辅助 4 个新页（4 页 × 2 页签）的自证。
    // 一律限定在 [role=tabpanel] 里 —— 同页里的历史表/其它表格会被算进来（t51 实测过
    // 301 = 300 findings + 1 历史行），不限定的话自证值就不专属于当前页签。
    devTabs: document.querySelectorAll('.pg .tabs .tab2').length,
    devActiveTab: (() => { const a = document.querySelector('.pg .tabs .tab2.is-active'); return a ? (a.textContent || '').trim() : ''; })(),
    devPanel: document.querySelectorAll('[role=tabpanel]').length,
    devScroll: document.querySelectorAll('[role=tabpanel] .dev-scroll').length,
    devTables: document.querySelectorAll('[role=tabpanel] table.tbl').length,
    devRows: document.querySelectorAll('[role=tabpanel] table.tbl tbody tr').length,
    devBanners: document.querySelectorAll('[role=tabpanel] .dev-banner').length,
    devTags: document.querySelectorAll('[role=tabpanel] .dev-tag').length,
    devInputs: document.querySelectorAll('[role=tabpanel] input:not([type=checkbox]):not([type=radio])').length,
    devSelects: document.querySelectorAll('[role=tabpanel] select').length,
    devTextareas: document.querySelectorAll('[role=tabpanel] textarea').length,
    devEmpty: document.querySelectorAll('[role=tabpanel] .empty').length,
    devStats: document.querySelectorAll('[role=tabpanel] .home-stat').length,
    // 1.35.0（W3 / S5-t23）：UI 录制器。它的表单在 .toolbar 里、灯面板在 .tabs 之前，
    // 两者都在 .pg 直下、不在 [role=tabpanel] 内，所以上面那组限定 tabpanel 的 dev* 计数
    // 对本页恒为 0 —— 单独取三项，用来做 PAGES 里两条录制器单元的 min 自证
    // （否则「空页面 0 违规」又成了假绿）。
    // ✅ 1.36.0（t27）：AbilityBar 已由 t26 挂进 Recorder.tsx，recLamps 实测 5，
    // 已写进两条 min。灯面板的 DOM 是 5 个固定槽位（abilities 为空时全部落 grey），
    // 所以首屏就有 5 个 .rec-lamp —— 这份计数不会因 probe 未返回而闪 0。
    // ⚠️ 本段在模板字符串里：注释里不许出现反引号与 $ 加大括号。
    recToolbar: document.querySelectorAll('.rec-page .toolbar').length,
    recInputs: document.querySelectorAll('.rec-page .rec-row input:not([type=checkbox]):not([type=radio])').length,
    recLamps: document.querySelectorAll('.rec-page .rec-lamp').length,
    recLampStates: [...document.querySelectorAll('.rec-page .rec-lamp')]
      .map((el) => String(el.getAttribute('data-state') || '')).join(','),
    // 1.34.1：生成代码区（只有点过「生成」才会出现），用来给 min 自证与日志
    devCode: document.querySelectorAll('[role=tabpanel] .dev-code').length,
    // 1.36.0（B3）：代码体检改**单页**后没有 [role=tabpanel]，上面那组「限定 tabpanel」的计数对本页恒 0，
    // 所以另取三项**页面级**计数给它的 min 做自证（同录制器那组的做法：不另取就会红，或者只能放宽 min）。
    // 本段在模板字符串里：注释里不许出现反引号与 $ 加大括号。
    devPnlAll: document.querySelectorAll('.pg .pnl').length,
    devTablesAll: document.querySelectorAll('.pg table.tbl').length,
    devRowsAll: document.querySelectorAll('.pg table.tbl tbody tr').length };
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

/**
 * 白名单命中计数（1.34.1）。按主题分桶；页面 / 弹窗 / 抽屉三条扫描路径共用。
 * 为什么放在模块作用域：`scanCopyModal` / `scanEntryDrawer` 是模块级函数，看不到主 IIFE 里的局部变量
 * （第一版写成 IIFE 局部 → 运行时报 `noteWhitelistHit is not defined`）。
 */
const whitelistHit = {};
const noteWhitelistHit = (theme, id) => {
  whitelistHit[theme] = whitelistHit[theme] || {};
  whitelistHit[theme][id] = (whitelistHit[theme][id] || 0) + 1;
};

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

/**
 * 页面扫描的稳定性签名：不透明块列表 + 页面自证计数。
 * 1.32.5（t6/D1）：把 `maRows / pmTabs` 也并进签名 —— 成员账号 tab 上 `cards/rows/pagers` 恒 0，
 * 不并入的话签名只剩「命中块列表」，表还在挂载/填数据时也能「两次采样一致」= 新的假绿通道。
 */
const pageSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.cards, res.ctx.rows, res.ctx.pagers, res.ctx.maRows, res.ctx.pmTabs])
  // 1.33.0（t54/W7-A）：新页的自证计数也必须进签名 —— 新页上 cards/rows/pagers/maRows 恒 0，
  // 不并入的话签名只剩「命中块列表」，表格还在挂载/填数据时也能「两次采样一致」= 新的假绿通道。
  + '|' + JSON.stringify([res.ctx.devTabs, res.ctx.devActiveTab, res.ctx.devPanel,
    res.ctx.devScroll, res.ctx.devTables, res.ctx.devRows, res.ctx.devBanners, res.ctx.devInputs, res.ctx.devStats,
    res.ctx.devTextareas, res.ctx.devEmpty])
  // 1.35.0（W3 / S5-t23）：录制器的三项自证也进签名。灯（recLamps）是探测返回后才挂上的
  // （`record:probe` 有 60 s 缓存 + 一次 IPC 往返），不并进签名的话「灯还没挂出来」那一刻
  // 也能「两次采样一致」——与 1.32.5 / 1.33.0 那两条是同一个假绿通道。
  + '|' + JSON.stringify([res.ctx.recToolbar, res.ctx.recInputs, res.ctx.recLamps, res.ctx.recLampStates]);

/**
 * 弹窗扫描的稳定性签名：块列表 + 弹窗自证（输入框数 / 预览字数）。
 * ⚠️ 1.32.5（t6/D1）之前这两个字段**在 ctx 里不存在** → 恒为 `[null,null]`，
 * 弹窗的稳定判据实际上只等于命中块列表。现在 ctx 补了字段，这一半才真的在起作用。
 */
const modalSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.modalInputs, res.ctx.preLen]);

/** 抽屉扫描的稳定性签名：块列表 + 抽屉自证（键值对项数 / 标题） */
const drawerSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.drawerKv, res.ctx.drawerTitle]);

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
    if (w) { good.push({ r, w }); noteWhitelistHit(theme, w.id); } else bad.push(r);
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

/* ════════════════════════════════════════════════════════════════════
 * 1.32.5（t6/D1）「卡片详情抽屉」扫描（契约 §8-5）
 * ----------------------------------------------------------------
 * 为什么单独一段：`.drawer` 是浮层，只有用户点开卡片时才存在；而且它**此前没有任何
 * data-bg='image' 规则**（`redesign.css:8008` 的注释明确把它排除在玻璃之外），
 * 背景图模式下就是一块 520×全高的实心板 —— 门禁从来不开抽屉，所以一直没抓到。
 * 这一段把「点卡片主体 → 等抽屉可见 → 扫抽屉子树 → 量 .drawer.entry-drawer 的
 * --glass-modal 溯源 → 关掉」固化下来。
 *
 * 三条硬约束（写死的理由）：
 *   1) 扫描根只取 `.drawer.entry-drawer` 子树：`.drawer-mask` 是全窗口压暗层，本来就该半透明；
 *      扫整个 body 又会把页面自身的不透明块重复算一遍。
 *   2) 打开方式必须是**点卡片主体**：勾选框（`input[type=checkbox]`）是另一个元素，
 *      点它只切选中、不开抽屉（契约 §3.1）—— 点错就永远等不到抽屉。
 *   3) 关闭**只点抽屉头部的关闭按钮**，绝不「点第一个 button」：
 *      抽屉底栏第一个按钮是「编辑」，点了会弹出 EntryForm（`.modal`），把后面的扫描全搞脏。
 * ════════════════════════════════════════════════════════════════════ */

/** 抽屉扫描（只扫 `.drawer.entry-drawer` 子树） */
const DRAWER_SCAN_EXPR = buildScanExpr("document.querySelector('.drawer.entry-drawer')");

/** 抽屉「挂上了」：只看 DOM 存在与尺寸（不判 opacity —— 进场动画可能停在起始帧，要先收尾动画） */
const DRAWER_EXISTS_EXPR = `(() => {
  const d = document.querySelector('.drawer.entry-drawer');
  if (!d) return { ok: false, state: { drawer: 0 } };
  const r = d.getBoundingClientRect();
  return { ok: r.width > 0 && r.height > 0,
    state: { drawer: 1, w: Math.round(r.width), h: Math.round(r.height),
      opacity: Number(getComputedStyle(d).opacity), masks: document.querySelectorAll('.drawer-mask').length } };
})()`;

/** 抽屉「真的打开了」：有尺寸 + opacity 1（进场动画结束）+ 标题/键值对已渲染 */
const DRAWER_READY_EXPR = `(() => {
  const d = document.querySelector('.drawer.entry-drawer');
  if (!d) return { ok: false, state: { drawer: 0 } };
  const r = d.getBoundingClientRect();
  const cs = getComputedStyle(d);
  const t = d.querySelector('.drawer-title-text');
  const state = { drawer: 1, w: Math.round(r.width), h: Math.round(r.height),
    opacity: Number(cs.opacity), title: t ? (t.textContent || '').slice(0, 20) : '',
    kv: d.querySelectorAll('.drawer-kv dt').length,
    masks: document.querySelectorAll('.drawer-mask').length,
    theme: document.documentElement.dataset.theme };
  // 宽度是否落在契约 420–480 只打印、不作门禁判据（几何归回归报告；类名 entry-drawer 已够定位）
  const ok = r.width > 0 && Number(cs.opacity) === 1 && !!state.title && state.kv >= 1;
  return { ok, state };
})()`;

/**
 * 打开抽屉：点**第一个卡片的主体**（不是勾选框 input）。
 * 定位失败要明确失败，不许静默跳过 —— 跳过等于这一段门禁没装。
 */
const OPEN_DRAWER_EXPR = `(() => {
  const card = document.querySelector('.entry-card');
  if (!card) return { ok: false, why: '卡片视图里没有 .entry-card（视图没切到卡片？）' };
  const title = card.querySelector('.card-title');
  const check = card.querySelector('input[type=checkbox]');
  card.click();
  return { ok: true, name: title ? (title.textContent || '').trim() : '',
    hasCheckbox: !!check, checkboxLabel: check ? (check.getAttribute('aria-label') || '') : '' };
})()`;

/**
 * 关闭抽屉：只点抽屉头部的关闭按钮（`aria-label=关闭` / `.ibtn`），退路是派发 Escape。
 * ⚠️ 绝不「点第一个 button」：底栏第一个是「编辑」，会弹出 EntryForm。
 */
const CLOSE_DRAWER_EXPR = `(() => {
  const d = document.querySelector('.drawer.entry-drawer');
  if (!d) return true;
  const b = d.querySelector('.drawer-head [aria-label="关闭"]') || d.querySelector('.drawer-head .ibtn');
  if (b) { b.click(); return true; }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`;

/** 抽屉是否已经关掉（给 waitUntil 用；.drawer.entry-drawer / .drawer / .drawer-mask 都必须没了） */
const DRAWER_GONE_EXPR = `(() => {
  const state = { entryDrawer: document.querySelectorAll('.drawer.entry-drawer').length,
    drawers: document.querySelectorAll('.drawer').length, masks: document.querySelectorAll('.drawer-mask').length,
    modals: document.querySelectorAll('.modal').length };
  return { ok: state.entryDrawer === 0 && state.drawers === 0 && state.masks === 0, state };
})()`;

/**
 * 泛化关闭（只在「抽屉根类名与契约选择器不一致」的诊断分支用）：
 * 任意 `.drawer` 头部的关闭按钮 → 退路 Escape。仍然只点**头部**按钮，不点底栏第一个（那是「编辑」）。
 */
const CLOSE_ANY_DRAWER_EXPR = `(() => {
  const d = document.querySelector('.drawer');
  if (!d) return true;
  const b = d.querySelector('.drawer-head [aria-label="关闭"]') || d.querySelector('.drawer-head .ibtn');
  if (b) { b.click(); return true; }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`;

/** 任意抽屉是否都关掉了（诊断分支收尾用） */
const ANY_DRAWER_GONE_EXPR = `(() => ({
  ok: document.querySelectorAll('.drawer').length === 0 && document.querySelectorAll('.drawer-mask').length === 0,
  state: { drawers: document.querySelectorAll('.drawer').length, masks: document.querySelectorAll('.drawer-mask').length },
}))()`;

/**
 * 和 `waitUntil` 同一个「条件轮询」语义，但**超时不抛错**、把最后一次实测返回给调用方。
 * 只给「期望的东西没出现时还有话要说」的分支用（抽屉根类名不匹配的诊断），
 * 正常路径一律走 `waitUntil`（超时就是失败）。**不是固定 sleep**：条件满足立刻返回。
 *
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {string} expr 返回 { ok, state } 的表达式
 * @param {number} timeout 最长等多久（ms）
 * @returns {Promise<{ok: boolean, ms: number, state: any}>} 最后一次实测
 */
async function waitSoft(ev, expr, timeout) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await ev(expr);
    if (last && last.ok) return { ok: true, ms: Date.now() - t0, state: last.state };
    await sleep(POLL_MS);
  }
  return { ok: false, ms: Date.now() - t0, state: last ? last.state : null };
}

/**
 * 抽屉锚点：面板底必须**逐字符等于** `var(--glass-modal)` 且 alpha < 1（契约 §8-5 / 队长裁定）。
 * 只验 alpha<1 拦不住「玻璃规则没命中、但底色恰好半透明」的假绿（1.32.2 的口径）。
 */
const DRAWER_TARGETS = [
  { sel: '.drawer.entry-drawer', label: '.drawer.entry-drawer（卡片详情抽屉面板）', token: '--glass-modal' },
];

/**
 * 扫一次「卡片详情抽屉」（契约 §8-5）。
 *
 * @param {object} session cdp 会话
 * @param {(expr: string) => Promise<any>} ev 页面求值函数
 * @param {'light'|'dark'} theme 当前主题
 * @param {Array<object>} violations 违规收集数组（与页面/弹窗扫描共用一个）
 * @returns {Promise<void>}
 */
async function scanEntryDrawer(session, ev, theme, violations) {
  const pageLabel = '网址管理 · 详情抽屉';
  // 1) 进网址管理 + 切到卡片视图（卡片主体才是开抽屉的入口）
  const ok = await navTo(session, '网址管理', { timeout: 15000 });
  if (!ok) throw new Error('导航不到「网址管理」');
  const page = PAGES.find((p) => p.label === '网址管理 · 卡片视图');
  await waitPageReady(session, ev, page);

  // 2) 点卡片主体开抽屉（点不到 / 没卡片 → 直接失败）
  const opened = await ev(OPEN_DRAWER_EXPR);
  if (!opened || !opened.ok) {
    throw new Error(`打不开详情抽屉：${JSON.stringify(opened)}`
      + '（卡片视图里没有 .entry-card，或卡片主体不再绑定 onClick）');
  }
  // 先用**软等待**（超时不抛错）：如果契约类名 `.drawer.entry-drawer` 根本没出现，
  // 下面要能说出「实际渲染的类名是什么」—— 这正是「CSS 选择器与组件类名不一致」这类缺陷的形态。
  const mountedSoft = await waitSoft(ev, DRAWER_EXISTS_EXPR, 3000);
  if (!mountedSoft.ok) {
    // 诊断分支：抽屉出现了但类名不匹配 → **记违规（不是跳过）**，然后关掉、继续扫后面的组合，
    // 这样一次运行就能同时拿到「抽屉这条缺陷」和「其他组合有没有回退」两份证据。
    const actual = await ev(`(() => {
      const ds = [...document.querySelectorAll('.drawer')];
      const d = ds[0];
      const r = d ? d.getBoundingClientRect() : { width: 0, height: 0 };
      return { count: ds.length, classes: ds.map((x) => String(x.className || '')),
        w: Math.round(r.width), h: Math.round(r.height),
        bg: d ? getComputedStyle(d).backgroundColor : '-',
        masks: document.querySelectorAll('.drawer-mask').length,
        modals: document.querySelectorAll('.modal').length };
    })()`);
    if (!actual || actual.count === 0) {
      throw new Error(`点卡片后没有任何 .drawer 出现（${JSON.stringify(opened)}）——`
        + '卡片主体还绑着「打开详情抽屉」的 onClick 吗？这段门禁不能静默跳过');
    }
    violations.push({
      theme, page: pageLabel,
      cls: `(抽屉根类名不匹配：期望 .drawer.entry-drawer，实测 .${actual.classes.join(' / .')}；宽 ${actual.w}px)`,
      bg: actual.bg, w: actual.w, h: actual.h, area: actual.w * actual.h,
    });
    console.log(`\n──── ${pageLabel}：\u2717 抽屉根类名与契约选择器不一致（不静默跳过，记为违规）`);
    console.log(`  · 期望 .drawer.entry-drawer，实测 .${actual.classes.join(' / .')}`
      + ` / ${actual.w}×${actual.h} / ${actual.bg} / 遮罩 ${actual.masks}`);
    console.log('      ↑ 两个后果：① 抽屉仍是基础实底色（alpha=1，挡住背景图）；'
      + '② 契约 §3.1 的 460px 宽度规则也不命中。修法：把组件根上的修饰类改成 entry-drawer（一行）；');
    console.log('        不要靠扩白名单或放宽锚点消红 —— 那等于把这条门禁关掉');
    // 关掉（用泛化选择器，仍然只点头部关闭按钮），避免污染后面的页面扫描
    await ev(CLOSE_ANY_DRAWER_EXPR);
    const gone = await waitSoft(ev, ANY_DRAWER_GONE_EXPR, 3000);
    if (!gone.ok) {
      throw new Error(`诊断分支关不掉抽屉（实测 ${JSON.stringify(gone.state)}）—— 残留抽屉会让后续扫描失真`);
    }
    return;
  }
  const mounted = mountedSoft;
  // 进场动画收尾：窗口被遮挡时抽屉的 fadeIn 会停在 opacity:0，不收尾就一直读到 opacity=0
  await settleAnimations(ev, '抽屉挂载后');
  const ready = await waitUntil(ev, DRAWER_READY_EXPR, {
    timeout: READY_TIMEOUT,
    label: '详情抽屉打开（可见 + 标题 + 键值对；opacity 一直为 0 多半是动画停在起始帧）',
  });
  console.log(`  · 抽屉打开：等 ${mounted.ms + ready.ms}ms（${JSON.stringify(ready.state)}）`
    + `（卡片「${opened.name}」/ 勾选框 ${opened.hasCheckbox ? `「${opened.checkboxLabel}」` : '未找到'}）`);

  // 3) 抽屉刚挂载时可能被组件自己按 settings.theme 重写一次 data-theme，钉一次并复验
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await setTheme(session, theme);
    await sleep(250);
    const probe = await ev(`document.documentElement.dataset.theme`);
    if (probe === theme) break;
    if (attempt === 1) throw new Error(`无法把 data-theme 固定成 ${theme}（实读 ${probe}），本次抽屉扫描不可信`);
  }

  // 4) 稳定采样后扫抽屉子树（不扫 .drawer-mask：那是全窗口压暗层，本来就该半透明）
  await settleAnimations(ev, '抽屉钉主题后');
  const { res, samples, ms } = await stableScan(ev, DRAWER_SCAN_EXPR, drawerSig, `${pageLabel} · ${theme}`);
  console.log(`  · 稳定：${samples} 次采样，${ms}ms 后签名不再变`);
  const drawerCtx = await ev(DRAWER_READY_EXPR);
  if (drawerCtx.state.theme !== theme) {
    throw new Error(`${pageLabel} 扫描时的页面状态不对：data-theme=${drawerCtx.state.theme}（期望 ${theme}）`);
  }

  const rows = res.rows || [];
  const bad = [];
  const good = [];
  for (const r of rows) {
    const w = whitelistOf(r);
    if (w) { good.push({ r, w }); noteWhitelistHit(theme, w.id); } else bad.push(r);
  }
  console.log(`\n──── ${pageLabel}：不透明块 ${rows.length} 个（白名单 ${good.length} / 违规 ${bad.length}）`);
  console.log(`  · 抽屉自证：主题 ${theme} / 背景 ${res.ctx.bg} / 抽屉 ${drawerCtx.state.w}×${drawerCtx.state.h}`
    + ` / opacity ${drawerCtx.state.opacity} / 标题「${drawerCtx.state.title}」/ 键值对 ${drawerCtx.state.kv}`
    + ` / 遮罩 ${drawerCtx.state.masks}`);
  for (const { r, w } of good) {
    console.log(`  \u2713 ${pad(r.area, 7)} ${pad(`${r.w}×${r.h}`, 11)} ${pad(r.bg, 26)} ${r.cls || r.tag}`);
    console.log(`      ↑ 白名单「${w.id}」：${w.why}`);
  }
  for (const r of bad) {
    console.log(`  \u2717 ${pad(r.area, 7)} ${pad(`${r.w}×${r.h}`, 11)} ${pad(r.bg, 26)} ${r.cls || r.tag}`);
    violations.push({ theme, page: pageLabel, ...r });
  }
  if (bad.length) {
    console.log('      ↑ 抽屉里的实底同样会挡住背景图：在 redesign.css 的 html[data-bg=\'image\'] 段给');
    console.log('        .drawer.entry-drawer（及其内部块）补 var(--glass-*) 背景，容器不要加 backdrop-filter');
  }

  // 5) 锚点：面板底必须逐字符等于 var(--glass-modal) 且 alpha < 1
  for (const t of DRAWER_TARGETS) {
    const m = await ev(targetExpr(t.sel, t.token));
    const label = pad(t.label, 34);
    if (!m || !m.found) {
      violations.push({ theme, page: pageLabel, cls: `${t.label}（未出现）`, bg: '-', w: 0, h: 0, area: 0 });
      console.log(`  \u2717 ${pad(theme, 6)} ${label} 抽屉里没找到这类元素，无法证明已玻璃化`);
      continue;
    }
    const a = alphaOf(m.bg);
    const provOk = m.tokenMatch === true && a < 1;
    if (provOk) {
      console.log(`  \u2713 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a}  ${m.w}×${m.h}  ← var(${t.token})`);
      continue;
    }
    violations.push({ theme, page: pageLabel, cls: t.label, bg: m.bg, w: m.w, h: m.h, area: m.area });
    if (a >= 1) {
      console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 仍然全不透明（期望 var(${t.token})）`);
      console.log('      ↑ 常见原因：组件根上的修饰类与 CSS 选择器不一致（例如 CSS 写 .drawer.entry-drawer、');
      console.log('        组件渲染成 .drawer.entry-detail-drawer）→ 规则一条都没命中，抽屉还是基础实底色');
    } else {
      console.log(`  \u2717 ${pad(theme, 6)} ${label} ${pad(m.bg, 30)} alpha=${a} —— 是半透明，但不是 var(${t.token})`
        + `（该 token 的 computed 值 ${m.tokenBg}）`);
    }
  }

  // 6) 关掉抽屉（关不掉按失败处理：残留抽屉会让后面的页面扫描失真；也要确认没弹出 EntryForm）
  const closed = await ev(CLOSE_DRAWER_EXPR);
  if (!closed) throw new Error('详情抽屉关不掉（找不到 .drawer-head [aria-label=关闭]），后面的扫描不可信');
  const gone = await waitUntil(ev, DRAWER_GONE_EXPR, { timeout: 3000, label: '详情抽屉关闭（.drawer / .drawer-mask 归零）' });
  if (gone.state.modals !== 0) {
    throw new Error(`关抽屉时弹出了 .modal（${gone.state.modals} 个）—— 多半是点到了抽屉底栏的「编辑」`
      + '而不是头部关闭按钮；后面的扫描会被 EntryForm 污染');
  }
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
  /** 1.34.0（W8/t5）：页签透明化不变量在每套主题下的实测值 */
  const tabStrip = {};
  /** 1.34.1：白名单命中计数用模块级的 `whitelistHit`（弹窗/抽屉函数看不到此处的局部变量） */
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
    //   - 1.32.5（t6/D1）：「成员账号」tab 的自证靠 `entry.accounts`，所以前 3 条样本必须带账号
    //     （3 个网址 5 个账号：1→2 个、2→2 个、3→1 个，角色/账号/密码都有值，覆盖「密码打码列」）。
    //     账号是条目内嵌字段，收尾按 entries 前缀删除时一起消失，不用单独清理。
    const seed = await ev(`(async () => {
      const now = Date.now();
      const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
      const envs = [['production', '生产'], ['testing', '测试'], ['staging', '预发布']];
      const before = await window.electronAPI.entriesGetAll();
      const beforeList = (before && before.success && before.data && Array.isArray(before.data.entries))
        ? before.data.entries : [];
      const ENTRIES = 25;
      // 成员账号样本：前 3 条条目带 accounts（id 前缀同样是 opaque-，随条目一起清）
      const accPlan = { 1: [['管理员', 'admin1@example.com'], ['只读', 'viewer1@example.com']],
        2: [['运维', 'ops2@example.com'], ['审计', 'audit2@example.com']],
        3: [['备份', 'backup3@example.com']] };
      for (let i = 1; i <= ENTRIES; i += 1) {
        const [envType, envLabel] = envs[i % envs.length];
        const accounts = (accPlan[i] || []).map(([role, username], k) => ({
          id: 'opaque-acc-' + i + '-' + (k + 1), role, username,
          password: 'Pw-' + i + '-' + (k + 1), note: k === 0 ? '造数样本（背景图扫描）' : '',
        }));
        await window.electronAPI.entriesAdd({ id: 'opaque-entry-' + i,
          name: '背景样本 ' + String(i).padStart(2, '0') + ' · ' + envLabel,
          username: 'user-' + i, url: 'https://example.com/entry/' + i, note: '',
          tags: [], envType, accounts, updatedAt: iso(i) });
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
        withAccounts: afterList.filter((e) => (e.accounts || []).length > 0).length,
        totalAccounts: afterList.reduce((n, e) => n + (e.accounts || []).length, 0),
        notesBefore: kept.length, notesAfter: kept.length + notes.length + sql.length,
        notes: notes.length, sql: sql.length }; })()`);
    console.log(`\n（造数）entries ${seed.entriesBefore} → ${seed.entriesAfter} 条（+${seed.entriesAfter - seed.entriesBefore}）`
      + `，其中带成员账号 ${seed.withAccounts} 条 / 账号 ${seed.totalAccounts} 个`
      + ` / notes ${seed.notesBefore} → ${seed.notesAfter} 条（普通笔记 +${seed.notes}、SQL +${seed.sql}）`
      + ' —— 分页条、成员账号表格与复制弹窗都必须渲染出来，否则下面的自证会红');
    // 1.33.0（t54/W7-A）：新页造数。4 个新页里有 4 个页签的数据来自 vault 集合
    // （pomPages / scanRuns / caseMaps），集合为空时渲染的是空态 ——
    // 空页扫出 0 个不透明块等于没测。这里只造「能渲染出表格行」的最小字段，不含任何真实信息，
    // id 一律 `opaque-dev-` 前缀（收尾按前缀删）。覆盖矩阵页签没有历史表（只在跑完后才有结果），
    // 它的自证卡在「面板 + 表单真的渲染」，见 PAGES 里该条的 hint。
    // 1.36.0（B1）：Allure 历史那条集合已无页面读，它的造数（原 ④）一并摘除。
    const devSeed = await ev(`(async () => {
      const now = new Date().toISOString();
      // ① pomPages：元素库 1 个页面 / 3 个元素（css / text / role 三种定位器）
      await window.electronAPI.wsSet('pomPages', [{ id: 'opaque-dev-pom-1', name: 'OpaqueLoginPage',
        baseUrl: 'https://example.com', className: 'OpaqueLoginPage',
        elements: [
          { name: '用户名输入框', locator: '#username', kind: 'css', note: '造数样本' },
          { name: '登录按钮', locator: '登录', kind: 'text', note: '可见文本定位' },
          { name: '错误提示', locator: 'alert', kind: 'role', role: 'alert', note: 'role 定位' },
        ], note: '背景图扫描用合成样本', updatedAt: now }]);
      // ② scanRuns：代码体检历史表 1 行（counts 三键 high/medium/low，与契约 v14 一致）
      await window.electronAPI.wsSet('scanRuns', [{ id: 'opaque-dev-scan-1', at: now, root: '<fixture>',
        pack: 'audit', files: 12, skippedSymlinks: 0, truncated: false,
        counts: { high: 1, medium: 1, low: 1 },
        findings: [
          { ruleId: 'cred-hardcoded', severity: 'high', title: '疑似硬编码凭据', file: 'src/a.ts', line: 12, snippet: 'const token = "***";' },
          { ruleId: 'assert-weak', severity: 'medium', title: '弱断言', file: 'src/b.ts', line: 34, snippet: 'expect(x).toBeTruthy();' },
          { ruleId: 'dep-dup', severity: 'low', title: '依赖重复声明', file: 'package.json', line: 7 },
        ], ruleIds: ['cred-hardcoded', 'assert-weak', 'dep-dup'], ms: 42 }]);
      // ③ caseMaps：用例映射 2 行（file / method 两种 target.kind 各一）
      await window.electronAPI.wsSet('caseMaps', [
        { id: 'opaque-dev-map-1', caseNo: 'OPAQUE-001', caseTitle: '登录成功',
          target: { kind: 'file', ref: 'src/tests/LoginTest.java' }, source: 'manual', note: '造数样本', updatedAt: now },
        { id: 'opaque-dev-map-2', caseNo: 'OPAQUE-002', caseTitle: '下单成功',
          target: { kind: 'method', ref: 'src/tests/OrderTest#shouldCreate' }, source: 'manual', updatedAt: now },
      ]);
      // ④ Allure 历史的造数已随 1.36.0（B1）一并摘除（本段在模板字符串里，注释不写反引号）。
      const read = async (k) => { const r = await window.electronAPI.wsGet(k); return (r && r.success && Array.isArray(r.data)) ? r.data.length : -1; };
      return { pom: await read('pomPages'), scan: await read('scanRuns'), maps: await read('caseMaps') };
    })()`);
    console.log(`（造数·新页）pomPages ${devSeed.pom} 条 / scanRuns ${devSeed.scan} 条 / caseMaps ${devSeed.maps} 条`
      + ' —— 元素库、体检历史、映射清单读的就是这几个集合，空集合 = 空页 = 假绿');
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

    // 变异验证（默认关闭）：往 <head> 追加一条实底样式，用来证明「这条扫描组合会真的红」。
    // 放在这里而不是每个页面前：SPA 内部导航不会重建 <head>，注入一次就一直在。
    if (MUTATION_CSS) {
      const injected = await ev(`(() => {
        const s = document.createElement('style');
        s.id = 'qa-mutation-css';
        s.textContent = ${JSON.stringify(MUTATION_CSS)};
        document.head.appendChild(s);
        return true;
      })()`);
      if (injected !== true) throw new Error('变异 CSS 注入失败（<head> 里加不上 <style>）');
      console.log(`\n（变异）已注入临时实底 CSS：${MUTATION_CSS}`);
      console.log('  本次运行**预期 exit=1**：违规清单里必须出现被注入的元素；跑完不要拿它当正常结果');
    }
    if (DROP_LAMPS) {
      console.log('\n（变异·灯）PM_SCAN_DROP_LAMPS=1：每次页面扫描前会把 .rec-page .rec-lamp 从 DOM 里摘掉');
      console.log('  = 等价于「AbilityBar 没挂载」。本次运行**预期 exit=1**：');
      console.log('  UI 录制器两条单元必须红在「页面自证不足 recLamps=0 < 5」。');
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
        // 变异（默认关闭）：摘灯与扫描在**同一次求值**里做，避免「先摘、后渲染又长回来」的时序假阴性。
        // 前缀返回 true 才继续求值 SCAN_EXPR，两者都是 IIFE，拼起来仍是一个表达式。
        const scanExpr = DROP_LAMPS
          ? `(() => { document.querySelectorAll('.rec-page .rec-lamp').forEach((n) => n.remove()); return true; })() && ${SCAN_EXPR}`
          : SCAN_EXPR;
        const { res, samples, ms } = await stableScan(ev, scanExpr, pageSig, `${page.label} · ${theme}`);
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
        let ctxLine = `  · 页面自证：主题 ${ctx.theme} / 背景 ${ctx.bg} / 卡片 ${ctx.cards} / 列表行 ${ctx.rows}`
          + ` / 环境徽标 ${ctx.badges} / 主按钮 ${ctx.primaryBtns} / KBD ${ctx.kbds}`
          + ` / KPI 卡 ${ctx.stats} / 标签栏项 ${ctx.tagItems} / SQL 行 ${ctx.sqlRows}`
          + ` / 分页条 ${ctx.pagers}${ctx.pagers ? `（${String(ctx.pagerCur).trim()} · ${String(ctx.pagerInfo).trim()}）` : ''}`
          + ` / 页签 ${ctx.pmTabs} / 成员账号行 ${ctx.maRows} / 按网址筛选选项 ${ctx.maFilterOpts}`
          // 1.33.0（t54/W7-A）：新页的自证计数（都限定在 [role=tabpanel] 里，见 buildScanExpr）
          + ` / 新页[页签 ${ctx.devTabs} · 激活「${String(ctx.devActiveTab).trim()}」 · 面板 ${ctx.devPanel}`
          + ` · 表格 ${ctx.devTables} · 行 ${ctx.devRows} · 横幅 ${ctx.devBanners} · 标签 ${ctx.devTags}`
          + ` · 输入 ${ctx.devInputs} · 下拉 ${ctx.devSelects} · 多行框 ${ctx.devTextareas} · 空态块 ${ctx.devEmpty} · KPI ${ctx.devStats} · 滚动 ${ctx.devScroll}]`
          // 1.35.0（W3 / S5-t23）：录制器（表单在 .toolbar 里，不在 tabpanel 内）
          + ` / 录制器[工具条 ${ctx.recToolbar} · 表单输入 ${ctx.recInputs} · 灯 ${ctx.recLamps}`;
        if (ctx.recLamps > 0) ctxLine += `（data-state=${ctx.recLampStates}）`;
        ctxLine += ']';
        const minFail = [];
        for (const [key, min] of Object.entries(page.min || {})) {
          const got = Number(ctx[key]) || 0;
          if (got < min) minFail.push(`${key}=${got} < ${min}`);
        }
        const bad = [];
        const good = [];
        for (const r of rows) {
          const w = whitelistOf(r);
          if (w) { good.push({ r, w }); noteWhitelistHit(theme, w.id); } else bad.push(r);
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
        // 1.34.0（W8/t5）：页签透明化不变量。面积判据盖不到「药丸底被收回」这件事
        // （透明不会产生任何不透明块，删掉规则也不会红），所以每套主题在开发辅助
        // 四页的第一个页面上量一次：无底 + 上/左/右边框 0 + 下边框 1px。
        if (!tabStrip[theme] && DEV_PAGE_LABEL.test(page.label)) {
          const inv = await ev(TAB_STRIP_EXPR);
          if (inv && inv.found) tabStrip[theme] = { ...inv, page: page.label };
        }
        // 压暗遮罩的实测 opacity：每套主题记第一次（页面不换它，取一次就够）
        if (!dim[theme]) {
          const d = await ev(DIM_EXPR);
          if (d && d.found) dim[theme] = { ...d, page: page.label };
        }

        // 1.32.5（t6/D1）：**扫完必须 restore 回原 tab**。
        // 成员账号是 pmSubPage（store 状态，侧栏导航不重置）；不切回去的话，下一套主题的
        // 首个「网址管理 · 列表视图」会落在成员账号 tab 上，而它的就绪判据要 .toolbar +
        // 三个 .view-switch-btn → 必然 10s 超时红。这不是理论风险，是「按现有两轮循环必然发生」的。
        if (page.restore) {
          const restored = await page.restore(session);
          if (restored !== true) {
            throw new Error(`「${page.label}」的 restore 点击落空：这一页改了页面级 tab，`
              + '不切回去会让下一套主题的首个网址管理页落在错误的 tab 上（就绪判据会死等 .toolbar）');
          }
          console.log('  · restore：已切回「所有网址」（否则下一轮主题会落在成员账号 tab 上）');
        }
      }

      // 1.32.5（t6/D1）：每套主题再扫一次「卡片详情抽屉」（.drawer.entry-drawer 子树）。
      // 放在页面循环之后：此时卡片样本与 store 都是热的；抽屉自己会钉主题。
      await scanEntryDrawer(session, ev, theme, violations);
      scanned += 1;

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
    // ── 1.34.1（review-arch 阻断项）白名单「必须命中一次」自证 ──
    // 白名单是保护声明；元素不出现时面积判据根本走不到它 —— 既不通过也不失败 = 装饰品。
    // 这里把「没命中」变成违规：要么命中，要么红。变异验证（M-1.34.1）就靠它。
    console.log('\n════════ 白名单自证（声明了就必须真被命中一次，否则等于没装）');
    for (const theme of THEMES) {
      const bucket = whitelistHit[theme] || {};
      for (const mh of WHITELIST_MUST_HIT) {
        const n = bucket[mh.id] || 0;
        if (n >= 1) {
          console.log(`  \u2713 ${pad(theme, 6)} ${pad(mh.label, 30)} 命中 ${n} 次`);
          continue;
        }
        violations.push({ theme, page: '(白名单未命中)', cls: mh.label, bg: '-', w: 0, h: 0, area: 0 });
        console.log(`  \u2717 ${pad(theme, 6)} ${pad(mh.label, 30)} 命中 0 次 —— 这条白名单一次都没被走到`);
        console.log(`      ↑ 保护等于没装：${mh.why}`);
      }
    }

    // ── 1.34.0（W8/t5）页签透明化不变量：无底 + 上/左/右无边框 + 下边框 1px ──
    // 为什么不能只靠「面积判据」：把药丸底换成 transparent 只会让扫描更绿，删掉那条
    // 规则也不会产出任何 alpha≥0.999 的块 —— 没有这条断言，「页签透明化」等于没有回归保护。
    console.log('\n════════ 页签透明化不变量（.pg .tabs 无底/无三边框/留 1px 底边；激活页签无底）');
    const CLEAR = 'rgba(0, 0, 0, 0)';
    for (const theme of THEMES) {
      const inv = tabStrip[theme];
      if (!inv) {
        violations.push({ theme, page: '(未出现)', cls: '.pg .tabs 不变量', bg: '-', w: 0, h: 0, area: 0 });
        console.log(`  \u2717 ${pad(theme, 6)} 四页里一个 .pg .tabs 都没量到，无法证明页签已透明`);
        continue;
      }
      const s = inv.strip;
      const a = inv.act;
      const okBg = s.bg === CLEAR && a.bg === CLEAR;
      const okBorder = s.bt === '0px' && s.bl === '0px' && s.br === '0px' && s.bb === '1px';
      if (okBg && okBorder) {
        console.log(`  \u2713 ${pad(theme, 6)} ${pad(`.tabs ${s.w}×${s.h}`, 18)} 底 ${pad(s.bg, 20)}`
          + ` 边框 ${s.bt}/${s.bl}/${s.br}/${s.bb}  激活页签底 ${a.bg}（${inv.page}）`);
        continue;
      }
      violations.push({ theme, page: inv.page, cls: '.pg .tabs 不变量', bg: s.bg, w: s.w, h: s.h, area: s.w * s.h });
      console.log(`  \u2717 ${pad(theme, 6)} ${pad(`.tabs ${s.w}×${s.h}`, 18)} 底 ${pad(s.bg, 20)}`
        + ` 边框 ${s.bt}/${s.bl}/${s.br}/${s.bb}  激活页签底 ${a.bg}（${inv.page}）`);
      console.log('      ↑ 期望：.tabs/.tab2 背景 = rgba(0, 0, 0, 0)、上/左/右边框 0px、下边框 1px。'
        + '说明 redesign.css 末尾 1.34.0 段被删了或被更具体的规则压掉');
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
        // 1.33.0（t54/W7-A）：新页造数（opaque-dev- 前缀）从 4 个集合里按前缀删 ——
        // 只删自己造的，不整表清空（万一哪天数据目录不是临时的，整表清会把用户数据删掉）。
        const dropDev = async (k) => {
          const r = await window.electronAPI.wsGet(k);
          const arr = (r && r.success && Array.isArray(r.data)) ? r.data : [];
          const keep = arr.filter((x) => !String(x && x.id || '').startsWith('opaque-dev-'));
          if (keep.length !== arr.length) await window.electronAPI.wsSet(k, keep);
          return { before: arr.length, after: keep.length };
        };
        const dev = {};
        for (const k of ['pomPages', 'scanRuns', 'caseMaps']) dev[k] = await dropDev(k);
        return { notesBefore: all.length, notesAfter: keepNotes.length,
          entriesBefore: entries.length, entriesAfter, deleted: del.length, dev }; })()`);
      if (cleaned) {
        console.log(`\n（收尾）清掉造的数据：entries ${cleaned.entriesBefore} → ${cleaned.entriesAfter} 条`
          + `（删 ${cleaned.deleted} 条）/ notes ${cleaned.notesBefore} → ${cleaned.notesAfter} 条`);
        const dev = cleaned.dev || {};
        const devLine = ['pomPages', 'scanRuns', 'caseMaps']
          .map((k) => `${k} ${dev[k] ? `${dev[k].before} → ${dev[k].after}` : '?'}`).join(' / ');
        console.log(`（收尾·新页）${devLine} 条`);
        const devLeft = ['pomPages', 'scanRuns', 'caseMaps']
          .filter((k) => !dev[k] || dev[k].after !== 0);
        if (cleaned.entriesAfter !== 0 || cleaned.notesAfter !== 0 || devLeft.length) {
          console.log(`  ⚠️ 前缀 opaque- / opaque-dev- 的样本没清干净（应为 0，残留：${devLeft.join(',') || 'entries/notes'}），`
            + '下次扫描前要检查通道是否还按 id 落盘');
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
  console.log('\n\u2713 0 违规：白名单外没有 alpha=1 且面积 > 600 的块'
    + '（含「成员账号」tab、复制弹窗与卡片详情抽屉子树），补漏类都是半透明（带 token 的还验了背景来源）');
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error(`\n\u2717 扫描失败：${e && e.message}`);
  try { stop(null); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(1), 200);
});
