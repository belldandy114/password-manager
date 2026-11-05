import React, { useEffect, useRef, useState } from 'react';

interface TdgPaths {
  distPath: string;
  preloadPath: string;
}

export function DataGenerator() {
  // webview 是 Electron 自定义元素，没有随项目引入 Electron 的类型声明
  const webviewRef = useRef<any>(null);
  const [tdgPaths, setTdgPaths] = useState<TdgPaths | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isDev = window.location.href.startsWith('http://');

  useEffect(() => {
    if (!isDev) {
      window.electronAPI.tdgGetPath().then((paths) => {
        setTdgPaths(paths);
      }).catch((err) => {
        setLoadError('无法获取子应用路径: ' + err);
      });
    }
  }, [isDev]);

  // Compute webview src – only when paths are ready
  const webviewSrc = isDev
    ? 'http://localhost:5174'
    : tdgPaths
      ? `file://${tdgPaths.distPath.replace(/\\/g, '/')}/index.html`
      : 'about:blank';

  // Preload path — only set when paths are known
  const preloadPath = isDev || !tdgPaths
    ? undefined
    : `file://${tdgPaths.preloadPath.replace(/\\/g, '/')}`;

  // Handle webview errors
  const handleWebviewError = () => {
    const wv = webviewRef.current;
    if (!wv) return;
    const handler = (e: any) => {
      setLoadError(`加载失败: ${e.errorDescription} (code=${e.errorCode})`);
    };
    wv.addEventListener('did-fail-load', handler);
    return () => wv.removeEventListener('did-fail-load', handler);
  };

  // 主题同步：子应用是独立的 Vue 应用，主题得由宿主推进去
  // 1) webview dom-ready 后推一次；2) 主应用切换主题（html[data-theme] 变化）时再推
  useEffect(() => {
    const pushTheme = () => {
      const wv = webviewRef.current;
      if (!wv || typeof wv.executeJavaScript !== 'function') return;
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const js = `(() => {
        try {
          if (typeof window.__pmSetTheme === 'function') { window.__pmSetTheme(${dark}); return true; }
          if (typeof window.__pmApplyThemeClasses === 'function') { window.__pmApplyThemeClasses(${dark}); return true; }
          // 老版本子应用：直接写 localStorage + class，至少视觉一致
          try { localStorage.setItem('tdg-dark', '${dark}'); } catch (e) {}
          document.documentElement.classList.toggle('dark', ${dark});
          const c = document.querySelector('.app-container'); if (c) c.classList.toggle('dark', ${dark});
          return true;
        } catch (e) { return String(e); }
      })()`;
      wv.executeJavaScript(js).catch(() => { /* webview 还没就绪，等下一次 */ });
    };

    const wv = webviewRef.current;
    const onReady = () => setTimeout(pushTheme, 60);
    if (wv) wv.addEventListener('dom-ready', onReady);

    // 主题切换：观察 html[data-theme]
    const mo = new MutationObserver(pushTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      if (wv) wv.removeEventListener('dom-ready', onReady);
      mo.disconnect();
    };
  }, [tdgPaths]);
  useEffect(() => {
    handleWebviewError();
  }, [tdgPaths]);

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--bg-primary)',
    }}>
      {isDev && (
        <div style={{
          padding: '8px 16px',
          background: 'var(--bg-secondary)',
          color: 'var(--warning)',
          fontSize: '13px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 600 }}>⚡ 开发模式</span>
          <span style={{ color: 'var(--text-muted)' }}>— 生成测试数据运行在 http://localhost:5174</span>
        </div>
      )}

      {loadError && (
        <div style={{
          padding: '32px',
          color: 'var(--danger)',
          textAlign: 'center',
          fontSize: '14px',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
          <div>{loadError}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
            {isDev ? '请确保子应用开发服务器已在端口 5174 启动' : '文件可能未正确打包'}
          </div>
        </div>
      )}

      {!isDev && !tdgPaths && !loadError && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-muted)',
          fontSize: '14px',
        }}>
          加载中...
        </div>
      )}

      {(isDev || tdgPaths) && !loadError && (
        <webview
          ref={webviewRef}
          src={webviewSrc}
          preload={preloadPath}
          style={{
            flex: 1,
            width: '100%',
            height: '100%',
            display: 'flex',
          }}
        />
      )}
    </div>
  );
}
