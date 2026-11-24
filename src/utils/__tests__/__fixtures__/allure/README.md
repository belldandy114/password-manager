# Allure 多轮合成夹具（模块 5.1 用）

> **数据来源声明**：本目录全部是**合成数据**，不对应任何真实项目的运行结果，也不是从真实报告脱敏来的。
> 域名一律 `example.com`，账号/密钥一律占位值（`qa_placeholder_account` / `placeholder_not_a_real_secret`），主机名 `qa-fixture-host`。
> 造它的目的只有一个：让 5.1 的解析与 flaky 判定**可复现、可证伪**，而不是靠本机拿不到的真实 `allure-results`。

夹具由**测试方（qa）**独立造，不由解析器实现方造——避免出现「夹具刚好适配实现」的自证。

---

## 0. 这份夹具能证伪什么

不是「有几条数据就行」。下面每一条都是一个**能被写歪的实现**，夹具专门留了让它红的数据：

| 可能写歪的实现 | 夹具里对应的证伪数据 | 期望（判失败 = 相反） |
|---|---|---|
| 把 skipped 当 passed | `ImportTest` 3 轮全 `skipped` | `passed` 计数里**不含**它；`passed=0` |
| 把 broken 当 passed 或忽略 | `CallbackTest` 3 轮全 `broken` | 计入 fail 侧（契约 C-38 写的是 `failed/broken`），不进 `passed` |
| 把「有重试」一律判成 flaky | `DiscountTest` 在 run2 同轮重试两次**都失败**（`runs=2, pass=0, fail=2`） | **不是 flaky**（缺 `pass ≥ 1`） |
| 把「单次运行的失败」判成 flaky | `SchemaTest` 只在 run3 出现、只跑 1 次就失败（`runs=1`） | **永不 flaky**（契约 C-38 明文：只有 1 次运行的用例永远不能判 flaky） |
| flaky 不显示分母 | 唯一的本轮内 flaky 正例 `ApiClientTest`（run1：`runs=2, pass=1, fail=1`） | 输出必须带 `runs`/`pass`/`fail` 三个数，不能只给名字 |
| 靠 `statusDetails.flaky` 现成标记抄答案 | 全部 `statusDetails.flaky` **故意写成 `false`** | 必须自己按状态序列算；读这个标记等于没实现 |
| 按「轮次最终状态」而不是「每条 result」算运行数 | `ApiClientTest` 在 run1 是 fail→pass 两条 result，最终状态 passed | 按契约 C-38 的 result 口径：run1 的 flaky **应含 1 条** `ApiClientTest`；按「最终状态」口径会算成 0 —— **两种口径结论不同，测试必须显式锁一种**（见 §5） |
| 聚类只让 failed 参与、broken 被丢掉 | `CallbackTest` 的 broken message 3 轮**完全相同**（Connection refused） | 若 broken 计入聚类 → 该 key `count=3`；若只聚 failed → 该 key 不进 clusters，但 `DiscountTest` 那两条**完全相同**的 failed message 必须聚成 `count=2` |

---

## 1. 目录与构成

```
src/utils/__tests__/__fixtures__/allure/
  README.md                        ← 本文件（不是 allure 的产物，解析器应忽略）
  run1/  8 个 *-result.json  + 2 个 *-container.json + environment.properties
  run2/  10 个 *-result.json + 2 个 *-container.json + environment.xml
  run3/  10 个 *-result.json + 1 个 *-container.json + environment.properties
```

- 共 **36 个 allure 产物文件**（28 个 `*-result.json` + 5 个 `*-container.json` + 3 份 environment），合计 **68.8 KB**；
  连本 README 一起，目录共 **37 个文件 / 87.4 KB**，均远低于 300 KB 上限。
- `run2` 故意用 `environment.xml`（其余两轮用 `environment.properties`），**两种格式都覆盖**。
- 文件名严格用真实 allure 的形态：`<uuid>-result.json` / `<uuid>-container.json`，`<uuid>` 是合法 UUID v4 形状（校验见 §6）。
- **不要**在本目录下放 `*.test.ts`：夹具只被未来的测试 import/读取，不该被 vitest 当测试收集。

### 三张时间线

