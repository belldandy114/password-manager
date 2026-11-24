# W4-B 验收取证：CodeGen 页接线（t31）

> 范围：`src/pages/CodeGen.tsx`（页签① OpenAPI → RestAssured、页签② 元素库 → POM）。
> 本文件只记录**怎么验的、原始输出是什么**；结论在任务回执里。
> 取证方式：真机 Electron（`npm run dev:renderer` + `electron .`）+ CDP 驱动真实界面，
> 临时探针脚本放在 `%TEMP%`（不入库），生成物落在 `%TEMP%\t31\` 与 `%TEMP%\t31-save\`。

## 0. 环境与页面

```
应用解锁进入主界面                                      ✓
页面渲染：两页签 ["OpenAPI → 骨架","元素库 → POM"]
          + 「选择文件」+「解析文本」+ textarea.code-input   ✓
空态文案（还没导入接口文档）                              ✓
全页未使用 .pill-*（结论标签走 .dev-tag）  → pill-* 命中 0   ✓
```

## 1. 真选 `.yaml` 文件（§8 里 1.1 的硬要求，只粘贴不算）

原生「打开」对话框用 Win32 窗口消息驱动（`EnumWindows` 找 `#32770` → 往文件名控件
`WM_SETTEXT` 写路径 → 给 `IDOK` `BM_CLICK`）。**不是打桩**：主进程真的执行
`file:pick` → `file:read-text`，然后页面真的解析。

```
【文件对话框】DIALOG=选择 OpenAPI / Swagger 文件
 | EDIT_SET_OK
 | CLICKED_OK
 | DONE

【解析后标签】["OpenAPI 3.0.3","4 个接口","https://petstore.example.com/v1","1 条告警","文档版本 1.4.2"]
✓ ① 真选 .yaml → 自动解析成功（4 个接口 / OpenAPI 3.0.3）
✓ ① 请求预览表 4 行且方法正确  → ["GET","POST","GET","DELETE"]
✓ ① 分组可见                    → 分组：pets（4）
✓ ① 告警默认可见（.dev-banner.is-warn，未折叠）
     → allOf 已按字段合并，oneOf/anyOf 取第一个分支：Pet
✓ ① 来源显示文件名              → ① 导入接口文档 petstore.yaml（2.1 KB · UTF-8）
```

> 为什么不用 SendKeys：本机合成按键被 ACL 拒（`SendKeys` → `Access is denied`）；
> 窗口消息不受此限。首次尝试即确认这条路径可行（`DIALOG=...` 拿到系统真对话框标题）。

## 2. 生成 → 预览（不直接写盘）

```
✓ ② 生成后先出预览（pre.tb-pre，不直接写盘）
✓ ② 预览是 RestAssured 骨架（切到测试类页签） → 长度=1993 public class PetStoreAPITest extends BaseTest {
✓ ② 多文件出文件页签                          → ["BaseTest.java","PetStoreAPITest.java"]
✓ ② 挂「未编译验证」标签（[C-106]）            → ["未编译验证"]
✓ ② 有「保存此文件」按钮（保存是另一次用户动作）
```

## 3. 保存（真走系统保存框）

```
【保存对话框】DIALOG=另存为 | EDIT_SET_OK | CLICKED_OK | DONE
✓ ③ 保存后文件真的落盘                        → 2121 字节
✓ ③ 落盘内容 = 预览的 Java 且无 BOM（javac 才能编）
     首字符="p" 首行=package api;
✓ ③ 界面给出保存路径
```

### 3.1 ⚠️ 取证中发现并修掉的真实问题：`file:save-text` 会给 `.java` 加 BOM

第一版按拆分文档走既有 `saveText`（即 `file:save-text`），落盘文件开头是 `EF BB BF`，
拿它去 `javac` **直接失败**：

```
===== javac（界面保存出来的 PetStoreAPITest.java，带 BOM）=====
PetStoreAPITest.java:1: 错误: 非法字符: '\ufeff'
?package api;
^
PetStoreAPITest.java:1: 错误: 需要 class、interface、enum 或 record
2 个错误
JAVAC_EXIT=1
```

原因在主进程 `electron/ipc-api.js` 的 `file:save-text`：`fs.writeFileSync(path, '\uFEFF' + content)`
（本来是给导出 CSV 让 Excel 认编码用的）。**界面显示「保存成功」，用户拿到的 `.java` 却编不过** ——
而「生成物必须能过 javac」是硬要求。

修法（只在 inScope 内）：保存改走 `dialogSaveFile`（选路径）+ `fileWrite`（原样写，不加 BOM），
两个都是既有 IPC（[C-81] 零新增），与 DataGenerator 导出的组合一致。主进程通道属他人 inScope，本批不动。

修完重测：

