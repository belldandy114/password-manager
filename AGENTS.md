# Project Instructions

This file provides context for AI assistants working on this project.

## Project Type: Node.js + Electron

### Commands
- Install: `npm ci`
- Test: `npm run test:unit`（没有 `npm test`）
- Dev (renderer + electron concurrently): `npm run dev`
- Dev (renderer only): `npm run dev:renderer`
- Build renderer: `npm run build:renderer`
- Build + package: `npm run dist`
- Package (dir only, no installer): `npm run pack`

### Framework: Vite (React + TypeScript)

### Version Control
This project uses Git. See .gitignore for excluded files.

## Agent Guidance

- **CodeWhale reads this file as:** AGENTS.md (CodeWhale-native)
- **Read-only surface:** `release/` — generated build artifacts (`.exe`, `.asar`, `.pak`, `.dll`, etc.)
- **Never edit:** `release/` (build output), `package-lock.json` (lockfile), `dist/` (renderer build output), `*.pak` / `*.bin` / `*.dll` files
- **Always test with:** `npm run build:renderer && npm start` — 构建渲染层后启动 Electron 验证 UI + IPC

## 详细文档索引（AGENTS.md 只留摘要）

AGENTS.md 有 65,536 B 预算，超出会被**静默截断**。历史细节拆到 `docs/agents/`，这里只留必须遵守的约束：

| 文件 | 内容 |
|---|---|
| `docs/agents/history-1.x.md` | 1.1.0–1.7.2 能力清单、构建排错、禅道登录、崩溃排查 |
| `docs/agents/weekly-report.md` | 周报 + 从禅道自动成稿的全部规则（含 69 项回归） |
| `docs/agents/update-and-release.md` | 发布流程、应用内更新（`net`）、CI 覆盖 Release |
| `docs/agents/testing.md` | 页面拆包与回归脚本、单测、CI 门禁、几何量断言 |
| `docs/agents/ipc-split.md` | `setupIpcHandlers` 拆分全过程与踩坑 |
| `docs/agents/perf-test.md` | JMeter 非 GUI 压测 |
| `docs/agents/visual-system.md` | 视觉体系 v2 的 token 与组件类名 |
| `docs/agents/window-tray.md` | 单实例锁、托盘、`showMainWindow()` 顺序、全局快捷键与 `applyHotkeys()` 回滚、搜索小窗 |
| `docs/agents/url-open.md` | 网址打开/复制入口、环境矩阵 v3 |
| `README.md` | 新人/新 AI 第一站：目录地图、命令耗时、改什么跑什么、常见坑 |

**新增内容优先写进对应主题文件**；只有「每次改代码都必须遵守」的约束才写进 AGENTS.md。

## Architecture

Electron desktop app (测试工具) integrating a password manager using AES-256-GCM encryption and a test data generator via webview. Three layers: Electron main process, preload bridge, and React renderer.

### Entry Points

- **Electron main process:** `electron/main.js` — app lifecycle, window creation, IPC handlers, vault/trash I/O, clipboard auto-clear, browser detection, import/export logic
- **Preload bridge:** `electron/preload.js` — `contextBridge.exposeInMainWorld('electronAPI', ...)` — typed IPC surface exposed to renderer
- **React root:** `src/main.tsx` — mounts `<App />` into DOM
- **App component:** `src/App.tsx` — auth state routing (Login vs Dashboard), auto-lock timer, keyboard shortcut handler, theme application

### Key Modules

- **`electron/main.js`** (~1622 lines) — 应用生命周期、窗口/托盘/全局快捷键、加密（PBKDF2 + AES-256-GCM）、vault/trash 落盘、备份与审计、剪贴板自动清空。**IPC handler 已全部按域搬到 `electron/ipc-*.js`，main.js 里不再有 `ipcMain.handle`**：
  `ipc-shell`（app:/log:/update:check/palette:/quicknote:）、`ipc-auth`（auth: 9 个）、`ipc-entries`（session:/entries:/trash:/clipboard:/settings:）、`ipc-data`（backup:/data:/audit:）、`ipc-update`（update:download/pick-file/install）、`ipc-api`（file:pick/save-text、ws:、history:、attachment:、api:send/cookies）、`ipc-zentao`（zentao: 13 个）、`ipc-vault-io`（import:/export:）、`ipc-files`、`ipc-system`、`ipc-tools`、`ipc-browser`、`ipc-jmeter`、`ipc-codelab`、`ipc-env`、`ipc-attach`、`codelab-preview`（`codelab://` 特权协议，绕开主窗口 CSP）。
- **`src/store/useStore.ts`** — Zustand store holding all renderer state: auth status, entries/tags/trash, UI state (view mode, search, filter, sort, selection), settings with keybindings, and a `getFilteredEntries()` computed selector
- **`src/pages/`** — Five page components:
  - `Login.tsx` — setup (password strength validation), login with hint, forgot-password flow via security word
  - `Dashboard.tsx` — main workspace: entry CRUD, search/filter/sort, batch operations, export modal, environment grouping
  - `Settings.tsx` — 4 tabs: security (change password, security word), general (auto-lock delay, clipboard clear, theme), browser (path config), keyboard shortcuts
  - `TrashPage.tsx` — deleted entries with restore/empty
  - `ImportPage.tsx` / `ExportPage.tsx` — data migration UI
- **`src/components/`** — Reusable UI: `EntryCard` (card view), `EntryList` (table view), `EntryForm` (add/edit), `Sidebar/TagSidebar` (navigation + tag filtering), `Modal/ConfirmDialog` (overlays), `Toast` (notifications), `BrowserMenu` (browser picker)
- **`src/styles/global.css`** (~2329 lines) — Complete dark/light theme system with CSS custom properties, dedicated scrollbar styling, all component styles
- **`src/types.ts`** — All TypeScript interfaces: `PasswordEntry`, `VaultData`, `AppSettings`, `ElectronAPI` (full IPC surface type), `SearchField`, `SortField`, `KeybindingId`, etc.
- **`src/utils/tagColors.ts`** — Hash-based tag color generation using HSL

### Data Flow

```
User Input (React UI)
  → Zustand store (useStore.ts) — ephemeral state
  → window.electronAPI.* — typed IPC calls via preload.js
  → ipcMain.handle('*') in electron/main.js
    → AES-256-GCM decrypt → in-memory vault manipulation → re-encrypt → write to disk
  → Response flows back through IPC → Zustand store update → React re-render
```

Key security properties:
- Vault data is always encrypted at rest (AES-256-GCM) — only decrypted in memory during the session
- Master password is never stored; PBKDF2 hash is stored for verification
- Clipboard clears after configurable delay
- Inactivity auto-lock with configurable timeout
- Session holds decrypted vault in-memory only; locking clears it
- Trash bin has 30-day auto-purge

### Import/Export Formats
- **Import:** CSV, JSON (plain), encrypted vault files
- **Export:** CSV, JSON, XLSX; both encrypted (with separate export password) and plain (with optional password inclusion)

## Cache Stability

- **Frequently-rebuilt files:** `package-lock.json` (dependency changes), `dist/` (renderer build output), `release/` (packaged installer)
- **Stable scaffolding:** `AGENTS.md`, `electron/main.js`, `electron/preload.js`, `src/types.ts`, `vite.config.ts`, `tsconfig.json`, `src/store/useStore.ts`
- **Append, don't reorder:** New context goes at the end of the request; reordering invalidates prefix cache

## Guidelines

- Follow existing code style and patterns
- Write tests for new functionality
- Keep changes focused and atomic
- Document public APIs
- Update this file when project conventions change
- All IPC handlers in `electron/main.js` must return `{ success, data?, error? }` shaped responses
- Renderer should never access Node.js APIs directly — always use `window.electronAPI.*`
- Encryption changes must be carefully reviewed; vault data loss is unrecoverable
- CSS uses a CSS custom property theme system — always use `var(--*)` instead of hardcoded colors
- ⚠️ 三份样式表按 `global.css → pages.css → redesign.css` 顺序加载，同名选择器重复很多
  （2026-11-09 实测：规则 2,386 条 / 选择器 2,029 个，**重复 263 个 = 声明冲突 253 + 完全重复 10**）。
  按钮变形那次就是后加载的密度规则覆盖了前面的样式。
  新增/修复样式一律写在 `redesign.css` 末尾并注明原因，不要靠改前面的文件「猜」优先级。
