# 测试中台（password-manager）

Windows 桌面端测试工作台：加密密码库 + 测试数据生成 + 接口调试 + 缺陷管理 + 周报 + 压测 + 工具箱。
Electron 主进程 + preload 桥 + React 渲染层，数据全部落在本地加密库（AES-256-GCM）。

> **这份文档是给「接手的人 / AI」看的入口。**
> 目标：改一个小样式不用跑两小时回归 —— 见 [§5 改什么跑什么](#5-改什么跑什么回归分层)。
> 历史细节在 `docs/agents/`，`AGENTS.md` 只留「每次改代码都必须遵守」的硬约束。

| 项 | 值 |
|---|---|
| 版本 | 1.22.0（`package.json`） |
| 运行时 | Node 22.22.0 / Electron 37.10.3 |
| 前端 | React 19.2.6 + TypeScript 6.0.3 + Vite 8.0.14 + Zustand 5.0.13 |
| 测试 | Vitest 5.0.5（63 文件 / 808 条） |
| 打包 | electron-builder 26.x → NSIS，`productName: 测试中台` |
| 仓库 | `github.com/belldandy114/password-manager`（公开，**禁止提交真实姓名/账号/内网地址**） |

---

## 0. 30 秒上手

```powershell
npm ci                      # 依赖
npm run dev                 # Vite 5173 + Electron 同时起
```

改完代码，**最小验证**（约 50 秒，覆盖 90% 的小改动）：

```powershell
npm run check               # 隐私 + tsc + 单测 + IPC 契约 + CSS + 静态债
npx vite build; npm run pack:asar   # 让打包版跟上（约 7 秒）
node scripts/ui-round12-test.js     # 只跑你改的那一块（工具箱）
```

---

## 1. 这个项目是什么

13 个页面（侧栏顺序；另有底部「设置」`settings`，5 个 tab：安全 / 通用 / 浏览器 / 快捷键 / 定时任务）：

| 页面 | 路由 key | 说明 |
|---|---|---|
| 网址管理 | `passwordManager` | 密码库主体，含子页 `dashboard / trash / import / export` |
| 测试账号 | `accounts` | 系统 / 角色 / 环境 / 账号密码表格，支持批量导入 |
| 环境矩阵 | `environments` | 环境地址清单 + 一键巡检（并发探活）+ 巡检历史 |
| 周报 | `weeklyReport` | 本地 Markdown 周报，可从禅道自动成稿 |
| 测试笔记 | `notes` | 双模式：本地目录 Markdown / 加密库笔记；支持 Ctrl+V 粘图、钉成桌面小窗。1.24.3 起 SQL 片段并入此页（`kind: 'sql'`），旧 `snippets` 集合保留作兜底 |
| 附件管理 | `attachments` | 全库附件集中查看：缩略图、引用者、未引用清理、导出到本地 |
| 缺陷管理 | `zentao` | 禅道 Bug 拉取、统计汇总、日报口径 |
| 测试数据 | `dataGenerator` | 主应用内原生 React 页面，生成规则在 `src/utils/tdg/`（身份证校验位、Luhn、车牌等）；目录清单见 `utils/tdg/catalog.ts`，Ctrl+K / Ctrl+空格 可用 `@data`、`data:身份证` 直达某类 |
| 工具箱 | `toolbox` | 21 个纯前端小工具（见 §3.4） |
| 接口调试 | `apiClient` | 类 Postman：环境变量、历史、断言、结构快照、WebSocket / SSE 长连接 |
| 压力测试 | `perfTest` | JMeter 非 GUI 封装 |
| 代码调试 | `codeLab` | 跑 JS/Python/Java 片段，HTML 预览走 `codelab://` 协议 |

另有三个**独立窗口**（同一个产物，靠 `?window=` 分流）：

| 窗口 | query | 入口 |
|---|---|---|
| 命令面板 | `?window=palette` | `Ctrl+Space` |
| 随手记 | `?window=quicknote` | `Ctrl+Shift+N` |
| 钉住的条目 | `?window=pin` | 卡片上的图钉 |

---

## 2. 目录地图

```
electron/            主进程（65 个文件）
  main.js            1,722 行：生命周期 / 窗口 / 托盘 / 快捷键 / 加密 / vault 落盘 / 备份审计
  preload.js         309 行：contextBridge 暴露 electronAPI（164 个方法）
  ipc-*.js           16 个 IPC 域模块（见 §3.2）—— main.js 里已无 ipcMain.handle
  *.js + .d.ts       24 个纯逻辑模块（22 个带 .d.ts；csv / vault-schema / url-open / text-encoding …）

src/
  main.tsx           入口：按 ?window= 分流 + 挂 ErrorBoundary + 异步加载拼音字典
  App.tsx            登录态路由、自动锁定、主题应用、页面 switch
  pages/             18 个页面组件（ApiClient / Settings / ZentaoPage / Toolbox 最大）
  components/        29 个通用组件（ui.tsx 是设计系统入口）
  store/             useStore（主状态）/ zentaoStore / envProbeStore / idbStorage
  utils/             44 个纯函数模块（每个都有 __tests__ 对应）
  styles/            tokens → global → pages → redesign（顺序不能变，见 §6.3）
  types.ts           1,051 行，ElectronAPI 全量契约

scripts/             约 80 个：质量门禁、UI 回归、打包、发布、截图
docs/agents/         12 个主题文档（AGENTS.md 拆出来的历史细节）
```

**构建产物（不要手改）**：`dist/`（渲染层）、`release/`（打包）、`run/`（`npm run try` 的运行副本）。

---

## 3. 架构

### 3.1 三层

```
渲染层 React  ──window.electronAPI.*──▶  preload.js  ──ipcRenderer.invoke──▶  主进程 ipc-*.js
   src/                                  contextBridge                         electron/
```

- **渲染层永远不直接 require electron**，只通过 `window.electronAPI`。
- 统一用 `callIpc()`（`src/utils/ipc.ts`）包一层：返回 `{ok, data, error}`，只有 `success === false` / 抛异常 / 空值算失败，`canceled: true` 算成功。
- 主进程返回约定：`{ success: true, data }` 或 `{ success: false, error }`。

### 3.2 IPC 域模块（16 个）

| 模块 | 负责的 channel 前缀 |
|---|---|
| `ipc-shell.js` | `app:` `palette:` `quicknote:` `log:` `update:check` |
| `ipc-auth.js` | `auth:`（主密码、安全词、改密、重置） |
| `ipc-entries.js` | `session:` `entries:` `trash:` `clipboard:` `settings:` |
| `ipc-data.js` | `data:` `backup:` `audit:` |
| `ipc-update.js` | `update:download/pick-file/install` |
| `ipc-api.js` | `api:` `history:` `attachment:` `file:pick` `file:save-text` `file:read-text` |
| `ipc-ws.js` | `ws:` `sse:`（WebSocket / SSE 长连接，锁定时全部断开） |
| `ipc-zentao.js` | `zentao:`（13 个，最大的一块） |
| `ipc-vault-io.js` | `import:` `export:` |
| `ipc-files.js` | `weekly:` `notes:` |
| `ipc-system.js` | `dialog:` `fs:` `system:` |
| `ipc-tools.js` | 密码生成 / TOTP |
| `ipc-browser.js` | 浏览器检测与启动 |
| `ipc-jmeter.js` | `jmeter:` |
| `ipc-codelab.js` | `codelab:` |
| `ipc-env.js` | `env:probe` `env:open` |
| `ipc-attach.js` | `attachment:save-image` `attachment:read-image` `attachment:list` `attachment:export` |

**新增 IPC 的完整动作**（漏一步就是「点了没反应」）：

1. 在对应 `electron/ipc-*.js` 里 `ipcMain.handle('x:y', ...)`；
2. `electron/preload.js` 加 `xY: (a) => ipcRenderer.invoke('x:y', a)`；
3. `src/types.ts` 的 `ElectronAPI` 加同名签名；
4. `npm run check:ipc` —— 它会比对三处是否一致（当前 151 handler / 146 调用 / 164 暴露 / 164 声明）。

### 3.3 数据模型

一个加密库 = 一个 `vault.enc`，解密后是：

```js
{
  schemaVersion: 2,
  entries: [],   // PasswordEntry[]：网址管理主体
  tags: [],      // string[]
  history: {},   // 条目历史版本
  snippets, notes, checklists, accounts, environments,
  apiRequests, integrations, ztPresets, apiEnvs, apiHistory, codeSnippets
}
```

- 集合清单在 `electron/vault-schema.js` 的 `VAULT_COLLECTIONS`，**加集合必须同时改这里**，否则 `normalizeVault` 会把它当未知字段丢掉。
- 迁移表 `MIGRATIONS`：只做结构搬移和补字段，**绝不删用户数据**；库版本比当前新时保留未知字段（否则降级打开一次就抹掉新版本数据）。
- 渲染层读写集合用 `useCollection<T>('notes')`（`src/hooks/useCollection.tsx`），底层是 `wsGet/wsSet`。

磁盘布局（`DATA_DIR` 可由用户在设置里改，默认 `%APPDATA%\测试中台`）：

```
vault.enc          加密库
backups/           每日备份
attachments/       附件与截图（<uuid>.enc，同样用会话密钥加密）
audit.log          审计日志
data-location.json 数据目录指针（在 userData 下，不在 DATA_DIR 里）
```

### 3.4 工具箱 21 个工具

`timestamp timeline timezone cron encode hash sign jwt aes regex regexExtract diff jsonRepair jsonDiff yaml urlParams sql idGen validate media redact`

- 外壳在 `src/pages/Toolbox.tsx`（`.tb-rail` 左栏 + `.tb-main` 右工作区），每个工具是 `src/components/toolbox/*.tsx`。
- 纯逻辑一律放 `src/utils/*.ts` 并配单测；组件只做 UI 与状态。
- 工具状态用 `useToolState(key, initial)`（sessionStorage，命名空间 `pm.toolbox.<toolId>.<key>`）。
- 工具头「复制结果 / 导出」由 `useToolResult(text)` 驱动（120ms 防抖），**不要自己写按钮**。
- 新增工具要同步三处：`TOOL_GROUPS`、`ToolId` 联合类型、`CommandPalette.tsx` 的 `TOOLBOX_TOOLS`。

### 3.5 常见改动落在哪个文件（先查这张表，别全仓 grep）

| 想改的东西 | 文件 |
|---|---|
| 侧栏导航项 / 分组 / 折叠 | `src/components/Sidebar.tsx`（`GROUPS`） |
| 页面路由（加页面） | `src/App.tsx` 的 `switch (currentPage)` + `src/components/Sidebar.tsx` 的 `GROUPS` + `src/components/CommandPalette.tsx` 的 `PAGES_MORE`（`currentPage` 是普通 string，没有联合类型约束） |
| 全局设计 token（颜色/圆角/阴影） | `src/styles/tokens.css` |
| 按钮 / 输入框 / 面板 / 表格外观 | `src/styles/global.css`（基础）+ `src/styles/pages.css`（页面级，按编号分节） |
| 视觉体系 v2 覆盖（后加载胜出） | `src/styles/redesign.css` 末尾 |
| 通用组件（PageHead / Panel / Pill / IconBtn / SearchBox） | `src/components/ui.tsx` |
| 主进程窗口 / 托盘 / 快捷键 | `electron/main.js`（+ `docs/agents/window-tray.md`） |
| 某个 IPC 的行为 | 对应 `electron/ipc-*.js`（见 §3.2） |
| 加密 / vault 结构 / 迁移 | `electron/main.js`（加解密）+ `electron/vault-schema.js`（集合与迁移） |
| 禅道拉取与解析 | `electron/ipc-zentao.js` + `electron/zentao-parse.js` + `electron/zentao-filter.js` |
| 缺陷统计口径 / 日报文本 | `src/utils/bugSummary.ts`（59 条单测锁口径） |
| 接口调试请求/响应处理 | `src/pages/ApiClient.tsx` + `src/utils/api*.ts` |
| WebSocket / SSE 长连接 | `electron/ipc-ws.js` + `electron/ws-frame.js`（RFC 6455 纯函数，16 条单测） |
| 工具箱某个工具 | `src/components/toolbox/<X>Tool.tsx` + `src/utils/<x>.ts` |
| 命令面板条目 | `src/components/CommandPalette.tsx`（`PAGES` / `PAGES_MORE` / `TOOLBOX_TOOLS`） |
| 全局状态 | `src/store/useStore.ts`（主）/ `zentaoStore.ts` / `envProbeStore.ts` |
| 回归脚本 | `scripts/ui-round<N>-test.js`（改 UI 时同步改断言） |

---

## 4. 命令清单（实测耗时，本机 2026-11-12）

> 标 **粗体** 的是实测值；带 `~` 的是估算（没逐条掐表），只用来判断量级。

### 4.1 开发

| 命令 | 作用 | 耗时 |
|---|---|---|
| `npm run dev` | Vite + Electron 一起起 | ~5s |
| `npm run dev:renderer` | 只起 Vite（5173） | ~1s |
| `npm start` | 直接跑 `electron .`（需先 build） | ~2s |

### 4.2 质量门禁

| 命令 | 内容 | 耗时 |
|---|---|---|
| `npm run check` | 隐私 → tsc → vitest → IPC 契约 → CSS 重复 → 静态债 | **16s** |
| `npx tsc --noEmit` | 类型 | 12.6s |
| `npx vitest run` | 63 文件 / 808 条 | 18.8s |
| `npx vitest run src/utils/__tests__/redact.test.ts` | 单文件 | 2–4s |
| `npm run check:ipc` | IPC 三处一致性 | ~0.2s |
| `npm run check:privacy` | 真实姓名/账号/内网 IP 扫描 | ~0.3s |
| `npm run check:debt` | `!important` 64 / 色值 207 / eslint-disable 15 三项预算 | ~0.2s |

### 4.3 构建与打包

| 命令 | 作用 | 耗时 |
|---|---|---|
| `npx vite build` | 渲染层 → `dist/` | **5.3s** |
| `npm run pack:asar` | 把 `dist` + `electron` + 依赖闭包塞进 `release/win-unpacked/resources/app.asar` | **1.9s** |
| `npm run repack` | electron-builder 打到临时目录再 robocopy 覆盖回 `release/win-unpacked` | ~60s |
| `npm run dist` | 完整安装包（含门禁 + NSIS） | 3–6 min |
| `npm run try` | 复制到 `run/` 再启动（避开 asar 文件锁） | ~3s |

> **日常验证用 `vite build` + `pack:asar` 就够了**（7 秒），不要每次 `npm run dist`。

### 4.4 UI 回归（打包版，CDP 驱动真实界面）

| 脚本 | 覆盖 | 耗时 |
|---|---|---|
| `smoke-test.js` | 初始化→解锁→增删改查→回收站→设置→锁定 | 4.0s |
| `ui-round10-test.js` | JMeter 压测（假 jmeter） | 8.5s |
| `ui-round3-test.js` | 网址管理 + 禅道全部项目 | 13.1s |
| `ui-palette-cache-test.js` | 搜索小窗缓存 / epoch / 锁定 | 13.3s |
| `ui-startup-test.js` | 启动期 | 16.4s |
| `ui-round8-test.js` | 周报下拉 / 设置页布局 / 接口调试分区（几何量断言） | 17.9s |
| `ui-round2-test.js` | 周报 CRUD / 禅道两 tab / 工具箱 / 接口调试 | 21.6s |
| `ui-round15-test.js` | 随手记小窗 / 环境矩阵 / 图片附件 / 快捷键 | 22.7s |
| `ui-round12-test.js` | **工具箱 21 个工具** | 24.5s |
| `ui-round16-test.js` | 可访问性 / 焦点陷阱 / 拼音 / 逐页 console error | 30.1s |
| `ui-round5-test.js` | 分页 / 导出 / 缓存 / 断言 / 体检 / 审计 | 32.6s |
| `ui-round4-test.js` | Bug 抽屉 / 筛选预设 / 周报草稿 / 环境历史 / 命令面板 | 37.5s |
| `ui-round6-test.js` | 接口调试（历史 / Cookie / 请求体） | 41.7s |
| `ui-round17-test.js` | 定时任务 / 库自检 / 片段库 / 变量提取 / 钉小窗 | 41.8s |
| `ui-round7-test.js` | 数据安全（原子写 / 备份恢复 / 数据目录） | 42.4s |
| `ui-round11-test.js` | 禅道指派 / 项目集 / 代码调试运行时 | 42.7s |
| `ui-round9-test.js` | cURL 互转 / 禅道三视图 / 备份异地 / 下载 | 92.6s |
| `ui-round18-test.js` | 全局搜索补全 / 附件管理 / 导出 Markdown / 按提交人 / 笔记钉小窗 / 数据回填 | 未实测 |
| `ui-round19-test.js` | 接口调试 WebSocket / SSE（自带本地回声与 SSE 服务） | 未实测 |
| `ui-round13/14-test.js` | 缺陷管理汇总 / 两个列表页 | **需真实禅道**，未配 `ZT_*` 时 0.1s 跳过 |
| `verify-packaged-csv.js` | 打包后 CSV 导出 | 1.9s |

**全量 UI ≈ 8.5 分钟**（不含 r13/r14）。这就是「两小时」的来源：全量 + 反复 repack + 排查。

---

## 5. 改什么跑什么（回归分层）

**核心原则：先跑最便宜的那层，只有它证明不了才往上加。**

| 你改了什么 | 必跑（分钟级以内） | 可选 |
|---|---|---|
| 纯函数（`src/utils/*.ts`） | `npx vitest run <对应测试文件>` | `npm run check` |
| 新增/改单测 | 同上 | — |
| 单个页面/组件的 JSX 或样式 | `npx vite build` + `npm run pack:asar` + 对应 `ui-roundN` | `ui-round16`（逐页 console error） |
| 工具箱某个工具 | `ui-round12`（24s） | `ui-round16` |
| 接口调试 | `ui-round6`（42s）+ `ui-round7`（42s） | `ui-round8`（分区样式）、`ui-round19`（WS/SSE） |
| 缺陷管理 / 周报 | `ui-round2` + `ui-round11`（禅道走本地桩） | `ui-round13/14`（需真实禅道） |
| 环境矩阵 / 随手记 / 附件 | `ui-round15`（23s）+ `ui-round18`（附件管理） | `ui-round17` |
| 主进程 IPC / vault / 加密 | `npm run check` + `smoke-test`（4s）+ `ui-round7`（42s） | `ui-round9`（92s，含下载） |
| 全局 CSS（`tokens/global/pages/redesign`） | `npm run check`（含 CSS 重复 + 静态债）+ `ui-round8` + `ui-round16` | 全量 UI |
| 打包配置 / 依赖 | `npm run dist` + `smoke` + `verify-packaged-csv` | 全量 UI |
| 发版前 | `npm run check` + 全量 UI + `npm run dist` | — |

**几条硬规矩：**

- **改样式不要只截图看「还行」** —— 用几何量断言（`getBoundingClientRect` / `computedStyle` / `scrollWidth`），`ui-round8` 就是这么写的。
- **UI 回归跑的是打包版**（`release/win-unpacked`）。改完代码必须 `vite build` + `pack:asar`，否则测的是旧包 —— 这是最常见的「改了没生效」。
- 部分脚本支持 `PM_USE_DIST=1` 直接跑源码（`node_modules/electron/dist/electron.exe .`），省一次 pack：`ui-round6/7/8/9/10/13/14/17`、`ui-digest`、`ui-palette-cache`、`ui-startup`。其余脚本（r2/3/4/5/11/12/15/16、smoke）**只认打包版**，改完必须 `pack:asar`。
- 跑之前**先结束所有 `测试中台.exe` 进程**：残留实例会占全局热键（`Ctrl+Shift+P` / `Ctrl+Shift+N`），导致 `ui-round15` 的快捷键断言假失败。
- 每个脚本都用临时 `--user-data-dir`，**不会碰你真实的密码库**。

### 5.1 三个常用配方（直接抄）

**A. 只改了一个工具的样式 / 文案**（约 40 秒）

```powershell
Get-Process -Name "测试中台" -ErrorAction SilentlyContinue | Stop-Process -Force
npx vite build; npm run pack:asar
node scripts/ui-round12-test.js        # 24s，21 个工具全过一遍
```

**B. 改了全局 CSS / 设计 token**（约 1 分钟）

```powershell
npm run check                          # 16s，含 CSS 重复 + 静态债预算
npx vite build; npm run pack:asar
node scripts/ui-round8-test.js         # 18s，几何量断言
node scripts/ui-round16-test.js        # 30s，逐页 console error
```

**C. 改了主进程 IPC / vault**（约 1 分钟）

```powershell
npm run check                          # 含 IPC 契约三方对齐
npx vite build; npm run pack:asar
node scripts/smoke-test.js             # 4s，解锁→增删改查→锁定
node scripts/ui-round7-test.js         # 42s，原子写 / 备份恢复 / 数据目录
```

> 只有**发版前**才需要全量（`npm run regress -- --pack`，静态门禁 + 9 项打包版回归，约 3 分钟；再加 r2–r17 全量 UI 约 8.5 分钟）。日常改动跑上面任一条就够 —— 剩下的时间花在「看清楚改了什么」上，比多跑 8 分钟回归有用。

### 5.2 怀疑某个具体现象时：写一次性探针，别跑全量

「某个下拉框文字压住箭头」「某页上传后乱码」这类问题，跑 8 分钟回归也定位不到 —— 要的是**量出来的数字**。做法是写一个 40 行的 CDP 探针，跑完就删：

```js
// scripts/_probe.js —— 用完删掉，不要提交
const { spawn } = require('child_process');
const { pickExe } = require('./pick-exe');
const path = require('path'), fs = require('fs'), os = require('os');

const EXE = pickExe(path.join(__dirname, '..', 'release', 'win-unpacked'));
const PORT = 9961;
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-'));
const env = { ...process.env, PM_USE_DIST: '1' };   // 支持的话可省一次 pack
delete env.ELECTRON_RUN_AS_NODE;                    // 必须！否则 exe 以纯 Node 启动
const app = spawn(EXE, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`],
  { env, cwd: path.join(__dirname, '..'), windowsHide: true });

