# 玻璃门禁 D 分片：成员账号 tab 的扫描接入方案（附实跑基线）

> 2026-11-23。任务 t2（qa，仅方案，不写代码）。**本文只落基线 + 方案：`scripts/` 与 `src/` 一个字没改**
> （我自己的改动脉络：`git status --porcelain` 里只多出 `docs/agents/entry-ux-next.md` 与本文；
> 跑基线期间工作区干净，A/B/C 片尚未落地 —— 见 §1.1 的基线钉点）。
> 判据口径沿用 `scripts/ui-glass-opaque-scan.js` 文件头：**元素可见 && `backgroundColor` alpha ≥ 0.999 && 面积 > 600 px²**；
> 命中 `WHITELIST` 放行并打印理由，白名单外即违规、退出码 1。
>
> **2026-11-23 队长裁定与 frontend §7 落地清单已并入 §10**（附件管理 tab 不进本批门禁、附件条按「删路径文本 + 删复制路径」、
> **抽屉纳入扫描**且锚点 = `var(--glass-modal)`）。t6/D1 以 **§10** 为准，§3 的选择器是开工前推演。

## 0. 结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 现状基线绿不绿 | **绿**。`node scripts/ui-glass-opaque-scan.js` → **exit 0**，12 个「主题 × 页面/弹窗」组合、0 违规（§1.1，原始日志 35.8 KB） |
| 2 | 现有 `READY_PRED` / `prep` 能不能覆盖新 tab | **不能**，4 条硬原因（§2）：PAGES 没这一页；列表/卡片共用的就绪判据强依赖 `.toolbar` + `.view-switch-btn===3`（成员账号 tab 上没有）；`prep` 点的是「列表/卡片」不是 tab；`pageSig` 只含 cards/rows/pagers，新 tab 三项恒 0 ⇒ 稳定判据退化成「只看命中列表」 |
| 3 | 「按系统」第三个视图今天有没有玻璃覆盖 | **没有**（PAGES 只有列表/卡片）。补扫实测 **12 块全白名单、0 违规** ⇒ 加进扫描只要 3 行（§1.2、§5.1，建议接入） |
| 4 | 附件管理 tab 今天有没有玻璃覆盖 | **没有**，而且**一接就红**：深浅主题各 2 条**既存**泄漏 —— `.pnl-meta` 70×22 = 1533px²、`.notes-dirpath` 443×22 = 9735px²（§1.3、§1.4、§5.2） |
| 5 | 成员账号 tab 怎么接 | PAGES 1 条 + READY_PRED 1 条（**必须与「当前在哪个 tab」无关**，否则死锁）+ APPLIED_PRED 1 条 + ctx 三项 + `min:{maRows:1}` + 造数补 `accounts` + **扫完必须 restore 回「所有网址」**（§3，否则下一套主题的首个网址管理页死等） |
| 6 | A/B 片的写入通道 | `entriesUpdate(整条 entry)` → 成功后 `store.setVaultData(result.data)`；失败 `{success:false, error}` 且**没有 data**；已有同款先例 `OrphanAccounts.attachTo`（§7） |
| 7 | 附件页 ④ 的玻璃证据 | 本批**不进**玻璃门禁（要先补 2 条 CSS、且会撞笔记页目录模式，§5.2）；④ 用一次性 DOM 探针判（实测基线：两个 `.att-dir-bar`、**2 个 `.att-dir-path` 文本节点**，改后要求 0） |
| 8 | 队长裁定（2026-11-23，见 §10） | ①tab 宿主 `PasswordManagerPage.tsx` 已在 t4 inScope（契约 §8-1），不推；②附件管理 tab **本批不进**门禁，两条既存泄漏进 backlog P1；④附件条口径 = **删路径文本 + 删「复制路径」**，只留「打开目录 / 更改目录」，笔记条补「更改目录」写 `settings.notesDir`（不许新增 IPC）；**新增：抽屉也纳入扫描**，锚点 `.drawer.entry-drawer` 背景必须逐字符等于 `var(--glass-modal)` |
| 9 | 抽屉扫描怎么做 | 新增 `DRAWER_SCAN_EXPR` + `scanEntryDrawer()`（照 `scanCopyModal` 的骨架，每套主题一遍）：点卡片主体 → 等 `.drawer.entry-drawer` 可见且 opacity 1 → 收尾动画 → 稳定采样 → 扫 `.drawer.entry-drawer` 子树 → 量 `.drawer.entry-drawer` 的 `--glass-modal` 溯源 → 关闭并等消失（§10.2） |

## 1. 基线实测

### 1.1 官方门禁现状（exit 0）

环境：工作区 `E:\测试数据\test_cases\01_项目源码\password-manager`，HEAD `b84faf3`（1.31.0），
`dist/` 构建于 2026-11-23 14:38（晚于 `Dashboard.tsx` / `redesign.css` 的最后改动），跑的时候工作区除
`docs/agents/entry-ux-next.md` 外无改动 —— **这份基线 = 四项改造开工前的状态**，后续 A/B/C 落地后
应该拿同一份脚本重跑对照。

```powershell
node scripts/ui-glass-opaque-scan.js      # → EXIT=0
# 日志：%TEMP%\pm-glass-baseline\glass-baseline-official.log（35,859 B）
```

| 页 / 弹窗 | 不透明块 | 白名单 | 违规 | 页面自证（原文摘录） |
|---|---|---|---|---|
| 网址管理 · 列表视图 | 12 | 12 | 0 | 卡片 0 / 列表行 10 / 徽标 10 / 分页条 1（1/3） |
| 网址管理 · 卡片视图 | 15 | 15 | 0 | 卡片 10 / 徽标 13 / 分页条 1 |
| 工具箱 | 1 | 1 | 0 | tb-head ✓ |
| 笔记与附件（库模式） | 2 | 2 | 0 | 胶囊 24 / 分页条 1（1/2） |
| SQL 片段 | 2 | 2 | 0 | KPI 3 / SQL 行 2 |
| 复制弹窗（SQL 片段） | 1 | 1 | 0 | `.modal` 520×359、opacity 1、输入框 1、预览 54 字 |

- 白名单命中只有 4 类：`.app-bg-dim`（压暗层）、`.btn-add` / `.btn-primary`（主按钮）、
  `.env-badge` / `.env-badge-table`（环境徽标）。**没有一条是「为了消红而扩的白名单」**。
- 补漏类锚点（`.pager` / `.pm-pager-wrap` / `.pager-btn` / `.pager-size` / `.chip` / `tb-main-head` …）
  在深浅两套主题下都 `alpha < 1` 且 token 溯源逐字符相等 —— 现状没有被删规则或选择器被压掉的情况。
- 压暗遮罩：light `0.2814`（0.42 × 0.67）、dark `0.42`，与公式一致。

### 1.2 补充探针：门禁**没覆盖**的两个页面状态

官方 PAGES 只有「列表 / 卡片 / 工具箱 / 笔记（库模式）/ SQL」，所以另外跑了一次性探针（**不在仓库里**，
`%TEMP%\pm-glass-baseline\baseline.js`，判据与白名单逐字照抄门禁）。造数沿用官方的量级
（25 条条目、25 条笔记 + 2 条 SQL），另外两处**故意不同**：给前 5 条各塞 2 个 `accounts`（成员账号 tab 的自证样本），
并设 `settings.notesDir`（让附件页的「笔记目录」条也渲染出来 —— 官方造数没有它，所以官方从来没扫到这条 bar）：

