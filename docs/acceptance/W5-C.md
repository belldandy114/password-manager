# W5-C 验收取证：CodeAudit 两页签（t46）
> ⚠ 已下线（1.36.0）：代码体检的 Git 影响面页签与资产台账用例映射联动。本文档仅作历史记录，不要照它实现。

> 范围：`src/pages/CodeAudit.tsx`（页签① 代码体检 / 页签② Git 影响面）、`src/utils/gitImpact.ts`。
> 本文件只记原始输出；结论在任务回执里。
> 取证方式：真机 Electron（`npm run dev:renderer` + `electron .`）+ CDP 驱动真实界面；
> 原生目录对话框用 Win32 窗口消息驱动（`SendKeys` 在本机被 ACL 拒，见 W4-B §1）。
> 临时探针在 `%TEMP%`（不入库）。**被测目录是真的**：就是本仓库
> `E:\测试数据\test_cases\01_项目源码\password-manager`（555 个跟踪文件、有真实未提交改动）。

## 0. 页面与视觉口径

```
✓ 页签①渲染（两页签 + 规则勾选列表 + 空态）  → ["代码体检","Git 影响面"] / 规则 checkbox 12 个
✓ 全页未使用 .pill-*（三态走 .dev-tag）      → pill-* 命中 0
```

`.dev-tag` 只用了实际存在的五个变体（`is-ok` / `is-heur` / `is-unknown` / `is-unverified` / `is-fail`）——
第一版误用了不存在的 `is-warn-text`，已被本批自查发现并改掉（见 §5）。

## 1. 真实目录跑一次体检（取证①）

```
【目录对话框】DIALOG=选择要体检的目录 | EDIT_SET_OK | CLICKED_OK | DONE
✓ ① 选目录后路径回填（真实仓库目录） → E:\测试数据\test_cases\01_项目源码\password-manager

【体检摘要标签】["阻断 0","高 64","中 236","低 11","已扫 675 个文件（未跳过符号链接）","启发式命中", …]
【规则分布】{"硬编码口令":47,"硬编码地址":61,"硬编码令牌":8,"硬编码等待":49,"深层 CSS 子选择器":19,
             "断言缺失":6,"只判真假/非空":54,"只断言状态码":1,"按下标定位":36,"按界面文案定位":11,
             "绝对 XPath":2,"内网 IP 直连":6}
【前 3 行】
["硬编码口令","AGENTS.md","212","| 真实禅道地址 + 账号 + 密码 | …","高","启发式","定位"]
["硬编码地址","AGENTS.md","212","…","中","启发式","定位"]
["硬编码地址","AGENTS.md","224","git diff --cached -U0 | Select-String …","中","启发式","定位"]

✓ ① 真实目录体检跑通并出摘要（已扫 N 个文件） → 已扫 675 个文件（未跳过符号链接）
✓ ① findings 表有内容且带规则名/文件/行/原文/严重度 → 行数=301，规则种类=13
✓ ① 每条都标「启发式」 → 启发式标签 300 个
✓ ① 体检结果落 scanRuns（含 skippedSymlinks 字段） → {"n":1,"files":675,"skippedSymlinks":0}
✓ ① 点「定位」走 scan:reveal 并回显文件:行 → 已在文件管理器中定位：AGENTS.md:212
```

结果是真的：命中里有 47 处「硬编码口令」、61 处「硬编码地址」——因为 `AGENTS.md` 里那些
「曾经的泄露写法」示例（`password: '...'`、`http://<内网IP>:8181`）本身就是可疑字符串。
**这也说明启发式会误报**：这些是文档里的反例，不是真口令。页面顶部固定说明条因此写明
「启发式检查，可能误报也会漏报」，且每条结果的结论标签固定是 `启发式`。

## 2. 台账为空：算不出来 ≠ 没有影响（取证③）

