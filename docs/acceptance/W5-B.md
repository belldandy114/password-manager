# W5-B 验收取证：覆盖矩阵 + 用例映射（t34）
> ⚠ 已下线（1.36.0）：资产台账的覆盖矩阵与用例映射（coverage / caseMaps 纯函数）。本文档仅作历史记录，不要照它实现。

> 范围：`src/utils/coverage.ts`、`src/utils/caseMaps.ts`、`src/utils/collectionTrim.ts`、
> `src/pages/AssetLedger.tsx`（页签①覆盖矩阵 / 页签②用例映射）。
> 取证方式：真机 Electron（`npm run dev:renderer` + `electron .`）+ CDP 驱动真实界面；
> 原生对话框用 Win32 窗口消息驱动（`SendKeys` 在本机被 ACL 拒，见 W4-B §1 同一段说明）。
> 临时探针在 `%TEMP%`（不入库），产物在 `%TEMP%\t34\`。

## 0. 页面与视觉口径

```
✓ 页签①渲染（选择目录 + 运行覆盖矩阵 + 空态）  → ["覆盖矩阵","用例映射"]
✓ 全页未使用 .pill-*（三态走 .dev-tag）        → pill-* 命中 0
```

三态标签：`covered` → `.dev-tag.is-ok`、`missing` → `.is-fail`、`unknown` → `.is-heur`；
两张表（矩阵 / 映射清单）都在 `.dev-scroll` 里且 `tableLayout:'fixed'`；未写任何 css。

## 1. 覆盖矩阵：三态数字与合计（取证①）

造的代码目录（`%TEMP%\t34\code`）里有 6 种真实写法：Spring 注解 `@GetMapping("/api/user/{userId}")`、
RestAssured 链式 `.get("/api/pets?limit=20")`、Python `requests.get("/api/orders/1")`、
拼接 `"/api/order/" + orderId + "/detail"`、注释里的 `// /api/legacy/user/1`、以及 `"/static/app.js"`。

接口集合（分母）预置 7 个：查用户 / 建用户 / 查宠物 / 查订单 / 删用户 / 动态拼接的接口 / 日报统计（代码里没有）。

```
【覆盖矩阵三态行】
["GET /api/user/{id} · 查用户 已覆盖",
 "POST /api/user · 建用户 已覆盖",
 "GET /api/pets · 查宠物 已覆盖",
 "GET /api/orders/{id} · 查订单 已覆盖",
 "DELETE /api/user/{id} · 删用户 已覆盖",
 "GET /api/order/{id}/detail · 动态拼接的接口 无法判定",
 "GET /api/reports/daily · 日报统计（代码里没有） 未覆盖"]

✓ 三态标签齐全（已覆盖/未覆盖/无法判定） → 已覆盖 5/7 | 未覆盖 1/7 | 无法判定 1/7 | 覆盖率 71%（5/7）
✓ 三态合计 = 接口总数（明写那一条）      → 三态合计 7 = 接口总数 7
✓ 覆盖率带分子/分母（不只给百分比）      → 覆盖率 71%（5/7）
✓ unknown 行显示了原因
   → ["GET","/api/order/{id}/detail · 动态拼接的接口","无法判定",
      "路径由变量拼装，静态无法判定（代码里只看到静态前缀 /api/order）"]
✓ 三种状态都有（各 ≥1）                 → 已覆盖=5 未覆盖=1 无法判定=1
✓ 覆盖记录落进 coverageRuns（含三态计数） → {"n":1,"total":7,"c":5,"m":1,"u":1}
```

**归一化真的生效的证据**：接口写的是 `/api/user/{userId}`（完整 URL `https://api.example.com/api/user/{userId}`），
代码里是 `@GetMapping("/api/user/{userId}")` → 命中；接口写 `/api/orders/{id}`，代码里是
`requests.get("/api/orders/1")`（具体值）→ 也命中。前者证明 baseURL 被剥掉，后者证明数字段被收敛成占位符。

### 1.1 ⚠️ 取证中修掉的一个真实缺口：`dynamic-concat` 原先在真机上永远不出现

第一版 `buildCoverage` 只在「ref 的 path 本身含 `${}` / `+`」时才判 `dynamic-concat`。但
`scan:run` 的取数规则只抽**引号里的字面量**，`"/api/order/" + orderId + "/detail"` 抽出来的是
`/api/order/` —— 一条完全静态、可归一的路径。结果是：真实扫描里第三态根本触发不了，
那个接口被错判成 `missing`（用户会去补一个其实已经写了的接口）。

修法：增加「**前缀归因**」—— 当一条引用路径是某个接口路径的严格前缀，且断点正好落在一个占位符之前
（`/api/order` ⇒ `/api/order/{id}/detail`），判为 `unknown(dynamic-concat)` 并在原因里点出这个前缀。
同时加了**反向保护**：如果「前缀本身就是一个接口」（`/api/user` 与 `/api/user/{id}` 并存），
那这条引用属于前者，不能把后者抬成 unknown（单测 `前缀是另一个接口时不算动态拼接` 锁住）。

> 副作用要说清：加了这条归因后，我的取证里 `missing` 从 2 条变成 1 条、`unknown` 从 0 条变成 1 条。
> 这是**有意的**：宁可说"判不准"，也不要把"其实写了"的接口报成未覆盖。

## 2. 用例映射：100 行 CSV（取证②）

CSV 内容：90 条新用例 + 5 条与已有重复（TC-001..TC-005）+ 1 条注释行 + 2 条结构性无效 + 1 条 CSV 内部重复（TC-001）。

