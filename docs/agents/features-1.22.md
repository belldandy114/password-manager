# 1.22 功能批次：定时任务 / 环境巡检 / 钉小窗 / 片段库 / 接口回归

这一批是「12 项功能」的落地记录。每节写清：做了什么、为什么这样拆、以及下次动它时要先知道的事。
入口文件都标了路径，方便直接跳过去改。

---

## 1. 库结构版本号与迁移

- 位置：`electron/vault-schema.js`（`VAULT_SCHEMA_VERSION = 2`、`MIGRATIONS`、`migrateVault`）
- 库文件现在**一定有** `schemaVersion` 字段；老库（没有这个字段）一律按 v1 处理，打开时自动迁移并写回。
- 迁移只做「结构变化」，不做数据修复；`future`（库版本比程序新）时**不迁移、不降级**，`normalizeVault` 保留未知字段——否则用旧版打开一次就把新版字段洗掉。
- 每次迁移都会写一条审计：`vault-migrate`（from/to）；撞到新版库写 `vault-newer-version`。
- 新增集合时**只改 `vault-schema.js` 的 `VAULT_COLLECTIONS`**：`normalizeVault`/`migrateVault` 都按它补空数组。本批新增 `codeSnippets`（代码调试片段库）。
- 单测：`src/utils/__tests__/vaultSchema.test.ts`（18 例）。

## 2. 库自检与恢复演练

- 位置：`electron/vault-audit.js`（纯函数 `auditVault(vault, { attachmentExists })`）、`electron/ipc-data.js` 的 `vault:audit` / `vault:restore-drill`
- **自检只读**：不修任何东西，只列问题；`attachmentExists` 由调用方注入（不碰 fs，方便测试）。
- 12 类检查：缺 id / 重复 id / 缺名称 / URL 协议非法 / 时间非法 / 标签悬空 / 附件缺失 / 密码历史悬空 / 笔记附件缺失 / 接口历史悬空 / 标签未使用 / 标签重名。
- `badUrl` 的口径与 `electron/url-open.js` 的 `normalizeHttpUrl` 一致：**只有写了协议头且不是 http(s) 才算坏**；`example.com`、`10.0.0.1:8080` 这种无协议头是合法的（会被自动补 https）。
- 恢复演练：选一份 `backups/vault-YYYY-MM-DD.enc` → 校验格式 → 用当前主密码试解 → 解析 JSON → 体检。**全程不写正式库**，失败了只回 `stage`（format/decrypt/parse/done）。
- 单测：`src/utils/__tests__/vaultAudit.test.ts`（13 例）。

## 3. 定时任务统一面板

- 入口：设置 › 定时任务（`src/pages/Settings.tsx` 的 `case 'tasks'`，样式在 `redesign.css` 第 48 节）
- 四张卡：环境矩阵巡检 / 禅道新 Bug 检查 / 检查更新 / 每日备份。每张显示间隔、上次时间、立即执行按钮。
- **所有定时任务都跑在应用运行期间**，关掉应用就停——这是产品定位（本地工具，不常驻），不要改成后台服务。
- 间隔改动要**点「保存设置」才生效**（和其它设置项一致）。

## 4. 环境矩阵定时巡检 + 状态翻转告警

- 位置：`src/utils/envSchedule.ts`（`useEnvAutoProbe` / `runEnvProbeOnce` / `diffProbe` / `toSnap`）
- 环境列表来自 **`wsGet('environments')`**（vault 集合，只放地址），不是 `entries`；账号密码在 `entries` 里是另一回事。
- 巡检放渲染层（用 fetch），关掉应用就不跑；结果直接进 `useEnvProbeStore`，所以切回环境页能看到新数字。
- **只在翻转时通知**：可达→不可达（fail）、不可达→可达（recover）、耗时 ≥2s 且翻倍（slow）。首次巡检没有基线，不报。
- 通知走 `app:notify`（`electron/ipc-shell.js`），点通知会把主窗口拉出来并跳到 `environments`（`app:navigate` → `onAppNavigate`）。
- 立即巡检按钮与定时器共用 `runEnvProbeOnce`，同一时刻只允许一轮（模块级 `probing` 锁）。
- 单测：`src/utils/__tests__/envSchedule.test.ts`（9 例，含「40ms→95ms 不算变慢」）。

## 5. 最近使用 / 常用入口

- 位置：`src/utils/recent.ts`（localStorage：`pm.recent.entries` / `pm.recent.pages`）
- 只存 id 与计数，**不含名称/网址**，所以放明文 localStorage 不泄露内容；也不进导出文件（这是「这台机器上我怎么用」，不该跟加密库同步）。
- 记录点：`EntryCard` 根节点点击、`EntryList.handleRowClick`、`App.tsx` 里「记住当前页面」的 effect（600ms 节流）。
- 两个消费方：工作台「最近」条（`.recent-strip`，有筛选时隐藏，避免和搜索结果重复）、命令面板排序（`pageUseScore` / `entryUseScore`）。

## 6. 搜索升为全局 + 语法

