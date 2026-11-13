# history-1.x（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

## ⚠️ 应用内下载：不要把安装包拼到 %TEMP%（2026-10-29 杀软误报）

**现象**：应用内「下载并安装」下到一半被 360 删除，报 `Trojan/Injector.avv`：

```
%TEMP%\pm-update\PasswordManager-Setup-<ts>.exe.part0
操作进程：测试工具.exe
```

**根因**：旧实现把安装包拆成 `xxx.exe.part0 … part5` 并发写到 `%TEMP%\pm-update`，再拼成 exe。
`.part0` 的内容就是 NSIS 安装包的 PE 头，「非浏览器进程在临时目录写可执行内容并拼装」
正是释放器/注入器的行为模式，启发式必中——**不是误报到我们头上，是这种写法本来就像**。

**现在的约定（改这块前务必遵守）**：

| 项 | 做法 |
|---|---|
| 落盘位置 | `app.getPath('userData')/update/`，**不要再写 `%TEMP%`** |
| 文件名 | 用 GitHub 资产名（`assetFileName()`），不要带时间戳/随机串 |
| 写盘方式 | 先写 `<name>.partial` → `fs.renameSync` 成正式名；并行时分片放 `update/parts-<ts>/chunk-N.bin`（**仅并行才创建该目录**），下完即删。单连接与分片的写流都要监听 `error` |
| 默认策略 | **单连接顺序下载**（像普通下载器），不做自动慢速切换；只有用户点「加速重试」/ 勾多线程才 6 分片并行，并行失败要回退单连接（分片可能被杀软误报，UI 上要写明）。默认行为由 r9 慢速用例锁住 |
| 完整性 | 下载后算 SHA-256，与 Release asset 的 `digest` 比对，**不一致就删文件并拒绝安装**；返回 `verified` 给 UI 显示「已校验」 |
| 失败提示 | 必须包含：浏览器下载 / 选择本地安装包 / 加速重试 + 当前链路（代理 or 直连）+ 一句杀软排查建议 |

**验证方式**（`R9_ONLY=update node scripts/ui-round9-test.js`，用本地 Range 服务造假安装包）：

- 摘要正确 → `success && verified`，文件名等于官方资产名，路径不含 `pm-update`；
- 摘要错误 → `success:false` 且错误里带 `SHA-256`，文件被删除；
- `threads:true` → 走 6 段且校验仍然通过。

GitHub 侧的 `digest` 字段确认可用：v1.7.0 附件的 digest 与本地 exe 的 SHA-256 完全一致。

## 1.7.2 修的两个坑（别改回去）