- `node scripts/check-css-dup.js`（已进 `npm run check`）会把重复分成两类：
  **声明完全相同**的可以机械清理（保留最后加载的那条，删前面的不影响级联结果）；
  **声明冲突**的必须人工确认。别再用「行首是 `.xxx {`」这种正则做统计，会漏掉约一半规则。
- 2026-11-09 已清掉 `redesign.css` 里被整段复制两遍的「31 汇总洞察 / 32 今日待办」（-123 行），
  验证方式不是看图：解析前后两份 CSS，按「同选择器 + 同 @media 的声明合并（后者覆盖）」求值，
  断言 357 个选择器的最终声明**完全一致**（0 差异）。以后再删重复也先做这一步。

## Windows 打包 / 启动排错（2026-10 排查结论，务必保留）

**症状**：双击 exe 无窗口、进程秒退；退出码 `2147483651`（`0x80000003 STATUS_BREAKPOINT`），
`--enable-logging` 无输出，`main.js` 第一行都执行不到 → 崩在 Chromium 沙箱初始化，**应用层代码无法拦截**。

**已确认的诱因：产物文件带「低完整性级别（Low Mandatory Level）」标签**

```powershell
icacls "release\win-unpacked\测试工具.exe"     # 出现 Mandatory Label\Low Mandatory Level 即命中
icacls "<目录>" /setintegritylevel (OI)(CI)Medium   # 修目录；已有文件加 /T
```

- 本项目的上层目录（本机用例目录树）带有 Low IL 的 `(OI)(CI)` 继承标签，
  **在此树内构建出的 exe 会自动继承 Low IL，双击必闪退**。每次打包后都要抽查一次标签。
- 快速判别：给 exe 加 `--no-sandbox` 启动，能起来就说明是沙箱初始化问题（仅用于诊断，不要作为交付方式）。
- 已排除的因素：中文路径名、路径长度、Electron 版本、IFEO/漏洞利用保护、CSP/preload/IPC 代码。

**构建相关**

- `electron` 固定在 `37.10.3`（`devDependencies`）；打包时通过 `-c.electronDist=node_modules/electron/dist`
  复用本地运行时，避免联网下载。
- NSIS 阶段会下载 nsis/nsis-resources 资源，本机访问 GitHub 会超时；离线打包请设置
  `ELECTRON_BUILDER_CACHE=%LOCALAPPDATA%\electron-builder\Cache`（本机已有完整缓存）。
- `scripts/fix-icon.js` 已不再被 `build-installer.js` 调用：它针对 `password-manager-temp.exe`
  这个 electron-builder 不再留下的中间文件，必然报 `Fatal error: Unable to load file`。
  图标由 electron-builder 在 `--dir` 阶段用 `buildResources/icon.ico` 直接写入。

## 性能约束（2026-10 优化，改动前请先读）

`KEY_ITERATIONS = 600000` 的 PBKDF2-SHA512 在本机约 **390ms/次**。早期实现里每次读写都会重新派生，
导致「新增/修改/删除/刷新列表」各卡 **0.6~0.95 秒**。现在改为会话级缓存：

- `getKey(password, salt)`：命中就复用，写盘时复用同一个 salt（`encrypt` 里的 `reuse` 分支）。
  **磁盘格式没变**（salt 仍在文件头），旧库可直接打开，KDF 强度也没降。
- `loadVault` / `saveVault` / `loadTrash` / `saveTrash`：解密结果留在内存（`vaultCache` / `trashCache`），
  handler 里对返回对象做 `push` / `filter` 后再 `saveVault` 是安全的，缓存会自动同步。
- **新增 IPC handler 必须走 `loadVault` / `saveVault`**，不要自己 `fs.readFileSync(DATA_FILE)`，
  否则既慢又会绕过缓存造成读写不一致。
- **4 个必须清缓存的时刻**：`session:unlock`、`session:lock`、`auth:change-password`、
  `auth:reset-password`（都调 `clearCaches()`）。新增涉及换密码/换库的逻辑时别忘了。
- 渲染层 `sessionTouch` 已节流到 **5 秒一次**（`src/App.tsx`），别把它绑回 mousemove 的原始频率。
- 实测（60 条数据）：增删改查 **1~4ms**，界面 **60fps / 17ms 帧时间**；
  登录仍有一次 ~300ms 的 KDF，属于安全成本，不要为了「看起来快」去降迭代次数。

## 窗口 / 托盘 / 单实例（1.0.4）

单实例锁、托盘菜单、`showMainWindow()` 必须先 `show()` 再 `restore()`、两个全局快捷键的分工与
`applyHotkeys()` 回滚规则、搜索小窗（`?window=palette`）的缓存/高度/主题/未解锁行为 —— 全部细节见
`docs/agents/window-tray.md`。**改窗口、托盘、快捷键、搜索小窗前必读**。

## 1.1.0 新增能力（改动时注意联动）

CSV/Excel/JSON 导入（`parseCsv` + `normalizeImportRecords`，**新增字段必须同步 `IMPORT_FIELD_ALIASES`**）、
密码生成器（crypto + Fisher–Yates，别用 `Math.random`）、安全体检、自动备份（每天 1 份保留 7 份）、
登录限速（5 次错 → 30s）、防截屏、开机自启、窗口状态、主题跟随系统、记住上次页面、列表增量渲染（每屏 120 条）。
逐项实现位置见 `docs/agents/history-1.x.md`。

## 1.2.0：多模块扩展（改动前必读）

### 数据层（1.2.0 起）

vault = `{ entries, tags, history, snippets, notes, checklists, accounts, environments, apiRequests, integrations }`。
`normalizeVault()` 在 `loadVault` 里补齐缺失字段，旧库可直接打开；新增集合只加进 `VAULT_COLLECTIONS`，
渲染层用 `ws:get` / `ws:set`（`src/hooks/useCollection.tsx`）。**不要**给这些模块另建密码库或明文文件。
`history` 由 `entries:update` 自动维护（密码变更留最近 10 条），不要手写。页面清单见 `docs/agents/history-1.x.md`。

### 禅道登录三步（20.6 实测，改这块必须按此回归）

1. `GET user-login.html` 建会话，并从表单取隐藏域 `referer`；
2. `GET user-refreshRandom.html` 返回**纯文本**数字盐（不是 JSON，`JSON.parse` 会失败）；
3. `POST user-login.html`：`account`、`password=md5(md5(明文)+rand)`、`verifyRand=rand`、`referer`、`keepLogin`。

必须带 `X-Requested-With: XMLHttpRequest` 与 `Referer`；**不要用 `index.php?m=user&f=login`**（PATH_INFO 实例会 302）。
Bug 列表用 `my-work-bug.html`（`my-bug.html` 无权限），表格数据在 `zui-create-dtable` 属性里、不是合法 JSON，
只能按括号配平截取 `"data":[...]`（`ztTableRows`）。完整表格与快捷入口清单见 `docs/agents/history-1.x.md`。

### ⚠️ 绝对不要用 `<datalist>`（会导致程序原生崩溃）

`Environments` / `Accounts` 的弹窗曾用 `<input list="xxx"> + <datalist>` 做「系统名」联想。
实测：**输入框处于聚焦状态时，候选项（options）发生更新，Chromium 直接 0xC0000005 崩溃**，
整个程序瞬间退出、没有任何 JS 报错 —— 用户看到的现象就是「点保存没反应 / 添加内容无效」。

- 复现路径：打开弹窗（input `autoFocus`）→ 填系统名 + 地址 → 点保存 → `setItems` 让
  `systems` 变化 → datalist 重新渲染 → 崩溃。
- 对照实验：删掉 `<datalist>` 节点后再保存 → 一切正常、数据正常落盘。
- **替代方案**：用可点的快捷标签（`.suggest-row .chip`），功能等价、无崩溃风险。
  已在 `Environments.tsx` / `Accounts.tsx` 里改掉，别再改回 datalist。

### 排查 Electron 原生崩溃（无 JS 报错）

