# 一页方案：SQL 片段「填充变量并复制」第二批（1–5 项）

> 2026-11-21。第一批已交付并验证：变量填充复制弹窗 + 变量说明联动 + 实时预览 + 背景图玻璃。
> 本文是第二批的契约，实现按 §4 分片；验收按 §5 逐条判真假。

## 1. 目标与范围

**做**（用户勾选，5 项）：

| 编号 | 项 | 一句话 |
|---|---|---|
| A | 变量说明一键生成 | 编辑弹窗里按正文变量补 `{{a}} = ` 模板，不覆盖已写释义 |
| B | 常用日期变量一键填 | 复制弹窗里 `today` / `now` / `today-7d` 一键填值 |
| C | 库 / 环境可选已有值 | 输入框下给「已有值」可点标签，仍可自由输入 |
| D | 复制入口推广到笔记页 | 弹窗抽成组件，笔记页复用同一套 |
| E | 弹窗纳入玻璃门禁 | `ui-glass-opaque-scan.js` 扫弹窗，且修它首屏 `rows=0` 竞态 |

**不做**（写死，不要顺手加）：变量值持久化、Enter 快捷键、批量复制、按库/环境筛选列表、SQL 执行、目录模式语义变更。

## 2. 数据与接口

- **不改** vault 结构、`Note` 字段、`fileOf()` 命名、目录模式语义。
- **不新增** IPC。
- 纯逻辑继续放 `src/utils/`，页面只做展示（既有约定）。

## 3. 逐项契约

### A. 变量说明一键生成

- 入口：编辑弹窗「变量说明」标签行右侧一个「按正文生成」（`.btn-ghost btn-sm`）。
- 算法（纯函数 `mergeVarHint(hint, vars)`）：按 `extractVars(content)` 的顺序，对每个变量
  - 说明里**已有**该变量的条目（`parseVarHint` 能解析出来）→ **原样保留**；
  - 没有 → 追加 `{{name}} = `（用 `；` 分隔，不用换行，避免把 textarea 撑成一大坨）。
- 判据（队长裁定 2026-11-21）：**只要 `extractVars(hint)` 里出现过这个名字就跳过**，包括用户只写了裸 `{{t}}`、没写释义的情况。不要用「`parseVarHint` 能不能解析出来」当已有判据 —— 否则裸 token 会被再追加一次，产出 `{{t}}；{{t}} = `。
- 幂等：连点两次不产生重复条目。
- 正文没有变量 → 按钮 disabled，`title` 说明「正文里没有 {{变量}}」。
- 用户已手写的释义一个字都不能动（这是最容易做错的一点，要单测锁住）。

### B. 常用日期变量一键填

- 识别（纯函数 `dateVarKind(name)`）：
  - `today` → `YYYY-MM-DD`
  - `now` → `YYYY-MM-DD HH:mm:ss`
  - `today±Nd`（如 `today-7d`、`today+1d`）→ 当天 ±N 天的 `YYYY-MM-DD`
- 值由纯函数 `dateVarValue(name, now)` 算出，`now` 可注入（单测要用固定时间，**不许在函数内部取 `new Date()`**）。
- 时区：**本地时区**，用 `getFullYear/getMonth/getDate` 拼，禁止 `toISOString().slice(0,10)`（会差一天）。
- 弹窗里只有识别为日期变量的输入框，右侧给一个「填今天」/「填现在」小按钮。
- 不认识的变量名：不给按钮，不猜。裁定：`today+0d` 算可识别；`now±Nd`、大小写变体（`Today`）**不识别**；按钮文案固定 `填今天` / `填现在`。

### C. 库 / 环境可选已有值

- 编辑弹窗「库 / 环境」输入框下方：列出**已有片段里出现过的值**，按出现次数降序、去重、最多 8 个，每个是可点标签（`.chip` 或既有可点标签类），点一下填进输入框。
- 仍然可自由输入（组合值 `test_order / 预发` 是合法值，不做解析）。
- ⚠️ **禁止 `<datalist>`**：AGENTS.md 记录它会触发 Chromium 崩溃（`0xC0000005`，无 JS 报错）。用可点标签。
- 没有历史值时整行不渲染（不出现空标题）。

### D. 复制入口推广到笔记页

- 把现有弹窗抽成 `src/components/CopyVarsModal.tsx`，props：
  `{ open, content, varHint?, title?, onClose, onCopied(message) }`；
  内部继续用 `utils/sqlVars.ts` 与 `utils/clipboard.ts`，**不复制一套新逻辑**。
