# W7 BOM 缺陷修复验收证据（t40）

> 缺陷：`file:save-text` **无条件**写 UTF-8 BOM，导致保存 `.java` 时 javac 报 `非法字符: '\ufeff'`，
> 而界面显示「保存成功」——用户拿到一个编不过的文件。
> 本文件是长证据落点；`update_task` 每条 evidence ≤200 字 + 指向本文件章节。
> 运行：2026-11-24 12:45–13:05，Windows 11 + Node 22.22。

## 1. 修复内容（7 个 inScope 文件）

| 文件 | 改动 |
|---|---|
| `electron/ipc-api.js` | `file:save-text` 入参加 `bom?: boolean`；**只有 `bom === true` 才写 `\uFEFF`**；头部注释 + 函数注释订正（原文写「带 UTF-8 BOM，Excel 不乱码」） |
| `electron/preload.js` | `saveText(content, defaultName, filters, opts)` 透传 `bom: !!(opts && opts.bom === true)`（**方法名不改**，仍是 `saveText`） |
| `src/types.ts` | `saveText` 加第 4 参 `opts?: { bom?: boolean }`，注释改成「默认不写 BOM」 |
| `src/pages/ZentaoPage.tsx:718` | CSV 导出 → 传 `{ bom: true }` |
| `src/components/ZentaoSummary.tsx:410`（缺陷汇总 CSV） | 传 `{ bom: true }` |
| `src/components/ZentaoSummary.tsx:470`（安全问题 CSV） | 传 `{ bom: true }` |
| `src/components/toolbox/RedactTool.tsx:184`（脱敏表 csv/tsv） | 传 `{ bom: true }` |

## 2. 调用点审计（**逐个全仓核对，不是抽样**）

全仓 `grep 'electronAPI.saveText'`（`src/**`）共 **6 处调用点、5 个文件**：

| # | 文件:行 | 产物 | 分类 | 传 bom？ | 依据 |
|---|---|---|---|---|---|
| 1 | `src/pages/ZentaoPage.tsx:718` | `bugsToCsv(...)` → `.csv` | **CSV（Excel 打开）** | ✅ `{ bom: true }` | 缺陷清单给 PM/开发用 Excel 看 |
| 2 | `src/components/ZentaoSummary.tsx:410` | `buildText('csv')` → `缺陷汇总-*.csv` | **CSV** | ✅ `{ bom: true }` | 汇总表同理 |
| 3 | `src/components/ZentaoSummary.tsx:470` | 拼装行 → `安全问题-*.csv` | **CSV** | ✅ `{ bom: true }` | 同上 |
| 4 | `src/components/toolbox/RedactTool.tsx:184` | `${base}-脱敏.csv` / `.tsv` | **CSV/TSV** | ✅ `{ bom: true }` | 脱敏结果要给 Excel 打开核对 |
| 5 | `src/pages/SqlSnippets.tsx:407` | `buildSqlMarkdown` → `.md` | Markdown | ❌ 不传 | 文档文件，BOM 会让部分渲染器显示成正文 |
| 6 | `src/pages/Toolbox.tsx:1827` | `toolbox-*.txt` | 纯文本 | ❌ 不传 | 中性文本，不需要偏好 |

**行为变化逐个核对结论**：
- 第 1–4 处：显式 `bom: true` → **行为与修复前完全一致**（仍然带 BOM，Excel 兼容性没变）；
- 第 5–6 处：修复前**也会带 BOM**（因为主进程无条件加），修复后**不带** —— 这两处是**有意的行为修正**
  （`.md` / `.txt` 本来就不该带 BOM；此前是通道缺陷的连带受害者，不是「静默回归」）；
- 其余所有通道（`dialog:save-file`、`tdg-write.js` 的流式写盘 BOM 开关、`export:` 那套）**一行未动**。

> inScope 里原本写的 `ExportPage.tsx` / `DataGenerator.tsx` 实为误列：它们**不调** `saveText`
> （ExportPage 走 `export:` 家族，DataGenerator 走 tdg 流式写盘自己的 BOM 开关，`bom: !!opts.bom`）。
> 已报队长并按其裁定 amend 为真实调用点文件。

## 3. 原始字节取证（不看文本，读文件前 3 字节）

脚本：stub `electron` 后真实调起注册的 `file:save-text` handler，把 `dialog.showSaveDialog` 指到临时文件，
写完后 `fs.readFileSync(p).subarray(0,3)` 逐字节打印。

