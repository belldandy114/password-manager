# visual-system（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

### 视觉体系 v2（2026-10-28，pages.css 第 19 节）

所有工作台页面共用一套 token 与组件样式，**新增页面请直接用 `components/ui.tsx` + 这些类名**，不要再手写样式：

| 层级 | 元素 | 说明 |
|---|---|---|
| 页面 | `.content-area > .pg` | 最大宽 1440 居中，padding 26/32，子块间距 22 |
| 头部 | `PageHead` | 23px 标题 + 32px 渐变图标块 + 12.5px 灰描述 |
| 卡片 | `Panel` | 16px 圆角、1px 淡边、双层阴影；`collapsible` 可折叠（配置类面板默认折叠） |
| 表格 | `.tbl` | 表头 11px 粘性 + 毛玻璃，行 11/16 padding，hover 淡紫 |
| 标签页 | `.tabs > .tab2` | **下划线式**（不是胶囊），激活为 2px 强调条 |
| 按钮 | `.btn-primary/.btn-secondary` | 9px 圆角，主按钮渐变+内阴影 |
| 表单 | 全局 input/textarea/select | 34px 高、9px 圆角、focus 3px 光环 |

- **新增网址弹窗的小按钮统一走 `.entry-mini-btn` 系列**（`global.css` 尾部）：
  `+ 添加字段 / + 添加附件 / 打开 / 生成 / 查看 / 回滚 / 复制验证码` 用同一套 accent 淡底 + 7px 圆角；
  `保密` 是 `.gen-check.entry-field-secret`（带 `Icons.lock`，选中加 `.is-on` 高亮），
  行内删除是 `.entry-row-del`（带边框方块、hover 变红）。别再退回灰色胶囊 `.gen-check` 或裸 `×` 文本按钮。
  视觉回归：`node scripts/shot-entry-buttons.js [dark|light]`。

- 「网址管理」页也接入了这套骨架（`PasswordManagerPage` 用 `Page/PageHead/tabs` + `.pm-shell/.pm-main`），
  这样左侧栏与工作台页面观感统一；改动该页时注意 `.pm-main > .content-area` 是它自己的滚动容器。
- 禅道统计卡用 `repeat(auto-fit, minmax(92px, 1fr))`，保证「全部 + 5 状态 + 4 严重度」10 张卡一行放得下。
- 视觉走查脚本：`node scripts/shots.js <输出目录> [dark|light]`（CDP 截图 7 个页面，1440×900）。

### 开发辅助四页（W8 · 1.34.0）新增公共类：类名与 token 真源登记

> 为什么登记在这里：`AGENTS.md` 把「哪个类用哪个 token」的真源定为本文档。W8 为「不复用
> `.tdg-type`」争过一轮（`docs/acceptance/W8-视觉口径.md` §3.2），不登记就是下次重造。
> 两条判定口径（写死，别再争）：
> ① **透明类不进 `html[data-bg='image']` 玻璃登记表** —— 登记表唯一职责是「把实底换成玻璃底」，
>    给透明类登记反而引入 40–52% 底色、推翻已验收的对比度（`docs/视觉-开发辅助.md` §10.2）。
> ② **刻意实底的类走 `scripts/ui-glass-opaque-scan.js` 的 `WHITELIST` 并写 `why`**，不进登记表。
>
> 前置：`.dev-tag`（5 变体 `.is-ok/.is-fail/.is-heur/.is-unknown/.is-unverified`）与
> `.dev-banner`（`.is-error/.is-warn/.is-info`）是 W7（1.33.0）落地的，token 落点见
> `redesign.css:8801-8918`，同样**不进**玻璃登记表（背景 `transparent`）。

