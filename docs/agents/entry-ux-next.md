# 一页方案：网址管理 / SQL 片段 / 附件 四项体验改造

> 2026-11-23。用户 5 个裁定：①卡片加勾选框，勾选才选中；②详情用右侧抽屉；③成员账号 tab 用平铺表格 + 按网址筛选；④tab 里可新增/编辑/删除；⑤SQL 三张统计卡保留、移到页面顶部。
> 本文是契约，批准后按 §4 分片下发；验收按 §5 逐条判真假。

## 1. 关键现状（勘察结论，别再猜）

- **成员账号不是新概念**：`PasswordEntry.accounts?: EntryAccount[]`（`types.ts:79`，`EntryAccount{id, role, username, password, note}`）。v3 已把旧「测试账号」集合合并进条目；`components/OrphanAccounts.tsx` 负责把遗留 `accounts` 集合里的孤儿挂回条目。
- **卡片已有只读的「其他角色账号」弹窗**（`EntryCard.tsx:73-124`，标题「…的其他角色账号（N）」），只支持显示/复制，不能增删改。
- **现在点卡片 = 勾选**（`EntryCard.tsx:153` → `toggleSelected`），批量删除 / 导出 / 改环境都依赖 `selectedIds`。改成开详情后必须给多选留入口（用户选：卡片上加勾选框）。
- 抽屉有现成范式：`components/BugDrawer.tsx`（右侧滑出 + Esc + 焦点归还），新抽屉复用同一套类与交互。
- 玻璃体系：`html[data-bg='image']` 下按 `--glass-*` 上透明底；容器禁止 `backdrop-filter`（`scripts/check-stacking.js` 拦截）。

## 2. 范围

**做**：①网址管理点击开详情抽屉 + 勾选框负责多选；②网址管理新增「成员账号」tab（聚合 + 增删改，与条目内 `accounts` 同源同步）；③SQL 片段三张统计卡移到页面顶部全宽并压缩尺寸；④附件页隐藏两个目录的路径文本，只留「打开目录 / 更改目录」。

**不做**：不改 vault 结构（`EntryAccount` 字段不动）；不做列表视图的详情（本次只改卡片视图，列表行保持点击选中）；不动孤儿账号迁移逻辑；不给 SQL 片段加新功能；不动提示语体系（上批已改完）。

## 3. 逐项契约

### 3.1 卡片详情抽屉

- 卡片主体 `onClick` / 键盘 Enter/Space → 打开 `EntryDetailDrawer`；**卡片左上角新增勾选框**（`aria-label="选择 <名称>"`），只有它（以及全选/批量条）改 `selectedIds`。
- 抽屉宽度 420–480px，右侧滑出，复用 `.drawer` 体系；Esc / 点遮罩 / 「关闭」都能关，关闭后焦点回到触发它的卡片（可访问性硬要求）。
- 内容：名称 + 环境徽标、URL（复制 / 打开）、用户名（复制）、密码（默认打码，显示 / 复制）、TOTP（有就显示当前码与剩余秒数，没有就不占位）、标签、备注、其他角色账号（只读列表 + 复制，与卡片现有弹窗同一份数据）、附件数量、创建 / 更新时间。
- **密码与含密码的复制必须走 `copySensitive`**（主进程定时清空剪贴板），不能普通 `copyPlain`。
- 底部操作：编辑（复用现有编辑弹窗）、删除（走既有二次确认）、关闭。

### 3.2 成员账号 tab

- `Dashboard` 顶部 tab 顺序：**所有网址 → 成员账号 → 回收站 → 导入数据 → 导出数据**。
- 数据 = `entries.flatMap(e => (e.accounts || []).map(a => ({ ...a, entryId, entryName, envType })))`；空态文案：「还没有成员账号。在任意网址的详情抽屉或卡片里的账号弹窗新增，会出现在这里」。
- 表格列：**网址**（点击打开该条详情抽屉）/ 环境 / 角色 / 账号 / 密码（打码 + 显示/复制）/ 备注 / 操作（编辑、删除）。
- 筛选：按网址（下拉，含「全部」）+ 关键字（账号 / 角色 / 网址名）；默认按网址名 + 角色排序。
- 新增表单：**所属网址（必填，下拉）** / 角色 / 账号 / 密码 / 备注；写回该 entry 的 `accounts`（新 id，用 `utils/id.ts` 的 `newId`）。
- 编辑 / 删除同样写回对应 entry 的 `accounts`；删除要 `useConfirm` 二次确认。
- **同步口径**：数据同源（`entry.accounts`），卡片里的账号弹窗与 tab 天然一致；两处都遵守「先落盘成功再更新界面」，失败红 toast + 不改本地状态。
- 玻璃：新 tab 的表头 / 工具条 / 行在 `html[data-bg='image']` 下走既有 `--glass-*`；不加 `backdrop-filter` / `z-index`；要进入 `ui-glass-opaque-scan` 的扫描组合。

### 3.3 SQL 片段统计卡

- 三张卡从右栏**移到页面顶部全宽**（页头下方、`.pm-shell` 之上），仍是「全部片段 / 收藏 / 本周新增」三列。
- 压缩：卡高 ≤ 64px、数字字号 20 → 16、标签 12 → 11、内边距减半；宽度 < 1100px 仍一行三列不换行。
- 口径不变（继续用 `countSql`），只动位置与尺寸。

### 3.4 附件页目录条

