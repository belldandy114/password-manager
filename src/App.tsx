import React, { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from './store/useStore';
import { Login } from './pages/Login';
import { Sidebar } from './components/Sidebar';
import { CommandPalette } from './components/CommandPalette';
import { NoticeCenter } from './components/NoticeCenter';
import { UpdateDialog } from './components/UpdateDialog';
import { applyTheme, watchSystemTheme, applyAccent, applyDensity } from './utils/theme';
import { guessUrlFromInput } from './utils/urlInput';
import { recordPageUse } from './utils/recent';
import { useEnvAutoProbe } from './utils/envSchedule';

/**
 * 工作台页面按需加载：首屏只装登录 + 侧边栏，
 * 点哪个页面才去拉哪个页面的 chunk（否则主 bundle 700KB+，冷启动要等）。
 * 登录页保持同步引入——它是启动必经之路，拆出去只会多一次往返。
 */
const PasswordManagerPage = lazy(() => import('./pages/PasswordManagerPage').then(m => ({ default: m.PasswordManagerPage })));
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })));
const DataGenerator = lazy(() => import('./pages/DataGenerator').then(m => ({ default: m.DataGenerator })));
const Toolbox = lazy(() => import('./pages/Toolbox').then(m => ({ default: m.Toolbox })));
const Accounts = lazy(() => import('./pages/Accounts').then(m => ({ default: m.Accounts })));
const Environments = lazy(() => import('./pages/Environments').then(m => ({ default: m.Environments })));
const WeeklyReport = lazy(() => import('./pages/WeeklyReport').then(m => ({ default: m.WeeklyReport })));
const Snippets = lazy(() => import('./pages/Snippets').then(m => ({ default: m.Snippets })));
const Notes = lazy(() => import('./pages/Notes').then(m => ({ default: m.Notes })));
const Attachments = lazy(() => import('./pages/Attachments').then(m => ({ default: m.Attachments })));
const ZentaoPage = lazy(() => import('./pages/ZentaoPage').then(m => ({ default: m.ZentaoPage })));
const ApiClient = lazy(() => import('./pages/ApiClient').then(m => ({ default: m.ApiClient })));
const PerfTest = lazy(() => import('./pages/PerfTest').then(m => ({ default: m.PerfTest })));
const CodeLab = lazy(() => import('./pages/CodeLab').then(m => ({ default: m.CodeLab })));

function App() {
  const isLocked = useStore(s => s.isLocked);
  const isSetup = useStore(s => s.isSetup);
  const setLocked = useStore(s => s.setLocked);
  const setMasterPassword = useStore(s => s.setMasterPassword);
  const setIsSetup = useStore(s => s.setIsSetup);
  const setSettings = useStore(s => s.setSettings);
  const setPmSubPage = useStore(s => s.setPmSubPage);
  const [currentPage, setCurrentPage] = useState('passwordManager');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
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
    setCurrentPage('passwordManager');
  }, []);

  // Ref to always call the latest handleLock from intervals
  const handleLockRef = useRef(handleLock);
  handleLockRef.current = handleLock;

  // 环境矩阵定时巡检：间隔与「只在翻转时通知」都在设置页「定时任务」里改
  const autoProbeInterval = useStore(s => s.settings.envProbeInterval || 0);
  const autoProbeNotify = useStore(s => s.settings.envProbeNotifyOnFlip !== false);
  useEnvAutoProbe(autoProbeInterval, autoProbeNotify, !isLocked);

  // 点系统通知时主进程要求跳页
  useEffect(() => window.electronAPI.onAppNavigate?.((p) => {
    if (p && p.page) setCurrentPage(p.page);
  }), []);

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

  // 解锁后回到上次停留的页面
  useEffect(() => {
    if (isLocked) return;
    const saved = useStore.getState().settings.lastPage;
    if (saved && saved !== 'passwordManager') setCurrentPage(saved);
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

  // 测试数据子应用（webview）保活：切走只隐藏，不卸载
  // 首次进入立即挂载；之后在解锁空闲 3 秒时预热，点进去时已经就绪
  // 注意：这些 hooks 必须在下面的 `if (isLocked) return` 之前，否则锁定/解锁切换时
  // hooks 数量会变化，触发 React error #310。
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
        case 'entry': setCurrentPage('passwordManager'); st.setPmSubPage('dashboard'); st.setSearchQuery(item.title || ''); break;
        case 'snippet': setCurrentPage('snippets'); break;
        case 'note': setCurrentPage('notes'); break;
        case 'account': setCurrentPage('accounts'); break;
        case 'request': setCurrentPage('apiClient'); st.signalCmd(`api:open:${arg}`); break;
        case 'checklist': setCurrentPage('checklists'); break;
        case 'env': setCurrentPage('environments'); break;
        case 'paste':
          // 快速搜索小窗里粘贴后的动作：原文经 item.text 带过来，这里落到对应页面
          if (arg === 'sql') { setCurrentPage('snippets'); st.seedSnippet(String(item.text || '')); }
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
          else if (arg === 'weekly-draft') { setCurrentPage('weeklyReport'); st.signalCmd('weekly:draft'); }
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
  // 测试数据子应用把生成结果发过来：切到接口调试，并把值交给它填进请求体
  useEffect(() => {
    const off = window.electronAPI.onTdgToApi?.((payload) => {
      if (!payload || !Array.isArray(payload.values) || payload.values.length === 0) return;
      if (useStore.getState().isLocked) return;
      useStore.getState().seedApiBody(payload.values);
      setCurrentPage('apiClient');
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

  const [tdgMounted, setTdgMounted] = useState(false);
  useEffect(() => {
    if (currentPage === 'dataGenerator') { setTdgMounted(true); return; }
    if (isLocked || tdgMounted) return;
    const t = setTimeout(() => setTdgMounted(true), 3000);
    return () => clearTimeout(t);
  }, [currentPage, isLocked, tdgMounted]);

  // If locked or not set up, show login
  if (isLocked) {
    return <Login onLogin={handleLogin} />;
  }

  // Main app layout
  const renderPage = () => {
    switch (currentPage) {
      case 'passwordManager': return <PasswordManagerPage />;
      case 'settings': return <Settings />;
      // 1.11.0：JSON 转化已并入工具箱，老用户上次停在这一页也能平滑落到工具箱
      case 'jsonConverter': return <Toolbox />;
      case 'toolbox': return <Toolbox />;
      case 'accounts': return <Accounts />;
    case 'environments': return <Environments />;
      case 'weeklyReport': return <WeeklyReport />;
      case 'snippets': return <Snippets />;
      case 'notes': return <Notes />;
      case 'attachments': return <Attachments />;
      case 'zentao': return <ZentaoPage />;
      case 'apiClient': return <ApiClient />;
      case 'perfTest': return <PerfTest />;
    case 'codeLab': return <CodeLab />;
      default: return <PasswordManagerPage />;
    }
  };

  return (
    <div className="app-layout">
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
        {/* 每个页面自己是独立 chunk：切换时只挂一个局部 loading，不牵连保活的子应用 */}
        {currentPage !== 'dataGenerator' && (
          <Suspense fallback={<div className="page-loading">正在加载…</div>}>
            {renderPage()}
          </Suspense>
        )}
        {tdgMounted && (
          <div className="keepalive-host" style={{ display: currentPage === 'dataGenerator' ? 'flex' : 'none' }}>
            <Suspense fallback={null}>
              <DataGenerator />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
