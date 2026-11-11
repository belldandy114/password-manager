# 网址「打开 / 复制」的唯一入口（1.22.x，2026-11-10）

这一轮处理的反馈是两句：「点网址后面的打开，没用默认浏览器打开」和「复制网址，实际复制的是名称」。
结论：**打开链路在部分环境里是「静默失败」**，而复制链路的取值本身是对的 —— 但点击目标与提示都太含糊，
用户没法判断到底发生了什么。所以做了三件事：统一打开入口、把点击目标显式化、复制/打开后回显内容。

## 1. 打开网址只有一个入口

### 主进程：`electron/url-open.js`

```js
openHttpUrl(rawUrl, { shell, spawn, platform }) // => { success, via?, error? }
```

顺序：`rundll32 url.dll,FileProtocolHandler` → `shell.openExternal` → `explorer.exe <url>`。
第一条「进程真的起来了」就算命中，全失败才返回 `success:false`，并把最后一条原因带回渲染层。

> **顺序是量出来的，不是拍的。** 2026-11-11 用「本地 HTTP 服务器收请求 + 查 Chrome 历史」判真假，
> 同一批地址逐个试（详见第 2 节表格）。`explorer.exe` 代理在 **Electron 宿主里是假成功**，
> 只能放最后当兜底，绝不能排第一。

- `env:open`（环境矩阵行内「打开」）与 `browser:open`（`browser` 为空串或 `default` 都按默认浏览器）
  都已经改成走它。**新增任何「开网址」的 IPC 也照此办理**，不要再直接写 `shell.openExternal`。
- `normalizeHttpUrl` 先拒危险伪协议再补协议：`javascript:alert(1)` 这种**不带 `//`** 的写法
  如果先补 `https://` 会变成 `https://javascript:alert(1)` 从而绕过校验。现在按
  `javascript|data|vbscript|file|about|blob|mailto|tel|chrome|edge|ms-` 名单先拦，
  `localhost:3000` / `host:8080/path` 这类正常填法不受影响。
- 单测：`src/utils/__tests__/urlOpen.test.ts`（13 条，纯逻辑，`shell`/`spawn` 注入，不 require electron）。
- **`spawn` 之后必须等 `spawn` / `error` 事件**（`spawnAndWait`，600ms 上限）：exe 不存在时 `spawn`
  不抛错、只异步发 `error`，以前 spawn 完就 return 成功 —— 这正是「显示已打开实际没有」的来源之一。

### 渲染层：`src/utils/openUrl.ts`

```ts
openUrlInDefaultBrowser(raw) // => { ok, error?, copied? }
```

- 只有 `success:false` / 抛异常算失败（用户取消不算失败）。
- 失败时**把地址复制到剪贴板**，调用方只要把 `error` 显示出来即可。

## 2. 为什么要有兜底链（实测记录）

### 2.1 2026-11-11 复测（本次定顺序的依据）

环境：本机管理员会话，Electron 33 主进程（打包版与 `node_modules/.bin/electron` 结果一致），
Chrome 已在运行（多窗口多 profile）。判定方法：本地 `http://127.0.0.1:38999/<唯一路径>` 服务器记请求，
再查 `Chrome\User Data\Profile 10\History` 复核 —— **「真打开」和「假成功」就此分开**。

| 尝试 | 从 node 进程 | 从 Electron 主进程 |
|---|---|---|
| `rundll32 url.dll,FileProtocolHandler <url>` | ✅ | ✅ |
| `shell.openExternal(url)` | ✅ | ✅ |
| `spawn(chrome.exe, [url])` / `msedge.exe` | ✅ | ✅（退出码 0，标签页真的开了） |
| **`spawn(explorer.exe, [url])`**（shell 代理） | ✅ | ❌ **退出码 1，浏览器毫无反应** |
| `cmd /c start "" <url>` | ✅ | ✅（但地址含 `&` 会被 cmd 当分隔符截断，故不采用） |

> 上一版把 `explorer.exe` 排第一（依据是「node 里它跨权限能拉起浏览器」），结果**在 Electron 里静默失败**，
> 界面照样显示「已打开」——用户看到的就是「点了没反应」。**结论：跨宿主差异必须实测，不能类比。**

### 2.2 2026-11-10 的旧记录（另一种更严的沙箱会话里测得，仅作参考）

在**以管理员身份运行 / 被沙箱包住**的环境里（当时那个 DSH 会话是 High 完整性级别）：
`openExternal` / `spawn(chrome.exe)`（退出码 **21**，PROFILE_IN_USE）/ `rundll32` / `cmd start`
从 Electron 里**全部失败**，只有 `msedge.exe` 正常。Chrome 侧日志
`Chrome.ProcessSingleton.NotifyResult` = 失败、`RemoteProcessInteractionResult` = 失败 ——
新进程没能把 URL 通知给已在跑的 Chrome 实例，于是认为 profile 被占用直接退出。

**结论**：这类失败是**环境相关**的（沙箱/权限 + Chrome 单例），不是 JavaScript 层的 bug。
应用侧能做的就是：① 按实测顺序轮询多条通道；② 把「打不开」变成**看得见的失败**并给出兜底路径，
而不是弹一个「已打开」；③ 失败时地址已经在剪贴板里。


