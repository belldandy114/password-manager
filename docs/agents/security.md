# 主进程安全加固（导航守卫 / 依赖 / 打开网址）

2026-11-11 的一轮加固，三件事都属于「渲染层能碰到系统边界」的那一侧。
本文只记**约束与理由**，细节读代码：`electron/nav-guard.js` 有完整注释和 31 条单测。

> **1.24.2 更新**：测试数据生成器已从 webview 子应用并入主应用，主窗口 `webviewTag` 关闭、
> `guardWebviews` 不再挂载，`tdg:` 协议 / `dist-tdg/` / `preload-tdg.cjs` 全部删除。
> 下面关于 webview 白名单的表格描述的是 1.24.2 **之前**的形态；`nav-guard.js` 里那套判断
> 作为纵深防御保留（单测继续跑），但当前不会再被触发。

---

## 1. 导航守卫 `electron/nav-guard.js`

### 为什么必须要

`main.js` 的两个窗口早就设了 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`，
但**没有任何 `will-navigate` / `setWindowOpenHandler` / `will-attach-webview`**。
也就是说：渲染层一旦被注入（禅道返回的 HTML、接口调试的响应体、用户粘贴的 markdown），
`window.location = 'http://evil'` 或 `<a target="_blank">` 就能把主窗口导航走，
而主窗口的 `preload.js` 是挂着全部 143 个 IPC 的。当时 `webviewTag: true` 更是允许动态塞 `<webview>`（1.24.2 已关闭）。

### 白名单（改之前先看这张表）

| 目标 | 开发态（`USE_DEV_SERVER`） | 打包态 |
|---|---|---|
| 主窗口 | 仅 `http://localhost:5173`（origin 相等） | 仅 `file:` 且落在 `dist/` 内 |
| `devtools:` | 放行 | 拦 |
| `about:` | 放行 | 放行 |
| `<webview>`（历史，现已关闭） | 仅 `http://localhost:5174` | 仅 `tdg:` 与 `dist-tdg/` 内的 `file:` |
| `codelab:` 预览子框架 | 放行（`will-frame-navigate` 里只放 `codelab:`） | 同左 |

- `USE_DEV_SERVER = IS_DEV && !process.env.PM_USE_DIST`。**不要用 `IS_DEV` 判断**：
  `PM_USE_DIST=1` 时 `IS_DEV` 仍是 true 但窗口已经加载 `file://dist`，按开发态判断会把自己拦掉。
- `file:` 判定走 `toLocalPath`（百分号解码 + `/`→`\`），再用 `isWithinDir` 比目录。
  `isWithinDir` 必须比到「目录 + 分隔符」这一层，否则 `dist` 会匹配上 `dist2`。
- `setWindowOpenHandler` 一律 `deny`；http(s) 额外带 `external`，交回 `openHttpUrl`
  走「默认浏览器」那条链（见 `docs/agents/url-open.md`），不让 Electron 自己开新窗。
- （历史，1.24.2 起不再挂载）`will-attach-webview` 对 webview 的 `webPreferences` 做
  `Object.assign(HARDENED_WEBVIEW_PREFERENCES)`，并且 preload 只认 `preload-tdg.cjs` 这一个官方路径。
  **src 合法但 preload 不是官方的，剥掉 preload 而不是整体拒绝** —— 拒绝会让测试数据生成器白屏。

### 坑

- `new URL(u).pathname` 给的是正斜杠。测试里按 `C:\...` 断言会失败，`toLocalPath` 统一转反斜杠。
- `will-frame-navigate` 是子框架（codelab 预览 iframe）的钩子，别把 `codelab:` 拦了。

---

## 2. `xlsx` 只从 SheetJS CDN 装

`0.18.5`（npm 上仍是 latest）有两个 high：原型污染 + ReDoS，而 `ipc-vault-io.js` 拿它解析
**用户导入的**文件，正好是攻击面。修复版 0.20.3 官方只发在 `cdn.sheetjs.com`。

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

- **不能写 `file:` 本地路径** —— 仓库公开，会泄漏本机路径，且 CI 必挂。
- 0.20.3 的 `dependencies` 是 `{}`（全部打进 `xlsx.js`），所以 lock 里 `adler-32` / `cfb` /
  `codepage` / `crc-32` / `ssf` / `wmf` 等 8 个包应该消失，`npm install` 输出会写 `removed 8 packages`。
- 代理环境里 `npm install --package-lock-only` 可能 `ECONNRESET`。此时先
  `Invoke-WebRequest` 下载 tgz 再装本地文件，然后手改 lock 的 `resolved`/`integrity`（integrity 保留原值）。
- 升级后 `npm audit --omit=dev` 应为 **0 漏洞**。

---

## 3. 渲染层不再有 `window.open`

`EntryList` 以前在 `browserOpen` 失败时 `window.open(url)` 兜底 —— 那是绕过主进程白名单的第二条路，
而且 `window.open` 在新窗口里同样带着 preload。现在统一走
`src/utils/openUrl.ts` 的 `openUrlInDefaultBrowser()`：失败就把 URL 丢进剪贴板并提示，
不再自己开窗（`docs/agents/url-open.md` 有完整链路）。

全仓应保持 **0 处真实 `window.open(` 调用**（注释里提到不算）。