- `SqlSnippets.tsx` 改为使用该组件（行为零变化，现有 5 条弹窗用例必须继续绿）。
- 弹窗标题（队长裁定）：SQL 页保留 `填充变量并复制 SQL`，组件默认 `填充变量并复制`，笔记页用默认值。§5 只判行为不判标题。
- `Notes.tsx` 增加行内「复制」入口（与 SQL 页同图标位次），打开同一个组件。
- 笔记判定：只对当前可见笔记生效；`kind==='sql'` 的条目本来就不在笔记页（保持）。
- 不改笔记保存/编辑/目录模式逻辑。

### E. 弹窗纳入玻璃门禁

- **根因（qa t2 实测，2026-11-21，比本节初稿更准）**：不是"首屏数据没渲染完"，而是 `navTo()`（`scripts/lib/app.js`）的完成条件两半都失效 —— `.page-loading` 在 `src/` 里**不存在**（恒真），而 `PageSkeleton` 自己渲染 `<div className="pg">`（骨架屏满足 `.pg`）。于是 `navTo` 在骨架期（65→365ms）就返回，`prep` 的 `clickText` 落空（实测 `点击返回 false`）**且返回值被丢弃**，页面停在默认卡片视图。只红第一页是因为第二次进页面时数据已在 store。
- 修法（qa 临时副本连跑 3 次 exit=0）：就绪判据**按页写死且视图无关**（骨架屏消失 + 工具栏出现 + `swBtn === 3` + `(cards | rows) >= 1` + 分页条出现，10s 超时 + 明确文案）；`prep` 返回 false **直接失败**；`prep` 生效判据 5s；扫描前加「两次采样签名一致」的稳定判据；删掉 `sleep(600/700)`。
  ⚠️ **不能只等 `rows >= 1`**：网址管理默认卡片视图下 `rows` 恒 0，会死锁。本文初稿的「`rows>=1` 或 分页条」是它的真子集，按上述判据实现。
- 新增步骤：进 `SQL 片段` 页 → 打开复制弹窗（造一条带变量的片段）→ 按既有判据（可见 && 背景 alpha ≥ 0.999 && 面积 > 600）扫 `.modal` 子树，深浅两套主题各一次。
- 白名单：`btn-primary`（既有条目，主行动按钮本应实心）。实测 `.modal` 子树唯一不透明块就是它（93×34），**无需新增白名单**。
- 违规 → 打印 class/尺寸/颜色并以非 0 退出；不违规 → 打印一行实测值（`pre` 必须带 `var(--glass-input-soft)` 的 computed 值锚点，实测 `color(srgb 1 1 1 / 0.42)`）。
- 顺带修同源假绿：布局未稳定时 `getBoundingClientRect()` 全 0，会把 12 个块数成 1 个；用「两次采样签名一致」兜住（方案 §5 有实测）。

## 4. 分片与文件边界（批准后按此下发）

| 片 | 内容 | 文件 |
|---|---|---|
| A（frontend） | A + B + 抽出 `CopyVarsModal`（不含笔记页接线） | `src/utils/sqlVars.ts`、`src/components/CopyVarsModal.tsx`(新)、`src/pages/SqlSnippets.tsx`、`src/utils/__tests__/sqlVars.test.ts`、`src/utils/__tests__/sqlSnippets.test.tsx` |
| B（frontend） | C + D（笔记页接线） | `src/pages/Notes.tsx`、`src/pages/SqlSnippets.tsx`（只加历史值标签 + `dbEnvValues` 纯函数）、`src/utils/__tests__/notesCopy.test.tsx`(新)、`src/utils/__tests__/sqlSnippets.test.tsx`（只追加 `dbEnvValues` 用例） |
| C（qa） | E | `scripts/ui-glass-opaque-scan.js` |

依赖：B 依赖 A（共用组件），C 依赖 A（要弹窗已存在）。**A、C 可并行**（路径不重叠）。

## 5. 验收（逐条可判真假）

1. 变量说明：正文 `select * from {{t}} where {{id}}=1` + 说明 `{{id}} = 主键` → 点「按正文生成」后说明变成含 `{{t}} = ` 与 `{{id}} = 主键`，且 `{{id}}` 的释义未被改；再点一次文本不变（幂等）。
2. 日期变量：固定 `now = 2026-03-01 09:05:06`，`today`=2026-03-01、`now`=2026-03-01 09:05:06、`today-7d`=2026-02-22、`today+1d`=2026-03-02（跨月），未知变量返回空。
3. 库/环境：库里已有 `test_order / 预发`、`test_order` 两种值 → 编辑弹窗出现这两个可点标签，点击后输入框值变成该值；库为空时不渲染标签行。
4. 笔记页：行内有复制入口，点开弹窗与 SQL 页一致（有变量出输入框、无变量出提示、预览与复制一致）。
5. SQL 页 5 条既有弹窗用例全绿（抽组件未改行为）。
6. 门禁：`node scripts/ui-glass-opaque-scan.js` 连跑 2 次都是 0 违规，且第二套主题（dark）同样绿；把新增的玻璃规则注释掉时必须能红（变异验证）。
7. `npx tsc --noEmit` / `npm run check` 全绿。
8. 打包版：`npm run pack` + `USE_PACKED=1` 冒烟通过（启动 16s 存活 + 弹窗扫描 0 违规）。

