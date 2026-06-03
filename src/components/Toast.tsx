import React from 'react';
import type { Toast } from '../hooks/useToast';

interface Props {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

const icons: Record<string, string> = {
  success: '✓',
  error: '✗',
  info: 'ℹ',
};

export function ToastContainer({ toasts, onRemove }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => onRemove(t.id)}>
          <span>{icons[t.type]}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