| 页 | 不透明块 | 白名单 | 违规 | 页面自证 |
|---|---|---|---|---|
| 网址管理 · 列表视图 | 12 | 12 | 0 | 行 10 / 徽标 10 / 分页条 1 |
| 网址管理 · 卡片视图 | 15 | 15 | 0 | 卡片 10 / 徽标 13 / 分页条 1 |
| **网址管理 · 按系统视图** | **12** | 12 | **0** | 卡片 10 / 按系统分组 9 / 分页条 1 |
| 笔记与附件 · 测试笔记 tab（**目录模式**） | **4** | 3 | **1** | 笔记目录条 1 / 路径按钮 1 |
| **笔记与附件 · 附件管理 tab** | **3** | 2 | **1** | 目录条 **2** / 路径文本节点 **2** |
| SQL 片段 | 2 | 2 | 0 | KPI 3 / SQL 行 2 |

原始日志 `%TEMP%\pm-glass-baseline\baseline.log`，结构化结果 `baseline.json`。

### 1.3 命中清单（alpha ≥ 0.999 && 面积 > 600，深浅各一遍）

**白名单内（现状应实心，放行）**

| 元素 | 尺寸 / 面积 | light | dark |
|---|---|---|---|
| `.app-bg-dim` | 1384×761 / 1,053,224 | `rgb(255,255,255)` | `rgb(5,7,10)` |
| `.btn-add`（新增网址） | 77×34 / 2,618 | `color(srgb .190 .222 .242)` | 同 |
| `.btn.btn-primary.btn-sm`（新建笔记 / 导出所选） | 92×34 / 3,111 | 同上 | 同 |
| `.env-badge`（卡片） | 38~49×19 / 737~950 | `rgb(209,250,229)` / `rgb(219,234,254)` / `rgb(255,237,213)` | 同色语义色 |
| `.env-badge-table`（列表） | 42~53×21 / 861~1,087 | `rgb(6,95,70)` / `rgb(30,64,175)` / `rgb(234,179,8)` | `rgb(15,45,31)` 等 |

**白名单外（违规，深浅各 2 条 = 共 4 条）**

| 页 | 元素 | 尺寸 / 面积 | light | dark |
|---|---|---|---|---|
| 附件管理 tab | `.pnl-meta`（`<Panel meta>` 药丸） | 70×22 / 1,533 | `rgb(230,232,240)` | `rgb(18,20,30)` |
| 测试笔记 tab（目录模式） | `.notes-dirpath`（路径按钮） | 443×22 / 9,735 | `rgb(248,249,251)` | `rgb(15,18,19)` |

### 1.4 这两条是**既存泄漏**，不是本批引入（但会被新扫描页放大）

| 元素 | 不透明底来自 | 为什么门禁一直没抓到 | 一条规则的修法（frontend 范围） |
|---|---|---|---|
| `.pnl-meta` | `src/styles/pages.css:127` `background: var(--bg-input)` | 玻璃门禁扫的 5 个页面里只有附件页用 `<Panel meta>`；`.pnl-meta` 在**禅道 / 周报 / 压测 / 数据生成器 / 接口调试 / 首页**也都在用（`grep 'meta='` 25 处传值），全站都没补玻璃 | `html[data-bg='image'] .pnl-meta { background-color: var(--glass-input); }` 写到 `redesign.css` 的 `html[data-bg='image']` 段末尾 |
| `.notes-dirpath` | `src/styles/redesign.css:6910` `background: var(--surface-inset)` | 同一条规则把 `.notes-dirbar` 本体列进了玻璃（`redesign.css:8012`），但**内层路径药丸没列**；而且门禁只在**库模式**扫笔记页（库模式没有这条 bar） | `html[data-bg='image'] .notes-dirbar .notes-dirpath { background-color: var(--glass-inset); }` |

> ⚠️ 这两条都**不在本批四项契约里**。是不是顺手修由队长裁定；不修也不影响 §5 的 8 条验收，
> 只影响「要不要把附件管理 tab 加进玻璃门禁」（见 §5.2）。

### 1.5 探针自己踩的两个坑（D 片实现时别重蹈）

1. **把「就绪」写成「目标视图就绪」→ 死锁。** 第一版给「列表视图」写 `rows >= 1` 才就绪，实测
   10s 超时（`{"skel":false,"swBtn":3,"rows":0,"pagers":1}`）—— 网址管理默认是卡片视图，`rows` 恒 0，
   而「切到列表」正是下一步 prep 的动作。这正是门禁文件头 1.32.3 记过的同类坑。
   ⇒ **新 tab 的就绪判据必须与「当前在哪个 tab」无关**，tab 由 prep 切、由 APPLIED_PRED 验（§3.2）。
2. **造数里设 `settings.notesDir` 会把笔记页拽进「目录模式」**：库模式的 `胶囊 24 / 分页条 1` 变成
   `胶囊 0 / 分页条 0 / 笔记目录条 1`。官方 `READY_PRED['笔记与附件']` 要 `pagers>=1 || chips>=1`，
   一设 `notesDir` 就永远等不到（我第一版就是这样 10s 超时的）。
   ⇒ 谁要扫「目录模式 / 附件管理 tab」，就必须同时改笔记页那条就绪判据（§5.2）。

## 2. 覆盖判定：现有 `READY_PRED` / `prep` 为什么盖不到新 tab

按代码逐条对（`scripts/ui-glass-opaque-scan.js`）：

| # | 现状 | 为什么不能覆盖「网址管理 · 成员账号」 |
|---|---|---|
| 1 | `PAGES`（:175-196）只有 `网址管理 · 列表视图` / `网址管理 · 卡片视图` | 没有这一页；循环里根本不会导航/扫描它，**加 tab 也不会让门禁多跑一步** |
| 2 | `READY_PRED['网址管理 · 列表/卡片']`（:210-225）要求 `!skel && toolbar && swBtn===3 && (cards>=1 \|\| rows>=1) && pagers>=1` | 成员账号 tab 上 `.toolbar` 与三个 `.view-switch-btn` **都不存在**（它们是 Dashboard 的视图工具条），照抄这条判据必然 10s 超时；而且它要求 `.pager`，成员账号表若不分页也没有 |
| 3 | `prep`（:177、:181）= `clickText(s,'列表' / '卡片')` + `APPLIED_PRED`（:248-257）对着 `.view-switch-btn.is-on` | 成员账号的切换控件是 `.tabs > button.tab2`（`src/pages/PasswordManagerPage.tsx:50-61`），与视图按钮不是一套；`clickText('列表')` 也不会切 tab |
| 4 | `pageSig`（:602-603）只含 `ctx.cards / ctx.rows / ctx.pagers` | 新 tab 上这三项恒 0 ⇒ 签名只剩「命中块列表」，页面还在挂载/换数据时「两次采样一致」可能提前成立 = **新的假绿通道** |
| 5 | `waitPageReady`（:616-640）缺 `READY_PRED` 会**明确抛错**、prep 缺 `APPLIED_PRED` 也会抛错 | 这是好事：新页**漏写判据不会被静默跳过**，但反过来说，只加 PAGES 不加判据 = 一跑就红 |

