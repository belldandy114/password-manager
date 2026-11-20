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

### CSS 级联死声明门禁（2026-11-14）

`scripts/css-cascade-audit.js` 已进 `npm run check`（`ci-gate.js`）。它按
`src/main.tsx` 的真实加载顺序 `tokens → global → pages → redesign` 解析 4 份样式表，
按「at-rule 栈 + 选择器文本」分组，只清掉**被后面同组同名声明完全覆盖**的单条声明
（同选择器 ⇒ 同特异性、同命中元素，删除不改变级联结果）。

| 命令 | 作用 |
|---|---|
| `node scripts/css-cascade-audit.js` | 报告死声明数量，不阻断 |
| `node scripts/css-cascade-audit.js assert` | 门禁用：死声明 > 0 直接失败 |
| `node scripts/css-cascade-audit.js fix` | 清理并写入，写入前做「最终声明 0 差异」断言 |
| `node scripts/css-cascade-audit.js verify <旧 CSS 目录>` | 与清理前对比最终声明 |

守卫：跳过 `@keyframes`、涉及 `!important` 的声明、以及「旧值给 `color-mix()` / `clamp()` 等新函数兜底」的写法。
2026-11-14 首次运行删掉 926 条死声明 / 127 条空规则（-26.7 KB），
`check-css-dup.js` 的同名冲突从 309 组降到 231 组；剩下的 231 组是**各规则都还有独有声明**，
合并会改变同特异性插入规则的胜负，必须人工确认，脚本不碰。

改完 CSS 的验证顺序：`npm run check` → `npm run build:renderer` → 用 CDP 把同一份真实 DOM
分别注入旧/新 CSS，逐元素哈希 `getComputedStyle`（含 `::before/::after`），深浅主题各跑一遍。
首次清理实测 13 个页面 / 3158 + 3358 个元素 / 0 差异。

### CSS 层叠门禁（2026-11-20：z-index 令牌化 + 层叠上下文约束）

背景：**「下拉被吸顶表头压住」不是偶发**，是四类写法各自在不同地方犯了同一个病——
`z-index` 字面量随手写（42 条声明里曾有 41 条是数字，17 种取值）；容器类选择器上加了
`backdrop-filter|filter|transform|contain`（会**新建层叠上下文**，写在同一选择器上的
`z-index` 就变成「容器内部的天花板」，内部菜单再高也出不去）；`skip-link` 用了
`position: relative` 变成 flex 占位把侧栏挤偏。前两类已各配一条机械门禁。

| 命令 | 作用 |
|---|---|
| `node scripts/check-z-index.js` | 门禁用：`z-index:` 后直接跟数字（含负数）即失败 |
| `node scripts/check-z-index.js --self-test` | 自测 10 项，确认门能抓能放 |
| `node scripts/check-stacking.js` | 门禁用：容器类选择器同时出现上下文属性 + `z-index` 即失败 |
| `node scripts/check-stacking.js --self-test` | 自测 10 项 |

四条判据：

1. **层级表是唯一真源**：`tokens.css` 的 `3. Layers` 段有 25 个 `--z-*`，每个数值只出现
   一次，后面跟着「压谁 / 被谁压」的说明。新浮层从表里挑一层，不要发明新数字。
   确实需要新层 → 先改表，再改脚本白名单。
2. **容器不许自带层叠上下文**：容器类（class 名含 toolbar / sidebar / panel / card /
   section / header / rail / shell）同时带 `backdrop-filter|filter|transform|contain`
   与 `z-index` 会命中 R2。要透光用三家背景色（见 `--glass-*`），不要靠 `backdrop-filter`
   做层次。白名单必须写在样式的就地注解里并写理由（理由太短脚本不认），
   全局放行等于关掉这条门。
3. **两个门禁都先 `--self-test` 再跑真检查**（`ci-gate.js` 里各两步）：自测用内存样例验证
   「能抓到 / 不误报」，防止改脚本时把门写成永远绿。
4. **门只证明结构，不证明好看**：z-index 全走令牌 ≠ 层级顺序对。层序对不对要看
   「表头吸顶 + 工具栏下拉 + 命令面板 + 右键菜单」四个场景在真实窗口里的开合。

两条踩坑：

- **玻璃层（半透明底）一律用 `--glass-*`，不要在 `data-bg='image'` 分支里逐类补百分比**。
  这套 token 有深浅两套 + 图片档（`--glass-card / side / overlay / input / control`），
  切换背景只改 token 值。核对实测值时不要拿 `getPropertyValue('--glass-card')` 和
  `getComputedStyle().backgroundColor` 做**字符串比较**——自定义属性返回的是未解析的
  `color-mix()` 原文，会假红；用探针元素解析后再比。
