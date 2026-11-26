# W6-B Allure 解析域验收证据（t38）
> ⚠ 已下线（1.36.0）：结果中心的 Allure 解析域（ipc-allure / allure-parse）。本文档仅作历史记录，不要照它实现。

> 任务：模块 5.1「Allure 结果解析」主进程侧 —— 纯函数 allure-parse.js（flaky / 聚类 / skippedFiles）+ ipc-allure.js 两条只读通道。
> 本文件是长证据唯一落点；`update_task` 每条 evidence ≤200 字 + 指向本文件章节。
> 环境：Windows 11 + Node 22.22。运行时间 2026-11-24 12:10–12:35。

## 1. 改动清单（5 个 inScope 文件）

| 文件 | 内容 |
|---|---|
| `electron/allure-parse.js`（新） | 纯函数：`parseAllure(files, opts)`、`normalizeMessage`、`parseEnvironment`、`isResultFile/isContainerFile/isEnvFile`、五个上限常量。**不 require fs / electron / path** |
| `electron/allure-parse.d.ts`（新） | 完整类型声明（`AllureCase` / `AllureFlaky` / `AllureCluster` / `AllureParseResult`） |
| `electron/ipc-allure.js` | 2 条通道落地：`pack-dir` 选择对话框 + `parse` 只读遍历（只看文件名决定要不要打开、2 MB 上限、30 s 超时、每 64 文件让出事件循环） |
| `src/utils/__tests__/allureParse.test.ts`（新） | **29 条**单测，全部基于 qa 的夹具（3 轮 28 条 result） |
| `docs/acceptance/W6-B.md`（新） | 本文件 |

## 2. flaky 口径（C-38）：三组期望值全部命中

| 轮次 | 夹具场景 | 期望 | 实测 |
|---|---|---|---|
| run1 | `ApiClientTest` 同一轮内 fail→pass | **flaky=1，runs=2 pass=1 fail=1** | ✅ `{"fullName":"...ApiClientTest.shouldTimeoutAfter3s","runs":2,"pass":1,"fail":1}` |
| run2 | `DiscountTest` 重试两次**全失败** | **flaky=0**（runs=2 pass=0 fail=2） | ✅ `{"runs":2,"pass":0,"fail":2,"flaky":false}`，`fail/runs = 2/2` |
| run3 | `SchemaTest` 只跑 1 次就失败 | **flaky=0**（runs=1 永不判） | ✅ `{"runs":1,"fail":1,"flaky":false}` |
| run1 | `ImportTest` 全 skipped | 不算 | ✅ flaky=false |
| run1 | `CallbackTest` 全 broken | 不算（pass=0） | ✅ flaky=false，pass=0 |

判定式：`runs >= 2 && pass > 0 && fail > 0`，其中 `fail = failed + broken` 的结果数。
`runs=1` 天然不满足 → **永不 flaky**（不需要额外分支）。

计数是**结果级**（同一条用例重试两次 = 两条 result）：run1 = passed 5 / failed 1 / broken 1 / skipped 1 = 8；
`retries = Σ(runs-1)`，run1 = 1（ApiClient 多出来的那条）。

## 3. 聚类（C-39 **v12 口径**）：key 表达模式，诊断信息交给 sample / samples

> **t42 改过一次口径**（队长裁决推翻 t38 的「保留业务值」）：`key` 只表达**模式**，
> 数字（含业务值）一律抹掉；诊断信息由 `sample` / `samples` 的**未归一原文**承载。
> 来由见契约 `[C-39]`：聚类的目的是「找同一根因」，按值拆开会把 1 个「每单都错」的 bug
> 显示成 10 个 count=1 的偶发问题——**把同一个 bug 拆散比不聚类更误导**。

合并 3 轮 28 条 result 后（单轮里同一错误只出现 1 次，聚不出来，所以聚类断言用合并输入）：

```
clusters = [ { key: "...Connection refused: ...", count: 3, sample: "java.net.ConnectException: Connection refused: https://…", samples: [...] },
             { key: "java.lang.AssertionError: expected discount # but was #", count: 2,
               sample:  "java.lang.AssertionError: expected discount 15.00 but was 0.00",   ← 原文，值还在
               samples: ["java.lang.AssertionError: expected discount 15.00 but was 0.00"] } ]
```