本机 vault 是持久的，探针先显式清空 `caseMaps`（否则「台账为空」这条根本没被验到）：

```
✓ ② 取证前显式清空 caseMaps（保证「台账为空」是真的空） → {"ok":true,"n":0}
✓ ② 台账为空时页面常显「无映射数据，无法计算影响面」
✓ ② 台账为空时没有把它渲染成「影响 0 个脚本」

【空台账跑完后的诊断】
 banners: [
   "dev-banner is-warn :: 无映射数据，无法计算影响面：用例映射是空的，影响面无从算起。先去「资产台账 → …",
   "dev-banner is-warn :: 无映射数据，无法计算影响面（算不出来 ≠ 没有影响）。",
   "dev-banner is-info :: 无映射数据，无法计算影响面：先去「资产台账 → 用例映射」导入或新增映射，再回来…"
 ]
 面板标题: "② 受影响脚本  算不出来"
 bodyLen: 3194  hasNotice: true

✓ ② unstaged 跑通（拿到改动文件数） → 未映射改动 36
✓ ② 台账空时结果区仍明说算不出来（不是空数组冒充没影响）
```

三处都说了同一件事（页顶常显条 / 结果面板 / 建议行），因为这些是三个不同的视线落点：
用户可能只看面板标题就开始读表，只看建议就复制走。

## 3. 真实 git 仓库跑两种 scope（取证②）

```
【unstaged 改动文件】["docs/方案-本地测试资产工作站.md","electron/ipc-allure.js","electron/ipc-api.js",
                      "electron/ipc-git.js","electron/ipc-scan.js","electron/preload.js"] … 共 36 个
✓ ② unstaged 跑通 → 未映射改动 36
✓ ② 第二种 scope（对比 HEAD）也跑通 → 对比 HEAD · 36 个文件
```

补 3 条用例映射（精确路径 / 只给文件名 / 方法级）后重算：

```
✓ ③ 补 3 条用例映射（精确 / 文件名 / 方法级） → {"ok":true,"n":3}

【影响面标签】["确定命中 2","启发式 1","未映射改动 35"]
【受影响脚本前几行】
["TC-EXACT","精确路径命中","electron/ipc-scan.js","路径命中"]
["TC-METHOD","方法级映射","electron/ipc-scan.js#run","方法级"]
["TC-FUZZY","只按文件名猜","lib/ipc-scan.js","文件名推测"]
["docs/方案-本地测试资产工作站.md"]

【建议】建议先跑：TC-EXACT（electron/ipc-scan.js）、TC-METHOD（electron/ipc-scan.js#run）、
TC-FUZZY（lib/ipc-scan.js）。其中 1 个是按文件名推测的（启发式），跑之前先确认是不是你要的脚本。
另有 35 个改动文件没有对应脚本，需人工确认。

✓ ③ 算出台账命中的脚本（确定 + 启发式都有）
✓ ③ 受影响脚本表里有「路径命中/方法级」与「文件名推测」两种标签 → ["路径命中","方法级","文件名推测"]
✓ ③ 给的是可照做的建议（点名先跑哪些）
```

注意 `TC-FUZZY` 的映射写的是 `lib/ipc-scan.js`（文件根本不存在），靠 basename 子串命中 ——
所以它被标成 `文件名推测`（`.dev-tag.is-heur`），和被标成 `路径命中`（`.dev-tag.is-ok`）的两条**长得不一样**。
这正是「不许猜」的落地方式：猜可以猜，但要让人看见这是猜的。

## 4. scanRuns 超上限：写入前裁剪 + dropped 可见

预置 21 条历史（上限 20）后跑一次体检：

```
✓ 预置 21 条 scanRuns（超过 20 条上限） → n=21
✓ 历史记录区显示 21/20（已超上限）
裁剪后: {"n":20,"notice":"历史记录已按上限裁剪，最早 2 条已清理"}
✓ 写入前按上限裁剪（21 + 1 → 20 条） → n=20
✓ UI 提示 dropped（「最早 N 条已清理」）
✓ 历史记录回放「上次跳过几个符号链接」（旧记录里有 7 个的示例）
```