## 6. 风险与硬约束

- `<datalist>` 禁用（C）。
- 组件抽取是「行为零变化」重构，抽完必须先跑既有用例再改功能（避免把回归混进重构）。
- 门禁脚本改动不要用固定 sleep 掩盖竞态；失败信息要写清楚「等什么、等了多久」。
- 门后编辑必须复跑对应门（AGENTS 约定）。

## 7. 实现清单（frontend）

> 2026-11-21，frontend（t1）。只做清单，不改任何 `src/` 代码。
> 行号基于当前工作区现状（第一批未提交：`src/utils/sqlVars.ts` 与 `sqlVars.test.ts` 是新增文件，
> `SqlSnippets.tsx` / `sqlSnippets.test.tsx` / `redesign.css` 有改动），编辑后行号会漂移，
> 以**函数名 / 选择器 / 文案**为准。

### 7.1 分片与文件边界（可机械核对）

| 片 | 功能 | 允许改的文件 | 明确不碰 |
|---|---|---|---|
| A | 功能 A（变量说明一键生成）+ 功能 B（日期变量）+ 抽出 `CopyVarsModal` | `src/utils/sqlVars.ts`、`src/components/CopyVarsModal.tsx`(新)、`src/pages/SqlSnippets.tsx`、`src/utils/__tests__/sqlVars.test.ts`、`src/utils/__tests__/sqlSnippets.test.tsx` | 笔记页、`src/styles/*`、`electron/*`、`scripts/*` |
| B | 功能 C（库 / 环境历史值）+ 功能 D（笔记页接线） | `src/pages/SqlSnippets.tsx`（只加历史值纯函数 + 标签行）、`src/pages/Notes.tsx`、`src/utils/__tests__/notesCopy.test.tsx`(新) | 组件本体（A 已定稿）、`sqlVars.ts`、A 的两个测试文件、样式表 |
| C（qa） | 功能 E（玻璃门禁） | `scripts/ui-glass-opaque-scan.js` | 本次 frontend 不改 |

两片**都不改任何 CSS 文件**（§4 的文件边界里没有样式表）。新控件只用既有类：
`.btn-ghost.btn-sm`、`.chip`、`.suggest-row`、`.form-group`，其余用行内样式。
`.chip` 在背景图模式已有玻璃规则（`redesign.css:8335`），`.btn-ghost` 无底色，
所以 A/B 新增的元素不会让 E 的弹窗扫描变红。

### 7.2 A 片：函数签名与行为（写死）

**`src/utils/sqlVars.ts`（新增 3 个导出；既有 3 个函数一字不改）**

```ts
export function mergeVarHint(hint: string, vars: string[]): string
export type DateVarKind = 'date' | 'datetime' | null
export function dateVarKind(name: string): DateVarKind
export function dateVarValue(name: string, now: Date): string   // now 必填，禁止函数内 new Date()
```

`mergeVarHint` 的规则（逐条都有单测）：

1. `vars` 空 / null → 返回 `String(hint ?? '')` **原文**，不 trim、不动空白。
2. 「已有条目」判据 = `parseVarHint(hint)` 的 key 集合（严格按 §3A「能解析出来才算已有」）。
3. 缺失变量按 `vars` 顺序追加，每条 `{{name}} = `（等号后**一个空格**，末尾不加分号）。
4. 分隔符：`hint.trim() === ''` → 直接返回追加串（丢掉纯空白，先导分号不出现）；
   `hint` 末尾（**忽略尾部空白**，正则 `/[;；,，\n\r]\s*$/`）已是分隔符 → 不再补；
   否则补全角 `；`。**只新增字符，不改写已有字符**（含既有空格、全角冒号、换行）。
5. 幂等：第二次调用时缺失集合为空 → 走规则 1，返回第一次结果逐字符相同。

`dateVarKind` 的识别表：`today` → `'date'`；`now` → `'datetime'`；
`/^today([+-])(\d{1,3})d$/`（含 `today+0d`）→ `'date'`；其余一律 `null`
（`TODAY` / `tody` / `today-d` / `today+1` / `now-1d` / 空串 / undefined —— §3B「不认识的变量名不猜」）。

