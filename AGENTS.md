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

AGENTS.md 有 65,536 B 预算，超出会被**静默截断**（2026-11-19 拆过一次，从 65 KB 降到 32 KB）。历史细节拆到 `docs/agents/`，这里只留必须遵守的约束：

| 文件 | 内容 |
|---|---|
| `docs/agents/history-1.x.md` | 1.1.0–1.7.2 能力清单、构建排错、禅道登录、崩溃排查 |
| `docs/agents/weekly-report.md` | 周报 + 从禅道自动成稿的全部规则（含 69 项回归） |
| `docs/agents/update-and-release.md` | 发布流程、应用内更新（`net`）、CI 覆盖 Release |
| `docs/agents/testing.md` | 页面拆包与回归脚本、单测、CI 门禁、CSS 级联死声明门禁、1.24.3 菜单合并/测试数据笔记、几何量断言 |
| `docs/agents/ipc-split.md` | `setupIpcHandlers` 拆分全过程与踩坑 |
| `docs/agents/perf-test.md` | JMeter 非 GUI 压测 |
| `docs/agents/visual-system.md` | 视觉体系 v2 的 token 与组件类名 |
| `docs/agents/window-tray.md` | 单实例锁、托盘、`showMainWindow()` 顺序、全局快捷键与 `applyHotkeys()` 回滚、搜索小窗 |
| `docs/agents/url-open.md` | 网址打开/复制入口、环境矩阵 v3 |
| `docs/agents/vault-modules.md` | 多模块扩展（1.2.0）：vault 结构、禅道登录三步 / REST、周报、视觉体系、`<datalist>` 崩溃、会话分桶 |
| `docs/agents/zentao-summary.md` | 缺陷管理「汇总」tab（1.13~1.16）：统计口径、日报、导出、快照、回归清单 |
| `docs/agents/release-tools.md` | 发布 / 排障基础设施（1.9.x）：release / check / regress、日志落盘、cURL 导入预览、字段提取 |
| `docs/agents/code-conventions.md` | 纯函数下沉、恢复自检、`callIpc`、依赖卫生、接口侧栏类名 |
| `docs/agents/version-conventions.md` | 1.6.0~1.6.1：原子写盘、损坏自愈、备份恢复、数据目录迁移、会话 Cookie 罐 |
| `README.md` | 新人/新 AI 第一站：目录地图、命令耗时、改什么跑什么、常见坑 |

**新增内容优先写进对应主题文件**；只有「每次改代码都必须遵守」的约束才写进 AGENTS.md。

## Architecture

Electron desktop app (测试工具) integrating a password manager using AES-256-GCM encryption and a native React test-data generator. Three layers: Electron main process, preload bridge, and React renderer.

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


## 多模块扩展（1.2.0 ~ 1.8.x，细节见 `docs/agents/vault-modules.md`）

**仍然必须遵守的 4 条**：
- vault 结构 = `{ entries, tags, history, snippets, notes, checklists, accounts, environments, apiRequests, integrations }`；
  新增集合只加进 `VAULT_COLLECTIONS`，渲染层用 `ws:get` / `ws:set`（`useCollection`），**不要**另建密码库或明文文件。
- ⚠️ **绝对不要用 `<datalist>`**：输入框聚焦时候选项更新会让 Chromium 直接崩溃（`0xC0000005`，无 JS 报错），用可点标签代替。
- 禅道会话必须**按实例分桶**（`ztCookieJars` / `ztApiTokens` 是 Map），不要回到全局单例，否则跨公司拉数据会串号 401。
- 禅道 REST 查全量 Bug 必须带 `status=all`（默认只返回未关闭）。

## 1.6.0 / 1.6.1 的约定（细节见 `docs/agents/version-conventions.md`）

- **原子写盘**：`writeFileAtomic`（临时文件 → fsync → rename + `.bak`），vault / trash 落盘必须走它；损坏时 `readEncryptedWithBak` 回退 `.bak`。
- **数据目录迁移**：`data:migrate` / `data:reset-location` 只复制不删除，`resolveDataDir()` 是唯一入口。
- **备份恢复**：`backup:restore` 先做 `pre-restore` 快照（保留 5 份）。
- 结构快照 / 断言规则行 / 会话 Cookie 罐 / 禅道多套配置 / 未读红点的存放位置见文档。
- 周次下拉 `weekOptions()` 的 **offset = 几周前**（0=本周），别写成 `-i`。
- 设置页骨架是 `.set-shell / .set-rail / .set-nav`；周报正文框 `.wk-editor` 定高 + 子项 `min-height: 0`。

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


