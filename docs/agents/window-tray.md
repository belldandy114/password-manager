# window-tray（AGENTS.md 历史段落存档）

## 窗口 / 托盘 / 单实例（1.0.4）

- **单实例锁**：`app.requestSingleInstanceLock()`，第二个实例会直接退出并把已有窗口唤到前台。
  **不要移除**——两个实例各自持有解密后的 vault 副本，会互相覆盖导致数据丢失。
- **托盘**（`electron/main.js` 的 `createTray/hideToTray/showMainWindow`）：
  - 设置项 `minimizeToTray`（最小化时隐藏）、`closeToTray`（点 × 时隐藏）。
  - 任一开启时 `settings:save` 会立即创建托盘图标，全关则销毁（窗口可见时才销毁）。
  - 托盘菜单：显示主窗口 / 锁定（`webContents.send('lock-request')`）/ 退出（置 `isQuitting` 后 `app.quit()`）。
- ⚠️ **Windows 上 `minimize` 事件的 `preventDefault()` 拦不住系统最小化**，窗口会先进入
  iconic 状态再被 `hide()`。所以 `showMainWindow()` 必须 **先 `show()` 再 `restore()`**：
  窗口隐藏状态下 `isMinimized()` 会返回 false，先 restore 会被跳过，
  从托盘唤醒后会得到一个「任务栏最小化」的窗口。
- 全局快捷键拆成两个，别合并回一个键：
  - `Ctrl+Shift+P` → `toggleMainWindow()`，**只**显示/隐藏窗口。
  - `Ctrl+空格` → `openSearchPalette()`，**只**开搜索。
  - 两个键都可在「设置 › 快捷键」里自定义（存 `settings.hotkeySearch` / `hotkeyToggle`，值为 Electron 加速键）。
- 键位统一走 `applyHotkeys()`：
  - 注册失败**整体回滚**到上一次能用的组合（不能把用户原本可用的键弄丢），失败原因 `conflict` / `same` 回给渲染层显示。
  - 默认搜索键被占用时才走 `SEARCH_HOTKEY_FALLBACKS`；**用户自定义的键冲突就如实报错，不静默替换**。
  - 等于默认值的键不写盘（`delete s.hotkeyX`），`PM_HOTKEY_*` 环境变量覆盖也不写盘。
  - 改完要 `buildTrayMenu()`，托盘菜单里显示的是实际键位。
- `openSearchPalette()` 弹的是**独立快速搜索小窗**（`searchWin`，加载 `dist/index.html?window=palette`），
  不是主窗口里的面板：
  - 渲染层入口在 `main.tsx` 按 `?window=palette` 分流到 `PaletteApp`；数据由小窗自己走 IPC 现取
    （`entries:get-all` / `ws:get`，主进程持有解锁态），每次弹出 `palette:refresh` 重取。
  - **数据按版本号复用，不是每次全量重取**：主进程 `vaultEpoch` 在 `saveVault()`（以及 unlock/lock）
    里 +1，`palette:epoch` 只回 `{epoch, unlocked}`；小窗先问这个版本号，没变就直接复用上次拼好的
    命令列表（页面/工具/网址/片段/笔记/账号/请求/用例/环境，上限约 1,600 条）。
    ⚠️ 别再退回「250ms 内不重复取数」——那个时间窗会把刚保存的条目挡在外面，表现为「刚存完搜不到」。
    命中缓存/全量/未解锁三种路径会写 `document.documentElement.dataset.paletteLoad`，
    回归脚本靠它断言（`npm run test:palette-cache`，12 项）。
  - ⚠️ `palette:refresh` **只在小窗「从隐藏变显示」时发**（已显示时只 focus），所以测「重新弹出」
    必须先 `paletteHide()` 再 `paletteShow()`，否则测到的是同一个开着的小窗，缓存与刷新都不会发生。
  - **主题必须走 `settings:get`**（`applyPrefs()`），不要用 zustand `useStore(s => s.settings.theme)`：
    新窗口的 persist 是异步 rehydrate，拿到的是默认深色，会和主窗口设置不一致。
  - **空查询只显示搜索框**：`filtered=[]`、不渲染 `.cmdk-list` / `.cmdk-foot`；高度不再靠行数估算，
    而是 `reportHeight()` 量 `.cmdk` 的真实高度 + `PAD_Y(20)` 交给 `palette:resize`
    （主进程 clamp 68–540；BrowserWindow 的 `minHeight` 也必须是 68，否则 setBounds 被拦）。
    早期按「`MIN_H + 行数×行高`」估算，空态提示/换行/行高变化都会算偏（底部被裁半截）。
  - ⚠️ **Windows 透明无边框窗 `setSize()` 在「变大之后再变小」会被忽略**（放大有效、缩小无效，
    setBounds / setContentSize 有效）。所以改高度统一走 `setSearchWindowHeight()` → `setBounds({x,y,width,height})`。
    另外隐藏状态下改尺寸也可能被忽略，`showSearchWindow()` 要在 show() 前后各收一次 68；
    `palette:refresh` 里渲染层要等 React 提交后再量一次真实高度（`requestAnimationFrame`），
    否则读到的是上一屏布局（表现为窗口忽高忽低或底部留缝）。
  - `palette:show` IPC 与全局快捷键等价（未解锁时只出主窗口），回归脚本用它避免本机按键被别的程序吃掉。
  - ⚠️ `CommandPalette.tsx` 模块底部有 `PAGES.push(...PAGES_MORE)`，**PAGES 已含全部菜单页**：
    小窗里只能展开 `PAGES`，再展开 `PAGES_MORE` 会重复；末尾统一按 `id` 去重，重复 key 会让 React
    在结果变化时留下上一屏的残留行（表现为「回显一堆重复内容」）。
  - 选中**网址**条目：`palette:run` 带 `url` → 主进程 `shell.openExternal()` 直接用默认浏览器打开，
    **不要 `showMainWindow()`**（只补 `https://`、只允许 http/https；url 为空/invalid 才回退到应用内跳转）。
    选中**菜单页**：正常 `hideSearchWindow() + showMainWindow()` 转发给主窗口落地。
  - 未解锁时按搜索键**不出小窗**，直接 `showMainWindow()`（模块级 `appUnlocked` 标志，session:unlock/lock 维护）。
    ⚠️ 这类标志必须放**模块作用域**——放进 `setupIpcHandlers()` 的话模块级函数读不到，
    ReferenceError 会被快捷键回调静默吞掉；排查要在回调第一行加日志。
  - 小窗 `blur` 即隐藏、`close` 被 `!isQuitting` 拦截转隐藏；`session:lock` 时也要 `hideSearchWindow()`。