`dateVarValue`：

- `date`：`${yyyy}-${MM}-${dd}`，用 `getFullYear/getMonth/getDate` 拼；`today±Nd` 用
  `new Date(y, m, d + delta)`（本地时区，跨月 / 跨年 / 闰年由 Date 自己算）。
- `datetime`：再拼 `${HH}:${mm}:${ss}`。
- `dateVarKind(name) === null` 或 `Number.isNaN(now.getTime())` → `''`。
- **禁止** `toISOString().slice(0,10)`（UTC 会差一天，§3B）。

**`src/components/CopyVarsModal.tsx`（新）**

```ts
export interface CopyVarsModalProps {
  open: boolean;
  content: string;
  varHint?: string;
  title?: string;                 // 默认 '填充变量并复制'
  onClose: () => void;
  onCopied: (message: string) => void;
}
export function CopyVarsModal(props: CopyVarsModalProps): JSX.Element
```

- 只 import `Modal` / `copyPlain` / `extractVars, fillVars, parseVarHint, dateVarKind, dateVarValue`，
  **不复制逻辑**（§3D）。
- 状态：`vals: Record<string,string>`；`useEffect(() => { if (open) setVals({}); }, [open])`
  —— 关窗即丢，重开清空（与现行为一致）。不依赖 `content`，避免输入过程中被清。
- JSX 照搬现 `SqlSnippets.tsx:883-914`：提示行文案两种（`检测到 N 个变量，留空则保留原样。` /
  `这段内容里没有 {{变量}}，可以直接复制。`）、每个变量一个 `.form-group`
  （label `{{v}}` + 释义、`input aria-label={\`变量 ${v}\`}`、首个变量 `data-autofocus="1"`）、
  底部 `pre.code2.sql-var-preview` 预览（与 `fillVars` 同源）。
- 输入框 id 由 `sql-var-${i}` 改为 `copy-var-${i}`（组件被两页复用，`sql-` 前缀会误导；
  `aria-label` 不变，既有用例判据不受影响）。
- 日期变量按钮（§3B「输入框右侧」）：`dateVarKind(v)` 非 null 时，在**同一个** `.form-group` 内、
  input 之后加
  `<button type="button" className="btn btn-ghost btn-sm" data-fill-var={v}
   aria-label={kind === 'datetime' ? '填现在' : '填今天'}>…</button>`，
  onClick `setVals(p => ({ ...p, [v]: dateVarValue(v, new Date()) }))`。
- ⚠️ **布局硬约束**：`html[data-bg='image'] .modal .form-group > input`（`redesign.css:8203`）
  是**直接子元素**选择器；把 input 包进 `<div>` 会让它掉玻璃底（输入框面积 ~15k px²），
  E 的弹窗扫描必红。所以这一行只能用行内 flex：
  `.form-group` 加 `style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:8 }}`，
  label 加 `style={{ flex:'0 0 100%' }}`，input 加
  `style={{ flex:'1 1 220px', width:'auto', minWidth:0 }}`，button 作为直接兄弟。
  **不要**为此新增 CSS 类（会越出 A 片文件边界）。
- 两条复制路径（先 `onCopied` 再 `onClose`）：

| 动作 | 剪贴板 | `onCopied(message)` |
|---|---|---|
| 复制原文 | `content` 原样 | `已复制原文` |
| 替换并复制（无变量） | `content` | `已复制（没有变量）` |
| 替换并复制（有变量） | `fillVars(content, vals)` | `已复制（替换 ${filled} / ${vars.length} 个变量）`，`filled` = 值 trim 后非空的变量数 |

页面侧的展示由页面决定：SQL 页 `onCopied={m => flash(m === '已复制原文' ? 'SQL 已复制原文' : m)}`
（与现文案**逐字一致**）；笔记页 `onCopied={m => setToast(m)}`。

**`src/pages/SqlSnippets.tsx`（A 片部分）**

- 删：`copyVals/copyVars/copyHint/copyPreview`（296-306）、`copyOriginal/copyFilled`（498-520）、
  复制弹窗 JSX（870-915）；保留 `copyTarget` 与 `openCopy`。
- 换成：`<CopyVarsModal open={!!copyTarget} content={copyTarget?.content || ''}
  varHint={copyTarget?.varHint || ''} title="填充变量并复制 SQL"
  onClose={() => setCopyTarget(null)} onCopied={…} />`。
  **标题保留「… SQL」**，其余行为零变化 —— §5 第 5 条的 5 条既有用例是这次重构的回归锁。