- 笔记目录与全局附件目录两处 `.att-dir-bar`：**不再渲染路径文本，也去掉「复制路径」**，只保留「打开目录」「更改目录」两个按钮；完整路径放进「打开目录」的 `title`（悬停可见）。
- 全局附件目录条的「更改目录」沿用现有选目录 IPC；笔记目录条原本没有这个按钮，本次补上，写 `settings.notesDir`（与笔记页 / 设置页同一字段），改完提示「笔记页目录已同步」。若现有 IPC 只能选附件目录，则该按钮退化为「去笔记页改」（跳转 notes 页），并在交付说明里写明用了哪种。
- 未配置目录时保持现有行为（按钮禁用 / 提示先选目录）。

## 4. 分片（批准后下发）

| 片 | 内容 | 文件 |
|---|---|---|
| A（frontend） | 3.1 抽屉 + 勾选框 | `src/components/EntryCard.tsx`、`src/components/EntryDetailDrawer.tsx`(新)、`src/components/EntryExtras.tsx`(TotpBadge 可选 prop)、`src/pages/Dashboard.tsx`(仅在需要页面级状态时)、`src/pages/PasswordManagerPage.tsx`(同上)、`src/styles/redesign.css`(末尾两条抽屉规则)、`src/utils/__tests__/entryDetail.test.tsx`(新) |
| B（frontend，依赖 A） | 3.2 成员账号 tab | `src/pages/PasswordManagerPage.tsx`(**tab 宿主在这里**，不在 Dashboard)、`src/components/MemberAccountsTab.tsx`(新)、`src/utils/__tests__/memberAccounts.test.tsx`(新) |
| C（frontend，依赖 A） | 3.3 + 3.4 | `src/pages/SqlSnippets.tsx`、`src/pages/Attachments.tsx`、`src/styles/redesign.css`(A 之后追加)、`src/utils/__tests__/sqlSnippets.test.tsx`、`src/utils/__tests__/attachmentsDirBar.test.tsx`(新) |
| D（qa，依赖 A/B/C） | 玻璃门禁 + 回归证据 | `scripts/ui-glass-opaque-scan.js`（把成员账号 tab 加进扫描页）、报告 |

A 与 B 都改 `Dashboard.tsx`，串行；C 路径与 A/B 不重叠，可并行。

## 5. 验收（逐条可判真假）

1. 卡片视图：点卡片主体开抽屉；点左上勾选框只切换选中、**不**开抽屉；勾选后批量删除按钮仍出现且能删。
2. 抽屉：Esc / 点遮罩 / 关闭按钮都能关；关闭后焦点回到原卡片；密码默认打码；「复制密码」后剪贴板内容 = 该账号密码（且走敏感通道）。
3. 成员账号 tab 在「所有网址」之后；列出所有条目的 `accounts`；按网址筛选生效；空态文案正确。
4. 在 tab 里给某网址新增账号 → 该网址卡片里的「其他角色账号」弹窗与抽屉里都能看到同一条；编辑角色/账号/密码同样双向可见；删除后两处同时消失。
5. 保存失败（模拟 IPC 返回 success:false）：界面不变 + 红 toast，`entry.accounts` 未被改（贴证据）。
6. SQL 片段：三张卡在页头下方全宽；实测卡高 ≤ 64px、数字字号 16；宽 1024 仍一行三列（几何断言或截图）。
7. 附件页：两条目录都不再出现路径文本节点；两个按钮仍分别触发「打开目录 / 更改目录」。
8. `npx tsc --noEmit`、`npm run check`、`npx vitest run` 全绿；`node scripts/ui-glass-opaque-scan.js` 含成员账号 tab 且 0 违规。

## 6. 风险

- `Dashboard.tsx` 已 900+ 行，A/B 两片都会改它 → 必须串行，且新组件各自独立，不要往 Dashboard 里再堆逻辑。
- 抽屉与卡片里的「其他角色账号」弹窗职责重叠：抽屉只做只读展示 + 复制，增删改只在 tab 与（既有）编辑入口里做，避免三处写同一份数据。
- 密码展示/复制的既有安全口径（打码、敏感复制、审计日志）不能破坏，A 片必须先读 `EntryForm` 与 `EntryCard` 现有实现再动手。

---

## 7 实现清单（frontend）

> 2026-11-23。A/B/C 三片的可执行清单：每片的文件、组件 props、状态归属、单测用例（含边界）。
> **不改 §1–§6 契约**。与现状对不上的 5 处集中在 §7.1，等队长裁定；其余按「本清单默认做法」落地。
> 通用步法（三片都一样）：先写用例 → 跑一遍确认红 → 最小实现 → 跑绿 → `npx tsc --noEmit` + `npm run check`。

### 7.1 与现状对不上的 5 处（待队长裁定，frontend 不自行改契约）