`spawn(exe, ['--no-sandbox', '--remote-debugging-port=9xxx', '--user-data-dir=<临时>'])` → CDP 监听
`Runtime.exceptionThrown` / `Inspector.targetCrashed` + 子进程 `exit`（`3221225477 = 0xC0000005`）；
再用「变量替换法」把可疑 API 换成桩或删掉可疑 DOM 节点，崩溃是否消失即结论。
参考 `scripts/ui-features-test.js`。**跨页状态必须放 store**（`src/store/zentaoStore.ts`），页面 `useState` 切页即丢。

### 禅道 REST API（api.php/v1）—— 取「整个项目」的 Bug

网页端只给「我的 Bug」，全量要靠 REST（Zentao 18+ 内置）：
1. `POST {base}/api.php/v1/tokens`，body `{"account":"...","password":"..."}` → `{"token":"..."}`
2. 之后所有请求带 **`Token: <token>`** 头（不是 `Authorization: Bearer`，用错会 401）
3. `GET api.php/v1/products?limit=1000` → 产品（= 界面上的「项目」）列表
4. `GET api.php/v1/bugs?product=58&limit=1000&page=1` → `{total, bugs:[...]}`，>1000 条要翻页

- `assignedTo` / `openedBy` 是对象 `{account, realname}`，渲染前要取 `realname`。
- token 有有效期，主进程里缓存 token；遇到 401 强制换新 token 重试一次（`ztApiGet`）。
- 实测该实例：数十个产品，单个产品下可有数百条 Bug（具体名称与数量以实际环境为准）。
- 项目列表排序：把「我有 Bug 的项目」排前面，默认选中即可看到自己正在测的项目。

### 周报（本地 Markdown）约定

主进程只暴露 `weekly:list / read / save / rename / delete / pick-dir / reveal`，**所有路径过 `weeklyResolve()` 做目录穿越校验**；
删除走 `shell.trashItem()`（可恢复），不要 `fs.unlink`；渲染用 `utils/markdown.tsx`。

**从禅道自动成稿**（`utils/weeklyDigest.ts`，29 条单测）的格式照着使用者真实周报来：
`**一、项目名**` → 「累计缺陷 N 个，已关闭 A…修复率 E%」→ `（1）模块：共 N 个…` → 总结 → 「下周工作计划」。
口径与 `utils/bugSummary.ts` 一致（已修复 = `resolution==='fixed'`）。

几条被反复反馈过的硬约束：**项目默认一个都不勾**（空选择不许兜底成「全部」）；公司状态只由「勾了几个项目」决定；
项目名完整显示不截断；「生成一次还能继续补」只认**正在编辑的草稿**（别把已保存文件算进去，否则会覆盖历史周报）；
`mergeDigest` 靠 `**一、标题**` 与「本周完成 / 下周工作计划 / 统计范围：」认边界，改格式必须同步改这三个正则；
记住上次选择存**口径名不存死日期**、项目只存 id 且加载后过滤。
完整规则（含弹窗交互、缓存复用、生成并保存、69 项回归）见 `docs/agents/weekly-report.md`。

### ⚠️ 禅道会话必须按实例分桶（做跨公司功能前必读）

`ztCookieJars: Map<baseUrl, Map<name,value>>` + `ztLoggedInBases: Set<baseUrl>`。

以前是全局单例 `ztCookies` / `ztLoggedInBase`，只能同时认一个站点。跨公司的周报要一次拉好几套，
单例会让后登录的覆盖前面的 cookie，表现为「A 公司的请求带着 B 公司的会话」→ 401 或读到别的项目。
同理 `ztApiTokens` 也改成了 `Map<key, token>`，否则每换一家都要重新认证。

`scripts/ui-digest-test.js` 的桩会**校验各自的 Token 和 Cookie**，串号会直接 401 —— 改这块必须跑它。

### 视觉体系 v2（pages.css 第 19 节）

新增页面直接用 `components/ui.tsx` + 这套类名，不要手写样式：`.content-area > .pg`（1440 居中）、`PageHead`、
`Panel`（16px 圆角 + 双层阴影，`collapsible` 可折叠）、`.tbl`（11px 粘性表头）、`.tabs > .tab2`（下划线式）、
`.btn-primary/.btn-secondary`（9px 圆角）、全局 input/textarea/select（34px 高 + focus 3px 光环）。
网址弹窗小按钮统一 `.entry-mini-btn` 系列；**不要用 `<datalist>`**（见上）。
完整 token 表与截图脚本见 `docs/agents/visual-system.md`。

### ⚠️ 禅道 REST 查 Bug 必须带 `status=all`

`api.php/v1/bugs?product=58` **默认只返回「未关闭」（active + resolved）**：
```
product=58                  → total 219（active 190 + resolved 29）
product=58&status=all        → total 680（active 190 + resolved 29 + closed 461）✅
```
`browseType=all` / `/products/58/bugs` 都是 219，只有 `status=all` 是网页上看到的全量。
实测该实例：产品 58 = 681 条；31 个产品合计 9881 条（其中 9358 已关闭）。
明细表仍限制渲染 300 行（`.tbl-more` 提示），别整表渲染上万行。

### 发布新版本（远程更新完全依赖 GitHub Releases）

**只提交 git 不够**，必须发 Release 并挂安装包，否则所有人的「检查更新」停在旧版本。
用 `npm run release -- <ver>`（升版本 → 构建 → 打包版回归 → 英文资产名 → 推送 → 建 Release → 等 CI → 核对附件与 latest）。
⚠️ 上传前必须改成英文文件名（中文名会被 GitHub 改写）；`release/` 在 `.gitignore` 里。

⚠️ **CI 会覆盖 Release 说明**（`.github/workflows/build.yml` 用写死的模板建 Release），
所以 `release.js` 第 8 步会删掉 CI 多传的 `Setup.<ver>.exe` 并用本地 notes 回填说明 —— 对新旧 CI 都幂等。
本机 gh token 没有 `workflow` scope，推不了 workflow 改动；推荐模板在 `scripts/ci-build.yml.recommended`。

应用内更新（检查 + 下载）**必须用 Electron `net`，不要用 Node `fetch`**（undici 不读系统代理）；
默认纯单连接 + 30 分钟总超时，**不要再自动切并行**（停顿会被误杀、`parts-*` 易被杀软隔离）；
安装包执行有白名单（`allowedInstallFiles`）；摘要缺失时 `verified=false` 且取消自动安装。
禅道 Bug 截图需带登录态由主进程取（`ztFetchBinary` → dataURL）。细节见 `docs/agents/update-and-release.md`。

### 时间显示：一律走 `src/utils/time.ts`

`iso.slice(11, 16)` 取的是 **UTC 小时**，北京时间会少 8 小时（禅道「· 03:20 拉取」其实是 11:20）。
用 `formatHm` / `formatDateTime` / `formatRecent`。

### 1.4.0 起的几个约定

列表分页走 `components/Pager.tsx`（筛选变化重置到第 1 页）；导出文本由主进程 `file:save-text` 写 **UTF-8 BOM**；
断言在 `utils/apiAssert.ts`（只断言填了的项，状态码支持 `2xx`）；全量 Bug 缓存 `zentao:all-bugs` 10 分钟 TTL；
审计日志 `DATA_DIR/audit.log` **只记动作 + 条目名，绝不写密码**；自动备份保留份数读 `settings.backupKeep`。

### Esc 必须能关掉一切浮层

新增任何弹窗 / 抽屉 / 下拉 / 右键菜单，都要在组件里加：

```ts
useEffect(() => {
  if (!open) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [open]);
```

- `Modal` 已内置，直接用它就不用重复写。
- 多层同时打开时，**内层先关**：例如 Bug 抽屉里的大图预览，Esc 先关大图再关抽屉（`BugDrawer` 有实现）。
- 别只写在 `onKeyDown` 上：焦点一旦离开输入框（点过列表）就收不到事件，必须 `document` 级。

### 跨页触发动作：用 `cmdSignal`

命令面板要"跳页并执行某个动作"时，不要直接调另一个页面的函数（组件是 switch 渲染的，跨页拿不到实例）。
用 `useStore.getState().signalCmd('zentao:refresh-mine')`，目标页面：

```ts
let lastCmdAt = 0;                       // 模块级：页面重新挂载也不会重复执行
useEffect(() => {
  if (!cmdSignal || cmdSignal.at === lastCmdAt) return;
  if (cmdSignal.kind !== 'zentao:refresh-mine') return;
  lastCmdAt = cmdSignal.at;
  loadMine();
}, [cmdSignal]);
```

