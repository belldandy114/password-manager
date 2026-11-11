# testing（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

### 回归脚本现在的跑法（不再依赖内网与账号）

`ui-round2/3/4/5/9` 都会自动调用 `ensureZt()`：

- 配了 `ZT_BASEURL` / `ZT_ACCOUNT` / `ZT_PASSWORD` → 打真实禅道（分页、趋势图、缓存这些断言都会跑）；
- 没配 → 起本地桩，**与真实数据强相关的断言自动跳过并打印跳过原因**，其余照常跑。

所以本地/CI 上看到「12/12 通过 + 5 跳过」是正常的，不是漏测；要全量验证时先设环境变量。

`scripts/ui-round9-test.js` 覆盖本轮三项：cURL 导入/复制（含中文与错误输入）、异地备份（真的在第二目录落文件）、禅道三视图（断言 `openedBy=...&status=all` 与 `assignedTo=...&status=resolved`）。可用 `R9_ONLY=curl|backup|zentao` 单跑一段。


---

### 本轮回归脚本：`scripts/ui-round8-test.js`

模型看不到截图，所以样式类改动全部用**几何量**断言，不要只截图「看起来还行」：

- 周报下拉：`option` 顺序 + 「上周结束日 ≤ 今天」+ 本周区间包含今天；
- 设置页：`.set-rail` 竖排、左栏在左内容在右、内容宽度 > 640px、保存按钮在内容区右下、四个分组都能点开；
- 接口调试：地址栏圆角/边框、输入框融入（无独立底色）、断言行贴满内容宽、页签胶囊、`.code2` 圆角+行距、状态码药丸；
- 对比表：把同样结构注入真实页面，量**每列数字的右边界与对应表头是否吻合**（跨行还要一致）；
- 折叠：点 `.pnl-head.is-clickable` 能收起再展开。

这些断言都靠 computed style / `getBoundingClientRect`，跟主题无关，暗色亮色都成立。


---

### CI 门禁是怎么生效的（2026-11-09 更新）

CI 的「构建安装包」步骤跑 `node scripts/build-installer.js`，门禁装在**脚本**里而不是 workflow 里，
这样即使 workflow 文件因 token 缺 `workflow` scope 推不上去，现有 CI 也受保护。

`build-installer.js` 开头调用 `require('./ci-gate').runGate()`，顺序是：
隐私扫描 → `tsc --noEmit` → `vitest run` → IPC 契约 → CSS 重复选择器检查 → 静态债预算。
以前这里只有 tsc + vitest，隐私与 IPC 契约只能本地手动跑，容易漏。

两个「只许下降」的检查（2026-11-11 加）：

- `scripts/check-css-dup.js`：**只对「声明完全相同」的重复规则报错**（已清零），
  「声明不同」的重复照旧只打印清单 —— `global → pages → redesign` 的顺序覆盖是本项目的换肤手段，
  批量删会直接改掉视觉。
- `scripts/check-debt-budget.js`（`npm run check:debt`）：`!important` / 令牌之外的色值字面量 /
  `eslint-disable` 指令数三项预算（当前 64 / 207 / 15）。数字变大就失败；
  真要加就改脚本里的 `BUDGET` 并在提交说明写理由。同时要求每条 `eslint-disable` 写明规则名
  （仓库没装 ESLint，这些指令目前只是注释，写全了以后接 ESLint 才知道压的是什么）。

`src/pages/__tests__/pages.smoke.test.tsx` 覆盖 17 个页面「空数据 + IPC 全部 `{success:false}` 下挂载不炸」。
桩的关键两点：`onXxx` 类订阅接口必须返回退订函数（不是 Promise），其余返回 `{success:false}`——
回 `{success:true,data:[]}` 会让页面在 `.data.mirror.xxx` 这类路径上崩，那是桩的问题不是页面的问题。

`npm run check`（`preflight.js`）、`npm run regress`（`regress-all.js`）、CI 构建共用同一份 `ci-gate.js`；
`regress -- --pack` 会再跑 7 项打包版回归。任一步失败 → `process.exit(1)` → 不出包。
`SKIP_PREFLIGHT=1` 可临时跳过全部门禁（只用于排查构建问题，正式发版不要跳）。

