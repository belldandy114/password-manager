# Project Instructions

This file provides context for AI assistants working on this project.

## Project Type: Node.js + Electron

### Commands
- Install: `npm install`
- Test: `npm test`
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
- **Always test with:** `npm run build && npm start` — build the renderer then launch the electron app to verify UI + IPC integration

## Architecture

Electron desktop app (测试工具) integrating a password manager using AES-256-GCM encryption and a test data generator via webview. Three layers: Electron main process, preload bridge, and React renderer.

### Entry Points

- **Electron main process:** `electron/main.js` — app lifecycle, window creation, IPC handlers, vault/trash I/O, clipboard auto-clear, browser detection, import/export logic
- **Preload bridge:** `electron/preload.js` — `contextBridge.exposeInMainWorld('electronAPI', ...)` — typed IPC surface exposed to renderer
- **React root:** `src/main.tsx` — mounts `<App />` into DOM
- **App component:** `src/App.tsx` — auth state routing (Login vs Dashboard), auto-lock timer, keyboard shortcut handler, theme application

### Key Modules

- **`electron/main.js`** (~955 lines) — The core: encryption (PBKDF2 + AES-256-GCM), vault data storage (encrypted JSON), trash bin with 30-day retention, session management (in-memory decrypted vault), clipboard auto-clear, browser detection/launching, import (CSV/JSON/encrypted) and export (encrypted/plain) with xlsx support, settings persistence
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

## Windows 打包 / 启动排错（2026-10 排查结论，务必保留）

**症状**：双击 exe 无窗口、进程秒退；退出码 `2147483651`（`0x80000003 STATUS_BREAKPOINT`），
`--enable-logging` 无输出，`main.js` 第一行都执行不到 → 崩在 Chromium 沙箱初始化，**应用层代码无法拦截**。

**已确认的诱因：产物文件带「低完整性级别（Low Mandatory Level）」标签**

```powershell
icacls "release\win-unpacked\测试工具.exe"     # 出现 Mandatory Label\Low Mandatory Level 即命中
icacls "<目录>" /setintegritylevel (OI)(CI)Medium   # 修目录；已有文件加 /T
```