- 编辑弹窗「变量说明」生成按钮：`.form-group` 内先放一个 label 行
  `<div style={{display:'flex',alignItems:'center',gap:8}}><label>变量说明</label>
  <button className="btn btn-ghost btn-sm" style={{marginLeft:'auto'}} …>按正文生成</button></div>`，
  textarea 仍是 `.form-group` 的**直接子元素**（既有样式与用例都依赖）。
  `disabled = editingVars.length === 0`；`title` 分别
  `正文里没有 {{变量}}` / `按正文里的变量补 {{名字}} = ，已有释义不动`。
  `editingVars = useMemo(() => extractVars(editing?.content || ''), [editing?.content])`；
  onClick `setEditing({ ...editing, varHint: mergeVarHint(editing.varHint || '', editingVars) })`。
- import 调整：`extractVars, mergeVarHint`；删掉不再使用的 `fillVars, parseVarHint`。

### 7.3 B 片：函数签名与接线

**功能 C —— `dbEnvValues`（放 `src/pages/SqlSnippets.tsx` 纯函数区，紧跟 `tagsOf`）**

```ts
export function dbEnvValues(notes: Note[] | null | undefined, max = 8): string[]
```

- 只取 `sqlOnly(notes)`；值 `String(n.dbOrEnv || '').trim()`，空值忽略。
- 计数 + 首次出现序号：`Map<string, { count: number; first: number }>`；
  排序 `count desc` → 同票 `first asc`；`slice(0, Math.max(0, max))`。
- 大小写敏感（`TEST_ORDER` 与 `test_order` 是两个真实库名，不做 lowercase）。
- 编辑弹窗「库 / 环境」`.form-group` 内、input 之后（input 保持直接子元素）：

```tsx
{dbEnvOptions.length > 0 && (
  <div className="suggest-row" aria-label="已有库 / 环境值">
    {dbEnvOptions.map(v => (
      <button key={v} type="button" className="chip"
        onClick={() => setEditing({ ...editing, dbOrEnv: v })}>{v}</button>
    ))}
  </div>
)}
```

`const dbEnvOptions = useMemo(() => dbEnvValues(items), [items]);` —— 用**全量** `items`，
不受搜索 / 标签筛选影响（否则标签行随筛选跳动）。新增与编辑共用同一弹窗，所以新增时也显示历史值
（同一代码路径，不另写分支）。没有历史值时**整行不渲染**（不出现空标题/空容器）。
`.suggest-row` + `.chip` 是既有组合（`Environments.tsx:681-687`），照抄即可。
**禁止 `<datalist>`**：用可点标签，单测加机械断言。

**功能 D —— `src/pages/Notes.tsx`**

- 状态：`const [copyTarget, setCopyTarget] = useState<{ title: string; content: string } | null>(null);`
  （不引入 `varHint`，笔记没有该字段）。
- 本地库：`const openCopy = (n: Note) => setCopyTarget({ title: n.title, content: n.content || '' });`
- 目录模式：`openDirCopy(f: WeeklyFile)` —— 正文已缓存直接用；没缓存先 `notesRead(dir, f.name)`
  并写回 `bodies`（与 `openDirNote` 同款读法，**不重构**既有 `openDirNote/editDirNote`，
  保持 D 的 diff 最小），失败走 `setDirError`。
- 入口位次：SQL 页 `.cell-actions` 第一个就是复制，笔记页 `card2-actions` 现有「钉 / 编辑 / 删除」，
  复制放在**第一个**：`<IconBtn title="复制（可填 {{变量}}）" onClick={…}><Icons.copy size={13} /></IconBtn>`；
  目录模式那张卡用 `openDirCopy(f)`。`.card2-actions` 外层已有 `stopPropagation`，不用改。
- 弹窗（放在 `preview` 那个 Modal 之后）：

```tsx
<CopyVarsModal open={!!copyTarget} content={copyTarget?.content || ''}
  title="填充变量并复制" onClose={() => setCopyTarget(null)}
  onCopied={m => { setToast(m); setTimeout(() => setToast(''), 2600); }} />
```

标题与 SQL 页不同是有意的（SQL 页保留「… SQL」）；§5 第 4 条判的是**行为一致**，不判标题文案。
- 不改：保存 / 编辑 / 目录模式 / 关联 / 预览逻辑；`kind==='sql'` 仍不进笔记页（`visibleItems` 不动）。

### 7.4 单测用例清单

**A：`src/utils/__tests__/sqlVars.test.ts` 追加两个 describe**

`SQL 变量：说明一键生成`（`mergeVarHint`）

1. 已有释义保留 + 缺失按正文顺序追加：vars `['t','id']`，hint `'{{id}} = 主键'`
   → 结果 === `'{{id}} = 主键；{{t}} = '`，且 `parseVarHint(结果).id === '主键'`（§5 第 1 条原样）。