| 轮 | 时间（UTC） | environment | 场景 |
|---|---|---|---|
| `run1` | 2026-11-18 02:00–02:11 | `environment.properties` | **基线轮**：整体绿；`ApiClientTest` 超时用例第一次失败、第二次重试通过（**本轮内的 flaky 正例**） |
| `run2` | 2026-11-19 02:00–02:14 | `environment.xml` | **回归轮**：`CreateOrderTest` 翻车（跨轮 flaky 正例的中段）；`DiscountTest` 同轮重试两次仍失败（**反例：有重试但从未通过 ≠ flaky**） |
| `run3` | 2026-11-20 02:00–02:12 | `environment.properties` | **修复轮**：`CreateOrderTest` 恢复绿（跨轮 flaky 正例收口）；`SchemaTest` 新用例单轮失败（**反例：只跑过一次的失败 ≠ flaky**） |

每轮的 `environment.*` 里 `run.scenario` 就是上表那段话，解析器若把 environment 回显到界面，可直接看出这轮是什么场景。
（注：environment 值含 UTF-8 中文，读取必须按 UTF-8，不要按 latin1。）

---

## 2. 用例清单与跨轮状态矩阵（10 个用例）

`historyId` 全程不变（这是 flaky 判定的唯一键）；`fullName` 也全程不变（人读的唯一键）。`testCaseId` 与 `historyId` 取同值（简化，不影响判定）。

| # | 类.方法（`fullName` 尾段） | `historyId` | run1 | run2 | run3 | 角色 |
|---|---|---|---|---|---|---|
| 1 | `LoginTest.shouldLoginWithValidAccount` | `a1b2c3d4e5f60718293a4b5c6d7e8f90` | passed | passed | passed | **flaky 反例**（3 轮全绿） |
| 2 | `CreateOrderTest.shouldCreateOrder` | `b1c2d3e4f5a60718293a4b5c6d7e8f91` | passed | **failed** | passed | **flaky 正例（跨轮）** |
| 3 | `SearchTest.shouldFilterByKeyword` | `c1d2e3f4a5b60718293a4b5c6d7e8f92` | passed | passed | passed | flaky 反例 |
| 4 | `ApiClientTest.shouldTimeoutAfter3s` | `d1e2f3a4b5c60718293a4b5c6d7e8f93` | **failed → passed（重试）** | passed | passed | **flaky 正例（本轮内重试）** + 重试样例 |
| 5 | `ExportTest.shouldExportXlsx` | `e1f2a3b4c5d60718293a4b5c6d7e8f94` | passed | passed | passed | flaky 反例 |
| 6 | `ImportTest.shouldImportLegacyFile` | `f1a2b3c4d5e60718293a4b5c6d7e8f95` | skipped | skipped | skipped | 反例：**skipped 既不算 pass 也不算 fail** |
| 7 | `CallbackTest.shouldHandlePaymentCallback` | `a2b3c4d5e6f708192a3b4c5d6e7f8096` | broken | broken | broken | 反例：**从未 pass 的稳定坏 ≠ flaky** |
| 8 | `DiscountTest.shouldApplyCouponDiscount` | `b2c3d4e5f6a708192a3b4c5d6e7f8097` | —（无） | **failed → failed（重试，两次都失败）** | passed | 反例：**有重试、pass=0 ≠ flaky** + 重试样例 |
| 9 | `LocaleTest.shouldFormatDateByLocale` | `c2d3e4f5a6b708192a3b4c5d6e7f8098` | —（无） | passed | passed | 反例（只跑过 2 次且全绿） |
| 10 | `SchemaTest.shouldValidateResponseSchema` | `d2e3f4a5b6c708192a3b4c5d6e7f8099` | —（无） | —（无） | **failed** | 反例：**runs=1 永不 flaky** |

`—（无）` = 该轮没有这条用例的 result 文件（不是空状态）。

### uuid 对照（写断言要指到具体文件时用）

规律：`run1` 前缀 `a1000000-0000-4000-8000-00000000`、`run2` 前缀 `b2000000-…`、`run3` 前缀 `c3000000-…`，
后 4 位 = 该轮文件生成顺序（`0001` 起）；container 用同前缀 + `c` + 3 位（`c001` 起）。