### 1.5.0 起的几个约定

`ApiRequest.bodyType` = `json / form / multipart / raw / none`（`multipart` 的值以 `@` 开头=本地路径；
用户自己写了 Content-Type 就不覆盖）；Cookie 统一写在请求头里（旧数据走 `migrateReq()`）；
笔记目录存 `localStorage['pm.notes.dir']`；`notesResolve` / `weeklyResolve` **必须做目录穿越校验**。

### ⚠️ 跑 UI 回归时的两个坑

1. **CDP 里 DevTools 自己也是一个 `type: 'page'` 的 target**，而且排在应用前面。
   只写 `list.find(t => t.type === 'page')` 会连到 DevTools 页面上（表现为 `document.body` 里全是 CSS 文本）。
   必须过滤：`!t.url.startsWith('devtools://')`。
2. **开发模式（`electron .`）窗口加载的是 `http://localhost:5173`**，本机 Electron 连不上 dev server
   （页面变成 `chrome-error://chromewebdata/`，curl 却是 200）。
   现在主进程支持 `PM_USE_DIST=1`：开发目录下也直接加载已构建的 `dist`，回归脚本不用先打包。

### ⚠️ electron-builder 下载超时 / 构建卡死

`npm run pack` 会去 GitHub 下 electron / winCodeSign，公司网络常超时。先设
`$env:ELECTRON_BUILDER_CACHE = "$env:LOCALAPPDATA\electron-builder\Cache"`。
实在不行只重打 asar（`npx asar extract` → 覆盖 `dist`/`electron` → `npx asar pack`），exe 本体不用变；
**要出安装包仍必须让 electron-builder 完整跑通**。子应用构建曾因 bash 语法 `test -d` 在 cmd 下卡死，
已改 `node scripts/build-subapp.js`。完整排错记录见 `docs/agents/history-1.x.md`。

## 1.6.0 起的约定（改代码前先看）

| 能力 | 约定 |
|---|---|
| 原子写盘 | `writeFileAtomic`（临时文件 → fsync → rename + `.bak`），**所有 vault/trash 落盘都必须走它** |
| 损坏自愈 | `readEncryptedWithBak` 回退 `.bak`；`auth:verify` 返回 `code:'vault-corrupt'` |
| 备份恢复 | `backup:restore` 先做 `pre-restore` 快照（保留 5 份） |
| 数据目录迁移 | `data:migrate` / `data:reset-location` 只复制不删除；`resolveDataDir()` 是唯一入口 |
| 结构快照 | `utils/apiSchema.ts` 只比类型不比值；快照存 `req.snapshot` |
| 断言规则行 | `ApiRequest.assertions[]` = `{op,target,value,negate}`，旧 5 槽位走 `migrateReq()` |
| 会话 Cookie 罐 | `apiJar`（已随 `ipc-api.js` 搬走），用户手写 Cookie 头优先 |
| 禅道多套配置 | `AppSettings.zentaoActiveId` + `ztCfgFromVault()` |
| 未读红点 | `DATA_DIR/zentao-notify-state.json`（**不是** userData） |

其余（禅道附件、周报对比、安装包并行下载等）见 `docs/agents/history-1.x.md`。

### 页面拆包与回归脚本的配合（注意，改这里很容易踩）

工作台页面全部 `React.lazy` + `Suspense`，**首次进页面是异步的**：`navTo` 必须「等 `.page-loading` 消失 + `.pg` 出现」
再断言，不要定长 `sleep(800)`（慢机器会抓到上一页 DOM，表现为随机几条失败、重跑又过）。
数据生成器 webview 走 `tdgMounted` 保活，**别改成随页面卸载**。

单测：`npm run test:unit`（vitest），测试放 `src/utils/__tests__/*.test.ts`，`tsconfig` 只 include `src`（**不要引入 node 类型**）；
主进程纯函数抽成 `electron/<mod>.js` + `.d.ts` 才能被渲染层单测 import；打包后跑 `npm run verify:packaged-csv` 确认模块真进了 asar。

### ⚠️ 跑 UI 回归前先清干净残留进程

上一轮测试若没退干净（`测试工具.exe` 还在跑并占着 `--remote-debugging-port`），
下一轮 CDP 会连到**旧实例**上——表现是「明明改了代码，回归还是旧行为」，或者随机几条莫名其妙失败。

```powershell
Get-Process -Name "测试工具" -ErrorAction SilentlyContinue | Stop-Process -Force
```

另外：脚本 `spawn` 打包后的 exe 时，必须 `delete env.ELECTRON_RUN_AS_NODE`
（本机环境里有这个变量，否则 exe 会以「纯 Node」模式启动，窗口不出现、CDP 连不上）。

### CI 门禁是怎么生效的（2026-11-09 更新）

门禁装在**脚本**里而不是 workflow 里（token 缺 `workflow` scope 推不了 workflow）：
`build-installer.js` 开头 `require('./ci-gate').runGate()`，顺序 = 隐私扫描 → `tsc --noEmit` → `vitest run` → IPC 契约 → CSS 重复报告（只报告）。
`npm run check` / `npm run regress` / CI 构建共用同一份 `ci-gate.js`；任一步失败即 `exit 1` 不出包。
`SKIP_PREFLIGHT=1` 只用于排查构建问题，正式发版不要跳。

## 1.6.1 起的约定（改代码前先看）

| 项 | 约定 |
|---|---|
| 周次下拉 | `weekOptions()` 的 **offset = 几周前**（0=本周），`weekRange` 内部减 `offset*7` 天，别写成 `-i` |
| 老数据兼容 | `localStorage['pm.weekly.draftOffset']` 里的负数一律归 0 |
| 对比表对齐 | `.wk-cmp*` 三列**定宽 + 右对齐 + baseline**，不要退回 `1fr` |
| 设置页骨架 | `.set-shell / .set-rail / .set-nav`，不要回到顶部横排 + 600px 窄栏 |
| 接口调试视觉 | 只改样式、**不动类名**（`.url-bar`/`.api-io`/`.assert-toggle`/`.resp-tabs`/`.code2`） |
| 周报正文框 | `.wk-editor` 定高 + 子项 `min-height:0` + 边框用 `--input-line` + 阅读态带 `wk-read` |

### 样式类改动怎么验：`scripts/ui-round8-test.js`

模型看不到截图，样式改动全部用**几何量**断言（computed style / `getBoundingClientRect`），不要只截图说「看起来还行」：
周报下拉顺序与区间、设置页 `.set-rail` 竖排与内容宽度、接口调试地址栏边框/断言行贴满/`.code2` 圆角、
对比表每列数字右边界与表头吻合、`.pnl-head.is-clickable` 能收起再展开。

### 设置页改版后要顺手自查的点

- `.set-main .settings-section` 才是卡片样式；别的页面若也用 `settings-section`，样式只在这个容器内生效（已限定 `.set-main`）。
- 四个分组的标题来自各 tab 里的 `<h3>`，新增分组记得保持「一个 `.settings-section` + 若干 `.setting-row`」的结构，否则右侧卡片样式会断。

## ⚠️ 仓库卫生：绝不把本机信息 / 账号密码提交进 git（2026-10-29 事故后新增）

这个仓库是**公开**的。历史上踩过三类泄露，改代码前务必对照：

| 泄露类型 | 曾经的写法（已清理） | 现在的做法 |
|---|---|---|
| 真实禅道地址 + 账号 + 密码 | 7 个 `scripts/ui-*.js` 里各有一行 `const ZT = { base: 'http://<内网IP>:8181/zentao', account: '...', password: '...' }` | 统一 `const ZT = require('./zt-config');`，值来自环境变量 `ZT_BASEURL` / `ZT_ACCOUNT` / `ZT_PASSWORD`（见 `scripts/zt-config.js`），**代码里不留任何默认值** |
| 使用者本机目录 | `WeeklyReport.tsx` 的 `DEFAULT_DIR = 'E:\...\周报'`、`shots-140.js` 的输出目录、AGENTS.md 里的绝对路径 | 默认值改为空，由用户在界面上选一次存进 `localStorage`；脚本用相对路径或环境变量 |
| 本机环境/编辑器配置 | `.claude/settings.local.json`（含 `C:/Users/...`） | 已 `git rm --cached` 并写进 `.gitignore` |

