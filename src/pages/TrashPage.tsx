import React, { useState, useEffect } from 'react';
import type { PasswordEntry } from '../types';
import { useStore } from '../store/useStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';

export function TrashPage() {
  const trash = useStore(s => s.trash);
  const setTrash = useStore(s => s.setTrash);
  const { toasts, addToast, removeToast } = useToast();
  const [items, setItems] = useState<PasswordEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);

  useEffect(() => {
    loadTrash();
  }, []);

  const loadTrash = async () => {
    const result = await window.electronAPI.trashGetAll();
    if (result.success && result.data) {
      setItems(result.data);
      setTrash(result.data);
    }
  };

  const handleRestore = async (ids: string[]) => {
    const result = await window.electronAPI.trashRestore(ids);
    if (result.success) {
      addToast(`已恢复 ${ids.length} 个网址`, 'success');
      loadTrash();
      // Refresh main entries too
      const entriesResult = await window.electronAPI.entriesGetAll();
      if (entriesResult.success && entriesResult.data) {
        useStore.getState().setVaultData(entriesResult.data);
      }
    } else {
      addToast('恢复失败', 'error');
    }
  };

  const handleEmptyTrash = async () => {
    const result = await window.electronAPI.trashEmpty();
    if (result.success) {
      setItems([]);
      setTrash([]);
      addToast('回收站已清空', 'success');
    }
    setShowEmptyConfirm(false);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const envLabel: Record<string, string> = {
    production: '正式', testing: '测试', development: '开发', staging: '预发布',
  };

  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <div className="toolbar">
        <h3 style={{ flex: 1, margin: 0 }}>回收站</h3>
        <span className="text-muted text-sm">网址在回收站保留30天后自动清除</span>
        {items.length > 0 && (
          <>
            <button className="btn btn-sm btn-secondary" onClick={() => handleRestore(Array.from(selectedIds))} disabled={selectedIds.size === 0}>
              恢复所选
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => setShowEmptyConfirm(true)}>清空回收站</button>
          </>
        )}
      </div>

      <div className="content-area">
        {items.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            <h3>回收站为空</h3>
            <p>删除的网址会出现在这里，30天后自动清除</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-16">
              <span className="text-sm text-muted">共 {items.length} 个网址</span>
              <button className="btn btn-sm btn-ghost" onClick={() => {
                if (selectedIds.size === items.length) setSelectedIds(new Set());
                else setSelectedIds(new Set(items.map(i => i.id)));
              }}>
                {selectedIds.size === items.length ? '取消全选' : '全选'}
              </button>
            </div>
            {items.map(item => (
              <div key={item.id} className="trash-item" style={{ opacity: selectedIds.has(item.id) ? 1 : 0.8 }}>
                <input type="checkbox" className="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} style={{ marginRight: 12 }} />
                <div className="trash-info">
                  <div className="trash-name">
                    {item.name}
                    <span className={`env-badge env-${item.envType}`} style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px' }}>
                      {envLabel[item.envType] || item.envType}
                    </span>
                  </div>
                  <div className="trash-meta">
                    {item.url} · 删除于 {item.deletedAt ? new Date(item.deletedAt).toLocaleString('zh-CN') : ''}
                    {item.deletedAt && (() => {
                      const daysLeft = Math.ceil(30 - (Date.now() - new Date(item.deletedAt).getTime()) / (24*60*60*1000));
                      return ` · ${daysLeft > 0 ? `${daysLeft}天后自动清除` : '即将清除'}`;
                    })()}
                  </div>
                </div>
                <div className="trash-actions">
                  <button className="btn btn-sm btn-secondary" onClick={() => handleRestore([item.id])}>恢复</button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <ConfirmDialog
        open={showEmptyConfirm}
        title="清空回收站"
        message="确定要清空回收站吗？所有网址将被永久删除，此操作不可恢复！"
        confirmText="清空"
        variant="danger"
        onConfirm={handleEmptyTrash}
        onCancel={() => setShowEmptyConfirm(false)}
      />
    </>
  );
}