2. 已有释义**一个字都不动**：hint `'  {{a}}：甲\n{{b}} = 乙  '`，vars `['a','b','c']`
   → `结果.startsWith(hint)`；`parseVarHint(结果)` 的 a/b 与解析原 hint 一致；只在尾部多 `{{c}} = `。
3. **幂等**：`mergeVarHint(mergeVarHint(h, vars), vars) === mergeVarHint(h, vars)`。
4. 空 / 全空白说明：`''` 与 `'  '` 都 → `'{{a}} = ；{{b}} = '`（无先导 `；`，不残留空白）。
5. 末尾已有分隔符：hint `'{{a}} = A；'` → `'{{a}} = A；{{b}} = '`（不出现 `；；`）；
   末尾是空白时分隔符判定仍生效：`'{{a}} = A；  '` → `'{{a}} = A；  {{b}} = '`（原文空白不改写）。
6. 没有变量：vars `[]` / undefined → 原文全等（含尾部空格、不 trim）。
7. 契约口径记录：hint `'{{t}}'`（裸 token，无赋值号）+ vars `['t']` → `'{{t}}；{{t}} = '`。
   这是 §3A 字面判据的结果（`parseVarHint` 解析不出来 → 视为缺失），见 §7.6 第 2 条待裁决。

`SQL 变量：常用日期变量`（`dateVarKind` / `dateVarValue`）

8. 识别：`today`/`now`/`today-7d`/`today+1d`/`today+0d` 分别 → `'date'|'datetime'|'date'…`；
   `TODAY`/`tody`/`today-d`/`today+1`/`now-1d`/`''`/undefined → `null`。
9. **§5 第 2 条原样**：`now = new Date(2026, 2, 1, 9, 5, 6)` →
   `today='2026-03-01'`、`now='2026-03-01 09:05:06'`、`today-7d='2026-02-22'`、`today+1d='2026-03-02'`；
   未知变量名 → `''`。
10. **跨月 / 跨年**：`now = new Date(2026, 0, 1)` → `today-1d='2025-12-31'`、`today+31d='2026-02-01'`。
11. 闰年：`now = new Date(2028, 2, 1)` → `today-1d='2028-02-29'`。
12. **本地时区（禁 ISO）**：按 `getTimezoneOffset()` 选本地 `00:30`（东半球）或 `23:30`（西半球），
    断言 `dateVarValue('today', d) === '2026-03-01'` 且 `d.toISOString().slice(0,10) !== '2026-03-01'`
    （offset === 0 的 UTC 机器跳过反证断言）。
13. 坏入参：`new Date('bad')` → `''`；`now` 合法但 name 不认识 → `''`。
14. 补零：`new Date(2026, 0, 5, 7, 8, 9)` → `'2026-01-05 07:08:09'`。

**A：`src/utils/__tests__/sqlSnippets.test.tsx` 追加页面用例**（既有 785 行**不改一字**，尤其那 5 条弹窗用例）

15. §5 第 1 条：编辑弹窗 → 正文改 `select * from {{t}} where {{id}}=1`、说明填 `{{id}} = 主键`
    → 点「按正文生成」→ 值含 `{{t}} = ` 与 `{{id}} = 主键`；**再点一次值不变**（幂等）。
16. 正文没有变量 →「按正文生成」`disabled` 且 `title` 含 `正文里没有 {{变量}}`。
17. 日期按钮：fake timers 固定 `2026-03-01 09:05:06`（`vi.useFakeTimers()` + `vi.setSystemTime`），
    片段含 `{{today}}` / `{{now}}` / `{{orderNo}}` → `[data-fill-var]` 数量 2；
    点 `[data-fill-var="today"]` → `input[aria-label="变量 today"]` 值 `'2026-03-01'`；
    点 `[data-fill-var="now"]` → `'2026-03-01 09:05:06'`；`{{orderNo}}` 没有按钮。
    用例结束 `vi.useRealTimers()`（放在 `afterEach`）。
18. 关窗重开：填过值 → 关闭 → 再开同一片段 → 输入框为空（与现行为一致）。

**B：`src/utils/__tests__/notesCopy.test.tsx`（新，`// @vitest-environment jsdom`）**

纯函数 `dbEnvValues`：

1. 计数降序 + 去重 + trim：`test_order / 预发`×2、`test_order`×1 → `['test_order / 预发','test_order']`。
2. 同票按首次出现顺序；空值 / 空白 / undefined 忽略。
3. 上限 8：10 个不同值 → length 8 且前 8 符合排序；`max=0` → `[]`；`max` 超实际 → 全给。
4. 只统计 `kind==='sql'`：普通笔记的 `dbOrEnv` 不参与。
5. `null` / `[]` → `[]`，不抛错。

