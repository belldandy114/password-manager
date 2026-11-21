# 契约：SQL 片段独立页（1.30.2）

> 2026-11-21。用户确认：独立页照截图做全 / 字段一次做全 / 复用 notes 集合给 sql 条目扩字段。
> 本文是实现契约，`frontend` 按此实现，`ui` 按类名清单补样式，`qa` 按验收条目验。

## 1. 数据模型（唯一变更点）

`Note` 增加 4 个**可选**字段（`src/types.ts`），只对 `kind === 'sql'` 的条目有意义，
其余 kind 不读不写。老数据没有这些字段 → 一律当空，**不需要迁移脚本、不需要动 vault 版本号**。

```ts
export interface Note {
  id: string;
  title: string;
  content: string;          // SQL 片段时 = SQL 正文
  tags: string[];
  updatedAt: string;
  kind?: 'note' | 'sql' | 'weekly';
  links?: NoteLink[];

  /* ---- 1.30.2：SQL 片段专用（其余 kind 不读不写，缺省 = 空） ---- */
  dbOrEnv?: string;         // 库 / 环境，如 test_order、预发
  varHint?: string;         // 变量说明，如 {{orderNo}} = 订单号；{{today}} = 今天
  remark?: string;          // 备注
  starred?: boolean;        // 收藏
}
```

**不改**：`kind` 枚举、`fileOf()` 的 `.sql.md` 命名约定、`utils/noteKind.ts` 的目录判定规则、
旧 `snippets` 集合（保留不删，只不再作为数据源）。

## 2. 页面结构（`src/pages/SqlSnippets.tsx`，新文件）

```
Page（页头：SQL 片段 · N 条 / 导入备份 | 导出 | 刷新 | + 新增）
├─ 左栏 .tag-sidebar 形态
│   ├─ 「全部」+ 计数
│   ├─ 「收藏」+ 计数
│   └─ 标签列表（来自所有 sql 条目的 tags 并集，点选筛选，可「全部标签」）
├─ 右区
│   ├─ KPI 三卡：全部 / 收藏 / 本周新增
│   ├─ 工具行：搜索框（标题、内容、标签）+ 结果计数「x / N 条」+ 排序下拉
│   ├─ 表格（.tbl）：名称 | 库/环境 | 更新时间
│   └─ 空态（无数据 / 筛选无结果 两种文案）
└─ 弹窗（新增/编辑）
    ├─ 名称 *（必填，空则不允许保存）
    ├─ 库/环境
    ├─ SQL *（等宽 textarea，必填）
    ├─ 变量说明
    ├─ 备注
    ├─ 标签（复用现有标签输入交互）
    └─ 收藏（开关）+ 取消 / 保存
```

## 3. 口径（必须写死，避免实现时自由发挥）

| 项 | 口径 |
|---|---|
| 数据源 | `notes` 集合里 `kind === 'sql'` 的条目（本地库模式）；目录模式仍走文件（见 §5） |
| 「全部」计数 | 当前筛选（标签）前的 sql 条目总数 |
| 「收藏」计数 | `starred === true` 的 sql 条目数 |
| 「本周新增」 | `updatedAt >= 本周一 00:00` 的 sql 条目数（本地时区，周一为一周起点） |
| 搜索范围 | `title` + `content` + `tags.join(' ')`，不区分大小写 |
| 排序 | 默认「最近修改」按 `updatedAt` 降序；另一项「名称」按 `title` 升序（中文按 `localeCompare('zh')`） |
| 表格列 | 名称 / 库·环境 / 更新时间（更新时间用现有格式化工具，与笔记页一致） |
| 行操作 | 点击行 = 打开编辑弹窗；行内「复制」按钮复制 `content` 原文（不替换变量），并在 toast 里说明「变量未替换」 |
| 变量 | 只做**展示**（变量说明字段）与「复制原文」；本期**不做**变量替换引擎（截图里的「变量替换后复制」先不做，写进后续建议） |
| 保存 | 写回 `notes` 集合（`ws:set('notes', ...)`），`updatedAt` 取当前时间；新建时 `kind='sql'`、`id` 用现有 id 生成工具 |
| 与笔记页关系 | 笔记页（`Notes.tsx`）**过滤掉 `kind === 'sql'`**，避免同一片段两个入口；已有 `weekly` 过滤照旧 |