- 本项目位于 `E:\测试数据\test_cases\`，该层目录带有 Low IL 的 `(OI)(CI)` 继承标签，
  **在此树内构建出的 exe 会自动继承 Low IL，双击必闪退**。每次打包后都要抽查一次标签。
- 快速判别：给 exe 加 `--no-sandbox` 启动，能起来就说明是沙箱初始化问题（仅用于诊断，不要作为交付方式）。
- 已排除的因素：中文路径名、路径长度、Electron 版本、IFEO/漏洞利用保护、CSP/preload/IPC 代码。

**构建相关**

- `electron` 固定在 `37.10.3`（`devDependencies`）；打包时通过 `-c.electronDist=node_modules/electron/dist`
  复用本地运行时，避免联网下载。
- NSIS 阶段会下载 nsis/nsis-resources 资源，本机访问 GitHub 会超时；离线打包请设置
  `ELECTRON_BUILDER_CACHE=C:\Users\Administrator\AppData\Local\electron-builder\Cache`（本机已有完整缓存）。
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

- **单实例锁**：`app.requestSingleInstanceLock()`，第二个实例会直接退出并把已有窗口唤到前台。
  **不要移除**——两个实例各自持有解密后的 vault 副本，会互相覆盖导致数据丢失。
- **托盘**（`electron/main.js` 的 `createTray/hideToTray/showMainWindow`）：
  - 设置项 `minimizeToTray`（最小化时隐藏）、`closeToTray`（点 × 时隐藏）。
  - 任一开启时 `settings:save` 会立即创建托盘图标，全关则销毁（窗口可见时才销毁）。
  - 托盘菜单：显示主窗口 / 锁定（`webContents.send('lock-request')`）/ 退出（置 `isQuitting` 后 `app.quit()`）。
- ⚠️ **Windows 上 `minimize` 事件的 `preventDefault()` 拦不住系统最小化**，窗口会先进入
  iconic 状态再被 `hide()`。所以 `showMainWindow()` 必须 **先 `show()` 再 `restore()`**：
  窗口隐藏状态下 `isMinimized()` 会返回 false，先 restore 会被跳过，
  从托盘唤醒后会得到一个「任务栏最小化」的窗口。
- 全局快捷键 `Ctrl+Shift+P` 也走 `showMainWindow()`，不要重复实现恢复逻辑。

## 1.1.0 新增能力（改动时注意联动）

| 能力 | 实现位置 | 注意 |
|---|---|---|
| CSV/Excel/JSON 导入 | `main.js` `parseCsv` + `normalizeImportRecords` | 支持中英文表头（`IMPORT_FIELD_ALIASES`）；**新增字段必须同时加进别名表**，否则导出→导入会丢字段 |
| 密码生成器 | `password:generate`（crypto）+ `EntryForm` | 每类字符至少 1 个，Fisher–Yates 洗牌；不要换成 `Math.random` |
| 安全体检 | `src/utils/security.ts`（渲染层纯计算） | 弱密码规则见 `COMMON_WEAK` / `passwordStrength`，重复密码按明文分组 |
| 自动备份 | `main.js` `backupVaultOncePerDay` | 每天 1 份，保留 7 份，存 `userData/backups/vault-YYYY-MM-DD.enc`（本身仍是加密文件） |
| 登录限速 | `auth:verify` | 连续错 5 次 → 30s 冷却，返回 `retryAfterMs` 给 `Login.tsx` 倒计时 |
| 防截屏 | `settings:save` → `setContentProtection` | 创建窗口时也读一次设置 |
| 开机自启 | `settings:save` / `whenReady` → `setLoginItemSettings` | 仅 `app.isPackaged` 时生效 |
| 窗口状态 | `window-state.json` | 关闭显示器后坐标会被校验丢弃，避免窗口跑到屏幕外 |
| 主题跟随系统 | `src/utils/theme.ts` + `watchSystemTheme` | 保存的是 `dark/light/system`，`data-theme` 只写解析后的值 |
| 记住上次页面 | `settings.lastPage` | 锁定时会切回主页，用 `skipLastPageSaveRef` 避免把「主页」写回 |
| 列表增量渲染 | `Dashboard.tsx` `visibleLimit` | 每屏 120 条，滚动接近底部再追加；别改回一次性全量渲染 |

### 工程脚本

```bash
npm run typecheck       # tsc --noEmit（必须 0 错误）
npm run check:integrity # 校验产物没有被标成 Low IL（可加 -- --fix 自动修复）
npm run smoke           # 对 release/win-unpacked 跑端到端冒烟测试（临时 userData）
npm run dist            # 全量构建：renderer → 子应用 → --dir → NSIS → 完整性自检
```

`scripts/smoke-test.js` 用 `--remote-debugging-port` 连渲染进程，覆盖初始化/解锁/增删改查/回收站/设置/密码生成/锁定拒绝访问，
改动 IPC 契约时要同步更新它。

## 1.2.0：多模块扩展（改动前必读）

### 数据层
vault 从 `{ entries, tags }` 扩展为：

```js
{ entries, tags, history,
  snippets, notes, checklists, accounts, environments, apiRequests, integrations }
