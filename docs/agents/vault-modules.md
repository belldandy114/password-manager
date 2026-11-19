# 多模块扩展（1.2.0 ~ 1.8.x）

从 AGENTS.md 迁出的完整说明：vault 结构、禅道登录三步 / REST、周报、视觉体系等。

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
**要出安装包仍必须让 electron-builder 完整跑通**。1.24.2 起测试数据生成器已并入主应用，
独立 Vue 子应用（`sub-apps/`）、`build-subapp.js` / `build:sub-apps`、`dist-tdg/`、webview preload
与 tdg IPC 全部删除，构建只剩 renderer 一步；上面的「子应用构建卡死」排错记录仅作历史。