### 3.1 修复前（RED，缺陷复现）

```
① 不传 bom → success=true 首三字节=EF BB BF 期望≠EF BB BF → FAIL ✗（写了 BOM）
② bom:true → success=true 首三字节=EF BB BF 期望=EF BB BF → PASS ✓
③ bom:false → 首三字节=EF BB BF 期望≠EF BB BF → FAIL ✗
④ bom:true 文件正文（跳过前 3 字节）= "账号,密码\nu1,p1\n"
⑤ 取消 → {"success":false,"canceled":true}
```

**连 `bom:false` 也写 BOM**（那时参数根本不存在，传了也被忽略）—— 这就是 t31 保存 `.java` 编不过的根因。

### 3.2 修复后（GREEN）

```
① 不传 bom → success=true 首三字节=70 75 62 期望≠EF BB BF → PASS ✓      ← "pub"（public class）
② bom:true → success=true 首三字节=EF BB BF 期望=EF BB BF → PASS ✓
③ bom:false → 首三字节=68 65 6C 期望≠EF BB BF → PASS ✓                ← "hel"（hello）
④ bom:true 文件正文（跳过前 3 字节）= "账号,密码\nu1,p1\n"             ← BOM 之外的正文完好
⑤ 取消 → {"success":false,"canceled":true}                            ← 取消仍然不写文件
```

字节层面可证伪：`70 75 62` / `68 65 6C` 是内容的真实首字节，`EF BB BF` 是 UTF-8 BOM 的三字节。
**不是**「文本里有没有 `\ufeff` 字符」这种会被编辑器/解码器悄悄丢掉的判断。

## 4. 注释订正（避免下一个人以为 BOM 是内置行为）

`electron/ipc-api.js` 头部原文：
```
 *   - file:pick / file:save-text：文件对话框（导出 CSV 带 UTF-8 BOM，Excel 不乱码）；
```
改为：
```
 *   - file:pick / file:save-text：文件对话框（`save-text` **默认不写 BOM**；给 Excel 打开的
 *     CSV/TSV 类导出由调用方显式传 `bom: true`，否则源码文件会因 `\uFEFF` 编不过）；
```

函数注释原文：`/** 保存文本文件（导出 CSV 等）：带 UTF-8 BOM，Excel 打开不乱码 */`
改为带 **为什么** 的块注释：说明「通用通道 + BOM 是偏好 → 偏好由调用方声明」，
并点名 `.java` 被 `javac` 拒绝的后果。

`src/types.ts` 的同名注释也从「自动加 BOM」改成「**默认不写 BOM**；CSV/TSV 导出请传 `{ bom: true }`」。

## 5. 三条门原始输出

```
========== npm run typecheck ==========   tsc --noEmit 无诊断，exit=0
========== npm run test:unit ==========   Test Files 109 passed (109) / Tests 1716 passed (1716)，exit=0
========== node scripts/check-ipc-contract.js ==========
IPC 契约检查：handler 221 个 / preload 调用 219 个 / 暴露方法 239 个 / 类型声明 239 个
! 注册了但没人调用（2）：pin:close-all、pin:count
结果：通过（无 error 级问题）exit=0
```

## 6. 遗留 / 说明

1. 本任务**没有新增单测**：`file:save-text` 是 `require('electron')` 的 handler，vitest 里跑不了；
   可证伪证据走 §3 的原始字节脚本（两条路径都断言了）。若后续要把这条固化成回归，
   建议把「前缀决策」抽成纯函数（`bomPrefix(bom)` 一行），但那是新增文件、需要单独 inScope。
2. `SqlSnippets`（.md）与 `Toolbox`（.txt）的 BOM 消失是**有意的修正**，不是回归；
   若有用户反馈「导出的 md 用某编辑器打开乱码」，那是编辑器问题（UTF-8 无 BOM 是标准做法）。
3. 渲染层还有一处 `saveText` 的测试桩（`src/utils/__tests__/sqlSnippets.test.tsx`）只有 1–2 个形参，
   新增的第 4 参是**可选**，所以桩不用改（typecheck 已证）。
4. 若将来有人想给 `file:save-text` 再加「按扩展名自动加 BOM」，请先读 t40 的回执：
   那正是本次要消掉的隐式偏好，会把同一个坑再挖一遍。