功能 C（渲染 `SqlSnippets`）：

6. §5 第 3 条：打开编辑弹窗 → `.suggest-row` 里 2 个 `button.chip`，顺序按次数；
   点 `test_order` → `input[aria-label="库或环境"]`.value === `'test_order'`。
7. **库为空不渲染标签行**：所有 `dbOrEnv` 为空 → `.suggest-row` 与 `button.chip` 都不存在
   （也不出现空标题）。
8. 机械锁：`document.querySelector('datalist') === null`（禁用 `<datalist>` 的回归）。
9. 自由输入不被破坏：点标签后再手改成组合值 `test_order / 预发`，保存后 `dbOrEnv` 为用户最后输入。

功能 D（渲染 `Notes`）：

10. 本地库：卡片 `.card2-actions` 第一个按钮 `title` 含「复制」；点击开 `[role="dialog"]`；
    正文含 `{{today}}` 时出 `input[aria-label="变量 today"]` + `[data-fill-var="today"]`。
11. 无变量笔记：点「替换并复制」→ 剪贴板 === 原文，页面提示含「已复制」。
12. 有变量：点「填今天」（fake timers 固定 `2026-03-01`）→「替换并复制」→ 剪贴板 === 替换后文本；
    「复制原文」→ 剪贴板 === 原文（两条路径独立）。
13. `kind:'sql'` 的条目不出现在笔记页 → 没有复制入口（可见性规则不变）。
14. 目录模式：桩 `notesList` 返回 `a.md` + `b.sql.md`、`notesRead` 返回正文 → 只渲 `a.md`；
    点复制 → 调过 `notesRead(dir,'a.md')` 且弹窗正文 = 文件正文。
15. 关窗重开：变量值清空（与 SQL 页一致）。
16. 与 SQL 页同一套：同一 content 在两页产出的 `input[aria-label^="变量 "]` 数量与
    `[data-fill-var]` 数量相同（组件没分叉）。

### 7.5 执行顺序（TDD，先重构后功能）

1. **A1 纯函数**：先写 7.4 的 1-14 → 跑红 → 实现 `mergeVarHint/dateVarKind/dateVarValue`
   → `npx vitest run src/utils/__tests__/sqlVars.test.ts` 全绿。
2. **A2 行为零变化重构**：只把弹窗 JSX/状态/复制两条路径搬进 `CopyVarsModal`，
   `SqlSnippets` 接线 → `npx vitest run src/utils/__tests__/sqlSnippets.test.tsx`
   **既有 5 条全绿且用例文件零改动**（§6 的硬要求）。红就停下来修重构，不许顺手改功能。
3. **A3 加功能 A/B**：7.4 的 15-18 驱动「按正文生成」与日期按钮。
4. **B1**：7.4 的 1-5 驱动 `dbEnvValues`。
5. **B2/C**：6-9 驱动历史值标签行。
6. **B3/D**：10-16 驱动笔记页接线。
7. 每片收尾：`npx vitest run`（全量）→ `npx tsc --noEmit` → `npm run check`；
   交付前 `npm run build:renderer`；E 片（qa）跑 `node scripts/ui-glass-opaque-scan.js`。
   门后任何编辑都要复跑对应门（AGENTS 约定）。

### 7.6 待队长裁决 / 契约解释点（不自行改契约）

1. **`dbEnvValues` 的落点**：§2 要求「纯逻辑继续放 `src/utils/`」，但 §4 的 B 片文件清单没有
   `src/utils/*`。本清单按既有惯例放在 `src/pages/SqlSnippets.tsx` 纯函数区
   （与 `startOfWeek/filterSql/countSql/buildSqlMarkdown` 同层，页面测试覆盖），
   测试放在 B 片唯一新文件 `notesCopy.test.tsx`。若要求严格放 `src/utils/`，
   需要把 `src/utils/sqlVars.ts` + `sqlVars.test.ts` 写进 B 片（B 依赖 A、串行执行，
   不会造成同批 inScope 重叠）。
2. **裸 token 判据**：`mergeVarHint` 严格按 §3A（`parseVarHint` 能解析出来才算已有），
   于是 `{{t}}`（无赋值号）会被当成缺失再追加一次，产出 `{{t}}；{{t}} = `。
   若要避免这种重复提及，判据改成「`extractVars(hint)` 里出现过就跳过」，
   需要队长确认后改契约（实现与用例都只有一处）。
3. **弹窗标题**：SQL 页保留 `填充变量并复制 SQL`（行为零变化），组件默认 `填充变量并复制`，
   笔记页用默认。§3D 只约定了 `title?`，没固定文案。
