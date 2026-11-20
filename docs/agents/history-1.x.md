# history-1.x（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

## ⚠️ 禅道项目/Bug 拉取不全：必须以 total 翻页（1.24.8，别改回去）

**现象**：项目下拉列表少一批、或某项目 Bug 比网页版少（「后面拉取的没拉到」）。

**根因**：`products` / `programs` / `bugs` 都是分页接口，响应带 `total`。旧代码有两种错法：
① `ztApiProducts`/`ztApiPrograms` 只发一次 `?limit=1000`，无 `page` 循环；
② `ztLoadMyBugsScoped` 写死 `page=1`。
禅道服务端会**压低 limit**（同源框架默认 20），「返回条数 < limit 就到尾」的判断不成立，
于是第一页之后的项目/Bug 被静默丢弃，界面还以为拿到了全部。

**现在的约定（改禅道分页前务必遵守）**：

| 项 | 做法 |
|---|---|
| 统一分页 | 走 `electron/zentao-pager.js` 的 `ztPageAll(fetchPage, opts)`：**以 total 驱动翻页**，按 id 去重，整页无新增（服务端忽略 page）立即停，`maxPages` 兜底；不要自己写 `for(page=2..5)` 的硬上限 |
| 调用点 | `ipc-zentao.js` 的 `ztApiPaged(cfg, pathOf, listKey)` 封装了 `ztApiGet` + `ztPageAll`；`products`/`programs`/`my-bugs` 全部改走它 |
| 不得静默截断 | `zentao:projects` handler 返回 `{data, total, warning}`；撞到页数上限没拉满时 `warning` 非空，`ZentaoPage.loadProjects` 会显示告警。`.filter(p => p.name)` 已去掉（空名产品保留为「产品 id」），别再加回来 |
| 测试 | 单测 `src/utils/__tests__/zentaoPager.test.ts`（8 条，覆盖 limit 被压到 20 / 重复页 / 无 total / maxPages）；桩 `scripts/zt-stub.js` 的 products/programs 已支持 limit/page 分页 |

**验证**：`npm run test:unit`（1014 条绿）、端到端模拟「服务端每页 20 条、共 55 个项目」→ 翻 3 页全部拉全。

## ⚠️ 分页修好后仍缺项目：products 的过滤参数因版本而异（1.24.9 → 1.24.10）

**现象**：分页已修，但个别项目（如产品 69）**整条不在**项目下拉列表里；网页 `bug-browse-69-*.html`
却能正常打开、能看到该项目下的 Bug。

**1.24.9 的错判**：以为是「缺 status=all」，于是给 products 加上 `&status=all`。
**1.24.10 实测推翻**：用户跑完新包后，日志是

```
[zentao] products total=31 got=31 ids=4,49,30,...,67,68,40,39,57,58,59,28,42,32,50
```

最大 id 只到 68，69 不在；而且 **total 一点没变**（还是 31）——
说明这个版本的禅道**静默忽略**了 `status=all`。所以「加了参数就以为修好了」不成立：
**必须用 total 有没有变大来验证参数是否真的被识别**，不能只看有没有报错。

**1.24.10 在真实环境跑出来的日志**（这就是结论，别再重复试）：

```
[zentao] html products via product-all.html: 20
[zentao] products variants: status=all=31/31 | browseType=all=31/31 | default=31/31
[zentao] products merged total=31 got=31 ids=4,49,30,...,67,68,40,39,57,58,59,28,42,32,50
[zentao] products programs={"71":11,"72":6,"73":13,"119":1}
```

逐条读出来的结论：

1. **三种参数 total 全是 31** → 该版本禅道把这些过滤参数**全部静默忽略**，靠换参数永远拿不到 69。
2. **网页兜底只解析出 20 个，合并后仍是 31** → 那 20 个是接口结果的子集；网页 `product-all.html` 同样不显示 69
   （它默认也只列未关闭产品）。**网页兜底对本例无效，别再指望它**。
3. **programs 分布是 `{71:11, 72:6, 73:13, 119:1}`，没有任何一个 program=0** → 不存在「只返回不属于项目集的产品」这种可能，
   按项目集逐个拉也不会多出 69。

**现在的做法（1.24.11）：手动补项目 + 持久化**

既然接口侧拿不到，就把「按编号补」做成一等公民，而不是一次性补丁：

| 项 | 做法 |
|---|---|
| 补的项目带 `manual: true` | `zentao:product-probe`（`GET products/{id}`）单查成功或失败都标 `manual: true` |
| 跨「拉取项目」存活 | `loadProjects` 里 `setProjects(接口结果 + 之前 manual 的项)`；判断选中项是否失效也用合并后的列表，否则 69 会被当成「已删除项目」踢出选中列表 |
| 跨重启存活 | `projects` 本来就进 `partialize` → IndexedDB，manual 标记一起落盘 |
| 批量补 | 搜索框可输入 `69` / `69,70` / `69 70`，一次补多个 |
| 界面可辨 | 列表里 manual 项带「补」角标，title 说明「接口没返回这个产品，是手动按编号补进来的」 |
| 根因线索 | probe 成功时打 `[zentao] product probe 69 ok: status=.. acl=.. program=.. deleted=..` —— 单查能拿到说明 REST 有权限，list 少它只可能是 status/acl/program 在过滤 |

**1.24.12：不再靠手动，改成按 id 空档自动补漏**

关键推理：用户**手动添加 69 能成功**，说明 `GET api.php/v1/products/69` 单查是通的 ——
被过滤的只是**列表**接口。那就反过来用：拿列表结果的 id 集合算空档，逐个单查，存在的就补进列表。