| 轮 | uuid（后 4 位） | 用例 | 状态 |
|---|---|---|---|
| run1 | `0001` | LoginTest | passed |
| run1 | `0002` | CreateOrderTest | passed |
| run1 | `0003` | SearchTest | passed |
| run1 | `0004` | ApiClientTest（attempt 1） | failed |
| run1 | `0005` | ApiClientTest（attempt 2） | passed |
| run1 | `0006` | ExportTest | passed |
| run1 | `0007` | ImportTest | skipped |
| run1 | `0008` | CallbackTest | broken |
| run1 | `c001`（container） | `ApiClientTest (retry)`，`children` = `0004` + `0005` | — |
| run1 | `c002`（container） | `JUnit Jupiter`，`children` = 本轮 8 条 result | — |
| run2 | `0001` | LoginTest | passed |
| run2 | `0002` | CreateOrderTest | failed |
| run2 | `0003` | SearchTest | passed |
| run2 | `0004` | ApiClientTest | passed |
| run2 | `0005` | ExportTest | passed |
| run2 | `0006` | ImportTest | skipped |
| run2 | `0007` | CallbackTest | broken |
| run2 | `0008` | DiscountTest（attempt 1） | failed |
| run2 | `0009` | DiscountTest（attempt 2） | failed |
| run2 | `0010` | LocaleTest | passed |
| run2 | `c001`（container） | `DiscountTest (retry)`，`children` = `0008` + `0009` | — |
| run2 | `c002`（container） | `JUnit Jupiter`，`children` = 本轮 10 条 result | — |
| run3 | `0001` | LoginTest | passed |
| run3 | `0002` | CreateOrderTest | passed |
| run3 | `0003` | SearchTest | passed |
| run3 | `0004` | ApiClientTest | passed |
| run3 | `0005` | ExportTest | passed |
| run3 | `0006` | ImportTest | skipped |
| run3 | `0007` | CallbackTest | broken |
| run3 | `0008` | DiscountTest | passed |
| run3 | `0009` | LocaleTest | passed |
| run3 | `0010` | SchemaTest | failed |
| run3 | `c001`（container） | `JUnit Jupiter`，`children` = 本轮 10 条 result | — |

---

## 3. 四个必测形态的落点（对着任务要求逐条）

### 3.1 flaky 正例（必须判出来）

| 形态 | 用例 | 证据 |
|---|---|---|
| **跨轮**：run1 passed / run2 failed / run3 passed | `CreateOrderTest`（`historyId=b1c2d3e4f5a60718293a4b5c6d7e8f91`） | run1 `…0002` passed、run2 `…0002` failed、run3 `…0002` passed |
| **本轮内重试**：同一轮里 fail→pass | `ApiClientTest`（`historyId=d1e2f3a4b5c60718293a4b5c6d7e8f93`） | run1 `…0004` failed（attempt 1）+ `…0005` passed（attempt 2），且 `c001` container 把两条 uuid 归成一组 |

### 3.2 flaky 反例（必须**不**判出来）

| 反例类型 | 用例 | 为什么不许判 flaky |
|---|---|---|
| 3 轮全绿 | `LoginTest` / `SearchTest` / `ExportTest` | 全 passed，缺 fail 侧 |
| 3 轮全 skipped | `ImportTest` | skipped 不算 pass，也不算 fail → `pass=0, fail=0` |
| 3 轮全 broken | `CallbackTest` | 计入 fail 侧但**从未 passed** → `pass=0`，缺 pass 侧 |
| 有重试但两次都失败 | `DiscountTest`（run2） | `runs=2, pass=0, fail=2` → 缺 `pass ≥ 1` |
| 只跑过一次就失败 | `SchemaTest`（仅 run3） | `runs=1` → 契约 C-38 明文永不 flaky |
| 只跑过 2 次且全绿 | `LocaleTest`（run2 / run3） | 缺 fail 侧 |

### 3.3 重试（同一轮内同一用例多条 result）

- **run1**：`ApiClientTest` 两条 result（`…0004` failed → `…0005` passed），并额外落了一个 `ApiClientTest (retry)` container（`children` = 两条 uuid）——**result 级与 container 级两种重试关系都有**。
- **run2**：`DiscountTest` 两条 result（`…0008` failed → `…0009` failed），同样带 retry container。
- 重试两条的 `start` 严格递增（间隔约 10 秒），按 `start` 升序排序后**最后一条是该用例最终状态**。

### 3.4 四种状态齐全（每一轮都齐，不是整份夹具凑齐）

| 轮 | passed | failed | broken | skipped | 合计 |
|---|---|---|---|---|---|
| run1 | 5 | 1 | 1 | 1 | 8 |
| run2 | 5 | 3 | 1 | 1 | 10 |
| run3 | 7 | 1 | 1 | 1 | 10 |

（`passed + failed + broken + skipped` 必须等于该轮 result 条数——这是契约 C-37 的 `total` 口径，可直接当断言。）

---

## 4. 期望计数（可直接写进断言，不用猜）

### 表 A · 单轮口径（**本批按契约 C-38：一条 result 算一次运行**）