补充约定：

- `release-notes-*.md` **不进仓库**（已 ignore）。它只在发布时本地写入，然后 `gh release edit <tag> --notes-file release-notes-<ver>.md` 同步到 Release。
- 界面上的示例值（禅道地址、目录）一律用 `example.com` / `host:端口` 这类占位，不要用真实内网地址——它会随 asar 一起发出去。
- 写新脚本要连外部服务时，**从环境变量读**，并在开头 `if (!ZT.ready) { console.log('未配置 ZT_* 环境变量，跳过'); return; }`，不要硬编码。
- 提交前自查（本机执行，命中即停）：

```powershell
git diff --cached -U0 | Select-String -Pattern 'password\s*[:=]\s*[''"]|http://\d+\.\d+\.\d+\.\d+|[A-Za-z]:\\\\|[A-Za-z]:/'
```

- 万一已经推上去了：**先改密码**（历史清不掉的情况下，改密码才是止损），再决定是否重写历史。
  重写历史会改所有 commit SHA，必须 `git push --force`，且需要把 tag 一起重指。

## 1.7.0 起的约定（改代码前先看）

cURL 互转 `utils/curl.ts`（`parseCurl`/`buildCurl` 纯函数，32 条单测；分词器要支持引号段拼接，别写成「遇引号就 push」）；
`copyCurlCmd` 必须回退 `textarea + execCommand`（窗口未聚焦时 `navigator.clipboard` 会抛错）；
我的 Bug 三视图 `ztLoadMyBugsScoped`（opened/verify 走 REST，assigned 走页面抓取）；
异地备份 `backupMirrorDir` / `mirrorBackupFile`（**写失败只记录不抛**）；回归桩 `scripts/zt-stub.js`。

### 回归脚本现在的跑法（不再依赖内网与账号）

`ui-round2/3/4/5/9` 都会自动 `ensureZt()`：配了 `ZT_BASEURL` / `ZT_ACCOUNT` / `ZT_PASSWORD` 就打真实禅道，
没配就起本地桩（`scripts/zt-stub.js`），**与真实数据强相关的断言自动跳过并打印原因**。
所以「12/12 通过 + 5 跳过」是正常的，不是漏测；要全量验证先设环境变量。

## ⚠️ 应用内下载：不要把安装包拼到 %TEMP%（2026-10-29 杀软误报）

安装包必须落在 `update/` 目录（`updateDir()`），**不要拼到 `%TEMP%`** —— 杀软会把「临时目录里的 exe」
当可疑文件隔离，表现为下载完成但安装失败。1.7.2 另修了两处（见 `docs/agents/history-1.x.md`）。

## 1.7.3 起的约定（工程债清理，改代码前先看）

### 纯函数下沉模式（main.js 不要再无脑变大）

main.js 现在 1622 行（IPC 已全部拆走，见「IPC 域拆分进度」）。**新增/修改纯逻辑时，先抽成 `electron/<module>.js` + `electron/<module>.d.ts`，
再在 `src/utils/__tests__/<module>.test.ts` 写单测**（tsconfig 只 include `src`，d.ts 让测试能直接 import）。
已下沉的模块：

| 模块 | 内容 | 单测 |
|---|---|---|
| `electron/csv.js` | `parseCsv` / `normalizeImportRecords` / `IMPORT_FIELD_ALIASES` | `csv.test.ts`（13） |
| `electron/vault-schema.js` | `VAULT_COLLECTIONS` / `normalizeVault`（**旧库升级唯一关口**） | `vaultSchema.test.ts`（8） |
| `electron/vault-file.js` | 加密文件常量 + `inspectVaultFile`（结构自检） | `vaultFile.test.ts`（9） |
| `electron/zentao-parse.js` | `ztDecodeEntities` / `ztStripTags` / `ztTableRows`（dtable 解析） | `zentaoParse.test.ts`（13） |

- 常量只留一份定义：`ALGO` / `SALT_LENGTH` / `IV_LENGTH` / `TAG_LENGTH` 已从 main.js 移到 `vault-file.js`，
  由 main.js require。**别再在 main.js 里重新声明**——恢复校验和解密各算各的长度必然出事。
- 测试里**不要用 `Buffer`**（tsconfig 无 node 类型）；需要造二进制就自己写最小 base64 编码（见 `vaultFile.test.ts`）。
- 下沉时注意 main.js 里的 `const` 是块级作用域：`setupIpcHandlers()` 内部的 require 只能在该函数内可见，
  新抽的模块一律在**文件顶部 require**。

### 恢复前必须做结构自检

`backup:restore` 在用备份覆盖主库前，先 `inspectVaultFile()`（校验 base64 + 长度 ≥ 65 字节）：
不合格直接返回错误、**一行都不动**。以前只校验文件名，损坏的备份会把好库盖掉。

### IPC 调用一律走 `callIpc`（`src/utils/ipc.ts`）

```ts
const r = await callIpc(() => window.electronAPI.fileWrite({ filePath, content }));
if (!r.ok) { addToast(`导出失败：${r.error}`, 'error'); return; }
```

- 判定规则：只有 `success === false` / 抛异常 / 返回空 才失败；`canceled: true` 算成功（用户取消不该弹错误）。
- **写盘、导出、设置保存这三类必须判错**：以前 `fileWrite` 结果被忽略，磁盘满/无权限时照样弹「导出成功」。
  已修：`Dashboard.tsx` 的两条导出、`ExportPage.tsx` 的两条导出、`Settings.tsx` 的 `handleSave` + `applyTraySetting`。
- 注意 TS 窄化在闭包里会丢失：先 `const payload = result.data;` 再进箭头函数，否则报 `string | undefined`。

### 依赖卫生

- `react-router-dom` 已移除（代码里 0 引用，之前一直躺在 dependencies 里）。加依赖前先 grep 是否真的用得上。

### 接口调试侧栏（两行式）类名约定

`.api-list-item.api-row-2l` → `.method` + `.api-item-main`（内含 `.api-item-name` / `.api-item-sub`）+ `.api-item-del`。

- `.api-name` / `.api-hist` / `.api-pick` 这几个老类名**必须保留**（round4/5/6 依赖）。
- 删除按钮默认 `opacity: 0`，hover/选中/聚焦才出现；回归里用 `Input.dispatchMouseEvent` 真鼠标移动验证。
- 侧栏宽 272px，面板头部收紧（`.split > .pnl:first-child .pnl-head`），标题用「历史 + 计数徽标」，
  不要再写「请求历史」四个字（会被挤成两行）。
