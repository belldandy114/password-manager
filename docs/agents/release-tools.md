# 发布与排障基础设施（1.9.0 起）

从 AGENTS.md 迁出的完整说明：release / check / regress / ipc 门禁、日志落盘、导入预览等。

## 1.9.0 起：发布与排障基础设施（改代码前先看）

这一批不是功能，而是**减少返工**的东西——都来自 1.7.4~1.7.8 这五个版本里实际踩的坑。

### 三个新命令

| 命令 | 作用 | 什么时候用 |
|---|---|---|
| `npm run release -- 1.9.0` | 一键发布：升版本 → 构建（含 ci-gate）→ 打包版全量回归 → 英文资产名 → 提交推送 → 建 Release → 等 CI → 核对附件与 latest（兼容旧 CI 的覆盖） | 正式发版 |
| `npm run check` | 静态门禁：隐私 / 类型 / 单测 / IPC 契约 / CSS 报告（与 CI 共用 `ci-gate.js`） | 随时可跑 |
| `npm run regress -- --pack` | 在静态门禁之上再跑 7 项打包版回归（需先 `npm run dist`） | 本地验收 |
| `npm run clean:release` | 列出 release/ 里可清理的历史 exe（dry-run；加 `-- --apply` 才删） | 磁盘卫生 |
| `npm run install:local` | 把 `release/` 下最新安装包**静默覆盖安装**到当前目录 | 只是想让自己机器用上新版本（**不需要发版**） |
| `npm run check:ipc` | IPC 契约检查：main 注册 ↔ preload 暴露 ↔ types 声明 三方对齐 | 改了任何 IPC 后 |

- `release` 脚本要求 `release-notes-<version>.md` 已存在且不少于 50 字符——**发布说明必须人写**，脚本不编。
- `release --dry-run` 只打印计划，不动工作区。
- 加了新 IPC 忘了在 preload/types 里接线时，`check:ipc` 会直接报 error（`types 声明了但 preload 没暴露` 这类）。

**为什么加 `install:local`**：1.7.7 那次「还是一样」，根因是修复只在源码里、没进安装包。
以后改完想自己验，跑 `npm run dist && npm run install:local`（约 2 分钟），不必等发版。

### 主进程日志落盘（`electron/app-log.js`）

- 位置：`<数据目录>/logs/app.log`；超过 2MB 滚一份 `app.log.1`。
- 接管了 `console.log/warn/error`，并记录 `uncaughtException` / `unhandledRejection`。
- 设置页「关于 → 运行日志 → 打开日志目录」；IPC：`log:info` / `log:open` / `log:tail`。
- ⚠️ `require('./app-log')` **必须在第一次调用 `installFileLogging()` 之前**。
  放到后面会因 const 的 TDZ 让应用启动即崩（已踩过，表现为「双击没反应」）。

### cURL 导入改成「先预览再填入」

- 解析后先显示：方法、地址、请求头条数、请求体类型与字段数、警告列表、正文预览（600 字符）。
- 确认后才写进编辑器；「返回修改」可以继续编辑原始命令。
- 回归脚本里对应两个 helper：`openCurlImport()`（等输入框就绪）与 `confirmCurlImport()`（等预览出现再点确认）。
  **不要用固定 `sleep`**——渲染是异步的，抢跑会点到上一次的预览（已踩过）。

### 从响应提取字段 → 变量（`electron/json-paths.js`）

- 响应是 JSON 时，工具栏出现「提取字段」：列出叶子路径（`data.token`），点一下 → 起变量名 → 写入变量表。
- 只取叶子（string/number/boolean/null）；数组最多展开 5 个元素；总条数默认上限 300。
- 长字符串只在**展示层**截断，存进变量的是完整值。

### JMeter：覆盖能力预检（`jmeter:inspect-script`）

- 选中 `.jmx` 时读文件，判断有没有 `${__P(threads,…)}` / `${__P(loops,…)}`。
- 没有就把对应输入框禁用并说明原因；真跑了也会在日志里打 `[警告] …覆盖不会生效`。
- **别再假设 -J 一定生效**：脚本里线程组写死时，`-Jthreads=N` 是静默无效的。

### JMeter：运行历史（`electron/jmeter-history.js`）

- 存 `<数据目录>/jmeter-history.json`，最近 50 条（**不加密，但只存路径与统计**）。
- 记录：时间、脚本名、模式、线程/循环、样本、错误率、TPS、平均/最大、jtl/报告/日志路径。
- 页面「运行历史」面板可一键打开产物、清空。

### 测试账号：批量导入 + 密码新鲜度（`electron/accounts-import.js`）

- 批量导入：每行 `系统 | 角色 | 账号 | 密码 | 备注`，也支持从 Excel 复制的 Tab 分隔；`#` 开头是注释。
- 格式不对的行会跳过并在弹窗里标出行号（不会静默丢数据）。
- 密码超过 90 天未变更，列表里显示「已 N 天未改密码」（`passwordUpdatedAt` 只在密码真的变了时更新）。

### IPC 域拆分进度（D2，2026-11-10 全部完成）

`main.js` 4652 → **1622 行，`ipcMain.handle` 计数 0**，全部 handler 已按域搬进 17 个 `electron/ipc-*.js`。
模块清单、搬迁铁律（对象注入 / getter / 扫漏 require / 注册顺序）与别名坑见 `docs/agents/ipc-split.md`。