| 指标 | run1 | run2 | run3 |
|---|---|---|---|
| `total`（= result 条数） | **8** | **10** | **10** |
| `passed` | **5** | **5** | **7** |
| `failed` | **1** | **3** | **1** |
| `broken` | **1** | **1** | **1** |
| `skipped` | **1** | **1** | **1** |
| `retries`（判定为重跑的**用例数**） | **1**（ApiClientTest） | **1**（DiscountTest） | **0** |
| `flaky` | **1 条**：`ApiClientTest`（`runs=2, pass=1, fail=1`） | **0 条** | **0 条** |
| 唯一用例数（去重 historyId，仅供参考） | 7 | 9 | 10 |

> `retries` 是**用例数**不是**重跑次数**：run1 是 `1`（一个用例重跑过），不是 `2`（两条 result）。写成 2 就是错的。

### 表 B · 跨轮合并口径（**本批不做，见契约 §1.6 C-38「跨报告的历史 flaky 归并本批不做」**）

仅当将来把 3 轮当一个历史窗口合并时用；现在**不得**用它当本批断言，否则会要求实现做本批范围外的事。

| 指标 | 合并值 |
|---|---|
| `total` | **28** |
| `passed` / `failed` / `broken` / `skipped` | **17 / 5 / 3 / 3** |
| 唯一用例数 | **10** |
| flaky 条数（按 result 计） | **3 条** |
| ↳ `CreateOrderTest` | `runs=3, pass=2, fail=1` |
| ↳ `ApiClientTest` | `runs=4, pass=3, fail=1`（run1 的两条 result 各算一次运行） |
| ↳ `DiscountTest` | `runs=3, pass=1, fail=2` |

### 表 C · 聚类（契约 C-39：`statusDetails.message` 归一后同 key 计数 ≥ 2 才进 clusters）

夹具里的失败/坏消息，归一（去数字、去堆栈、去耗时）后的分组是确定的：

| 消息（归一后） | 出现次数 | 出现在 |
|---|---|---|
| `java.net.ConnectException: Connection refused: https://callback.example.com/pay/notify` | **3** | CallbackTest × 3 轮（`broken`） |
| `java.lang.AssertionError: expected discount 15.00 but was 0.00` | **2** | DiscountTest run2 的两次尝试（`failed`） |
| `java.net.SocketTimeoutException: Read timed out after 3000 ms` | 1 | ApiClientTest run1 attempt 1 |
| `java.lang.AssertionError: expected status 201 but was 500` | 1 | CreateOrderTest run2 |
| `java.lang.AssertionError: response missing required property 'items'` | 1 | SchemaTest run3 |

两种实现的期望（测试要显式选一种并写清）：
- **只聚 `failed`**（不含 broken）→ clusters 恰好 **1 组**，`count=2`（discount）。
- **`failed` + `broken` 都聚**（契约 C-38 把 broken 归在 fail 侧）→ clusters **2 组**：`count=3`（Connection refused）、`count=2`（discount）。

---

## 5. 使用约定与坑（写测试前必读）

1. **不要读 `statusDetails.flaky`**：全部故意写成 `false`。读它 = 没实现 flaky 计算。
2. **`total` 的口径只能是「result 条数」**：`total = passed + failed + broken + skipped`（契约 C-37 单测锁死）。若按「唯一用例」算，run1 会得 7 而四状态和是 8，自相矛盾。
3. **`retries` = 判定为重跑的用例数**，不是重跑次数（见 §4 表 A 注）。
4. **重试用例最终状态取按 `start` 升序的最后一条**：run1 的 `ApiClientTest` 最终是 `passed`，run2 的 `DiscountTest` 最终是 `failed`。
5. **skipped 不进 flaky 的两侧**：既不等于 pass 也不等于 fail（`ImportTest` 就是这条的锁）。
6. **broken 进 fail 侧**：契约 C-38 原文是「既出现过 `passed` 又出现过 `failed`/`broken`」。所以 `CallbackTest` 是 `pass=0, fail=3` → 不是 flaky（缺 pass），而不是「broken 不算数」。
7. **「轮」= 一个目录**：`allure:parse` 一次只吃一个目录，所以 `run1`/`run2`/`run3` 是三次独立解析；把三轮结论合并成 flaky 属跨报告归并（本批不做）。
8. **container 的 `children` 是 uuid 数组**：`JUnit Jupiter` 的 children 覆盖该轮全部 result；`* (retry)` 的 children 只有同一用例的两条。若实现靠 container 判重试，必须能处理「一个 container 里两条同 historyId」这种情况。
9. **不要在本目录放 `*.test.ts`**，也不要把夹具复制进 `dist/`：它只服务于单测。

---

## 6. 自校验（改完夹具必须重跑，且期望值就是下面这些）