```
落盘: [{"dest":"...\\t31-save\\BaseTest.java","bytes":439,"bom":false},
       {"dest":"...\\t31-save\\PetStoreAPITest.java","bytes":2121,"bom":false}]

===== javac（编译界面保存出来的 2 个 .java）=====
(无输出 = 零 warning)
JAVAC_OK=true class文件=2 → api\BaseTest.class, api\PetStoreAPITest.class
```

classpath 用的是本机 `~/.m2` 里的真 jar：rest-assured 4.4.0 + rest-assured-common 4.4.0 +
hamcrest 2.2 + junit-jupiter-api 5.10.1 + apiguardian 1.1.2 + opentest4j 1.3.0。

## 4. 粘贴路径（第二条入口）

```
✓ ④ 粘贴路径解析成功（2 个接口 + 表 2 行）  → {"rows":2}
```

## 5. 大 spec：按钮禁用 + 不卡顿

解析是同步纯函数（`parseOpenApi` 属 W4-A，本批不改），所以做法是：点按钮 → `setBusy(true)` →
`await setTimeout(0)` **先让界面画一帧**（disabled + BusyProgress 落地）→ 再解析。
采样点在同步解析期间抓不到那一瞬，因此用 `MutationObserver` 的 mutation 记录来证明「禁用态真的出现过」：

```
✓ ⑤ 500 接口 / 56KB spec 解析成功
✓ ⑤ 解析期间按钮 disabled + BusyProgress 出现过（MutationObserver 记录）
     → disabled 记录=true busy 记录=true 总 mutation=511
✓ ⑤ 解析期间界面不卡（心跳最大间隔 < 800ms）
     → 耗时=497ms 心跳=2 次 最大间隔=497ms
```

**如实说明**：56 KB / 500 接口的一次性解析占主线程约 0.5 秒（不是数秒级白屏）。
真正的「数秒级」只会出现在几 MB 的 spec 上；要彻底消除得把 `parseOpenApi` 改成分片异步，
那属于 W4-A 的 inScope，本批不做。

## 6. 页签②：`pomPages` 集合 CRUD + POM 生成

```
✓ ⑥ 页签②空态（没有元素库页面 + 新建按钮）
✓ ⑥ role 不填名称 → 保存被拦（[C-28] 固定文案）
✓ ⑥ 拦截时没写库（ws:set 未被调用）  → 拦截前 pomPages=0
✓ ⑥ 补 role 名后保存进 pomPages（ws:set 落库）  → {"name":"LoginPage","n":1}
✓ ⑥ 元素表按契约存 name/locator/kind/role
     → {"name":"登录按钮","locator":"button","kind":"role","role":"登录"}
✓ ⑥ 生成 POM 预览（class + AriaRole.BUTTON + open()）
     → return page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("登录"));
✓ ⑥ 删除页面后 pomPages 少一条（真删、非软删）  → 剩余 0
```

### 6.1 取证中修掉的第二个真实问题：新建页面后右侧空白

第一版 `useEffect` 的「选中项消失就回落第一条」判据是 `activeId 不在 items 里`——
新建页面时 items 当然还没有它，于是刚建出来的草稿立刻被清成 `null`，表现是**点「新建页面」什么都不出来**。
改成「**还没有草稿**才自动选中第一条」（删除后的清理在 `removePage` 里显式做）：

```
修前：新建后 inputs=[] hasAdd=false
修后：新建后 inputs=["","https://","",""] hasAdd=true；加元素后 rows=1（名称/定位器/类型/role/删除）
```

## 7. 汇总

```
结果：29 通过 / 0 失败
```

三门禁（与任务回执里的原始输出一致）：`npm run typecheck` exit 0；`npm run test:unit`
103 文件 1536 条全绿；`npm run build:renderer` ✓ built。

## 8. 本批未做 / 需后续注意

| 项 | 说明 |
|---|---|
| `file:save-text` 的 BOM | 属主进程（他人 inScope）。本页已绕开；若别处也要存 `.java`/源码，同样会踩 |
| 拆分文档说的 3 个组件文件 | inScope 只有 `CodeGen.tsx`，故三个区块在同文件内实现（`OpenApiTab` / `ElementLibTab` / `GeneratedFilesView`）；要拆文件是纯搬运，需要下次开 inScope |
| `parseOpenApi` 异步化 | 见 §5 的如实说明 |
| 元素库左侧列表样式 | 复用了 `.tdg-type/.tdg-type-label/.tdg-type-hint`（已存在的类），未新增 css |

---

# 附：t41 拆分记录（CodeGen.tsx 1098 行 → `components/codegen/` 七块）

> 本节由 t41 追加：把 t31 写成单文件的 CodeGen 页按 `docs/拆分-渲染层.md` §3.1 的三区块拆开。
> **纯搬运**：逻辑 / 文案 / IPC 调用 / `pomPages` 读写路径零改动；上面 §0–§6 的 29 项真机断言原样复跑仍全过。

## A. 「原行段 → 新文件」对应表

