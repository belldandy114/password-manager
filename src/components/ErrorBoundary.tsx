import React from 'react';
import { logError } from '../utils/log';

interface Props { children: React.ReactNode }
interface State { error: Error | null }

/**
 * 渲染层兜底：之前任一组件抛错都会整页白屏且无任何提示。
 * 这里给出可读的降级页 + 重新加载入口，并把堆栈写进主进程 app.log。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logError('ErrorBoundary', error, info.componentStack?.slice(0, 400));
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <div className="app-error-card">
          <div className="app-error-title">页面出错了</div>
          <div className="app-error-desc">{this.state.error.message}</div>
          <div className="app-error-hint">
            数据保存在本地，重新加载即可继续；详细错误已写入应用日志（设置 → 关于 → 查看日志）。
          </div>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
