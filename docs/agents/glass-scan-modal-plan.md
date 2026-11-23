# 玻璃门禁 E 分片：首屏竞态根因 + 弹窗扫描方案

> 2026-11-21。任务 t2（qa）。**本文只落方案，不改任何代码**；`scripts/ui-glass-opaque-scan.js` 的实现另派。
> 判据口径不变（`scripts/ui-glass-opaque-scan.js` 文件头）：**可见 && `backgroundColor` alpha ≥ 0.999 && 面积 > 600 px²**。
> 走查与实测都在**临时副本 / 临时探针**上做，仓库 `scripts/`、`src/` 一个字没动（见 §7）。

## 0. 结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 首屏 `页面自证不足 rows=0` 能复现吗 | 能。`node scripts/ui-glass-opaque-scan.js` **连跑 2 次都 exit=1**，红点都在 `[light] 网址管理 · 列表视图`（§1） |
| 2 | 基线要不要 `git stash` | **不要**。HEAD（`7cf872e`）+ `git worktree` 独立构建同样红，且抓到失败侧关键证据 `prep 点击返回 false`；全程没碰 frontend 未提交的工作区（§2） |
| 3 | 根因 | `navTo()` 的完成条件被 **PageSkeleton 的 `.pg`** 满足（`!document.querySelector('.page-loading')` 这半边在源码里恒真，因为 `.page-loading` 根本不存在）→ 它在骨架屏阶段就返回；紧接着 `prep` 的 `clickText('列表')` 落空、**返回值被忽略** → 停在默认卡片视图 → `rows=0`（§3） |
| 4 | 修法 | navTo 之后加「页面就绪」条件等待（10s + 明确失败原因）；`prep` 返回 false 直接失败；`prep` 生效再等 5s；扫描前加「两次采样签名一致」的稳定性判据；删掉 `sleep(600/700)`。临时副本上连跑 3 次全绿（§4） |
| 5 | 弹窗扫描 | 进「SQL 片段」→ 点**带变量那行**的复制入口 → 等 `.modal` 可见 + 变量输入框 + `pre` 有文本 → 重新钉主题 → 稳定采样 → 扫 `.modal` 子树；白名单**不需要新增**（只有 `.btn-primary` 命中既有条目）；深浅各一次（§5） |
| 6 | 变异验证 | 4 条变异（3 条玻璃规则 + 1 条组件改名）+ 1 条竞态负向控制，每条写明「期望红在哪一行」（§6） |

## 1. 复现：连跑 2 次（命令 + 原始输出）

命令（仓库根目录，dist 已是最新一次 `npm run build:renderer` 的产物）：

```powershell
node scripts/ui-glass-opaque-scan.js   # 第 1 次
node scripts/ui-glass-opaque-scan.js   # 第 2 次
```

两次输出逐字相同（只有首屏那一页红），下面贴第一次的原文（第 2 次同）：

```text
（造数）entries 0 → 25 条（+25） / notes 0 → 27 条（普通笔记 +25、SQL +2） —— 分页条必须渲染出来，否则下面的自证会红

════════ 主题 light（html[data-bg='image']）

──── 网址管理 · 列表视图：不透明块 1 个（白名单 1 / 违规 0）
  · 页面自证：主题 light / 背景 image / 卡片 10 / 列表行 0 / 环境徽标 13 / 主按钮 1 / KBD 0 / KPI 卡 0 / 标签栏项 1 / SQL 行 0 / 分页条 1（1 / 3 · 第 1–10 条，共 25 条）
  ✗ 页面自证不足：rows=0 < 1（pagers=0 说明没超过一页，分页条没渲染 = 这一页没真的扫到）
  ✓ 1053224 1384×761    rgb(255, 255, 255)         app-bg-dim
...
扫描 10 个「主题 × 页面」组合（面积 > 600px² 且背景 alpha >= 0.999 计为不透明块）

✗ 违规 1 条：
    [light] 网址管理 · 列表视图  0×0(0px²)  -  (页面自证不足 rows=0 < 1)
```

