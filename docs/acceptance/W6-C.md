# W6-C 验收取证：ResultHub 两页签（t47）
> ⚠ 已下线（1.36.0）：结果中心页（Allure 页签；.jtl 指标页签已迁入压力测试页）。本文档仅作历史记录，不要照它实现。

> 范围：`src/pages/ResultHub.tsx`（页签① Allure / 页签② .jtl 指标）。
> 本文件只记原始输出；结论在任务回执里。
> 取证方式：真机 Electron（`npm run dev:renderer` + `electron .`）+ CDP 驱动真实界面；
> 原生目录/文件对话框用 Win32 窗口消息驱动（`SendKeys` 在本机被 ACL 拒，见 W4-B §1）。
> 临时探针与夹具在 `%TEMP%`（不入库）。**所有数字都来自真实产物**：t9 的三轮 Allure 夹具、
> 以及 `E:\测试数据\13_结果\AI(3)-2026-11-20_15-24-59.jtl`（262,828 B）。

## 0. 页面与视觉口径

```
✓ 页签①渲染（两页签 + 空态） → ["Allure",".jtl 指标"]
✓ 全页未使用 .pill-*（状态词走 .dev-tag） → pill-* 命中 0
```

状态词只用 `.dev-tag`（`is-ok` / `is-fail` / `is-heur` / `is-unknown` / `is-unverified`）；
计数卡复用既有 `.home-stats` / `.home-stat`（Home 页同一套），**没写一行 css**；
四张表（flaky / 聚类 / 历史 / byLabel）都在 `.dev-scroll` 里（`.pnl` 是 `overflow:hidden`）。

## 1. 页签①：三轮夹具各解析一次（取证①）

### run1（8 个用例，含 1 条 flaky）

```
【对话框 run1】DIALOG=选择 allure-results 目录
【run1 计数卡】["8｜用例总数","5｜passed","1｜failed","1｜broken","1｜skipped（用例状态）","1｜retries（重跑次数）"]
【run1 flaky 行】[["shouldTimeoutAfter3s","1/2","1","1"]]

✓ ① run1 计数卡齐全（总数/通过/失败/断开/skipped/retries）
✓ ① flaky 行显示「失败/运行」分母（run1 = 1/2） → ["shouldTimeoutAfter3s","1/2","1","1"]
✓ ① flaky 用例名可见 → shouldTimeoutAfter3s
```

**分母是重点**：`shouldTimeoutAfter3s` 跑了 2 次、挂 1 次 → 界面显示 `1/2`。
如果只显示用例名，用户没法区分「偶发」和「必挂」——这两种的处置完全不同（前者要查竞态，后者要改断言）。

### run2（10 个用例，0 flaky，1 类失败聚类）

```
✓ ① run2 聚类表有 key（归一后的模式） → java.lang.AssertionError: expected discount # but was #
✓ ① run2 该目录无 flaky（跨目录不误判）
✓ ① 聚类 samples 可展开且显示对照原文 → aria-expanded=true
   （展开后可见 "expected discount 15.00 but was 0.00"）
```

聚类 key 里的数字已被抹成 `#`（`expected discount # but was #`），原文在 `sample` / `samples` 里——
这正是 [C-39] 的分工：**key 表达模式、sample 承载诊断**。展开可看最多 3 条对照；
如果同一类里原文差别很大，说明 key 抹过头了。

### run3（10 个用例）

```
✓ ① run3 计数卡（10/7/1/1/1/0） → 10｜用例总数 / 7｜passed / 1｜failed / 1｜broken / 1｜skipped / 0｜retries
```

> 三轮是**分别解析**的：`run1` 目录里那 2 条同用例结果才判 flaky，
> `run2`/`run3` 各自目录内没有「既过又挂」的用例，所以 flaky 为 0——跨目录不做 flaky 判定（契约口径）。

## 2. skippedFiles 与 skipped 分开（取证②的一部分）

为了让 `skippedFiles > 0`，把 run1 复制一份并塞进两个非结果文件（`zzz-attachment.png`、`debug.log`）：

```
【带附件目录 tags】["跳过的文件数 2","用例 skipped 1"]
✓ ② 跳过的文件数单独显示（=2） → 跳过的文件数 2
✓ ② 用例 skipped 单独显示且文案不混用（=1） → 用例 skipped 1
✓ ② skippedFiles>0 时提示「本次导入跳过了 N 个文件」
   → 本次导入跳过了 2 个文件（附件/非结果文件，按 [C-61] 不读不解析）。
     这些不是"跳过的用例"，别把两个数混在一起看。
```

两个数在同一屏上**并排**出现但各有各的文案：`跳过的文件数 2`（附件/日志）与`用例 skipped 1`（状态为
skipped 的用例）。历史表里 `skippedFiles` 缺失的老记录显示 `—`，不假装是 0。