- **`backdrop-filter` 在父层是实色时是死效果**（`.env-card-head` 就是），删掉不影响观感，
  但会让「图片模式下的白带」消失——这类删除属于视觉变化，改完要过一遍背景图模式。

## 1.24.3：菜单合并 / 测试数据（改这里前先看）

> 2026-11-14 从 `AGENTS.md` 末尾搬来，原文未改。原因：`AGENTS.md` 超出 65,536 B 预算，
> 这段正好落在被静默截断的尾部，会丢掉号段回退与正则预设两条注意事项。

- **「SQL 片段」与「测试笔记」已合并成一个菜单**（`notes`）。SQL 语句是 `Note.kind === 'sql'`，
  等宽显示 + 一键复制；普通笔记走 Markdown。旧 `snippets` 集合**保留不删**——笔记页首次打开时
  迁移（标记 `pm.notes.sql-merged-v1`），搜索面板用 `utils/notesMerge.ts` 合并新旧两处，
  迁移前后都能搜到。别把旧集合或迁移标记删掉，会丢历史数据。
- **17 类测试数据的唯一清单是 `src/utils/tdg/catalog.ts`**：左侧列表和全局搜索命令都从它派生。
  加类型只改这一处；搜索关键词写在 `kw`。`@data` / `@tdg` 只看测试数据，`data:身份证` / `data:phone`
  还能定位到某一类。两个搜索入口的 `perKind` 限量对 `data` 放宽到 20，否则 17 类会被截成 4 条。
- **「后 N 位」只在身份证 / 手机号有值**：结果表按 `items.some(i => i.last6)` 条件渲染整列，
  其它类型不再出现空列。导出侧的 `hasLast6()` 会自动跟随。填 0 表示不要这一列——
  `String.slice(-0)` 会返回整串，必须在生成时显式挡掉。
- `generateData({ id: 'phone' })` 不能解引用 `config.phone!.prefixes`：号段参数是可选的，
  缺省要用内置号段。空号段数组同样要回退（`phoneGenerator.ts` 里已处理）。
- 正则快捷预设复用 `utils/tdg/regexGenerator.ts` 的 `REGEX_PRESETS`（16 个），
  点击只回填输入框、之后仍可手改；别用 lookahead `(?=)`，randexp 不支持。


### CSS 死规则审计（2026-11-19）

删旧样式前先证明「没人用」，三步缺一不可：

1. **静态**：解析三份 CSS 的每条规则，取选择器里的类名，检查是否出现在 `src/**/*.{ts,tsx}` 与 `index.html`；
2. **动态前缀保护**：`env-${type}`、`is-${tone}`、`m-${method}` 这类拼出来的类名**不能算死**——先从源码里抽出
   `([A-Za-z][\w-]*)\$\{` 的前缀集合，命中前缀一律保留；
3. **运行时交叉验证**：逐页 `document.querySelectorAll(rule.selectorText)`，各页累计 0 匹配才算候选。

只删「选择器里**每个** class 都属于旧功能白名单」的规则（避免误删 `.live .dead` 这种复合写法）。本次删 160 条 / 19.8 KB：
`.envx`（旧环境矩阵表格）、`.wk-cmp*`（1.9.3 去掉的周对比）、`.pm-tab*` / `.settings-tab/group`（旧设置页签）、
`.api-layout/.api-sidebar/.api-url*`（旧接口页布局）、`.project-combo*` / `.sys-*`（旧项目选择器与系统视图）、
`.shot-viewer*`、`.tool-tabs`、`.page-loading`（已换骨架屏）等。产物 CSS 308.8 → 297.2 KB。

**剩下的 246 组同名选择器冲突不要碰**：同特异性、不同声明，删哪条都会改级联。要动就用
`scripts/css-cascade-audit.js`：它只清理「同选择器、被后面规则完全覆盖」的单条声明（当前 0 条），
`fix` 前会做最终声明等价的断言。

### CI 端到端冒烟（1.26.4）

`build-installer.js` 的第 4.2 步会跑 `scripts/smoke-test.js`（连接 win-unpacked 的远程调试端口，用真实 IPC
初始化密码 → 解锁 → 增删改查 → 回收站 → 设置 → 密码生成 → 锁定，13 条）。失败即中止，不会产出安装包；
排查构建本身的问题时用 `SKIP_SMOKE=1 npm run dist` 跳过。为什么放在这里而不是 `ci-gate.js`：
门禁在打包前跑，那时还没有 win-unpacked；而「打包产物能不能跑」只有产物出来才能验。