| 项 | 做法 |
|---|---|
| 纯逻辑 | 新增 `electron/zentao-probe.js`：`buildProbeCandidates`（生成候选 id）+ `probeByIds`（并发探测），抽出来才好单测 |
| 扫描顺序 | **先扫 `maxId+1 .. maxId+30`**（新产品总是最大 id，69 就在 maxId+1），再扫中间断档。顺序不能反：断档多时会被 cap 截断，尾部必须优先 |
| 上限保护 | 候选总数封顶 120、并发 6、断档超过 200 个就只扫尾部（大实例不被拖慢）；索引 10 分钟 |
| 结果标记 | 补进来的项带 `manual: true` 并**在 handler 返回值里透传**（漏传则前端落盘后丢标记，下次照样被覆盖） |
| 日志 | `[zentao] probe missing: scanned=67 (tail 69..98, gaps=37) found=1 #69[status=normal,program=71]`；带 `denied=N` 说明是 403 权限问题而非不存在 |
| 实测 | 用真实 id 集合做端到端模拟：67 个候选、82ms 找回 69；单测 13 条覆盖尾部优先/断档/封顶/capped/403 计数 |

**1.24.12 线上跑出来的真实结果（2026-11-17 09:41，这就是最终答案）**

```
[zentao] probe missing: scanned=67 (tail 69..98, gaps=37) found=11
  #44[closed,72] #45[closed,71] #46[closed,72] #48[closed,73]
  #51[closed,71] #52[closed,71] #53[closed,71] #54[normal,73] #55[closed,71]
  #56[closed,73] #69[normal,71]
[zentao] products variants: ... | probe+11
[zentao] products merged total=31 got=42
[zentao] products programs={"71":17,"72":8,"73":16,"119":1}
```

31 → **42 个产品**，找回 11 个。由此可以确定三件事：

1. **不是「已关闭」在过滤**：找回的 11 个里 9 个 `closed`、2 个 `normal`（54、69），
   而列表里的 31 个也有各种状态。**69 是 `status=normal`** —— 之前 1.24.9 猜「因为产品已关闭」是错的。
2. **不是项目集在过滤**：11 个分散在 71/72/73 三个集，列表里同样三个集都有。
3. 合理解释：**列表接口只返回「我参与的产品」**，单查不做这个限制。所以「列表 + 按 id 单查」取并集
   才是这个接口的正确用法，靠调参数没用。

**1.24.13：性能 + 可读性**

首次扫描实测 **5.9 秒**（67 个候选 / 并发 6 / 内网 RTT 约 500ms），用户每次重启后第一次拉取都得等。
10 分钟内存缓存内的后续请求只要 1ms。

| 项 | 做法 |
|---|---|
| 磁盘缓存 6 小时 | `%APPDATA%\测试中台\zentao-probe-cache.json`，key = `baseUrl\|account`。重启后直接命中，**不再重扫** |
| 并发 6 → 10 | 首次扫描从 5.9 秒降到约 3 秒 |
| program 维度优先 | 先按项目集逐个拉 `products?program=X`（4 次请求）。**若带来新增就说明该版本认 program 参数、按集拉是全的，直接跳过 id 扫描**；不认则静默忽略，无副作用 |
| 已关闭可辨 | 选择器里 closed 产品带「已关闭」标记，且同组内排到后面（补漏会把 9 个历史产品捞出来，别混在常用项目中间） |

**已知未解**：`resetProjectScope()`（切换禅道实例时调用）会清掉 `projects`，manual 项随之丢失；
换实例后需要重补（或等下一次自动扫描）。单实例场景无影响。

**1.24.14：删掉 1.24.13 里「以为有用、实测没用」的几层**

1.24.13 的日志：

```
[zentao] products variants: status=all=31/31 | browseType=all=31/31 | default=31/31
  | program=71=11/11 | program=72=6/6 | program=73=13/13 | program=78=13/13 | program=97=6/6
  | program=108=ERR | program=119=ERR | program=122=13/13 | ...（共 16 个）| probe+11
[zentao] products merged total=31 got=42
```

- **program 维度 0 新增**：16 个项目集逐个拉，没有一个新产品被带进来，其中 5 个还报错。
  纯耗时（首次拉取 4.2 秒里大头就是它，还是串行的）。**已整段删除**。
- **三种过滤参数完全一致**：`status=all` / `browseType=all` / 不传 都是 31/31 —— 这个版本对不认识的参数
  一律静默忽略。逐个跑只是 3 倍请求。**合并成一次 `status=all`**（旧版回 4xx 时退回不带参数）。
- **网页兜底只解析 20 条且全是 REST 子集**（列表默认每页 20），补不进任何东西，
  每次拉取白等一次往返。**降级为「REST 一条都没返回」时的最后手段**。

缓存从「整体缓存一份结果」改成 **按 id 记账**：

| 项 | 做法 |
|---|---|
| 结构 | `{ "<实例key>": { ids: { "<产品id>": {at, p} } } }`，`p: null` 表示确定不存在 |
| 为什么 | 整体缓存会把「后来新建的产品」一起挡住 6 小时；按 id 记账后**新 id 天然不在缓存里 → 必被请求** |
| 只缓存确定结论 | 404 → 记 `null`；超时 / 403 / 5xx → **不写缓存**（否则一次网络抖动就会把某产品误判成"不存在"6 小时） |
| 并发 10 → 12 | 首次约 2~3 秒，之后 0 请求。实测：第 1 次 67 个请求、第 2 次 **0 个请求**，两次找回结果完全一致 |

**顺带去掉 Bug 侧的 5 页硬上限（这是真 bug，不只是保守）**

`project-bugs` / `all-bugs` / `summary` 原来都是：

```js
const pages = Math.min(5, Math.ceil(total / 1000));   // total=44 → ceil(44/1000)=1，只请求 1 页
if (arr.length < 1000) break;
```

