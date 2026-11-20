import React, { useState, useMemo, useEffect } from 'react';
import type { VaultData } from '../types';
import { useStore } from '../store/useStore';
import { getTagHue } from '../utils/tagColors';
import { Modal } from './Modal';
import { Icons } from './ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { callIpc } from '../utils/ipc';

const TAG_PRESET_COLORS = [
  '#7c5cfc', '#ef4444', '#f59e0b', '#10b981',
  '#3b82f6', '#ec4899', '#14b8a6', '#8b5cf6',
  '#f97316', '#84cc16', '#06b6d4', '#a855f7',
  '#e11d48', '#0ea5e9', '#22c55e', '#eab308',
];

type TagOpResult = { ok: true; data?: VaultData } | { ok: false; error: string };

/**
 * 标签操作统一落盘。
 *
 * 背景：这个组件以前**一处 electronAPI 都没调**——新建 / 重命名 / 删除 / 合并 / 拖拽排序
 * 全部只调 `setVaultData` 改内存，重启后全部回退。用户以为改好了，其实一次都没写盘。
 *
 * 现在统一走主进程的 4 个 handler，并且遵守项目硬约束「先落盘成功再弹 toast」：
 * 失败时**不改本地状态**，由调用方弹 error toast 并 return。
 */
async function persistTagOp(
  fn: () => Promise<{ success: boolean; data?: VaultData; error?: string }>,
): Promise<TagOpResult> {
  const r = await callIpc<VaultData>(fn);
  if (!r.ok) return { ok: false, error: r.error };
  // 主进程返回的 vault 才是落盘后的真相：直接覆盖 store，避免本地猜的和磁盘不一致
  if (r.data) useStore.getState().setVaultData(r.data);
  return { ok: true, data: r.data };
}

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

  // Esc 关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  // Esc 关闭标签颜色选择浮层（项目硬约束：一切浮层都要能 Esc 关掉）
  useEffect(() => {
    if (!showColorPickerFor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowColorPickerFor(null); };
    // 点浮层外面也要关：以前只能再点一次色点，点别处它一直挂着
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.manage-color-popup') || t.closest('.manage-tag-dot'))) return;
      setShowColorPickerFor(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [showColorPickerFor]);

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

  /**
   * 标签改名 / 删除后同步「当前筛选条件」。
   *
   * 以前重命名后 `filterTags` 里还是旧名字 —— 筛选条件指向一个已经不存在的标签，
   * 列表立刻变空，用户以为数据丢了。删除同理（删掉的正好是当前筛选的标签）。
   * `newName` 传 null 表示删除。
   */
  const syncFilterAfterTagChange = (oldName: string, newName: string | null) => {
    const store = useStore.getState();
    if (store.filterTags.has(oldName)) {
      const next = new Set(store.filterTags);
      next.delete(oldName);
      if (newName) next.add(newName);
      store.setFilterTags(next);
    }
    if (store.filterTag === oldName) {
      store.setFilterTag(newName || 'all');
    }
  };

  const handleInlineRenameConfirm = async (oldName: string) => {
    const trimmed = inlineRenameValue.trim();
    if (!trimmed || trimmed === oldName) { setInlineRename(null); return; }
    if (tags.includes(trimmed) && trimmed !== oldName) {
      addToast('标签名称已存在', 'error');
      return;
    }
    // 先落盘：失败就保持原状（输入框还开着，用户可以改个名字再试）
    const r = await persistTagOp(() => window.electronAPI.entriesRenameTag({ from: oldName, to: trimmed }));
    if (!r.ok) { addToast(`重命名失败：${r.error}`, 'error'); return; }
    syncFilterAfterTagChange(oldName, trimmed);
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

  /**
   * 新建标签并落盘。
   *
   * 新建的标签还没有任何条目引用，所以不能走 `entriesAddTag`（它要求 ids 非空且只往条目上加），
   * 也不能走 `entriesUpdate`（需要条目本身）。唯一通道是 `entriesReorderTags`：
   * 主进程按传入顺序重排 `vault.tags`，**允许新增**，没传到的已有标签追加到末尾。
   *
   * 保留一道防御性校验：万一主进程又改回「过滤未知标签」，这里必须报错而不是假装成功。
   */
  const createTagPersisted = async (name: string): Promise<TagOpResult> => {
    const r = await persistTagOp(() => window.electronAPI.entriesReorderTags({ tags: [...tags, name] }));
    if (!r.ok) return r;
    if (!r.data || !r.data.tags.includes(name)) {
      return { ok: false, error: '主进程未接受新标签（标签顺序接口把未知标签过滤掉了）' };
    }
    return r;
  };

  const doCreateTag = async () => {
    const t = newTagName.trim();
    if (!t) return;
    if (tags.includes(t)) { addToast('标签已存在', 'error'); return; }
    const r = await createTagPersisted(t);
    if (!r.ok) { addToast(`创建标签失败：${r.error}`, 'error'); return; }
    setNewTagName('');
    setShowCreateModal(false);
    if (showManageModal) setManageTags([...useStore.getState().tags]);
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

  const handleDeleteTag = async (tag: string) => {
    const count = countByTag(tag);
    if (count > 0) {
      addToast(`标签「${tag}」被 ${count} 个网址使用，无法删除`, 'error');
      return;
    }
    const r = await persistTagOp(() => window.electronAPI.entriesDeleteTag({ tag }));
    if (!r.ok) { addToast(`删除标签失败：${r.error}`, 'error'); return; }
    syncFilterAfterTagChange(tag, null);
    setManageTags(prev => prev.filter(t => t !== tag));
    addToast(`标签「${tag}」已删除`, 'success');
  };

  const handleBulkDelete = async () => {
    const deletable = Array.from(selectedTags).filter(t => countByTag(t) === 0);
    const blocked = Array.from(selectedTags).filter(t => countByTag(t) > 0);
    if (blocked.length > 0) {
      addToast(`${blocked.length} 个标签有网址使用，无法删除`, 'error');
    }
    if (deletable.length === 0) { setShowBulkDeleteConfirm(false); return; }
    // 逐个删：主进程的 delete-tag 一次只认一个标签。任一失败就停下并如实报告，
    // 已经删掉的那些保持删除（它们确实落盘了），不要回滚成「看起来全都没删」。
    const failed: string[] = [];
    for (const t of deletable) {
      const r = await persistTagOp(() => window.electronAPI.entriesDeleteTag({ tag: t }));
      if (!r.ok) { failed.push(`${t}（${r.error}）`); continue; }
      syncFilterAfterTagChange(t, null);
      setManageTags(prev => prev.filter(x => x !== t));
    }
    const done = deletable.length - failed.length;
    setSelectedTags(new Set());
    setShowBulkDeleteConfirm(false);
    if (failed.length > 0) {
      addToast(`已删除 ${done} 个标签，${failed.length} 个失败：${failed.join('、')}`, 'error', 5000);
    } else {
      addToast(`已删除 ${done} 个标签`, 'success');
    }
  };

  const handleRenameTag = async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) { setEditingTag(null); return; }
    if (tags.includes(trimmed)) { addToast(`标签「${trimmed}」已存在`, 'error'); return; }
    const r = await persistTagOp(() => window.electronAPI.entriesRenameTag({ from: oldName, to: trimmed }));
    if (!r.ok) { addToast(`重命名失败：${r.error}`, 'error'); return; }
    syncFilterAfterTagChange(oldName, trimmed);
    setManageTags(prev => prev.map(t => t === oldName ? trimmed : t));
    setEditingTag(null);
    addToast(`已重命名为「${trimmed}」`, 'success');
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
  //
  // 合并语义 = 把 rest 里的每个标签都改名成 targetName。主进程的 rename-tag 会同时改
  // 标签池与所有条目上的引用，所以逐个 rename 就够，不需要再 delete（rename 后 rest
  // 已经不在库里了）。targetName 本身不动，因此不会撞「标签已存在」的校验。
  const handleMergeTags = async () => {
    const sel = Array.from(selectedTags);
    if (sel.length < 2) return;
    const targetName = sel[0];
    const rest = sel.slice(1);
    const failed: string[] = [];
    for (const from of rest) {
      const r = await persistTagOp(() => window.electronAPI.entriesRenameTag({ from, to: targetName }));
      if (!r.ok) { failed.push(`${from}（${r.error}）`); continue; }
      // 被合并掉的标签如果正在筛选，改指向合并目标
      syncFilterAfterTagChange(from, targetName);
    }
    const merged = rest.length - failed.length;
    setManageTags([...useStore.getState().tags]);
    setSelectedTags(new Set());
    if (failed.length > 0) {
      addToast(`已合并 ${merged} 个标签到「${targetName}」，${failed.length} 个失败：${failed.join('、')}`, 'error', 5000);
    } else {
      addToast(`已将 ${sel.length} 个标签合并为「${targetName}」`, 'success');
    }
  };

  /**
   * 拖拽排序落盘。
   *
   * `manageTags` 是「管理弹窗里的显示顺序」，可能被搜索框或排序下拉改过，
   * 直接拿它当全量顺序会把库里的顺序搞乱。所以只把**被拖动的那一个**挪位置：
   * 在真实顺序里找到「拖动后紧跟在它后面的那个标签」，插到它前面；没有就追加到末尾。
   */
  const handleReorder = async (dragIdx: number, dropIdx: number) => {
    const arr = [...manageTags];
    const [moved] = arr.splice(dragIdx, 1);
    if (moved === undefined) return;
    arr.splice(dropIdx, 0, moved);
    setManageTags(arr);

    const real = [...useStore.getState().tags];
    const fromIdx = real.indexOf(moved);
    if (fromIdx === -1) return;
    real.splice(fromIdx, 1);
    // 拖动后排在 moved 后面、且真实存在的第一个标签 = 插入锚点
    const nextTag = arr.slice(dropIdx + 1).find(t => real.includes(t));
    const insertAt = nextTag ? real.indexOf(nextTag) : real.length;
    real.splice(insertAt, 0, moved);

    const r = await persistTagOp(() => window.electronAPI.entriesReorderTags({ tags: real }));
    if (!r.ok) {
      addToast(`保存标签顺序失败：${r.error}`, 'error');
      setManageTags([...useStore.getState().tags]);
    }
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
                onClick={e => e.stopPropagation()} aria-label="搜索标签" />
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
                    onDrop={async e => {
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
                            // 拖拽排序必须落盘，否则重启后顺序回退
                            const r = await persistTagOp(() => window.electronAPI.entriesReorderTags({ tags: arr }));
                            if (!r.ok) addToast(`保存标签顺序失败：${r.error}`, 'error');
                          }
                        }
                      }
                      setSidebarDragIdx(null);
                    }}
                    onDragEnd={() => setSidebarDragIdx(null)}
                    onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'tag', tag }); }}
                    onClick={(e) => handleTagClick(tag, e)}>
                    <span className="tag-sidebar-dot" style={{ background: getTagColor(tag) }} />
                    {pinned && <span className="tag-pin-icon"><Icons.pin size={11} /></span>}
                    {isRenaming ? (
                      <input type="text" className="tag-sidebar-rename-input" value={inlineRenameValue}
                        onChange={e => setInlineRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleInlineRenameConfirm(tag);
                          if (e.key === 'Escape') setInlineRename(null);
                        }}
                        onBlur={() => handleInlineRenameConfirm(tag)}
                        onClick={e => e.stopPropagation()}
                        autoFocus aria-label="重命名标签" />
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
                  <span className="context-menu-icon"><Icons.copy size={13} /></span>
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
                  <span className="context-menu-icon"><Icons.pencil size={13} /></span>
                  <span>重命名标签</span>
                  <kbd>F2</kbd>
                </div>
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  handlePinToggle(contextMenu.tag!);
                }}>
                  <span className="context-menu-icon"><Icons.pin size={13} /></span>
                  <span>{isPinned(contextMenu.tag!) ? '取消置顶' : '置顶标签'}</span>
                </div>
                <div className="context-menu-sep" />
                <div className="context-menu-item" onClick={() => {
                  setContextMenu(null);
                  navigator.clipboard.writeText(contextMenu.tag!).catch(() => {});
                  addToast('已复制标签名称', 'success');
                }}>
                  <span className="context-menu-icon"><Icons.copy size={13} /></span>
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
                  <span className="context-menu-icon"><Icons.trash size={13} /></span>
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
              onKeyDown={e => { if (e.key === 'Enter') doCreateTag(); }} aria-label="标签名称" />
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
                value={searchQuery} onChange={e => setSearchQuery(e.target.value)} aria-label="搜索标签名称" />
            </div>
            <select className="manage-tag-sort-select" value={sortBy} onChange={e => setSortBy(e.target.value as any)} aria-label="标签排序方式">
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
                onKeyDown={async e => {
                  if (e.key === 'Enter') {
                    const t = (e.target as HTMLInputElement).value.trim();
                    if (t) {
                      if (tags.includes(t)) { addToast('标签已存在', 'error'); return; }
                      const r = await createTagPersisted(t);
                      if (!r.ok) { addToast(`创建标签失败：${r.error}`, 'error'); return; }
                      setManageTags([...useStore.getState().tags]);
                      addToast(`标签「${t}」已创建`, 'success');
                    }
                    setInlineNewTag(false);
                  }
                  if (e.key === 'Escape') setInlineNewTag(false);
                }}
                onBlur={() => setInlineNewTag(false)} aria-label="输入标签名称" />
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
                      }} aria-label="选中该标签" />

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
                          autoFocus className="manage-tag-edit-input" aria-label="标签名称" />
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

      {/* Bulk Delete Confirm —— 用 Modal（内置 Esc + 焦点陷阱 + 叠放栈），
          以前是手写 .modal-overlay，按 Esc 关不掉，还会和「管理标签」弹窗一起被关 */}
      <Modal
        open={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        title="确认批量删除"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowBulkDeleteConfirm(false)}>取消</button>
            <button className="btn btn-danger" onClick={handleBulkDelete}>确认删除</button>
          </>
        }
      >
        <div style={{ padding: '8px 0', textAlign: 'center' }}>
          <p style={{ marginBottom: 12 }}>确定要删除选中的 {selectedTags.size} 个标签吗？</p>
          <p className="text-sm text-muted">有网址使用的标签不会被删除</p>
        </div>
      </Modal>
    </>
  );
}