// 连 CDP → Runtime.evaluate 取 computedStyle / getBoundingClientRect → console.log 数字
// 关键：过滤 devtools:// 的 target；首启要设主密码（Test@1234）再解锁
```

要点（都是踩过的）：

- **过滤 `devtools://`**：DevTools 自己也是 `type: 'page'` 的 target，而且排在前面。
- **`delete env.ELECTRON_RUN_AS_NODE`**：本机有这个环境变量，不删的话 exe 以纯 Node 模式启动，窗口不出现、CDP 连不上。
- **首启是「建库」不是「解锁」**：新 `--user-data-dir` 第一次要设主密码（用原生 setter 写 value + 派发 `input`/`change`，再点「设置主密码并开始使用」）。
- **导航用 `.nav-item`**，页面是 `React.lazy`，要等 `.page-loading` 消失再断言，别定长 sleep。
- 断言**几何量**（`getBoundingClientRect` / `computedStyle` / `scrollWidth`），不要截图说「看起来还行」。
- 探针确认修好后，把关键几条**并进对应的 `ui-roundN-test.js`**，然后删掉探针。

---

## 6. 常见坑（都是踩过的）

### 6.1 Electron / 主进程

- **绝对不要用 `<datalist>`** —— 会让 Chromium 原生崩溃（整个窗口消失，无日志）。用「下拉 + 可点标签」代替。
- **`srcdoc` iframe 会继承父文档 CSP**（`script-src 'self'`），所以 HTML 预览里的内联脚本根本不执行。代码调试页因此改用特权协议 `codelab://`（`electron/codelab-preview.js`，`registerSchemesAsPrivileged` 必须在 `app.whenReady()` 之前调用）。
- **`spawn` 之后必须等 `spawn`/`error` 事件**：exe 不存在时 `spawn` 不抛错、只异步发 `error`。`electron/url-open.js` 的 `spawnAndWait` 就是为此写的。
- **打开网址只走 `openHttpUrl()`**（`electron/url-open.js`）：`rundll32` → `shell.openExternal` → `explorer.exe`，顺序是量出来的（`explorer.exe` 在 Electron 宿主里是假成功）。新增「开网址」的 IPC 也照此办理。
- **`app.asar` 一旦被运行过就删不掉**（unlink/rename 都 EBUSY）。所以 `npm run dist` 走「打到临时目录 + robocopy 就地覆盖」，`npm run try` 把运行副本放 `run/`。
- **应用内下载不要拼 `%TEMP%`**：用 `app.getPath('temp')`，否则打包后路径不存在。