- 为什么不直接写进 `build.yml`：本机 token 没有 `workflow` scope，推 workflow 改动会被服务端拒绝；
  完整的新工作流模板见 `scripts/ci-build.yml.recommended`。
- `npm run check` / `npm run check:pack` 是同一套门禁的手动入口；
  `npm run hooks:install` 会把它装成 git `pre-push` 钩子。


---

### 页面拆包与回归脚本的配合（注意，改这里很容易踩）

- 工作台页面全部 `React.lazy` + `Suspense`（`src/App.tsx`），**首次进页面是异步的**。
- 回归脚本里 `navTo` 必须「等占位消失 + 真页面出现」再断言：

```js
await ev(`...click nav...`);
for (let i = 0; i < 40; i++) {
  const ready = await ev(`(() => !document.querySelector('.page-loading') && !!document.querySelector('.pg'))()`);
  if (ready) break;
  await sleep(100);
}
```

  以前是定长 `sleep(800)`，在慢机器上会抓到上一页的 DOM（表现为随机几条失败，重跑又过）。
- 数据生成器（webview 子应用）仍走 `tdgMounted` 保活 + 独立 `Suspense`，**别改成随页面卸载**。
- `manualChunks`（`vite.config.ts`）把 react/scheduler 拆 `vendor-react`、zustand 拆 `vendor-state`；
  主包曾 793 KB → 331 KB → **现在 81.35 KB**（`pinyin-pro` 改成启动后 `import()` 的独立 chunk
  `esm-*.js` 287 KB，不进 `modulepreload`）。改这里之后 `dist/index.html` 的 modulepreload 列表
  不能出现 `esm-`，这是「拼音不占首屏」唯一的可测证据（见下一条）。

### 打包版探针（CDP）——三个会让你误判的坑

`scripts/ui-round16-test.js` 跑的是 `release/win-unpacked` 里的真程序，不是 vite dev。

1. **`file://` 下 `performance.getEntriesByType('resource')` 永远是空数组。**
   想验证「某个 chunk 有没有加载」不能看资源计时，要看两处：`dist/index.html` 实际引用的
   `link[rel=modulepreload]` / `script[src]`（首屏该不该有），以及**端到端行为**
   （比如拼音：造一条中文条目，搜首字母 `cdzhyz` 能命中，就说明 chunk 到位且索引重建过）。
2. **窗口没获得系统焦点时 `:focus` 不匹配**，但 `document.activeElement` 又确实是它 —— 于是
   `.skip-link` 的聚焦样式看起来「没生效」。连上 CDP 后先
   `Emulation.setFocusEmulationEnabled({ enabled: true })`。
3. **过渡动画要等一帧以上再读**：`getComputedStyle` 在同一帧返回的是动画起始值。
   测「聚焦后滑回视口」得 `await sleep(400)`（过渡 150ms），否则永远读到
   `matrix(1,0,0,1,0,-72.2812)`。
4. 用 `entriesAdd` 造数据时字段名是 **`name`**（不是 `title`），环境是 **`envType`**（不是 `env`）；
   写错不会报错，只是条目渲染成空名字、搜不到。UI 表单能写对，IPC 直写最容易错。
5. 直写 IPC 不会更新渲染层 store，要 `location.reload()` 再重新解锁（临时 profile 的主密码
   由探针自己设成 `Test@1234`）。

### 单元测试（vitest）

```bash
npm run test:unit        # vitest run，约 0.5s
npx vitest run src/utils/__tests__/csv.test.ts   # 单跑一个
```

- 测试放 `src/utils/__tests__/`，用 `.test.ts`；`tsconfig.json` 只 include `src`，所以测试也会被 `typecheck` 检查（**不要引入 node 类型**）。
- 主进程的纯函数想测就抽成 CJS 模块：`electron/csv.js` + `electron/csv.d.ts`（类型声明让渲染层单测能直接 `import`）。
  已经抽出去的是 `parseCsv` / `normalizeImportRecords` / `extractTotpSecret` / `IMPORT_FIELD_ALIASES`。
- 打包后还要确认「抽出去的模块真的进了 asar」：`npm run verify:packaged-csv`（4 项：导入可用 / 引号逗号 / 中文表头 / 标签与环境归一化）。