```bash
# 结构自检：轮数 ≥ 3、全部 JSON 可 parse
node -e "const fs=require('fs'),p=require('path');const root='src/utils/__tests__/__fixtures__/allure';if(!fs.existsSync(root)){console.error('夹具目录不存在');process.exit(1)}const runs=fs.readdirSync(root).filter(d=>fs.statSync(p.join(root,d)).isDirectory());let n=0,bad=[];for(const r of runs){for(const f of fs.readdirSync(p.join(root,r))){if(!f.endsWith('.json'))continue;n++;try{JSON.parse(fs.readFileSync(p.join(root,r,f),'utf8'))}catch(e){bad.push(r+'/'+f)}}}if(runs.length<3){console.error('轮数不足: '+runs.length);process.exit(1)}if(bad.length){console.error('非法 JSON: '+bad.join(','));process.exit(1)}console.log('轮数='+runs.length+' json文件='+n+' 全部合法')"
# 期望输出：轮数=3 json文件=33 全部合法
```

```bash
# 逐轮状态/唯一用例/重试/flaky 自检（期望值见 §4 表 A）
node -e "const fs=require('fs'),p=require('path');const root='src/utils/__tests__/__fixtures__/allure';for(const r of fs.readdirSync(root).filter(d=>fs.statSync(p.join(root,d)).isDirectory()).sort()){const rs=fs.readdirSync(p.join(root,r)).filter(f=>f.endsWith('-result.json')).map(f=>JSON.parse(fs.readFileSync(p.join(root,r,f),'utf8')));const c={passed:0,failed:0,broken:0,skipped:0},h={};for(const x of rs){c[x.status]++;h[x.historyId]=h[x.historyId]||[];h[x.historyId].push(x.status)}const rt=Object.keys(h).filter(k=>h[k].length>1);const fl=rt.filter(k=>h[k].includes('passed')&&(h[k].includes('failed')||h[k].includes('broken')));console.log(r,JSON.stringify({total:rs.length,...c,unique:Object.keys(h).length,retries:rt.length,flaky:fl.length}))}"
# 期望：run1 {"total":8,"passed":5,"failed":1,"broken":1,"skipped":1,"unique":7,"retries":1,"flaky":1}
#       run2 {"total":10,"passed":5,"failed":3,"broken":1,"skipped":1,"unique":9,"retries":1,"flaky":0}
#       run3 {"total":10,"passed":7,"failed":1,"broken":1,"skipped":1,"unique":10,"retries":0,"flaky":0}
```

---

## 7. 重生成口径（将来要改夹具时按这套规则，别手工乱加文件）

- **uuid**：`run1` = `a1000000-0000-4000-8000-00000000` + 4 位序号；`run2` = `b2000000-…`；`run3` = `c3000000-…`。container = 同前缀 + `c` + 3 位。必须是合法 UUID v4 形状（第 3 段以 `4` 开头、第 4 段以 `8` 开头）。
- **时间**：run1 = `2026-11-18`、run2 = `2026-11-19`、run3 = `2026-11-20`，都从 `02:00:00Z` 起；同一用例的重试两条 `start` 间隔 ≥ 5 秒。
- **`historyId`**：10 个用例各一个固定值（见 §2 表），跨轮**不得变**；变了就等于换了一个用例，flaky 判定会断。
- **`statusDetails`**：passed 用 `{known:false,muted:false,flaky:false}`；failed/broken 追加 `message` + `trace`；**永远不要把 `flaky` 写成 `true`**。
- 改完必须重跑 §6 的两条自检，并同步更新本文件 §2 的 uuid 对照表与 §4 的三张计数表——**数量本身就是判据**，不更新等于给后来人埋坑。

---

## 8. 与契约 / 验收文档的对应关系

| 这里的东西 | 对应的口径 |
|---|---|
| §4 表 A（单轮 total/四状态/retries/flaky） | 契约 `C-37`（`total === passed+failed+broken+skipped`）、`C-38`（flaky 定义与「单次运行永不 flaky」） |
| §3.1 / §3.2 的正例与反例 | 契约 `C-38`；验收文档 `AC-11`（flaky 必须显示 `fail/总运行数` 分母） |
| §4 表 C（聚类分组） | 契约 `C-39`（message 归一 + `count ≥ 2` + Top 50 排序） |
| `environment.properties` / `environment.xml` | 契约 §2.4 `allure:parse` 返回里的 `environment` 字段（两种格式都要能读） |
| `run1/run2/run3` 三个独立目录 | 契约 `C-38` 末句「跨报告的历史 flaky 归并本批不做」——三轮各自解析，合并口径只在 §4 表 B 备查 |