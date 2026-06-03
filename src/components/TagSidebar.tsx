import React, { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { getTagHue } from '../utils/tagColors';
import { Modal } from './Modal';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';

const TAG_PRESET_COLORS = [
  '#7c5cfc', '#ef4444', '#f59e0b', '#10b981',
  '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6',
  '#f97316', '#84cc16', '#06b6d4', '#a855f7',
  '#e11d48', '#0ea5e9', '#22c55e', '#eab308',
];

export function TagSidebar() {
  const tags = useStore(s => s.tags);
  const entries = useStore(s => s.entries);
  const filterTags = useStore(s => s.filterTags);
  const setFilterTags = useStore(s => s.setFilterTags);
  const collapsed = useStore(s => s.tagSidebarCollapsed);
  const setCollapsed = useStore(s => s.setTagSidebarCollapsed);
  const setFilterTag = useStore(s => s.setFilterTag);
  const { toasts, addToast, removeToast } = useToast();
  const selectAll = useStore(s => s.selectAll);
  const clearSelected = useStore(s => s.clearSelected);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showManageModal, setShowManageModal] = useState(false);
  const [manageTags, setManageTags] = useState<string[]>([]);
  const [changedColors, setChangedColors] = useState<Record<string, string>>({});
  const [showColorPickerFor, setShowColorPickerFor] = useState<string | null>(null);

  // Manage modal state
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name-asc' | 'name-desc' | 'count-desc' | 'count-asc'>('name-asc');
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingColor, setEditingColor] = useState('');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showSingleDeleteConfirm, setShowSingleDeleteConfirm] = useState<string | null>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState(TAG_PRESET_COLORS[0]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [inlineNewTag, setInlineNewTag] = useState(false);
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [sidebarDragIdx, setSidebarDragIdx] = useState<number | null>(null);

  // Right-click context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    type: 'blank' | 'all' | 'tag';
    tag?: string;
  } | null>(null);

  // Pinned tags
  const [pinnedTags, setPinnedTags] = useState<Set<string>>(new Set());

  const isPinned = (tag: string) => pinnedTags.has(tag);

  // Sort tags: pinned first, then the rest in original order
  const sortedTags = useMemo(() => {
    const pinned: string[] = [];
    const rest: string[] = [];
    tags.forEach(t => {
      if (pinnedTags.has(t)) pinned.push(t);
      else rest.push(t);
    });
    // If sidebarSearch is active, filter first
    const matchesSearch = (t: string) => !sidebarSearch || t.toLowerCase().includes(sidebarSearch.toLowerCase());
    return [...pinned.filter(matchesSearch), ...rest.filter(matchesSearch)];
  }, [tags, pinnedTags, sidebarSearch]);

  // F2 keyboard shortcut — rename tag
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        const tag = contextMenu?.type === 'tag' && contextMenu.tag
          ? contextMenu.tag
          : filterTags.size > 0 ? Array.from(filterTags)[0] : null;
        if (tag && tags.includes(tag)) {
          e.preventDefault();
          setInlineRename(tag);
          setInlineRenameValue(tag);
          setContextMenu(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextMenu, filterTags, tags]);

  // Ctrl+A keyboard shortcut — select all / deselect all
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // Only handle when not in an input/textarea
        const tag = e.target as HTMLElement;
        if (tag.tagName === 'INPUT' || tag.tagName === 'TEXTAREA' || tag.isContentEditable) return;
        e.preventDefault();
        if (entries.length > 0) {
          const store = useStore.getState();
          const allSelected = entries.every(e => store.selectedIds.has(e.id));
          if (allSelected) {
            store.clearSelected();
            addToast('已取消全选', 'info');
          } else {
            selectAll(entries.map(e => e.id));
            addToast(`已全选 ${entries.length} 个网址`, 'info');
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [entries, selectAll, addToast]);

  // Inline rename state (sidebar, not manage modal)
  const [inlineRename, setInlineRename] = useState<string | null>(null);
  const [inlineRenameValue, setInlineRenameValue] = useState('');

  const totalLinkedEntries = useMemo(() => {
    const linked = new Set<string>();
    tags.forEach(t => entries.filter(e => e.tags.includes(t)).forEach(e => linked.add(e.id)));
    return linked.size;
  }, [tags, entries]);

  const countByTag = (tag: string) => entries.filter(e => e.tags.includes(tag)).length;

  const getTagColor = (tag: string): string => {
    if (changedColors[tag]) return changedColors[tag];
    return `hsl(${getTagHue(tag)}, 55%, 55%)`;
  };

  const handleInlineRenameConfirm = (oldName: string) => {
    const trimmed = inlineRenameValue.trim();
    if (!trimmed || trimmed === oldName) { setInlineRename(null); return; }
    if (tags.includes(trimmed) && trimmed !== oldName) {
      addToast('标签名称已存在', 'error');
      return;
    }
    const updatedEntries = entries.map(e => ({ ...e, tags: e.tags.map(t => t === oldName ? trimmed : t) }));
    const updatedTags = tags.map(t => t === oldName ? trimmed : t);
    useStore.getState().setVaultData({ entries: updatedEntries, tags: updatedTags });
    setInlineRename(null);
    addToast(`已重命名为「${trimmed}」`, 'success');
  };

  const handlePinToggle = (tag: string) => {
    const next = new Set(pinnedTags);
    if (next.has(tag)) {
      next.delete(tag);
      addToast(`标签「${tag}」已取消置顶`, 'info');
    } else {
      next.add(tag);
      addToast(`标签「${tag}」已置顶`, 'success');
    }
    setPinnedTags(next);
  };

  const handleTagClick = (tag: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(filterTags);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      setFilterTags(next);
    } else {
      if (filterTags.has(tag) && filterTags.size === 1) {
        setFilterTags(new Set());
      } else {
        setFilterTags(new Set([tag]));
      }
    }
  };

  const handleAllClick = () => {
    setFilterTags(new Set());
    setFilterTag('all');
  };

  const handleCreateTag = () => {
    setNewTagName('');
    setNewTagColor(TAG_PRESET_COLORS[0]);
    setShowCreateModal(true);
  };

  const doCreateTag = () => {
    const t = newTagName.trim();
    if (!t) return;
    if (tags.includes(t)) { addToast('标签已存在', 'error'); return; }
    const updatedTags = [...tags, t];
    useStore.getState().setVaultData({ entries: useStore.getState().entries, tags: updatedTags });
    setNewTagName('');
    setShowCreateModal(false);
    if (showManageModal) setManageTags([...updatedTags]);
    addToast(`标签「${t}」已创建`, 'success');
  };

  const isAllSelected = filterTags.size === 0;

  const handleManageClick = () => {
    setManageTags([...tags]);
    setShowManageModal(true);
    setSearchQuery('');
    setSortBy('name-asc');
    setEditingTag(null);
    setSelectedTags(new Set());
  };

  // Filtered + sorted tags for manage modal
  const filteredManageTags = useMemo(() => {
    let result = manageTags;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t => t.toLowerCase().includes(q));
    }
    return [...result].sort((a, b) => {
      if (sortBy === 'name-asc') return a.localeCompare(b);
      if (sortBy === 'name-desc') return b.localeCompare(a);
      const ca = countByTag(a), cb = countByTag(b);
      if (sortBy === 'count-desc') return cb - ca;
      return ca - cb;
    });
  }, [manageTags, searchQuery, sortBy, entries]);

  const handleDeleteTag = (tag: string) => {
    const count = countByTag(tag);
    if (count > 0) {
      addToast(`标签「${tag}」被 ${count} 个网址使用，无法删除`, 'error');
      return;
    }
    const updatedTags = tags.filter(t => t !== tag);
    useStore.getState().setVaultData({ entries: useStore.getState().entries, tags: updatedTags });
    setManageTags(prev => prev.filter(t => t !== tag));
    addToast(`标签「${tag}」已删除`, 'success');
  };

  const handleBulkDelete = () => {
    const deletable = Array.from(selectedTags).filter(t => countByTag(t) === 0);
    const blocked = Array.from(selectedTags).filter(t => countByTag(t) > 0);
    if (blocked.length > 0) {
      addToast(`${blocked.length} 个标签有网址使用，无法删除`, 'error');
    }
    if (deletable.length === 0) { setShowBulkDeleteConfirm(false); return; }
    const updatedTags = tags.filter(t => !deletable.includes(t));
    useStore.getState().setVaultData({ entries: useStore.getState().entries, tags: updatedTags });
    setManageTags(prev => prev.filter(t => !deletable.includes(t)));
    setSelectedTags(new Set());
    setShowBulkDeleteConfirm(false);
    addToast(`已删除 ${deletable.length} 个标签`, 'success');
  };

  const handleRenameTag = (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) { setEditingTag(null); return; }
    const updatedEntries = entries.map(e => ({ ...e, tags: e.tags.map(t => t === oldName ? trimmed : t) }));
    const updatedTags = tags.map(t => t === oldName ? trimmed : t);
    useStore.getState().setVaultData({ entries: updatedEntries, tags: updatedTags });
    setManageTags(prev => prev.map(t => t === oldName ? trimmed : t));
    setEditingTag(null);
  };

  const handleChangeTagColor = (tag: string, color: string) => {
    setChangedColors(prev => ({ ...prev, [tag]: color }));
  };

  const handleStartEdit = (tag: string) => {
    setEditingTag(tag);
    setEditingName(tag);
    setEditingColor(getTagColor(tag));
  };

  // Merge tags
  const handleMergeTags = () => {
    const sel = Array.from(selectedTags);
    if (sel.length < 2) return;
    const targetName = sel[0];
    const rest = sel.slice(1);
    const updatedEntries = entries.map(e => {
      let newTags = e.tags.filter(t => !rest.includes(t));
      if (rest.some(r => e.tags.includes(r)) && !newTags.includes(targetName)) {
        newTags = [...newTags, targetName];
      }
      return { ...e, tags: newTags };
    });
    const updatedTags = tags.filter(t => !rest.includes(t));
    useStore.getState().setVaultData({ entries: updatedEntries, tags: updatedTags });
    setManageTags(updatedTags);
    setSelectedTags(new Set());
    addToast(`已将 ${sel.length} 个标签合并为「${targetName}」`, 'success');
  };

  const handleReorder = (dragIdx: number, dropIdx: number) => {
    const arr = [...manageTags];
    const [moved] = arr.splice(dragIdx, 1);
    arr.splice(dropIdx, 0, moved);
    setManageTags(arr);
    // Sync to store (tags list order)
    useStore.getState().setVaultData({ entries: useStore.getState().entries, tags: arr });
  };

  return (
    <>
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      <div className={`tag-sidebar ${collapsed ? 'collapsed' : ''}`}>
        <button className="tag-sidebar-toggle" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开标签' : '收起标签'}>
          {collapsed ? '▶' : '◀'}
        </button>
        {!collapsed && (
          <>
            <div className="tag-sidebar-header">
              <span className="tag-sidebar-title">标签</span>
              <button className="tag-sidebar-add-btn" onClick={handleCreateTag} title="新建标签">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="16" height="16">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
            </div>
            <div className={`tag-sidebar-item ${isAllSelected ? 'active' : ''}`} onClick={handleAllClick}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'all' }); }}>
              <span className="tag-sidebar-dot" style={{ background: '#888' }} />
              <span className="tag-sidebar-name">全部标签</span>
              <span className="tag-sidebar-count">{entries.length}</span>
            </div>
            <div className="tag-sidebar-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input type="text" className="tag-sidebar-search-input" placeholder="搜索标签..."
                value={sidebarSearch} onChange={e => setSidebarSearch(e.target.value)}
                onClick={e => e.stopPropagation()} />
            </div>
            <div className="tag-sidebar-list" onContextMenu={e => {
              e.preventDefault(); e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, type: 'blank' });
            }}>
              {sortedTags.map(tag => {
                const isActive = filterTags.has(tag);
                const pinned = isPinned(tag);
                const isRenaming = inlineRename === tag;
                return (
                  <div key={tag} className={`tag-sidebar-item ${isActive ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
                    draggable={!pinned}
                    onDragStart={() => {
                      const rawIdx = tags.indexOf(tag);
                      setSidebarDragIdx(rawIdx);
                    }}
                    onDragOver={e => { e.preventDefault(); }}
                    onDrop={e => {
                      e.preventDefault();
                      if (sidebarDragIdx !== null) {
                        const rawTags = useStore.getState().tags;
                        const dragTag = rawTags[sidebarDragIdx];
                        if (dragTag && dragTag !== tag && !isPinned(dragTag)) {
                          const arr = [...rawTags];
                          const fromIdx = arr.indexOf(dragTag);
                          const toIdx = arr.indexOf(tag);
                          if (fromIdx !== -1 && toIdx !== -1) {
                            const [moved] = arr.splice(fromIdx, 1);
                            const adjustedTo = arr.indexOf(tag);
                            arr.splice(adjustedTo >= 0 ? adjustedTo : toIdx, 0, moved);
                            useStore.getState().setVaultData({ entries: useStore.getState().entries, tags: arr });
                          }
                        }
                      }
                      setSidebarDragIdx(null);
                    }}
                    onDragEnd={() => setSidebarDragIdx(null)}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'tag', tag }); }}
                    onClick={(e) => handleTagClick(tag, e)}>
                    <span className="tag-sidebar-dot" style={{ background: getTagColor(tag) }} />
                    {pinned && <span className="tag-pin-icon">{'\u{1F4CC}'}</span>}
                    {isRenaming ? (
                      <input type="text" className="tag-sidebar-rename-input" value={inlineRenameValue}
                        onChange={e => setInlineRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleInlineRenameConfirm(tag);
                          if (e.key === 'Escape') setInlineRename(null);
                        }}
                        onBlur={() => handleInlineRenameConfirm(tag)}
                        onClick={e => e.stopPropagation()}
                        autoFocus />
                    ) : (
                      <span className="tag-sidebar-name">{tag}</span>
                    )}
                    <span className="tag-sidebar-count">{countByTag(tag)}</span>
                  </div>
                );
              })}
              {tags.length === 0 && <div className="tag-sidebar-empty">暂无标签</div>}
            </div>
            <div className="tag-sidebar-footer">
              <span className="tag-sidebar-manage" onClick={handleManageClick}>管理标签</span>
            </div>
          </>
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <>
          <div className="context-menu-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={e => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(ctx => ctx ? { ...ctx, x: e.clientX, y: e.clientY } : null);
            }} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {contextMenu.type === 'blank' && (
              <>
                <div className="context-menu-item" onClick={() => { setContextMenu(null); setShowCreateModal(true); }}>
                  <span className="context-menu-icon">+</span>
                  <span>新建标签</span>
                </div>
                <div className="context-menu-sep" />
                <div className="context-menu-item" onClick={() => { setContextMenu(null); handleManageClick(); }}>
                  <span className="context-menu-icon">{'\u2699'}</span>
                  <span>管理标签</span>
                </div>
              </>
            )}
            {contextMenu.type === 'all' && (
              <>
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  if (entries.length > 0) selectAll(entries.map(e => e.id));
                  addToast(`已全选 ${entries.length} 个网址`, 'info');
                }}>
                  <span className="context-menu-icon">{'\u2713'}</span>
                  <span>全选所有网址</span>
                  <kbd>Ctrl+A</kbd>
                </div>
                <div className="context-menu-sep" />
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  navigator.clipboard.writeText('全部标签').catch(() => {});
                  addToast('已复制标签名称', 'success');
                }}>
                  <span className="context-menu-icon">{'\u{1F4CB}'}</span>
                  <span>复制标签名称</span>
                </div>
              </>
            )}
            {contextMenu.type === 'tag' && contextMenu.tag && (
              <>
                {(() => {
                  const tag = contextMenu.tag!;
                  const tagEntries = entries.filter(e => e.tags.includes(tag));
                  const allTagSelected = tagEntries.length > 0 && tagEntries.every(e => useStore.getState().selectedIds.has(e.id));
                  return (
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  if (allTagSelected) {
                    clearSelected();
                    addToast('已取消全选', 'info');
                  } else {
                    selectAll(tagEntries.map(e => e.id));
                    addToast(`已全选标签「${tag}」下 ${tagEntries.length} 个网址`, 'info');
                  }
                }}>
                  <span className="context-menu-icon">{allTagSelected ? '\u274C' : '\u2713'}</span>
                  <span>{allTagSelected ? '取消全选' : '全选该标签下所有网址'}</span>
                  <kbd>Ctrl+A</kbd>
                </div>
                  );
                })()}
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  setInlineRename(contextMenu.tag!);
                  setInlineRenameValue(contextMenu.tag!);
                }}>
                  <span className="context-menu-icon">{'\u270F'}</span>
                  <span>重命名标签</span>
                  <kbd>F2</kbd>
                </div>
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  handlePinToggle(contextMenu.tag!);
                }}>
                  <span className="context-menu-icon">{isPinned(contextMenu.tag!) ? '\u{1F4CC}' : '\u{1F51D}'}</span>
                  <span>{isPinned(contextMenu.tag!) ? '取消置顶' : '置顶标签'}</span>
                </div>
                <div className="context-menu-sep" />
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  navigator.clipboard.writeText(contextMenu.tag!).catch(() => {});
                  addToast('已复制标签名称', 'success');
                }}>
                  <span className="context-menu-icon">{'\u{1F4CB}'}</span>
                  <span>复制标签名称</span>
                </div>
                <div className="context-menu-sep" />
                <div className="context-menu-item danger" onClick={() => {
                  setContextMenu(null);
                  const count = countByTag(contextMenu.tag!);
                  if (count > 0) {
                    addToast(`标签「${contextMenu.tag}」被 ${count} 个网址使用，无法删除`, 'error');
                  } else {
                    handleDeleteTag(contextMenu.tag!);
                  }
                }}>
                  <span className="context-menu-icon">{'\u{1F5D1}'}</span>
                  <span>删除标签</span>
                  <kbd>Del</kbd>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Create Tag Modal */}
      <Modal open={showCreateModal} onClose={() => setShowCreateModal(false)} title="新建标签">
        <div style={{ padding: '8px 0' }}>
          <div className="form-group">
            <label>标签名称</label>
            <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)}
              placeholder="输入标签名称" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') doCreateTag(); }} />
          </div>
          <div className="form-group">
            <label>标签颜色</label>
            <div className="tag-color-picker">
              {TAG_PRESET_COLORS.map(color => (
                <div key={color} className={`tag-color-swatch ${newTagColor === color ? 'selected' : ''}`}
                  style={{ background: color }} onClick={() => setNewTagColor(color)} />
              ))}
            </div>
          </div>
          <div className="flex gap-8" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => setShowCreateModal(false)}>取消</button>
            <button className="btn btn-primary" onClick={doCreateTag}>创建</button>
          </div>
        </div>
      </Modal>

      {/* ==================== MANAGE TAGS MODAL ==================== */}
      <Modal open={showManageModal} onClose={() => { setShowManageModal(false); setShowColorPickerFor(null); }} title="管理标签">
        <div style={{ padding: '4px 0', minWidth: 480, maxWidth: 560 }}>

          {/* --- Toolbar --- */}
          <div className="manage-tag-toolbar">
            <div className="manage-tag-search-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ flexShrink: 0, color: 'var(--text-muted)' }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input type="text" className="manage-tag-search-input" placeholder="搜索标签名称..."
                value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
            <select className="manage-tag-sort-select" value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
              <option value="name-asc">名称 A-Z</option>
              <option value="name-desc">名称 Z-A</option>
              <option value="count-desc">数量 ↓</option>
              <option value="count-asc">数量 ↑</option>
            </select>
            <button className="btn btn-sm btn-primary manage-tag-new-btn" onClick={() => setInlineNewTag(true)}>+ 新建</button>
          </div>

          {/* --- Bulk action bar --- */}
          {selectedTags.size > 0 && (
            <div className="manage-tag-bulk-bar">
              <span className="manage-tag-bulk-info">已选 {selectedTags.size} 个</span>
              {selectedTags.size >= 2 && (
                <button className="btn btn-sm btn-secondary" onClick={handleMergeTags}>合并标签</button>
              )}
              <button className="btn btn-sm btn-secondary bulk-color-btn" onClick={() => {
                // Apply first preset color to all selected
                const color = TAG_PRESET_COLORS[0];
                selectedTags.forEach(t => handleChangeTagColor(t, color));
                addToast(`已修改 ${selectedTags.size} 个标签颜色`, 'success');
              }}>重置颜色</button>
              <button className="btn btn-sm btn-danger" onClick={() => setShowBulkDeleteConfirm(true)}>删除</button>
            </div>
          )}
          {(selectedTags.size > 0 || true) && <div style={{ display: selectedTags.size > 0 ? 'block' : 'none' }} />}

          {/* --- Inline new tag input --- */}
          {inlineNewTag && (
            <div className="manage-tag-inline-new">
              <input type="text" placeholder="输入标签名称..." autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const t = (e.target as HTMLInputElement).value.trim();
                    if (t) {
                      if (tags.includes(t)) { addToast('标签已存在', 'error'); return; }
                      const updatedTags = [...tags, t];
                      useStore.getState().setVaultData({ entries: useStore.getState().entries, tags: updatedTags });
                      setManageTags([...updatedTags]);
                      addToast(`标签「${t}」已创建`, 'success');
                    }
                    setInlineNewTag(false);
                  }
                  if (e.key === 'Escape') setInlineNewTag(false);
                }}
                onBlur={() => setInlineNewTag(false)} />
              <button className="btn btn-sm btn-secondary" onClick={() => setInlineNewTag(false)}>取消</button>
            </div>
          )}

          {/* --- Tag list --- */}
          <div className="manage-tag-list">
            {filteredManageTags.length === 0 ? (
              searchQuery ? (
                <div className="manage-tag-empty">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="36" height="36" style={{ opacity: 0.3 }}>
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <p>未找到匹配的标签</p>
                  <p className="text-sm text-muted">试试其他关键词，或新建一个标签</p>
                </div>
              ) : (
                <div className="manage-tag-empty">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="36" height="36" style={{ opacity: 0.3 }}>
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>
                  </svg>
                  <p>暂无标签</p>
                  <p className="text-sm text-muted" style={{ marginBottom: 12 }}>创建一个标签来分类你的密码记录</p>
                  <button className="btn btn-sm btn-primary" onClick={handleCreateTag}>新建第一个标签</button>
                </div>
              )
            ) : (
              filteredManageTags.map((tag, idx) => {
                const entryCount = countByTag(tag);
                const currentColor = getTagColor(tag);
                const isEditing = editingTag === tag;
                const isSelected = selectedTags.has(tag);
                const hasEntries = entryCount > 0;

                return (
                  <div key={tag}
                    className={`manage-tag-row ${isEditing ? 'editing' : ''} ${isSelected ? 'selected' : ''}`}
                    draggable={!isEditing}
                    onDragStart={() => setDragIdx(idx)}
                    onDragOver={e => { e.preventDefault(); }}
                    onDrop={e => { e.preventDefault(); if (dragIdx !== null && dragIdx !== idx) handleReorder(dragIdx, idx); setDragIdx(null); }}
                    onDragEnd={() => setDragIdx(null)}>
                    {/* Drag handle + Checkbox */}
                    <span className="manage-tag-drag-handle" title="拖拽排序">
                      <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="6" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/></svg>
                    </span>
                    <input type="checkbox" className="manage-tag-checkbox" checked={isSelected}
                      onChange={() => {
                        const next = new Set(selectedTags);
                        if (next.has(tag)) next.delete(tag); else next.add(tag);
                        setSelectedTags(next);
                      }} />

                    {/* Color dot */}
                    <div className="manage-tag-color-wrap">
                      <span className="manage-tag-dot" style={{ background: currentColor }}
                        onClick={() => setShowColorPickerFor(showColorPickerFor === tag ? null : tag)} />
                      {showColorPickerFor === tag && (
                        <div className="manage-color-popup">
                          {TAG_PRESET_COLORS.map(c => (
                            <span key={c} className={`manage-color-swatch ${currentColor === c ? 'active' : ''}`}
                              style={{ background: c }}
                              onClick={() => { handleChangeTagColor(tag, c); setShowColorPickerFor(null); }} />
                          ))}
                        </div>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="manage-tag-edit-row">
                        <input type="text" value={editingName}
                          onChange={e => setEditingName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleRenameTag(tag, editingName);
                            if (e.key === 'Escape') setEditingTag(null);
                          }}
                          autoFocus className="manage-tag-edit-input" />
                        <button className="btn btn-sm btn-primary" onClick={() => handleRenameTag(tag, editingName)}>保存</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => setEditingTag(null)}>取消</button>
                      </div>
                    ) : (
                      <>
                        <span className="manage-tag-name" title={tag}
                          onClick={() => { setShowManageModal(false); setFilterTags(new Set([tag])); }}>
                          {tag.length > 15 ? tag.slice(0, 15) + '...' : tag}
                        </span>
                        <span className="manage-tag-count" title={`共${entryCount}条密码记录`}>
                          {entryCount}
                        </span>
                        <span className="manage-tag-actions">
                          <button className="manage-tag-btn" onClick={() => handleStartEdit(tag)} title="编辑">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          <button className="manage-tag-btn danger" onClick={() => {
                            if (hasEntries) {
                              addToast(`标签「${tag}」被 ${entryCount} 个网址使用，无法删除`, 'error');
                            } else {
                              handleDeleteTag(tag);
                            }
                          }} title={hasEntries ? '有网址使用中，无法删除' : '删除'}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* --- Stats --- */}
          {manageTags.length > 0 && (
            <div className="manage-tag-footer">
              共 {manageTags.length} 个标签，关联 {totalLinkedEntries} 条密码记录
            </div>
          )}
        </div>
      </Modal>

      {/* Bulk Delete Confirm */}
      {showBulkDeleteConfirm && (
        <div className="modal-overlay" onClick={() => setShowBulkDeleteConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <span>确认批量删除</span>
              <button className="close-btn" onClick={() => setShowBulkDeleteConfirm(false)}>&times;</button>
            </div>
            <div className="modal-body" style={{ padding: '24px', textAlign: 'center' }}>
              <p style={{ marginBottom: 12 }}>确定要删除选中的 {selectedTags.size} 个标签吗？</p>
              <p className="text-sm text-muted">有网址使用的标签不会被删除</p>
              <div className="flex gap-8" style={{ justifyContent: 'center', marginTop: 16 }}>
                <button className="btn btn-secondary" onClick={() => setShowBulkDeleteConfirm(false)}>取消</button>
                <button className="btn btn-danger" onClick={handleBulkDelete}>确认删除</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
