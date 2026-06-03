import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { PasswordEntry } from '../types';
import { useStore } from '../store/useStore';
import { BrowserMenu } from './BrowserMenu';
import { getTagHue } from '../utils/tagColors';

interface Props {
  entries: PasswordEntry[];
  onEdit: (entry: PasswordEntry) => void;
  onCopy: (text: string, label: string) => void;
}

/* ---------- helpers ---------- */

const envLabel: Record<string, string> = {
  production: '\u6B63\u5F0F',
  testing: '\u6D4B\u8BD5',
  development: '\u5F00\u53D1',
  staging: '\u9884\u53D1\u5E03',
};

/** Relative time format */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  if (diffDays < 0) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (diffDays === 0) return `\u4ECA\u5929 ${hhmm}`;           // 今天
  if (diffDays === 1) return `\u6628\u5929 ${hhmm}`;           // 昨天
  if (diffDays <= 7) return `${diffDays}\u5929\u524D`;         // X天前
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Truncate URL — show hostname + short path */
function shortenUrl(url: string, maxLen = 28): string {
  try {
    const u = new URL(url);
    let out = u.hostname;
    if (u.pathname && u.pathname !== '/') {
      const rest = u.pathname + u.search;
      out += rest.length > 8 ? rest.slice(0, 8) + '\u2026' : rest;
    }
    if (out.length > maxLen) out = out.slice(0, maxLen) + '\u2026';
    return out;
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen) + '\u2026' : url;
  }
}

/** Full precision time for tooltip */
function fullTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Search highlight */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !text) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

/* ---------- component ---------- */