**结论：新 tab 需要 3 条新判据 + 1 条 order 处理 + 1 处造数扩展，不是「在 PAGES 里加一行」那么小。**
另外还有一个**只在多页循环里才会暴露**的坑（§3.6）：`pmSubPage` 是 store 状态，扫完成员账号 tab 后
它**留在 accounts**，下一套主题回来时 `navTo('网址管理')` 落到的是成员账号 tab，
于是 `READY_PRED['网址管理 · 列表视图']`（要 `.toolbar`）**必然超时红**。

## 3. 接入清单（D 片实现，改一个文件 `scripts/ui-glass-opaque-scan.js`）

> **2026-11-23 队长裁定 + frontend §7 落地清单已给出最终 tab key / 类名**（tab 键 `members`、标签 `成员账号`，
> 组件类 `.mem-acc-bar` / `.mem-acc-filters` / `.mem-acc-actions`，表格复用 `.tbl`）。
> 本节代码片段里的选择器与 tab 名是**开工前的推演**，最终以 **§10.3** 为准（差异逐条列在那里）。

### 3.1 `PAGES` 新增一项

`prep` 点 tab（`tab2` 是 `<button>`，`clickText` 能命中），`restore` 是本文新增的可选钩子（§3.6）：

```js
{
  label: '网址管理 · 成员账号', nav: '网址管理',
  // 点的是「网址管理」页顶部的 tab，不是视图按钮（两者是不同控件，别抄 列表/卡片 的 prep）
  prep: (s) => clickText(s, '成员账号'),
  // 扫完必须回到「所有网址」：pmSubPage 会留在 accounts，下一套主题的首个网址管理页会落在这一 tab 上
  restore: (s) => clickText(s, '所有网址'),
  min: { maRows: 1 },
  hint: 'maRows=0 说明成员账号表没渲染（造数没带 accounts，或 tab 落进了空态）—— 空表扫出 0 违规没有意义',
}
```

### 3.2 `READY_PRED`（tab 无关）与 `APPLIED_PRED`（tab + 行）

**就绪判据不能要求「已经在成员账号 tab」**（否则死锁，同 §1.5 第 1 条）：它只证明
「网址管理页真的渲染出来了、tab 栏齐了、有任意内容」；切 tab 由 prep 做、由 APPLIED_PRED 验。

```js
// READY_PRED['网址管理 · 成员账号']：视图/ tab 无关
`(() => {
  const q = (x) => document.querySelectorAll(x).length;
  const state = { skel: !!document.querySelector('.page-skel'), pmTabs: q('.tabs .tab2'),
    toolbar: !!document.querySelector('.toolbar'), cards: q('.entry-card'),
    rows: q('.entry-table tbody tr'), maRows: q('.pm-main table tbody tr') };
  // >= 5：今天 4 个 tab（所有网址/回收站/导入数据/导出数据），新增后 5 个；
  // 用 >= 而不是 === ，以后再加 tab 不会误红，但 tab 名字由 APPLIED_PRED 卡死
  const ok = !state.skel && state.pmTabs >= 5 && (state.cards >= 1 || state.rows >= 1);
  return { ok, state };
})()`

// APPLIED_PRED['网址管理 · 成员账号']：真的切到成员账号，且表里真的有行
`(() => {
  const q = (x) => document.querySelectorAll(x).length;
  const on = document.querySelector('.tabs .tab2.is-active');
  const sel = document.querySelector('.pm-main select');
  const state = { tab: on ? on.textContent.trim() : '', maRows: q('.pm-main table tbody tr'),
    maFilterOpts: sel ? sel.options.length : 0, empty: !!document.querySelector('.pm-main .tbl-empty') };
  const ok = state.tab === '成员账号' && state.maRows >= 1;
  return { ok, state };
})()`
```

- `maRows` 用**结构选择器**（`.pm-main table tbody tr`）而不是猜 B 片的类名：契约 §3.2 已经定死
  「平铺表格」，结构断言不会因为改名而失去覆盖。**但禁止把它改成恒真**（例如只数 `.pm-main` 容器）。
- `.pm-main` 是 `PasswordManagerPage.tsx:65` 的内容容器：无论 B 片是把「成员账号」做成
  `pmSubPage='accounts'` 的一个 case，还是在 Dashboard 内部再分一层，它都落在 `.pm-main` 里。
  **唯一例外**是把 tab 内容挂到 `.pm-main` 之外（例如自建布局）——那 D 片必须换根选择器并写明，
  不许静默降级。
- 若 B 片最终不是 `<table>`（比如 div 网格），D 片必须换成对应选择器并在实现任务的
  `commandsRun`/`evidence_note` 里写明，**不许静默降级**。
- `pmTabs >= 5` 这条同时是「tab 真的加在契约指定的位置」的自证：若 B 片没把 tab 加到
  `PasswordManagerPage` 的 `.tabs`（例如自己在 Dashboard 里另起一条工具栏），它会红并打印
  `pmTabs:4` —— 那是**契约偏离**，要么改实现、要么改契约，**不许为了让门禁绿而把这条放宽成 `>=4`**。

### 3.3 `ctx` + `stableScan` 签名 + `min`

`buildScanExpr`（:274-287）的 `ctx` 加三项，`pageSig`（:602）把 `maRows`/`pmTabs` 并进签名，
否则新页的稳定判据只剩「命中列表」，会重新打开 §2 第 4 条的假绿通道
（顺带决定做 §5.1 的话，再补一项 `sysGroups: document.querySelectorAll('.sysview-name').length`，
`min` 里要用它）：

```js
// buildScanExpr 的 ctx 追加
pmTabs: document.querySelectorAll('.tabs .tab2').length,
maRows: document.querySelectorAll('.pm-main table tbody tr').length,
maFilterOpts: (() => { const s = document.querySelector('.pm-main select'); return s ? s.options.length : 0; })(),
sysGroups: document.querySelectorAll('.sysview-name').length,   // 仅 §5.1 需要
```

```js
// pageSig 追加（保持原有三项不动）
const pageSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.cards, res.ctx.rows, res.ctx.pagers, res.ctx.maRows, res.ctx.pmTabs]);
```

自证行（:890-893）同步打印 `成员账号行 ${ctx.maRows} / 页签 ${ctx.pmTabs} / 按网址筛选选项 ${ctx.maFilterOpts}`。

### 3.4 造数必须补 `accounts`（否则新页永远绿不了，也永远证明不了）

现有 seed（:797-835）造的 25 条条目**没有 `accounts`**，成员账号 tab 会是空态 ⇒ `min.maRows=1` 直接红。
在造数循环里补（前 5 条各 2 个账号 = 10 行，且角色/账号/密码都有值，覆盖「密码打码列」）：