- 位置：`src/utils/query.ts`（`parseQuery` / `scoreTarget`），接入 `CommandPalette`
- 语法：`@page/@action/@entry/@snippet/@note/@account/@request/@case/@env`（有别名，如 `@sql`→snippet、`@api`→request）、`tag:xxx`、`env:prod`（前缀匹配）、`name:`/`url:`/`user:`
- **只做进命令面板，不做进工作台搜索框**：后者是「在网址里找」，语法只有在跨六类数据时才有价值。
- `tag:` 后面没值时不吞词，按自由文本处理。
- 单测：`src/utils/__tests__/query.test.ts`（15 例）。

## 7. 剪贴板历史（本地加密，30 条）

- 位置：`electron/clip-history.js`（`createClipHistory`），文件 `clipboard.enc`（用主密码加密整份数组）
- 语义分三种，别混：
  - 锁屏 → `forget()`：只清内存，文件还在；解锁后 `load()` 读回来。
  - 用户点「清空」 → `wipe()`：清内存 + 删文件。
  - 改主密码 → `repersist(newPw)`：用新密码重写；重置主密码 → `wipe()`（旧密码作废，文件再也解不开）。
- 同一内容重复复制→提到最前而不是堆多行。
- 单测：`src/utils/__tests__/clipHistory.test.ts`（10 例，用真临时目录 + 可逆假加密）。

## 8. 代码调试片段库

- 位置：`src/pages/CodeLab.tsx` 的「片段库」抽屉（样式 `redesign.css` 第 49 节）；数据存 vault 集合 `codeSnippets`
- 存的是 `{ id, name, lang, code, createdAt, updatedAt }`；同名 + 同语言视为更新。
- 载入片段会一并切语言（HTML 片段会自动切到预览页签）。

## 9. 错误日志查看 + 导出诊断包

- 位置：`electron/ipc-data.js` 的 `log:export-diagnostic`；设置 › 通用 › 关于
- 「查看日志」弹窗只读最近 400 行（`logTail(400)`），带路径与刷新按钮，样式在 `redesign.css` 第 51 节（`.log-modal*`）。
- 诊断包内容：版本 / Electron / Chrome / Node / 平台 / 数据目录 / 库文件大小 / 备份份数 / 异地目录 + 库自检文本 + `logTail(400)`。
- **不含主密码与条目内容**——发出去也不泄露库，但里面可能有内网地址，提醒用户先看一眼再发。

## 10. 快捷键

- 结论：全局 3 个与应用内 7 个**本来就能改**（`electron/main.js` 的 `DEFAULT_SETTINGS.keybindings` 与设置页同源）。本批补的是冲突检测与「恢复默认」。
- 位置：`src/utils/keybindings.ts`（`normalizeCombo` / `findConflicts` / `DEFAULT_KEYBINDINGS`）
- 有一条单测直接读 `electron/main.js` 抓 `keybindings: {...}` 块比对默认值，**改默认键位必须两边一起改**。

## 11. 条目钉成独立小窗

- 位置：`electron/pin-window.js`（窗口管理）、`src/PinApp.tsx`（窗口内容）、`?window=pin&id=…` 路由
- 窗口参数：无边框、透明、置顶（`screen-saver` 层）、不进任务栏；开了「防截屏」时一并 `setContentProtection`。
- **锁屏会关掉所有小窗**（`closePinWindows`）——小窗里是明文密码，锁屏必须一起收。
- 小窗获得焦点时重新拉一次数据，主窗改了密码切回来就能看到新值。
- 复制走 `clipboardCopy({ delay: 20000 })`，20 秒后自动清空剪贴板。

## 12. 接口调试：用例集 + 变量传递 + 回归报告

- 位置：`src/utils/apiVars.ts`（`parseVarLines` / `applyVars` / `readJsonPath` / `mergeVarPool`）、`src/pages/ApiClient.tsx` 的 `runBatch` 与批量结果弹窗
- 变量传递：给请求配「变量提取」（变量名 + 响应路径，如 `data.token`），批量运行时按顺序执行，提取到的值进变量池，后面的请求用 `{{token}}` 取。**变量池不落盘，跑完即丢**（避免下次拿过期 token）。
- 提取失败不判失败，只在结果行标 ⚠ 并列出没取到的变量名——多半是路径写错，需要看得见。
- 回归报告：批量结果弹窗「复制 Markdown / 保存 .md」，输出一张 PASS/FAIL 表（含断言通过数、耗时、提取到的变量、总耗时）。
- 单测：`src/utils/__tests__/apiVars.test.ts`（15 例，覆盖 `[0]` 下标、缺字段、值为对象、自引用不递归）。

---

## 这批改动踩过的坑

1. `Object.keys(vault.history)` 在 TS 里会报 TS2769（`history` 是 `unknown`），要 `as Record<string, unknown>`。
2. `PasswordEntry` 的备注字段是 **`notes`**，不是 `note`。
3. `app:notify` 只发通知不够——点通知要跳页，得同时加 `onAppNavigate`（`app:navigate` 通道），只加主进程发消息是收不到的。
4. 环境的数据源是 `wsGet('environments')`，`window.electronAPI.environmentsGetAll` 不存在。
5. `prefers-reduced-motion` 会把持续型进度动画冻在起始帧，需要单独给它 `busy-breathe`（见 `docs/agents/visual-system.md`）。
6. 静态债预算（`npm run check:debt`）对新增 CSS 生效：新写 `#fff`/`#000`/`!important` 会顶破预算，先找令牌（`--text-on-bad`、`--shadow-ink` 就是这批为它加的）。