| # | 契约原文 | 现状（已核） | 本清单默认做法 |
|---|---|---|---|
| 1 | §3.2「`Dashboard` 顶部 tab 顺序…」+ §4-B 文件只列 `Dashboard.tsx` | 四个 tab 不在 `Dashboard.tsx`，在 `src/pages/PasswordManagerPage.tsx:13-18`（`subNavItems`）+ `:50-61`（`.tabs`/`.tab2`）+ `:27-34`（`renderSubPage`，局部 `type SubPage`）；store 的 `pmSubPage` 是 `string`（`useStore.ts:36`），不用改类型 | **B 片必须改 `PasswordManagerPage.tsx`**：`SubPage` 联合加 `'members'`；`subNavItems` 第 2 项插 `{ key: 'members', label: '成员账号' }`；`renderSubPage` 加 `case 'members'`；`{subPage === 'dashboard' && <TagSidebar/>}` 保持不变（成员账号 tab 无侧栏）。请把该文件补进 §4-B |
| 2 | §3.1「TOTP（有就显示当前码与剩余秒数）」 | `src/components/EntryExtras.tsx:55 TotpBadge` 只显示 `code`，**没有剩余秒数**；卡片调用点在 `EntryCard.tsx:215` | `TotpBadge` 加可选 `showRemaining?: boolean`（默认 `false`，卡片调用点一字不动）；抽屉传 `true`：剩余秒 = `30 - Math.floor(Date.now()/1000) % 30`，与现有 1s `setInterval` 同一次 tick 内算出 |
| 3 | §3.1「抽屉宽度 420–480px，复用 `.drawer` 体系」 | `.drawer` 固定 `width: 520px`（`src/styles/pages.css:2079`），超上限 40px | 不改原规则（BugDrawer 在用）；`redesign.css` 末尾加 `.drawer.entry-drawer { width: 460px; max-width: 92vw; }`（AGENTS：新样式一律写 `redesign.css` 末尾并注明原因） |
| 4 | §3.4「不再渲染路径文本，只保留『打开目录』『更改目录』两个按钮」 | 全局目录条有 **3 个**按钮：复制路径 / 打开目录 / 更改目录（`Attachments.tsx:387-395`）；**笔记目录条只有 2 个**：复制路径 / 打开目录（`:405-411`），它跟着笔记目录设置走，没有「更改目录」 | 只删路径文本 `<code className="att-dir-path">`（两处），路径塞进「打开目录」按钮 `title`；**保留「复制路径」**（删掉等于砍能力）。「更改目录」仅全局条有。若坚持字面「只留两个按钮」，笔记条会只剩一个，需要队长拍 |
| 5 | §2/§3.2 玻璃口径（`--glass-*`、禁 `backdrop-filter`/`z-index`） | 全仓库**没有任何 `.drawer` 的 `data-bg='image'` 玻璃规则**（grep 无命中）；抽屉是实心 `--bg-card`，尺寸 520×全高 > 601px² 判据 | A 片补一条**只作用于新抽屉**的 `html[data-bg='image'] .drawer.entry-drawer { background-color: var(--glass-modal); }`（不动 `.drawer` 本体，BugDrawer 观感零变化）；并请 qa 在 D 片明确「抽屉是否纳入 `ui-glass-opaque-scan`」。要连 BugDrawer 一起玻璃化属另一片 |

**另外两件必须在片内连带处理的事（不是契约冲突，是既有实现依赖）：**

1. **C 片移卡会打断一条既有样式**：`redesign.css:8197`
   `html:not([data-bg='image']) .pm-shell .home-stats .home-stat { background: var(--surface-2); border: 1px solid var(--line); }`
   三卡移出 `.pm-shell` 后这条不再命中，普通模式下三卡会退回无边框的 `--surface-inset`（浅色下几乎看不出是卡片）。C 片必须在 `redesign.css` 末尾补等价选择器（见 §7.5）。
2. **§4-C 文件清单缺附件页测试**：§5-7 要「两条目录都不再出现路径文本节点」，`vitest` 里没有对应测试文件。建议新增 `src/utils/__tests__/attachmentsDirBar.test.tsx`（渲染整页 + 打桩 IPC，与 `sqlSnippets.test.tsx` 同一套路）。不扩的话这一条只能靠 qa 的浏览器脚本覆盖。

`useConfirm` 是**真存在**的（`src/components/confirm.tsx`，返回 `{ ask, confirmNode, close }`，`EntryList.tsx:106` 在用），§3.2 的写法无需调整；注意 import 路径是 `components/confirm` 而不是 `hooks/`。

### 7.2 文件边界（只碰这些）

| 片 | 改 | 新建 |
|---|---|---|
| A | `src/components/EntryCard.tsx`、`src/pages/Dashboard.tsx`、`src/styles/redesign.css`（末尾）、`src/components/EntryExtras.tsx`（`TotpBadge` 加一个可选 prop，仅此） | `src/components/EntryDetailDrawer.tsx`、`src/utils/__tests__/entryDetail.test.tsx` |
| B | `src/pages/PasswordManagerPage.tsx`（§7.1-1 + `members` 分支的抽屉实例）、`src/styles/redesign.css`（末尾） | `src/components/MemberAccountsTab.tsx`、`src/utils/__tests__/memberAccounts.test.tsx` |
| C | `src/pages/SqlSnippets.tsx`、`src/pages/Attachments.tsx`、`src/styles/redesign.css`（末尾）、`src/utils/__tests__/sqlSnippets.test.tsx`（追加） | `src/utils/__tests__/attachmentsDirBar.test.tsx`（§7.1 第 2 条，待裁定） |

**零改动**：`src/types.ts`、`electron/**`、`EntryAccount` 字段、`vault` 结构、`OrphanAccounts.tsx`、孤儿迁移逻辑、列表视图（`EntryList.tsx` 保持点击选中）。

### 7.3 A 片：卡片详情抽屉 + 勾选框

**文件与改动点**

