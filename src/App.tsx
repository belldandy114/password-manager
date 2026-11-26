import React, { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from './store/useStore';
import { Login } from './pages/Login';
import { PAGE_LOADERS } from './pages/loaders';
import { PageSkeleton } from './components/PageSkeleton';
import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { NoticeCenter } from './components/NoticeCenter';
import { Modal } from './components/Modal';
import { UpdateDialog } from './components/UpdateDialog';
import { applyTheme, watchSystemTheme, applyAccent, applyDensity } from './utils/theme';
import { BackgroundLayer } from './components/BackgroundLayer';
import { guessUrlFromInput } from './utils/urlInput';
import { recordPageUse } from './utils/recent';
import { useEnvAutoProbe } from './utils/envSchedule';
import { useRegressionScheduler } from './hooks/useRegressionScheduler';

/**
 * 工作台页面按需加载：首屏只装登录 + 侧边栏，
 * 点哪个页面才去拉哪个页面的 chunk（否则主 bundle 700KB+，冷启动要等）。
 * 登录页保持同步引入——它是启动必经之路，拆出去只会多一次往返。
 */
const Home = lazy(PAGE_LOADERS.home);
const PasswordManagerPage = lazy(PAGE_LOADERS.passwordManager);
const Settings = lazy(PAGE_LOADERS.settings);
const DataGenerator = lazy(PAGE_LOADERS.dataGenerator);
const Toolbox = lazy(PAGE_LOADERS.toolbox);
const Environments = lazy(PAGE_LOADERS.environments);
// 1.30.1：notes / attachments 两个 loader 都指向合并页 NotesAttachments，
// 别名跟着改成真实组件名，避免读代码时以为这里还是单页的 Notes
const NotesAttachments = lazy(PAGE_LOADERS.notes);
const ZentaoPage = lazy(PAGE_LOADERS.zentao);
const ApiClient = lazy(PAGE_LOADERS.apiClient);
const PerfTest = lazy(PAGE_LOADERS.perfTest);
const CodeLab = lazy(PAGE_LOADERS.codeLab);
const Cases = lazy(PAGE_LOADERS.cases);
// 1.30.2：SQL 片段从笔记页拆成独立页。页面载入表（pages/loaders.ts）本轮不在改动范围内，
// 所以这里直接给 import 路径；补进 loaders 之后侧栏的悬停预取才生效（功能不受影响，
// 点开时 lazy 会自己 import，只是少了预取那一次预热）。
const SqlSnippets = lazy(PAGE_LOADERS.sqlSnippets);
// 1.33.0：本地测试资产工作站 4 个新页（开发辅助分组）。和其它页一样从 PAGE_LOADERS 取，
// 这样侧栏悬停预取才指向同一份 import 路径；写成 `lazy(() => import('./CodeGen'))` 就没有预取了。
const CodeGen = lazy(PAGE_LOADERS.codeGen);
const CodeAudit = lazy(PAGE_LOADERS.codeAudit);
// 1.34.0：UI 录制器（S4b）。与其它页一样从 PAGE_LOADERS 取 —— 侧栏悬停预取才指向同一份 import。
const Recorder = lazy(PAGE_LOADERS.recorder);

function App() {
  const isLocked = useStore(s => s.isLocked);
  const isSetup = useStore(s => s.isSetup);
  const setLocked = useStore(s => s.setLocked);
  const setMasterPassword = useStore(s => s.setMasterPassword);
  const setIsSetup = useStore(s => s.setIsSetup);
  const setSettings = useStore(s => s.setSettings);
  const setPmSubPage = useStore(s => s.setPmSubPage);
  const [currentPage, setCurrentPage] = useState('home');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  /** 首次启动用例库引导：没配置过就弹一次，可「稍后再说」 */
  const [casesSetup, setCasesSetup] = useState(false);
  const autoLockRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const lastActivityRef = useRef(Date.now());
  // 锁定时会把页面切回主页，那次切换不应该覆盖「上次停留页面」
  const skipLastPageSaveRef = useRef(false);
  // 页面内按钮请求跳页（如接口调试「去工具箱」）
  const navigateTo = useStore(s => s.navigateTo);
  const consumeNavigate = useStore(s => s.consumeNavigate);
  useEffect(() => {
    if (!navigateTo) return;
    setCurrentPage(navigateTo);
    consumeNavigate();
  }, [navigateTo, consumeNavigate]);

  // 解锁后检查一次用例库配置：没配过就引导选目录（本次运行只问一次，用户可稍后再说）
  const casesPromptedRef = useRef(false);
  useEffect(() => {
    if (isLocked || casesPromptedRef.current) return;
    casesPromptedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const r = await window.electronAPI.casesConfig();
        if (!alive || !r.success || !r.data) return;
        if (!r.data.configured) setCasesSetup(true);
      } catch { /* 主进程没起来时静默，不影响登录 */ }
    })();
    return () => { alive = false; };
  }, [isLocked]);

  // Handle login success
  const handleLogin = useCallback(async () => {
    try {
      const result = await window.electronAPI.sessionUnlock({
        password: useStore.getState().masterPassword
      });
      if (result.success && result.data) {
        useStore.getState().setVaultData(result.data);
        setLocked(false);
        setIsSetup(true);
        // Load settings
        const prefs = await window.electronAPI.settingsGet();
        if (prefs) setSettings(prefs);
      }
    } catch (e) {
      console.error('Login error:', e);
    }
  }, []);

  // Handle lock
  const handleLock = useCallback(async () => {
    await window.electronAPI.sessionLock();
    setMasterPassword('');
    // 清掉渲染层内存中的明文，锁定后不可再从 DevTools / 内存里翻到
    const st = useStore.getState();
    st.setVaultData({ entries: [], tags: [] });
    st.setTrash([]);
    st.setSearchQuery('');
    st.clearSelected();
    setLocked(true);
    skipLastPageSaveRef.current = true;
    // 锁定时回到今日工作台（1.25.0 起的落地页），下次解锁也从这里开始
    setCurrentPage('home');
  }, []);

  // Ref to always call the latest handleLock from intervals
  const handleLockRef = useRef(handleLock);
  handleLockRef.current = handleLock;

  // 环境矩阵定时巡检：间隔与「只在翻转时通知」都在设置页「定时任务」里改
  const autoProbeInterval = useStore(s => s.settings.envProbeInterval || 0);
  const autoProbeNotify = useStore(s => s.settings.envProbeNotifyOnFlip !== false);
  useEnvAutoProbe(autoProbeInterval, autoProbeNotify, !isLocked);

  // 接口回归定时：解锁后才跑，错过的会在解锁瞬间补跑一次
  useRegressionScheduler(!isLocked);

  // 点系统通知时主进程要求跳页
  useEffect(() => window.electronAPI.onAppNavigate?.((p) => {
    if (p && p.page) setCurrentPage(p.page);
  }), []);

  /**
   * 录制事件（S4b）：**全应用只订一次**，卸载时退订。
   *
   * 为什么不挂在录制页里：录制页是 lazy 挂载的，切页就卸载；页面里订阅 + 退订稍有不慎
   * 就会在「切页 → 回来」时留下第二条通道，事件翻倍——单页面操作根本看不出来。
   * 放这里还顺带解决「录制中切到别的页面，动作不丢」：事件照样进 store 的草稿。
   */
  useEffect(() => {
    const off = window.electronAPI.onRecordEvent?.((event) => {
      useStore.getState().recorderPushEvent(event);
    });
    return () => { try { off?.(); } catch { /* 窗口已关 */ } };
  }, []);

  // Auto-lock timer
  useEffect(() => {
    if (isLocked) return;

    const checkLock = () => {
      const settings = useStore.getState().settings;
      const delayMs = settings.autoLockDelay * 60 * 1000;
      if (Date.now() - lastActivityRef.current >= delayMs) {
        handleLockRef.current();
      }
    };

    let lastTouchSentAt = 0;
    const resetAutoLock = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      // mousemove/scroll fire dozens of times per second — only tell the main process
      // once every 5s instead of flooding it with IPC round-trips.
      if (now - lastTouchSentAt < 5000) return;
      lastTouchSentAt = now;
      window.electronAPI.sessionTouch();
    };

    autoLockRef.current = setInterval(checkLock, 10000);

    const handlers = ['click', 'keydown', 'mousemove', 'scroll'] as const;
    handlers.forEach(ev => document.addEventListener(ev, resetAutoLock));

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (autoLockRef.current) clearInterval(autoLockRef.current);
      handlers.forEach(ev => document.removeEventListener(ev, resetAutoLock));
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isLocked, handleLock]);

  // Keyboard shortcuts (only when unlocked) — reads from settings.keybindings
  useEffect(() => {
    if (isLocked) return;

    const parseKeys = (keys: string): { ctrl: boolean; shift: boolean; key: string } | null => {
      const parts = keys.split('+');
      let ctrl = false;
      let shift = false;
      let key = '';
      for (const p of parts) {
        if (p === 'Ctrl' || p === 'Cmd') ctrl = true;
        else if (p === 'Shift') shift = true;
        else key = p.toLowerCase();
      }
      if (!key) return null;
      return { ctrl, shift, key };
    };

    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const pressedKey = e.key === ',' ? ',' : e.key.toLowerCase();

      // 全局命令面板：Ctrl+K / Cmd+K
      if (ctrl && !shift && pressedKey === 'k') {
        e.preventDefault();
        setCmdkOpen(v => !v);
        return;
      }

      const kb = useStore.getState().settings.keybindings;
      if (!kb) return;

      // newEntry
      const newEntryKeys = parseKeys(kb.newEntry);
      if (newEntryKeys && ctrl === newEntryKeys.ctrl && shift === newEntryKeys.shift && pressedKey === newEntryKeys.key) {
        e.preventDefault();
        setCurrentPage('passwordManager');
        useStore.getState().signalNewEntry();
        useStore.getState().setPmSubPage('dashboard');
        return;
      }

      // search
      const searchKeys = parseKeys(kb.search);
      if (searchKeys && ctrl === searchKeys.ctrl && shift === searchKeys.shift && pressedKey === searchKeys.key) {
        e.preventDefault();
        setCurrentPage('passwordManager');
        useStore.getState().setPmSubPage('dashboard');
        // Focus search input after switching
        setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('.toolbar-search input');
          if (input) { input.focus(); input.select(); }
        }, 50);
        return;
      }

      // settings
      const settingsKeys = parseKeys(kb.settings);
      if (settingsKeys && ctrl === settingsKeys.ctrl && shift === settingsKeys.shift && pressedKey === settingsKeys.key) {
        e.preventDefault();
        setCurrentPage('settings');
        return;
      }

      // lock
      const lockKeys = parseKeys(kb.lock);
      if (lockKeys && ctrl === lockKeys.ctrl && shift === lockKeys.shift && pressedKey === lockKeys.key) {
        e.preventDefault();
        handleLockRef.current();
        return;
      }

      // trash
      const trashKeys = parseKeys(kb.trash);
      if (trashKeys && ctrl === trashKeys.ctrl && shift === trashKeys.shift && pressedKey === trashKeys.key) {
        e.preventDefault();
        setCurrentPage('passwordManager');
        useStore.getState().setPmSubPage('trash');
        return;
      }

      // import
      const importKeys = parseKeys(kb.import);
      if (importKeys && ctrl === importKeys.ctrl && shift === importKeys.shift && pressedKey === importKeys.key) {
        e.preventDefault();
        setCurrentPage('passwordManager');
        useStore.getState().setPmSubPage('import');
        return;
      }

      // export
      const exportKeys = parseKeys(kb.export);
      if (exportKeys && ctrl === exportKeys.ctrl && shift === exportKeys.shift && pressedKey === exportKeys.key) {
        e.preventDefault();
        setCurrentPage('passwordManager');
        useStore.getState().setPmSubPage('export');
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isLocked]);

  // 系统通知「有新 Bug」→ 跳到禅道页
  useEffect(() => {
    const off = window.electronAPI.onZentaoOpen?.(() => setCurrentPage('zentao'));
    return off;
  }, []);

  // Tray menu → 锁定（窗口可能处于隐藏/后台状态，锁定时不需要弹窗）
  useEffect(() => {
    const off = window.electronAPI.onLockRequest(() => {
      handleLockRef.current();
    });
    return off;
  }, []);

  // Check auth state on mount & apply theme
  useEffect(() => {
    (async () => {
      try {
        const setup = await window.electronAPI.authIsSetup();
        setIsSetup(setup);
        if (!setup) {
          setLocked(true);
        }
        const prefs = await window.electronAPI.settingsGet();
        if (prefs) {
          setSettings(prefs);
          applyTheme(prefs.theme);
          applyAccent(prefs.accent);
          applyDensity(prefs.density);
        }
      } catch {
        setLocked(true);
      }
    })();
  }, []);

  // Apply theme on change (支持 dark / light / system)
  const themeMode = useStore(s => s.settings.theme);

  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [themeMode]);

  // 强调色
  const accentColor = useStore(s => s.settings.accent);
  useEffect(() => { applyAccent(accentColor); }, [accentColor]);

  // 密度三档
  const density = useStore(s => s.settings.density);
  useEffect(() => { applyDensity(density); }, [density]);

  // 解锁后固定落在「工作台」（1.29.0 起不再恢复上次页面）
  useEffect(() => {
    if (isLocked) return;
    // 以前会读 settings.lastPage 恢复上次停留的页面，结果是「重启后还在某个二级页」，
    // 用户反馈每次都要自己点回工作台。现在统一落在工作台；lastPage 仍照常记录，
    // 只是不再用于启动跳转（以后要做「继续上次」设置项时还有数据）。
    setCurrentPage('home');
  }, [isLocked]);

  // 记住当前页面（600ms 节流）
  useEffect(() => {
    if (isLocked) return;
    if (skipLastPageSaveRef.current) { skipLastPageSaveRef.current = false; return; }
    // 顺带记一次页面使用次数：命令面板按常用度排序要靠它
    recordPageUse(currentPage);
    const t = setTimeout(() => {
      window.electronAPI.settingsSave({ lastPage: currentPage });
    }, 600);
    return () => clearTimeout(t);
  }, [currentPage, isLocked]);

  // 启动检查发现新版本：在应用内横向提示条里告知（不再弹 Windows 系统通知）
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; current: string; url: string; notes?: string; downloadUrl?: string; assetName?: string; digest?: string } | null>(null);
  // 更新弹窗：点横幅上的「去更新」直接在这里看说明 + 下载 + 安装，不再跳设置页
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);

  // 快速搜索小窗把选中的命令转发过来：在主窗口里落地（导航 / 填搜索词 / 锁定…）
  useEffect(() => {
    const off = window.electronAPI.onPaletteRun?.((item) => {
      if (!item || !item.id) return;
      if (useStore.getState().isLocked) return;
      const [kind, ...rest] = item.id.split(':');
      const arg = rest.join(':');
      const st = useStore.getState();
      switch (kind) {
        case 'page': setCurrentPage(arg); break;
        case 'toolbox': st.openToolboxTool(arg); setCurrentPage('toolbox'); break;
        // 搜索里选中某个测试数据类型：先把类型写进 store，页面挂载后自己消费
        case 'data': st.seedDataGenerator(arg); setCurrentPage('dataGenerator'); break;
        case 'entry': setCurrentPage('passwordManager'); st.setPmSubPage('dashboard'); st.setSearchQuery(item.title || ''); break;
        case 'snippet': setCurrentPage('notes'); break;
        case 'note': setCurrentPage('notes'); break;
        case 'account': {
          // 账号挂在网址条目上：落到网址管理，并按条目名筛出来
          const entryName = String(item.title || '').split(' · ')[0];
          setCurrentPage('passwordManager');
          st.setPmSubPage('dashboard');
          if (entryName) st.setSearchQuery(entryName);
          break;
        }
        case 'request': setCurrentPage('apiClient'); st.signalCmd(`api:open:${arg}`); break;
        // 「用例」没有页面（vault 的 checklists 无写入方）：直接忽略，别再跳到不存在的路由
        case 'checklist': break;
        case 'env': setCurrentPage('environments'); break;
        // 1.24.7：搜索小窗补齐的集合
        case 'integration':
        case 'ztpreset': setCurrentPage('zentao'); break;
        case 'apienv':
        case 'regression':
        case 'regrun': setCurrentPage('apiClient'); break;
        case 'paste':
          // 快速搜索小窗里粘贴后的动作：原文经 item.text 带过来，这里落到对应页面
          if (arg === 'sql') { setCurrentPage('sqlSnippets'); st.seedSnippet(String(item.text || '')); }
          else if (arg === 'json') { setCurrentPage('apiClient'); st.seedApiBodyText(String(item.text || '')); }
          else if (arg === 'log' || arg === 'accesslog') { st.openToolboxTool('log', String(item.text || '')); setCurrentPage('toolbox'); }
          else if (arg === 'jwt') { st.openToolboxTool('jwt', String(item.text || '')); setCurrentPage('toolbox'); }
          else if (arg === 'url') {
            const guess = guessUrlFromInput(String(item.text || item.title || ''));
            setCurrentPage('passwordManager');
            st.setPmSubPage('dashboard');
            st.signalNewEntry(guess ? { url: guess.url, name: guess.name } : { url: String(item.text || '') });
          }
          break;
        case 'action':
          if (arg === 'new-entry') { setCurrentPage('passwordManager'); st.setPmSubPage('dashboard'); st.signalNewEntry(); }
          else if (arg === 'new-entry-url') {
            // 快速搜索里没搜到 → 回车把输入当成网址，直接开新增弹窗并预填
            const guess = guessUrlFromInput(item.title || '');
            setCurrentPage('passwordManager');
            st.setPmSubPage('dashboard');
            st.signalNewEntry(guess
              ? { url: guess.url, name: guess.name }
              : { name: String(item.title || '').trim() });
          }
          else if (arg === 'lock') handleLockRef.current();
          else if (arg === 'zt-refresh') { setCurrentPage('zentao'); st.signalCmd('zentao:refresh-mine'); }
          else if (arg === 'zentao') setCurrentPage('zentao');
          else if (arg === 'api') setCurrentPage('apiClient');
          else if (arg === 'theme') {
            const next = st.settings.theme === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            st.updateSettings({ theme: next });
            void window.electronAPI.settingsSave({ theme: next });
          }
          break;
        default: break;
      }
    });
    return () => { try { off?.(); } catch { /* 忽略 */ } };
  }, []);
  // 窗口被隐藏时收起搜索面板，免得下次唤起看到上次没关的面板
  useEffect(() => {
    const off = window.electronAPI.onCloseCommandPalette?.(() => setCmdkOpen(false));
    return () => { try { off?.(); } catch { /* 忽略 */ } };
  }, []);
  useEffect(() => {
    const off = window.electronAPI.onUpdateAvailable((d) => {
      if (d && d.latest) {
        setUpdateInfo({
          latest: d.latest, current: d.current, url: d.url || '',
          notes: d.notes, downloadUrl: d.downloadUrl, assetName: d.assetName, digest: d.digest,
        });
      }
    });
    return () => { try { off(); } catch { /* 忽略 */ } };
  }, []);

  // If locked or not set up, show login
  if (isLocked) {
    return <Login onLogin={handleLogin} />;
  }

  // Main app layout
  const renderPage = () => {
    switch (currentPage) {
      // 1.25.0：工作台是新的落地页（聚合缺陷/环境/回归/备份/笔记，只读）
      case 'home': return <Home />;
      case 'passwordManager': return <PasswordManagerPage />;
      case 'settings': return <Settings />;
      // 1.11.0：JSON 转化已并入工具箱，老用户上次停在这一页也能平滑落到工具箱
      case 'jsonConverter': return <Toolbox />;
      case 'toolbox': return <Toolbox />;
      // 「测试账号」页已并入网址管理（账号就挂在条目上）。老用户上次停在这一页时
      // 持久化的 currentPage 还是 accounts，落到网址管理而不是白屏。
      case 'accounts': return <PasswordManagerPage />;
    case 'environments': return <Environments />;
      // 1.36.0（B2）：周报页下线（key / lazy 常量 / 这个 case / 命令面板入口同批删）。
      // 老用户持久化的 `currentPage='weeklyReport'` 落到 `default` 兜底的网址管理，不白屏
      // （与 1.30.1 的 `accounts`、B1 的 `resultHub` 同理）。
      // 1.30.2：SQL 片段重新独立成页（数据仍来自 notes 集合里 kind='sql' 的条目）。
      // 老路由 'snippets' 跟着改指向独立页 —— 数据源是同一批条目，落到笔记页会看不见它们。
      case 'snippets': return <SqlSnippets onNavigate={setCurrentPage} />;
      // 1.30.1：「测试笔记 + 附件管理」合并成一个菜单页，两个入口都落同一页，
      // 只是默认打开的页签不同（旧链接 / 首页快捷入口 / 条目里的「查看附件」都还能直达）。
      // 'notes' 是主入口：NotesAttachments 内部会恢复上次页签（localStorage）；
      // 'attachments' 是显式附件入口：一定落附件管理，不被记忆覆盖。
      case 'notes': return <NotesAttachments initialScope="notes" />;
      // 1.30.2：SQL 片段独立页（数据仍来自 notes 集合里 kind='sql' 的条目）
      case 'sqlSnippets': return <SqlSnippets onNavigate={setCurrentPage} />;
      case 'attachments': return <NotesAttachments initialScope="attachments" />;
      case 'zentao': return <ZentaoPage />;
      case 'dataGenerator': return <DataGenerator onNavigate={setCurrentPage} />;
      case 'apiClient': return <ApiClient />;
      case 'perfTest': return <PerfTest />;
    case 'codeLab': return <CodeLab />;
      case 'cases': return <Cases />;
      // 1.33.0：开发辅助 4 个新页（本批只有接线与空壳，页面内是「待实现（W2–W6）」）。
      // 这 4 个 case 与 pages/loaders.ts 的 4 个 key、侧栏 NavItem.id 逐字同名。
      // 1.36.0（B1）：结果中心下线（`.jtl` 指标已搬进压力测试页），`resultHub` 的 key / case /
      // 侧栏项 / 懒加载常量同批摘除；老用户持久化的 `currentPage='resultHub'` 落到 `default`
      // 兜底的网址管理（与 1.30.1 的 `accounts` 同理，不白屏）。
      case 'codeGen': return <CodeGen />;
      case 'codeAudit': return <CodeAudit />;
      // 1.36.0（B4）：资产台账下线（覆盖矩阵 / 用例映射的结论属一次性，方案 §11.1 判它该删）。
      // key / lazy 常量 / case / 侧栏项 / 命令面板条目同批摘除；老用户持久化的
      // `currentPage='assetLedger'` 落到 `default` 兜底的网址管理，不白屏（同 B1 的 resultHub）。
      // 1.34.0：UI 录制器。⚠️ 新增页面必须**同时**改三处：pages/loaders.ts 的 key、
      // 这里的 case、Sidebar.tsx 的 GROUPS 数组（NavItem.id）。
      // 只加前两处的表现是「路由有、入口没有」——页面永不可达，而且不报错，是最难发现的沉默缺口。
      case 'recorder': return <Recorder />;
      default: return <PasswordManagerPage />;
    }
  };

  return (
    <div className="app-layout">
      <BackgroundLayer />
      {/* 键盘用户从侧栏 13 个导航项跳到主内容不必逐个 Tab 过去；
          用 preventDefault 手动聚焦，纯锚点跳转在 SPA 里不会移走焦点 */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳到主内容
      </a>
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} onLock={handleLock} onNotices={() => setNoticeOpen(true)} />
      <NoticeCenter open={noticeOpen} onClose={() => setNoticeOpen(false)} onNavigate={setCurrentPage} />
      {/* 首次启动：用例库目录引导（只弹一次，之后可在用例库页「更改目录」） */}
      <Modal
        open={casesSetup}
        onClose={() => setCasesSetup(false)}
        title="先设置用例库目录"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setCasesSetup(false)}>稍后再说</button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                const r = await window.electronAPI.casesChooseRoot();
                if (r.success) {
                  setCasesSetup(false);
                  setCurrentPage('cases');
                }
              }}
            >
              选择目录
            </button>
          </>
        }
      >
        <p className="text-sm" style={{ lineHeight: 1.7, marginTop: 0 }}>
          用例库用来按「系统 / 模块」收纳 xmind、Excel、Markdown 用例文件，
          双击就用系统默认应用打开，应用内不编辑。
        </p>
        <p className="text-sm" style={{ lineHeight: 1.7 }}>
          建议选一个固定目录（例如 <code>D:\Test_Cases</code> 或云盘目录）。之后可以随时在
          「用例库 → 更改目录」里改，改的时候会自动迁移已有文件。
        </p>
        <p className="text-sm text-muted" style={{ lineHeight: 1.7, marginBottom: 0 }}>
          注意：用例库是明文目录，不像密码库那样加密。
        </p>
      </Modal>
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        onNavigate={setCurrentPage}
        onLock={handleLock}
      />
      <UpdateDialog
        open={updateDialogOpen}
        info={updateInfo}
        onClose={() => setUpdateDialogOpen(false)}
      />
      <div className="main-content" id="main-content" tabIndex={-1}>
        {/* 弹窗打开时收起横幅，避免和弹窗内容重复 */}
        {updateInfo && !updateDialogOpen && (
          <div className="update-banner" role="status">
            <span className="update-banner-dot" />
            <span className="update-banner-text">
              有新版本 <b>v{updateInfo.latest}</b>（当前 v{updateInfo.current}）
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setUpdateDialogOpen(true)}
              title="直接查看更新内容并下载安装，不用再去设置页"
            >
              去更新
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setUpdateInfo(null)}
              title="本次先不看了"
            >
              稍后
            </button>
          </div>
        )}
        {/* 每个页面自己是独立 chunk：切换时只挂一个局部 loading，不牵连其他页面 */}
        <Suspense fallback={<PageSkeleton />}>
          {renderPage()}
        </Suspense>
      </div>
    </div>
  );
}

export default App;