```

- `normalizeVault()` 在 `loadVault` 里补齐缺失字段，**旧密码库可直接打开**。
- 新增集合只加进 `VAULT_COLLECTIONS` 即可，渲染层用 `ws:get` / `ws:set` 读写（`src/hooks/useCollection.tsx`）。
- **不要**给这些模块新建第二个密码库或明文文件——所有数据都在这一个加密 vault 里。
- `history` 由 `entries:update` 自动维护（密码变更时留最近 10 条），不要手动写。

### 页面

| 页面 | 文件 | 说明 |
|---|---|---|
| 环境地址 | `pages/Environments.tsx` | 系统 × 环境矩阵，单元格点击编辑，空内容即删除 |
| 测试账号 | `pages/Accounts.tsx` | 按系统分组，可显示/复制密码 |
| 用例清单 | `pages/Checklists.tsx` | 勾选状态逐次落盘 |
| SQL 片段 | `pages/Snippets.tsx` | 等宽显示 + 一键复制 |
| 测试笔记 | `pages/Notes.tsx` | 极简 Markdown（先转义再渲染） |
| 禅道 | `pages/ZentaoPage.tsx` | 登录（PATH_INFO + md5(md5+rand) + verifyRand）→ 拉我的 Bug / 快捷入口 |
| 工具箱 | `pages/Toolbox.tsx` | 时间戳 / 编码 / 哈希&JWT / 正则 / Diff / 校验 |
| 接口调试 | `pages/ApiClient.tsx` | 主进程发请求（无 CORS），`{{变量}}` 替换 |

### 关键约束

- **hooks 必须在 `if (isLocked) return` 之前**：`App.tsx` 里锁定/解锁是同一个组件，
  提前 return 之后再写 `useState` 会导致 hooks 数量变化，触发 React error #310（整页白屏）。
  已踩过，新增 hook 请放在所有条件返回之前。
- **TOTP 算法**（`base32Decode` + `totpAt`）已用 RFC 6238 官方向量校验（94287082 / 287082），
  改动后请重新跑向量。
- **附件**用当前会话密钥加密存 `userData/attachments/<id>.enc`，单文件上限 20MB；
  vault 里只存元数据，删除附件要同时删文件。
- **导入别名表**（`IMPORT_FIELD_ALIASES`）已覆盖本应用导出、Chrome/Edge、Bitwarden、1Password；
  新增字段要同时补别名，否则导出→导入会丢值。
- **更新检查**只读 GitHub Releases 做版本比对，不自动下载安装（避免签名/发布链路依赖）。
- 测试数据子应用（webview）**保活**：`App.tsx` 用 `tdgMounted` + `display:none` 隐藏，绝不卸载；
  登录后空闲 3 秒预热。实测首次 ~1s、再次进入 ~2ms（不重新加载）。

### 禅道接入（20.6 实测，改动务必按此流程回归）

| 步骤 | 地址 | 要点 |
|---|---|---|
| 1 | `user-login.html` | 建会话，并从表单里取隐藏域 `referer`（如 `/zentao/`） |
| 2 | `user-refreshRandom.html` | 返回**纯文本**数字随机盐，不是 JSON（`JSON.parse` 会失败→rand 为空） |
| 3 | `POST user-login.html` | 字段：`account`、`password=md5(md5(明文)+rand)`、`verifyRand=rand`、`passwordStrength`、`referer`、`keepLogin`、`captcha` |

- **必须带 `X-Requested-With: XMLHttpRequest` 和 `Referer`**，否则服务端返回整页 HTML 而不是 JSON。
- **不要用 `index.php?m=user&f=login`**：本实例 `requestType=PATH_INFO`，该地址一律 302 到
  `user-login-L3plbnRhby8=.html`，body 为空 —— 这就是「登录失败（HTTP 302）」的根因。
- 响应：`{"result":"success","locate":"/zentao/#app=my"}` 或 `{"result":"fail","message":"..."}`。
- **Bug 列表**：`my-bug.html` 无权限（302 到 `user-deny-my-bug.html`），改用
  `my-work-bug.html`；分页复用页面里的模板
  `my-work-bug-assignedTo-0-id_desc-{recTotal}-{recPerPage}-{page}.html`（每页可设 100）。
- 表格数据在 `zui-create-dtable="..."` 属性里，**整体不是合法 JSON**（混了 JS 函数体），
  只能按括号配平截取 `"data":[...]` 再解析（`ztTableRows`）。
- 快捷入口用 `my-work-{bug,task,story,testtask,testcase,todo}.html`，`index.php?m=my&f=` 会 302。
- 我的账号实测：166 条 assignedTo Bug，18 个产品；字段 `productName` 直接可用。

### ⚠️ 绝对不要用 `<datalist>`（会导致程序原生崩溃）

`Environments` / `Accounts` 的弹窗曾用 `<input list="xxx"> + <datalist>` 做「系统名」联想。
实测：**输入框处于聚焦状态时，候选项（options）发生更新，Chromium 直接 0xC0000005 崩溃**，
整个程序瞬间退出、没有任何 JS 报错 —— 用户看到的现象就是「点保存没反应 / 添加内容无效」。

- 复现路径：打开弹窗（input `autoFocus`）→ 填系统名 + 地址 → 点保存 → `setItems` 让
  `systems` 变化 → datalist 重新渲染 → 崩溃。
- 对照实验：删掉 `<datalist>` 节点后再保存 → 一切正常、数据正常落盘。
- **替代方案**：用可点的快捷标签（`.suggest-row .chip`），功能等价、无崩溃风险。
  已在 `Environments.tsx` / `Accounts.tsx` 里改掉，别再改回 datalist。

### 排查 Electron 原生崩溃（无 JS 报错）的方法

1. `spawn(exe, ['--no-sandbox', '--remote-debugging-port=9xxx', '--user-data-dir=<临时>'])`
2. CDP 连上后 `Runtime.enable`，监听 `Runtime.exceptionThrown` / `Inspector.targetCrashed`，
   并监听子进程 `exit` 拿退出码（`3221225477 = 0xC0000005`）。
3. 用「变量替换法」逐步排除：把可疑 API 用桩替换（如 `window.electronAPI.wsSet = async () => ({success:true})`），
   或直接删掉可疑 DOM 节点再触发同样操作 —— 崩溃是否消失就是结论。
参考脚本：`scripts/ui-features-test.js`（CDP 驱动真实界面的回归测试）。

### 工作台页面状态：跨页面保留用 store，不要用 useState

侧边栏切页是 `switch` 直接换组件，旧组件会卸载 —— 页面里的 `useState` 全丢。
禅道这类「拉取一次、多处查看」的数据必须放 store：`src/store/zentaoStore.ts`
（数据 + 筛选条件都在里面，切页/切回来都还在）。

### 禅道 REST API（api.php/v1）—— 取「整个项目」的 Bug

网页端只给「我的 Bug」，全量要靠 REST（Zentao 18+ 内置）：
1. `POST {base}/api.php/v1/tokens`，body `{"account":"...","password":"..."}` → `{"token":"..."}`
2. 之后所有请求带 **`Token: <token>`** 头（不是 `Authorization: Bearer`，用错会 401）
3. `GET api.php/v1/products?limit=1000` → 产品（= 界面上的「项目」）列表
4. `GET api.php/v1/bugs?product=58&limit=1000&page=1` → `{total, bugs:[...]}`，>1000 条要翻页

- `assignedTo` / `openedBy` 是对象 `{account, realname}`，渲染前要取 `realname`。
- token 有有效期，主进程里缓存 token；遇到 401 强制换新 token 重试一次（`ztApiGet`）。
- 实测该实例：31 个产品、产品 58（资产管理系统-管理后台V2.0.0）共 271 条 Bug。
- 项目列表排序：把「我有 Bug 的项目」排前面，默认选中即可看到自己正在测的项目。

### 周报（本地 Markdown）约定

- 主进程只暴露 `weekly:list / read / save / rename / delete / pick-dir / reveal`，
  **所有路径都过 `weeklyResolve()` 做目录穿越校验**，只允许操作指定目录内的 .md/.markdown/.txt。
- 删除用 `shell.trashItem()`（进回收站可恢复），不要用 `fs.unlink`。
- 渲染用自写的 `utils/markdown.tsx`（周报语法固定：`**一、xxx**` / `1.` / `（1）` / 空行分段）。
- 页面回归脚本：`scripts/ui-round2-test.js`（用临时目录测新建/修改/删除，不动真实周报）。

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

- 「网址管理」页也接入了这套骨架（`PasswordManagerPage` 用 `Page/PageHead/tabs` + `.pm-shell/.pm-main`），
  这样左侧栏与工作台页面观感统一；改动该页时注意 `.pm-main > .content-area` 是它自己的滚动容器。
- 禅道统计卡用 `repeat(auto-fit, minmax(92px, 1fr))`，保证「全部 + 5 状态 + 4 严重度」10 张卡一行放得下。
- 视觉走查脚本：`node scripts/shots.js <输出目录> [dark|light]`（CDP 截图 7 个页面，1440×900）。

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

应用内「检查更新」读的是 `https://api.github.com/repos/belldandy114/password-manager/releases/latest`，
**只提交 git 是不够的**，必须发 Release 并挂上安装包，否则所有人的「检查更新」永远停在旧版本（之前停在 v1.0.2）。