```js
// 与 opaque-entry-<i> 同前缀，收尾按 entries 删除时账号是条目内嵌字段，会一起消失（无需额外清理）
const accounts = i <= 5 ? [
  { id: 'opaque-acc-' + i + '-1', role: '管理员', username: 'admin' + i + '@example.com', password: 'pwdA' + i, note: '造数' },
  { id: 'opaque-acc-' + i + '-2', role: '只读', username: 'viewer' + i + '@example.com', password: 'pwdB' + i, note: '' },
] : [];
await window.electronAPI.entriesAdd({ id: 'opaque-entry-' + i, /* …原字段… */, accounts });
```

造数后打印一行自证（照现有风格）：`带成员账号 5 条 / 账号共 10 个`。

> 实测这条造数路径可行：`%TEMP%\pm-glass-baseline\baseline.log` 首行
> `entries 0 → 25 条，其中带成员账号 5 条 / 账号共 10 个`，收尾 `删样本 25 条，剩 0 条`。

### 3.5 锚点（`TARGETS`，可选但建议）

面积判据受窗口尺寸影响，成员账号 tab 的**筛选下拉 / 表头**值得各加一条带 `token` 的确定性锚点
（token 溯源是 1.32.2 的口径：`alpha<1` 单独不可信，必须证明背景真的来自那条玻璃规则）：

```js
{ sel: '.pm-main select', label: '成员账号 · 按网址筛选下拉', token: '--glass-input',
  pages: ['网址管理 · 成员账号'] },
{ sel: '.pm-main thead th', label: '成员账号 · 表头', token: '--glass-side',
  pages: ['网址管理 · 成员账号'] },
```

两条都要带 `pages` 限制，否则会在别的页面量到别的下拉（`.pager-size` 也是 `<select>`，而且就在
`.pm-main` 里 —— 所以第一条建议写成 `.pm-main select:not(.pager-size)`，或等 B 片落地后换成
`.ma-toolbar select` 这类更具体的选择器）。**类名以 B 片落地为准**；锚点找不到时门禁本来就会红
（`targetExpr` 返回 `found:0` → 违规），不会静默漏掉。

### 3.6 顺序 / 主题 / `restore`（新增钩子）

`PAGES` 的顺序与 `restore` 必须满足：**任何「会改 `pmSubPage`」的页扫完都要切回去**。
推荐顺序与改法：

```js
{ label: '网址管理 · 列表视图', …, prep: (s) => clickText(s, '列表') },
{ label: '网址管理 · 卡片视图', …, prep: (s) => clickText(s, '卡片') },
{ label: '网址管理 · 按系统视图', …, prep: (s) => clickText(s, '按系统'),
  min: { cards: 1, sysGroups: 1, pagers: 1 } },          // §5.1
{ label: '网址管理 · 成员账号', …, prep: …, restore: (s) => clickText(s, '所有网址') },
{ label: '工具箱', … }, { label: '笔记与附件', … }, { label: 'SQL 片段', … },
```

在页面循环里（:859-939）扫描判定之后调用：

```js
if (page.restore && (await page.restore(session)) !== true) {
  throw new Error(`「${page.label}」的 restore 点击落空：这一页改了页面级 tab，`
    + '不切回去会让下一套主题的首个网址管理页落在错误的 tab 上（就绪判据会死等 .toolbar）');
}
```

**为什么必须有**：`pmSubPage` 是 zustand 状态（`src/store/useStore.ts:156` 默认 `'dashboard'`，
`setPmSubPage` 只由 tab 点击与少数快捷键/命令面板动作写，**侧栏导航不会重置**：
`src/App.tsx:212-234` 里只有 Ctrl+N / 搜索这些快捷键才把它写回 `dashboard`），
一次运行的浅色/深色两轮之间**不会重载页面**，扫完成员账号后它留在 `accounts`；
第二轮 `navTo('网址管理')` 就到成员账号 tab，而 `READY_PRED['网址管理 · 列表视图']` 要 `.toolbar` +
`.view-switch-btn===3` → 10s 超时红。这条**不是理论风险**，是「按现有两轮循环必然发生」的。

### 3.7 失败文案（必须有「等什么 + 等多久 + 最后一次实测」）

| 场景 | 文案 |
|---|---|
| 就绪超时 | `等 10000ms「网址管理 · 成员账号 渲染就绪」仍未就绪；最后一次 {"skel":false,"pmTabs":4,…}` ⇒ 若 `pmTabs` 还是 4，说明 **tab 没加进去** |
| prep 落空 | `「网址管理 · 成员账号」的 prep 点击落空：没有含「成员账号」的 button —— tab 文案/控件类型改了（tab2 必须是 <button>）` |
| APPLIED 超时 | `等 5000ms「网址管理 · 成员账号 prep 生效」仍未就绪；最后一次 {"tab":"所有网址","maRows":0}` ⇒ 点到了但没切过去 / 表没渲染 |
| 自证不足 | `✗ 页面自证不足：maRows=0 < 1`（`hint` 里写「造数没带 accounts / 落进空态」） |

## 4. 变异验证（**必须变红**，否则等于没装门禁）

基线绿的证据是 §1.1；下面每条都要记录**命令 / 退出码 / 红在哪一行 / 恢复后复跑绿**。

| # | 变异（临时改，跑完恢复） | 期望红在哪 |
|---|---|---|
| a | `prep` 的 `clickText(s,'成员账号')` 改成 `clickText(s,'成员帐号')`（同音字） | `prep 点击落空`（不是超时、不是自证不足）—— 证明它真的在找那个 tab |
| b | 造数里 `accounts` 恒为 `[]` | `✗ 页面自证不足：maRows=0 < 1`，且 `tab=成员账号` —— 证明空表不会被当成绿 |
| c | 删掉 `restore`（或注释掉 `page.restore` 调用） | 第二轮（dark）首个网址管理页 10s 超时，实测 `skel:false,toolbar:false,swBtn:0` —— 证明这个钩子不是装饰 |
| d | 前端临时给成员账号表加一条 `background: #fff`（或注释掉新 tab 的玻璃规则，前提是 frontend 已补） | 扫描违规列出该元素（class + 尺寸 + 颜色），锚点也红 —— 证明新页真的在判玻璃，不是只走流程 |
| e | 反向控制：全部恢复后连跑 2 次 | 两次都 exit 0，且新页的 `maRows`/`pmTabs` 自证值与第 1~4 条一致 |

> 变异 d 依赖 frontend 先落地新 tab；D 片在**自己的验证轮**做（改完立刻 `git checkout -- src/` 恢复），
> 不把变异留在工作区。

## 5. 要不要一并接入「按系统」和「附件管理」

### 5.1 按系统视图（建议接入，成本 3 行，实测绿）

今天 PAGES 只有列表/卡片，**三视图里的「按系统」从来没有玻璃覆盖**；实测 12 块全白名单、0 违规（§1.2），
说明现在没漏，但也没有任何回归保护 —— 谁改 `.env-section-header` / `.sysview-name` 的底色都不会被拦。
接入方式与列表/卡片同构：共用 `READY_PRED['网址管理 · 列表视图']` 的那条（视图无关），
`APPLIED_PRED` 新增一条 `on==='按系统' && sysview-name>=1 && entry-card>=1`，`min` 加 `sysGroups:1`。
**契约 §5.8 没要求它**，属于顺带补的历史缺口；要不要做由队长定，不做也不影响本批验收。