退出码：第 1 次 `1`、第 2 次 `1`。判定为假红的两个特征都在：

- `卡片 10 / 列表行 0` —— 这一页**停在卡片视图**（默认视图），`prep` 想切的「列表」没生效；
- `分页条 1（1 / 3 · 第 1–10 条，共 25 条）` —— 数据是有的，25 条造数没问题，所以不是「页面没内容」。

原始日志留在本机 `%TEMP%\glass-scan-run1.log` / `run2.log`（一次性证据，不进仓库）。
注意：这个竞态是**抖动**的 —— 后面几次同条件运行会偶然变绿（余量只有 10~40ms，见 §3.2）。
因此「跑绿了」本身不能当成修好了，必须有 §4 的条件等待。

## 2. 基线判定：不需要 `git stash`

`git stash` 会把 frontend 正在写的 4 个文件（`SqlSnippets.tsx` / `redesign.css` / 测试 / 文档）一起收走，
这个批次的 A/B/C/D 正在同一工作区并行，**stash 等于抢别人的工作区**，不能用。
基线改用独立 worktree 取，主工作区一个字节都不动：

```powershell
# 1) 用 HEAD（7cf872e）开一份干净检出到临时目录（detached，不新建分支）
git worktree add --detach "$env:TEMP\pm-baseline" HEAD

# 2) 借主仓库的 node_modules（junction，不复制 1GB）+ 构建基线 dist
cmd /c mklink /J "$env:TEMP\pm-baseline\node_modules" "<仓库>\node_modules"
node "$env:TEMP\pm-baseline\node_modules\vite\bin\vite.js" build      # ✓ built in 6.74s

# 3) 用同一份门禁脚本，只把启动参数换成「cwd=基线目录、exe=主仓库的 electron」
#    （脚本的 launch() 支持 cwd/exe/args，见 scripts/lib/app.js:101-131）
```

结果：**基线同样红**，而且插桩版抓到了失败侧的直接证据 —— 点击时 DOM 里根本没有「列表」按钮：

```text
════════ 主题 light（html[data-bg='image']）
[PROBE prep] 网址管理 · 列表视图 点击返回 false
[PROBE 网址管理 · 列表视图 · 扫描瞬间] switchOn="卡片" cards=10 rows=0 pagers=1

──── 网址管理 · 列表视图：不透明块 1 个（白名单 1 / 违规 0）
  · 页面自证：主题 light / 背景 image / 卡片 10 / 列表行 0 / 环境徽标 13 / 主按钮 1 / KBD 0 / KPI 卡 0 / 标签栏项 1 / SQL 行 0 / 分页条 1（1 / 3 · 第 1–10 条，共 25 条）
  ✗ 页面自证不足：rows=0 < 1（pagers=0 说明没超过一页，分页条没渲染 = 这一页没真的扫到）
...
✗ 违规 1 条：
    [light] 网址管理 · 列表视图  0×0(0px²)  -  (页面自证不足 rows=0 < 1)
```

- `点击返回 false` = `clickText` 在 DOM 里**没有找到**任何含「列表」的 button（找到了才会返回 true），
  所以不是「点了但 React 没响应」，而是**点在按钮出现之前**。
- 基线（干净 HEAD）同样红 ⇒ 与本批未提交改动无关，`git stash` 不必要也无意义。
- worktree 用完即删（`rmdir` junction → 删目录 → `git worktree prune`），`git worktree list` 只剩主工作区。

## 3. 根因（四段证据）

### 3.1 静态：`navTo` 的完成条件两半都不可靠

`scripts/lib/app.js:266-278` 的 `navTo()`：

```js
await session.waitFor({ expr: `!document.querySelector('.page-loading') && !!document.querySelector('.pg')` },
  { timeout: opts.timeout || 15000, throwOnTimeout: false });
await cdp.sleep(300);
```

