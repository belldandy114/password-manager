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
隐私扫描 → `tsc --noEmit` → `vitest run` → IPC 契约 → CSS 重复选择器报告（只报告不阻断）。
以前这里只有 tsc + vitest，隐私与 IPC 契约只能本地手动跑，容易漏。

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
  主包曾 793 KB（有体积告警），现在 331 KB。

### 单元测试（vitest）

```bash
npm run test:unit        # vitest run，约 0.5s
npx vitest run src/utils/__tests__/csv.test.ts   # 单跑一个
```

- 测试放 `src/utils/__tests__/`，用 `.test.ts`；`tsconfig.json` 只 include `src`，所以测试也会被 `typecheck` 检查（**不要引入 node 类型**）。
- 主进程的纯函数想测就抽成 CJS 模块：`electron/csv.js` + `electron/csv.d.ts`（类型声明让渲染层单测能直接 `import`）。
  已经抽出去的是 `parseCsv` / `normalizeImportRecords` / `extractTotpSecret` / `IMPORT_FIELD_ALIASES`。
- 打包后还要确认「抽出去的模块真的进了 asar」：`npm run verify:packaged-csv`（4 项：导入可用 / 引号逗号 / 中文表头 / 标签与环境归一化）。