| 症状 | 根因 | 正确做法 |
|---|---|---|
| 禅道「我提交的 / 待我验证」报 `Need product id.` | 禅道 20.x 的 `GET api.php/v1/bugs` **强制要 product**，只带 openedBy/assignedTo + status 一律失败 | `ztLoadMyBugsScoped` 先 `ztApiProducts()` 取项目，再**按项目逐个查**（4 并发、按 id 去重合并）。`scripts/zt-stub.js` 也实现了「不带 product → 400 Need product id」，回归会拦住 |
| 粘贴 curl 后值首尾多出 `^` | Chrome「Copy as cURL (cmd)」用 `^"…"^` 包裹参数，`^` 是 cmd 转义符；分词器只处理了 bash `\` 与裸 `^` 续行 | `unwrap()` 先把 `^"` → `"`、去掉贴尾/贴空白的孤立 `^`，再走正常引号分词。单测覆盖了 cmd 写法 |

⚠️ 写禅道 REST 相关代码时记住：`products` 与 `bugs` 这两个接口都有硬性参数要求，
不要凭直觉省参数——先在假禅道（`zt-stub.js`）里把响应造对，再让回归跑绿。


---

## 1.7.0 起的约定（改代码前先看）

| 能力 | 位置 | 约定 |
|---|---|---|
| cURL 互转 | `utils/curl.ts` | `parseCurl` / `buildCurl` 是**纯函数**，单测在 `src/utils/__tests__/curl.test.ts`（32 条）。分词器按「一个参数可由单引号段/双引号段/`\`转义/裸字拼接」实现，别写成「遇引号就 push」——`'it'\''s'` 与含空格的 body 会被切坏（踩过）。生成端用单引号包裹并 `'\''` 转义，输出单行，Git Bash/PowerShell 都能跑 |
| cURL 复制兜底 | `ApiClient.tsx` `copyCurlCmd` | `navigator.clipboard` 在窗口未聚焦时会抛错，必须回退 `textarea + execCommand`，否则用户点了没反应 |
| 我的 Bug 三视图 | `main.js` `ztLoadMyBugsScoped` | `opened` → REST `openedBy + status=all`；`verify` → `assignedTo + status=resolved`；`assigned` 仍走页面抓取（有现成分页模板）。视图存 `zentaoStore.mineScope`，切页面不丢 |
| 异地备份 | `main.js` `backupMirrorDir` / `mirrorBackupFile` | 每天备份时同时写一份到 `settings.backupMirrorDir`（可为 OneDrive/坚果云 目录），保留份数与本地一致；**写失败只记录不抛**，绝不能让备份阻断保存。`backup:now` 可手动补一份，返回 `{file, mirror}` |
| 备份测试 | `scripts/zt-stub.js` | 没配 `ZT_*` 时提供的假禅道（`tokens` / `products` / `bugs` 过滤 + `user-login.html`），回归脚本用它替代内网实例，并能断言「应用实际带了哪些查询参数」 |


---

## 1.6.1 起的约定（改代码前先看）

| 能力 | 位置 | 约定 |
|---|---|---|
| 周次下拉 | `utils/weeklyDraft.ts` `weekOptions()` | **offset = 几周前**（0=本周、1=上周）。`weekRange(offset)` 内部是「减去 offset*7 天」，所以下拉**不能**再写成 `-i`——1.6.0 就是符号反了，把「上周」算成下一周（10-19~10-25 显示成 11-02~11-08），草稿与对比全错。改动请跑 `src/utils/__tests__/weeklyRange.test.ts` |
| 老数据兼容 | `WeeklyReport.tsx` `draftOffset` 初始化 | `localStorage['pm.weekly.draftOffset']` 里可能存在旧版的 `-1`，**负数一律归 0**，不要原样信任 |
| 对比表对齐 | `pages.css` `.wk-cmp*` | 三个数字列**定宽 + 右对齐 + `align-items: baseline`**。不要退回 `1fr` 自适应：位数一变整列就跳，字号不同还会错位（就是「变化和数字没对齐」那个观感问题） |
| 对比面板 | `WeeklyReport.tsx` | 用 `<Panel collapsible>`（折叠是 Panel 自带能力，标题跟着 `draftOffset` 变）。`Panel` 的 `tools` 已经 `stopPropagation`，按钮不会误触发折叠 |
| 设置页骨架 | `pages.css` `.set-shell / .set-rail / .set-nav / .set-foot` | 左侧竖排菜单 + 右侧内容卡片。**不要再回到顶部横排 `.settings-tabs` + `600px` 居中窄栏**，也别用内联 `padding`/`marginLeft` 去对位置 |
| 接口调试视觉 | `pages.css` 第 19.21 节 | 只改样式、**不动类名**（round5/6/7 回归脚本依赖 `.url-bar`/`.api-io`/`.assert-toggle`/`.resp-tabs`/`.code2`）。`.api-io` 是**上下单列**（半宽时 KV 行太挤），不要改回两栏 |
| 周报正文框 | `redesign.css` 末尾 `.wk-editor / .wk-md-input / .wk-preview / .wk-read` | **编辑态和阅读态是同一个框**：固定高度 `calc(100vh - 300px)`（与左栏 `.wk-list` 的 `calc(100vh - 320px)` 同一口径），框内滚动。四个必须一起满足：① 父级 `.wk-editor` 有确定高度；② 子项 `min-height: 0`（否则 flex 子项不肯收缩，`overflow-y` 失效、框还是会被内容撑长）；③ 边框用 `--input-line` 而不是 `--border`（`--border` = `--line`，深色主题下几乎看不见）；④ 阅读态的 `<article>` 必须带 `wk-read` 类 —— 只改编辑态时使用者会说「好像没变化」，因为他看的是已保存的周报。回归里有「注入 200 行后高度不变且 `scrollHeight > clientHeight`」和「长周报在阅读态框内滚动」两条断言 |


---

## 1.6.0 起的约定（改代码前先看）

| 能力 | 位置 | 约定 |
|---|---|---|
| 原子写盘 | `main.js` `writeFileAtomic` | 临时文件 → `fsync` → `rename`，再加一份 `.bak`；**所有 vault/trash 落盘都必须走它**，不要直接 `writeFileSync(DATA_FILE)` |
| 损坏自愈 | `readEncryptedWithBak` | 主文件解不开就回退 `.bak` 并写回，审计记 `vault-recover-bak`；`auth:verify` 遇损坏返回 `code:'vault-corrupt'`，登录页据此给「从备份恢复」入口 |
| 备份恢复 | `backup:restore` | 恢复前先做 `pre-restore` 快照（保留 5 份）；保留份数读 `settings.backupKeep`（1~60） |
| 数据目录迁移 | `data:migrate` / `data:reset-location` | 只复制不删除；`resolveDataDir()` 是唯一入口，别在别处拼 `DATA_DIR` |
| 结构快照 | `utils/apiSchema.ts` | 只比**类型**不比值（值变化不误报）；`schemaFromBody` 非 JSON 返回 `null`；快照存在 `req.snapshot` |
| 响应转代码 | `utils/apiCodegen.ts` | `jsonToTsTypes` / `jsonToMarkdownTable` 纯函数；表格单元格里的 `|` 与换行必须转义，否则表格被拆坏 |
| 断言规则行 | `ApiRequest.assertions[]` | 1.6.0 起是**可增删的规则行**（`{op,target,value,negate}`），旧的 5 槽位走 `migrateReq()` 自动迁移；断言行里状态码行的 target 输入是 disabled，测试要取 `input:not([disabled])` |
| 会话 Cookie 罐 | `main.js` `apiJar` | `api:send` 的 `autoSession=true` 时自动接收 Set-Cookie 并回带；**用户手写的 Cookie 头优先**；`api:cookies-clear` 清空 |
| 禅道多套配置 | `AppSettings.zentaoActiveId` | `ztCfgFromVault()` 取「当前选中 → 旧的 `zentao` → 任一完整配置」，定时提醒也跟这套走；切换时 `settings:save { zentaoActiveId }` |
| 禅道附件 | `zentao:attachment` | 主进程带登录态取二进制（上限 100MB），`mode=open` 落临时目录再 `shell.openPath`，`mode=save` 走 `showSaveDialog`；文件名要过滤 `[\\/:*?"<>|]` 并去重 `-2` |
| 未读红点 | `zentao:unread` / `zentaoUnreadClear` | 状态存 `DATA_DIR/zentao-notify-state.json`（**不是** userData，随数据目录迁移）；进禅道页清零，重启后仍能显示未读数 |
| 周报对比 | `utils/weeklyDraft.ts` `compareWeeks` | 「多」不一定是「好」：`lowerBetter` 决定箭头颜色（新提变多=坏，关闭变多=好） |
| 安装包下载 | `main.js` `netDownloadParallel` | 先 `netProbe`（Range `0-0` 拿 `Content-Range`）→ 6 段并发 `netDownloadRange` → `concatFiles` 拼回；不支持 Range 或文件 < 4MB 回退单连接；进度推送带 `speed`/`threads` |


---

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

## 1.5.0 构建卡死根因与三个坑（2026-10-28）

**现象**：`npm run dist` 跑到「构建子应用」就长时间无输出，exe 一直出不来（日志里像是「卡在下载」）。

**根因**：`package.json` 和 `scripts/build-installer.js` 里的子应用步骤写的是 bash 语法

```bash
cd sub-apps/test-data-generator && (test -d node_modules || npm install) && npx vite build
```

Windows 的 npm 用 `cmd.exe` 执行脚本，**cmd 里没有 `test` 命令**，于是每次都进 `|| npm install` 分支：
在公司网络下这一步会长时间卡住 → 整个构建停在子应用阶段。

已改为 `node scripts/build-subapp.js`：用 `fs.existsSync` 判断依赖、直接调用本地 `vite/bin/vite.js`，
不联网、跨平台；`package.json` 的 `build:sub-apps` 也指向它。
（**1.24.2 起子应用已并入主应用并删除**，本节排错记录仅作历史。）

**另外两条必须记住**：

- `scripts/build-installer.js` 现在会**自动探测** `ELECTRON_BUILDER_CACHE`
  （`%LOCALAPPDATA%\electron-builder\Cache`），有就直接用，避免 NSIS 阶段去 GitHub 拉资源超时；
  已经设了环境变量则不覆盖。electron 仍走 `-c.electronDist=node_modules/electron/dist`。
- **`multipart` 请求体不能带用户自己的 Content-Type**：`api:send` 里会先删掉该头，
  由 `fetch(FormData)` 生成带 boundary 的值。用户从别处粘来的 `multipart/form-data`（无 boundary）
  会让服务端解析失败。

**笔记新建的约定（容易写错）**：

- 新建笔记必须给 `notes:save` 传**空文件名**，让主进程 `notesFileName()` 生成名字（重名自动加 `-2`）；
  一旦传了文件名就走「沿用」分支，会覆盖同名笔记 —— 1.5.0 初版就是踩了这个，同名新建会吃掉原文件。
- 改标题走 `notes:rename`，目标已存在时主进程返回错误（不会覆盖），内容仍写回原文件。

**本次全链路验证**：`npm run typecheck` 0 错 → `npx vite build` → `npm run dist` 一把过
（96.1 MB / 100,750,785 B）→ `check:integrity` 7 项全 Medium → `npm run smoke` 13/13 →
`ui-round6-test` 28/28（新增「同名新建不覆盖」断言）→ round2/3/4/5 全绿。


---

### 1.5.0 起的几个约定（改代码前先看）

| 能力 | 位置 | 约定 |
|---|---|---|
| 请求体类型 | `ApiRequest.bodyType` | `json / form / multipart / raw / none`；`form`/`multipart` 正文按**每行 key=value** 写，`multipart` 的值以 `@` 开头=本地文件路径；`raw` 的 Content-Type 填在 `rawContentType`；**用户自己写了 Content-Type 头就不覆盖** |
| Cookie | `ApiRequest.headers` | 已取消独立 `cookies` 字段，统一写在请求头里（`Cookie: a=1; b=2`）；读取旧数据走 `migrateReq()` 自动合并 |
| 笔记目录 | `notes:*` IPC | 目录存 `localStorage['pm.notes.dir']`，为空=用加密库；文件名由标题生成（非法字符转 `_`、重名加 `-2`），删除走 `shell.trashItem`（可找回） |
| 目录类 IPC 安全 | `notesResolve` / `weeklyResolve` | **必须做目录穿越校验**：拼出的绝对路径必须仍在根目录内，否则报错 |


---

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


---

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


---

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


---

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
- **更新链路**：`update:check` 读 GitHub Releases 比对版本 → 启动时静默检查推 `update:available`
  → 顶部横幅 + `UpdateDialog` 弹窗（展示更新说明、自动下载、倒计时自动安装）。
  点「去更新」**不再跳设置页**；设置页里的旧版内联更新 UI 保留为高级入口（多线程开关 + 链路诊断）。
  `update:available` 推送必须带 `notes/downloadUrl/assetName/digest`，否则弹窗要先补一次 `update:check`。
- 更新弹窗的回归：`scripts/shot-update-dialog.js` 用 `PM_UPDATE_API` 指向桩服务冒充 Releases，
  `PM_UPDATE_NO_INSTALL=1` 让安装只走流程不真拉安装程序（否则截图跑一半应用就退出了）。
- 测试数据子应用（webview）**保活**：`App.tsx` 用 `tdgMounted` + `display:none` 隐藏，绝不卸载；
  登录后空闲 3 秒预热。实测首次 ~1s、再次进入 ~2ms（不重新加载）。


---

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