## 3. 点击目标必须显式

- 网址管理卡片：`.card-url` 从 `<span>` 改成 `<button>`（点地址即打开默认浏览器，可键盘 Tab 到），
  旁边单独给 `.card-url-copy`「复制网址」。以前只有一排 emoji 按钮（🔗/👤/🔑），很容易点成「复制账号」。
- 环境矩阵行内：动作常显（`opacity: .72`，hover 到 1），并用 `.env-acts-sep` 把「打开/复制」
  与「编辑/删除」分开；title 写明「复制的是地址，不是系统名」。
- 复制/打开之后**回显内容**：`网址已复制：<地址>`、`已交给系统浏览器打开：<地址>`。
  这样「复制出来是名字」这类误会能当场看出来。

## 4. 页面内提示的定时器必须可取消

`Environments.tsx` 的 `flash()` 以前每次都 `setTimeout(() => setHint(''), 2600)`，
旧定时器会把**下一条更晚出现的提示**提前清掉（点完复制立刻点打开 → 打开的提示瞬间消失，
看起来就像「点了没反应」）。现在用一个 `useRef` 存 timer，新提示先 `clearTimeout` 旧的。

## 5. 环境矩阵 v3 样式

全部追加在 `src/styles/redesign.css` 末尾第 33 节（**不改进 `pages.css` 第 19.29 节**，
避免被后面加载的密度规则覆盖）：

| 类名 | 作用 |
|---|---|
| `.env-filters` / `.env-filter` / `.env-filter-n` / `.env-filter-dot` | 环境类型快筛胶囊，带计数与色点 |
| `.env-bar` / `.env-bar-seg` | 巡检报告的可达/失败比例条 |
| `.env-row-acts`（常显）/ `.env-acts-sep` | 行内动作分组 |
| `.env-card-head`（`position: sticky`） | 长分组滚动时不丢系统名 |
| `.card-url`（按钮态）/ `.card-url-copy` | 网址管理卡片里的地址与「复制网址」 |

几何量口径（临时探针断言过，脚本已删，需要时按下面重建）：

- `.env-filter` 高度 26px、圆角 ≥ 12px（实际 `999px`）
- `.env-row` 高度 34–56px（1440×900 下实测 51px）
- `.env-row-acts` 的 `opacity ≥ 0.6`（实测 0.72）
- 每行 4 个 `.ibtn`（打开 / 复制 / 编辑 / 删除）

探针脚本的写法参考 `scripts/ui-round15-test.js`：CDP 连 `--remote-debugging-port`，
**过滤 `devtools://`**、`delete env.ELECTRON_RUN_AS_NODE`、临时 `--user-data-dir`，
起一个本地 http server 当「可达地址」，再断言 DOM 与剪贴板（`Get-Clipboard -Raw`）。

## 6. 巡检上限与统计卡（2026-11-11）

### 50 条上限已放开到 500

`electron/env-probe.js` 的 `MAX_URLS` 从 **50 改成 500**。之前 80 个地址只跑 50 个，
是因为 `runProbes` 与 `ipc-env.js` 都按 `MAX_URLS` 截断，**没有任何提示**——用户只会觉得「少了几条」。

- 并发改成随批量自动放大：`min(16, max(6, ceil(n / 8)))`。80 条用 10 并发，
  实测 80 个地址（79 可达 + 1 不可达）**2.3 秒**跑完；6 并发时最坏情况（全超时）要等 100 秒以上。
- 上限仍卡在 16，别把内网一次打满。
- 单测 `envProbe.test.ts` 里「超过上限的地址被截断」用的是 `MAX_URLS + 5`，改常量后自动跟着走。

### 统计卡（`.env-kpis`）

对齐缺陷汇总页那种「大数字 + 说明」的卡片，**一次巡检后一直显示，再巡检原地刷新数字与时间**：

| 卡 | 内容 | 副标题 |
|---|---|---|
| 地址总数 | `summary.total` | 本次巡检 N 个 |
| 可达 | `summary.ok` | 占 N% |
| 失败 | `summary.fail` | 占 N% |
| 慢（≥2s） | `summary.slow` | 占可达 N% |
| 平均耗时 | `summary.avgMs` | 最慢 `<host>` |
| 上次巡检 | `MM-DD HH:mm` | 最新一次 / 历史记录 |

- 左侧竖色条区分口径（`.env-kpi::before`），数字按口径上色。
- 响应式：≤1280px 三列、≤860px 两列。
- **持久化从 sessionStorage 换成 localStorage**：用户要的是「巡检一次后一直显示」，
  关掉应用再打开也要能看到上一次的数字与时间。key 仍是 `pm.env.probe`。
- ⚠️ `viewingRecord` 不能只判 `history.some(h => h.id === currentId)`——刚跑完那次也在 history 里，
  会一直显示「历史记录」。改成 `currentId !== history[0].id` 才算回看历史。

### 回归

临时探针（已删）验证过 11 条：80 条地址全部渲染 / 统计卡 6 张 / 总数 80（不再 50）/
可达 79 / 失败 1 / 有时间卡 / 巡检 <60s / 真实打到 79 个不同地址 / 再巡检卡片不清空 /
切页面回来仍在。需要时按 `scripts/ui-round15-test.js` 的写法重建。