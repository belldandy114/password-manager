'use strict';
/**
 * 会话 / 条目 / 回收站 / 剪贴板 / 用户设置 IPC。
 *
 * 这些 handler 原本写在 setupIpcHandlers() 里，直接读写 currentPassword、vaultEpoch、
 * clipboardTimers 等模块级状态。搬出来时一律走依赖注入：**状态仍然留在 main.js**，
 * 本模块只做「读 → 改 → 存盘」的流程，避免出现 ipc-files.js 那种看不到 main 变量、
 * 一点按钮就 ReferenceError 的老问题。
 */
const { app, clipboard } = require('electron');

// `ipcMain` 用惰性解析：单测可注入替身（`registerEntriesIpc({ ipcMain })`），生产不传就取真的。
const resolveIpcMain = (deps) => (deps && deps.ipcMain) || require('electron').ipcMain;

/**
 * @param {object} deps
 * @param {() => string|null} deps.getPassword
 * @param {(pw: string|null) => void} deps.setPassword
 * @param {() => void} deps.bumpEpoch
 * @param {(v: boolean) => void} deps.setUnlocked
 * @param {() => void} deps.touchActivity
 * @param {(pw: string) => any} deps.loadVault
 * @param {(vault: any, pw: string) => void} deps.saveVault
 * @param {(pw: string) => any} deps.loadTrash
 * @param {(trash: any[], pw: string) => void} deps.saveTrash
 * @param {() => void} deps.clearCaches
 * @param {() => void} deps.hideSearchWindow
 * @param {() => void} deps.ztRestartNotify
 * @param {() => void} deps.ztLoadSeen
 * @param {() => void} deps.ztPushUnread
 * @param {() => void} deps.backupVaultOncePerDay
 * @param {() => any} deps.loadSettings
 * @param {(s: any) => void} deps.saveSettings
 * @param {() => any} deps.getWindowPrefs
 * @param {() => void} deps.createTray
 * @param {() => void} deps.destroyTray
 * @param {() => void} deps.restartAutoUpdateCheck
 * @param {() => any} deps.getMainWindow
 * @param {(list: any[]) => any[]} deps.sortByDateDesc
 * @param {number} deps.retentionMs
 * @param {object} deps.defaultSettings
 * @param {(text: string) => void} deps.rememberClipboard
 * @param {(ms: number) => void} deps.clearClipboardAfter
 * @param {() => void} deps.clearClipHistory
 * @param {() => void} deps.wipeClipHistory
 * @param {() => any[]} deps.loadClipHistory
 * @param {() => any[]} deps.getClipHistory
 * @param {() => object} deps.getClipboardTimers
 * @param {() => void} deps.resetClipboardTimers
 * @param {() => void} deps.closePinWindows
 * @param {(v: boolean) => void} [deps.setAutoUnlockSuppressed] 手动锁定后置「本次进程内不自动解锁」（E4）
 */
