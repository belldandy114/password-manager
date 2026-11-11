# ipc-split（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

> **现状（2026-11-10）：已全部拆完。** `main.js` 4652 → 1625 行，`ipcMain.handle` 计数为 0，
> handler 分布在 17 个 `electron/ipc-*.js`。下面的「当前状态」「后续候选」是 2026-10-29 的中间态记录，
> 保留它是因为里面的踩坑与判定标准仍然有效；不要把它当成还有活没干。
> 最新清单见 AGENTS.md 的「IPC 域拆分进度（D2）」。

## 拆分 `setupIpcHandlers`（2026-10-29 起，2026-11-10 完成）

`setupIpcHandlers()` 原本近 3000 行、98 个 handler 全在里面。拆分**不要一次性大改**，
按「两步走」推进，每步都要跑回归：

### 第一步（已完成）：先摸清边界，别急着挪

- 域之间通常有 `const xxxResolve = ...` 这类**仅本域使用**的辅助函数，它们夹在 handler 之间。
  挪动前必须确认：这段区间里声明的 const/let，没有被区间外的代码引用。
- 用脚本机械化处理时，**边界判定要按「下一个域的起始注释」倒推**，不要用
  `^\s*\}\);$` 去找「第一个 `});`」——那是 handler 内部的 try/catch 收尾，
  会导致函数被提前闭合，后面的 handler 引用不到辅助函数（**已踩过**：`weekly:read` 等会在运行时报
  `weeklyResolve is not defined`，而 `node --check` 完全不会报错）。
- 重排缩进前先检查区间内**每行反引号是否成对**；有跨行模板字符串就不能统一缩进，否则会改到字符串内容。

### 第二步（已完成，2026-11-10）：整域搬到 `electron/ipc-<domain>.js`

模式（已用于周报/笔记）：

```js
// electron/ipc-files.js
'use strict';
const { ipcMain, shell, dialog } = require('electron');
// ... 本域私有的常量与辅助函数 ...
function registerFileIpc() { /* 所有 ipcMain.handle('weekly:*' / 'notes:*') */ }
module.exports = { registerFileIpc };
```

```js
// electron/main.js —— 顶部 require，setupIpcHandlers() 末尾调用
const { registerFileIpc } = require('./ipc-files');
...
registerFileIpc();
```

**只有满足这两条才能整域搬走**：

1. 本域没有依赖 main.js 的模块级状态（`loadVault` / `saveVault` / `currentPassword` / `DATA_DIR` / `appendAudit` 等）；
2. 本域不与其他域共享「内存里的可变状态」（如 `apiJar`、`ztTokenCache`）。

当前状态：`electron/ipc-files.js` = 周报 + 笔记（274 行）、`electron/ipc-tools.js` = 密码生成 + TOTP（含 RFC 6238 向量单测）、`electron/ipc-browser.js` = 浏览器检测/启动（`loadSettings` 通过参数注入）；main.js 3894 → 3466 行，`setupIpcHandlers` 2963 → 2600 行左右。

### 后续候选（按耦合从低到高）

| 域 | handler | 依赖情况 | 风险 |
|---|---|---|---|
| 工具类 | `password:generate` / `totp:code` / `history:get` | 只用 crypto + 纯函数 | 低 |
| 浏览器 | `browser:detect` / `browser:get-known` / `browser:open` | fs/path/exec/shell，需传浏览器路径设置 | 低 |
| 系统 | `app:get-path` / `dialog:*` / `file:write` / `tdg:get-path` | 需传 `TDG_DIST_PATH` / `TDG_PRELOAD` | 中 |
| 导入导出 | `import:*` / `export:*` | 依赖 `loadVault`/`saveVault`/`currentPassword`/xlsx | 高（必须传 ctx） |
| 禅道 | `zentao:*`（约 600 行） | 依赖会话 Cookie、token 缓存、`ztCfgFromVault` | 高 |
| 接口调试 | `api:send` / `api:cookies*` | 依赖 `apiJar` 内存状态 | 高 |

⚠️ 每搬一个域，**必须**跑：
- `node scripts/ui-round2-test.js`（周报）、`ui-round6-test.js`（笔记）、`ui-round9-test.js`（综合）
- `node scripts/ui-startup-test.js`（启动期不受影响，但成本低）
- `npm run pack && npm run smoke`（确认新模块进了 asar —— 打包白名单是 `electron/**/*`）