- 前半 `!document.querySelector('.page-loading')`：**恒真** —— 全仓库 `src/` 里不存在 `page-loading` 这个类（grep 0 命中）。
- 后半 `!!document.querySelector('.pg')`：`src/components/PageSkeleton.tsx:14` 的懒加载骨架屏就是
  `<div className="pg" aria-hidden="true">`，而 `src/App.tsx:584` 是 `<Suspense fallback={<PageSkeleton />}>`。
  ⇒ **骨架屏自己就满足「页面已就绪」**，`navTo` 在骨架阶段就返回了，再 `sleep(300)` 也补不回来。
- 另外 `throwOnTimeout: false`：等的条件不满足也不报错，静默继续。

### 3.2 时序：点击落在骨架屏窗口里（余量 10~40ms）

用一次性插桩副本（装 MutationObserver 记录骨架屏 → 真实页面的切换时刻）抓到的时间线：

```text
25ms :  START skel=0 toolbar=0 swBtn=0 cards=0 rows=0      ← 上一页已卸载，新页 chunk 还没到
65ms :  skel=1 toolbar=0 swBtn=0 cards=0 rows=0            ← 骨架屏出现
365ms:  skel=0 toolbar=1 swBtn=3 cards=10 rows=0 pagers=1  ← 真实页面挂载（默认卡片视图）
891ms:  skel=0 toolbar=1 swBtn=3 cards=0 rows=10 pagers=1  ← prep 点击生效（切到列表）
```

`navTo` 在 ~326ms 返回（含它自己的 300ms settle），`prep` 的 `clickText` 紧接着执行（一次 CDP 往返 ~20ms）
⇒ 点击时刻 ~340ms，与真实页面挂载的 365ms **只差 10~40ms**。这次侥幸踩在线上（点到了），
换一次运行就落到骨架屏里（§2 抓到 `点击返回 false`）。

### 3.3 失败侧：`prep` 的返回值被丢掉

`scripts/ui-glass-opaque-scan.js:389-391`：

```js
const ok = await navTo(session, page.nav, { timeout: 15000 });
if (!ok) throw new Error(`导航不到「${page.nav}」`);
if (page.prep) { await page.prep(session); await sleep(700); } else { await sleep(600); }
```

`page.prep` 就是 `(s) => clickText(s, '列表')`，`clickText`（`scripts/lib/app.js:246-257`）找不到按钮时返回 `false`。
脚本不看返回值，只 `sleep(700)` —— 于是「没点到」与「点到了」在日志里长得一模一样，
直到 900ms 后扫描读到 `rows=0` 才红，而那一刻数据早就渲染好了（`卡片 10`），所以看起来像「页面自证不足」。

### 3.4 为什么只红首屏

第一次进「网址管理」时，25 条造数是**刚写进库、页面刚 reload**的状态，条目 IPC + React 首次渲染都要走一遍，
骨架屏 300ms 才换成真实页面；等到第二套主题（dark）或第二个页面再进时，数据已在 store 里，
`prep` 的按钮立刻就有 —— 于是全部变绿，把首屏的竞态掩盖成「偶发一次」。

### 3.5 顺带发现的第二个假绿：扫描时页面还没布局稳定

同一份条件等待到位后，第一次验证跑的「网址管理 · 列表视图」只数到 **1 个**不透明块，
另一次同条件跑到 **12 个**（10 个表格环境徽标 + 主按钮 + 压暗遮罩）：自证行两次都写 `列表行 10 / 环境徽标 10`，
说明元素在 DOM 里，但 `getBoundingClientRect()` 还没量出尺寸（面积 0 → 判据不成立 → 漏判）。
**这就是「扫在重排中间」的假绿**。修法很简单也很机械：扫描前要求「同一份采样签名连续 2 次相同」（§4.4），
加上之后两次运行都稳定数到 12 个，白名单 12/12、违规 0。