- `src/components/EntryCard.tsx`
  - `Props` 加 `onOpenDetail?: (entry: PasswordEntry, trigger: HTMLElement) => void`；其余 props 不动。
  - 卡片根 `div` 的 `onClick`：`recordEntryUse(entry.id)` **保留**（`scripts/ui-round17-test.js:229` 靠它验「最近」条），把 `toggleSelected` 换成 `onOpenDetail?.(entry, e.currentTarget)`。
  - 保留 `tabIndex={0}` + `onKeyDown={onKeyClickStrict}`（键盘 Enter/Space 等价点击；内部按钮不冒泡误触发）。
  - 卡片**左上角**（`.card-header` 的第一个子元素）新增勾选框：`<label className="entry-card-check"><input type="checkbox" checked={selected} onChange={() => toggleSelected(entry.id)} onClick={e => e.stopPropagation()} aria-label={\`选择 ${entry.name}\`} /></label>`。勾选框是**唯一**改 `selectedIds` 的卡片内元素。放流内而不是绝对定位：`.card-header` 同一行左边已有收藏 ★ 按钮，绝对定位会压住它。
  - 根 `div` 保留 `className={\`entry-card ${selected ? 'selected' : ''}\`}`（选中态高亮仍靠它）。**去掉 `aria-selected`**（普通 div 上不合法，状态已交给 checkbox 的 `checked`；已 grep 确认 `scripts/*.js` 没有依赖该属性）。
  - 卡片里的「+N 其他角色账号」弹窗 `AccountsModal` **原样保留**（§3.2 同步口径靠它）。
- `src/components/EntryDetailDrawer.tsx`（新）
- `src/pages/Dashboard.tsx`
  - 新增页面级状态 `const [detail, setDetail] = useState<{ entry: PasswordEntry; trigger: HTMLElement | null } | null>(null);`
  - 两处 `<EntryCard>`（卡片视图 `:670`、按系统视图 `:712`）都加 `onOpenDetail={(entry, trigger) => setDetail({ entry, trigger })}`。
  - 渲染 `<EntryDetailDrawer open={!!detail} entry={detail?.entry ?? null} trigger={detail?.trigger ?? null} onClose={() => setDetail(null)} onEdit={...} onDelete={...} onCopy={handleCopy} onOpen={handleOpenUrl} />`，放在 `EntryForm` 弹窗之前。
  - `onEdit` = 既有的 `e => { setDetail(null); setEditingEntry(e); setShowForm(true); }`；`onDelete` = 打开既有 `ConfirmDialog`（复用 `useConfirm()` 的 `ask({ title:'彻底删除网址', message:\`确定彻底删除「…」？…\`, confirmText:'彻底删除', onOk })`，`onOk` 里 `entriesDelete({ ids: [entry.id], permanent: true })` → 成功再 `setVaultData` + `setDetail(null)`，失败红 toast 且**不关抽屉**）。
  - 抽屉的 `entry` 用 **store 里的实时副本**（`store.entries.find(e => e.id === detail.entry.id) ?? detail.entry`），否则编辑保存后抽屉里还是旧值。
- `src/components/EntryExtras.tsx`：仅 `TotpBadge` 加 `showRemaining?: boolean`。
- `src/styles/redesign.css` 末尾：`.drawer.entry-drawer{width:460px;max-width:92vw}` + 玻璃一条（§7.1-5）+ `.entry-card-check` 的排布（**不绝对定位**：勾选框作为 `.card-header` 的**第一个子元素**参与流式布局——左上角就是它，且不会压住已在同一行的收藏 ★ 按钮；样式只需 `.entry-card-check{display:inline-flex;align-items:center;margin-right:2px;flex:0 0 auto;cursor:pointer}` 与 `.entry-card-check input{width:15px;height:15px;accent-color:var(--accent)}`，不新增色值字面量）。

**组件契约（props）**

| 组件 | props |
|---|---|
| `EntryCard` | `entry; onEdit; onCopy; onOpen?; security?; onToggleFavorite?; onOpenDetail?` |
| `EntryDetailDrawer` | `open: boolean; entry: PasswordEntry \| null; trigger: HTMLElement \| null; onClose(): void; onEdit?(e): void; onDelete?(e): void; onCopy?(text, label, entryName?): void; onOpen?(url): void` —— **可选回调未传时不渲染对应控件**（B 片只传 `onClose`） |

**状态归属**

| 状态 | 归属 | 说明 |
|---|---|---|
| 哪条在抽屉里 / 触发元素 | `Dashboard`（`detail`，`useState`） | 页面级 UI 状态，不进 store |
| 哪个勾选框选中 | `store.selectedIds`（只经 `toggleSelected`） | **卡片/抽屉都不持有**选中态副本 |
| 卡片内「密码已显示」「账号弹窗开合」 | `EntryCard` 本地 `useState`（现状不变） | 离开卡片即复位 |
| 抽屉内「主密码已显示」/「哪些账号密码已显示」 | `EntryDetailDrawer` 本地 `useState`，`open` 变 true 时全部复位打码 | 沿用 `AccountsModal.tsx:61` 的复位范式 |
| 编辑弹窗 / 删除确认 | `Dashboard`（既有 `showForm`/`editingEntry`/`useConfirm`） | 不在抽屉里重造 |

**交互硬判据**