- cURL 导入的 cmd 转义清理顺序（见 `utils/curl.ts` `unwrap`）：`^`+换行 → `^"`/`^'` → `^&|<>()` → 行尾孤立 `^`，
  最后才处理 bash 的 `\`+换行。缺任何一条都会出现「地址里带 `^&`」这类残留。

## ⚠️ 启动阶段新增逻辑：必须放在模块作用域，并且要有「跑过 8 秒」的回归

`electron/main.js` 里 `setupIpcHandlers()` 曾经是一个 3000 行的大函数（2026-11-10 起只剩注册调用，见「IPC 域拆分进度」），
历史教训是：在里面顺手定义了「启动后要用的函数」，`app.whenReady()` 里的代码是**看不到**它的。

2026-10-29 就踩了这个：`autoCheckUpdate` 写在 `setupIpcHandlers` 内部，而调用点在 `whenReady` 的
`setTimeout(..., 8000)` 里 —— 应用启动 8 秒后抛 `ReferenceError: autoCheckUpdate is not defined`，
弹「A JavaScript error occurred in the main process」。**所有既有回归都没发现**，因为：

- UI 回归几十秒跑完，但没人跑到 8 秒后；
- `npm run smoke` 只测首屏 13 条，几秒就退出。

**约定**：

1. 启动期逻辑（定时器、`whenReady` 里引用的函数）一律**定义在模块作用域**（`setupIpcHandlers` 外面），
   与 `fetchLatestRelease` / `autoCheckUpdate` 同层；只被 IPC handler 用到的可以留在里面。
2. 新增启动期定时任务，必须加一个阶段日志开关（参考 `PM_DEBUG_AUTO_UPDATE=1` 打印 `[auto-update] start`），
   让回归能断言「定时器真的执行到了」，而不是只看「进程没退出」。
3. 加了启动期逻辑就跑 `node scripts/ui-startup-test.js`（默认等 16 秒；`USE_PACKED=1` 测打包版）。

```bash
node scripts/ui-startup-test.js                 # 开发目录（需先 npx vite build）
USE_PACKED=1 node scripts/ui-startup-test.js    # 打包版（需先 npm run pack）
```

它验证三件事：进程 16 秒后仍存活 / 定时器执行到 / 主进程无未捕获异常。

## 拆分 `setupIpcHandlers`（2026-10-29 起，2026-11-10 完成）

**已完成**：`main.js` 4652 → 1622 行，`ipcMain.handle` 计数 0，全部 handler 按域搬进 17 个 `electron/ipc-*.js`（清单见「IPC 域拆分进度」）。

搬迁模式：`registerXxxIpc(deps)` + 对象注入（`loadVault` / `getPassword` / `getMainWindow` …），模块内不 require main.js；
会话密码与窗口一律用 **getter**（传值会拿到搬迁那一刻的 `null`）。
边界判定按「下一个域的起始注释」倒推，**不要用 `^\s*\}\);$` 找第一个 `});`**（那是 handler 内部的 try/catch 收尾，会把函数提前闭合，
`node --check` 查不出来，运行时才报 `xxxResolve is not defined`）。
搬完必须扫一遍漏 require 的 Node 核心模块（`ipc-zentao.js` 漏 `crypto` 曾伪装成「登录页返回 HTTP 404」）。
完整踩坑记录与「后续候选」表见 `docs/agents/ipc-split.md`。

## 压力测试（JMeter 非 GUI）

只跑 `-n` 模式：`electron/jmeter-args.js`（纯函数，16 条单测）+ `electron/ipc-jmeter.js` + `src/pages/PerfTest.tsx`。
四个必须记住的坑：① Windows 上 `.bat` 不能直接 spawn（要 `cmd.exe /c`）；② 停止要 `taskkill /PID <pid> /T /F` 杀进程树；
③ 报告模式 `-o` 要求目录为空，所以每次建 `report-<时间戳>/`、jtl 放它旁边；④ 输出流式 + 界面只留最近 4000 行。
线程/循环覆盖靠 `-Jthreads=N -Jloops=N`，脚本里必须用 `${__P(threads,默认值)}` 才生效。
回归用假 JMeter（`scripts/ui-round10-test.js`，14 条断言），**不要拿真实 JMeter 打内网做回归**。细节见 `docs/agents/perf-test.md`。

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

## 1.9.2 起的约定（改登录页 / 接口调试标题行前先看）

| 项 | 约定 |
|---|---|
| 登录页「从旧版本恢复」 | 登录卡片很窄，提示条用**上下排布**（文字在上、按钮靠右在下），按钮必须 `flex: 0 0 auto; white-space: nowrap`，否则会被挤成半截字（1.9.2 修过） |
| 接口调试请求头标题行 | 「收起/展开」与「+ Cookie」必须在 `.field-label-actions` 里、`margin-left: auto` 贴右。别用 `space-between` 直接排三个子元素——会把按钮甩到行中间（用户明确说「在中间不合适」） |
| 布局类改动怎么验 | 不要只截图说「看起来行」。r9 里有几何断言：动作组右边缘与标题行右边缘间距 ≤ 14px（实际 0）；登录页按钮 `scrollWidth ≤ clientWidth` |

### release.js 的两个坑

- **不要用 `cmd /c timeout` 休眠**：无终端（后台任务/CI）时它会报 `Input redirection is not supported` 并抛错，把发布卡在「等 CI」那一步。用 `Atomics.wait` 封装的 `sleepSync(ms)`。
- **`.github/workflows/build.yml` 里还写着「测试工具」**：CI 上传产物会提示 `No files were found`（不影响 Release，但没 artifact）。本机 gh token 缺 `workflow` scope，改不了；要修先 `gh auth refresh -h github.com -s workflow`，或直接把 `scripts/ci-build.yml.recommended` 覆盖过去（模板已统一产品名、附件 glob，并去掉 CI 双写 Release）。旧补丁 `ci-workflow-rename.patch.txt` 只改产品名，已不推荐。

## 1.10.0 起的约定（改缺陷管理 / 代码调试前先看）

| 项 | 约定 |
|---|---|
| `zentao:my-bugs` | **三个视图统一走 `ztLoadMyBugsScoped`**（REST + 本地按账号过滤）。不要回到 `ztLoadMyBugs` 的 HTML 抓取分支——那条路拿不到账号字段，界面会永远显示「未按账号复核」 |
| 「指派给我」语义 | 只保留未关闭（`filterMineBugs` 里 scope=assigned 时排除 closed），和按钮提示一致 |
| 项目集名称 | 产品列表带 `programName`（`ztApiPrograms` 拉 `api.php/v1/programs`，10 分钟缓存；失败静默降级）。选择器与标签显示 `项目集 / 项目名` |
| 禅道配置 | `ZentaoConfig.company` 可选；胶囊显示 `公司 · 主机`。**回归脚本按字段标签填表单**，不要按 input 顺序（加字段就会错位，1.10.0 踩过 r9 的 11 条失败） |
| 代码调试 | `electron/codelab-args.js`（纯逻辑 + 9 条单测）+ `electron/ipc-codelab.js`（spawn/流式/超时/杀进程树）。**停止必须杀子进程**（`taskkill /PID <child> /T /F`），杀主进程会把应用自己干掉 |
| 代码调试安全 | 页面必须保留「本机真实执行、不是沙箱」的提示；Java 需要 `javac`（JRE 不够） |

## 1.11.0：工具箱重构（改这里前先看）

| 项 | 约定 |
|---|---|
| 分组 | `Toolbox.tsx` 的 `TOOL_GROUPS`（5 组 20 个工具）。新增工具：加到某组 + 在 `renderTool()` 里加 case + 写组件 |
| 页签 | 容器 `.tool-tabs`（可换行卡片）+ 按钮 `.tab2`（回归脚本按文字点，**类名不要改**）；`role=tablist` + 方向键/Home/End 切换 |
| 状态保留 | `useToolState(key, initial)`（`components/toolbox/shell.tsx`，sessionStorage 按工具 id 分命名空间）。新工具一律用它，别用裸 `useState`，否则切页签就丢输入 |
| 结果复制/导出 | 工具调用 `useToolResult(text)`，外壳自动在页头出现「复制结果 / 导出」；**不要**再自己摆一组复制按钮 |
| 懒加载 | qrcode / js-yaml 相关工具走 `React.lazy`（C16）。新增重依赖工具也照此办理 |
| 跳转联动 | `useStore.openToolboxTool(tool, text)` → 工具箱切到该工具并带上文本（接口调试响应面板的「去 JSON 转化 / 去 JSON 对比 / 去 YAML」用的就是它） |
| 纯逻辑 | yaml / jwt / jsonDiff / idGen / sign / idCard / cron / timeParse / jsonPath / md5 都在 `src/utils/`，各有单测；页面只做展示 |
| 依赖注意 | 新增 `qrcode`、`js-yaml`；`tsconfig` 设了 `types: []`（渲染层不引 Node 类型），`@types/node` 不要去装（本机那份损坏会让 tsc 报 binary） |
| 回归 | `scripts/ui-round12-test.js` 覆盖 22 条（分组/键盘/状态保留/YAML/JSON对比/JWT/ID/SQL/时间轴/签名/二维码/时间戳单位/GBK/diff忽略空白/Cron反查/侧栏折叠/命令面板工具搜索） |

## 1.23.0：七项能力（改这里前先看）

| 能力 | 落点 | 关键约定 |
|---|---|---|
| 全局搜索补全 | `CommandPalette.tsx` + `utils/query.ts` | 新增 `@history` / `@code` 限定词；历史点进去只填方法/地址/状态 |
| 数据生成器回填 | `ipc-system.js` 的 `tdg:to-api` → `useStore.seedApiBody` | 主进程截断 500 条；**GET/HEAD 会改成 POST**，否则请求体框不渲染 |
| 附件集中管理 | `pages/Attachments.tsx` + `attachment:list/export` | `attachment:list` **只返回元数据**（全解密会撑爆渲染进程）；条目引用走 `useStore(s => s.entries)`，`ws:get` 读不到 |
| 导出 Markdown | `ipc-vault-io.js` 的 `buildPlainExport` | `format === "md"` 与 CSV/XLSX 共用拼装，两个 export 通道自动支持 |
| 汇总按提交人 | `utils/bugSummary.ts` 的 `creatorOf` / `creatorsToText` | 看创建人、含已关闭、**不套排除名单**（排除名单是给开发积压用的） |
| 笔记钉小窗 | `pin-window.js` + `PinApp.tsx` | `pin:open` 兼容 `id` 与 `{ id, kind }`；窗口 key 是 `${kind}:${id}` |
| WebSocket / SSE | `ipc-ws.js` + `ws-frame.js` + `ApiClient.tsx` | 帧编解码是纯函数（16 条单测锁 RFC 6455）；`clearCaches()` 里必须 `closeWsConnections()` |

- **`webPreferences.preload` 只认文件系统路径**：`nav-guard.js` 曾把 `file://` URL 赋进去，Electron 静默不执行 preload，表现为子应用 `window.electronAPI === undefined`。改 webview 后跑 `ui-round18`。
- 回归：`scripts/ui-round18-test.js`（33 条，六项功能）、`scripts/ui-round19-test.js`（19 条，WS/SSE，自带本地回声与 SSE 服务）。