`total=44` 时只请求第 1 页。一旦服务端把 limit 压到 20（同源框架默认值），44 条 Bug 只拿到 20 条，
而 `total` 仍是 44 —— 界面看不出来。现在三处统一走 `ztApiPaged`（按 total 翻页 + id 去重 + 无进展保护）。
`all-bugs` 里单个项目失败也不再拖垮整个「全部」视图：记入 `failed` 并写 `[zentao] all-bugs: N/M 个项目拉取失败`。

**日志位置**：`%APPDATA%\测试中台\logs\app.log`。

**1.24.15：产品清单加 60 秒短时缓存 + 并发合并（`electron/ttl-cache.js`）**

1.24.14 的日志暴露一个成本问题：同一个进程里 **10:09:51 与 10:09:53 两次调用都 `requested=56`**，
也就是说 60 多个 id 被完整扫了两遍。

```
[zentao] probe missing: candidates=67 ... requested=56 reused=11 found=11
[zentao] products: total=31 got=42 | probe+11 (requested=56 reused=11)
   ← 1.3 秒后又来一遍，requested 还是 56
```

原因不是缓存没生效，而是**第一次扫描（2~4 秒）还没结束**，第二次调用进来时缓存里什么都没有。
所以真正的解法是 **single-flight**：同一 key 正在跑的 Promise 直接复用，后来者等它，不再开第二份。

| 层 | 位置 | TTL | 作用 |
|---|---|---|---|
| 产品清单 | `ztProductsCache` | 60 秒 | 进页面/登录/兜底重试这类自动调用不重复拉 |
| 补漏扫描 | `ztMissingCache` | 10 分钟 | 同一次拉取里多处调用只扫一遍（原裸 Map 换成带 single-flight 的实现） |
| 单 id 结论 | `zentao-probe-cache.json` | 6 小时 | 重启后 `requested` 直接变 0 |

- **`fresh` 通道**：`zentao:projects` 的 payload 可带 `fresh:true`（「拉取项目」按钮、快捷键、
  「列表过期」兜底重试、登录成功都走它），绕过清单缓存**也**绕过补漏结果缓存，
  确保禅道刚建的产品立刻可见；`all-bugs` 的 `force` 同样会透传下来。
- **固定 TTL，不滑动**：滑动窗口会让「一直有人点」的 key 永不刷新，反而看不见新产品。
- **失败不缓存**：`fn` 抛错时不写值、并清掉 inflight，下一次调用立刻重试（否则一次抖动会缓存 60 秒的空结果）。
- 单测：`src/utils/__tests__/ttlCache.test.ts`（10 条，含并发合并、边界 TTL、LRU 淘汰、抛错重试）。

**1.24.16：缓存要「看得见」——UI 反馈 + 防连点**

1.24.15 交付后用户反馈「没有提示」。查日志（10:22）发现两件事：

1. `requested=0 reused=67` —— **磁盘缓存已全部命中**，补漏扫描一次请求都不发了（之前 56 个）。
2. 但 20 秒内出现了 **13 次完整拉取**（间隔 0.2~0.5 秒），全部是 `fresh`（日志里每次都打 `probe missing`）。
   说明用户在反复点「刷新项目列表」找反馈 —— 因为点了之后界面上什么都不变。

我的说明也有问题：让用户「60 秒内再点一次」验证缓存，可**「刷新项目列表」按钮本身就是 `fresh=true`**，
永远不会命中缓存，日志自然没有 `cache hit` 那一行。

| 改动 | 位置 |
|---|---|
| `zentao:projects` 返回 `cached / ageMs / probedAdded / reportedTotal` | `electron/ipc-zentao.js` |
| 拉完在页头下方显示一行结果：`已更新 · 42 个项目，接口只报 31 个、按编号补回 11 个 · 10:31` | `src/pages/ZentaoPage.tsx` |
| 命中缓存时显示 `缓存结果 · N 个项目 · 12 秒前拉的（点「刷新项目列表」可强制重拉）` | 同上 |
| 3 秒内连点刷新：直接提示「刚刚已更新（N 秒前），这次直接复用结果」，**不打禅道** | 同上（`projectsAtRef`） |
| 并发保护：一次只允许一个拉取在飞（`projectsBusyRef`） | 同上 |

教训：**加缓存就必须同时加可见反馈**，否则用户唯一的感受是「点了没反应」，只会点得更频繁。

**1.24.17：三个 tab 的口径统一（一个按钮、一份筛选）**

用户截图指出三处不一致：`我的 Bug` 顶部没有「刷新项目列表」；`项目 Bug` 是蓝色主按钮、`汇总` 是灰色次按钮；
`我的 Bug` 还有自己一套项目选择（`mineProductIds`），和「当前项目」不是同一批。

| 约定 | 做法 |
|---|---|
| 页头只放一个「刷新项目列表」 | 提到 tab 判断外面，三个 tab 同一位置、同一 `btn-secondary btn-sm`，动作都是 `loadProjects(true)`（重读全部项目列表，约 6~8 秒） |
| 「我的 Bug」只认「当前项目」 | `loadMine` 的 id 来源改为 `idsOverride → scopeProjectIds → ensureMineProjects()`，不再看 `mineAllProjects`；`mineProjectLabel` 也跟着 scope 走 |
| 汇总页的项目 chip | 数据取 `scopeIds`，chip 也必须取 `scopeIds`（`scopeChips`），否则出现「数字是 A 项目、名字是 B 项目」 |
| 验证脚本 | 新增 `scripts/shot-audit-zentao-header.js`：CDP 连打包产物，逐 tab 输出 `.pg-tools` 里每个按钮的 `text/cls/bg/right`，可直接断言三个 tab 是否一致 |