| 类名 | 用途 | token 落点（`redesign.css`） | 玻璃登记 / 实底判定 |
|---|---|---|---|
| `.dev-scroll` | 大表滚动容器：`overflow:auto; max-height:56vh; min-height:0` | 无背景 | 不进：无底可换 |
| `.dev-scroll.is-short` | 次要表矮档 `max-height:300px`（历史记录 / 环境信息） | 无背景 | 不进 |
| `.dev-scroll > table.tbl` | 收编 15 处内联 `tableLayout:'fixed'`（`table-layout:fixed`） | — | 不进（无背景） |
| `.dev-scroll > .dev-code` | 代码块滚动权归外层：`max-height:none`（消内外双滚动条） | — | 不进 |
| `.dev-scroll > .tbl td > input:not([type='checkbox']):not([type='radio'])`、`… > select` | 表格内控件撑满单元格、消「相邻输入框重叠」 | `width:100%; min-width:0` | 不进；**勾选框/单选框刻意排除**（UA 画固定方块，撑满会变成整列方块） |
| `.dev-code` + `html[data-bg='image'] .dev-code` | 生成代码区容器；用法 `<pre class="tb-pre dev-code">` | 背景 `--surface-inset`、正文 `--text-1` | **刻意实底 → 白名单**：`WHITELIST`「代码区 (.dev-code)」；why = 高亮 4 个语义色需稳定底过 4.5:1，压 `--glass-input-soft` 浅色合成底只有 3.25–3.91（视觉口径 §2.3） |
| `.dev-code-line` | 代码行 + 行号槽的对齐容器 | `display:grid; grid-template-columns:4ch 1fr; gap:8px` | 不进：无背景。列宽必须 `4ch`（`auto` 会让 1/2/3 位行号把代码列左缘推成三档） |
| `.dev-code-ln` | 行号槽（装饰位，非正文） | `--text-3` + `--fs-2xs` + `tabular-nums` + 右对齐 | 不进 |
| `.dev-code .tok-kw` / `.tok-ann` | 关键字 / 注解（`@Test`） | `--info` + 600 | 不进（前景色，无底） |
| `.dev-code .tok-type` | 类型（`String`/`By`） | `--ok` | 不进 |
| `.dev-code .tok-str` / `.tok-num` | 字符串 / 数字 | `--bad`（数字加 `tabular-nums`） | 不进；**块内 `--bad` 不表示错误**（错误只走 `.dev-banner`/`.dev-tag`） |
| `.dev-code .tok-cmt` | 注释 | `--text-2` + italic | 不进；**禁用 `--text-3`**（弱化文字，与「正文 ≥4.5」口径混淆） |
| `.dev-code .tok-fn` | 方法调用 | `--text-1` + 600 | 不进 |
| `.dev-list` | 左侧普通列表容器 | 透明；`max-height:56vh; overflow:auto` | 不进：无底 |
| `.dev-list-item` / `.dev-list-item.is-on` | 列表行 / 选中行 | hover `color-mix(--accent 6%, transparent)` + `--line`；选中 `--accent-soft` + `--accent-line` | 不进：两态 alpha 都 <1。选中态文字**不用 `--accent`**（`data-accent='image'` 取色时不可控，同 1.33.1 的 `.tab2.is-active` 教训） |
| `.dev-list-name` / `.is-on .dev-list-name` | 行名称（单行省略） | `--text-2` → 选中 `--text-1` + 600 | 不进 |
| `.dev-list-count` | 右侧计数：纯文本、不做胶囊底 | `--text-2` + `--fs-2xs` + `tabular-nums` | 不进 |
| `.dev-list-del` | 行删除按钮（复用 `.btn.btn-ghost.btn-sm`） | `opacity:0` → `:hover` / `.is-on` / **`:focus-visible`** 三态显形 | 不进（`.btn-ghost` 本身透明底） |

补充两条：
- `.dev-*` 前缀 = 「开发辅助四页专用」；新页面复用时**按本表取 token，不要改类名**（回归脚本与扫描锚点都认名字）。
- `.tabs` / `.tab2` 自 1.34.0 起透明化为下划线式，**不再作为玻璃锚点**；锚点迁移与不变量见
  `docs/agents/glass-scan-tab-plan.md` §11。