1. 点卡片主体 → 开抽屉；点左上勾选框 → 只切选中、**不**开抽屉（`stopPropagation` + 独立 `onChange`）。
2. Esc / 点 `.drawer-mask` / 「关闭」按钮三条路都调 `onClose`；Esc 用 `document.addEventListener('keydown')` 且**只在抽屉打开时挂**（照 `BugDrawer.tsx:46-56`，但 BugDrawer 的 Esc 不判 `isTopOverlay`，抽屉与 Modal 叠开时要注意：抽屉内不打开任何 Modal，顺序是「先开抽屉 → 再点编辑」，编辑弹窗是 Modal，Esc 由 Modal 的 overlayStack 处理，抽屉的监听必须在 `!isTopOverlay` 时不动作 —— 复用 `components/overlayStack` 的 `pushOverlay/isTopOverlay` 判一层）。
3. 焦点归还：抽屉打开时 `restoreRef.current = document.activeElement`，卸载/关闭时 `if (document.contains(back)) back.focus()`（照 `Modal.tsx:99/122-125`）。`trigger` 作为**兜底**：`document.activeElement` 为 `body` 时改聚焦 `trigger`。
4. 密码默认打码（`••••••••`），点「显示」才真实渲染；`open` 每次变 true 复位。
5. 主密码与账号密码的「复制」一律走 `copySensitive`（`utils/clipboard.ts`）；走 Dashboard 的 `onCopy` 也行——它内部按 `isSensitiveLabel(label)` 判敏感并传 `delay`，**label 必须含「密码」**（`密码` / `管理员-密码`），否则不会定时清空。

**单测清单 `src/utils/__tests__/entryDetail.test.tsx`（新，`@vitest-environment jsdom`，`stubElectronApi` 照 `sqlSnippets.test.tsx:209` 的 Proxy 写法）**

卡片：
1. 勾选框存在且 `aria-label="选择 <名称>"`；`fireEvent.click(check)` → `useStore.getState().selectedIds.has(id) === true`，且 `onOpenDetail` **未被调用**。
2. 点勾选框**不改** `selectedIds` 以外的状态：`searchQuery / filterEnv / sortField / sortOrder / viewMode / entries` 逐项快照前后相等，`localStorage['pm.recent.entries']` 不变（选 ≠ 用）。
3. 点卡片主体（`.entry-card`）→ `onOpenDetail(entry, HTMLElement)` 被调用一次，`selectedIds.size` 仍为 0，`localStorage['pm.recent.entries']` 里出现该 id（`recordEntryUse` 未被误删）。
4. 键盘：卡片自身 `Enter`/`Space` → 触发一次 `onOpenDetail`；焦点在内部按钮上按 Enter → **不**触发（`onKeyClickStrict`）。
5. `checked` 与 store 同步：外部 `toggleSelected` 后重渲染，`checkbox.checked === true` 且根部 `class` 含 `selected`；`aria-selected` 已不存在。

抽屉：
6. 内容齐：名称、环境徽标文本、URL、用户名、备注、标签、「其他角色账号（N）」只读列表、附件数量、创建/更新时间（用 `formatDateTime`）。
7. 密码默认打码：渲染后 `.entry-detail-pwd` 文本 === `'••••••••'`，**不包含**明文；点「显示」后包含明文；再点回打码。
8. 复制密码走敏感通道：点「复制密码」→ `clipboardCopy` 收到的 `delay > 0`（`settings.clipboardClearDelay * 1000`），且 `auditLog` 被调用（label 含「密码」）。
9. 三条关闭路径：`Escape` / 点 `.drawer-mask` / 点「关闭」→ 各调用一次 `onClose`（`onOpenDetail` 的触发元素不被重新打开）。
10. 焦点归还：先 `card.focus()` 再开抽屉，`fireEvent.keyDown(document,{key:'Escape'})` 后 `document.activeElement === card`；`trigger` 兜底路径：`document.activeElement` 为 `body` 时聚焦 `trigger`。
11. 无 `totpSecret`：抽屉里**不出现** TOTP 行（不是空占位）；有则显示 6 位码 + 剩余秒数（`1..30`），假计时器推进 1s 后秒数减 1（`vi.useFakeTimers()` + `vi.setSystemTime`）。
12. 底部「编辑」→ `onEdit(entry)`；「删除」→ `onDelete(entry)`（抽屉**不自己删**，确认弹窗由 Dashboard 负责）；**不传** `onEdit/onDelete` 时两个按钮都不渲染（B 片用法）。

**步法**：用例 1–5 先红（卡片现在点主体=选中）→ 改 `EntryCard` → 绿；6–12 先红（组件不存在）→ 写 `EntryDetailDrawer` → 绿；最后在 `Dashboard` 接线并补一条「Dashboard 里点卡片后抽屉出现、勾选框仍可多选」的冒烟用例。

### 7.4 B 片：成员账号 tab

**文件与改动点**