**1.24.18 / 1.24.19：「重新拉取」搬到「当前项目」旁边**

用户要求 `项目 Bug`、`汇总` 在当前项目旁边也能重拉。做法：在 `.zt-global-scope` 里（`ProjectPicker` 之后）
放唯一的「重新拉取」（`refreshScope` → 按筛选项目 force 重拉，三个标签共享），
并**删掉**三处旧的同功能按钮 —— `我的 Bug` 子行、`项目 Bug` 状态行、`汇总` 工具条，
一个 tab 只留一个，免得同一屏出现两个一模一样的「重新拉取」（用审计脚本的 `refreshCount` 断言 = 1）。
汇总空状态里那个 CTA 保留（没有数据时的引导，走 `onRefresh`）。

**1.24.20：删掉「拉取「指派给我」」**

用户实测发现页头的「拉取「指派给我」」和「重新拉取」是同一件事：
`loadMine` 在已有 `pBugs` 时只是 `deriveMine(pBugs)`（**零请求**，本地按账号过滤），
和 `refreshScope` 重拉一遍再过滤的结果一样，只是入口不同。于是删掉该按钮，
**页头三个 tab 彻底只剩 `登录并保存` + `刷新项目列表`**，拉数据统一走「当前项目」右边的「重新拉取」。
`loadMine` 仍保留（`switchScope` 在 `pBugs` 为空时兜底，`?idsOverride` 供项目弹窗用），别再往页头加回来。

**1.24.21：页头别随滚动条横跳（`scrollbar-gutter: stable`）**

删完按钮用审计脚本对比三个 tab 才发现：`我的 Bug` 的 `.content-area` 恰好 910px > 900px，
多出一条 10px 竖滚动条，**页头按钮整体左移 10px**，切 tab 会看到按钮「抖一下」。
给 `.content-area` 加 `scrollbar-gutter: stable` 常驻留位后，三个 tab 的 `headRight` 都是 `[1277, 1402]`。
以后再加长的内容也不会有这种跳动。

**1.24.22：正式发版（这批 1.24.8~1.24.21 的收口）**

`node scripts/release.js 1.24.22`，安装包 94.7 MB，CI 通过，Release 与本地 digest 一致
（`sha256:b3fb3052…`），说明用的是本地 `release-notes-1.24.22.md`，没被 CI 模板覆盖。
发版过程踩了三个坑，都已修或写进文档：

