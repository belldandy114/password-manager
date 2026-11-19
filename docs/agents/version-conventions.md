# 1.6.0 ~ 1.6.1 的逐项约定

从 AGENTS.md 迁出的完整说明：原子写盘、损坏自愈、备份恢复、数据目录迁移、会话 Cookie 罐等。

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
1.24.2 起测试数据是普通 `React.lazy` 页面，随页面卸载、按路由渲染；
回归脚本不要再去 CDP 里找 `webview` target 或 `tdgMounted` 保活容器。

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