- `Connection refused` **count=3**（run1/run2/run3 各一条 Callback broken）✅ —— 改口径不改数量
- `expected discount` 簇 **count=2**，key 是 `expected discount # but was #`，**sample 里能找到 `15.00`** ✅
- `missing required property 'items'` 只出现 1 次 → **不进 clusters** ✅
- 排序：count 降序、同 count 按 key 升序；`sample` / `samples` 每条 ≤500，`samples` ≤3 条不同原文 ✅
- 上限 50 条、key ≤200 ✅

### 3.1 成对用例（缺一不可，单侧断言只证明一边）

| 对 | 两条消息 | 期望 | 实测 |
|---|---|---|---|
| ① 必须**同** key | `expected discount 15.00 but was 10` / `expected discount 20.00 but was 12` | 同一 key、count=2 | ✅ 合成 1 簇 count=2，key=`expected discount # but was #`，samples 两条都在 |
| ② 必须**不同** key | `连接 api.pay.example.com:8080 失败` / `…:9090 失败` | 2 个簇（8080 支付 vs 9090 风控） | ✅ 2 簇各 count=2，key **逐字保留主机+端口** |
| ③ 必须**不同** key | `401 Unauthorized` / `500 Internal Server Error` | 2 个簇 | ✅ `401` / `500` 原样保留，key 不同 |

第 ① 条正是 t38 的实现会拆成两个 count=1 簇的场景，用它把 v12 的取舍**锁死**：
以后谁想把业务值留在 key 里，这条会立刻红。

### 3.2 例外清单（`[C-39]` v12：这三类「数字」不是实例值）

| 保留 | 例子 | 为什么 |
|---|---|---|
| URL 主机名 + 端口 | `api.pay.example.com:8080` 原样 | 决定「连的是哪个服务」；抹掉会把 8080 与 9090 两条不同根因合并 |
| 文件扩展名 | `report.csv` / `report.xlsx` / `report.json` 各自保留 | 「不支持的文件类型」类报错里，扩展名就是分类键 |
| HTTP 状态码 | `401` / `500` / `503` 原样 | 认证失败与后端崩溃是不同根因 |

实现方式：这三类先「寄存」成不含数字的占位符 → 抹完所有数字 → 原样放回（顺序上
**耗时先于状态码**，否则 `after 100 ms` 里的 `100` 会被当成状态码保护起来，
同一个超时错误会被拆成好几簇——这条是实跑发现的，已写进单测）。
`normalizeMessage` 单测 **9 条**：耗时、行号/序号、UUID/长哈希、端口（反例）、业务数值（正例）、
状态码（反例）、混合场景、空消息、以及「三位数耗时不当状态码」的回归。

## 4. 端到端（stub electron 真实调 handler）

```
① allure:pick-dir（stub 让 dialog 取消）→ {"success":false,"canceled":true}

② 三轮夹具走 handler：
  run1: total=8 passed=5 failed=1 broken=1 skipped=1 retries=1 skippedFiles=0 flaky=1 clusters=0 ms=5
  run2: total=10 passed=5 failed=3 broken=1 skipped=1 retries=1 skippedFiles=0 flaky=0 clusters=1
  run3: total=10 passed=7 failed=1 broken=1 skipped=1 retries=0 skippedFiles=0 flaky=0 clusters=0
  run1 environment = {"allure.report.name":"Synthetic fixture (qa) - run1", "base.url":"https://api.example.com",
                      "test.env":"fixture-local", ...}   ← properties 解析
  run2 environment.xml 也解析成对象（不引 XML 解析器，只用 key/value 正则）

③ skippedFiles vs skipped（C-63 两个概念）：
  在 run1 副本里加 3 个附件（png/txt/html）→ total=8 skipped=1 skippedFiles=3  → PASS ✓
  （用例状态 skipped 仍是 1，文件数另算 3，两个数字没合并）

④ 畸形输入：
  只有 container → {"success":false,"error":"不是 allure-results 目录（未找到 *-result.json）"}
  空目录         → 同上（不是静默 0 条当成功）
  坏 JSON + 4 个好 result → success=true total=4 skippedFiles=1（单坏不整体失败）
  目录不存在 / dir 空 → {"success":false,"error":"目录不存在"}
  单文件超 2 MB   → success=true total=1 truncated=true reason=file-size
  maxFiles=3      → total=3 truncated=true reason=files
```

## 5. 只读边界（C-61）