- `src/components/MemberAccountsTab.tsx`（新）—— 数据 + 表格 + 新增/编辑弹窗，**纯函数一律 export**（照 `SqlSnippets.tsx` 的 `countSql`/`filterSql` 范式，测试只测这些 + 渲染）。
- `src/pages/PasswordManagerPage.tsx`：两处改动——①按 §7.1-1 加 tab（`SubPage` 联合 + `subNavItems` + `renderSubPage`），并 **export `subNavItems`**（测试断言顺序用）；②**成员账号 tab 的抽屉实例挂在这里**：`const [detail, setDetail] = useState<{ entry: PasswordEntry; trigger: HTMLElement | null } | null>(null)`，`case 'members'` 渲染 `<MemberAccountsTab entries={store.entries} onOpenDetail={(entry, trigger) => setDetail({ entry, trigger })} />`，页面末尾渲染 `<EntryDetailDrawer open={!!detail} entry={detail?.entry ?? null} trigger={detail?.trigger ?? null} onClose={() => setDetail(null)} />`（只有这两个回调，见下条）。
  - 为什么不在 store 里加 `detailEntryId`：详情抽屉是页面级 UI 状态，加进 store 会让「切 tab 是否保留抽屉」变成全局行为，还要处理锁库清理；两个 tab 不会同时挂载，各自的抽屉实例即可。
  - `Dashboard`（A 片）**保持自己持有 `detail` 并渲染抽屉**，不需要为 B 改造：`PasswordManagerPage` 只负责 `members` 分支那一个实例。
  - `onEdit` / `onDelete` / `onCopy` / `onOpen` 在 `PasswordManagerPage` 里没有现成实现 → **B 片只接 `onOpenDetail` 与 `onClose`，抽屉的编辑/删除/复制在 `members` 分支下不传**（`EntryDetailDrawer` 把这四个回调设为可选，未传就不渲染对应按钮）。这样 B 不必把 `Dashboard` 的 toast/复制/删除逻辑再抄一遍；「从成员账号打开详情后要编辑」的用户路径仍是：网址列已在 A 片抽屉里可编辑（点卡片进），本次不扩大到 cross-tab 编辑。
- `src/pages/Dashboard.tsx`：B 片对它**零改动**（只有 A 片的改动）。
- `src/styles/redesign.css` 末尾：成员账号表的玻璃（`.mem-acc-*` 只加 `html[data-bg='image']` 作用域，走既有 `--glass-side` / `--glass-inset` / `--glass-control`，**不加 `backdrop-filter`/`z-index`/`!important`**，也不新增色值字面量——`check-debt-budget` 的预算只许下降）。

**组件契约（props）**

| 组件 | props |
|---|---|
| `MemberAccountsTab` | `entries: PasswordEntry[]; onOpenDetail: (entry: PasswordEntry, trigger: HTMLElement \| null) => void` —— toast 自持（`useToast()` + `<ToastContainer>`，照 `OrphanAccounts.tsx:29/107` 的现成做法，不新增页面级容器） |
| `PasswordManagerPage` | 无 props；内部 `detail` 状态 + 渲染 `<EntryDetailDrawer>`（只传 `open/entry/trigger/onClose`） |

**纯函数（从 `MemberAccountsTab.tsx` export，测试直接调）**

- `flattenMemberAccounts(entries: PasswordEntry[]): MemberAccountRow[]`，`MemberAccountRow = EntryAccount & { entryId: string; entryName: string; envType: string }`（§3.2 口径，字段名不改 `EntryAccount`）。
- `filterMemberAccounts(rows, { entryId?: string; q?: string }): MemberAccountRow[]`——`q` 命中 `username / role / entryName`（大小写不敏感，`trim` 后为空 = 不过滤）。
- `sortMemberAccounts(rows): MemberAccountRow[]`——按 `entryName.localeCompare(x,'zh')` 再 `role.localeCompare(x,'zh')`，**纯函数不就地改入参**。
- `upsertAccount(entry: PasswordEntry, account: EntryAccount): PasswordEntry`——同 id 替换、新 id 追加，返回新对象（不改入参）。
- `removeAccount(entry: PasswordEntry, accountId: string): PasswordEntry`。
- `emptyAccount(role = '', username = '', password = '', note = ''): EntryAccount`——id 用 `newId('acc-')`（`utils/id.ts`）。

**状态归属**

| 状态 | 归属 |
|---|---|
| 聚合数据 | **派生**（`useMemo(() => flattenMemberAccounts(entries), [entries])`），不存副本 —— 保证 tab 与卡片弹窗天然同源 |
| 筛选/关键字/排序 | `MemberAccountsTab` 本地 `useState`（页面级 UI 状态） |
| 新增/编辑弹窗的草稿 | 弹窗内 `useState`，保存成功后关闭；**保存失败不关**（保留用户输入） |
| 待删除账号 | `useConfirm().ask()`（`components/confirm.tsx`），不在组件里手写 `window.confirm` |
| 落盘 | `callIpc(() => window.electronAPI.entriesUpdate(nextEntry))` → `res.ok` 后才 `useStore.getState().setVaultData(res.data)`；`res.ok === false` → `addToast(\`保存失败：${res.error}\`, 'error')` 并 **return，不动界面** |

**交互硬判据**

1. 表格列：网址（`button`，点它调 `onOpenDetail(entry, null)`）/ 环境徽标 / 角色 / 账号 / 密码（打码 + 显示/复制）/ 备注 / 操作（编辑、删除）。
2. 密码「复制」走 `copySensitive`（label 用 `\`${role}-密码\``），「显示」默认关闭且删行/换筛选后复位。
3. 「所属网址」必填：未选时保存按钮 `disabled`，并给 `input-hint` 提示。
4. 空态文案逐字：`还没有成员账号。在任意网址的详情抽屉或卡片里的账号弹窗新增，会出现在这里`。
5. 玻璃：新类只有三个——`.mem-acc-bar`（工具条）/ `.mem-acc-filters`（筛选行）/ `.mem-acc-actions`（操作列按钮组）；表格复用既有 `.tbl`，密码按钮复用 `.btn.btn-ghost.btn-sm`。`html[data-bg='image']` 段只给这三个新类 + `.mem-acc` 容器补 `--glass-*`（工具条 `--glass-side`、行内小块 `--glass-inset`、按钮 `--glass-control`）；**表头必须是 `.tbl th`**（`redesign.css:8232` 已给它补 `--text-2`）。