### 5.2 附件管理 tab（本批**不建议**进，理由三条）

1. **一接就红**：`.pnl-meta`（1,533px²）+ `.notes-dirpath`（9,735px²），深浅各 2 条（§1.3）。
   要绿就得 frontend 补 2 条 CSS（§1.4），属于**第五项改动**、不在本批契约内。
2. **会连带改笔记页就绪判据**：附件页的「笔记目录」条只在 `settings.notesDir` 非空时渲染，
   而设了 `notesDir` 笔记页就进目录模式 → 现有 `READY_PRED['笔记与附件']`（要 `pagers>=1||chips>=1`）
   永久超时（§1.5 第 2 条）。要接就得同时给笔记页加 prep（点「测试笔记」）+ 目录模式容错判据，
   改动面从「加一页」变成「重写两页」。
3. **附件网格仍然扫不到**：`attachment:list` 在临时数据目录里是 0 个附件（`.att-card` 不渲染），
   真要覆盖得造 `.enc` 附件样本（走 `attachment:save` 通道），成本另算。

**替代方案（本批用这个）**：④ 的验收用**一次性 DOM 探针**判，不进玻璃门禁 ——
实测基线是「附件管理 tab：`.att-dir-bar` **2** 个、`.att-dir-bar .att-dir-path` **2** 个文本节点」，
C 片改完后要求 `pathCode === 0` 且各 bar 原有的目录动作仍可用（全局条的「打开 / 更改」、
笔记条的「打开」，见 §5.3 的口径）；
玻璃方面只要求这两条 bar 本体保持 `alpha < 1`（今天已经是 `--glass-input-soft`，见 `redesign.css:8060-8065`，
且**路径 `<code>` 本身是透明底**，所以隐藏它不会改变玻璃结论 —— 实测 `.att-dir-path` 不在命中清单里）。
附件管理页的**玻璃回归**留到下一批（连同 `.pnl-meta` 全站修复一起做，一条 CSS 管 7 个页面）。

### 5.3 契约 §3.4 / §5.7 与现状的两处不一致（C 片和最终判定都要知道）

| 不一致 | 现状（实测代码） | 影响 |
|---|---|---|
| 「两处 `.att-dir-bar` 都只保留『打开目录』『更改目录』两个按钮」 | **只有全局目录条有「更改目录」**：`Attachments.tsx:387-395`（复制路径 / 打开目录 / 更改目录）；笔记目录条是 `:405-410`（**复制路径 / 打开目录**，没有「更改目录」，改笔记目录要去笔记页「切换目录」） | §5.7「两个按钮仍分别触发『打开目录 / 更改目录』」对笔记条**无法字面成立**。判定按「该 bar 原有的动作仍可用」理解，或由 C 片给笔记条补一个「更改目录」（等于改 `notesDir`，多一条 IPC 路径，需队长拍板） |
| 「只保留两个按钮」 | 全局条今天有 **3 个**按钮（含「复制路径」）；隐藏路径文本后「复制路径」是否保留，契约没写 | 我的判定口径：「不再渲染路径文本节点 + 打开/更改目录可用」为通过；「复制路径」保留或删除都不判失败（但删了要在报告里写一句，它是路径仍然可得的唯一入口之一） |

> 这两条不改契约也能验收，但**必须在报告里写明口径**，否则 §5.7 会变成「按谁的理解算过」的口水仗。

## 6. 契约 §5 八条验收与门禁的分工

| 契约 §5 | 判据（机械） | 谁判 | D 片取证方式 |
|---|---|---|---|
| 1 卡片主体开抽屉 / 勾选框只切选中 | DOM + 事件断言（点主体 → 抽屉挂载；点勾选框 → `selectedIds` 变但抽屉不挂载） | A 的 vitest | 引用 vitest 用例名 + 输出；报告里贴「勾选后批量删除按钮出现」的断言行 |
| 2 抽屉 Esc/遮罩/关闭、焦点归还、密码打码、复制走敏感通道 | 键盘/事件断言 + `clipboardCopy` 调用参数（`delay` = 清空秒数） | A 的 vitest | 引用用例 + 实测 `delay > 0` 的 spy 断言 |
| 3 tab 位置 / 聚合 / 筛选 / 空态 | tab 顺序（`pmTabs` 文案数组）、行数 = `Σ entry.accounts`、筛选后行数、空态文案 | B 的 vitest | 玻璃门禁只负责「这一页真的渲染出来」（`maRows>=1`）+ 顺带打印 `maFilterOpts` |
| 4 双向同步 | 同一份 `entry.accounts`：tab 新增后卡片弹窗/抽屉可见；编辑、删除同理 | B 的 vitest | 引用用例；报告注明「同源，无第二份存储」 |
| 5 保存失败（IPC `success:false`） | 界面不变 + 红 toast + `entry.accounts` 未改 | B 的 vitest（stub `entriesUpdate` 返回 `{success:false,error}`） | 引用用例 + 断言 `setVaultData` **没被调用** |
| 6 SQL 三卡顶部全宽 / 卡高 ≤64 / 字号 16 / 1024 仍一行三列 | 几何断言（`getBoundingClientRect().height`、`getComputedStyle().fontSize`、三卡 `top` 相同） | C 的 vitest（jsdom 量不到布局 ⇒ 用几何脚本文本或 r9 的几何断言写法） | 报告贴实测数值（截图 + `height/fontSize/top` 三组数） |
| 7 附件两条目录无路径文本、两按钮可用 | `pathCode === 0`；完整路径进 `title`；两个按钮分别触发既有 IPC（全局条：`attachmentReveal` / `attachmentPickDir`+`attachmentSetDir`；笔记条：`attachmentEnsureNoteDir`+`notesReveal`） | D 的 DOM 探针（§5.2、§5.3） | 实测基线 `pathCode=2` → 改后 `0`，两套主题各一次 |
| 8 `tsc` / `npm run check` / `vitest` / 玻璃门禁 | 命令退出码 | D | 四条命令的**原始输出尾部 + 退出码**贴在报告里；玻璃门禁要求「含成员账号 tab 且 0 违规」 |

## 7. A/B 片写入通道（可直接引用，已逐行核对）

### 7.1 链路（新增 / 编辑条目，也是成员账号写回的唯一通道）

```
EntryForm（src/components/EntryForm.tsx:78-85, 138-149）
  只维护本地 form 状态（accounts 的增/改/删都在 form 里，不碰 IPC）
  handleSave → onSave({ ...form, id, createdAt, updatedAt })      // 整条 PasswordEntry，含 accounts

Dashboard.handleSave（src/pages/Dashboard.tsx:216-232）
  editingEntry ? window.electronAPI.entriesUpdate(entry)          // 编辑
               : window.electronAPI.entriesAdd(entry)             // 新增
  if (result.success && result.data) { store.setVaultData(result.data); 关弹窗; 绿 toast }
  else { addToast(result.error || '保存失败', 'error') }           // 界面不动

主进程 electron/ipc-entries.js:130-160（entries:update）
  按 entry.id 找下标 → vault.entries[idx] = entry（**整条替换**）
  → saveVault → return { success:true, data: vault }              // 回整库，不是回单条

store（src/store/useStore.ts:230）
  setVaultData: (data) => set({ entries: data.entries, tags: data.tags })
```

