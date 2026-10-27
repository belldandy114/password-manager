import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from './store/useStore';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { PasswordManagerPage } from './pages/PasswordManagerPage';
import { Sidebar } from './components/Sidebar';
import { DataGenerator } from './pages/DataGenerator';
import { JsonConverter } from './pages/JsonConverter';
import { Toolbox } from './pages/Toolbox';
import { Environments } from './pages/Environments';
import { Accounts } from './pages/Accounts';
import { Checklists } from './pages/Checklists';
import { Snippets } from './pages/Snippets';
import { Notes } from './pages/Notes';
import { ZentaoPage } from './pages/ZentaoPage';
import { ApiClient } from './pages/ApiClient';
import { applyTheme, watchSystemTheme, applyAccent } from './utils/theme';

function App() {
  const isLocked = useStore(s => s.isLocked);
  const isSetup = useStore(s => s.isSetup);
  const setLocked = useStore(s => s.setLocked);
  const setMasterPassword = useStore(s => s.setMasterPassword);
  const setIsSetup = useStore(s => s.setIsSetup);
  const setSettings = useStore(s => s.setSettings);
  const setPmSubPage = useStore(s => s.setPmSubPage);
  const [currentPage, setCurrentPage] = useState('passwordManager');
  const autoLockRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const lastActivityRef = useRef(Date.now());
  // 锁定时会把页面切回主页，那次切换不应该覆盖「上次停留页面」
  const skipLastPageSaveRef = useRef(false);

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
    const t = setTimeout(() => {
      window.electronAPI.settingsSave({ lastPage: currentPage });
    }, 600);
    return () => clearTimeout(t);
  }, [currentPage, isLocked]);

  // 测试数据子应用（webview）保活：切走只隐藏，不卸载
  // 首次进入立即挂载；之后在解锁空闲 3 秒时预热，点进去时已经就绪
  // 注意：这些 hooks 必须在下面的 `if (isLocked) return` 之前，否则锁定/解锁切换时
  // hooks 数量会变化，触发 React error #310。
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
      case 'jsonConverter': return <JsonConverter />;
      case 'toolbox': return <Toolbox />;
      case 'environments': return <Environments />;
      case 'accounts': return <Accounts />;
      case 'checklists': return <Checklists />;
      case 'snippets': return <Snippets />;
      case 'notes': return <Notes />;
      case 'zentao': return <ZentaoPage />;
      case 'apiClient': return <ApiClient />;
      default: return <PasswordManagerPage />;
    }
  };

  return (
    <div className="app-layout">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} onLock={handleLock} />
      <div className="main-content">
        {currentPage !== 'dataGenerator' && renderPage()}
        {tdgMounted && (
          <div className="keepalive-host" style={{ display: currentPage === 'dataGenerator' ? 'flex' : 'none' }}>
            <DataGenerator />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