## 4. 竞态修法（实现清单）

改的文件只有一个：`scripts/ui-glass-opaque-scan.js`。**不动 `scripts/lib/app.js`**（被 20+ 个 `ui-*.js` 共用，
改 `navTo` 的语义要连带跑全部 UI 回归，是独立任务）。本脚本自己在 `navTo` 之后把「真就绪」等回来即可。

### 4.1 通用条件等待（轮询，条件驱动，不是 sleep）

```js
/**
 * 轮询条件表达式直到 ok；超时抛错，消息里写清「等什么、等了多久、最后一次实测」。
 * 注意：这是条件等待，不是固定 sleep —— 页面快就立刻过，页面慢就一直等到超时。
 */
async function waitUntil(ev, expr, opts) {
  const timeout = opts.timeout || 10000;
  const label = opts.label || expr;
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await ev(expr);                       // 返回 { ok, state }
    if (last && last.ok) return { ms: Date.now() - t0, state: last.state };
    await sleep(100);                            // 轮询间隔，不是「等 100ms 再判定」
  }
  throw new Error(`等 ${timeout}ms「${label}」仍未就绪；最后一次实测 ${JSON.stringify(last)}`);
}
```

### 4.2 「页面就绪」判据：按页写死（这是关键，不能只看 `rows>=1`）

> ⚠️ 契约 §E 写的是「等待条件改成 `rows >= 1` **或** 分页条出现」。实测发现**只写 `rows>=1` 会永远等不到**：
> 网址管理默认视图是**卡片**（`store.viewMode` 默认 `card`），卡片视图下 `rows` 恒 0，
> 而「切列表」正是下一步 `prep` 要做的动作 —— 用结果去等前置条件就死锁了。
> 所以实际实现取**更强也视图无关**的一条：**骨架屏消失 + 工具栏 + 三个视图按钮 + 有内容（卡片或行）+ 分页条**。
> 这条比契约更严（契约的「或」是它的真子集），语义仍是「等真内容出现，别用固定 sleep 蒙」。

```js
const READY_PRED = {
  // 列表/卡片共用：骨架屏没了、工具栏在了、三个视图按钮齐了、有内容（卡片或行）、分页条渲染了
  '网址管理 · 列表视图': `(() => { const q=(x)=>document.querySelectorAll(x).length;
    const state={skel:!!document.querySelector('.page-skel'),toolbar:!!document.querySelector('.toolbar'),
      swBtn:q('.view-switch-btn'),cards:q('.entry-card'),rows:q('.entry-table tbody tr'),pagers:q('.pager')};
    const ok=!state.skel && state.toolbar && state.swBtn===3 && (state.cards>=1||state.rows>=1) && state.pagers>=1;
    return {ok,state}; })()`,
  '网址管理 · 卡片视图': `(() => { const q=(x)=>document.querySelectorAll(x).length;
    const state={skel:!!document.querySelector('.page-skel'),toolbar:!!document.querySelector('.toolbar'),
      swBtn:q('.view-switch-btn'),cards:q('.entry-card'),rows:q('.entry-table tbody tr'),pagers:q('.pager')};
    const ok=!state.skel && state.toolbar && state.swBtn===3 && (state.cards>=1||state.rows>=1) && state.pagers>=1;
    return {ok,state}; })()`,
  '工具箱': `(() => { const state={skel:!!document.querySelector('.page-skel'),tbHead:!!document.querySelector('.tb-main-head')};
    return {ok:!state.skel && state.tbHead,state}; })()`,
  '笔记与附件': `(() => { const q=(x)=>document.querySelectorAll(x).length;
    const state={skel:!!document.querySelector('.page-skel'),pagers:q('.pager'),chips:q('.chip')};
    return {ok:!state.skel && (state.pagers>=1 || state.chips>=1),state}; })()`,
  'SQL 片段': `(() => { const q=(x)=>document.querySelectorAll(x).length;
    const state={skel:!!document.querySelector('.page-skel'),stats:q('.home-stat'),
      tagItems:q('.tag-sidebar-item'),sqlRows:q('.sql-table tbody tr')};
    return {ok:!state.skel && state.stats===3 && state.sqlRows>=2,state}; })()`,
};
```

