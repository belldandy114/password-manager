# 方案：CSS 层叠与玻璃层治理 + 测试脚本公共库 + 体验三项

> 状态：staged（待用户批准）。创建日期 2026-11-20（本轮）。团队 `css-layers-and-polish`。
> 本文是队长（lead）的 S1 方案落盘，供评审与后续追溯；实现分片见团队任务 t1–t4。

## 目标

把「靠人记住的样式约定」变成「被 token 与脚本强制的规则」，同时抽掉测试脚本里
重复的启动/登录/截图样板，并把三处低成本体验问题收掉。

## 范围

**做（本轮）**

| 编号 | 项 | 落点 |
|---|---|---|
| P0-1 | z-index 令牌化 + 门禁 | `src/styles/tokens.css`、`scripts/check-z-index.js` |
| P0-2 | 玻璃层抽象为 token | `src/styles/tokens.css`、`src/styles/redesign.css` |
| P0-3 | 容器层叠上下文约束 + 门禁 | `src/styles/*`、`scripts/check-stacking.js` |
| P1 | CDP/Electron 测试公共库 + 玻璃层回归 | `scripts/lib/{cdp,app}.js`、`scripts/ui-bg-glass-test.js` |
| P2-1 | 工作台空态收敛 | `src/pages/Home.tsx` |
| P2-2 | 侧栏分组可折叠 + 记忆 | `src/components/Sidebar.tsx` |
| P2-3 | 合并页记住上次页签 | `src/pages/NotesAttachments.tsx` |

**不做（OUT_OF_SCOPE，用户明确不用动或本轮不碰）**

- ExcelJS 929KB：已是动态 import，性能不动。
- CSS 体积（325KB / gzip 53KB）：桌面应用可接受，不做拆分/压缩专项。
- 28 个 `ui-*.js` 全部迁移：本轮只迁 2 个做示范 + 1 个新增回归，其余出「后续可迁移清单」。
- 组件类名体系重构：P0-2 只改声明来源（token），不改类名、不改 DOM 结构。
- `release/`、`dist/`、`package-lock.json`：只读。

## 选型与取舍（AB 三维打分）

### A. z-index 治理方式

| 方案 | 团队能力 | 生态成熟 | 维护成本 | 结论 |
|---|---|---|---|---|
| A1 字面量 + 代码审查约定 | 5 | 5 | 2（靠人记，已失效） | 否 |
| A2 全部 token + 静态门禁 | 5 | 4（自研 60 行脚本） | 5（门禁红就拦） | **选 A2** |

理由：本轮三个 bug 全是「约定没被机械执行」，纯约定已被证伪。门禁脚本用 Node 正则扫
`src/styles/**`，无新依赖，成本可控。**禁止**为了「分层漂亮」引入 PostCSS 插件链或 CSS-in-JS——
那是把 12k 行历史样式重写一遍，风险远大于收益。

### B. 玻璃层抽象位置

| 方案 | 团队能力 | 生态成熟 | 维护成本 | 结论 |
|---|---|---|---|---|
| B1 每个组件自己写 rgba + backdrop-filter | 5 | 5 | 1（20+ 处已漏补） | 否 |
| B2 `tokens.css` 定义 `--glass-*`，组件引用 | 5 | 5 | 5 | **选 B2** |
| B3 引入 `color-mix()` 动态算透明 | 3 | 3（Chromium 版本绑死） | 4 | 否 |

理由：B3 会绑死渲染层 Chromium 版本，且 Electron 主进程里 `--enable-features` 不方便统一；
B2 与既有 token 体系同构，切换背景图只改 token。

### C. 测试脚本公共库的边界

不做「大而全测试框架」，只抽**三件事**：`cdp.js`（attach/求值/waitFor/截图/关闭）、
`app.js`（启动+引导+登录+预置数据）。其余（断言库、报告格式）沿用现有脚本自己的写法，
避免一次性把 28 个脚本的断言风格统一——那是第二轮的事。

## 模块与改动点

```
src/styles/tokens.css      + 层级表（≥10 个 --z-*）、+ --glass-card/side/overlay/input、
                           + 「容器不得建层叠上下文」规则注释
src/styles/redesign.css    z-index 字面量 → var(--z-*)；data-bg 覆盖段透明度 → var(--glass-*)
src/styles/{pages,global}.css  同上（字面量替换）
scripts/check-z-index.js   NEW：禁止 `z-index:` 后直接跟数字，命中非零退出，带 --self-test
scripts/check-stacking.js  NEW：容器类选择器同时出现 backdrop-filter/filter/transform/contain
                           与 z-index → 报错；带白名单（必须写理由）
scripts/ci-gate.js         两个新门挂进去（放在 check-css-dup 之后）
scripts/lib/cdp.js         NEW：attach/ev/waitFor/shot/close
scripts/lib/app.js         NEW：启动（dev + USE_PACKED）/引导/登录/预置数据
scripts/ui-bg-test.js      迁移到公共库（示范 1）
scripts/ui-palette-cache-test.js  迁移（示范 2）
scripts/ui-bg-glass-test.js NEW：四类玻璃层计算样式断言
scripts/regress-all.js     新回归挂进打包版清单
src/pages/Home.tsx         零数据时三面板合并为一个紧凑空态，保留跳转入口
src/components/Sidebar.tsx collapsedGroups 持久化到 localStorage（读失败兜底）
src/pages/NotesAttachments.tsx  上次页签记忆；显式 attachments 入口不被覆盖
```