function registerEntriesIpc(deps) {
  const ipcMain = resolveIpcMain(deps);
  const {
    getPassword, setPassword, bumpEpoch, setUnlocked, touchActivity,
    loadVault, saveVault, loadTrash, saveTrash,
    clearCaches, hideSearchWindow,
    ztRestartNotify, ztLoadSeen, ztPushUnread, backupVaultOncePerDay,
    loadSettings, saveSettings, getWindowPrefs, createTray, destroyTray,
    restartAutoUpdateCheck, getMainWindow,
    sortByDateDesc, retentionMs, defaultSettings,
    rememberClipboard, clearClipboardAfter, clearClipHistory,
    wipeClipHistory, loadClipHistory,
    getClipHistory, getClipboardTimers, resetClipboardTimers,
    closePinWindows,
    setAutoUnlockSuppressed,
  } = deps;

  /** 统一取当前会话密码；未解锁时返回 null（各 handler 据此回「未解锁」） */
  const pw = () => getPassword();

  // 1.36.0：原 `stopRecordingForPrivacy()`（「窄接口 + 退化到 clearCaches」的停录桥）随 UI 录制器下线整段删除。
  // 它是为停录而生的：录制域消失后没有停录这回事，防截屏只需 `win.setContentProtection(...)`。

  // ---- Session ----
  ipcMain.handle('session:unlock', (_event, { password }) => {
    clearCaches();
    const vault = loadVault(password);
    if (!vault) return { success: false };
    setPassword(password);
    setUnlocked(true);
    bumpEpoch();   // 搜索小窗的缓存必须失效，否则解锁后还显示「未解锁」
    touchActivity();
    // 解锁后启动禅道新 Bug 提醒（内部会检查开关）
    setTimeout(() => { try { ztRestartNotify(); } catch { /* 提醒失败不影响解锁 */ } }, 0);
    // 侧边栏红点：把上次没看的未读数推给界面
    setTimeout(() => { try { ztLoadSeen(); ztPushUnread(); } catch { /* 忽略 */ } }, 0);
    // 解锁即补一次当日备份：只改密码不改数据的日子也能有快照
    setTimeout(() => { try { backupVaultOncePerDay(); } catch { /* 忽略 */ } }, 400);
    // 剪贴板历史是加密落盘的，解锁后才有主密码可解，这里补读一次
    setTimeout(() => { try { loadClipHistory(); } catch { /* 解不开就当空历史 */ } }, 0);
    return { success: true, data: vault };
  });

  ipcMain.handle('session:lock', () => {
    setPassword(null);
    setUnlocked(false);
    bumpEpoch();   // 锁屏后小窗要立刻切成「未解锁」提示
    clearCaches();
    clearClipHistory();
    /**
     * E4（契约 §2.8）：手动锁定 = 本次进程内不再自动解锁（用户明确要求「锁了就是锁了」）。
     * **只置进程内抑制位，不删 autologin.json** —— 删了会让「锁定一次」变成永久关掉免密。
     * 抑制位在 main.js 模块作用域，进程重启自动归零。
     */
    try { setAutoUnlockSuppressed?.(true); } catch { /* 抑制位设置失败不影响锁定本身 */ }
    try { ztRestartNotify(); } catch { /* 锁定后自动停掉定时器 */ }
    hideSearchWindow();
    // 「钉」出来的小窗里是明文密码，锁屏必须连它们一起关掉
    try { closePinWindows?.(); } catch { /* 忽略 */ }
    return { success: true };
  });

  ipcMain.handle('session:is-unlocked', () => {
    return { unlocked: pw() !== null };
  });

  ipcMain.handle('session:touch', () => {
    touchActivity();
    return { success: true };
  });

  // ---- CRUD ----
  ipcMain.handle('entries:get-all', () => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:add', (_event, entry) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    vault.entries.push(entry);
    // Update tags list
    if (entry.tags) {
      entry.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
    }
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:update', (_event, entry) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    const idx = vault.entries.findIndex(e => e.id === entry.id);
    if (idx === -1) return { success: false, error: '网址不存在' };
    const prev = vault.entries[idx];

    // 密码变更时留一份历史（最多 10 条），改错了还能翻回来
    let next = entry;
    if (prev.password && entry.password && prev.password !== entry.password) {
      const list = Array.isArray(vault.history[entry.id]) ? vault.history[entry.id] : [];
      list.unshift({ password: prev.password, changedAt: new Date().toISOString() });
      vault.history[entry.id] = list.slice(0, 10);
      next = { ...entry, passwordUpdatedAt: new Date().toISOString() };
    } else if (!entry.passwordUpdatedAt && prev.passwordUpdatedAt) {
      next = { ...entry, passwordUpdatedAt: prev.passwordUpdatedAt };
    }

    vault.entries[idx] = next;
    // Update tags list
    if (next.tags) {
      next.tags.forEach(t => { if (!vault.tags.includes(t)) vault.tags.push(t); });
    }
    // 1.25.0：**不再自动清理「没有条目在用」的标签**。
    // 标签现在是用户显式管理的对象（可新建 / 重命名 / 删除 / 拖拽排序），
    // 自动清理会把用户刚建好的空标签在下一次编辑任意条目时静默删掉。
    // 真要清理走「库自检」里的 tag-unused 提示 + 用户手动删除。
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:delete', (_event, { ids, permanent }) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };

    if (permanent) {
      // Permanently delete
      vault.entries = vault.entries.filter(e => !ids.includes(e.id));
    } else {
      // Move to trash
      const trash = loadTrash(pw()) || [];
      const now = new Date().toISOString();
      const toTrash = vault.entries.filter(e => ids.includes(e.id));
      toTrash.forEach(e => { e.deletedAt = now; });
      trash.push(...toTrash);
      saveTrash(trash, pw());
      vault.entries = vault.entries.filter(e => !ids.includes(e.id));
    }
    // 1.25.0：不再自动清理孤儿标签（理由同 entries:update —— 会静默删掉用户新建的空标签）
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  ipcMain.handle('entries:batch-update', (_event, { ids, changes }) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    vault.entries.forEach(e => {
      if (ids.includes(e.id)) {
        Object.assign(e, changes);
        e.updatedAt = new Date().toISOString();
      }
    });
    // 1.25.0：不再自动清理孤儿标签（理由同 entries:update）
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  // ---- Tags（1.25.0：标签操作必须落盘）----
  //
  // 背景：TagSidebar 以前只调 setVaultData 改内存，重启全部回退；「批量添加标签」走
  // entries:batch-update 的 Object.assign，把条目原有标签整体冲掉（['重要','生产'] → ['新标签']）。
  // 这里四个 handler 都是「读 → 改 → saveVault」，并且**参数校验一律返回 error 不抛异常**
  // （ids.includes / for...of 在非数组入参上会直接抛，渲染层只会看到 rejected promise）。

  /** 标签名归一：非字符串一律当空，去首尾空白，并限制长度（防止渲染层塞超长串把库撑大） */
  const tagName = (v) => (typeof v === 'string' ? v.trim().slice(0, 100) : '');

  /**
   * 批量「追加」标签（并集，不覆盖）。
   * 入参 `{ ids: string[], tag: string }`。
   */
  ipcMain.handle('entries:add-tag', (_event, payload) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const { ids, tag } = payload || {};
    if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: '请选择要添加标签的条目' };
    const name = tagName(tag);
    if (!name) return { success: false, error: '标签不能为空' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    if (!Array.isArray(vault.tags)) vault.tags = [];

    const hit = new Set(ids.map(String));
    let changed = false;
    for (const e of vault.entries || []) {
      if (!hit.has(String(e.id))) continue;
      const list = Array.isArray(e.tags) ? e.tags : [];
      if (list.includes(name)) continue;   // 已有该标签：不动，避免无意义的加密写盘
      e.tags = Array.from(new Set([...list, name]));
      changed = true;
    }
    // 标签池同步：只有真的有条目在用才加，避免 ids 全部失效时留下一个 0 条目的孤儿标签
    const used = (vault.entries || []).some(e => Array.isArray(e.tags) && e.tags.includes(name));
    if (used && !vault.tags.includes(name)) {
      vault.tags.push(name);
      changed = true;
    }
    if (changed) saveVault(vault, pw());
    return { success: true, data: vault };
  });

  /**
   * 重命名标签：标签池 + 所有条目上的引用一起改。
   * 入参 `{ from: string, to: string }`。
   */
  ipcMain.handle('entries:rename-tag', (_event, payload) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const { from, to } = payload || {};
    const src = tagName(from);
    const dst = tagName(to);
    if (!src) return { success: false, error: '原标签不能为空' };
    if (!dst) return { success: false, error: '新标签不能为空' };
    if (src === dst) return { success: false, error: '新旧标签相同' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    if (!Array.isArray(vault.tags)) vault.tags = [];
    // 重名检查放在改动之前：合并语义应该走「删除 + 添加」，不能悄悄把两个标签并成一个
    if (vault.tags.includes(dst)) return { success: false, error: `标签「${dst}」已存在` };

    let touched = false;
    for (const e of vault.entries || []) {
      if (!Array.isArray(e.tags) || !e.tags.includes(src)) continue;
      // 条目上本来就可能已经有 dst：改名后必须去重，否则同一条目出现两个同名标签
      e.tags = Array.from(new Set(e.tags.map(t => (t === src ? dst : t))));
      touched = true;
    }
    const idx = vault.tags.indexOf(src);
    if (idx >= 0) {
      vault.tags[idx] = dst;
      touched = true;
    } else if (touched) {
      // 标签池里没有但条目上有（历史脏数据）：顺手补进池子，别让新名字只存在于条目上
      vault.tags.push(dst);
    }
    if (!touched) return { success: false, error: '标签不存在' };
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  /**
   * 删除标签：标签池 + 所有条目上的引用一起摘掉。
   * 入参 `{ tag: string }`。标签本来就不存在时按幂等成功处理（不报错）。
   */
  ipcMain.handle('entries:delete-tag', (_event, payload) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const { tag } = payload || {};
    const name = tagName(tag);
    if (!name) return { success: false, error: '标签不能为空' };
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    if (!Array.isArray(vault.tags)) vault.tags = [];

    const before = vault.tags.length;
    vault.tags = vault.tags.filter(t => t !== name);
    let changed = vault.tags.length !== before;
    for (const e of vault.entries || []) {
      if (!Array.isArray(e.tags) || !e.tags.includes(name)) continue;
      e.tags = e.tags.filter(t => t !== name);
      changed = true;
    }
    if (changed) saveVault(vault, pw());
    return { success: true, data: vault };
  });

  /**
   * 保存标签顺序（拖拽排序后调用），**同时承担「新建空标签」**。
   * 入参 `{ tags: string[] }`。
   *
   * 语义 = 按传入顺序重排 + 允许新增 + 未传到的已有标签追加到末尾。
   * 为什么允许新增：一个还没有任何条目引用的空标签没有别的落盘通道 ——
   * `entries:add-tag` 要求 ids 非空且只往条目上加，`entries:update` 需要条目本身。
   * 所以「新建标签」只能走这里（TagSidebar 的 handleCreateTag 就是这么调的）。
   * 反过来，**没传到的已有标签必须保留**：漏传不能等于删标签。
   */
  ipcMain.handle('entries:reorder-tags', (_event, payload) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const { tags } = payload || {};
    if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string')) {
      return { success: false, error: '标签顺序格式不正确' };
    }
    const vault = loadVault(pw());
    if (!vault) return { success: false, error: '数据损坏' };
    const existing = Array.isArray(vault.tags) ? vault.tags : [];
    const seen = new Set();
    const next = [];
    for (const raw of tags) {
      // 只去空、去重；未知标签保留（= 新建）。长度上限防止渲染层塞进超长串把库撑大
      const t = String(raw || '').trim().slice(0, 100);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      next.push(t);
    }
    // 没传到的已有标签追加到末尾（不能因为漏传就丢标签）
    for (const t of existing) {
      if (seen.has(t)) continue;
      seen.add(t);
      next.push(t);
    }
    vault.tags = next;
    saveVault(vault, pw());
    return { success: true, data: vault };
  });

  // ---- Trash ----
  ipcMain.handle('trash:get-all', () => {
    if (!pw()) return { success: false, error: '未解锁' };
    const trash = loadTrash(pw());
    if (!trash) return { success: false, error: '数据损坏' };
    // Auto-clean expired items
    const now = Date.now();
    const valid = trash.filter(e => {
      return e.deletedAt && (now - new Date(e.deletedAt).getTime() < retentionMs);
    });
    if (valid.length !== trash.length) saveTrash(valid, pw());
    return { success: true, data: sortByDateDesc(valid) };
  });

  ipcMain.handle('trash:restore', (_event, ids) => {
    if (!pw()) return { success: false, error: '未解锁' };
    const trash = loadTrash(pw());
    const vault = loadVault(pw());
    if (!trash || !vault) return { success: false, error: '数据损坏' };
    const toRestore = [];
    const remaining = trash.filter(e => {
      if (ids.includes(e.id)) {
        delete e.deletedAt;
        e.updatedAt = new Date().toISOString();
        toRestore.push(e);
        return false;
      }
      return true;
    });
    vault.entries.push(...toRestore);
    saveTrash(remaining, pw());
    saveVault(vault, pw());
    return { success: true, data: { entries: vault.entries, trash: remaining } };
  });

  /**
   * 从回收站里**彻底删除**指定条目（不是「移入回收站」，那是 entries:delete）。
   * 入参 `ids: string[]`（与 trash:restore 一致，裸数组）。
   */
  ipcMain.handle('trash:delete', (_event, ids) => {
    if (!pw()) return { success: false, error: '未解锁' };
    if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: '请选择要删除的条目' };
    const trash = loadTrash(pw());
    if (!trash) return { success: false, error: '数据损坏' };
    const hit = new Set(ids.map(String));
    const remaining = trash.filter(e => !hit.has(String(e.id)));
    // 一条都没命中就不写盘：避免「点了删除但 id 已过期」时白跑一次加密写盘
    if (remaining.length !== trash.length) saveTrash(remaining, pw());
    // 与 trash:get-all 保持同一排序（按删除时间倒序），否则渲染层 setTrash 后顺序会跳变
    return { success: true, data: sortByDateDesc(remaining) };
  });

  ipcMain.handle('trash:empty', () => {
    if (!pw()) return { success: false, error: '未解锁' };
    saveTrash([], pw());
    return { success: true };
  });

  // ---- Clipboard ----
  ipcMain.handle('clipboard:copy', (_event, { text, delay }) => {
    clipboard.writeText(text);
    if (delay > 0) {
      rememberClipboard(text);
      clearClipboardAfter(delay);
    }
    return { success: true };
  });

  /** 敏感复制历史（设置页展示；默认关闭时不记录） */
  ipcMain.handle('clipboard:history', () => ({
    success: true,
    data: { enabled: !!(loadSettings() || {}).clipboardHistory, items: getClipHistory().slice() },
  }));

  ipcMain.handle('clipboard:history-clear', () => {
    wipeClipHistory();
    return { success: true };
  });

  ipcMain.handle('clipboard:clear', () => {
    clipboard.clear();
    for (const k of Object.keys(getClipboardTimers())) {
      clearTimeout(getClipboardTimers()[k]);
    }
    resetClipboardTimers();
    return { success: true };
  });

  // ---- Settings (user preferences) ----
  ipcMain.handle('settings:get', () => {
    const s = loadSettings() || {};
    return {
      clipboardClearDelay: s.clipboardClearDelay || defaultSettings.clipboardClearDelay,
      passwordAutoHideDelay: s.passwordAutoHideDelay || defaultSettings.passwordAutoHideDelay,
      autoLockDelay: s.autoLockDelay || defaultSettings.autoLockDelay,
      defaultViewMode: s.defaultViewMode || defaultSettings.defaultViewMode,
      defaultEnvFilter: s.defaultEnvFilter || defaultSettings.defaultEnvFilter,
      theme: s.theme || defaultSettings.theme,
      accent: s.accent || defaultSettings.accent,
      density: s.density || defaultSettings.density,
      minimizeToTray: !!s.minimizeToTray,
      closeToTray: !!s.closeToTray,
      contentProtection: !!s.contentProtection,
      launchAtLogin: !!s.launchAtLogin,
      lastPage: s.lastPage || defaultSettings.lastPage,
      zentaoNotify: !!s.zentaoNotify,
      zentaoNotifyInterval: Number(s.zentaoNotifyInterval) || defaultSettings.zentaoNotifyInterval,
      zentaoStaleOn: !!s.zentaoStaleOn,
      zentaoStaleDays: Math.max(1, Math.min(60, Number(s.zentaoStaleDays) || defaultSettings.zentaoStaleDays)),
      // 多套禅道配置里「当前用哪套」：主进程的定时提醒也要跟着它走
      zentaoActiveId: String(s.zentaoActiveId || 'zentao'),
      backupKeep: Math.min(60, Math.max(1, Number(s.backupKeep) || defaultSettings.backupKeep)),
      // 异地备份目录：设置页用它初始化草稿，读不回会让用户点一次「保存设置」就把它清空
      backupMirrorDir: String(s.backupMirrorDir || ''),
      // ---- 环境巡检（1.24.3 用户反馈：重启后定时巡检回默认）----
      // settings:save 是全量 merge 能写进文件，但 settings:get 没把这两个键返回给渲染层，
      // 渲染层的巡检调度器和设置页草稿永远读到默认值 —— 保存等于没保存。
      envProbeInterval: Math.min(720, Math.max(0, Number(s.envProbeInterval) || 0)),
      envProbeNotifyOnFlip: s.envProbeNotifyOnFlip !== false,
      // 1.25.0：巡检超时以前只存在页面 useState 里，定时巡检写死 8000 —— 慢环境永远超时。
      // 这里必须返回，否则设置页保存后重启又回默认（和上面 envProbeInterval 是同一类缺口）。
      envProbeTimeoutMs: Math.min(60000, Math.max(1000, Number(s.envProbeTimeoutMs) || 8000)),
      // ---- 同类缺口：渲染层会读、重启后回默认的开关与路径 ----
      clipboardHistory: !!s.clipboardHistory,
      updateCheckOnStart: s.updateCheckOnStart !== false,
      hotkeySearch: String(s.hotkeySearch || ''),
      hotkeyToggle: String(s.hotkeyToggle || ''),
      // 1.25.0：主进程一直在写这个键，但 settings:get 不返回 —— 设置页回填拿不到
      hotkeyQuickNote: String(s.hotkeyQuickNote || ''),
      jmeterPath: String(s.jmeterPath || ''),
      jmeterOutDir: String(s.jmeterOutDir || ''),
      jmeterLastJmx: String(s.jmeterLastJmx || ''),
      // 更新源与检查周期：设置页要能读回当前值，否则保存时会把已有值覆盖掉
      updateMirrorUrl: String(s.updateMirrorUrl || ''),
      updateCheckIntervalHours: Math.min(168, Math.max(0, Number(s.updateCheckIntervalHours) || 0)),
      // 自定义存储位置（空 = 用数据目录下的默认路径）
      attachDir: String(s.attachDir || ''),
      notesDir: String(s.notesDir || ''),
      weeklyDir: String(s.weeklyDir || ''),
      // 自定义背景图（1.30.0）：渲染层要读回，否则重启后背景丢失
      backgroundImage: String(s.backgroundImage || ''),
      backgroundOpacity: Number.isFinite(Number(s.backgroundOpacity)) ? Number(s.backgroundOpacity) : 0.32,
      backgroundBlur: Number.isFinite(Number(s.backgroundBlur)) ? Number(s.backgroundBlur) : 8,
      backgroundDim: Number.isFinite(Number(s.backgroundDim)) ? Number(s.backgroundDim) : 0.42,
      backgroundAccent: String(s.backgroundAccent || ''),
      backgroundAutoAccent: s.backgroundAutoAccent !== false,
      browserPaths: s.browserPaths || { ...defaultSettings.browserPaths },
      keybindings: s.keybindings || { ...defaultSettings.keybindings },
    };
  });

  /**
   * 渲染层允许写的设置键白名单（1.25.0）。
   *
   * 以前是 `Object.assign(s, prefs)` 全量合并 —— settings.json 里同时存着
   * masterPasswordHash / salt / securityWordHash / recoveryData / dataKeyEncrypted，
   * 渲染层传 `{ masterPasswordHash: <已知密码的哈希>, salt: <对应盐> }` 就能改写认证凭据。
   * 现在只放行「确实是用户偏好」的键，认证字段一律拒绝。
   */
  const SETTINGS_WRITABLE = new Set([
    'clipboardClearDelay', 'passwordAutoHideDelay', 'autoLockDelay',
    'defaultViewMode', 'defaultEnvFilter', 'theme', 'accent', 'density',
    'minimizeToTray', 'closeToTray', 'contentProtection', 'launchAtLogin',
    'lastPage', 'updateCheckOnStart', 'updateNotifiedVersion',
    'zentaoNotify', 'zentaoNotifyInterval', 'zentaoStaleOn', 'zentaoStaleDays', 'zentaoActiveId',
    'envProbeInterval', 'envProbeNotifyOnFlip', 'envProbeTimeoutMs',
    'backupKeep', 'backupMirrorDir',
    'attachDir', 'notesDir', 'weeklyDir',
    'updateMirrorUrl', 'updateCheckIntervalHours',
    'hotkeySearch', 'hotkeyToggle', 'hotkeyQuickNote',
    'jmeterPath', 'jmeterOutDir', 'jmeterLastJmx',
    'clipboardHistory', 'browserPaths', 'keybindings',
    // 1.30.0：自定义背景图（图片文件由 bg:choose 写入，这里只存参数）
    'backgroundImage', 'backgroundOpacity', 'backgroundBlur', 'backgroundDim',
    'backgroundAccent', 'backgroundAutoAccent',
  ]);

  ipcMain.handle('settings:save', (_event, prefs) => {
    const s = loadSettings() || {};
    // 只合并白名单里的键：认证字段（masterPasswordHash / salt / recoveryData …）永远不接受渲染层写入
    if (prefs && typeof prefs === 'object') {
      for (const key of Object.keys(prefs)) {
        if (SETTINGS_WRITABLE.has(key)) s[key] = prefs[key];
      }
    }
    saveSettings(s);
    // Keep the tray icon in sync: create it as soon as a tray behaviour is enabled,
    // remove it when both are off so the user is not left with a stray icon.
    if (prefs && (Object.prototype.hasOwnProperty.call(prefs, 'zentaoNotify')
      || Object.prototype.hasOwnProperty.call(prefs, 'zentaoNotifyInterval')
      // 只开「超期提醒」也要把定时器拉起来，否则勾了等于没勾
      || Object.prototype.hasOwnProperty.call(prefs, 'zentaoStaleOn'))) {
      try { ztRestartNotify(); } catch { /* 忽略 */ }
    }
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'updateCheckIntervalHours')) {
      try { restartAutoUpdateCheck(); } catch { /* 忽略 */ }
    }

    const p = getWindowPrefs();
    if (p.minimizeToTray || p.closeToTray) createTray();
    else {
      // Only tear the tray down if the window is visible — otherwise the app would
      // become unreachable while hidden.
      const win = getMainWindow();
      if (win && !win.isDestroyed() && win.isVisible()) destroyTray();
    }

    // Privacy: exclude the window from screenshots / screen recordings.
    const win = getMainWindow();
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'contentProtection')
      && win && !win.isDestroyed()) {
      win.setContentProtection(!!prefs.contentProtection);
    }

    // 1.36.0：运行期打开防截屏时的「停录」联动已随录制域删除；
    // 开启防截屏本身仍在上面的 setContentProtection 里生效（本机手工验过开关可正常切换）。

    // Start with Windows (only meaningful for the installed app).
    if (prefs && Object.prototype.hasOwnProperty.call(prefs, 'launchAtLogin') && app.isPackaged) {
      try {
        // 带 --hidden：开机启动时不弹窗，直接驻留托盘（否则每次开机都蹦一个窗口）
        app.setLoginItemSettings({
          openAtLogin: !!prefs.launchAtLogin,
          path: process.execPath,
          args: ['--hidden'],
        });
      } catch { /* ignore */ }
    }
    return { success: true };
  });
}

module.exports = { registerEntriesIpc };
