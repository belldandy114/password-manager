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