## 纯函数下沉与调用约定（1.7.3 ~ 1.8，细节见 `docs/agents/code-conventions.md`）

- 新增/修改纯逻辑：先抽 `electron/<module>.js` + `electron/<module>.d.ts`，再写 `src/utils/__tests__/<module>.test.ts`。
- 常量只留一份定义（`ALGO` / `SALT_LENGTH` / `IV_LENGTH` / `TAG_LENGTH` 在 `vault-file.js`）。
- `backup:restore` 覆盖主库前必须先 `inspectVaultFile()` 做结构自检，不合格一行都不动。
- 渲染层 IPC 一律走 `callIpc`；**写盘 / 导出 / 设置保存这三类必须判错**。
- 测试里不要用 `Buffer`（tsconfig 没有 node 类型）。

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


## 发布与排障基础设施（1.9.x，细节见 `docs/agents/release-tools.md`）

- `npm run release -- <ver>`：升版本 → 构建（含门禁）→ 打包版回归 → 英文资产名 → 推送 → 建 Release → 等 CI → 核对附件与 latest。
- `npm run check` / `npm run regress -- --pack` / `npm run install:local` / `npm run check:ipc` 四条常用命令的分工见文档。
- 发布说明**必须人写**（`release-notes-<ver>.md` 已 gitignore）；`release/` 也在 ignore 里。
- 主进程日志落盘：`<数据目录>/logs/app.log`（`electron/app-log.js`），`require` 必须在 `installFileLogging()` **之前**，否则启动即崩（TDZ）。

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
| 数据生成器回填 | `DataGenerator.tsx` → `useStore.seedApiBody` → `ApiClient.tsx` | 页面内截断 500 条；**GET/HEAD 会改成 POST**，否则请求体框不渲染 |
| 附件集中管理 | `pages/Attachments.tsx` + `attachment:list/export` | `attachment:list` **只返回元数据**（全解密会撑爆渲染进程）；条目引用走 `useStore(s => s.entries)`，`ws:get` 读不到 |
| 导出 Markdown | `ipc-vault-io.js` 的 `buildPlainExport` | `format === "md"` 与 CSV/XLSX 共用拼装，两个 export 通道自动支持 |
| 汇总按提交人 | `utils/bugSummary.ts` 的 `creatorOf` / `creatorsToText` | 看创建人、含已关闭、**不套排除名单**（排除名单是给开发积压用的） |
| 笔记钉小窗 | `pin-window.js` + `PinApp.tsx` | `pin:open` 兼容 `id` 与 `{ id, kind }`；窗口 key 是 `${kind}:${id}` |
| WebSocket / SSE | `ipc-ws.js` + `ws-frame.js` + `ApiClient.tsx` | 帧编解码是纯函数（16 条单测锁 RFC 6455）；`clearCaches()` 里必须 `closeWsConnections()` |

- **历史坑（1.24.2 已随子应用移除）**：`webPreferences.preload` 只认文件系统路径，
  `nav-guard.js` 曾把 `file://` URL 赋进去，Electron 静默不执行 preload，表现为子应用
  `window.electronAPI === undefined`。现在没有 webview preload，回归脚本 `ui-round18` 改测主窗口页面。
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


## 缺陷管理「汇总」tab（1.13 ~ 1.16，细节见 `docs/agents/zentao-summary.md`）

**改统计口径前必须记住的几条**：
- 已修复 = `resolution === 'fixed'`（**不是**看 `status`）；已关闭一般也带 `resolution=fixed`，重复计一次是正常的，不要为了凑数改定义。
- 排除人员**只影响人员分布**；本期新增 / 修复 / 关闭是客观事实，不随排除名单变。
- 统计日按 **17:30** 切分（`statDayOf`），一天 = 昨天 17:30 → 今天 17:30；本期窗口是固定的，只有「较上次统计」的基准来自快照。
- 模块之和必须等于项目总数（单测锁了这条）；选中但 0 条的项目也要占一行。

## 1.24.3：菜单合并 / 测试数据（改这里前先看）

完整笔记已搬到 `docs/agents/testing.md` 的同名章节（原文未改）：SQL 片段并入笔记的迁移标记、
17 类数据唯一清单 `tdg/catalog.ts`、后 N 位整列渲染、手机号段缺省回退、
`REGEX_PRESETS` 不能用 lookahead。**AGENTS.md 有 65,536 B 预算，超出的尾部会被静默截断；
新增内容请写进 `docs/agents/` 的对应主题文件，这里只留摘要与指针。**