## 3. 空目录 / 非 allure 目录（取证③）

```
✓ ③ 空目录给出明确文案（不是空白页） → 不是 allure-results 目录（未找到 *-result.json）
```

空目录与「有文件但不是 allure 结果」的目录**给同一句中文**（后端 [C-60] 同款口径：给可读中文，
不吐英文栈）。这条文案出现在 `.dev-banner.is-error role="alert"` 里，不是静默失败。

## 4. 页签②：真实 .jtl（取证②）

```
【.jtl 对话框】DIALOG=选择 JMeter .jtl 结果文件 | EDIT_SET_OK | CLICKED_OK | DONE
【.jtl 指标卡】["700｜样本数 samples","100｜错误数 errors","14.29%｜错误率 errorPct","590 ms｜平均 avg",
                "89 ms｜P50","2220 ms｜P90","2824 ms｜P95","3538 ms｜P99"]
【.jtl tags】["TPS 51.6","时间跨度 13565 ms","最快 22 ms / 最慢 3814 ms","有效行 700","100.00%","0.00%"]
【.jtl byLabel 首行】["登录","100","100","100.00%","103 ms"]

✓ ② 真实 .jtl：samples = 700
✓ ② 真实 .jtl：errors = 100
✓ ② 真实 .jtl：errorPct ≈ 14.29（偏差 ≤1%）
✓ ② 真实 .jtl：tps ≈ 51.6（偏差 ≤1%）
✓ ② 分位数齐全（P50 89ms / P90 2220ms / P95 2824ms / P99 3538ms）
✓ ② byLabel 首行是错误率最高的「登录」（100/100/100.00%）
✓ ② byLabel 支持切换排序（按样本数）
```

### 4.1 与后端 ground truth 的逐字段对齐

先用 node 直接跑 `electron/jmeter-args.js`（不经过界面）算出基准值，再和界面显示比：

```
rows = 700
{samples:700, errors:100, errorPct:14.29, avg:590, min:22, max:3814,
 p50:89, p90:2220, p95:2824, p99:3538, spanMs:13565, tps:51.6,
 byLabel 7 项, truncated:false}
byLabel top3 = [{"label":"登录","samples":100,"errors":100,"errorPct":100,"p90":103}, …]
```

界面显示与它**逐字段一致**（含 min/max/spanMs/byLabel top3）。与 t17 的结论（700 / 100 / 14.29% / 51.6）
也一致 —— 说明 UI 没取错字段、也没自己重算分位数。

## 5. allureRuns 落库与裁剪

```
✓ 预置 21 条 allureRuns（超过 20 上限） → n=21
✓ allureRuns 写入前裁剪（21 + 1 → 20） → n=20
✓ dropped 提示可见（「最早 N 条已清理」） → 历史记录已按上限裁剪，最早 2 条已清理
```

写入走 `trimToCaps([record, ...runs], capsOf('allureRuns'))`（`{maxItems:20, maxBytes:1MB}`），
丢最旧、`dropped` 立刻变成 `.dev-banner.is-warn`（[C-25] 原话）。
历史表能回放每次导入的 `total / passed / failed / broken / skipped / skippedFiles`。

## 6. 汇总

```
主探针：25 通过 / 0 失败
```

三门禁（原始输出见任务回执）：`npm run typecheck` exit 0；`npm run test:unit`
110 文件 1755 条全绿；`npm run build:renderer` exit 0（`ResultHub-BTJgyOPj.js` 19,692 B）。

## 7. 本批未做 / 需后续注意

| 项 | 说明 |
|---|---|
| 组件拆分 | 拆分文档 §3.4 要求 `components/resulthub/{AllureTab,JtlTab}.tsx` 之类；本批 inScope 只有 `ResultHub.tsx`，故两页签同文件（约 640 行）。要拆是纯搬运，需下次开 inScope |
| 失败用例逐条明细 | 本页给「聚类 + 计数 + flaky」，没有把 `cases[]`（逐条用例耗时/状态）铺成表。「哪条用例最慢」目前只能去 Allure 报告看；要加需要新的一块 UI（数据后端已经返回） |
| 跨目录 flaky | 契约口径是**同一目录内**同用例多 result 才算 flaky。想看「多轮之间的 flaky」需要把各轮结果合到一个目录，或另做跨 run 追踪（本批不做，页面上有这句提示） |
| .jtl 历史 | `.jtl` 解析结果**没有落库**（本批只要求 `allureRuns`）。要「历次压测对比」需要新集合（`jtlRuns`），属契约外新增 |
| 探针不入库 | `%TEMP%\t47-probe.js` + `%TEMP%\t47\{allure-extra,empty,not-allure}`；要长期留着得整理成 `scripts/ui-round2x-test.js` |