## 4. 入口与路由

- 侧栏 `GROUPS` 的「测试工作」组里，**「笔记与附件」之前**插入 `{ id: 'sqlSnippets', label: 'SQL 片段', icon: <Icons.code /> }`。
- `src/App.tsx` 增加 `case 'sqlSnippets'`，懒加载 `SqlSnippets`（照现有 `React.lazy` 写法）。
- 命令面板（`CommandPalette.tsx`）的页面清单加一条「SQL 片段」，否则搜不到。

## 5. 目录模式（重要，别漏）

笔记页有「目录模式」（一篇一个 .md 文件，路径可切换）。SQL 片段独立页**首期只支持本地库模式**：

- 本地库模式（`dirMode === false`）：按 §3 读写 `notes` 集合。
- 目录模式：页面顶部显示一条提示「目录模式下 SQL 片段按 `标题.sql.md` 文件存放，请到「笔记与附件」里管理」，**不渲染表格**，避免读写两套数据源。
- 判据：硬编码 `dirMode` 从 `localStorage` 的笔记目录设置读（沿用 `Notes.tsx` 现有键），不新增设置项。

## 6. 样式与类名（ui 只补这些，不重做布局）

复用：`.tag-sidebar` / `.tag-item` / `.tbl` / `.page-head` / `.pill` / `.home-stat`（或现有 KPI 卡类）/ `.modal` / `.field` / `.btn-*` / `.empty`。

新增（若现有类名不够）：`.sql-kpi`（三卡容器）、`.sql-table`（列宽）、`.sql-detail`（弹窗内两列布局）。
新增样式一律写在 `redesign.css` 末尾并注明原因；**禁止**给容器加 `backdrop-filter`（`check-stacking.js` 会拦）。

## 7. 验收条目（逐条可判真假）

1. 侧栏出现「SQL 片段」，点进去是独立页（不是笔记页的筛选）。
2. 新建：名称/SQL 必填，空时保存按钮不可用或有校验提示；保存后列表出现该条，`notes` 里 `kind='sql'` 且新字段落盘。
3. 编辑：点行打开弹窗，回填 5 个字段（名称/库环境/SQL/变量说明/备注/标签/收藏）。
4. 收藏：切到「收藏」标签，只剩 `starred===true` 的条目；KPI「收藏」计数一致。
5. 搜索：搜标题、搜 SQL 正文片段、搜标签，三种都能命中；无结果时给「没有匹配」文案而不是空白。
6. 排序：切「名称」后按 `localeCompare('zh')` 升序，切回「最近修改」恢复降序。
7. 表更新：编辑后 `updatedAt` 变化且列表重排到最前。
8. 笔记页：`kind='sql'` 条目不再出现在「笔记」列表；`weekly` 仍被过滤。
9. 目录模式：切到目录模式再进 SQL 片段页，显示提示且**不渲染表格**（不读写笔记目录）。
10. 旧数据：库里已有的 sql 条目（无新字段）能正常列出、能编辑保存，保存后新字段写入但旧字段不丢。
11. 未改 `utils/noteKind.ts`、未删旧 `snippets` 集合、未改 `fileOf()` 命名。
12. `npm run typecheck` / `build:renderer` / `test:unit` 全绿。

## 8. 后续建议（不进本期）

- 变量替换引擎（`{{var}}` 实际替换后复制）。
- 目录模式的 SQL 片段读写（现在只提示去笔记页管理）。
- 导入备份 / 导出（页头那两个按钮先只接现有导出通道里 sql 条目的子集，若通道不支持就隐藏按钮，**不要显示假按钮**）。
