# 前端质量审计（impeccable）

> 记录 2026-11-11 用 impeccable 对 v1.21.10 做的代码级 + 运行时审计，以及后续复跑方式。
> 结论会过期，方法不会：下次改完 UI 按「复跑方式」重跑一遍即可。

## 为什么用运行时审计而不是只扫源码

这个项目是 Electron 应用，样式分三份（`global.css → pages.css → redesign.css`）叠加生效，
同一元素最终颜色由多层 `var()` 与 `color-mix()` 解析得出。只读 CSS 源码算不出真实对比度
（例如 `--accent` 在深色主题是 `#4f9d99`、浅色主题是 `#2f7a77`，同一个选择器两套结果）。
所以审计必须附加到真实窗口上量。

## 复跑方式

```powershell
# 1. 启动打包版并灌入代表性数据（窗口保持打开）
node scripts/_seed-for-audit.js      # 临时脚本，用完删

# 2. 机械检测（反模式 + 对比度）
& "$env:USERPROFILE\.dsh\skills\impeccable\scripts\impeccable.cmd" detect --cdp 9222 --json

# 3. 逐页量对比度 / 溢出 / 触控目标（CDP 脚本，见下）
```

`detect --cdp <port>` 直接扫运行中的 Electron 窗口，不导航、不改窗口大小。
注意：窗口被最小化或在后台时，像素通道读不到内容，会提示
`was hidden (minimized, or a background tab or window)` —— 此时先 `Page.bringToFront`。

## 关键坑

1. **切主题后要等过渡结束再量**。`data-theme` 改完立即读 `getComputedStyle` 拿到的是
   过渡中间值（实测导航项颜色会停在旧主题的 `rgb(79,157,153)`，等 2.5 秒才变成
   `rgb(47,122,119)`）。脚本里统一 `sleep(2500)` 以上。
2. **`color(srgb ...)` 格式**。`color-mix()` 的输出是 `color(srgb 0.14 0.37 0.36)`，
   不是 `rgb()`。对比度脚本必须同时解析两种格式，否则会把正常颜色算成 1.05:1 的假阳性。
3. **浅色主题的修正方向与深色相反**。深色主题下 `--danger` 偏暗，要往白里提；
   浅色主题下它已经很深，往白里提反而掉到 3.85:1，必须往黑里压。所以
   `.sec-flag-weak` / `.pill-bad` 的修正要写两套（`[data-theme='light']` 覆盖）。

## 2026-11-11 审计结果

| 维度 | 分数 | 主要问题 |
|---|---|---|
| 可访问性 | 3/4 | 修前 7 处对比度不足、17 个触控目标 < 24px；缺 skip-link |
| 性能 | 3/4 | 主包 358 KB；附件缩略图无懒加载（已补） |
| 主题化 | 3/4 | 115 个令牌，但仍有 25 处散落硬编码色（环境徽标四组） |
| 响应式 | 4/4 | 13 个页面在 900×600 下 0 横向溢出 |
| 状态覆盖 | 4/4 | 空/加载/错误态齐全 |

修后：深浅两套主题逐页实测对比度 0 处不足，触控目标 0 个偏小，
`detect --cdp` 返回 `[]`。

## 待办（按优先级）

- **P2** 主包 358 KB：先量真实启动耗时，再决定是否拆包。
- **P2** 环境徽标四组硬编码色（`#0f2d1f` 等）提成 `--env-*` 令牌，两套主题各定义一次。
- **P2** 加 skip-link：键盘用户从侧栏到主内容要过 13 个导航项。
- **P3** 部分 `<input>` 靠视觉相邻的 `<label>` 而非 `htmlFor`/`id` 关联。
- **P3** `prefers-reduced-motion` 是全局 `0.01ms` 一刀切，会同时干掉「保存成功」这类有用反馈；
  建议只关位移与缩放，保留 opacity/color 过渡。

---

## 2026-11-11 第二轮（上面待办全部处理完）

### 已做完