### 7.2 失败返回形状（A/B 的失败分支按这个写）

| 情况 | 返回值 |
|---|---|
| 成功 | `{ success: true, data: VaultData }`（`data.entries` / `data.tags` 可直接喂 `setVaultData`） |
| 未解锁 | `{ success: false, error: '未解锁' }`（**没有 `data`**） |
| 库损坏 | `{ success: false, error: '数据损坏' }`（没有 `data`） |
| 条目不存在 | `{ success: false, error: '网址不存在' }`（`entries:update` 特有） |
| 抛异常 / 返回空 | `callIpc` 兜底成 `{ ok:false, error:'操作失败，请重试' }`（`src/utils/ipc.ts:35-53`） |

### 7.3 已有同款先例（B 片照抄这个形状就行）

`src/components/OrphanAccounts.tsx:58-103` 的 `attachTo()` —— 把账号挂进 `entry.accounts` 的既有实现：

```ts
const prevAccounts = entry.accounts || [];
const merged = prevAccounts.some(a => a.id === nextAccount.id) ? prevAccounts : [...prevAccounts, nextAccount];
const upd = await callIpc(() => window.electronAPI.entriesUpdate({ ...entry, accounts: merged }));
if (!upd.ok) { addToast(`挂载失败：${upd.error}`, 'error'); return; }   // 失败：不动本地状态
if (upd.data) useStore.getState().setVaultData(upd.data);              // 成功：整库回写
```

### 7.4 三条必须遵守（否则 §5.5 直接破）

1. **必须 spread 整条 entry**：`entries:update` 是**整条替换**（`electron/ipc-entries.js:149`），
   传局部对象会把 `accounts` / `attachments` / `customFields` / `totp` 一起抹掉。
2. **不许乐观更新**：本地状态只在 `success && data` 之后由 `setVaultData` 换掉；
   先改 store 再等 IPC 会让「失败时界面不变」不成立。
3. **写前取最新条目**：从 `useStore.getState().entries.find(e => e.id === entryId)` 取当前值再 spread，
   不要用组件里可能过期的 `entry` 快照（同一窗口内收藏/改环境都会改同一条）。

### 7.5 §5.5 怎么造失败（vitest）

```ts
vi.spyOn(window.electronAPI, 'entriesUpdate').mockResolvedValue({ success: false, error: '写盘失败' });
// 触发新增/编辑 → 断言：红 toast 的文案、store.entries 里该条 accounts 长度不变、setVaultData 未被调用
```

`entriesUpdate` 是 `window.electronAPI` 上的函数（`src/types.ts:960`），stub 这一层就够，不用碰 IPC。

## 8. 边界（本次刻意不做）

- **不改** `scripts/`、`src/`：方案里的代码片段是给 D/frontend 片实现用的，本文不落地。
- **不为消红扩白名单**：`.pnl-meta` / `.notes-dirpath` 的定性是「漏了玻璃」，不是「本应实心」，
  所以修法是补 `--glass-*`，**不是**把它们写进 `WHITELIST`。
- **不把附件页塞进本批玻璃门禁**（理由见 §5.2），④ 用 DOM 探针判。
- **不动** `scripts/lib/app.js`（`navTo` 的 `.pg` 语义问题仍是已知坑，改它要连带跑全部 `ui-*.js`）。
- **不重跑一次就宣布竞态修好**：变异验证每条都要「红一次 + 恢复绿」。

## 9. 残余风险

1. **`.pnl-meta` 是全站问题**：附件 / 禅道 / 周报 / 压测 / 数据生成器 / 接口调试 / 首页都有
   `<Panel meta>` 药丸，背景模式下都是实底；本批只统计了附件页那一个（因为只有它进了探针）。
   下一批建议一条 CSS 修全站，并把这几页纳入扫描组合（顺带把它们的玻璃回归补上）。
2. **新 tab 的类名是外部依赖**：`maRows` 用结构选择器避开了类名耦合，但 `.pm-main select` 依赖
   B 片真的用原生 `<select>` 做「按网址筛选」。若改成自定义下拉，锚点与 `maFilterOpts` 要换写法
   （门禁会红，不会静默漏）。
3. **成员账号 tab 的玻璃规则若落在 `redesign.css` 之外**（例如组件内联 style），门禁仍会红 ——
   这是设计意图：玻璃必须走 token，内联实底不算数。
4. **面积阈值 600px² 对小药丸余量窄**：`.pnl-meta` 70×22 = 1,533 已远超阈值，不存在边缘情况；
   但若将来有人把某药丸缩到 20×20（400px²），它会掉出判据 —— 那是阈值本身的已知盲区，
   本批不调阈值（调阈值等于放宽门禁）。
5. **探针不是门禁**：§5.2 的 DOM 断言只在 D 片的验证轮跑一次，不进 `regress-all.js`；
   将来附件页再改，没有自动回归保护 —— 这条与残余风险 1 一起记成下一批的技术债。
6. **~~A 片新加的详情抽屉是「刻意不透明」的~~ —— 已被队长裁定推翻（2026-11-23）**：
   `redesign.css:8008` 的「浮层类（.modal/.drawer/…）刻意不在此列」是历史口径，
   本批按契约 §8-5 决定**把新抽屉也纳入扫描**，A 片给它补
   `html[data-bg='image'] .drawer.entry-drawer { background-color: var(--glass-modal) }`
   （只作用新抽屉，不动 `.drawer` 本体 → BugDrawer 观感零变化）。具体扫法与锚点见 **§10.2**；
   BugDrawer 仍不在扫描范围（要一起玻璃化属另一片）。

## 10. 补充：2026-11-23 队长裁定 + frontend §7 落地清单（**t6/D1 以本节为准**）

### 10.1 裁定结果（覆盖本文早先的推演）

| # | 裁定 | 对本文的影响 |
|---|---|---|
| ① | tab 宿主：`src/pages/PasswordManagerPage.tsx` **已在 t4 的 inScope**（契约 §8-1），不用再推 | §5.3 不再需要题「文件不在清单里」；tab 键定为 **`members`**、标签 `成员账号`、插在「所有网址」之后（frontend §7.1-1）→ prep 按文案点、restore 仍点「所有网址」 |
| ② | 附件管理 tab **本批不进**玻璃门禁；两条既存泄漏（`.pnl-meta` / `.notes-dirpath`）记 `docs/optimization-backlog.md` P1，**本批不修** | §5.2 的结论被采纳；§1.4 两条「修法」保留作 backlog 参考，不进本批改动 |
| ③ | 附件条口径按契约 §8-4：两条都**删路径文本 + 删「复制路径」**，只留「打开目录 / 更改目录」；笔记条补「更改目录」写 `settings.notesDir`；**不许新增 IPC**；若只有附件目录 picker，退化为「去笔记页改」并在报告写明 | **推翻** frontend §7.1-4 的默认做法（那里写「保留复制路径」）→ 见 §10.6，我按裁定判 §5.7 |
| ④ | **抽屉纳入扫描**（契约 §8-5 + t6 验收）：`.drawer.entry-drawer` 的锚点必须**逐字符等于** `var(--glass-modal)` | §9 残余风险 6 已改写；扫法见 §10.2 |
| ⑤ | t6 依赖 `t3,t4`（A 的抽屉）；`tsc`/`vitest` 统一到 t7 跑 | 本文 §4 的变异验证仍在 t6 做，但不跑 `tsc`/`vitest`（半成品噪声） |