### 6.2 构建

- **`index.html` 可能被某次构建覆盖成产物版**（引用 `./assets/index-*.js`），之后 `vite build` 会报 `Failed to resolve ./assets/...`。修法：`git checkout -- index.html`。
- **`npm run pack` 在本机不可靠**，两种失败都遇到过：①去 GitHub 下 electron/winCodeSign 超时（`got` timeout）；②`EBUSY: rmdir 'release\win-unpacked'`（残留进程占着 asar）。前者先设 `$env:ELECTRON_BUILDER_CACHE = "$env:LOCALAPPDATA\electron-builder\Cache"`，后者先杀 `测试中台` 进程；只想验证代码就用 `pack:asar`。
- **`pack:asar` 必须整目录替换 `dist`**，`Copy-Item dist\*` 会漏文件得到残包（应用起不来）。

### 6.3 CSS

- **四份样式表顺序固定**：`tokens → global → pages → redesign`（`src/main.tsx` 顶部 import）。换肤靠「后加载覆盖先加载」，**批量删重复规则会直接改掉视觉**。
- **同选择器、逐字相同的规则会被压缩器去重合并**，先出现的那条（连同 `!important`）整条消失。所以 `global.css` 里那份 `select` 箭头规则被删掉了 —— 下拉框统一外观只在 `redesign.css` 定义一次，**不要再写第二份**。
- **`background:` 简写会清掉 `background-image`**（下拉框箭头就是这么丢的）。给 `select` 设背景一律用 `background-color:`。
- **`!important` 不要写进注释**：`scripts/check-debt-budget.js` 用正则数 `!important`，注释里的也算，会让预算超限。
- 下拉框右侧要给箭头留位：`padding-right: 26–28px`，否则文字压在箭头上（`.tb-main select` 已统一 28px）。