超时 **10s**，失败文案（必须能一眼看出「等的是什么」）：

```text
✗ 扫描失败：「网址管理 · 列表视图」10s 内页面没渲染出来（缺 rows/pagers）；
  最后一次实测 {"skel":true,"toolbar":false,"swBtn":0,"cards":0,"rows":0,"pagers":0}
  —— 骨架屏（.page-skel，内含 .pg）还没被真实页面替换，此时 prep 点击一定落空
```

### 4.3 `prep` 必须「点到了」且「真生效」

```js
if (page.prep) {
  const clicked = await page.prep(session);
  if (clicked !== true) {
    throw new Error(`「${page.label}」的 prep 点击落空：DOM 里没有可点的按钮（页面还在骨架屏时点会这样）`);
  }
  const applied = await waitUntil(ev, APPLIED_PRED[page.label], { timeout: 5000, label: `${page.label} prep 生效` });
}
```

```js
const APPLIED_PRED = {
  // 生效 = .is-on 的视图按钮变成目标视图，且对应内容真的渲染出来
  '网址管理 · 列表视图': `(() => { const on=document.querySelector('.view-switch-btn.is-on');
    const state={on:on?on.textContent.trim():'',rows:document.querySelectorAll('.entry-table tbody tr').length};
    return {ok:state.on==='列表' && state.rows>=1,state}; })()`,
  '网址管理 · 卡片视图': `(() => { const on=document.querySelector('.view-switch-btn.is-on');
    const state={on:on?on.textContent.trim():'',cards:document.querySelectorAll('.entry-card').length};
    return {ok:state.on==='卡片' && state.cards>=1,state}; })()`,
};
```

删掉 `sleep(700)` / `sleep(600)`（这两条就是「用固定 sleep 掩盖竞态」）。

### 4.4 扫描前要求「稳定」：两次采样签名一致

```js
// 签名 = 不透明块列表（class/尺寸/颜色）+ 自证计数；变了说明还在重排/换视图/加载布局
let prevSig = '', scanRes = null, stableMs = 0, samples = 0;
const t0 = Date.now();
while (Date.now() - t0 < 4000) {
  scanRes = await ev(SCAN_EXPR);
  samples += 1;
  const sig = JSON.stringify(scanRes.rows.map((r) => [r.cls, r.w, r.h, r.bg]))
    + '|' + JSON.stringify([scanRes.ctx.cards, scanRes.ctx.rows, scanRes.ctx.pagers]);
  if (sig === prevSig) { stableMs = Date.now() - t0; break; }
  prevSig = sig;
  await sleep(150);
}
if (!stableMs) throw new Error(`${page.label} 4s 内页面没稳定（采样 ${samples} 次，签名一直在变），扫描结果不可信`);
```

失败文案把「采样次数」也印出来，避免「不稳定 → 恰好 0 违规」又被当成绿。

### 4.5 `page.min` 自证保留

现有的 `min`（卡片/行/分页条/KPI 卡/标签栏项/SQL 行）**不要删**：它是最后一道网，
只不过现在它前面已经有「就绪 + 生效 + 稳定」三道条件，不会再被首屏竞态误伤。
自证不足仍然按违规计（原来的红文案保留）。

### 4.6 验证结果（临时副本，连跑 3 次）