## 数据与接口契约

本轮**不改任何 IPC 契约、不改 vault 数据结构、不改路由语义**。

新增的持久化只有 `localStorage`（侧栏折叠、合并页页签），键名沿用项目现有风格，
读取一律 `try/catch` 兜底（隐私模式写不进去时静默降级为「默认展开 / 默认笔记页」）。

## 风险（最容易翻车的三件事）

1. **玻璃层 token 改完有地方变「实心」或「太透」**：data-bg 覆盖段 45 处，替换时容易漏某个
   组合态（深色/浅色 × 图片背景 × 浮层）。缓解：t2 的 `ui-bg-glass-test.js` 用计算样式断言
   四类层的实际取值，不靠肉眼看；t4 做反证（故意改错期望值必须红）。
2. **层叠门禁误伤合法写法**（组件内部 `z-index:1` 的局部叠放本是合理的）：缓解：门禁只拦
   「容器类选择器 + 建上下文属性 + z-index」组合，组件内部局部层通过白名单放行，白名单
   必须在注释里写理由；脚本自带 `--self-test`，避免「永远绿」的假门。
3. **侧栏折叠持久化与既有「记住上次页面」互相干扰**：缓解：不动页面记忆逻辑，只加折叠状态；
   t3 验收要求给出两条进入路径的判断依据（主入口 vs 附件入口）。

## 里程碑

- **必须当期**：P0 三项（不做的后果是同类 bug 继续发生）、P1 抽库（不做的后果是每个新回归
  继续 150 行样板，且玻璃层检测无法固化成回归）。
- **可延后（后续建议，不进本期）**：`ui-*.js` 全量迁移、断言库统一、CSS 体积拆分、
  菜单项超过 15 个后的分组策略重构。

## ADR

**ADR-1：z-index 用 token + 静态门禁，不引入样式构建插件**
决策：所有 `z-index` 值来自 `tokens.css` 的 `--z-*`，`check-z-index.js` 在 `npm run check` 里拦字面量。
背景：40 处字面量、17 种取值，本轮「下拉被表头压住」即因随手写 `5` 与表头 `10` 撞车。
备选与放弃：PostCSS 插件（要新增构建依赖 + 三份样式表的加载顺序全靠人工约定，插件解决不了
「谁压谁」的语义）；纯代码审查（已被证伪）。
后果（代价）：新增一层要改 token 文件，改 token 要过一次门禁用例；换来的是层级语义可读、可审。

**ADR-2：玻璃层用静态 token，不用 `color-mix()` 动态算**
决策：`--glass-card/side/overlay/input` 直接写 rgba 值，两套主题 + 图片背景各给一组。
背景：data-bg=image 下散落 40%/52%/94% 三种透明度，新页面写完全靠补。
备选与放弃：`color-mix()`（Chromium 版本绑死，打包版渲染层版本由 Electron 固定，升级时
会整片区变色，排查成本高）。
后果（代价）：透明度改变要改 4 个 token 而非 1 个表达式；换来的是「一眼看出当前值」与
可被计算样式断言。

**ADR-3：测试脚本只抽 cdp/app 两层，不做通用测试框架**
决策：抽 `cdp.js` + `app.js`，保留各脚本自己的断言写法。
背景：28 个脚本各 150 行样板，重写脚本时被重复逻辑拖了两次。
备选与放弃：一次性上 Playwright 或自研 runner（28 个脚本 + CI 全量重写，超出本轮范围，
且这些脚本的价值在「真 Electron 窗口」而非浏览器 API，换框架收益递减）。
后果（代价）：断言风格短期仍不统一；下一轮再收口（已写入后续建议）。

## 待确认项（S0，用户可在批准前改）

1. **P2-1 空态收敛的形态**：默认方案「零数据时三面板合并为一行紧凑空态 + 三个跳转入口」，
   是否接受？替代方案是「保留三面板但压缩高度」。选错的代价：改回去要再动一次 Home.tsx。
2. **P1 迁移范围**：默认只迁 2 个示范脚本 + 1 个新增回归。若要一次全迁 28 个，
   工期翻倍且回归面变大——建议按默认走。
3. **门禁严格度**：默认「容器类 + 建上下文属性 + z-index」才拦；若要求「组件内 `z-index:1/2`
   也不许写」，会误伤表格展开块、输入框浮标这类合法局部层，需要更大白名单。
4. **合并页记忆范围**：默认只记「笔记 / 附件」两个页签的选择；是否也要记「上次打开的具体笔记」？
   默认不记（避免从别处跳进来时被记忆抢焦点）。