export function EntryList({ entries, onEdit, onCopy }: Props) {
  const selectedIds = useStore(s => s.selectedIds);
  const toggleSelected = useStore(s => s.toggleSelected);
  const settings = useStore(s => s.settings);
  const searchQuery = useStore(s => s.searchQuery);
  const clearSelected = useStore(s => s.clearSelected);
  const selectAll = useStore(s => s.selectAll);

  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [hoverTagEntry, setHoverTagEntry] = useState<string | null>(null);
  const [recentCopy, setRecentCopy] = useState<{ id: string; field: string } | null>(null);
  const [sortField, setSortField] = useState<'name' | 'envType' | 'url' | 'username' | 'updatedAt'>('updatedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const copyTimerRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    return () => {
      timersRef.current.forEach(t => clearTimeout(t));
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const togglePassword = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setVisiblePasswords(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        const timer = timersRef.current.get(id);
        if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
      } else {
        next.add(id);
        const timer = setTimeout(() => {
          setVisiblePasswords(p => { const n = new Set(p); n.delete(id); return n; });
          timersRef.current.delete(id);
        }, settings.passwordAutoHideDelay * 1000);
        timersRef.current.set(id, timer);
      }
      return next;
    });
  }, [settings.passwordAutoHideDelay]);

  const handleCopyWithFeedback = useCallback((text: string, label: string, id: string, field: string) => {
    onCopy(text, label);
    setRecentCopy({ id, field });
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setRecentCopy(null), 2000);
  }, [onCopy]);

  const handleUrlOpen = useCallback((url: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (url) {
      window.electronAPI.browserOpen({ browser: '', url }).catch(() => {
        window.open(url, '_blank');
      });
    }
  }, []);

  const handleTagClick = useCallback((tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    useStore.getState().setFilterTags(new Set([tag]));
  }, []);

  const handleRowClick = useCallback((id: string) => {
    toggleSelected(id);
  }, [toggleSelected]);

  const isCopyFeedback = (id: string, field: string) =>
    recentCopy?.id === id && recentCopy?.field === field;

  const allSelected = entries.length > 0 && entries.every(e => selectedIds.has(e.id));

  /** Local sort — clicking column header cycles asc/desc on that field */
  const handleSort = useCallback((field: typeof sortField) => {
    setSortField(prev => {
      if (prev === field) {
        setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
        return prev;
      }
      setSortOrder('asc');
      return field;
    });
  }, []);

  const sortedEntries = useMemo(() => {
    const copy = [...entries];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'envType': cmp = (a.envType || '').localeCompare(b.envType || ''); break;
        case 'url': cmp = (a.url || '').localeCompare(b.url || ''); break;
        case 'username': cmp = (a.username || '').localeCompare(b.username || ''); break;
        case 'updatedAt': cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [entries, sortField, sortOrder]);

  const sortArrow = (field: typeof sortField): React.ReactNode => {
    if (sortField !== field) return null;
    return <span className="sort-arrow">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>;
  };

  return (
    <div className="entry-table-wrap" style={{ overflowX: 'auto', width: '100%' }}>
    <table className="entry-table">
      <thead>
        <tr>
          <th className="col-checkbox">
            <input type="checkbox" checked={allSelected}
              onChange={() => {
                if (allSelected) clearSelected();
                else selectAll(entries.map(e => e.id));
              }} />
          </th>
          <th className="col-name" onClick={() => handleSort('name')}>名称{sortArrow('name')}</th>
          <th className="col-env" onClick={() => handleSort('envType')}>环境{sortArrow('envType')}</th>
          <th className="col-url" onClick={() => handleSort('url')}>URL{sortArrow('url')}</th>
          <th className="col-username" onClick={() => handleSort('username')}>账号{sortArrow('username')}</th>
          <th className="col-password">密码</th>
          <th className="col-tags">标签</th>
          <th className="col-updated" onClick={() => handleSort('updatedAt')}>修改时间{sortArrow('updatedAt')}</th>
          <th className="col-actions">操作</th>
        </tr>
      </thead>
      <tbody>
        {sortedEntries.map(entry => {
          const isSelected = selectedIds.has(entry.id);
          const showPwd = visiblePasswords.has(entry.id);
          const showMore = openDropdown === entry.id;
          const showTags = hoverTagEntry === entry.id;
          const visibleTags = entry.tags.slice(0, 2);
          const hiddenCount = entry.tags.length - 2;

          return (
            <tr key={entry.id} className={isSelected ? 'selected' : ''}
              onClick={() => handleRowClick(entry.id)}>

              {/* Checkbox */}
              <td className="col-checkbox" onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={isSelected}
                  onChange={() => toggleSelected(entry.id)} />
              </td>

              {/* Name (bold) */}
              <td className="col-name">
                <span className="entry-name-link"
                  onClick={(e) => handleUrlOpen(entry.url, e)}
                  title={entry.name}>
                  {highlightText(entry.name, searchQuery)}
                </span>
              </td>

              {/* Env (icon + text, matching card mode) */}
              <td className="col-env">
                <span className={`env-badge-table env-${entry.envType}`}>
                  {envLabel[entry.envType] || entry.envType}
                </span>
              </td>

              {/* URL: truncated + clickable + copy icon on hover */}
              <td className="col-url" onClick={e => e.stopPropagation()}>
                <div className="url-cell">
                  <span className="url-display" title={entry.url}
                    onClick={(e) => handleUrlOpen(entry.url, e)}>
                    {highlightText(shortenUrl(entry.url), searchQuery)}
                  </span>
                  <button
                    className={`cell-icon-btn ${isCopyFeedback(entry.id, 'url') ? 'copied' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleCopyWithFeedback(entry.url, 'URL', entry.id, 'url'); }}
                    title="复制URL">
                    {isCopyFeedback(entry.id, 'url') ? '\u2705' : '\u{1F517}'}
                    {isCopyFeedback(entry.id, 'url') && <span className="copy-feedback-text">已复制</span>}
                  </button>
                </div>
              </td>

              {/* Username + copy icon */}
              <td className="col-username" onClick={e => e.stopPropagation()}>
                <div className="username-cell">
                  <span className="username-text" title={entry.username}>
                    {highlightText(entry.username || '--', searchQuery)}
                  </span>
                  <button
                    className={`cell-icon-btn ${isCopyFeedback(entry.id, 'username') ? 'copied' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleCopyWithFeedback(entry.username, '\u8D26\u53F7', entry.id, 'username'); }}
                    title="复制账号">
                    {isCopyFeedback(entry.id, 'username') ? '\u2705' : '\u{1F4CB}'}
                    {isCopyFeedback(entry.id, 'username') && <span className="copy-feedback-text">已复制</span>}
                  </button>
                </div>
              </td>

              {/* Password: dots + eye(show/hide) + copy */}
              <td className="col-password" onClick={e => e.stopPropagation()}>
                <div className="password-cell">
                  {showPwd ? (
                    <span className="password-visible">{entry.password}</span>
                  ) : (
                    <span className="password-dots">{'********'}</span>
                  )}
                  <button className="pwd-icon-btn" onClick={(e) => togglePassword(entry.id, e)}
                    title={showPwd ? '隐藏密码' : '显示密码'}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                      {showPwd ? (
                        <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
                      ) : (
                        <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                      )}
                    </svg>
                  </button>
                  <button className={`pwd-icon-btn ${isCopyFeedback(entry.id, 'password') ? 'copied' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleCopyWithFeedback(entry.password, '\u5BC6\u7801', entry.id, 'password'); }}
                    title="复制密码">
                    {isCopyFeedback(entry.id, 'password') ? (
                      <><span>{'\u2705'}</span><span className="copy-feedback-text">已复制</span></>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    )}
                  </button>
                </div>
              </td>

              {/* Tags: max 2 + N hover popover */}
              <td className="col-tags">
                <div className="tags-cell"
                  onMouseEnter={() => setHoverTagEntry(entry.id)}
                  onMouseLeave={() => setHoverTagEntry(null)}>
                  {visibleTags.map(t => (
                    <span key={t} className="tag-inline tag-clickable" style={{ '--tag-hue': getTagHue(t) } as React.CSSProperties}
                      onClick={(e) => handleTagClick(t, e)}>{highlightText(t, searchQuery)}</span>
                  ))}
                  {hiddenCount > 0 && (
                    <span className="tag-more" style={{ position: 'relative' }}>
                      +{hiddenCount}
                      {showTags && (
                        <div className="tag-popover">
                          {entry.tags.slice(2).map(t => (
                            <span key={t} className="tag-inline tag-clickable" style={{ '--tag-hue': getTagHue(t) } as React.CSSProperties}
                              onClick={(e) => handleTagClick(t, e)}>{t}</span>
                          ))}
                        </div>
                      )}
                    </span>
                  )}
                </div>
              </td>

              {/* Time: relative format + full on hover */}
              <td className="col-updated">
                <span className="time-text" title={fullTime(entry.updatedAt)}>
                  {formatTime(entry.updatedAt)}
                </span>
              </td>

              {/* Actions: ✏️ + ⋮ dropdown */}
              <td className="col-actions" onClick={e => e.stopPropagation()}>
                <div className="action-cell">
                  <button className="action-btn" onClick={(e) => { e.stopPropagation(); onEdit(entry); }} title="编辑">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                  <div className="action-more-btn" style={{ position: 'relative' }}
                    onClick={() => setOpenDropdown(showMore ? null : entry.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15">
                      <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
                    </svg>
                    {showMore && (
                      <div className="action-dropdown" onClick={e => e.stopPropagation()}>
                        <div className="action-dropdown-item" onClick={() => {
                          const info = '名称：' + entry.name + '\nURL：' + entry.url + '\n账号：' + entry.username + '\n密码：' + entry.password;
                          handleCopyWithFeedback(info, '全部信息', entry.id, 'all-dropdown');
                          setOpenDropdown(null);
                        }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M12 11v6"/><path d="M9 14l3 3 3-3"/>
                          </svg>
                          复制全部信息
                        </div>
                        <div className="action-dropdown-sep" />
                        <div className="action-dropdown-item" onClick={async () => {
                          if (!window.confirm('\u786E\u5B9A\u8981\u5220\u9664\u8BE5\u7F51\u5740\u5417\uFF1F\u5220\u9664\u540E\u53EF\u5728\u56DE\u6536\u7AD9\u6062\u590D')) return;
                          const result = await window.electronAPI.entriesDelete({ ids: [entry.id], permanent: false });
                          if (result.success && result.data) {
                            useStore.getState().setVaultData(result.data);
                          }
                          setOpenDropdown(null);
                        }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                          </svg>
                          移入回收站
                        </div>
                        <div className="action-dropdown-item danger" onClick={async () => {
                          if (!window.confirm('\u786E\u5B9A\u8981\u5F7B\u5E95\u5220\u9664\u8BE5\u7F51\u5740\u5417\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500')) return;
                          const result = await window.electronAPI.entriesDelete({ ids: [entry.id], permanent: true });
                          if (result.success && result.data) {
                            useStore.getState().setVaultData(result.data);
                          }
                          setOpenDropdown(null);
                        }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
                          </svg>
                          删除
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