| 运行 | 首屏就绪等待 | prep 生效 | 首屏不透明块 | 结果 |
|---|---|---|---|---|
| 1 | 111ms | 1ms | 1 个（布局未稳定） | exit 0 |
| 2 | 654ms | 1ms | 12 个（白名单 12） | exit 0 |
| 3（加 §4.4 稳定判据） | 3ms | 0ms | 12 个（白名单 12） | exit 0 |

- 就绪等待 111ms / 654ms 这两个数就是**原来被跳过的窗口**（固定 `sleep(600/700)` 只能碰运气）。
- 第 1 次那个「1 个」正是 §3.5 的假绿，加上稳定判据后不再出现。

## 5. 「打开复制弹窗后扫 `.modal` 子树」设计

### 5.1 步骤（每套主题各一遍）

1. `navTo('SQL 片段')` → 等 `READY_PRED['SQL 片段']`（`只 `.home-stat===3` 且 `sqlRows>=2`）。
2. 点**带变量的那一行**的复制入口（造数里 `opaque-sql-1` 的正文含 `{{today}}`）：

   ```js
   const row = [...document.querySelectorAll('.sql-table tbody tr')]
     .find((r) => (r.textContent || '').includes('查某天未支付的订单'));
   const btn = row && (row.querySelector('button[title*="复制"]')
     || [...row.querySelectorAll('button')].find((b) => (b.title || '').includes('复制')));
   ```

   拿不到行 / 拿不到按钮 → 直接失败（**不许静默跳过**，否则弹窗这一步等于没装）。
3. 等弹窗「真的打开了」（条件见 5.2）。
4. **重新钉一次主题并复验**（历史坑：切页/重渲染会把 `data-theme` 写回 `settings.theme`，
   脚本里 392-401 行已有同类处理；弹窗是新挂载的组件，同样要钉一次）。
5. 稳定采样（同 §4.4，签名改用 `.modal` 子树的块列表 + `modalInputs` + `preTextLen`）。
6. 扫 `.modal` 子树（判据同全局：可见 && alpha ≥ 0.999 && 面积 > 600）→ 打印 ✓/✗ 与白名单理由。
7. 量锚点（5.4）→ 打印实测值与 token 溯源。
8. 关弹窗（`.modal .close-btn` 或 Esc），再切下一套主题、重开一遍。

### 5.2 等待条件 / 超时 / 失败文案

| 等什么 | 判据（机械） | 超时 | 失败文案（必须带「等什么 + 实测」） |
|---|---|---|---|
| 弹窗已打开 | `.modal` 存在 && `rect.width>0` && `Number(opacity)===1`（等 `modalIn` 动画结束） | 10s | `「SQL 片段」10s 内没等到复制弹窗（modal=0，最后一次实测 …）；检查行内复制入口的 title 是否还含「复制」` |
| 内容已渲染 | `.modal .modal-body input` ≥ 1 && `pre.sql-var-preview` 存在 && `textContent.length > 0` | 10s（与上一条同一轮） | `弹窗打开了但没渲染出变量输入框（inputs=0 / pre=0）：样本片段里没有 {{变量}}，或 CopyVarsModal 的类名改了` |
| 主题已钉住 | `document.documentElement.dataset.theme === theme` | 2 次尝试 | `无法把 data-theme 固定成 ${theme}（实读 ${probe}），本次弹窗扫描不可信` |
| 页面稳定 | 两次采样签名一致（§4.4） | 4s | `「SQL 片段/弹窗」4s 内采样 N 次签名一直在变，扫描结果不可信` |

### 5.3 判据与白名单

- 判据不变（可见 && alpha ≥ 0.999 && 面积 > 600）；**扫描根 = `document.querySelector('.modal')`**，不扫 `.modal-overlay`
  （遮罩是全窗口压暗层，本来就该半透明，扫进来只会制造噪声；判据要盯的是「弹窗里有没有实心板」）。
- 白名单：**不需要新增**。实测 `.modal` 子树里唯一的不透明块就是底栏「替换并复制」按钮（`.btn.btn-primary`，93×34 = 3162 px²），
  已命中既有白名单条目（`scripts/ui-glass-opaque-scan.js:64-70`，`btn-primary / btn-add / btn-empty-add`），
  脚本会打印「主行动按钮本应实心」的理由后放行。
- B 片新增的「填今天 / 填现在」按钮是 `.btn.btn-ghost.btn-sm`（透明底），C 片的已有值标签是 `.chip`（`--glass-input`），
  都不会变成违规；**如果将来它们变成实底，门禁就该红** —— 这是设计意图，不要去扩白名单。

### 5.4 锚点（确定性验收，不吃面积判据的浮动）

| 目标 | 期望来源 | 失败文案 |
|---|---|---|
| `.modal` 本体 | `var(--glass-modal)` 的 computed 值，**逐字符相等** | `.modal 的背景不是 var(--glass-modal)（实测 {bg}，token={tokenBg}）—— 玻璃规则没命中或被注释掉了` |
| `pre.sql-var-preview`（合同点名要求） | `var(--glass-input-soft)`，逐字符相等 | `预览块 pre.sql-var-preview 不是 var(--glass-input-soft)（实测 …）` |
| `.modal-footer` | `rgba(0,0,0,0)`（alpha = 0，1.31.x 起改成透底 + border-top 分隔） | `.modal-footer 仍是实底（实测 {bg}），底栏会挡背景图` |
| 变量输入框（可选，第 2 条锚点） | `var(--glass-input)` | `变量输入框回退到不透明底（实测 …），redesign.css:8203 那条 .modal .form-group > input 规则没命中` |

token 溯源的写法沿用现有 `targetExpr(sel, token)`：在**目标元素的同一个父节点**下插 0×0 探针解析 token，
再与目标 computed 值逐字符比较 —— 这样「深浅两套 token」由同一个机制覆盖，不需要在脚本里写死颜色。

### 5.5 实测基线（本机 1384×761，当前工作区构建；实现后用这张表对号）

| 目标 | light | dark | token 溯源 |
|---|---|---|---|
| `.modal` | 520×359 `color(srgb 1 1 1 / 0.9)` | 520×359 `color(srgb 0.0901961 0.105882 0.117647 / 0.9)` | `= var(--glass-modal)` ✓ |
| `pre.sql-var-preview` | 478×47 `color(srgb 1 1 1 / 0.42)` | 478×47 `color(srgb 0.0588235 0.0705882 0.0745098 / 0.54)` | `= var(--glass-input-soft)` ✓ |
| `.modal-footer` | 518×67 `rgba(0, 0, 0, 0)` | 518×67 `rgba(0, 0, 0, 0)` | alpha 0 ✓ |
| `.modal` 子树不透明块 | 1 个：`.btn.btn-primary` 93×34 | 同 | 白名单放行 |

- 弹窗打开耗时实测 **247~285ms**（`modalIn` 0.15s + React 挂载）；固定 `sleep(600)` 也能过，但仍然是运气，
  所以按 5.2 的条件等。
- 变量输入框实测 1 个（样本 `{{today}}`）；`pre` 文本长度 54。

### 5.6 输出样例（实现后应长这样）

```text
──── 复制弹窗（SQL 片段 · 深层变量）：不透明块 1 个（白名单 1 / 违规 0）
  · 弹窗自证：主题 light / 背景 image / 弹窗 520×359 / 变量输入框 1 / 预览 54 字 / opacity 1
  ✓ 3162    93×34       color(srgb 0.190118 0.222353 0.241804) btn btn-primary
      ↑ 白名单「主按钮 (btn-primary / btn-add / btn-empty-add)」：主行动按钮本应实心…
  · 锚点：.modal ← var(--glass-modal) ✓ / pre.sql-var-preview ← var(--glass-input-soft) ✓ / .modal-footer alpha=0 ✓