### 10.2 抽屉扫描设计（照 `scanCopyModal` 的骨架，每套主题一遍）

**扫描根**：`document.querySelector('.drawer.entry-drawer')`（**只扫抽屉子树**，不扫 `.drawer-mask`：
那是全窗口压暗层，本来就该半透明；也不扫整个 body，否则会把页面自身的不透明块重复算一遍）。

```js
const DRAWER_SCAN_EXPR = buildScanExpr("document.querySelector('.drawer.entry-drawer')");

/** 打开：点卡片主体（不是勾选框 input —— A 片把根 div 的 onClick 接成「开抽屉」） */
const OPEN_DRAWER_EXPR = `(() => {
  const card = document.querySelector('.entry-card');
  if (!card) return { ok: false, why: '卡片视图里没有 .entry-card' };
  const title = card.querySelector('.card-title');
  card.click();
  return { ok: true, name: title ? (title.textContent || '').trim() : '' };
})()`;

/** 抽屉「真的打开了」：挂载 + 有尺寸 + opacity 1（进场动画结束）+ 标题/键值对已渲染 */
const DRAWER_READY_EXPR = `(() => {
  const d = document.querySelector('.drawer.entry-drawer');
  if (!d) return { ok: false, state: { drawer: 0 } };
  const r = d.getBoundingClientRect();
  const cs = getComputedStyle(d);
  const t = d.querySelector('.drawer-title-text');
  const state = { drawer: 1, w: Math.round(r.width), h: Math.round(r.height),
    opacity: Number(cs.opacity), title: t ? (t.textContent || '').slice(0, 20) : '',
    kv: d.querySelectorAll('.drawer-kv dt').length,
    masks: document.querySelectorAll('.drawer-mask').length };
  // 注意：宽度是否落在契约 420–480 只打印、不作门禁判据（几何归 t7 报告；类名 `entry-drawer` 已够定位）
  const ok = r.width > 0 && Number(cs.opacity) === 1 && !!state.title && state.kv >= 1;
  return { ok, state };
})()`;

/** 关闭：只点抽屉头部的关闭按钮（aria-label=关闭 / .drawer-head .ibtn），退路是派发 Escape。
 *  ⚠️ 绝不能"点第一个 button" —— 抽屉底栏第一个按钮是「编辑」，点了会弹出 EntryForm 模态，污染后续扫描。 */
const CLOSE_DRAWER_EXPR = `(() => {
  const d = document.querySelector('.drawer.entry-drawer');
  if (!d) return true;
  const b = d.querySelector('.drawer-head [aria-label="关闭"]') || d.querySelector('.drawer-head .ibtn');
  if (b) { b.click(); return true; }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`;

const DRAWER_GONE_EXPR = `(() => ({ ok: !document.querySelector('.drawer.entry-drawer'),
  state: { drawers: document.querySelectorAll('.drawer').length } }))()`;

/** 锚点：面板背景必须逐字符等于 var(--glass-modal)（队长裁定 ④） */
const DRAWER_TARGETS = [
  { sel: '.drawer.entry-drawer', label: '.drawer.entry-drawer（卡片详情抽屉面板）', token: '--glass-modal' },
];
```

**流程（`scanEntryDrawer(session, ev, theme, violations)`，在页面循环之后、`scanCopyModal` 之前/之后皆可）**

1. `navTo('网址管理')` → `waitPageReady(PAGES 里「网址管理 · 卡片视图」)` → prep 点「卡片」→ 等 APPLIED。
2. `OPEN_DRAWER_EXPR`，返回 `ok:false` 直接 **throw**（不许静默跳过 —— 跳过等于这一段门禁没装）。
3. `waitUntil(DRAWER_READY_EXPR, 5000)` → `settleAnimations('抽屉打开后')`。
4. **重新钉主题并复验**（抽屉是新挂载组件，可能按 `settings.theme` 重写 `data-theme`；与弹窗同一坑）。
5. `settleAnimations('抽屉钉主题后')` → `stableScan(DRAWER_SCAN_EXPR, drawerSig)`。
6. 扫出 `good/bad`，打印自证行（`抽屉宽×高 / 标题 / kv 项 / 遮罩 1`）；`bad` 计入 `violations`。
7. 量 `DRAWER_TARGETS`：`.drawer.entry-drawer` 必须 `tokenMatch === true && alpha < 1`；
   若 alpha ≥ 1 → 打印「仍是实底，会挡住背景图」并计违规。
8. `CLOSE_DRAWER_EXPR` → `waitUntil(DRAWER_GONE_EXPR, 3000)`；关不掉 **throw**（残留抽屉会让后续页面/主题扫描失真）。

**稳定性签名（顺手修掉一个既有弱点）**

```js
// 抽屉扫描的签名：块列表 + 抽屉自证。⚠️ 现有 modalSig 的 `ctx.modalInputs / ctx.preLen`
// 在 buildScanExpr 的 ctx 里**根本不存在**（查过：ctx 只有 cards/rows/badges/primaryBtns/kbds/
// stats/tagItems/sqlRows/pagers/pagerCur/pagerInfo）→ JSON.stringify([undefined,undefined])
// 恒为 "[null,null]"，等于**弹窗的稳定判据一直只看命中列表**。
// t6 顺手把这两个字段补进 ctx（2 行），抽屉用同一套：
const drawerSig = (res) => JSON.stringify(res.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
  + '|' + JSON.stringify([res.ctx.drawerKv, res.ctx.drawerTitle]);
// buildScanExpr 的 ctx 追加（对弹窗同样生效）：
//   modalInputs: document.querySelectorAll('.modal .modal-body input:not([type=checkbox]):not([type=radio])').length,
//   preLen: (document.querySelector('pre.sql-var-preview') || {}).textContent?.length || 0,
//   drawerKv: document.querySelectorAll('.drawer.entry-drawer .drawer-kv dt').length,
//   drawerTitle: (document.querySelector('.drawer.entry-drawer .drawer-title-text') || {}).textContent || '',
```

**已知坑（写进实现注释）**

- 抽屉子树里**任何** alpha ≥ 0.999 且 > 600px² 的块都是违规：账号只读行、密码显示框、
  键值对区块、底部操作条，只要 A 片给它们留了实底就会红 —— **由 A 补玻璃，白名单不新增**
  （唯一可能命中的既有条目是底栏主按钮 `.btn-primary`）。
- 成员账号 tab 里 B 片也渲染了一个 `<EntryDetailDrawer>`（只传 `open/entry/trigger/onClose`，
  frontend §7.4）。**它必须在 `open=false` 时不渲染（或 `display:none`）**，否则成员账号页扫描会把
  一个空抽屉骨架算成不透明块 → 误红。t6 第一次跑就要确认这一点（这是「B 片实现细节影响门禁」的唯一交接点，
  实测若真渲染了就报给 frontend，不要去白名单里加抽屉）。
- 打开抽屉会触发 `recordEntryUse`（写 `pm.recent.entries`）—— 本脚本不依赖「最近」排序，
  但为了不改变别的 `ui-*` 回归脚本的默认视图，抽屉扫描放在**页面循环之后**做，跑完把页面留在网址管理。

**变异验证（t6 必做，补进 §4 的表）**

| # | 变异 | 期望红在哪 |
|---|---|---|
| f | 注释掉 `html[data-bg='image'] .drawer.entry-drawer { background-color: var(--glass-modal) }` | 锚点红（`不是 var(--glass-modal)`）+ 扫描把 460×全高（≈ 460×700 = 322,000px²）记成违规 —— 证明抽屉这段真的在判玻璃 |
| g | 把 `CLOSE_DRAWER_EXPR` 的头部关闭按钮选择器改成 `.drawer-foot button`（模拟点错按钮） | 关闭超时红或后续页面扫描出现 `EntryForm` 模态残留 —— 证明「只点头部关闭按钮」不是洁癖 |
| h | `OPEN_DRAWER_EXPR` 改成点 `input[type=checkbox]` | 抽屉永不出现 → `DRAWER_READY` 5s 超时红 —— 证明它是通过卡片主体打开的（与 §5.1「点勾选框不开抽屉」互相印证） |

### 10.3 最终选择器（**覆盖 §3.2 / §3.3 / §3.5 的推演**）

| 用途 | 推演（§3） | 最终（按 frontend §7.4 + 裁定） |
|---|---|---|
| tab 键 | `accounts` | **`members`**（`pmSubPage === 'members'`；只影响 restore 的说明文字，prep 仍按文案「成员账号」点） |
| 账号行自证 | `.pm-main table tbody tr` | **`.pm-main table.tbl tbody tr`**（B 复用既有 `.tbl`） |
| 按网址筛选 | `.pm-main select` | **`.mem-acc-filters select`**（退路 `.pm-main select:not(.pager-size)`） |
| 工具条锚点 | 无 | **`.mem-acc-bar`**，token `--glass-side`（frontend §7.4-5 指定） |
| 表头锚点 | `.pm-main thead th` | **`.pm-main table.tbl th`**，token `--glass-side`（依据 `redesign.css:7944` 的 `:is(.toolbar,.entry-table th,.zt-table th,.tbl th)` 规则 —— 这条是**既有**规则，锚点能真正证明「表头玻璃命中」，不是新加的） |
| 操作列按钮锚点 | 无 | **先不接**：B 的按钮是 `.btn-ghost`（透明底），带 `--glass-control` 的锚点会假红；等实测再加 |
| 自证 min | `{ maRows: 1 }` | `{ maRows: 1 }`（key 名不变）+ 顺带打印 `maFilterOpts`、`pmTabs` |

### 10.4 附件条口径（裁定后的判定标准，t7 用）

- **C 要删的按钮从「保留复制路径」变成「删复制路径」**（裁定 ③），frontend §7.1-4 的默认做法作废（见 §10.6）。
- 笔记条「更改目录」**不需要退化**：仓库已有现成通道 —— `window.electronAPI.notesPickDir()`（`Notes.tsx:439` 用的就是它）
  + `window.electronAPI.settingsSave({ notesDir })`（`Notes.tsx:446`），C 片可**零新增 IPC** 实现；
  若 C 仍选「去笔记页改」的退化方案，按裁定在报告里写明也算通过。
- 我 t7 的判定口径：
  1. 两条 `.att-dir-bar` 里 `.att-dir-path` 数量 = **0**，且两条 bar 的 `textContent` 不含目录绝对路径；
  2. 完整路径在「打开目录」按钮的 `title` 里；
  3. 全局条剩「打开目录 / 更改目录」两个按钮（`attachmentReveal` / `attachmentPickDir`+`attachmentSetDir`）；
  4. 笔记条剩「打开目录 / 更改目录」两个按钮（`attachmentEnsureNoteDir`+`notesReveal` / `notesPickDir`+`settingsSave`），
     若走退化方案则是「打开目录 + 去笔记页改」；
  5. **不许新增 IPC**（`git diff electron/preload.js electron/ipc-*.js` 为空）。

### 10.5 C 片移卡对 SQL 页扫描的影响（零改动）

- 自证不变：`.home-stat` 仍 3、`.sql-table tbody tr` 仍 ≥2（C 只挪位置与尺寸）→ `READY_PRED['SQL 片段']` **不用改**。
- C 新增 `html[data-bg='image'] .sql-kpi-top .home-stat { background: var(--glass-inset) }` → alpha < 1，不新增违规。
- 可选加固：给 `.sql-kpi-top .home-stat` 加一条 token `--glass-inset` 的锚点，证明玻璃是**新规则**命中，
  而不是旧的选择器残留（移出 `.pm-shell` 后旧规则不再命中，这条锚点能抓住「忘了补玻璃」的回归）。

### 10.6 需要 C/B 知道的一条冲突（我按裁定判，已上报队长）

frontend §7.1-4 的默认做法是「**保留**『复制路径』，只删路径文本」；队长 2026-11-23 的裁定是
「**删路径文本 + 删复制路径**，只留打开/更改目录」。两者不一致，**以裁定为准**。
若 C 已按 §7.1-4 落地（保留了「复制路径」），§5.7 我会按裁定判**不通过**并指明要删哪个按钮；
若 C 认为保留更合理，应由队长改裁定、而不是在实现里默认保留。

### 10.7 t6 实现顺序（建议）

1. 先只加「成员账号」页（PAGES + 两条判据 + ctx + pageSig + min + 造数 + restore）→ 连跑 2 次绿。
2. 再加 `scanEntryDrawer()`（含 ctx 补 `modalInputs/preLen/drawerKv/drawerTitle`）→ 连跑 2 次绿。
3. 再做 §4 的变异 a–h（逐条红 → 恢复 → 绿）。
4. 最后决定要不要接「按系统」（§5.1，3 行）—— 接了就按 §5.1 的 pred/min 加，并把 `sysGroups` 并进 `pageSig`。
5. 全绿后把四次运行的**原始输出尾部 + 退出码**和变异记录交给 t7。

## 附：本次实测的命令与证据位置（一次性，均不入库）

```powershell
# 1) 官方门禁现状（exit 0，12 组合）
node scripts/ui-glass-opaque-scan.js
#    → %TEMP%\pm-glass-baseline\glass-baseline-official.log

# 2) 补充探针（按系统视图 / 附件管理 tab / 目录模式笔记，入口 9843）
node %TEMP%\pm-glass-baseline\baseline.js %TEMP%\pm-glass-baseline\baseline.json
#    → baseline.log（逐块 ✓/✗ + 页面自证）、baseline.json（结构化命中清单）

# 3) 全程未改仓库代码（跑基线时的工作区）
git status --porcelain    # 仅 docs/agents/entry-ux-next.md（契约）；本文是跑完之后才写的
```

> 注：本文落盘时 `git status` 已多出 `src/utils/__tests__/entryDetail.test.tsx` —— 那是 A 片在并行开工，
> 与本基线无关（基线钉在 `dist` 14:38 那一份，见 §1.1）。

