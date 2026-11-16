import React, { useState, useEffect } from 'react';
import type { PasswordEntry } from '../types';
import { useStore } from '../store/useStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { callIpc } from '../utils/ipc';
import { formatDateTime } from '../utils/time';

export function TrashPage() {
  const trash = useStore(s => s.trash);
  const setTrash = useStore(s => s.setTrash);
  const { toasts, addToast, removeToast } = useToast();
  const [items, setItems] = useState<PasswordEntry[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);
  /** 「彻底删除所选」的二次确认（不可恢复，必须单独一个确认框） */
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);

  useEffect(() => {
    loadTrash();
  }, []);

  const loadTrash = async () => {
    const r = await callIpc<PasswordEntry[]>(() => window.electronAPI.trashGetAll());
    if (!r.ok) { addToast(`读取回收站失败：${r.error}`, 'error'); return; }
    const list = r.data || [];
    setItems(list);
    setTrash(list);
    // 列表变了就把选中项收敛到仍然存在的那些，避免「选中了已消失的条目」
    setSelectedIds(prev => {
      const alive = new Set(list.map(i => i.id));
      const next = new Set(Array.from(prev).filter(id => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  };

  const handleRestore = async (ids: string[]) => {
    if (ids.length === 0) return;
    const r = await callIpc(() => window.electronAPI.trashRestore(ids));
    if (!r.ok) { addToast(`恢复失败：${r.error}`, 'error'); return; }
    addToast(`已恢复 ${ids.length} 个网址`, 'success');
    await loadTrash();
    // Refresh main entries too
    const entriesResult = await window.electronAPI.entriesGetAll();
    if (entriesResult.success && entriesResult.data) {
      useStore.getState().setVaultData(entriesResult.data);
    }
  };

  /**
   * 彻底删除所选（不是「清空回收站」）。
   *
   * 以前回收站只有「整站清空」和「恢复」两条路 —— 想删掉其中 3 条只能先全清空，
   * 或者一条条恢复再删。现在支持多选后精确删除。
   */
  const handlePurgeSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { setShowPurgeConfirm(false); return; }
    const r = await callIpc<PasswordEntry[]>(() => window.electronAPI.trashDelete(ids));
    if (!r.ok) {
      // 写盘失败必须报错，且不能假装删掉了
      addToast(`彻底删除失败：${r.error}`, 'error');
      setShowPurgeConfirm(false);
      return;
    }
    const remaining = r.data || [];
    setItems(remaining);
    setTrash(remaining);
    setSelectedIds(new Set());
    setShowPurgeConfirm(false);
    addToast(`已彻底删除 ${ids.length} 个网址`, 'success');
  };

  const handleEmptyTrash = async () => {
    const r = await callIpc(() => window.electronAPI.trashEmpty());
    if (!r.ok) {
      addToast(`清空回收站失败：${r.error}`, 'error');
      setShowEmptyConfirm(false);
      return;
    }
    setItems([]);
    setTrash([]);
    setSelectedIds(new Set());
    addToast('回收站已清空', 'success');
    setShowEmptyConfirm(false);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = items.length > 0 && selectedIds.size === items.length;

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
            <button className="btn btn-sm btn-danger" onClick={() => setShowPurgeConfirm(true)} disabled={selectedIds.size === 0}
              title="彻底删除选中的网址，不可恢复">
              彻底删除所选{selectedIds.size > 0 ? `（${selectedIds.size}）` : ''}
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
              <span className="text-sm text-muted">
                共 {items.length} 个网址{selectedIds.size > 0 ? ` · 已选 ${selectedIds.size} 个` : ''}
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => {
                if (allSelected) setSelectedIds(new Set());
                else setSelectedIds(new Set(items.map(i => i.id)));
              }}>
                {allSelected ? '取消全选' : '全选'}
              </button>
            </div>
            {items.map(item => (
              <div key={item.id} className="trash-item" style={{ opacity: selectedIds.has(item.id) ? 1 : 0.8 }}>
                <input type="checkbox" className="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} style={{ marginRight: 12 }} aria-label="选择此项" />
                <div className="trash-info">
                  <div className="trash-name">
                    {item.name}
                    <span className={`env-badge env-${item.envType}`} style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px' }}>
                      {envLabel[item.envType] || item.envType}
                    </span>
                  </div>
                  <div className="trash-meta">
                    {item.url} · 删除于 {item.deletedAt ? formatDateTime(item.deletedAt) : ''}
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

      <ConfirmDialog
        open={showPurgeConfirm}
        title="彻底删除所选网址"
        message={`确定要彻底删除选中的 ${selectedIds.size} 个网址吗？此操作不可恢复，删除后无法再从回收站找回。`}
        confirmText="彻底删除"
        variant="danger"
        onConfirm={handlePurgeSelected}
        onCancel={() => setShowPurgeConfirm(false)}
      />
    </>
  );
}
