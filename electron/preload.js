const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 取拖入文件的真实路径。
   * Electron 32 起 File.path 被移除，渲染层拿到的 File 只剩 name，必须回主进程侧的
   * webUtils 转换，否则拖放功能会静默失效（只能点按钮选文件）。
   */
  filePathFor: (file) => {
    try { return (file && webUtils.getPathForFile(file)) || ''; } catch { return ''; }
  },

  // Auth
  authIsSetup: () => ipcRenderer.invoke('auth:is-setup'),
  authSetup: (data) => ipcRenderer.invoke('auth:setup', data),
  authVerify: (data) => ipcRenderer.invoke('auth:verify', data),
  authGetHint: () => ipcRenderer.invoke('auth:get-hint'),
  authChangePassword: (data) => ipcRenderer.invoke('auth:change-password', data),
  authSetSecurityWord: (data) => ipcRenderer.invoke('auth:set-security-word', data),
  authVerifySecurityWord: (data) => ipcRenderer.invoke('auth:verify-security-word', data),
  authHasSecurityWord: () => ipcRenderer.invoke('auth:has-security-word'),
  authResetPassword: (data) => ipcRenderer.invoke('auth:reset-password', data),

  // Session
  sessionUnlock: (data) => ipcRenderer.invoke('session:unlock', data),
  sessionLock: () => ipcRenderer.invoke('session:lock'),
  sessionIsUnlocked: () => ipcRenderer.invoke('session:is-unlocked'),
  sessionTouch: () => ipcRenderer.invoke('session:touch'),

  // Entries
  entriesGetAll: () => ipcRenderer.invoke('entries:get-all'),
  entriesAdd: (data) => ipcRenderer.invoke('entries:add', data),
  entriesUpdate: (data) => ipcRenderer.invoke('entries:update', data),
  entriesDelete: (data) => ipcRenderer.invoke('entries:delete', data),
  entriesBatchUpdate: (data) => ipcRenderer.invoke('entries:batch-update', data),
  /** 批量「追加」标签（并集，不覆盖原有标签） */
  entriesAddTag: (data) => ipcRenderer.invoke('entries:add-tag', data),
  /** 标签重命名 / 删除 / 排序：1.25.0 起标签操作必须落盘 */
  entriesRenameTag: (data) => ipcRenderer.invoke('entries:rename-tag', data),
  entriesDeleteTag: (data) => ipcRenderer.invoke('entries:delete-tag', data),
  entriesReorderTags: (data) => ipcRenderer.invoke('entries:reorder-tags', data),

  // Trash
  trashGetAll: () => ipcRenderer.invoke('trash:get-all'),
  trashRestore: (data) => ipcRenderer.invoke('trash:restore', data),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),
  /** 从回收站彻底删除指定条目 */
  trashDelete: (data) => ipcRenderer.invoke('trash:delete', data),

  // Clipboard
  clipboardCopy: (data) => ipcRenderer.invoke('clipboard:copy', data),
  clipboardClear: () => ipcRenderer.invoke('clipboard:clear'),
  clipboardHistory: () => ipcRenderer.invoke('clipboard:history'),
  clipboardHistoryClear: () => ipcRenderer.invoke('clipboard:history-clear'),
  /** 实际生效的全局快捷键（Ctrl+空格被占用时主进程会自动回退） */
  hotkeyInfo: () => ipcRenderer.invoke('app:hotkeys'),

  /**
   * 「钉」成独立小窗：把一条记录摆到桌面上，锁屏时主进程会统一关掉。
   * 传字符串 = 钉一条网址记录；传 `{ id, kind: 'note' }` = 钉一条测试笔记。
   */
  pinOpen: (payload) => ipcRenderer.invoke('pin:open', payload),
  /** 小窗自己关自己 */
  pinClose: () => ipcRenderer.invoke('pin:close'),
  pinResize: (payload) => ipcRenderer.invoke('pin:resize', payload),  /** 修改全局快捷键：冲突会返回 success:false + error，并回滚到原来能用的键 */
  hotkeyApply: (payload) => ipcRenderer.invoke('app:hotkeys-apply', payload),
  /** 窗口隐藏时主进程要求关掉命令面板 */
  onCloseCommandPalette: (cb) => {
    const h = () => cb();
    ipcRenderer.on('app:cmd-palette-close', h);
    return () => ipcRenderer.removeListener('app:cmd-palette-close', h);
  },
  // ---- 独立快速搜索小窗（?window=palette）----
  /** 小窗每次弹出时主进程要求重取一遍数据 */
  onPaletteRefresh: (cb) => {
    const h = () => cb();
    ipcRenderer.on('palette:refresh', h);
    return () => ipcRenderer.removeListener('palette:refresh', h);
  },
  /** 小窗收起自己 */
  paletteHide: () => ipcRenderer.invoke('palette:hide'),
  /** 弹出/聚焦小窗（与全局快捷键等价，托盘与回归脚本用） */
  paletteShow: () => ipcRenderer.invoke('palette:show'),
  /** 小窗把选中的命令交给主窗口执行 */
  paletteRun: (item) => ipcRenderer.invoke('palette:run', item),
  /** 小窗按结果条数调整自身高度（空查询时只留搜索框） */
  paletteResize: (height) => ipcRenderer.invoke('palette:resize', height),
  /** 密码库数据版本：没变就复用上次拼好的命令列表，省掉 7 类全量取数 */
  paletteEpoch: () => ipcRenderer.invoke('palette:epoch'),
  /** 小窗里发现未解锁：让主窗口出来解锁 */
  paletteUnlock: () => ipcRenderer.invoke('palette:unlock'),
  /** 主窗口接小窗转发过来的命令 */
  onPaletteRun: (cb) => {
    const h = (_e, item) => cb(item);
    ipcRenderer.on('palette:run', h);
    return () => ipcRenderer.removeListener('palette:run', h);
  },
  // ---- 随手记小窗（?window=quicknote）----
  /** 收起随手记小窗（Esc / 保存后自动收） */
  quicknoteHide: () => ipcRenderer.invoke('quicknote:hide'),
  /** 弹出随手记小窗（与全局快捷键等价，托盘与回归脚本用） */
  quicknoteShow: () => ipcRenderer.invoke('quicknote:show'),
  /** 小窗每次弹出时复位「已保存」之类的临时提示 */
  onQuickNoteFocus: (cb) => {
    const h = () => cb();
    ipcRenderer.on('quicknote:focus', h);
    return () => ipcRenderer.removeListener('quicknote:focus', h);
  },
  onClipboardCleared: (cb) => {
    ipcRenderer.on('clipboard-cleared', () => cb());
    return () => ipcRenderer.removeAllListeners('clipboard-cleared');
  },

  // Tray menu → "锁定"
  onLockRequest: (cb) => {
    ipcRenderer.on('lock-request', () => cb());
    return () => ipcRenderer.removeAllListeners('lock-request');
  },

  // 自定义背景图
  bgGet: () => ipcRenderer.invoke('bg:get'),
  bgChoose: () => ipcRenderer.invoke('bg:choose'),
  bgClear: () => ipcRenderer.invoke('bg:clear'),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (data) => ipcRenderer.invoke('settings:save', data),

  // Password generator
  passwordGenerate: (opts) => ipcRenderer.invoke('password:generate', opts),

  // Backups
  backupList: () => ipcRenderer.invoke('backup:list'),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  backupMirrorPick: () => ipcRenderer.invoke('backup:mirror-pick'),
  auditLog: (action, detail) => ipcRenderer.invoke('audit:log', { action, detail }),
  auditList: (limit) => ipcRenderer.invoke('audit:list', limit),
  auditClear: () => ipcRenderer.invoke('audit:clear'),
  backupOpenFolder: () => ipcRenderer.invoke('backup:open-folder'),
  backupRestore: (name) => ipcRenderer.invoke('backup:restore', { name }),

  // 库自检 / 恢复演练 / 诊断包
  vaultAudit: () => ipcRenderer.invoke('vault:audit'),
  vaultRestoreDrill: (name) => ipcRenderer.invoke('vault:restore-drill', { name }),
  logExportDiagnostic: () => ipcRenderer.invoke('log:export-diagnostic'),

  // 数据目录（可见 / 打开 / 迁移）
  dataInfo: () => ipcRenderer.invoke('data:info'),
  dataOpenFolder: (which) => ipcRenderer.invoke('data:open-folder', { which }),
  dataMigrate: () => ipcRenderer.invoke('data:migrate'),
  dataResetLocation: () => ipcRenderer.invoke('data:reset-location'),

  // Generic collection storage (snippets / notes / checklists / accounts / environments / apiRequests)
  wsGet: (key) => ipcRenderer.invoke('ws:get', key),
  wsSet: (key, value) => ipcRenderer.invoke('ws:set', { key, value }),

  // Password history
  historyGet: (entryId) => ipcRenderer.invoke('history:get', entryId),

  // TOTP
  totpCode: (data) => ipcRenderer.invoke('totp:code', data),

  // Attachments
  attachmentPick: () => ipcRenderer.invoke('attachment:pick'),
  attachmentOpen: (data) => ipcRenderer.invoke('attachment:open', data),
  attachmentDelete: (data) => ipcRenderer.invoke('attachment:delete', data),
  // 粘贴截图（#5）：dataURL 进、加密落盘；读回 dataURL 用于显示
  attachmentSaveImage: (data) => ipcRenderer.invoke('attachment:save-image', data),
  attachmentReadImage: (data) => ipcRenderer.invoke('attachment:read-image', data),
  /** 附件集中管理：只列元数据（id/大小/时间/所在目录），内容按需逐张读 */
  attachmentList: () => ipcRenderer.invoke('attachment:list'),
  /** 解密后另存到用户选的位置 */
  attachmentExport: (data) => ipcRenderer.invoke('attachment:export', data),
  /** 批量导出到用户选的目录（重名自动加后缀，不覆盖） */
  attachmentExportMany: (data) => ipcRenderer.invoke('attachment:export-many', data),
  /** 在资源管理器中定位附件文件（不传 id 则只打开附件目录） */
  attachmentReveal: (data) => ipcRenderer.invoke('attachment:reveal', data || {}),
  /** 当前附件目录信息（是否自定义 / 默认位置 / 目录是否存在） */
  attachmentDirInfo: () => ipcRenderer.invoke('attachment:dir-info'),
  /** 确保笔记附件目录（<笔记目录>/attachments）存在：切完笔记目录后自动建出来 */
  attachmentEnsureNoteDir: () => ipcRenderer.invoke('attachment:ensure-note-dir'),
  /** 选一个目录（不立即切换） */
  attachmentPickDir: () => ipcRenderer.invoke('attachment:pick-dir'),
  /** 切换附件目录：把已有附件复制过去后立即生效 */
  attachmentSetDir: (data) => ipcRenderer.invoke('attachment:set-dir', data || {}),
  /** 非图片附件的文本预览（证书 / 密钥 / 配置） */
  attachmentTextPreview: (data) => ipcRenderer.invoke('attachment:text-preview', data || {}),

  // 环境巡检（#3）
  envProbe: (data) => ipcRenderer.invoke('env:probe', data),
  envOpen: (data) => ipcRenderer.invoke('env:open', data),

  // API debugger / Zentao
  apiSend: (data) => ipcRenderer.invoke('api:send', data),
  apiCookies: (origin) => ipcRenderer.invoke('api:cookies', { origin }),
  apiCookiesClear: (origin) => ipcRenderer.invoke('api:cookies-clear', { origin }),
  // WebSocket / SSE 长连接（1.23.0）：事件统一从 ws:event 推回来
  wsConnect: (data) => ipcRenderer.invoke('ws:connect', data),
  wsSend: (data) => ipcRenderer.invoke('ws:send', data),
  wsClose: (data) => ipcRenderer.invoke('ws:close', data),
  sseConnect: (data) => ipcRenderer.invoke('sse:connect', data),
  onWsEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('ws:event', h);
    return () => ipcRenderer.removeListener('ws:event', h);
  },
  zentaoLogin: (cfg) => ipcRenderer.invoke('zentao:login', cfg),
  zentaoMyBugs: (cfg, scope, productIds) => ipcRenderer.invoke('zentao:my-bugs', cfg, scope, productIds),
  // fresh=true 绕过主进程 60 秒短时缓存（用户主动点「拉取项目」/快捷键刷新时用）
  zentaoProjects: (cfg, fresh) => ipcRenderer.invoke('zentao:projects', { ...cfg, fresh: !!fresh }),
  // 手动补项目：产品缺失时（接口不返回已关闭/私有产品）按 id 单查一次
  zentaoProductProbe: (cfg, productId) => ipcRenderer.invoke('zentao:product-probe', { cfg, productId }),
  zentaoProjectBugs: (cfg, productId, force) => ipcRenderer.invoke('zentao:project-bugs', { cfg, productId, force: !!force }),
  zentaoAllBugs: (cfg, force) => ipcRenderer.invoke('zentao:all-bugs', cfg, { force: !!force }),
  zentaoSummary: (cfg, productIds, force) =>
    ipcRenderer.invoke('zentao:summary', cfg, productIds, { force: !!force }),
  /** 跨实例汇总：一次拉多家公司，返回带 instanceId/instanceName 的合并结果 */
  zentaoSummaryMulti: (targets, force) =>
    ipcRenderer.invoke('zentao:summary-multi', targets, { force: !!force }),
  onZentaoDigestProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('zentao:digest-progress', h);
    return () => ipcRenderer.removeListener('zentao:digest-progress', h);
  },
  zentaoBugDetail: (cfg, bugId) => ipcRenderer.invoke('zentao:bug-detail', { cfg, bugId }),
  zentaoAttachment: (cfg, url, name, mode) => ipcRenderer.invoke('zentao:attachment', { cfg, url, name, mode }),
  zentaoNotifyNow: () => ipcRenderer.invoke('zentao:notify-now'),
  zentaoNotifyStatus: () => ipcRenderer.invoke('zentao:notify-status'),
  zentaoUnread: () => ipcRenderer.invoke('zentao:unread'),
  zentaoUnreadClear: () => ipcRenderer.invoke('zentao:unread-clear'),
  onZentaoUnread: (cb) => {
    const h = (_e, n) => cb(n);
    ipcRenderer.on('zentao:unread', h);
    return () => ipcRenderer.removeListener('zentao:unread', h);
  },
  onZentaoOpen: (cb) => {
    const h = () => cb();
    ipcRenderer.on('zentao:open', h);
    return () => ipcRenderer.removeListener('zentao:open', h);
  },
  /** 主进程要求跳到某个页面（点系统通知时用） */
  onAppNavigate: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on('app:navigate', h);
    return () => ipcRenderer.removeListener('app:navigate', h);
  },
  /** 系统通知：环境巡检状态翻转等 */
  appNotify: (payload) => ipcRenderer.invoke('app:notify', payload),

  // 周报（本地 Markdown 目录）
  weeklyList: (dir) => ipcRenderer.invoke('weekly:list', { dir }),
  weeklyRead: (dir, name) => ipcRenderer.invoke('weekly:read', { dir, name }),
  weeklyPickDir: () => ipcRenderer.invoke('weekly:pick-dir'),
  weeklyReveal: (dir, name) => ipcRenderer.invoke('weekly:reveal', { dir, name }),
  weeklySave: (dir, name, content) => ipcRenderer.invoke('weekly:save', { dir, name, content }),
  weeklyRename: (dir, name, nextName) => ipcRenderer.invoke('weekly:rename', { dir, name, nextName }),
  weeklyDelete: (dir, name) => ipcRenderer.invoke('weekly:delete', { dir, name }),

  // 测试笔记（可选：存到自己选的目录）
  notesList: (dir) => ipcRenderer.invoke('notes:list', { dir }),
  notesRead: (dir, name) => ipcRenderer.invoke('notes:read', { dir, name }),
  notesSave: (dir, name, content, title) => ipcRenderer.invoke('notes:save', { dir, name, content, title }),
  notesRename: (dir, name, nextName) => ipcRenderer.invoke('notes:rename', { dir, name, nextName }),
  notesDelete: (dir, name) => ipcRenderer.invoke('notes:delete', { dir, name }),
  notesPickDir: () => ipcRenderer.invoke('notes:pick-dir'),
  notesReveal: (dir, name) => ipcRenderer.invoke('notes:reveal', { dir, name }),

  // 用例库（文件管家：收纳 / 打开 / 导出，应用内不解析内容）
  casesConfig: () => ipcRenderer.invoke('cases:config'),
  casesChooseRoot: () => ipcRenderer.invoke('cases:choose-root'),
  casesChangeRoot: (next) => ipcRenderer.invoke('cases:change-root', { next }),
  casesList: (rel) => ipcRenderer.invoke('cases:list', { rel }),
  casesMkdir: (rel, name) => ipcRenderer.invoke('cases:mkdir', { rel, name }),
  casesRename: (rel, name) => ipcRenderer.invoke('cases:rename', { rel, name }),
  casesPickFiles: () => ipcRenderer.invoke('cases:pick-files'),
  casesImport: (rel, files) => ipcRenderer.invoke('cases:import', { rel, files }),
  casesMove: (rel, targetRel) => ipcRenderer.invoke('cases:move', { rel, targetRel }),
  casesPreview: (rel) => ipcRenderer.invoke('cases:preview', { rel }),
  casesSearch: (q, limit) => ipcRenderer.invoke('cases:search', { q, limit }),
  casesPickImportDir: () => ipcRenderer.invoke('cases:pick-import-dir'),
  casesImportFolder: (rel, dir) => ipcRenderer.invoke('cases:import-folder', { rel, dir }),
  /* ---- 压力测试脚本库 ---- */
  jmxlibConfig: () => ipcRenderer.invoke('jmxlib:config'),
  jmxlibChooseRoot: () => ipcRenderer.invoke('jmxlib:choose-root'),
  jmxlibDefaultOut: () => ipcRenderer.invoke('jmxlib:default-out'),
  jmxlibPickDir: () => ipcRenderer.invoke('jmxlib:pick-dir'),
  jmxlibCreateTemplate: (rel, payload) => ipcRenderer.invoke('jmxlib:create-template', { rel, ...payload }),
  jmxlibList: (rel) => ipcRenderer.invoke('jmxlib:list', { rel }),
  jmxlibPickFiles: () => ipcRenderer.invoke('jmxlib:pick-files'),
  jmxlibImport: (rel, paths) => ipcRenderer.invoke('jmxlib:import', { rel, paths }),
  jmxlibMkdir: (rel, name) => ipcRenderer.invoke('jmxlib:mkdir', { rel, name }),
  jmxlibRename: (rel, name) => ipcRenderer.invoke('jmxlib:rename', { rel, name }),
  jmxlibDelete: (rel) => ipcRenderer.invoke('jmxlib:delete', { rel }),
  jmxlibReveal: (rel) => ipcRenderer.invoke('jmxlib:reveal', { rel }),
  jmxlibOpen: (rel) => ipcRenderer.invoke('jmxlib:open', { rel }),
  jmxlibMetaSet: (rel, meta) => ipcRenderer.invoke('jmxlib:meta-set', { rel, meta }),
  jmxlibValidate: (rel) => ipcRenderer.invoke('jmxlib:validate', { rel }),
  jmxlibMarkRun: (rel, payload) => ipcRenderer.invoke('jmxlib:mark-run', { rel, ...payload }),
  jmxlibCreateBatch: (rel, plan) => ipcRenderer.invoke('jmxlib:create-batch', { rel, plan }),
  onCasesChanged: (cb) => {
    const h = () => cb();
    ipcRenderer.on('cases:changed', h);
    return () => ipcRenderer.removeListener('cases:changed', h);
  },
  casesDelete: (rel) => ipcRenderer.invoke('cases:delete', { rel }),
  casesOpen: (rel) => ipcRenderer.invoke('cases:open', { rel }),
  casesOpenWith: (rel) => ipcRenderer.invoke('cases:open-with', { rel }),
  casesReveal: (rel) => ipcRenderer.invoke('cases:reveal', { rel }),
  casesPickDir: () => ipcRenderer.invoke('cases:pick-dir'),
  casesPickExportDir: () => ipcRenderer.invoke('cases:pick-export-dir'),
  casesExport: (rels, dest) => ipcRenderer.invoke('cases:export', { rels, dest }),

  // Update check
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (url, useMirror, opts) => ipcRenderer.invoke('update:download', { url, useMirror, ...(opts || {}) }),
  updatePickFile: () => ipcRenderer.invoke('update:pick-file'),
  // 第 4 参 opts.bom 必须**显式 true** 才带 BOM；不传就不带（默认中性，见 ipc-api.js file:save-text）
  saveText: (content, defaultName, filters, opts) => ipcRenderer.invoke('file:save-text', { content, defaultName, filters, bom: !!(opts && opts.bom === true) }),
  pickFile: (title, filters) => ipcRenderer.invoke('file:pick', { title, filters }),
  readTextFile: (file, maxBytes) => ipcRenderer.invoke('file:read-text', { file, maxBytes }),
  updateInstall: (file) => ipcRenderer.invoke('update:install', { file }),
  onUpdateProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('update:progress', h);
    return () => ipcRenderer.removeListener('update:progress', h);
  },

  // Import/Export
  importCsvJson: (data) => ipcRenderer.invoke('import:csv-json', data),
  importEncrypted: (data) => ipcRenderer.invoke('import:encrypted', data),
  importConfirm: (data) => ipcRenderer.invoke('import:confirm', data),
  importDownloadTemplate: () => ipcRenderer.invoke('import:download-template'),
  exportEncrypted: (data) => ipcRenderer.invoke('export:encrypted', data),
  exportPlain: (data) => ipcRenderer.invoke('export:plain', data),
  exportSelectedEncrypted: (data) => ipcRenderer.invoke('export:selected-encrypted', data),
  exportSelectedPlain: (data) => ipcRenderer.invoke('export:selected-plain', data),

  // File dialogs
  dialogOpenFile: (data) => ipcRenderer.invoke('dialog:open-file', data),
  dialogSaveFile: (data) => ipcRenderer.invoke('dialog:save-file', data),
  fileWrite: (data) => ipcRenderer.invoke('file:write', data),

  // App
  appGetPath: (name) => ipcRenderer.invoke('app:get-path', name),

  // Browser
  browserDetect: () => ipcRenderer.invoke('browser:detect'),
  browserGetKnown: () => ipcRenderer.invoke('browser:get-known'),
  browserOpen: (data) => ipcRenderer.invoke('browser:open', data),

  // JMeter（非 GUI 运行）
  jmeterDetect: () => ipcRenderer.invoke('jmeter:detect'),
  jmeterPickExe: () => ipcRenderer.invoke('jmeter:pick-exe'),
  jmeterPickScript: () => ipcRenderer.invoke('jmeter:pick-script'),
  jmeterPickJavaHome: () => ipcRenderer.invoke('jmeter:pick-java-home'),
  jmeterInspectScript: (p) => ipcRenderer.invoke('jmeter:inspect-script', p),
  codelabDetect: () => ipcRenderer.invoke('codelab:detect'),
  codelabRun: (payload) => ipcRenderer.invoke('codelab:run', payload),
  codelabPreview: (html) => ipcRenderer.invoke('codelab:preview', html),
  codelabStop: () => ipcRenderer.invoke('codelab:stop'),
  onCodelabOutput: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('codelab:output', h); return () => ipcRenderer.removeListener('codelab:output', h); },
  onCodelabMeta: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('codelab:meta', h); return () => ipcRenderer.removeListener('codelab:meta', h); },
  onCodelabDone: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('codelab:done', h); return () => ipcRenderer.removeListener('codelab:done', h); },
  jmeterHistory: () => ipcRenderer.invoke('jmeter:history'),
  jmeterHistoryClear: () => ipcRenderer.invoke('jmeter:history-clear'),
  jmeterPickOutDir: () => ipcRenderer.invoke('jmeter:pick-out-dir'),
  jmeterDefaults: () => ipcRenderer.invoke('jmeter:defaults'),
  jmeterRemember: (patch) => ipcRenderer.invoke('jmeter:remember', patch),
  jmeterRun: (opts) => ipcRenderer.invoke('jmeter:run', opts),
  jmeterStop: () => ipcRenderer.invoke('jmeter:stop'),
  jmeterStatus: () => ipcRenderer.invoke('jmeter:status'),
  jmeterOpenPath: (p) => ipcRenderer.invoke('jmeter:open-path', p),
  jmeterAnalyzeJtl: (p) => ipcRenderer.invoke('jmeter:analyze-jtl', p),

  /* ---- 本地测试资产工作站：代码体检 / Git 影响面 / Allure / 十万级流式造数 ----
   * W1 只接线（通道契约见 docs/契约-本地测试资产工作站.md §2.2–§2.5）；
   * 入参一律原样转发、不在这里做默认值与 clamp（clamp 只在主进程，C-08）。
   * 本批不引入任何推送型通道，所以这里没有 on* 监听（C-50）。 */
  scanPickRoot: () => ipcRenderer.invoke('scan:pick-root'),
  scanRules: () => ipcRenderer.invoke('scan:rules'),
  scanRun: (opts) => ipcRenderer.invoke('scan:run', opts),
  scanCancel: (token) => ipcRenderer.invoke('scan:cancel', { token }),
  scanReveal: (payload) => ipcRenderer.invoke('scan:reveal', payload),
  gitProbe: (payload) => ipcRenderer.invoke('git:probe', payload),
  gitDiff: (payload) => ipcRenderer.invoke('git:diff', payload),
  allurePickDir: () => ipcRenderer.invoke('allure:pick-dir'),
  allureParse: (payload) => ipcRenderer.invoke('allure:parse', payload),
  tdgWriteStart: (payload) => ipcRenderer.invoke('tdg:write-start', payload),
  // rows 必须逐字传数组：拼接与转义在渲染层、分隔符在主进程 tdg-write.js，别在这里 join（C-68）
  tdgWriteAppend: (writerId, rows) => ipcRenderer.invoke('tdg:write-append', { writerId, rows }),
  tdgWriteFinish: (writerId) => ipcRenderer.invoke('tdg:write-finish', { writerId }),
  tdgWriteAbort: (writerId) => ipcRenderer.invoke('tdg:write-abort', { writerId }),
  // 运行输出（流式）：返回取消订阅函数
  // 应用日志（排障）
  dataLegacyInfo: () => ipcRenderer.invoke('data:legacy-info'),
  dataRecoverLegacy: () => ipcRenderer.invoke('data:recover-legacy'),
  appRelaunch: () => ipcRenderer.invoke('app:relaunch'),
  logInfo: () => ipcRenderer.invoke('log:info'),
  logOpen: () => ipcRenderer.invoke('log:open'),
  logTail: (lines) => ipcRenderer.invoke('log:tail', lines),
  logRenderer: (level, message) => ipcRenderer.invoke('log:renderer', { level, message }),

  // 应用内「有新版本」提示（替代系统通知）
  onUpdateAvailable: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onJmeterOutput: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('jmeter:output', handler);
    return () => ipcRenderer.removeListener('jmeter:output', handler);
  },
  onJmeterDone: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('jmeter:done', handler);
    return () => ipcRenderer.removeListener('jmeter:done', handler);
  },
});









