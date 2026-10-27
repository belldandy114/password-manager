import React, { useCallback, useEffect, useState } from 'react';
import type { WorkspaceKey } from '../types';
import { useStore } from '../store/useStore';

interface WithId { id: string }

/** 统一读写 vault 里的集合（snippets / notes / …），保存即落盘加密 */
export function useCollection<T extends WithId>(key: WorkspaceKey) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const res = await window.electronAPI.wsGet(key);
    if (res.success && Array.isArray(res.data)) setItems(res.data as T[]);
    setLoading(false);
  }, [key]);

  useEffect(() => { reload(); }, [reload]);

  /** 返回主进程的结果，页面可以据此提示「保存失败」 */
  const save = useCallback(async (next: T[]) => {
    setItems(next);
    return await window.electronAPI.wsSet(key, next);
  }, [key]);

  return { items, save, loading, reload };
}

/** 页面头部：标题 + 说明 + 右侧操作 */
export function PageHeader({ title, desc, children }: { title: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="module-header">
      <div>
        <h2>{title}</h2>
        {desc && <div className="module-desc">{desc}</div>}
      </div>
      <div className="module-actions">{children}</div>
    </div>
  );
}

/** 空状态 */
export function EmptyHint({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="module-empty">
      <div>{text}</div>
      {action}
    </div>
  );
}

/** 复制到剪贴板（不触发剪贴板自动清空，用于普通文本） */
export function copyPlain(text: string) {
  navigator.clipboard.writeText(text);
}

/** 短提示 */
export function useHint() {
  const [hint, setHint] = useState('');
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(''), 1800);
    return () => clearTimeout(t);
  }, [hint]);
  return { hint, setHint, node: hint ? <div className="inline-hint">{hint}</div> : null };
}

/** 全局设置（主题等）需要的 store 快捷引用 */
export const useSettings = () => useStore(s => s.settings);