### 6.4 脚本 / 工具链

- **PowerShell 里 `node -e` 的替换串不要用 `\$1`**（会被转义成字面 `$1`，产出 `-color:` 这种残行）。用函数式 `replace(/re/gm, (m, p1) => ...)`。
- **删除含 junction 的目录**：先单独删 junction，**不要**用 `Remove-Item -Recurse` 覆盖父目录（会顺着链接清空真实 `node_modules`）。
- **`git worktree` 里跑回归**要 `mklink /J node_modules`，且 asar 必须含 `node_modules`（只打 `dist`+`electron` 会得到 5MB 残包）。
- **中文锚点不要走 PowerShell heredoc**（会乱码），用 ASCII 前缀 + `trim().startsWith`。

### 6.5 数据 / 禅道

- **禅道 REST 查 Bug 必须带 `status=all`**，否则只返回未关闭的。
- **`/bugs` 接口必须带 `product`**，`openedBy`/`assignedTo` 会被静默忽略 —— 要在本地过滤。
- **禅道会话按实例分桶**（`ztJar(base)`），多套配置不能共用一个 cookie 桶。
- **`entries:get-all` 返回的是整个 vault**（`{success, data: vault}`），不是数组。

---

## 7. 文档索引

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | **每次改代码都必须遵守的硬约束**（65,536 B 预算，已贴顶，新增内容请写进 `docs/agents/`） |
| `docs/agents/history-1.x.md` | 1.1.0–1.7.2 能力清单、构建排错、禅道登录、崩溃排查 |
| `docs/agents/features-1.22.md` | 1.22.0 的 12 项新功能 |
| `docs/agents/testing.md` | 回归脚本跑法、CI 门禁、几何量断言 |
| `docs/agents/ipc-split.md` | `setupIpcHandlers` 拆分全过程与踩坑 |
| `docs/agents/url-open.md` | 网址打开/复制唯一入口、环境矩阵 v3 |
| `docs/agents/window-tray.md` | 单实例锁、托盘、`showMainWindow()` 顺序、全局快捷键回滚 |
| `docs/agents/update-and-release.md` | 发布流程、应用内更新、CI 覆盖 Release |
| `docs/agents/weekly-report.md` | 周报 + 禅道成稿的全部规则 |
| `docs/agents/perf-test.md` | JMeter 非 GUI 压测 |
| `docs/agents/visual-system.md` | 视觉体系 v2 的 token 与组件类名 |
| `docs/agents/security.md` | 加密、审计、库自检 |
| `docs/agents/frontend-audit.md` | 前端审计结论 |
| `PRODUCT.md` | 产品定位与功能边界 |
| `ci-quality-gate.md` | CI 门禁说明 |

---

## 8. 发版（只在明确要求时做）

```powershell
# 1. 工作树必须干净
git status --porcelain

# 2. 写版本说明（gitignored，只在本地）
#    release-notes-<version>.md

# 3. 一条命令：升版本 → 门禁 → 打包 → 提交 → 打 tag → 推送 → 等 CI
node scripts/release.js 1.22.1
```

- `release.js` 要求**干净工作树**，否则直接退出。
- CI（`.github/workflows/build.yml`）会在 tag 上覆盖 Release body，所以发完要 `gh release edit --notes-file release-notes-<ver>.md` 回填。
- 附件名是 `PasswordManager-Setup-<ver>.exe`，发完核对 sha256 与线上 digest 一致。
- 本机安装副本在 `E:\password-manager\`，`npm run install:local` 可覆盖安装。