行号取自拆分前的原件（`src/pages/CodeGen.tsx`，1098 行）。

| 原行段 | 内容 | 去向 | 现在行数 |
|---|---|---|---|
| 1–12 | 12 行 import | 各文件按实际使用重算（含相对路径调整） | — |
| 14–39 | 文件头注释 | `src/pages/CodeGen.tsx` | 89 |
| 40–121 | `PomElementRow` / `PomPage` / `KINDS` / `MAX_PAGES` / `MAX_ELEMENTS` / `validatePage` / `blankPage`（第 73 行 `MAX_SPEC_BYTES_HINT` 除外） | `src/components/codegen/pomModel.ts` | 93 |
| 73 | `MAX_SPEC_BYTES_HINT`（单行常量） | `src/components/codegen/specHelpers.ts` | 26 |
| 123–136 | `pathOf` / `defaultClassName` | `src/components/codegen/specHelpers.ts` | （同上） |
| 138–240 | `saveJavaFile` + `GeneratedFilesView` | `src/components/codegen/GeneratedFiles.tsx` | 117 |
| 242–295 | `TABS` / `TabId` / `CodeGen`（页面壳） | `src/pages/CodeGen.tsx` | （同上 89） |
| 297–659 | `OpenApiTab` | `src/components/codegen/OpenApiTab.tsx` | 382 |
| 661–982 | `ElementLibTab` 前半（状态编排 + 左栏页面列表 + 基础信息 + 「加元素」入口） | `src/components/codegen/ElementLibTab.tsx` | 381 |
| 983–1063 | 元素表那段 `.dev-scroll` + `.tbl` JSX | `src/components/codegen/ElementTable.tsx` | 106 |
| 1064–1098 | `ElementLibTab` 后半（`genErr` 提示 + 生成物预览 + 收尾） | `src/components/codegen/ElementLibTab.tsx` | （同上 381） |

**为什么多出 `ElementTable.tsx` 和 `specHelpers.ts`**：`ElementLibTab` 单独就有 434 行、`OpenApiTab` 364 行，
直接整块搬过去会撞上 400 行上限。所以把「元素表那段自闭合 JSX 子树」和「三个纯工具」各自成文件——
两者都是**整段搬运**，不是重构：前者 props 与原作用域一一对应（`elements` / `onPatch` / `onRemove`），
后者是原样三个导出。

## B. 没有代码丢失的机械证明

逐行双向比对（原件的非空行 vs 新文件的全部非空行，容错 `export ` 前缀与元素表那三处标识符改名）：

```
原始非空行（不含 12 行 import）= 1016
在新文件里找到 = 1016
未匹配 = 0

新增行（文件头 / import / ElementTable 签名 / seam 调用）= 67
```

新增的 67 行全部是：7 个文件头（每份 7 行）、按文件重算的 import（25 行）、
`ElementTable` 的 props 签名（7 行）与它在 `ElementLibTab` 里的调用处（5 行）。

## C. 行为没变的证据（29 项复跑）

```
结果：29 通过 / 0 失败
```

关键项与拆分前一致：

- 真选 `.yaml` → `OpenAPI 3.0.3` / `4 个接口` / 预览表 `["GET","POST","GET","DELETE"]` / 告警
  `allOf 已按字段合并，oneOf/anyOf 取第一个分支：Pet`；
- 生成 → 文件页签 `["BaseTest.java","PetStoreAPITest.java"]` → 保存落盘 **2121 字节、无 BOM**、首行 `package api;`；
- 页签②：`role` 不填被拦（固定文案）→ 补名后落库 → 生成 POM 含 `AriaRole.BUTTON` → 删除后剩 0。

> 唯一与 t31 记录的差异是 §5 的大 spec 换成了 **228 KB / 500 接口**（t31 那次是 56 KB），
> 属更严格的输入；耗时 440ms、心跳最大间隔 437ms，未出现卡顿。

## D. chunk 尺寸前后对比（build:renderer 实跑两次）

| | 产物 | 大小 |
|---|---|---|
| 拆分前 | `CodeGen-DrHUGTKh.js` | **40,846 B** |
| 拆分后 | `CodeGen-Bj7js-Bx.js` | **40,926 B** |

+80 B（+0.2%），来自多出来的模块包装与导出绑定；两个页签都能正常打开（29 项断言里都走到了）。
注意：chunk 名变属正常（内容变了就要换 hash），不代表行为变化。

## E. 复跑方法

```
npm run dev:renderer                     # 另开一个终端
node %TEMP%\t41-probe.js <仓库根> %TEMP%\t41
```

探针依赖 `%TEMP%\t31-dlg.ps1`（Win32 窗口消息驱动原生「打开/另存为」对话框；`SendKeys` 在本机被 ACL 拒）。
它不入库——需要长期保留时，应整理成 `scripts/ui-round20-test.js` 之类的正式回归脚本（本批没做）。