import React, { useCallback, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * 应用内确认弹窗（替代原生 window.confirm）
 *
 * 原生 confirm 在 Electron 里是系统对话框，样式与本应用完全不一致
 * （还会顶着一个 "password-manager" 标题），所以统一走这里。
 *
 * 用法：
 *   const { ask, confirmNode } = useConfirm();
 *   onClick={() => ask({ title: '删除片段', message: `确定删除「${s.title}」？`, onOk: () => remove(s) })}
 *   ...
 *   {confirmNode}
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** false = 主色按钮（非破坏性操作） */
  danger?: boolean;
  onOk: () => void | Promise<void>;
}

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);

  const ask = useCallback((next: ConfirmOptions) => setOpts(next), []);
  const close = useCallback(() => setOpts(null), []);

  const confirmNode = opts ? (
    <ConfirmDialog
      open
      title={opts.title}
      message={opts.message || ''}
      confirmText={opts.confirmText || '确定'}
      cancelText={opts.cancelText || '取消'}
      variant={opts.danger === false ? 'primary' : 'danger'}
      onCancel={close}
      onConfirm={() => {
        const run = opts.onOk;
        setOpts(null);
        void run();
      }}
    />
  ) : null;

  return { ask, confirmNode, close };
}