| 待办 | 做法 | 结果 |
|---|---|---|
| 主包 358 KB | `src/utils/search.ts` 改成惰性加载 `pinyin-pro`：`preloadPinyin()` 在首屏渲染后才调用，未就绪时搜索降级为原文匹配，字典到位后 `cache.clear()` + 广播 `pm:pinyin-ready` 让 `Dashboard` 重渲染 | 主包 **357.80 → 81.35 kB**（gzip 167.69 → 26.12 kB）；`pinyin-pro` 独立成 `esm-*.js` 287.46 kB，**不进 `index.html` 的 modulepreload**。首屏 JS 约 543 → 274 kB |
| 环境徽标硬编码色 | `tokens.css` 第 4 节：卡片形态 `--env-{production,testing,development,staging}-bg/fg`、表格形态 `--env-cell-*-bg/fg`、`--env-cell-emphasis-bg/fg/line`；删掉 `global.css:69-78` 那 8 条**死代码**（被后面同特异性规则覆盖） | 两套形态本来就不同色（卡片深底浅字 / 表格深底白字 / 预发布黄底黑字），所以留两套令牌而不是硬合并 |
| skip-link | `App.tsx` 在 `<Sidebar>` 前加 `<a className="skip-link" href="#main-content">`，`onClick` 里 `preventDefault()` + 手动 `focus()`（纯锚点在 SPA 里不移焦点）；`.main-content` 加 `id` + `tabIndex={-1}` | `redesign.css` 第 42 节，`:focus` 时才 `translateY(0)` |
| `<input>` 可访问名称 | 269 个控件的命名覆盖率 **51.3% → 83.3%**（labeled 224 / 仅 placeholder 43 / 裸 2） | 用 `aria-label` 而**不是** `htmlFor`+`id`：同一表单组件会在列表里渲染多次，静态 id 会重复，label 只认第一个反而更糟 |
| reduced-motion 一刀切 | 全局 `*` 保留（淡入/滑入关掉是对的），`redesign.css` 第 43 节只给**持续型**动画补丁：`.busy-progress-bar` 换成 `busy-breathe` 透明度呼吸，`.modal`/`.drawer` 保留 `fadeIn` | 原问题：`busy-slide` 被冻在起始帧 = 空轨道，看起来像已经结束 |

### 顺手一起做的

- **Modal 焦点陷阱 + 叠放栈**：新建 `src/components/overlayStack.ts`，`Modal` 接入 `role="dialog"` /
  `aria-modal` / `aria-labelledby` / Tab 循环 / 打开时聚焦第一个可聚焦元素 / 关闭归还焦点；
  33 处调用零 API 破坏（新 prop `ariaLabel` 可选）。**顺带修掉嵌套弹窗按一次 Esc 全关的 bug** ——
  现在只有栈顶那层响应 Esc。
- **z-index**：`tokens.css` 第 3 节写了一张现状阶梯注释表（10 → 10000 每层是谁），只抽 8 个
  真正跨组件争抢屏幕的令牌（`--z-menu-overlay/--z-menu/--z-lightbox/--z-skip-link/--z-portal-top/--z-alert-top` 等），
  其余 14 个组件内部叠放**故意不抽**（抽出来只是把数字换个写法）。修掉了唯一的真实冲突：
  `.app-error` 与 `.browser-dropdown.portal` 都是 9999，错误横幅会被下拉菜单盖住。
- **CSS 重复**：删掉 2 条「声明完全相同」的规则，完全相同数 **2 → 0**，并让 `check-css-dup.js`
  对这类重复**报错**（可机械清理的那一半清零后就该拦住）。295 条「声明冲突」保留 —— 三份样式表
  顺序覆盖就是本项目的换肤手段，详见 `docs/agents/testing.md`。
- **静态债预算**：`scripts/check-debt-budget.js`（`npm run check:debt`）把
  `!important`(64) / 令牌外色值(207) / `eslint-disable`(15) 三项钉成只许下降的预算。
- **页面烟雾测试**：`src/pages/__tests__/pages.smoke.test.tsx` 覆盖 17 个页面
  「空数据 + IPC 全 `{success:false}` 下挂载不炸」。

### 明确不做的（附理由，别再来一遍）

- **剩余 207 个色值字面量不逐个替换**。按类别看：白字压彩色底（`color:#fff`）、
  阴影（`rgba(0,0,0,.x)`，两套主题都该是黑的）、遮罩（同一个黑、透明度按层级不同）、
  终端配色（`#3fb950`/`#f85149`… 是刻意模拟 VS Code Dark）、`mask-image` 的 `#000`
  （那是 alpha 通道，不是颜色）。真正与主题相关的两批（环境徽标、环境色点）已经提完令牌。
  给每个一次性出现再编个令牌，只会把 207 变成 207 个令牌。
- **59→64 个 `!important` 不批量删**。它们是在 12k 行、三份顺序加载的样式表里压特异度的结果，
  删一条就可能差一层视觉，而现有回归（几何量 + 对比度）抓不到这种「看着差不多但不对」的偏差。
  改成预算：数量不能涨。
- **`eslint-disable` 保留，也不装 ESLint**。仓库现在没有 ESLint / Prettier，也没有 `lint` 脚本，
  这 15 条指令只是注释。装上 ESLint 会在 1400 KB 旧代码上立刻产生几百条告警，属于独立任务；
  现在只保证每条都写全规则名（预算脚本会拦没写规则名的）。

## 相关文件

- `PRODUCT.md`：impeccable init 产物（使用者、定位、约束、原则），审计与后续设计命令都读它。
- `src/styles/redesign.css` 第 37–43 节：两轮修正，均带「为什么」注释。
- `src/styles/tokens.css` 第 3–4 节：z-index 阶梯表 + `--env-*` 令牌。
- `docs/agents/security.md`：同一轮里主进程那侧的三件（导航守卫、`xlsx`、`window.open`）。
- `docs/agents/testing.md`：新增的 `check-css-dup` 报错规则与 `check:debt` 预算说明。