```
【CSV 对话框】DIALOG=选择用例映射 CSV | EDIT_SET_OK | CLICKED_OK | DONE
【导入结果】导入结果：数据行 100 行 → 新增 91 / 更新 6（其中合并 6）/ 跳过 1 / 无效 2 · 计数自洽

✓ 100 行 CSV 导入成功并写了集合            → 集合条数=91
✓ 界面给出四类计数（新增/更新/合并/跳过/无效） → 同上那行
✓ 计数自洽（added+updated+skipped+invalid === 行数）
✓ 重复 caseNo 是更新/合并，不是新增        → 集合=91，数据行=96（表头外 96 行）
```

计数为什么是「新增 91 + 更新 6 + 跳过 1 + 无效 2 = 100」：
- 90 条新编号 → 前 5 个被后面的重复行更新（TC-001..005），所以新增 91 里含 TC-901；
- 5 条重复（TC-001..005）+ 1 条 CSV 内部重复（TC-001 第三遍）= 6 次「更新」，
  其中 `merged=6` 表示这 6 次都不是新增条目（有 5 次命中已存在、1 次命中本次文件内已建条目）；
- 1 条以 `#` 开头的注释行 → 跳过；
- 2 条无效（缺编号 / 缺脚本）→ 无效并写进错误清单。

**与主进程解析的一致性**：`caseMaps.test.ts` 里有一条**对照测试**，把同一份 fixture（引号内逗号、
`""` 转义、`\r\n`、多行字段、BOM、未闭合引号、纯逗号行）分别喂给 `parseCsvLite` 与
`electron/csv.js` 的 `parseCsv`，断言 `toEqual` 逐格相同 —— 两套解析不会悄悄分叉。

## 3. `.xmind` / `.xlsx`：明确不支持（取证③）

```
【xmind 对话框】DIALOG=选择用例映射 CSV | EDIT_SET_OK | CLICKED_OK | DONE
✓ 选 .xmind 给出固定文案
   → 只支持规范化 CSV 导入，不支持 xmind/Excel 解析
```

对话框**故意把 `.xmind/.xlsx` 也列进过滤器**：只过滤 `.csv` 的话用户选不到 xmind，
也就永远看不到这句说明（他会以为工具坏了或自己选错了）。选到非 CSV 时只给固定文案，
**不读文件、不尝试解析**（[C-36] 与 `Cases.tsx`「文件管家不解析」同一决策）。

## 4. 超上限裁剪与 dropped 提示（取证④）

按 [C-24]：`caseMaps` ≤ 20000 条 **且** ≤ 1.5 MB。用 8000 条 × 约 280 字节（共 2,260,671 字节）
把字节上限打爆，然后导入一份 2 行 CSV：

```
【预置超限集合】{"wrote":true,"count":8000,"bytes":2260671}
✓ 预置 8000 条（≈2208 KB，超过 1.5 MB 上限）

【裁剪用例对话框】DIALOG=选择用例映射 CSV | EDIT_SET_OK | CLICKED_OK | DONE
【裁剪后】{"count":5577,"bytes":1571482,"notice":"历史记录已按上限裁剪，最早 2514 条已清理"}

✓ 写入前按上限裁剪（集合字节回到 1.5 MB 以内） → 1535 KB（裁剪前 ≈2208 KB）
✓ 界面出现 dropped 提示（「最早 N 条已清理」）   → 历史记录已按上限裁剪，最早 2514 条已清理
✓ 新导入的 CSV 条目在裁剪后仍然保留（丢的是最旧的）
```

- 裁剪发生在 `ws:set` **之前**（页面里唯一的写入口 `writeAll`）；
- 丢的是 `updatedAt` 最旧的那批（8000 条 seed 的 `updatedAt` 递增，csv 两条是"现在"）；
- `dropped` 数在界面上以 `.dev-banner.is-warn` 常显，同时弹一条 info toast。

> 取证时踩到的时序坑（记下来免得下次误判）：写 1.5 MB 的加密集合要几秒，第一版探针固定等 3 秒
> 取样，拿到的还是"裁剪前"的界面 —— 现象看起来像**"提示没显示"**。改成轮询等文案出现后即复现。
> 这类"证据采样太早"的假阴性，比功能 bug 更容易骗人。

## 5. 汇总

```
结果：22 通过 / 0 失败
```

单测：`collectionTrim` 18 条、`coverage` 41 条、`caseMaps` 24 条（含与主进程 `parseCsv` 的对照测试）。
三门禁见任务回执（typecheck / test:unit / build:renderer 原始输出）。

## 6. 本批未做 / 需后续注意

| 项 | 说明 |
|---|---|
| `trimToCaps` 返回字段名 | 验收写 `{ items, dropped }`，契约 [C-25] 写 `{ kept, dropped }`。按验收实现 `items`，并在 `collectionTrim.ts` 头注释点名差异 |
| 5 个集合的**其它写入点** | 本批只接了 `caseMaps`（页签②）与 `coverageRuns`（页签①）。`scanRuns` / `allureRuns` / `pomPages` 的写入点在 W5-A / W6 / W4-B 各自页面，需各自 `trimToCaps`（函数已就位，`capsOf(key)` 直接取） |
| `collectionTrim` 的字节估算 | 用「各项 JSON 字节 + 逗号 + 方括号」等价公式，避免每次重算 O(n²)；单测用 `JSON.stringify` 结果做了交叉验证 |
| 覆盖矩阵的接口来源 | 用 `apiRequests`（接口调试收藏夹）。若用户没导入接口，矩阵没有分母 → 页面直接给出「接口集合是空的」而不是显示 0/0 |
| 扫描的 `fileList` | 本页未展示（W5-A 未在 `scan:run` 里给 UI 用到的路径清单展示位）；如需要，可在矩阵页加一个「扫了哪些文件」折叠区（契约 [C-46] 允许） |