**单测清单 `src/utils/__tests__/memberAccounts.test.tsx`（新）**

纯函数：
1. `flattenMemberAccounts`：3 个条目（1 个无 `accounts`、1 个 `accounts: []`、1 个 2 条账号）→ 2 行；每行带 `entryId/entryName/envType`；**不改入参**（快照比对）。
2. `filterMemberAccounts`：按 `entryId` 只剩该网址；`q` 分别命中账号、角色、网址名；`q: '  '` 等同不过滤。
3. `sortMemberAccounts`：网址名中文序 → 同网址内角色中文序；空角色排在最前但不丢行；入参顺序不被就地改。
4. `upsertAccount`：新 id 追加到尾部、同 id 原位替换（不动其它账号、不改入参）；`removeAccount` 只删匹配 id。

渲染 + 落盘（`render(<MemberAccountsTab .../>)`，`electronAPI` 打桩）：
5. 列出所有条目的账号：行数 = 聚合数；空库时出现**逐字**空态文案。
6. 按网址筛选：`select` 选某网址 → 只剩它的行；选「全部」恢复。
7. 关键字：输入角色名只剩 1 行；输入不存在的词 → 空结果态（不是空态文案）。
8. 默认排序断言（用 `sortMemberAccounts` 的期望值比 DOM 行序）。
9. 新增：不选网址时保存 `disabled`；选网址 + 填角色/账号/密码 → `entriesUpdate` 收到该 entry 且 `accounts.length+1`、新账号 `id` 以 `acc-` 开头、`role/username/password/note` 与输入一致；成功后 `setVaultData` 被调用、表格多一行、弹窗关闭。
10. 编辑：改 `role/username/password` → 同 id 原位替换，其它账号的字段逐一不变；成功后界面同步。
11. 删除：点删除 → 出现确认弹窗（`role="dialog"`，标题含「删除」）；点「取消」→ `entriesUpdate` **0 次调用**；点确认 → 该账号消失、`accounts` 长度 -1。
12. **保存失败回滚**：`entriesUpdate` 返回 `{ success:false, error:'磁盘满' }` → `setVaultData` **未被调用**、表格行数与字段与操作前逐项相等、出现含「保存失败」的 `error` toast（`.toast` 文本断言），弹窗**不关**且输入还在。
13. **双向可见**：新增账号后渲染 `EntryCard`（同一 store 数据）→ 卡片「+N」计数 +1、点开 `AccountsModal` 里能查到该账号；反向：`entries` 里已带 `accounts` → tab 里出现同一 id 的行（同一份数据，不做二次映射）。
14. tab 顺序：渲染 `PasswordManagerPage`（或直接断言 `subNavItems.map(i => i.label)`）=== `['所有网址','成员账号','回收站','导入数据','导出数据']`；且 `pmSubPage === 'members'` 时不渲染 `.tag-sidebar`。
15. 网址列点开抽屉：点「网址」按钮 → `onOpenDetail` 收到该 `entry`（`trigger` 为 `null`）。

**步法**：1–4 纯函数先红 → 写纯函数 → 绿；5–15 先红 → 写组件 + `PasswordManagerPage` 接线 → 绿；最后 `npx vitest run src/utils/__tests__/memberAccounts.test.tsx`。

### 7.5 C 片：SQL 三卡移到页顶 + 附件目录条

**改动点**

- `src/pages/SqlSnippets.tsx:691-696`：把 `.home-stats.is-3` 整块从 `.pm-main` 里**移出**，放到 `<PageHead>` 之后、`{dirBar}` 之前，并加类 `sql-kpi-top`（三张 `.home-stat` 与文案一字不改，`countSql` 口径不动）。
- `src/pages/Attachments.tsx:385`（全局）与 `:404`（笔记）：删 `<code className="att-dir-path">`；路径写进「打开目录」按钮的 `title`（`\`打开目录：${dir}\``）；「复制路径」按钮保留（§7.1-4）。
- `src/styles/redesign.css` 末尾（新段落，带原因注释）：
  - `.sql-kpi-top { margin-bottom: 10px; }` 与 `.sql-kpi-top .home-stats.is-3 { grid-template-columns: repeat(3, minmax(0,1fr)); }`（< 1100px 仍一行三列，不换行 → 容器 `min-width:0` + 子项 `min-width:0`）。
  - 压缩：`.sql-kpi-top .home-stat { padding: 4px 8px; }`、`.sql-kpi-top .home-stat b { font-size: 16px; line-height: 1.1; }`、`.sql-kpi-top .home-stat i { font-size: 11px; }`（目标卡高 ≤ 64px，改前 ≈ 54px 由 qa 量）。
  - **补回被移出 `.pm-shell` 打断的卡面**：`html:not([data-bg='image']) .sql-kpi-top .home-stat { background: var(--surface-2); border: 1px solid var(--line); }` 与 `html[data-bg='image'] .sql-kpi-top .home-stat { background: var(--glass-inset); }`（见 §7.1 第 1 条）。
  - 不用 `!important`、不写色值字面量（`check-debt-budget` 预算只许下降）。