4. **日期按钮文案**：`填今天` / `填现在`（§3B 原文）。`today+0d` 判为可识别；
   `now±Nd` 与大小写变体不识别（不猜）。
5. **样式边界**：`.form-group > input` 的直接子元素是玻璃门禁的硬约束（`redesign.css:8203`），
   所以日期按钮行只能用行内 flex；本次两片都不改 CSS。若视觉上必须新增类
   （如 `.sql-var-row`），需要把 `src/styles/redesign.css` 写进 A 片文件边界，
   或交给 E 片统一补玻璃。
6. **测试文件归属**：功能 C 的纯函数用例放在 B 片新文件 `notesCopy.test.tsx`
   （B 片不允许改 A 片的 `sqlSnippets.test.tsx`）；若队长希望按功能分文件，
   需要新增 `src/utils/__tests__/dbEnvValues.test.ts` 并写进契约。

## 8. 队长裁定（2026-11-21，逐条对应 §7.6）

1. **dbEnvValues 落点**：留在 `src/pages/SqlSnippets.tsx` 纯函数区（与 `startOfWeek/filterSql/countSql` 同层，页面测试从页面导入 —— 这是本页既有惯例，§2 的「纯逻辑放 utils」按此收敛，不为 5 行函数再开模块）。**测试放 src/utils/__tests__/sqlSnippets.test.tsx**，已写进 §4 的 B 片边界；`notesCopy.test.tsx` 只放笔记页渲染用例。
2. **裸 token 判据**：采用「`extractVars(hint)` 里出现过就跳过」。已改 §3A。理由：幂等是硬要求，裸 `{{t}}` 再追加一次会产出重复条目。
3. **弹窗标题**：批准。SQL 页 `填充变量并复制 SQL`、组件默认 `填充变量并复制`、笔记页用默认。
4. **日期按钮文案**：批准 `填今天` / `填现在`；`today+0d` 可识别，`now±Nd` 与大小写变体不识别。已改 §3B。
5. **样式边界**：**本批不改 `src/styles/redesign.css`**。日期按钮行只用行内 flex + 现有类（`btn-ghost btn-sm`），**input 必须保持 `.form-group` 的直接子元素** —— `redesign.css:8203` 的玻璃规则是直接子元素选择器，包一层 div 就会掉玻璃底、E 的弹窗扫描必红。t3 的验收里要附该 input 的 computed `backgroundColor` alpha < 1 作为证据。
6. **测试文件归属**：见第 1 条。若后续 `dbEnvValues` 涨到有第二处复用，再拆 `src/utils/`，不在本批做。

## 9. 交付记录（2026-11-21，第二批收口）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | 92 files / **1236 tests 全绿**（第一批基线 1202，本批 +34） |
| `npx tsc --noEmit` | EXIT 0，无输出 |
| `npm run check` | 12 道门全过（privacy / tsc / 主进程 52 文件 / vitest / IPC 契约 206 handler + 自测 / CSS 重复 / z-index 42 条 / 层叠 / 级联 / 债预算三项持平），尾部「全部门禁通过」 |
| `node scripts/ui-glass-opaque-scan.js` ×2 | 12 个「主题 × 页面/弹窗」组合、**0 违规**；`pre.sql-var-preview` 锚点 浅 0.42 / 深 0.54 ← `var(--glass-input-soft)` |
| `npm run pack` + `USE_PACKED=1` 启动与门禁 | 启动 3 通过 0 失败；打包版玻璃门禁 12 组合 0 违规 |
| `team_task_audit` | 🔴 0 · 🟡 0 |

变异验证（门禁的拦截力证据）：4 条玻璃规则变异（`.modal` / `.sql-var-preview` / `.modal-footer` / 覆盖丢失）+ 1 条竞态负向控制，全部 EXIT 1 且红灯落在期望位置；恢复后 hash 复核一致。

**本批发现的两个「门禁假绿」根因**（已写进 `docs/optimization-backlog.md` P1-2）：
1. `scripts/lib/app.js` 的 `navTo()` 就绪判据两半失效（`.page-loading` 不存在 + `PageSkeleton` 自己渲染 `.pg`），`clickText` 返回值被丢弃；
2. 窗口被遮挡/合成器节流时 CSS 动画停在 `opacity:0`，扫描器对 `opacity===0` 的容器整棵子树跳过 → 假绿且「弹窗打不开」。

本批只在 `ui-glass-opaque-scan.js` 内修好这两类（`READY_PRED` + `settleAnimations()`）；公共库与其余 `ui-*.js` 未动，列下一批。