## 1.14.0：缺陷管理两个列表页（「我的 Bug」「项目 Bug」）的修复

| 问题 | 根因 | 现在 |
|---|---|---|
| 点项目统计表「致命」列筛出空列表 | `onPickFatal` 把 `'1'`（严重程度）当状态传进了 `pStatus` | `jumpToProject(name, dim, sev)` 两个参数分开，`onPickFatal` 传 `('', '1')` |
| 复制只给 50 条 | `selected.size ? filter : list.slice(0, 50)` | 不勾选就复制「当前筛选后的全部」；失败/空列表也出提示，不再静默 return |
| 两个页签共用勾选 | `selected` 是页面级单一 state | 切页签 / 换视图 / 换项目时清空（`useEffect` 依赖 `[tab, mineScope, project, activeProject]`） |
| 「全部项目」是假开关 | 只改了标签，`loadMine` 仍然用 `ensureMineProjects()` 的选中 id | `loadMine(scope, ids, allOverride)`，全部时用 `projects.map(id)`；两个方向都重拉 |
| 「全部项目」与单项目数字不一致 | 单项目接口无缓存、全量接口 10 分钟缓存；且翻页上限 3 vs 5 | 两个接口统一 `10 分钟 TTL + force`，翻页都 5 页；单项目缓存只留最近 6 份 |
| 搜索后 `<select>` 显示空白 | 选项是 `filteredProjects`，当前项目被过滤掉了 | `selectProjects` 把当前项目补回选项首位 |
| 项目 Bug 没有模块维度 | 单项目接口不取模块名 | `zentao:project-bugs` 里并行取 `tree-ajaxGetOptionMenu`，表格加「模块」列 + 模块筛选（`pModule`） |
| 「我提交的」看不到派给谁 | `showAssignee={false}` 写死 | `showAssignee={mineScope !== 'assigned'}` |
| 创建日期列显示了截止日期 | `b.date \|\| b.deadline` | 只显示 `b.date` |

回归：`scripts/ui-round14-test.js`（15 条，需真实禅道；可用 `USE_PACKED=1` 跑打包版）。

## 1.13.0：缺陷管理「汇总」tab（改这里前先看）

多项目缺陷汇总：在「缺陷管理」里与「我提交的 / 项目 Bug」并列的第三个 tab，代码 `src/components/ZentaoSummary.tsx` + `src/utils/bugSummary.ts`。

### 统计口径（与历史日报脚本对齐，别自己发明）

| 指标 | 判定 |
|---|---|
| 缺陷总数 | 该项目全部 Bug，**含已关闭、含待验证** |
| 已修复 | `resolution === 'fixed'`（**不是** 看 `status`） |
| 未修复 | `status === 'active'` |
| 待验证 | `status === 'resolved'` |
| 已关闭 | `status === 'closed'` |
| 修复率 | 已修复 / 总数，保留 1 位小数；总数为 0 时给 0，不要除零 |

- 禅道里 `status=closed` 一般也带 `resolution=fixed`，所以「已修复 + 未修复 + 待验证 + 已关闭」不等于总数是正常的（已关闭会重复计一次），**不要为了凑数去改定义**。
- 落不进 active/resolved/closed 的状态（`postponed` 等）进 `other`，仍计入总数。

### 数据从哪来

| 事 | 走哪 |
|---|---|
| 拉多项目全量 Bug | IPC `zentao:summary(cfg, productIds, {force})`（`electron/main.js`）。REST `bugs?product=X&status=all&limit=1000` 逐页（最多 5 页），最多 4 个项目并发，按 `id` 去重 |
| 缓存 | `ztSummaryCache`，**10 分钟 TTL**；「强制刷新」按钮传 `force: true` 绕过 |
| 模块名 | REST **不返回模块名**，只有数字 `module` id。必须走 HTML 会话取 `tree-ajaxGetOptionMenu-<产品ID>-bug.html`（`ztFetchModuleNames`，需先 `ztEnsureLogin`）。失败时返回空表、不影响主流程，前端退化显示「模块<id>」/「未指定模块」 |
| 排除人员、模块聚合、复制文本 | **全部在渲染层**（`bugSummary.ts`）。改排除名单**即时重算，不重新拉数据** |

### 人员分布（「谁身上还挂着缺陷」）与「排除人员」

| 事 | 约定 |
|---|---|
| 统计对象 | **只看 `assignedTo`（当前指派人）**，不看 `openedBy`。用途是回答「哪个开发身上压了多少」 |
| 已关闭 | **不算**。禅道关闭后会把 `assignedTo` 清空（实测 910 条已关闭的全是空），所以它们既不挂在人身上，也不计入「未指派」 |
| 未指派 | 未关闭且 `assignedTo` 为空的，单独计数 |
| 等式 | `人员之和 + 未指派 + 已排除 = 总数 − 已关闭`（单测锁了这条） |
| 排除人员 | 按**指派人**匹配（不是提交人），且**只影响「按人员」这一块**——项目 / 模块 / 总数 / 修复率永远按全量算。用途就是把测试人员去掉，别让待验证的 Bug 堆在开发头上 |
| 文案 | `人员指派共 N 个：某某 X 个、……（未指派 a 个，已关闭 b 个不计，已排除 某某 名下 c 个）`，与 `zt_daily.py` 的 `人员分布（按当前指派，已剔除测试人员）共 N 个` 同义 |

> 口径来源：历史日报脚本的 `persons()`（脚本里有一份 `TESTERS` 账号白名单，把测试人员从人员分布里剔除）；它还有 `SECURITY`（安全工程师提交的单独统计），我们**没有**复刻，需要时再加。

### 1.13.x 追加：统计口径扩展与导出

| 项 | 约定 |
|---|---|
| 未关闭修复率 | `fixedOpen / open`，分子分母都在「未关闭」内（`closed` 同时从分子分母剔除）。点「修复率」卡片切换，不是两个卡片 |
| 时间窗 | `summarize({ since })` 按 **openedDate** 过滤（看「这批新缺陷现在修了多少」），选择值存 `sumSince`（0/7/30/90） |
| 近 7 天 | `recentNew` 按 openedDate、`recentFixed` 按 resolvedDate，窗口 = 含今天的 7 个自然日；`daysAgoDay(7)` 可注入 `now` 方便单测 |
| 严重程度 | 禅道 1 致命 / 2 严重 / 3 一般 / 4 轻微（`SEVERITY_LABELS`）。`summarize` 返回全局 `severity` 与每项目 `severity` |
| 时间字段 | REST 给的是 UTC（`2026-11-05T03:29:54Z`），主进程 `ztApiLocalTime` 统一转本地 `YYYY-MM-DD HH:mm`，**不要**再直接 slice(0,10)（跨零点会错一天） |
| 导出 | `summaryTo(format, ...)`：text / markdown / csv。CSV 带 BOM（Excel 中文不乱码）并转义逗号引号 |
| 快照 | `sumSnapshot` 存「上一次拉取」的六项数字，key = `排序后的项目id|时间窗天数`；**拉取后先算 delta 再覆盖**，否则永远显示 0 |