**组件 props / 状态归属**：两页都**零新增 props、零新增状态**（纯位置与样式改动）。

**单测清单（追加进 `src/utils/__tests__/sqlSnippets.test.tsx`）**

1. DOM 位置：`[.pg]` 的 `children` 里 `.pg-head` 的 index < `.home-stats` 的 index < `.pm-shell` 的 index（用 `compareDocumentPosition` 或 children 索引）。
2. 三卡仍在且计数不变：`.home-stats.is-3 > .home-stat` 长度 3，文本含「全部片段/收藏/本周新增」，计数与 `countSql` 一致（沿用既有 KPI 断言）。
3. 三卡不再出现在 `.pm-shell` 内：`container.querySelector('.pm-shell .home-stat') === null`（防止「复制一份留在原处」）。
4. 宽度约束只能断类名：`.home-stats.is-3` 仍在（`grid-template-columns: repeat(3 …)` 由 CSS 保证；**jsdom 无布局，卡高 ≤ 64px / 字号 16 的几何断言归 qa 的浏览器脚本，属 D 片，不在这里假绿**）。
5. 既有「KPI 三卡口径」用例保持全绿（改前先跑一遍基线）。

**附件（`src/utils/__tests__/attachmentsDirBar.test.tsx`，新，待裁定是否扩 §4-C）**

目录来源已核：`dir` / `notesDir` 都来自 `attachment:list` 的返回（`Attachments.tsx:70-71`），所以打桩 `attachmentList` 就能造出两条目录条，不用碰 `localStorage`。

6. 两个目录都在：`attachmentList` 返回 `{ success:true, dir:'D:\\att', notesDir:'D:\\notes\\attachments', dirExists:true, data:[] }` → `container.querySelectorAll('.att-dir-bar')` 长度 2，`container.querySelector('.att-dir-path') === null`（两条都不再有路径文本节点），且 `container.textContent` **不包含** `D:\att` / `D:\notes\attachments`。
7. 按钮仍在且各自触发原 IPC：全局条「打开目录」→ `attachmentReveal` 被调用；「更改目录」→ `attachmentPickDir`（取消返回 `{success:false}` 即止，不再调 `attachmentSetDir`）；笔记条「打开目录」→ `attachmentEnsureNoteDir` + `notesReveal`；两处「打开目录」的 `title` 都含完整路径。
8. 未配置目录时保持现状：`dir`/`notesDir` 为空 → 目录条整块不渲染（`.att-dir-bar` 长度 0），不出现空按钮。

### 7.6 三片共用的硬约束自检（交付前逐条自查）

| 约束 | 自查方式 |
|---|---|
| 密码展示/复制只走 `copySensitive`（或 `handleCopy` 且 label 含「密码」） | `grep -n "clipboard.writeText\|copyPlain" src/components/MemberAccountsTab.tsx src/components/EntryDetailDrawer.tsx` 必须无密码路径 |
| 批量选择只能由勾选框 / 批量条 / 全选改 `selectedIds` | `grep -n "toggleSelected\|selectAll\|clearSelected" src/components/EntryCard.tsx src/components/EntryDetailDrawer.tsx`：只允许勾选框那一处 |
| 不改 vault 结构 | `git diff --stat src/types.ts electron/` 必须为空 |
| 样式只在 `html[data-bg='image']` 补玻璃，不加 `backdrop-filter`/`z-index` | `npm run check`（内含 `check-stacking`、`check-z-index`、`css-cascade-audit`） |
| `Dashboard.tsx` 不再堆逻辑 | `git diff src/pages/Dashboard.tsx` 只允许 A 片这几处：`detail` 状态、两处 `onOpenDetail`、`EntryDetailDrawer` 渲染、`onEdit/onDelete` 接线、一个 import；新增逻辑全部落在 `EntryDetailDrawer.tsx` / `MemberAccountsTab.tsx` |
| 既有回归不红 | `scripts/ui-round17-test.js:229` 依赖「点卡片记最近使用」→ `recordEntryUse` 必须留在卡片主体点击里（已写进 §7.3） |

### 7.7 全片验证命令（frontend 交付前逐条贴原始输出）

```bash
npx tsc --noEmit
npx vitest run src/utils/__tests__/entryDetail.test.tsx src/utils/__tests__/memberAccounts.test.tsx src/utils/__tests__/sqlSnippets.test.tsx
npx vitest run                 # 全套，确认没打断既有 45+ 个测试文件
npm run check                  # privacy + tsc + vitest + ipc + css-dup + z-index + stacking + cascade + debt
git diff --stat                # 对照 §7.2 文件边界
```

`node scripts/ui-glass-opaque-scan.js`（含成员账号 tab、0 违规）属 **D 片（qa）**，frontend 只保证「不为通过扫描而扩白名单」。

### 7.8 交付顺序

1. **A**（抽屉 + 勾选框）→ 跑 A 片用例 + `npx tsc --noEmit`。
2. **B**（依赖 A 的抽屉组件）→ 跑 B 片用例；确认 `PasswordManagerPage.tsx` 的 diff 只有「tab 三处 + `members` 分支抽屉实例」两块，`Dashboard.tsx` 零改动。
3. **C**（与 A/B 路径不重叠，可并行）→ 跑 C 片用例；确认普通模式卡面靠新选择器（不是靠 `.pm-shell`）。
4. 三片合并后跑 §7.7 全量，把原始输出贴给 qa，D 片才开。