```

## 6. 变异验证（必须变红，否则等于没装门禁）

### 6.1 竞态修复的负向控制（证明超时分支真的会红）

1. 临时把 `READY_PRED['网址管理 · 列表视图']` 的 `state.swBtn===3` 改成 `state.swBtn===999`；
2. 跑 `node scripts/ui-glass-opaque-scan.js`；
3. **期望**：10s 后 exit=1，并且红的是「就绪」文案（`10s 内页面没渲染出来 … 最后一次实测 {"skel":false,…,"swBtn":3,…}`），
   不是 `rows=0` 那种自证不足；
4. 改回 → 复跑必须 exit=0（两跑都绿才算过）。

### 6.2 玻璃规则变异（逐条注释、跑、恢复）

| # | 注掉哪条（`src/styles/redesign.css`） | 期望红在哪 |
|---|---|---|
| a | `html[data-bg='image'] .modal { background: var(--glass-modal) }`（7871-7874） | `.modal` 锚点红：`不是 var(--glass-modal)`（背景落回基础 `.modal` 的实底，alpha=1，扫描也会把 520×359 记成违规） |
| b | `html[data-bg='image'] .sql-var-preview { background-color: var(--glass-input-soft) }`（8359-8361） | `pre` 锚点红 **且** 扫描违规：`478×47 (22466px²) rgb(212,214,221)`（1.31.x 未补玻璃前的实测色，见文件注释 8344-8346） |
| c | `html[data-bg='image'] .modal-footer { background-color: transparent }`（8362-8364） | `.modal-footer` 锚点红 + 扫描违规：`518×67 (34706px²)` 实底 |
| d | 组件抽取时把 `pre.sql-var-preview` 改个名字（只改 `CopyVarsModal.tsx` 的 className） | 锚点「找不到类」红：说明门禁真的盯着这一类；改名就必须同步补玻璃规则与锚点，不允许悄悄失去覆盖 |

每条变异都要记录：**命令 / 退出码 / 红在哪一行 / 恢复后复跑绿**。
变异前先确认基线是绿的（否则红说明不了任何事）。

### 6.3 记录方式

变异验证的结果写进实现任务的 `commandsRun` + `acceptanceResults`，格式：
`注释 a → exit 1，红在「.modal 锚点」；恢复 → exit 0（连跑 2 次）`。

## 7. 边界（本次刻意不做）

- **不改** `scripts/lib/app.js`（`navTo` 的 `.pg` 语义问题记成后续项：真要改必须同时排掉 `.page-skel`，
  并且跑全部 `ui-*.js` 回归）。
- **不改** `src/**`：玻璃规则缺失就报红，由 frontend 补；qa 不在门禁任务里顺手改样式。
- 不新增/放宽白名单来「消灭违规」。
- 不以「重跑一次绿了」作为竞态修好的证据（余量只有 10~40ms，见 §3.2）。

## 8. 残余风险

1. `.page-skel .pg` 让 `navTo` 提前返回这件事对**其它** `ui-*.js` 同样成立；本方案只让玻璃门禁自己兜住。
   其它脚本如果也断言首屏内容，应复用同一套「就绪判据」写法（后续项，不在本批）。
2. 稳定判据的签名只含「块列表 + 自证计数」，不含元素 `opacity`；`modalIn` 动画期间元素 opacity < 1，
   所以 5.2 的打开判据里要求 `opacity===1` 才继续 —— 两处一起才拦得住「动画中扫描」。
3. 弹窗内容随后续功能（B 日期按钮 / C 已有值标签）还会增加；白名单只留 `btn-primary`。
   新增块若实底，门禁会红 —— 这是预期行为，**不要**通过扩白名单消红。
4. 面积阈值 600px² 对小控件的余量本来就窄（键帽/徽标贴着阈值）；已有白名单是按「确实本应实心」立的，
   这次没有新增条目，也不建议因为弹窗扫描再放宽阈值。
