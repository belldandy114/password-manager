import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from './store/useStore';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { TrashPage } from './pages/TrashPage';
import { ImportPage } from './pages/ImportPage';
import { ExportPage } from './pages/ExportPage';
import { Sidebar } from './components/Sidebar';
import { TagSidebar } from './components/TagSidebar';

function App() {
  const isLocked = useStore(s => s.isLocked);
  const isSetup = useStore(s => s.isSetup);
  const setLocked = useStore(s => s.setLocked);
  const setMasterPassword = useStore(s => s.setMasterPassword);
  const setIsSetup = useStore(s => s.setIsSetup);
  const setSettings = useStore(s => s.setSettings);
  const [currentPage, setCurrentPage] = useState('dashboard');
  const autoLockRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const lastActivityRef = useRef(Date.now());

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
    setLocked(true);
    setCurrentPage('dashboard');
  }, []);

  // Ref to always call the latest handleLock from intervals
  const handleLockRef = useRef(handleLock);
  handleLockRef.current = handleLock;

  // Auto-lock timer
  useEffect(() => {
    if (isLocked) return;

    // Read latest autoLockDelay from store on every check
    const checkLock = () => {
      const settings = useStore.getState().settings;
      const delayMs = settings.autoLockDelay * 60 * 1000;
      if (Date.now() - lastActivityRef.current >= delayMs) {
        handleLockRef.current();
      }
    };

    const resetAutoLock = () => {
      lastActivityRef.current = Date.now();
      window.electronAPI.sessionTouch();
    };

    autoLockRef.current = setInterval(checkLock, 10000);

    const handlers = ['click', 'keydown', 'mousemove', 'scroll'] as const;
    handlers.forEach(ev => document.addEventListener(ev, resetAutoLock));

    // Check immediately when user returns to the app (e.g. alt+tab back)
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

    // Parse a keybinding string like "Ctrl+Shift+L" into match criteria
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
        useStore.getState().signalNewEntry();
        setCurrentPage('dashboard');
        return;
      }

      // search
      const searchKeys = parseKeys(kb.search);
      if (searchKeys && ctrl === searchKeys.ctrl && shift === searchKeys.shift && pressedKey === searchKeys.key) {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>('.toolbar-search input');
        if (input) { input.focus(); input.select(); }
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
        setCurrentPage('trash');
        return;
      }

      // import
      const importKeys = parseKeys(kb.import);
      if (importKeys && ctrl === importKeys.ctrl && shift === importKeys.shift && pressedKey === importKeys.key) {
        e.preventDefault();
        setCurrentPage('import');
        return;
      }

      // export
      const exportKeys = parseKeys(kb.export);
      if (exportKeys && ctrl === exportKeys.ctrl && shift === exportKeys.shift && pressedKey === exportKeys.key) {
        e.preventDefault();
        setCurrentPage('export');
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isLocked]);

  // Check auth state on mount & apply theme
  useEffect(() => {
    (async () => {
      try {
        const setup = await window.electronAPI.authIsSetup();
        setIsSetup(setup);
        if (!setup) {
          setLocked(true);
        }
        // Load settings and apply theme
        const prefs = await window.electronAPI.settingsGet();
        if (prefs) {
          setSettings(prefs);
          document.documentElement.setAttribute('data-theme', prefs.theme || 'dark');
        }
      } catch {
        setLocked(true);
      }
    })();
  }, []);

  // Apply theme on change
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', useStore.getState().settings.theme || 'dark');
  }, [useStore(s => s.settings).theme]);

  // If locked or not set up, show login
  if (isLocked) {
    return <Login onLogin={handleLogin} />;
  }

  // Main app layout
  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard': return <Dashboard />;
      case 'settings': return <Settings />;
      case 'trash': return <TrashPage />;
      case 'import': return <ImportPage />;
      case 'export': return <ExportPage />;
      default: return <Dashboard />;
    }
  };

  return (
    <div className="app-layout">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} onLock={handleLock} />
      {currentPage === 'dashboard' && <TagSidebar />}
      <div className="main-content">
        {renderPage()}
      </div>
    </div>
  );
}

export default App;