```bash
npm run dist                                     # → release/测试工具 Setup 1.2.6.exe
cp "release/测试工具 Setup 1.2.6.exe" "release/PasswordManager-Setup-1.2.6.exe"
gh release create v1.2.6 "release/PasswordManager-Setup-1.2.6.exe" \
  --title "测试工具 v1.2.6" --notes-file notes.md --latest --target master
```

- ⚠️ **上传前必须改成英文文件名**：中文名会被 GitHub 改写（`测试工具 Setup 1.2.6.exe` → `Setup.1.2.6.exe`）。
- `release/` 在 `.gitignore` 里，exe 不进 git，只能通过 Release 附件分发。
- 发布后自检：`gh release view v1.2.6 --json assets`（state=uploaded、size 对得上）；
  `curl -s .../releases/latest | grep tag_name` 应为 `v1.2.6`。
- 应用端 `updateCheck()` 会返回 `{current, latest, hasUpdate, url, notes}`，`url` 指向 Release 页；
  安装包是 NSIS，`/S /currentuser` 可静默覆盖安装，密码库数据不受影响。

### 禅道 Bug 重现步骤里的截图（file-read-*.png 需要登录态）

页面里的 `<img src="/zentao/file-read-29218.png">` **不能在渲染层直接当 src 用** ——
渲染进程的 `<img>` 不会带禅道的 Cookie，只会显示裂图/空白，所以之前只能显示 `[图片]` 占位。

