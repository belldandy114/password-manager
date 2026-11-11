import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { PaletteApp } from './components/PaletteApp';
import { QuickNoteApp } from './QuickNoteApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { logError } from './utils/log';
import './styles/tokens.css';
import './styles/global.css';
import './styles/pages.css';
import './styles/redesign.css';

window.addEventListener('error', (e) => logError('window.error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logError('unhandledrejection', e.reason));

// 文件被拖到窗口空白处时，Electron 默认会导航到 file://（相当于把应用"变成"那个文件）。
// 全局兜住 drag/drop 的默认行为，真正的接收逻辑交给各页面自己的 drop zone。
['dragover', 'drop'].forEach(type => {
  window.addEventListener(type, (e) => { e.preventDefault(); }, false);
});

// 独立快速搜索小窗（Ctrl+空格）：同一个产物，只渲染命令面板本身
const params = new URLSearchParams(window.location.search);
const isPaletteWindow = params.get('window') === 'palette';
// 随手记小窗（Ctrl+Shift+N）：同一个产物，只渲染小记事本
const isQuickNoteWindow = params.get('window') === 'quicknote';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isPaletteWindow ? <PaletteApp /> : isQuickNoteWindow ? <QuickNoteApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
