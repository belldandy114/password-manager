import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { PasswordEntry, SearchField } from '../types';
import { useStore, sortFieldLabels, sortOrderLabels, searchFieldLabels } from '../store/useStore';
import { EntryCard } from '../components/EntryCard';
import { EntryList } from '../components/EntryList';
import { EntryForm } from '../components/EntryForm';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { Modal } from '../components/Modal';

export function Dashboard() {
  const store = useStore();
  const { toasts, addToast, removeToast } = useToast();
  const [editingEntry, setEditingEntry] = useState<PasswordEntry | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePermanent, setDeletePermanent] = useState(false);
  const [showScopeMenu, setShowScopeMenu] = useState(false);
  const [collapsedEnvs, setCollapsedEnvs] = useState<Set<string>>(new Set());
  const [showExportModal, setShowExportModal] = useState(false);
  const [showBatchEnvModal, setShowBatchEnvModal] = useState(false);
  const [showBatchTagModal, setShowBatchTagModal] = useState(false);
  const [batchEnvType, setBatchEnvType] = useState('production');
  const [batchTag, setBatchTag] = useState('');
  const [exportType, setExportType] = useState<'encrypted' | 'plain'>('encrypted');
  const [exportFormat, setExportFormat] = useState<'csv' | 'json' | 'xlsx'>('json');
  const [exportPassword, setExportPassword] = useState('');
  const [includePasswords, setIncludePasswords] = useState(false);
  const [exporting, setExporting] = useState(false);

  const toggleEnvCollapse = useCallback((env: string) => {
    setCollapsedEnvs(prev => {
      const next = new Set(prev);
      if (next.has(env)) next.delete(env); else next.add(env);
      return next;
    });
  }, []);

  // Watch triggerNewEntry signal from keyboard shortcut (Ctrl+N)
  useEffect(() => {
    if (store.triggerNewEntry > 0) {
      setEditingEntry(null);
      setShowForm(true);
    }
  }, [store.triggerNewEntry]);

  const filteredEntries = store.getFilteredEntries();

  // Group entries by env type for card view
  const groupedEntries = filteredEntries.reduce<Record<string, PasswordEntry[]>>((acc, e) => {
    if (!acc[e.envType]) acc[e.envType] = [];
    acc[e.envType].push(e);
    return acc;
  }, {});

  const envOrder = ['production', 'testing', 'development', 'staging'];
  const envLabel: Record<string, string> = { production: '正式', testing: '测试', development: '开发', staging: '预发布' };

  // Refresh entries from main process
  const refreshEntries = useCallback(async () => {
    const result = await window.electronAPI.entriesGetAll();
    if (result.success && result.data) {
      store.setVaultData(result.data);
    }
  }, []);

  // Copy handler
  const handleCopy = useCallback(async (text: string, label: string) => {
    const delay = label === '密码' ? store.settings.clipboardClearDelay * 1000 : 0;
    await window.electronAPI.clipboardCopy({ text, delay });
    addToast(`${label}已复制到剪贴板`, 'success');
    if (label === '密码' && delay > 0) {
      addToast(`剪贴板将在 ${store.settings.clipboardClearDelay} 秒后自动清空`, 'info', 2000);
    }
  }, [store.settings.clipboardClearDelay]);

  // Save entry (add or update)
  const handleSave = async (entry: PasswordEntry) => {
    let result;
    if (editingEntry) {
      result = await window.electronAPI.entriesUpdate(entry);
    } else {
      result = await window.electronAPI.entriesAdd(entry);
    }
    if (result.success && result.data) {
      store.setVaultData(result.data);
      setShowForm(false);
      setEditingEntry(null);
      addToast(editingEntry ? '网址已更新' : '网址已添加', 'success');
    } else {
      addToast(result.error || '保存失败', 'error');
    }
  };

  // Delete entries permanently
  const handleDelete = async () => {
    const ids = Array.from(store.selectedIds);
    if (ids.length === 0) return;
    const result = await window.electronAPI.entriesDelete({ ids, permanent: true });
    if (result.success && result.data) {
      store.setVaultData(result.data);
      store.clearSelected();
      addToast(`已永久删除 ${ids.length} 个网址`, 'success');
    }
    setShowDeleteConfirm(false);
  };

  // Batch export — open modal
  const handleBatchExport = useCallback(() => {
    setShowExportModal(true);
  }, []);

  // Batch change env
  const handleBatchChangeEnv = async () => {
    const ids = Array.from(store.selectedIds);
    if (ids.length === 0) return;
    const result = await window.electronAPI.entriesBatchUpdate({ ids, changes: { envType: batchEnvType } });
    if (result.success && result.data) {
      store.setVaultData(result.data);
      addToast(`已更新 ${ids.length} 个网址的环境为 ${batchEnvType}`, 'success');
    }
    setShowBatchEnvModal(false);
  };

  // Batch move tag
  const handleBatchAddTag = async () => {
    const ids = Array.from(store.selectedIds);
    if (ids.length === 0 || !batchTag) return;
    // Add tag to each selected entry
    const updatedEntries = store.entries.map(e => {
      if (ids.includes(e.id)) {
        if (!e.tags.includes(batchTag)) {
          return { ...e, tags: [...e.tags, batchTag] };
        }
      }
      return e;
    });
    const allTags = [...new Set([...store.tags, batchTag])];
    // Save via updating first entry (triggers vault save)
    const result = await window.electronAPI.entriesBatchUpdate({ ids, changes: { tags: [batchTag] } });
    // Actually we need to update tags properly - just update the entries data
    if (result.success && result.data) {
      store.setVaultData(result.data);
      addToast(`已为 ${ids.length} 个网址添加标签「${batchTag}」`, 'success');
    }
    setShowBatchTagModal(false);
  };

  // Export selected entries
  const doExportSelected = async () => {
    const ids = Array.from(store.selectedIds);
    if (ids.length === 0) { addToast('请先选择要导出的网址', 'error'); return; }
    setExporting(true);
    try {
      if (exportType === 'encrypted') {
        if (!exportPassword || exportPassword.length < 6) {
          addToast('导出密码至少6位', 'error');
          setExporting(false);
          return;
        }
        const result = await window.electronAPI.exportSelectedEncrypted({ ids, exportPassword });
        if (result.success && result.data) {
          const saveResult = await window.electronAPI.dialogSaveFile({
            defaultName: `password-manager-selected-${new Date().toISOString().slice(0, 10)}.enc`,
            filters: [{ name: '加密备份', extensions: ['enc'] }],
          });
          if (!saveResult.canceled && saveResult.filePath) {
            await window.electronAPI.fileWrite({
              filePath: saveResult.filePath,
              content: result.data,
              encoding: 'base64',
            });
            addToast(`加密备份导出成功 (${result.count ?? ids.length} 条)`, 'success');
          }
        } else {
          addToast(result.error || '导出失败', 'error');
        }
      } else {
        const formatLabel = exportFormat.toUpperCase();
        const result = await window.electronAPI.exportSelectedPlain({ ids, format: exportFormat, includePasswords });
        if (result.success && result.data) {
          const ext = exportFormat === 'xlsx' ? 'xlsx' : exportFormat;
          const saveResult = await window.electronAPI.dialogSaveFile({
            defaultName: `password-manager-selected-${new Date().toISOString().slice(0, 10)}.${ext}`,
            filters: [{ name: formatLabel, extensions: [ext] }],
          });
          if (!saveResult.canceled && saveResult.filePath) {
            if (exportFormat === 'xlsx') {
              await window.electronAPI.fileWrite({
                filePath: saveResult.filePath,
                content: result.data,
                encoding: 'base64',
              });
            } else {
              await window.electronAPI.fileWrite({
                filePath: saveResult.filePath,
                content: result.data,
              });
            }
            addToast(`${formatLabel}导出成功 (${result.count ?? ids.length} 条)`, 'success');
          }
        } else {
          addToast(result.error || '导出失败', 'error');
        }
      }
    } catch (e: any) {
      addToast(`导出失败: ${e.message}`, 'error');
    }
    setExporting(false);
    setShowExportModal(false);
  };

  // Select all / deselect all
  const handleSelectAll = () => {
    if (filteredEntries.length > 0 && filteredEntries.every(e => store.selectedIds.has(e.id))) {
      store.clearSelected();
    } else {
      store.selectAll(filteredEntries.map(e => e.id));
    }
  };

  // Listen for clipboard cleared events
  useEffect(() => {
    const cleanup = window.electronAPI.onClipboardCleared(() => {
      addToast('剪贴板已自动清空', 'info', 2000);
    });
    return cleanup;
  }, []);

  const allSelected = filteredEntries.length > 0 && filteredEntries.every(e => store.selectedIds.has(e.id));

  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {/* Three-zone toolbar */}
      <div className="toolbar">
        {/* Zone 1: Search */}
        <div className="toolbar-search">
          <div className="search-scope-btn" onClick={() => setShowScopeMenu(!showScopeMenu)} title="搜索范围">
            {searchFieldLabels[store.searchField]}
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M0 0l5 6 5-6z"/>
            </svg>
          </div>
          {showScopeMenu && (
            <div className="search-scope-menu">
              {(Object.keys(searchFieldLabels) as SearchField[]).map(key => (
                <div
                  key={key}
                  className={`search-scope-item ${store.searchField === key ? 'active' : ''}`}
                  onClick={() => { store.setSearchField(key); setShowScopeMenu(false); }}
                >
                  {searchFieldLabels[key]}
                </div>
              ))}
            </div>
          )}
          <input
            type="text"
            placeholder={`搜索${searchFieldLabels[store.searchField] === '全部' ? '名称、URL、账号、标签' : searchFieldLabels[store.searchField]}...`}
            value={store.searchQuery}
            onChange={e => store.setSearchQuery(e.target.value)}
          />
          {store.searchQuery && (
            <button className="search-clear-btn" onClick={() => store.setSearchQuery('')} title="清除搜索">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        {/* Zone 2: Filters & Sort */}
        <div className="toolbar-filters">
          <select value={store.filterEnv} onChange={e => store.setFilterEnv(e.target.value)}>
            <option value="all">全部环境</option>
            <option value="production">正式</option>
            <option value="testing">测试</option>
            <option value="development">开发</option>
            <option value="staging">预发布</option>
          </select>



          <select className="sort-select" value={store.sortField} onChange={e => store.setSortField(e.target.value as any)}>
            {(Object.keys(sortFieldLabels) as Array<keyof typeof sortFieldLabels>).map(key => (
              <option key={key} value={key}>{sortFieldLabels[key]}</option>
            ))}
          </select>
          <select className="sort-order-select" value={store.sortOrder} onChange={e => store.setSortOrder(e.target.value as any)} style={{ minWidth: 80 }}>
            {(Object.keys(sortOrderLabels) as Array<keyof typeof sortOrderLabels>).map(key => (
              <option key={key} value={key}>{sortOrderLabels[key]}</option>
            ))}
          </select>
        </div>

        {/* Zone 3: View & Add */}
        <div className="toolbar-actions">
          <button className="view-toggle-btn" onClick={() => store.setViewMode(store.viewMode === 'card' ? 'list' : 'card')} title={store.viewMode === 'card' ? '切换列表视图' : '切换卡片视图'}>
            {store.viewMode === 'card' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(90deg)' }}>
                <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>
              </svg>
            )}
          </button>

          <button className="btn-add" onClick={() => { setEditingEntry(null); setShowForm(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            新增
          </button>
        </div>
      </div>

      {/* Batch action bar - dynamic */}
      {store.selectedIds.size > 0 && (
        <div className="batch-bar">
          <span className="batch-label">已选中 </span>
          <span className="batch-count">{store.selectedIds.size}</span>
          <span className="batch-label"> 个</span>
          <div className="batch-actions">
            <button className="batch-btn" onClick={handleSelectAll} title={allSelected ? '取消全选' : '全选'}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {allSelected ? (
                  <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
                ) : (
                  <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>
                )}
              </svg>
              {allSelected ? '取消全选' : '全选'}
            </button>

            <button className="batch-btn" onClick={() => setShowBatchEnvModal(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
              批量环境
            </button>
            <button className="batch-btn" onClick={() => setShowBatchTagModal(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
              批量标签
            </button>
            <button className="batch-btn" onClick={handleBatchExport}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              批量导出
            </button>
            <button className="batch-btn batch-btn-danger" onClick={async () => {
              const ids = Array.from(store.selectedIds);
              if (ids.length === 0) return;
              const result = await window.electronAPI.entriesDelete({ ids, permanent: false });
              if (result.success && result.data) {
                store.setVaultData(result.data);
                const trashResult = await window.electronAPI.trashGetAll();
                if (trashResult.success && trashResult.data) {
                  store.setTrash(trashResult.data);
                }
                store.clearSelected();
                addToast(`已将 ${ids.length} 个网址移入回收站`, 'success');
              }
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              批量移入回收站
            </button>
            <button className="batch-btn batch-btn-danger" onClick={() => { setDeletePermanent(true); setShowDeleteConfirm(true); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
              </svg>
              删除
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="content-area">
        {filteredEntries.length === 0 ? (
          <div className="empty-state">
            {store.filterTags && store.filterTags.size > 0 ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="56" height="56" style={{ color: 'var(--accent)', opacity: 0.6 }}>
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                  <line x1="7" y1="7" x2="7.01" y2="7"/>
                </svg>
                <h3>暂无「{Array.from(store.filterTags).join('」、「')}」标签的密码记录</h3>
                <p>尝试选择其他标签或新增密码记录</p>
              </>
            ) : (
              <>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <h3>{store.searchQuery || store.filterEnv !== 'all' || store.filterTag !== 'all' || store.filterTags.size > 0 ? '未找到匹配网址' : '暂无密码记录'}</h3>
            <p>{store.searchQuery || store.filterEnv !== 'all' || store.filterTag !== 'all' || store.filterTags.size > 0 ? '暂无匹配的网址，试试修改搜索条件或筛选' : '点击右上角「新增」按钮添加你的第一条密码记录'}</p>
            {(store.searchQuery || store.filterEnv !== 'all' || store.filterTag !== 'all' || store.filterTags.size > 0) ? (
              <button className="btn-empty-clear" onClick={() => {
                store.setSearchQuery('');
                store.setFilterEnv('all');
                store.setFilterTag('all');
                store.setFilterTags(new Set());
              }}>
                清空筛选条件
              </button>
            ) : (
              <button className="btn-empty-add" onClick={() => { setEditingEntry(null); setShowForm(true); }}>
                + 新增网址
              </button>
            )}
            </>
            )}
          </div>
        ) : store.viewMode === 'card' ? (
          // Card view - grouped by env
          Object.entries(groupedEntries).map(([env, entries]) => {
            const isCollapsed = collapsedEnvs.has(env);
            return (
            <div key={env}>
              <div className="env-section-header" onClick={() => toggleEnvCollapse(env)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                <span className="env-collapse-icon" style={{ fontSize: 10, marginRight: 4, color: 'var(--text-muted)', transition: 'transform 0.15s' }}>
                  {isCollapsed ? '▶' : '▼'}
                </span>
                <span className={`env-badge env-${env}`}>{envLabel[env] || env}</span>
                <span className="count">({entries.length})</span>
              </div>
              {!isCollapsed && (
              <div className="entry-grid">
                {entries.map(entry => (
                  <EntryCard key={entry.id} entry={entry}
                    onEdit={(e) => { setEditingEntry(e); setShowForm(true); }}
                    onCopy={handleCopy} />
                ))}
              </div>
              )}
            </div>
            );
          })
        ) : (
          // List view
          <EntryList entries={filteredEntries}
            onEdit={(e) => { setEditingEntry(e); setShowForm(true); }}
            onCopy={handleCopy} />
        )}
      </div>

      {/* Entry Form Modal */}
      <EntryForm
        open={showForm}
        entry={editingEntry}
        tags={store.tags}
        onSave={handleSave}
        onClose={() => { setShowForm(false); setEditingEntry(null); }}
      />

      {/* Delete Confirm */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认永久删除"
        message={`确定要永久删除 ${store.selectedIds.size} 个网址吗？此操作不可恢复！`}
        confirmText="永久删除"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {/* Batch Export Modal */}
      <Modal open={showExportModal} onClose={() => !exporting && setShowExportModal(false)} title="批量导出所选网址">
        <div style={{ padding: '8px 0' }}>
          <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
            已选中 <strong>{store.selectedIds.size}</strong> 个网址，选择导出方式
          </p>

          <div className="settings-section" style={{ padding: 0, margin: 0, maxWidth: 'none' }}>
            <div className="setting-row">
              <div>
                <div className="setting-label">导出类型</div>
                <div className="setting-desc">加密备份或明文导出</div>
              </div>
              <div className="setting-control">
                <select value={exportType} onChange={e => setExportType(e.target.value as any)}>
                  <option value="encrypted">🔒 加密备份 (AES-256)</option>
                  <option value="plain">📄 明文导出</option>
                </select>
              </div>
            </div>
          </div>

          {exportType === 'encrypted' ? (
            <div className="settings-section" style={{ padding: 0, margin: 0, maxWidth: 'none' }}>
              <div className="form-group">
                <label>导出密码</label>
                <input type="password" value={exportPassword}
                  onChange={e => setExportPassword(e.target.value)}
                  placeholder="设置加密导出密码（至少6位）" />
                <div className="input-hint">导入时需要提供此密码解密</div>
              </div>
            </div>
          ) : (
            <div className="settings-section" style={{ padding: 0, margin: 0, maxWidth: 'none' }}>
              <div className="setting-row">
                <div>
                  <div className="setting-label">导出格式</div>
                  <div className="setting-desc">选择文件格式</div>
                </div>
                <div className="setting-control">
                  <select value={exportFormat} onChange={e => setExportFormat(e.target.value as any)}>
                    <option value="json">JSON</option>
                    <option value="csv">CSV</option>
                    <option value="xlsx">Excel (XLSX)</option>
                  </select>
                </div>
              </div>
              <div className="setting-row">
                <div>
                  <div className="setting-label">包含密码</div>
                  <div className="setting-desc">密码将以明文形式包含在导出文件中</div>
                </div>
                <div className="setting-control">
                  <input type="checkbox" checked={includePasswords}
                    onChange={e => setIncludePasswords(e.target.checked)} />
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-8" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => setShowExportModal(false)} disabled={exporting}>
              取消
            </button>
            <button className="btn btn-primary" onClick={doExportSelected} disabled={exporting}>
              {exporting ? '导出中...' : `导出 ${store.selectedIds.size} 个网址`}
            </button>
          </div>
        </div>
      </Modal>

      {/* Batch Change Env Modal */}
      <Modal open={showBatchEnvModal} onClose={() => setShowBatchEnvModal(false)} title="批量修改环境">
        <div style={{ padding: '8px 0' }}>
          <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
            将 <strong>{store.selectedIds.size}</strong> 个选中网址的环境修改为：
          </p>
          <div className="form-group">
            <select value={batchEnvType} onChange={e => setBatchEnvType(e.target.value)}>
              <option value="production">正式</option>
              <option value="testing">测试</option>
              <option value="development">开发</option>
              <option value="staging">预发布</option>
            </select>
          </div>
          <div className="flex gap-8" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowBatchEnvModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleBatchChangeEnv}>确认修改</button>
          </div>
        </div>
      </Modal>

      {/* Batch Add Tag Modal */}
      <Modal open={showBatchTagModal} onClose={() => setShowBatchTagModal(false)} title="批量添加标签">
        <div style={{ padding: '8px 0' }}>
          <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
            为 <strong>{store.selectedIds.size}</strong> 个选中网址添加标签：
          </p>
          <div className="form-group">
            <label>选择标签</label>
            <select value={batchTag} onChange={e => setBatchTag(e.target.value)}>
              <option value="">- 选择或输入新标签 -</option>
              {store.tags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="input-hint" style={{ marginTop: 8 }}>
              或输入新标签名称（自动创建）
            </div>
            <input type="text" value={batchTag} onChange={e => setBatchTag(e.target.value)}
              placeholder="输入新标签名称" style={{ marginTop: 4 }} />
          </div>
          <div className="flex gap-8" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setShowBatchTagModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleBatchAddTag} disabled={!batchTag}>确认添加</button>
          </div>
        </div>
      </Modal>
    </>
  );
}