正确做法（已实现，`zentao:bug-detail` 内）：
1. 解析时把 `img src` 转绝对地址，按出现顺序去重，正文里用 `[图1] [图2]` 占位对应；
2. 主进程 `ztFetchBinary(cfg, url)` 带上 `ztCookieHeader()` 取二进制（跟随 302，单张上限 8MB）；
3. 转 `data:image/png;base64,...` 返回给渲染层，抽屉里直接 `<img src={dataUrl}>` 显示；
4. 最多取 12 张，失败数放进 `imageFailed` 提示用户去浏览器看原图。

验证脚本：`node scripts/ui-bug-image-test.js`（断言 steps 里有 `[图N]`、images 长度、`naturalWidth > 0`）。
实测 Bug #14171：2 张图均取回（1920×953），dataURL 约 210KB / 50KB。

### ⚠️ 应用内下载必须用 Electron `net`，不要用 Node `fetch`

Node 的 `fetch`（undici）**不读系统代理**，公司网络一拦，`update:download` 只会抛一句 `fetch failed`（信息量为零）。
改用 `net.request({ url, redirect: 'follow' })`（Chromium 网络栈）：跟随系统代理，能拿到 `HTTP 404` 这类真实原因。
实测本机直连 GitHub Release 附件：**9.2 秒 / 96 MB**，与附件字节数完全一致。

- 失败时的兜底顺序：`浏览器下载`（发布页）→ `选择本地安装包`（`update:pick-file`，dialog 选 exe，<10MB 拒绝）→ `加速镜像重试`（`ghfast.top` / `gh-proxy.com`，**必须用户手动点**，默认不代下 exe）。
- 安装**不要默认 `/S` 静默**：静默装的是默认目录，用户装到 `E:/password-manager` 会变成两份。
  默认走安装向导（`spawn(file, [])` + `app.quit()`）；静默才传 `['/S', '/D=<当前 exe 目录>']`。

### ⚠️ 发布时 CI 会覆盖 Release 说明（token 没有 workflow scope）

`.github/workflows/build.yml` 在打 tag 时会用 `softprops/action-gh-release` 建 Release，
body 是**写死的模板**，把我们 `gh release create --notes-file` 的说明覆盖掉（v1.2.6~v1.3.2 都中过），
还会额外上传一个中文名附件（被 GitHub 改名为 `Setup.1.3.2.exe`）。

- 本机 gh token 只有 `gist / read:org / repo`，**没有 `workflow`**，所以推不上去 workflow 的改动
  （`refusing to allow an OAuth App to create or update workflow ... without workflow scope`）。
  想根治得先 `gh auth refresh -h github.com -s workflow`（需浏览器授权）。
- 当前流程：发布后**等 CI 跑完**（`gh run watch <id>`，约 2 分钟）再
  `gh release edit <tag> --notes-file release-notes-<ver>.md` + `gh release delete-asset <tag> Setup.<ver>.exe`。
- 注意 `git checkout -- .github/workflows/build.yml` 恢复的是 **HEAD 版本（含改动）**，
  要还原成远程版本得 `git checkout origin/master -- .github/workflows/build.yml`。

### 时间显示：一律走 `src/utils/time.ts`