### ⚠️ 复制菜单会被面板裁掉

`.pnl { overflow: hidden }` 会裁掉面板内的绝对定位下拉。做法是 `.pnl:has(.zt-sum-menu) { overflow: visible }` —— 用 `:has()` 只对有菜单的那个面板放开，别改成全局 `overflow: visible`（圆角会露表格）。曾经试过 `position: fixed`，坐标对但被祖先层叠上下文吃掉了，不显示。

### 统计日（17:30 切分）与「今日新增」

- 需求方每天 **17:30** 出日报，所以「一天」不是自然日，而是**昨天 17:30 → 今天 17:30**，
  并且这一整天就记作**「今天」**（按窗口结束日命名）。切分点可在页面上改（`sumDayCutoff`，默认 `17:30`）。
- 纯函数都在 `bugSummary.ts`：`parseCutoff` / `statDayOf` / `shiftDay` / `dailyNew`，各有单测。
- `statDayOf` 的规则：时刻 **< 切分点** → 归到当天（还没到今天的 17:30，仍属「今天」这一天）；
  **>= 切分点** → 归到**次日**（今天的日报已经出完，之后的算明天那一天）。所以 11-06 00:10 属于「11-06」。
- 页面上把当前统计日的真实窗口印出来（`statWindowOf`）：`2026-11-04 17:30 → 2026-11-05 17:30`，
  避免「11-05 这一天到底是哪 24 小时」的歧义。
- 「今日新增」= 当前统计日（还没走完）的条数；环比对象是上一个**完整**统计日；
  昨天为 0 时 `pct` 给 `null`（不除零），UI 显示成 `+N` 不带百分比。
- 日均只算已走完的天数（不含今天），否则半天会把均值拉低。

### 日报口径（1.16 起，改统计前必看）

汇总页的统计已经从「几个独立卡片」改成**定时任务那套日报口径**，`src/utils/bugSummary.ts` 里对应这些纯函数：

| 函数 | 作用 |
|---|---|
| `periodOf(bugs, since, until)` | 区间内 新增 / 修复 / 关闭，左开右闭 `(since, until]` |
| `workdaysBetween(since, until)` | 区间内周一到周五的天数，最少按 1 算 |
| `growthOf(prevAt, prevTotal, curAt, curTotal)` | 总数环比：净增 / 增长% / 工作日 / 日均% |
| `splitSecurity(bugs, names)` | 把安全工程师提交的剔出来单独计数 |
| `dailyReportText(list, at)` | 生成和定时任务一致的那整段话 |

**⚠️ 与 `zt_daily.py` 有一处刻意不同**：脚本的本期窗口是「上次统计时刻 → 本次运行时刻」（滑动窗口），
我们是**固定窗口**（换日时间 17:30 → 次日 17:30）。原因是领导随时会点开看，如果窗口跟着运行时刻走，
同一天点两次会得到两个不同的「本期新增」，没法解释。所以：

- **本期窗口固定**：`statWindowOf(currentDay, cutoffMin)`，页面上直接印出来；
- **只有「较上次统计」的基准是历史快照**：`src/utils/sumHistory.ts` 存 localStorage（不是 zustand 的
  sessionStorage —— 关掉应用就没了，跨天就没法比）。取「上一个不同统计日的最近一条」，
  同一天重跑会覆盖当天那条，否则环比会退化成几小时。

**安全问题**（`sumSecurity`，按 `openedBy` 匹配）：这些条目不参与功能缺陷口径，
但会单独计数并在日报末尾补一句「另有安全问题 N 个…」。不配名单时整段不出现。

### 明细区是三个页签，别再写回竖排

`按项目 / 按人员 / 日报预览` 用一个面板里的页签切换（`.zt-detail-tab`），不再是三块面板竖排 ——
之前页面要滚三屏，领导看数字得一直往下拖。改回归时注意：`.zt-sum-prow` 只在「按人员」页签里，
`.zt-sum-row` 只在「按项目」里，断言前要切页签。

### ⚠️ 工具条类名是 `zt-sumbar-*`，不是 `zt-scope-*`

`zt-scope` 在本文件更早的地方（第 19.x 节，别的页面）已经有 `display: flex` 的定义，
曾经直接套用导致工具条和下面的「不计入人员表」并排显示、拉取按钮跑到右边。教训：新组件的类名前缀
先 grep 一遍再定。

### 排除人员 / 测试人员名单

- 两个概念不要混：
  - **不计入人员表**（`sumExclude`）= 真正生效的排除名单；
  - **测试人员**（`sumTesters`）= 本地标记的名单，点「排除测试人员」把它们并进 `sumExclude`。
- 以前「测试人员」只藏在选人弹窗里一个小小的「测试」标签里，用户根本找不到，
  点了灰色的「排除测试人员」没反应就以为坏了。现在名单在页面上单独一行展示（可点 × 取消），
  按钮也不再 disabled —— 名单为空时点它会直接打开选人弹窗并给出提示。

### 列表页工具栏（我的 Bug / 项目 Bug）

- **筛选控件在面板正文的 `.zt-filterbar`（独占一行），复制 / 导出在面板头的 `.zt-actions`（右上角）**。
  以前 8 个控件全塞在面板头同一行，窗口一窄就换行错乱。
- 「预设 / 存预设」已按需求移除（`ZentaoPreset` 类型还留着，暂时没人用）。

### 别改回去的几处

- **排除人员只作用于人员分布**。早期版本是「把这个人提交/名下的 Bug 从全部统计里剔掉」，一排除测试人员，缺陷总数和修复率就跟着变（970 → 947），跟日报对不上，已改掉。
- **选择与数据不一致要给提示**：`stale = dataIds.sort().join() !== productIds.sort().join()`。否则用户勾了新项目但没点「拉取并汇总」，看到的还是旧数字且毫无提示。
- **首次进入自动拉一次**（模块级 `autoPulledOnce`），但之后**不要**因为切 tab / 改排除名单自动重拉——那是 968 条 × N 个项目。
- **选中但 0 条的项目也要占一行**（`summarize` 先按 `productIds` 顺序建空行），否则用户会以为没选中。
- **模块之和必须等于项目总数**（单测里锁了这条），改聚合逻辑时别破坏。
- **「排除人员」不要影响本期新增/修复/关闭**：这三个量是客观事实（这个窗口里禅道发生了多少变动），跟着排除名单变就没法解释了。`periodOf` 用的是剔除安全问题后的全量，不是 `result`。
- **「全部恢复」按钮别删**：`sumExclude` 有内容时才会渲染，一次清空名单用；只留 chip 逐个点太慢。

### 回归

- `scripts/ui-round13-test.js`（**54 条**，需真实禅道）：接口可用性 → 模块名映射 → 连接配置 → tab 存在 → 项目多选 → 拉取 → 六项统计与接口口径逐一对齐 → 模块明细（模块和＝总数）→ 人员分布行（表内和＝「人员指派共 N 个」）→ 严重程度分布 → 修复率口径切换 → 时间窗（近 7 天 / 切回）→ 人员下钻（清单行数＝表内指派数）→ 选人弹窗排除（总数不变、人员表少一行、行内注明已排除）→ 今日新增卡片 / 统计日趋势柱 / 切分点改成 09:00 → 测试人员标记与一键排除 → 恢复 → 一键复制（日报格式：含总数、本期、模块分布、人员分布）/ Markdown 复制 → 单项目复制 → 多选两个项目（行和＝总计）。
- `src/utils/__tests__/bugSummary.test.ts`（**59 条**，纯逻辑，不需要禅道）：口径、分桶、模块退化、排除、人员分布与等式、未关闭口径、近 7 天、时间窗、严重程度、统计日切分与今日新增、**本期区间 / 工作日 / 总数环比 / 安全问题剔除 / 日报正文**、Markdown/CSV、复制文本。
- 截图脚本 `scripts/shots-summary.js`（产物 `_shots-summary/`，已 gitignore；第 6 张 `6-persons.png` 是滚到页面底部的按人员面板）。

