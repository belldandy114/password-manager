import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { PaletteApp } from './components/PaletteApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { logError } from './utils/log';
import './styles/tokens.css';
import './styles/global.css';
import './styles/pages.css';
import './styles/redesign.css';

window.addEventListener('error', (e) => logError('window.error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logError('unhandledrejection', e.reason));

// 独立快速搜索小窗（Ctrl+空格）：同一个产物，只渲染命令面板本身
const isPaletteWindow = new URLSearchParams(window.location.search).get('window') === 'palette';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isPaletteWindow ? <PaletteApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