写入走的是 `trimToCaps([record, ...runs], capsOf('scanRuns'))`（`{maxItems:20, maxBytes:1.5MB}`），
丢最旧、`dropped` 当场变成 `.dev-banner.is-warn`（[C-25] 原话）。
历史表里 `skippedSymlinks` 缺失的老记录显示 `—` 而不是「跳过 0 个」（[C-54] 第 2 条）。

## 5. 取证中自查出的三个问题（都在 inScope 内已修）

1. **不存在的 `.dev-tag` 变体**：第一版用了 `is-warn-text`，而 `src/styles/*.css` 里只有
   `is-ok / is-heur / is-unknown / is-unverified / is-fail` 五个。用不存在的变体不会报错，
   只会**悄悄没有样式**（最坏的一种失败：看起来"能用"）。已全部换成 `is-unverified`。

2. **严重度词表和后端对不上（真问题，跨模块）**：后端 `electron/ipc-scan.js` 的
   `counts = { high, medium, low }`、规则也用 `medium`，而契约 §1.3 写的是
   `{ blocker, high, mid, low }`。页面第一版按契约读 `counts.mid`，于是出现
   **摘要「中 0」、列表里却有 236 条 medium** —— 正好是 [C-30] 点名不许出现的
   「计数和列表对不上」。修法（本批 inScope 内）：两种拼写都认，`medium → mid` 归一到同一个桶，
   **摘要直接从 `findings[]` 现算**（与表格同源，结构上不可能再对不上），落库仍写契约口径 `mid`。
   **后端词表本身要不要改成 `mid`，属 electron/ 的 inScope，本批没动**，已在回执里点给队长。

3. **文案里的 markdown 星号**：`**可能误报**` 写在 JSX 文本里不会加粗，只会原样显示两个星号；
   顺手改成 `<strong>`。另把「（不是「影响 0 个脚本」）」改成「（算不出来 ≠ 没有影响）」——
   原写法在页面上重复了一遍错读法，还会让任何 grep「影响 0 个脚本」的检查误判（本探针就被自己坑了一次）。

## 6. 汇总

```
主探针：20 通过 / 0 失败
裁剪探针：5 通过 / 0 失败
```

三门禁（原始输出见任务回执）：`npm run typecheck` exit 0；`npm run test:unit`
110 文件 1755 条全绿；`npm run build:renderer` exit 0（`CodeAudit-LUqB2l2i.js` 24,191 B）。

## 7. 本批未做 / 需后续注意

| 项 | 说明 |
|---|---|
| 后端 `counts` 词表 | 用 `medium`，契约写 `mid`。页面已兼容两种；建议后端对齐契约或契约 v13 改口径 |
| 组件拆分 | 拆分文档 §3.2 要求 `components/codeaudit/{AuditTab,FindingsTable,GitImpactTab}.tsx`，本批 inScope 只有 `CodeAudit.tsx`，故两页签同文件实现（**717 行**）。要拆是纯搬运，需要下次开 inScope（与 t41 拆 CodeGen 同型） |
| 规则勾选没有「全选/反选」 | 12 条规则逐条勾。规则再多就需要分组开关，本批 12 条可接受 |
| 体检不落 `fileList` | `scan:run` 返回了 `fileList`，历史记录里只存计数（[C-24] 不让 vault 膨胀）；要看「扫了哪些文件」需要另开落点 |
| 影响面的 `head` 空仓库 | 空仓库 + `head` 时后端返回空改动（不是错误），页面显示「当前范围没有改动文件」 |
| 探针不入库 | `%TEMP%\t46-probe.js` / `t46-probe2.js`；要长期留着得整理成 `scripts/ui-round2x-test.js` |