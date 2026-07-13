import React, { useEffect, useRef, useState } from 'react';

interface TdgPaths {
  distPath: string;
  preloadPath: string;
}

export function DataGenerator() {
  const webviewRef = useRef<Electron.WebviewTag>(null);
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
          allowpopups="false"
        />
      )}
    </div>
  );
}
