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

  // 主题同步：子应用是独立的 Vue + Element Plus 应用，配色全靠这套变量。
  // 主应用把当前生效的设计令牌整体推过去（强调色 / 表面 / 线条 / 文字 / 密度），
  // 子应用不再写死颜色，换主题、换强调色、换密度都会立刻跟着变。
  useEffect(() => {
    /** 需要同步给子应用的设计令牌 */
    const TOKEN_KEYS = [
      '--accent', '--accent-hover', '--accent-soft', '--accent-line',
      '--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-inset', '--surface-selected',
      '--line-subtle', '--line', '--line-strong',
      '--text-1', '--text-2', '--text-3',
      '--ok', '--warn', '--bad', '--info',
      '--r-sm', '--r-md', '--r-lg',
      '--d-control-h', '--d-row-py', '--d-row-min', '--d-gap', '--d-panel-px', '--d-card-py',
      '--fs-2xs', '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg',
    ];

    const pushTheme = () => {
      const wv = webviewRef.current;
      if (!wv || typeof wv.executeJavaScript !== 'function') return;
      const root = document.documentElement;
      const dark = root.getAttribute('data-theme') === 'dark';
      const cs = getComputedStyle(root);
      const vars: Record<string, string> = {};
      for (const k of TOKEN_KEYS) {
        const v = cs.getPropertyValue(k).trim();
        if (v) vars[k] = v;
      }
      const js = `(() => {
        try {
          const root = document.documentElement;
          const vars = ${JSON.stringify(vars)};
          for (const k in vars) root.style.setProperty(k, vars[k]);
          if (typeof window.__pmSetTheme === 'function') {
            window.__pmSetTheme(${dark});
          } else {
            root.classList.toggle('dark', ${dark});
            const c = document.querySelector('.app-container');
            if (c) c.classList.toggle('dark', ${dark});
          }
          return true;
        } catch (e) { return String(e); }
      })()`;
      wv.executeJavaScript(js).catch(() => { /* webview 还没就绪，等下一次 */ });
    };

    const wv = webviewRef.current;
    const onReady = () => setTimeout(pushTheme, 60);
    if (wv) wv.addEventListener('dom-ready', onReady);

    // 主题 / 强调色 / 密度任一变化都要重推
    const mo = new MutationObserver(pushTheme);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'data-density', 'style'],
    });

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