- 只读三类文件名：`*-result.json`、`*-container.json`、`environment.properties|xml`；
  其它文件名**连打开都不打开**（先按名字判断再 `statSync`），只计入 `skippedFiles`。
- 附件（`*-attachment.*`）、HTML 报告：不读、不解析、不执行 —— 第 ④ 组里 `x1-attachment.png` 只贡献了 `skippedFiles`。
- 单文件 ≤ 2 MB（超出跳过并 `truncatedReason='file-size'`）、`maxFiles` 默认 5000、30 s 超时（到点带上已解析结果返回）。
- 用例内容（`message`）只在返回数据的 `cases[].message`（≤500 字符）里出现，**不进 console / app-log**。

## 6. 单测分布（29 条，全部基于夹具）

| 分组 | 条数 | 要点 |
|---|---|---|
| 夹具自检 | 1 | 3 轮 28 条 result（run1=8/run2=10/run3=10），防止夹具被改动后期望值悄悄失效 |
| run1 | 7 | 计数、flaky 恰 1 条、retries、两条反例、environment、skippedFiles/skipped 分离、C-64 排序 |
| run2 | 3 | total=10 / flaky=0、DiscountTest 2/2 分母、environment.xml |
| run3 | 2 | total=10 / flaky=0、SchemaTest runs=1 |
| 聚类 | 5 | Connection refused=3、discount=2、count<2 不入、排序与 cases 长度、normalizeMessage 4 断言 |
| skippedFiles | 2 | 附件计入、opts.skippedFiles 相加 |
| 畸形输入 | 4 | 坏 JSON、缺字段、空目录、只有 container |
| 上限 | 5 | maxFiles、maxCases、clusters≤50、2 MB、name≤300/message≤500 |

## 7. 三条门原始输出

```
========== npm run typecheck ==========   tsc --noEmit 无诊断，exit=0
========== npm run test:unit ==========   Test Files 109 passed (109) / Tests 1716 passed (1716)，exit=0
========== node scripts/check-ipc-contract.js ==========
IPC 契约检查：handler 221 个 / preload 调用 219 个 / 暴露方法 239 个 / 类型声明 239 个
! 注册了但没人调用（2）：pin:close-all、pin:count
结果：通过（无 error 级问题）exit=0
```

占位：**2 → 0**（全仓「该功能尚未实现（W1 骨架）」归零）。

> 任务书写的是「4 → 2」，那是 t37 之前的口径；t37 已经把 git 的 2 条清掉，所以本任务是 **2 → 0**。
> 契约 v8 的占位曲线是 `13 → 9 → 4 → 0`，到这里正好走到最后一步。

## 8. 需要队长裁定 / 契约补一条

**`skippedFiles` 的两种来源我合并成了一个数**（C-63 明文要求「同一个计数、不另开字段」）：
① 目录里按 C-61 不读的文件（附件/HTML）；② 读取失败或 JSON 解析失败的 result。
测试里两者都只落在 `skippedFiles`，没有 `invalidFiles` 这种第二字段。

**`truncatedReason` 已按 `[C-09]` v12 落成 5 值枚举**（属于 C-09 那 10 个允许值里 allure 的子集）：
`'timeout' | 'files' | 'file-size' | 'cases' | 'flaky'`，**顺序即优先级**——
多类同时触顶只报一个，`timeout > files > file-size > cases > flaky`（t42 补齐）。
`ipc-allure.js` 自己的截断（如单文件超 2 MB）与纯函数的截断合流时也走同一优先级，
不会出现「纯函数报 cases、通道报 file-size，最后显示哪个看运气」。单测锁了三条：
枚举顺序、file-size+cases→file-size、files+file-size→files。

## 9. 遗留

- `src/pages/ResultHub.tsx`（前端）不在 inScope；`allure:parse` 的 data 字段与契约 §2.4 完全一致，前端可直接消费。
- 单轮解析里 `clusters` 常常是 0（同轮同一错误只出现 1 次），这是**正确行为**：
  聚类是「本次导入内部的重复」，跨轮对比要靠历史页（`allureRuns` 集合）。
- `cases[].status` 取该用例**最后一条** result 的状态（重试通过 → passed），与 `flaky` 标记并存，
  前端展示时两者都要显示（「最终通过，但本轮 flaky 1/2」）。
- `test:unit` 首跑时 `caseMaps.test.ts` 有 2 条失败（别人正在写的文件），单跑与复跑均绿，与本任务无关。