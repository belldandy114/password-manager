# 纯函数下沉与调用约定（1.7.3 ~ 1.8）

从 AGENTS.md 迁出的完整说明：模块下沉清单、恢复自检、callIpc、侧栏类名约定。

## 1.7.3 起的约定（工程债清理，改代码前先看）

### 纯函数下沉模式（main.js 不要再无脑变大）

main.js 现在 1622 行（IPC 已全部拆走，见「IPC 域拆分进度」）。**新增/修改纯逻辑时，先抽成 `electron/<module>.js` + `electron/<module>.d.ts`，
再在 `src/utils/__tests__/<module>.test.ts` 写单测**（tsconfig 只 include `src`，d.ts 让测试能直接 import）。
已下沉的模块：

| 模块 | 内容 | 单测 |
|---|---|---|
| `electron/csv.js` | `parseCsv` / `normalizeImportRecords` / `IMPORT_FIELD_ALIASES` | `csv.test.ts`（13） |
| `electron/vault-schema.js` | `VAULT_COLLECTIONS` / `normalizeVault`（**旧库升级唯一关口**） | `vaultSchema.test.ts`（8） |
| `electron/vault-file.js` | 加密文件常量 + `inspectVaultFile`（结构自检） | `vaultFile.test.ts`（9） |
| `electron/zentao-parse.js` | `ztDecodeEntities` / `ztStripTags` / `ztTableRows`（dtable 解析） | `zentaoParse.test.ts`（13） |

- 常量只留一份定义：`ALGO` / `SALT_LENGTH` / `IV_LENGTH` / `TAG_LENGTH` 已从 main.js 移到 `vault-file.js`，
  由 main.js require。**别再在 main.js 里重新声明**——恢复校验和解密各算各的长度必然出事。
- 测试里**不要用 `Buffer`**（tsconfig 无 node 类型）；需要造二进制就自己写最小 base64 编码（见 `vaultFile.test.ts`）。
- 下沉时注意 main.js 里的 `const` 是块级作用域：`setupIpcHandlers()` 内部的 require 只能在该函数内可见，
  新抽的模块一律在**文件顶部 require**。

### 恢复前必须做结构自检

`backup:restore` 在用备份覆盖主库前，先 `inspectVaultFile()`（校验 base64 + 长度 ≥ 65 字节）：
不合格直接返回错误、**一行都不动**。以前只校验文件名，损坏的备份会把好库盖掉。

### IPC 调用一律走 `callIpc`（`src/utils/ipc.ts`）

```ts
const r = await callIpc(() => window.electronAPI.fileWrite({ filePath, content }));
if (!r.ok) { addToast(`导出失败：${r.error}`, 'error'); return; }
```

- 判定规则：只有 `success === false` / 抛异常 / 返回空 才失败；`canceled: true` 算成功（用户取消不该弹错误）。
- **写盘、导出、设置保存这三类必须判错**：以前 `fileWrite` 结果被忽略，磁盘满/无权限时照样弹「导出成功」。
  已修：`Dashboard.tsx` 的两条导出、`ExportPage.tsx` 的两条导出、`Settings.tsx` 的 `handleSave` + `applyTraySetting`。
- 注意 TS 窄化在闭包里会丢失：先 `const payload = result.data;` 再进箭头函数，否则报 `string | undefined`。

### 依赖卫生

- `react-router-dom` 已移除（代码里 0 引用，之前一直躺在 dependencies 里）。加依赖前先 grep 是否真的用得上。

### 接口调试侧栏（两行式）类名约定

`.api-list-item.api-row-2l` → `.method` + `.api-item-main`（内含 `.api-item-name` / `.api-item-sub`）+ `.api-item-del`。

- `.api-name` / `.api-hist` / `.api-pick` 这几个老类名**必须保留**（round4/5/6 依赖）。
- 删除按钮默认 `opacity: 0`，hover/选中/聚焦才出现；回归里用 `Input.dispatchMouseEvent` 真鼠标移动验证。
- 侧栏宽 272px，面板头部收紧（`.split > .pnl:first-child .pnl-head`），标题用「历史 + 计数徽标」，
  不要再写「请求历史」四个字（会被挤成两行）。
- cURL 导入的 cmd 转义清理顺序（见 `utils/curl.ts` `unwrap`）：`^`+换行 → `^"`/`^'` → `^&|<>()` → 行尾孤立 `^`，
  最后才处理 bash 的 `\`+换行。缺任何一条都会出现「地址里带 `^&`」这类残留。

### 测试样例里的敏感值：运行时拼接，不开白名单（2026-11-24）

有些测试**必须造敏感样例**才能验证规则（内网 IP 检测、脱敏工具、凭据扫描）。而本仓库是公开的，
`npm run check` 的第一道 `check-privacy` 会扫源码里的真实姓名 / 账号 / 内网地址，
**源文件里出现连续的内网地址字面量会让整个 `npm run check` 中止**（2026-11-24 `scanRules.test.ts` 撞过）。

两种解法，**选后者**：

- ❌ 往 `scripts/privacy-blocklist.local.js` 或白名单里加 —— **那是把门禁挖个洞**，下次真泄漏同样放行；
- ✅ **运行时拼接**：源码里不连续，运行时仍是真实形态。

```ts
// ⚠️ 别改回「好读的字面量」：源码里出现连续内网地址会被 check-privacy 判红并中止整个 npm run check
const privateA = '192.168.' + '1.20:8080/api';
expect(hit('sec-intranet-ip', `String url = "http://${privateA}";`)).toBe(true);
```

**必须同时配一条反例**（如 RFC 5737 文档保留段 `192.0.2.10`），否则证明不了规则不是「见到 IPv4 就报」。

### 门禁按「原文文本」计数：注释里出现也照算（2026-11-24 两次踩坑）

`scripts/check-debt-budget.js` 的静态债预算是**对源文件原文做正则计数**，不区分代码与注释：

- **`!important`**：预算 64/64（顶格）。在注释里写「这里原本用了 `!important`」→ 直接变 65/64 判红（t10 踩过）。
- **令牌外色值字面量**：预算 202/207（只剩 5 格）。在注释里写 `rgb(62,71,77)` 说明改动 → 计数 +1，超了就红（t56 首版注释 7 个 → 209/207 超 2）。

**做法**：注释里解释颜色/优先级时**用文字描述**（「原来的深灰」/「提高优先级」），不要贴可被正则命中的字面量；
需要引具体值时，写进 `docs/` 而不是 CSS 注释。这与「反向断言不要原样写出被禁的写法」是同一类问题（见 `docs/方案-本地测试资产工作站.md` §13.3 第 10、16 条）。

### 豁免口径：测试夹具里「被测规则的样例」不算泄漏

`src/utils/__tests__/` 下有为检测规则准备的**合成样例**，例如：

- `sec-password-literal` 的 `P@ssw0rd!`（2026-11-24 提交时被自查正则命中，人工判定为合成样例）
- `sec-intranet-ip` 用的私网地址（已按上一节改成运行时拼接）

**判定标准**：这段文字的用途是「给检测规则提供输入」而不是「连到某个真实资源」，且值本身是教科书式假值（`P@ssw0rd!` / `example.com` / RFC 5737 段）。
**处理**：可以不改写成拼接（改写反而是表演），但**必须在提交说明里逐条写出命中项与判定理由**，让下一个人能复核这个判断。
**不许**为了让自查变绿而降低规则的检测能力或删除用例。