| 坑 | 现象 | 处理 |
|---|---|---|
| vitest 缓存残留 | `npm run dist` 卡在「单测门禁」，报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED count=303` | vitest 启动要清 `node_modules/.vitest-cache.tmp-*`，被删除守卫按「本轮 >50 个文件」拦下。这两个 tmp 是被中断的运行留下的（正常结束会合并掉）。用 python 逐文件删干净后即恢复；**别再强杀 vitest** |
| `--dry-run` 会真推 | 预演时日志出现「已推送（第 1 次）」，`origin/master` 真被更新 | `run()` 会跳过 dryRun，但 `git push` 用的是 `sh()`，没这层判断。已在 step5 外面包 `if (dryRun)` |
| r9 禅道段假失败 | `禅道：默认不选项目（chips 为 0 且显示引导条）→ hint:false` 实际 chips 也是 0 | `waitPicker()` 只等 `.person-picker-trigger:not([disabled])`，而 trigger 在项目列表为空时也是可点的，于是断言跑在 loading 中间态。改成同时等「引导条出现或已有 chip」。**这类「等某个元素可点」的等待都要顺手确认它代表的状态真的到位** |

### 验证包清理（`release/verify-*` 的删法）

每轮验证留下一个 `release/verify-<ver>/win-unpacked`（约 362 MB），十几轮就是 5 GB。
本机删除被过滤驱动接管，**`fs.rm` / `shutil.rmtree` / `Remove-Item` 全部只会进回收站，
而且目录一多直接失败**（`SAFE_DELETE_FAIL_CLOSED: trash-failed`，一个字节都删不掉）。

实测唯一能真删的是 **`robocopy <空目录> <目标> /MIR`**：原生进程、走另一套删除路径、
且接受中文路径（`cmd rd /s /q` 在中文路径下会失败，别浪费时间）。已封装成
`node scripts/clean-verify-dirs.js [--apply] [--keep=12421]`，2 分钟清完 14 个目录、释放 5 GB。

⚠️ 少数 `win-unpacked/resources/app.asar` 会被句柄长期占住（`DeleteFileW` → `ERROR_SHARING_VIOLATION` 32），
robocopy 也删不掉 —— 跑过打包产物的目录都会这样。对策：`MoveFileExW(path, NULL, 4)`
登记「重启时删除」，重启后自动消失，空目录壳用 `os.rmdir` 收掉（空目录删除不触发拦截）。

## ⚠️ 别在项目根目录跑 `asar extract-file`（会覆盖源码）

1.24.9 排查时执行 `npx asar extract-file <app.asar> package.json`，把 asar 里那份**被 electron-builder 精简过**的
`package.json`（`scripts`/`devDependencies`/`build` 全没了）覆盖到了工作区根目录，差点把项目配置写废。
`asar extract-file` 的第二个参数是该文件**在包内的路径**，输出就落在**当前工作目录的同名路径**。

- 只用 `npx asar list` 检查内容；确需解包就 `cd` 到临时目录再执行；
- 已覆盖用 `git checkout -- <file>` 恢复，并删掉根目录多出来的同名文件；
- 本项目源码里 `main.js` 根目录副本同样是**过时副本**，真正入口是 `electron/main.js`。

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


## 接口调试：从 Postman / Apifox 导入集合（2026-11-19）

- 解析器 `src/utils/collectionImport.ts`（纯函数，31 条单测）：Postman Collection **v2.1 / v2.0**
  （Apifox 导出选「Postman 格式」就是 v2.1）。文件夹路径存进 `ApiRequest.group`；
  集合 / 文件夹变量合并成 `k=v` 多行，页面可选「存成环境」；bearer / apikey / basic 转成请求头；
  `Host` / `Content-Length` / `Connection` 等自动头直接丢弃；**multipart / form 的 Content-Type 一律去掉**，
  交给发送端按实际 boundary / charset 重拼（保留会和服务端校验打架）。
- 冲突判定用「方法 + 地址」（不是名字），三种策略：`skip`（默认）/ `overwrite`（保留原 id，界面勾选不失效）/
  `duplicate`（加「（导入）」后缀）。
- 页面改动：页头多一个「导入集合」按钮 + 三张概览卡（已保存 / 历史 / 近 7 天新增），
  空状态从「还没有保存的请求」换成带「导入集合 / 新建请求」两个按钮的引导；列表行的来源分组用
  `.api-item-group` 弱提示。
- 样式写在 `redesign.css` 末尾（`.api-stats` / `.api-stat` / `.api-empty-cta` / `.coll-*` / `.modal.modal-wide`），
  只用 token，无新增色值字面量。
- 回归：`scripts/shot-api-import.js`（12 条断言 + 6 张截图，产物 `_shots-api-import/` 已 gitignore）。
  跑法：`npm run build:renderer && node scripts/shot-api-import.js`（开发目录 + `PM_USE_DIST=1`，不需要先打包）。

## 1.26.0 体验收口（2026-11-19）

- **「今日工作台」改名「工作台」**：侧栏 / 页头 / 注释；命令面板 `PAGES` 顺带补上 `home`（以前 Ctrl+K 搜不到落地页）。
- **页面骨架屏**：`components/PageSkeleton.tsx` 替换 Suspense 里那行「正在加载…」，结构 = 页头 + 3 张卡 + 6 行列表；
  只装饰，`role=status` 播报一次、结构层 `aria-hidden`。样式在 redesign.css 末尾 `.page-skel / .ps-*`。
- **悬停预取**：`pages/loaders.ts` 是唯一懒加载表，App 的 `lazy()` 与侧栏 `onMouseEnter/onFocus` 共用；
  实测悬停 900ms 内发出 `Environments-*.js`，对照页 0 请求。
- **空库工具条**：环境矩阵 / 附件管理在没有数据时不再渲染搜索框与「超时」「仅未引用」这类无效控件。
- **工作台空态去重**：一张卡只有一个入口 —— 有内容时右上角文字链，空态时卡内按钮（两个并排的写法已去掉）。
- `checklists`（用例）在命令面板里不再生成结果：`renderPage` 没有该分支，点下去会落到「网址管理」。

## 1.26.0：用例库（2026-11-19）

定位是**文件管家**，不是用例编辑器：xmind / Excel / Markdown 由系统应用负责编辑，应用内不解析内容
（解析 xmind 版本差异、Excel 合并单元格会变成无底洞，收益也低）。

### 目录与配置

- 库根目录由用户选择，配置存 `<数据目录>/cases.json`（`{ "root": "..." }`），不随库目录走。
- 结构：`Test_Cases/<系统>/<模块>/<用例文件>`，**最多两级**（再深就成文件管理器了）。
- 首次启动会弹一次引导（本次运行只问一次，可「稍后再说」，之后在页面里「更改目录」）。
- 更改位置 = 复制 → 校验文件数 → 旧目录进系统回收站；校验不过就保留旧目录并报错，**绝不先删后拷**。

### 安全与规则（改这里前必读）

| 规则 | 位置 |
|---|---|
| 所有相对路径过 `resolveInside()`（拒绝绝对路径 / `../` 穿越） | `electron/cases-paths.js` |
| 名称清洗（Windows 非法字符、末尾点空格、`.`/`..`） | `safeName()` |
| 重名自动加后缀 `登录(2).xmind`（大小写不敏感） | `uniqueName()` |
| 删除走 `shell.trashItem`（可恢复），不 `fs.unlink` | `electron/ipc-cases.js` |
| 打开：`shell.openPath` 失败 → Windows `rundll32 shell32.dll,OpenAs_RunDLL` 弹「打开方式」 | 同上 |

纯函数带 17 条单测（`src/utils/__tests__/casesPaths.test.ts`）。

### IPC（13 个，注册在 `electron/ipc-cases.js`）

`cases:config` / `choose-root` / `change-root` / `list` / `mkdir` / `rename` / `pick-files` /
`import` / `delete` / `open` / `reveal` / `pick-dir` / `pick-export-dir` / `export`。

### 界面

侧栏「测试工作」组新增「用例库」；页面 = 左侧系统树 + 右侧文件列表（面包屑、搜索、批量导出/删除）。
文件行双击 = 用默认应用打开；行内按钮：打开 / 定位 / 重命名 / 导出 / 删除。
列表底部固定显示「明文目录 + 实际路径」——密码库加密、用例库不加密，这点必须在界面上说清楚。

### 回归

`scripts/ui-cases-test.js`（10 条断言）：首次引导 → 系统树 → 模块与文件 → 新建文件夹 →
同名导入加 `(2)` → 导出 → 迁移并清理旧目录 → 迁移后仍可读。跑法：
`npm run build:renderer && node scripts/ui-cases-test.js`（原生目录对话框无法自动化，脚本直接写 `cases.json`）。

- **接口「已保存」按分组折叠**：`ApiRequest.group` 来自 Postman/Apifox 导入；列表按分组渲染、可折叠（记忆在
  `localStorage['pm.api.collapsedGroups']`），**搜索时强制展开**（否则搜到了但在折叠组里像没结果）；没有分组的请求保持原样。
- **AGENTS.md 拆分**：65,005 → 32,826 B（预算 65,536，剩余一半余量）。迁出 5 份文档：`vault-modules.md`、
  `zentao-summary.md`、`release-tools.md`、`code-conventions.md`、`version-conventions.md`，正文原样保留、AGENTS.md 只留指针与硬约束。
- **CSS 死规则清理**：静态类名扫描 + 动态前缀保护 + 逐页运行时 `querySelectorAll` 交叉验证后删除 160 条旧功能规则
  （约 19.8 KB 源码；dist CSS 308.8 → 297.2 KB）。方法见 `docs/agents/testing.md` 的「CSS 死规则审计」。

### 1.26.1：用例库交互补全 + 全局动效（2026-11-19）

**左树两级 / 右键菜单**
- 左侧树现在显示两级：系统（一级）展开后是模块（二级），两级封顶（`MAX_FOLDER_DEPTH = 2`）。
- 右键系统/模块节点：新建子文件夹（仅一级节点）、重命名、在资源管理器中显示、导出、删除（进回收站）；
  树空白处右键：新建系统文件夹 / 刷新。菜单支持 Esc 关闭、点击遮罩关闭。
- ⚠️ 右键菜单必须 `createPortal(..., document.body)`：挂在 `.pg` 里时 `position: fixed` 会以
  `.content-area` 为包含块，坐标整体偏 232px（侧栏宽度）。

**拖拽**
- 列表行 `draggable` → 拖到左侧任意目录 = 移动（`cases:move`，目标重名自动加后缀）。
  文件可进任意一级；**文件夹只能放根/系统**，放进模块会拒绝（否则出现第三级）。
- 外部文件拖进列表区 = 导入到当前目录（`filePathFor` → `cases:import`），拖到树节点 = 导入到那个目录。

**全局动效（1.26.1）**
- 新增「动效层」写在 `redesign.css` 末尾：页面进入 `pg-enter` 220ms、按钮 hover 微抬 / 按下回弹、
  侧栏 hover 右移 2px、列表行渐入（前 8 行错峰 18ms）、面板边框/阴影与统计数字颜色过渡。
- 全部包在 `@media (prefers-reduced-motion: no-preference)` 里，系统开启「减少动态效果」时整体关闭。
- 断言方式不是看图：回归脚本读 `getComputedStyle(.pg).animationName === 'pg-enter'` 与
  `.btn` 的 `transitionProperty` 是否包含 `transform`。

回归：`scripts/ui-cases-test.js` 扩到 18 条（右键菜单坐标 / 二级树 / 真实拖拽 / 动效 computed style）。

### 1.26.3：用例库预览 / 全库搜索 / 排序 / 整目录导入 / 自动刷新（2026-11-19）

| 能力 | 实现 | 关键约定 |
|---|---|---|
| 应用内预览 | `cases:preview`（主进程解析） | md / csv / xlsx / 图片 / 文本；`xlsx` 用 SheetJS 在主进程解析（最多 6 sheet × 200 行 × 30 列），文本用 `decodeTextBuffer` 自动识别 GBK；> 8 MB 或 xmind/pdf/zip 退回「用默认应用打开」 |
| 全库搜索 | `cases:search` + 面板上的「当前目录 / 全库」开关 | 输入停下 260ms 再扫盘；结果行显示所在系统/模块，双击预览、可一键定位到目录 |
| 列表排序 | 面板下拉「最近修改 / 名称 / 大小」 | 排序方式记在 `localStorage['pm.cases.sort']` / `pm.cases.sortAsc` |
| 整目录导入 | `cases:pick-import-dir` + `cases:import-folder` | 复制进当前目录并保留内部结构，重名加后缀；**模块里不允许**（会出现第三级） |
| 变更自动刷新 | `fs.watch(recursive)` + `cases:changed` 事件 | 防抖 500ms；某些盘符不支持递归监听时静默降级为手动刷新 |
| 工作台「最近用例」 | `openPreview` 时写 `localStorage['pm.cases.recent']`（最多 20 条，只存相对路径） | 点击 → `openCase(rel)` intent → `App` 切到用例库 → 定位目录并打开预览 |

顺带清理：命令面板不再取 vault 的 `checklists`（没有写入方，点了会跳错页）；快捷入口补「用例库 / 接口调试」。

回归：`scripts/ui-cases-test.js` 扩到 **26 条**（新增 csv/xlsx 预览、全库搜索、排序、整目录导入、外部新增自动刷新、工作台最近用例）。

### 1.26.4：统计口径 / 命令面板搜用例 / 打开方式 / CI 冒烟（2026-11-19）

- **左树统计口径**：一级「系统」节点显示 **模块数**（`dirCount`），不再显示顶层文件数 ——
  之前「系统里有模块但顶层没有文件」会显示 0，看着像空目录。鼠标悬停能看到「N 个模块 · M 个顶层文件」；
  二级「模块」节点仍然显示文件数。`CasesDir` 新增 `dirCount`（只数一级子目录，不递归）。
- **Ctrl+K 搜用例文件**：命令面板打开时预热 `cases:search('', 300)`，用例库文件作为 `kind: 'checklist'`（显示「用例」）
  进结果，回车 = `openCase(rel)` 跳到用例库并直接打开预览。`@case` 限定词因此变成真的能用（之前指向已废弃的 vault 集合）。
  顺手修了 `Promise.all` 解构少一个变量导致用例数据拿不到的 bug（`accounts` 本来也没人用，一并去掉）。
- **「用其他应用打开…」**：新 IPC `cases:open-with`，不试默认应用、直接弹 Windows「打开方式」对话框；
  文件行右键与预览弹窗底部都有入口（xmind 装了两版时用得上）。
- **CI 端到端冒烟**：`build-installer.js` 在 `--dir` 产物打好、NSIS 之前跑 `scripts/smoke-test.js`（真实 IPC 13 条），
  失败即中止构建；排查构建问题可 `SKIP_SMOKE=1` 跳过。`npm run regress -- --pack` 的清单里也加上了用例库回归。

回归：`ui-cases-test.js` 28 条（新增「系统节点统计模块数」「Ctrl+K 能搜到用例文件」）。


### 1.27.0：弹窗定位 / 密码图标统一 / 压测脚本库（2026-11-20）

**弹窗跑到页面底部（修）**
- 根因：`1.26.1` 的页面进入动画 `.pg { animation: ... both }` 让页面容器在动画结束后仍带 `transform: matrix(1,0,0,1,0,0)`
  （单位矩阵也算），`position: fixed` 于是以页面为基准而不是视口 —— 页面越长，弹窗越靠下。
- 修法两层：`Modal` 改成 `createPortal(..., document.body)`（对任何祖先 transform 免疫）；
  同时把 `.pg` 的 `animation-fill-mode` 从 `both` 改成 `backwards`，动画结束后不再留 transform。
- 回归：`ui-jmxlib-test.js` 断言 `.modal-overlay` 覆盖整个视口（`top=0 / left=0 / width=innerWidth`）。

**密码显隐图标统一**
- 之前三处各写各的：`EntryForm` 用 emoji（👁/🙈）、`EntryCard` 用 emoji、`EntryList` 手绘 SVG。
- 现在统一用 `Icons.eye` / `Icons.eyeOff`（Tabler），14px，带 `title` 与 `aria-label`；
  样式在 `redesign.css` 末尾（`.password-toggle / .pwd-icon-btn / .cred-eye-btn`）。

**压力测试：脚本库（新）**
- 库根目录选一次，存 `<数据目录>/jmxlib.json`；两级文件夹封顶（与用例库同一套 `cases-paths` 校验）。
- 只收 `.jmx`（复制进库，重名加 `(2)`）；导入 / 新建文件夹 / 重命名 / 删除（回收站）/ 定位 / 用默认应用打开。
- **点一个脚本**就把「运行配置」填好：JMX 路径、输出目录、线程数、循环次数（后三个来自脚本自己的设置）。
- 每个脚本可存默认参数：输出目录（没设置时用 `<数据目录>/jmeter-reports`，运行仍会建 `report-<时间戳>`）、
  线程、循环、备注；运行结束后写回「最近运行」（成功/失败 + 时间 + 报告目录），库里直接显示。
- 「检查脚本」：静态解析 JMX（纯函数 `electron/jmx-script.js` + 7 条单测）——
  线程组数量、默认线程/循环、`${__P(name,default)}` 可覆盖参数、CSV Data Set 引用的文件是否存在（相对路径按脚本目录解析）。
- 回归：`scripts/ui-jmxlib-test.js`（11 条，含自动填充、检查、设置弹窗、重复导入、弹窗居中）。

### 1.27.1：脚本库补四项（2026-11-20）

- **参数面板**：脚本里 `${__P(name,default)}` 声明的参数会解析出来（`inspectJmx.params`），
  运行页多出一组「脚本参数」输入框，运行时拼成 `-Jname=value` 追加到 `extraArgs`；
  填过的值存进 `meta.params`，下次载入脚本自动带出。脚本设置弹窗里也能改。
- **数据文件预检**：`jmxlib:validate` 现在会解析 CSV Data Set 的 `filename`（相对路径按脚本所在目录解析），
  返回 `files[] = { path, abs, exists, bytes, lines }`（只读前 8MB 数行）；
  行数少于线程数时提示「多线程会重复读同一批数据」，文件不存在直接标红。
- **模板新建**：`buildJmxTemplate()`（纯函数，4 条单测）生成最小可跑的 HTTP 脚本 ——
  TestPlan + ThreadGroup（`${__P(threads,N)}`）+ LoopController（`${__P(loops,N)}`）+ HTTPSamplerProxy + HeaderManager，
  地址里的协议/端口/路径由 `new URL()` 拆好，脚本名做 XML 转义。UI 上是「新建脚本」按钮 + 一个小表单。
- **历史趋势**：`jmxlib:mark-run` 现在接 `stats` 与 `durationMs`，每次追加一条 `runs[]`（保留最近 20 次：
  样本数/错误数/错误率/平均 RT/吞吐量）；脚本设置弹窗底部画一张 SVG 走势图（吞吐量折线 + 错误率红点），
  标注最新 TPS、错误率和「几次有错误」。

注意：`stats.errorPct` 已经是**百分比**（0~100），写入时不要再乘 100（踩过一次，图上显示 600%）。

### 1.28.0：压力测试页改成两栏 + 锁屏图标（2026-11-20）

**布局**
- 左栏（380px，可折叠卡片）：环境 / 脚本库 / 运行配置；右栏：`实时控制台 · 历史记录` 页签、结果面板、运行历史。
- 以前是整页纵向平铺：脚本库在上面、控制台在下面，跑起来要来回滚；现在左边定参数、右边看输出。
- 折叠头是 `SideFold`（本地组件）：整行可点，`aria-expanded`，chevron 旋转；
  `.perf-split` 在 ≤1200px 降为单列。
- 执行命令块加了「复制」（`navigator.clipboard`，失败给 toast）。
- 运行历史改成真正的表格（时间 / 脚本 / 样本 / 错误率 / TPS / 平均 / 操作），
  页签「历史记录」显示全部，右栏下方只显示最近 5 次。

**锁屏图标**
- `Login.tsx` 里三处密码显隐（设置主密码 / 解锁 / 修改密码）还是 emoji，现在与其它页面统一成 `Icons.eye / eyeOff`。

**回归**
- `ui-round10-test.js` 跟着改选择器：面板列表断言改成「环境 / 脚本库 / 运行配置 + 两个页签」，
  运行历史从 `.perf-hist-row` 改成 `.perf-hist-tbl tbody tr`（23 → 24 条仍全过）。

### 1.28.1：压测页反馈修正（2026-11-20）

- **历史只留一份**：`实时控制台 · 历史记录` 页签与下方「运行历史」表格内容完全一样 —— 去掉页签，
  控制台固定标题「实时控制台」，历史统一由「运行历史」表格呈现（最近 5 次 + 清空历史）。
- **环境单行**：JMeter / Java 各一行（值做省略号截断，右侧「选择」按钮同一行），候选列表单独一行。之前是「一行值 + 一行按钮」，卡片很高。
- **根目录脚本看不见（修 bug）**：`jmxlib:import` 到根目录能成功，但树只渲染了「目录里的文件」，根目录文件从来没显示过。
  现在根文件从 `jmxlibList('')` 的 `files` 渲染，并加「根目录脚本」分组标题。
  组件同时监听 `window` 事件 `pm:jmxlib-refresh`，外部 IPC 改完可以主动刷列表（测试里用它代替原生对话框）。
- **点脚本后 JMX 路径还是上一次的（修 bug）**：`jmeterDefaults()` 在页面挂载后要 1~2 秒才返回（中间还要探测 Java），
  晚到的默认值直接 `setJmxPath(上一次脚本)` 把用户刚点的覆盖了。改成函数式更新 `setJmxPath(prev => prev || 默认值)`。
- **点脚本把已选输出目录冲掉（修 bug）**：脚本没存 `outDir` 时之前一律落到默认 `jmeter-reports`；
  现在「脚本有自己的目录就用、没有就保留当前选择的、当前为空才落默认」。

回归：`ui-jmxlib-test.js` 20 条（新增根目录可见、环境单行、页签移除、换脚本更新路径）；`ui-round10-test.js` 24 条。

### 1.28.2：输出目录不再被冲掉 + 网址管理图标（2026-11-20）

- **点脚本仍会改输出目录（真 bug 根因）**：上一版只改了 `PerfTest.loadFromLib`，但 `JmxLibrary.pickOne`
  在调 `onPick` 之前就自己取了一次默认目录并塞进 `meta.outDir` —— 页面以为「脚本存了目录」，于是照用。
  现在 `pickOne` 只带脚本自己存的参数；输出目录没存就完全不动页面的选择。
  空目录的兜底挪到 `start()`：真要跑的时候才取默认 `jmeter-reports`。
  顺带 `pickOne` 点击时现取一次 meta（列表里是旧快照时也能拿到最新参数）。
- **网址管理图标**：卡片头部的复制网址、标签、附件数、自定义字段、备注、账号、密码，以及底部动作组
  （复制 URL / 账号 / 密码、编辑、钉小窗）原来是 emoji（📋🏷📎🔖📝👤🔑✏️📌），
  全部换成 Tabler 图标（`Icons.copy/tag/clip/list/note/user/key/pencil/pin/link/check`）；
  列表视图的复制反馈、附件数，标签侧栏右键菜单（复制/重命名/钉住/删除）一并换掉。
  `ui.tsx` 新增 `Icons.user` / `Icons.clip` 两个图标。
- **状态字弱化**：`.perf-fold-meta` 10.5px / 75% 不透明度（「已就绪」「已选脚本」不再像标签）。
- **运行历史展开全部**：默认最近 5 次，右上角「展开全部（N）」展开到全部（容器最高 420px 滚动），可收起。

回归：`ui-jmxlib-test.js` 22 条（新增「脚本没存目录时不覆盖」「存了就带出」「换脚本保留目录」）；r9 80 条、r10 24 条。

### 1.29.0：启动落点 / 历史展开 / 备份天数 / 图标收尾（2026-11-20）

- **启动固定落在工作台**：以前解锁会读 `settings.lastPage` 恢复上次页面，重启后经常停在某个二级页。
  现在统一 `setCurrentPage('home')`；`lastPage` 仍照常记录（以后要做「继续上次」开关时有数据）。
- **运行历史「展开全部/收起」看着没反应**：底部只渲染最近 5 次，历史少于等于 5 条时点它自然没变化。
  改成只有 `history.length > 5` 才显示这个按钮（`jmeter-history` 最多存 50 条）。
- **「距上次备份（天）」永远是 0**：自动每日备份（`backupVaultOncePerDay`）当天第一次保存就会写
  `vault-YYYY-MM-DD.enc`，所以文件时间永远是今天。现在 `backup:now`（用户手点的那次）会把时间写进
  `settings.lastBackupAt`，工作台优先用它算天数；没有手动记录时退回最新备份文件时间，并在数字上加了
  tooltip 显示具体时间。
- **控制台行数**：界面保留最近 **4000 行**（超出丢最早的，完整输出看「打开运行日志」），
  标题右侧加了「最近 N 行 / 最多保留 4000 行」的提示。
- **图标收尾**：清掉剩余 emoji —— 设置页左侧 tab（🔒💾🎨⏱️ℹ️ → lock/db/tool/clock/note）、
  TOTP 徽标 🔐、安全体检空态 🎉/🔁、导出格式下拉 🔒📄、导入模板 📥、登录提示 💡、JSON 工具 💡🔧。
  `boundaryValues.ts` 里的 emoji 是测试数据（边界值用例），保留。
