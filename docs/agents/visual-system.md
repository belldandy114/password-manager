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