`iso.slice(11, 16)` 取的是 **UTC 小时**，北京时间会少 8 小时（禅道「· 03:20 拉取」其实是 11:20）。
用 `formatHm` / `formatDateTime` / `formatRecent`。

### 1.4.0 起的几个约定（改代码前先看）

| 能力 | 位置 | 约定 |
|---|---|---|
| 列表分页 | `components/Pager.tsx` | 数据量大就分页，**不要再用「只渲染前 N 行 + 提示缩小范围」**；筛选变化要把页码重置到 1 |
| 导出文件 | `file:save-text`（主进程） | 渲染层生成文本，主进程负责选路径 + 写 **UTF-8 BOM**（Excel 打开不乱码） |
| 断言 | `utils/apiAssert.ts` | 只断言填了的项；状态码支持 `2xx` 通配；`jsonPath` 留空值 = 只要求路径存在 |
| 全量 Bug 缓存 | `zentao:all-bugs` | 10 分钟 TTL，按 `baseUrl|account` 分键，`force=true` 绕过；返回带 `cached/ageMs` |
| 安全体检 | `components/SecurityAudit.tsx` | 纯前端统计，不改数据；点条目 → 回列表并设置搜索词 |
| 审计日志 | `DATA_DIR/audit.log`（JSONL） | **只记动作 + 条目名，绝不写密码内容**；超 512KB 自动截到最近 2000 条 |
| 自动备份 | `backupVaultOncePerDay()` | 解锁时也调一次；保留份数读 `settings.backupKeep`（1~60） |

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

### 1.5.0 起的几个约定（改代码前先看）

| 能力 | 位置 | 约定 |
|---|---|---|
| 请求体类型 | `ApiRequest.bodyType` | `json / form / multipart / raw / none`；`form`/`multipart` 正文按**每行 key=value** 写，`multipart` 的值以 `@` 开头=本地文件路径；`raw` 的 Content-Type 填在 `rawContentType`；**用户自己写了 Content-Type 头就不覆盖** |
| Cookie | `ApiRequest.headers` | 已取消独立 `cookies` 字段，统一写在请求头里（`Cookie: a=1; b=2`）；读取旧数据走 `migrateReq()` 自动合并 |
| 笔记目录 | `notes:*` IPC | 目录存 `localStorage['pm.notes.dir']`，为空=用加密库；文件名由标题生成（非法字符转 `_`、重名加 `-2`），删除走 `shell.trashItem`（可找回） |
| 目录类 IPC 安全 | `notesResolve` / `weeklyResolve` | **必须做目录穿越校验**：拼出的绝对路径必须仍在根目录内，否则报错 |

### ⚠️ 跑 UI 回归时的两个坑

1. **CDP 里 DevTools 自己也是一个 `type: 'page'` 的 target**，而且排在应用前面。
   只写 `list.find(t => t.type === 'page')` 会连到 DevTools 页面上（表现为 `document.body` 里全是 CSS 文本）。
   必须过滤：`!t.url.startsWith('devtools://')`。
2. **开发模式（`electron .`）窗口加载的是 `http://localhost:5173`**，本机 Electron 连不上 dev server
   （页面变成 `chrome-error://chromewebdata/`，curl 却是 200）。
   现在主进程支持 `PM_USE_DIST=1`：开发目录下也直接加载已构建的 `dist`，回归脚本不用先打包。

### ⚠️ electron-builder 下载超时时的应急办法

`npm run pack` 会去 GitHub 下 electron / winCodeSign，**公司网络下经常 `Timeout awaiting 'request'`**（10 分钟白等）。
winCodeSign、nsis 一般在 `~/AppData/Local/electron-builder/Cache` 里是齐的，缺的多半只是 electron。
此时可以**只重打 asar**，让已有的 `release/win-unpacked` 直接跑上新代码（exe 本体不需要变）：

```bash
npx asar extract release/win-unpacked/resources/app.asar _asar-tmp
cp -r dist/. _asar-tmp/dist/
cp electron/main.js electron/preload.js electron/preload-tdg.cjs _asar-tmp/electron/
# 记得同步 _asar-tmp/package.json 的 version
npx asar pack _asar-tmp release/win-unpacked/resources/app.asar
```

（要出安装包仍然必须让 electron-builder 完整跑通，asar 手工打包只能用于验证。）
