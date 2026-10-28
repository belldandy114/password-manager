import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { Icons } from './ui';
import { applyTheme } from '../utils/theme';

type Kind = 'page' | 'action' | 'entry' | 'snippet' | 'note' | 'account';

interface Cmd {
  id: string;
  title: string;
  sub?: string;
  kind: Kind;
  run: () => void;
}

const KIND_LABEL: Record<Kind, string> = {
  page: '页面', action: '操作', entry: '网址', snippet: '片段', note: '笔记', account: '账号',
};

const PAGES: { page: string; label: string }[] = [
  { page: 'passwordManager', label: '网址管理' },
  { page: 'accounts', label: '测试账号' },
  { page: 'weeklyReport', label: '周报' },
  { page: 'snippets', label: 'SQL 片段' },
  { page: 'notes', label: '测试笔记' },
  { page: 'zentao', label: '禅道' },
  { page: 'dataGenerator', label: '测试数据' },
  { page: 'jsonConverter', label: 'JSON 转化' },
  { page: 'toolbox', label: '工具箱' },
  { page: 'apiClient', label: '接口调试' },
  { page: 'settings', label: '设置' },
];

/**
 * 全局命令面板（Ctrl+K）：一处搜页面 / 网址 / 片段 / 笔记 / 账号。
 * 只在打开时读一次扩展数据，避免常驻内存。
 */
export function CommandPalette({
  open, onClose, onNavigate, onLock,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: string) => void;
  onLock: () => void;
}) {
  const entries = useStore(s => s.entries);
  const setSearchQuery = useStore(s => s.setSearchQuery);
  const setPmSubPage = useStore(s => s.setPmSubPage);
  const signalNewEntry = useStore(s => s.signalNewEntry);
  const signalCmd = useStore(s => s.signalCmd);
  const settings = useStore(s => s.settings);
  const updateSettings = useStore(s => s.updateSettings);

  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [extra, setExtra] = useState<{ snippets: any[]; notes: any[]; accounts: any[] }>({ snippets: [], notes: [], accounts: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    setTimeout(() => inputRef.current?.focus(), 30);
    (async () => {
      const [sn, nt, ac] = await Promise.all([
        window.electronAPI.wsGet('snippets'),
        window.electronAPI.wsGet('notes'),
        window.electronAPI.wsGet('accounts'),
      ]);
      setExtra({
        snippets: sn.success ? sn.data || [] : [],
        notes: nt.success ? nt.data || [] : [],
        accounts: ac.success ? ac.data || [] : [],
      });
    })();
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      ...PAGES.map(p => ({
        id: `page:${p.page}`,
        title: p.label,
        sub: '打开页面',
        kind: 'page' as Kind,
        run: () => onNavigate(p.page),
      })),
      {
        id: 'action:new-entry',
        title: '新建网址',
        sub: '相当于 Ctrl+N',
        kind: 'action',
        run: () => { onNavigate('passwordManager'); setPmSubPage('dashboard'); signalNewEntry(); },
      },
      { id: 'action:lock', title: '锁定密码库', sub: '立即锁屏', kind: 'action', run: onLock },
      {
        id: 'action:zt-refresh',
        title: '刷新：我的 Bug',
        sub: '重新拉禅道「我的 Bug」',
        kind: 'action',
        run: () => { onNavigate('zentao'); signalCmd('zentao:refresh-mine'); },
      },
      {
        id: 'action:weekly-draft',
        title: '生成周报草稿',
        sub: '用禅道「我的 Bug」生成本周草稿',
        kind: 'action',
        run: () => { onNavigate('weeklyReport'); signalCmd('weekly:draft'); },
      },
      {
        id: 'action:theme',
        title: settings.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        sub: '立即切换界面配色',
        kind: 'action',
        run: () => {
          const next = settings.theme === 'dark' ? 'light' : 'dark';
          applyTheme(next);
          updateSettings({ theme: next });
          window.electronAPI.settingsSave({ theme: next });
        },
      },
      { id: 'action:zentao', title: '禅道：我的 Bug', sub: '打开禅道页', kind: 'action', run: () => onNavigate('zentao') },
      { id: 'action:api', title: '发一个接口请求', sub: '打开接口调试', kind: 'action', run: () => onNavigate('apiClient') },
    ];

    const fromEntries: Cmd[] = entries.slice(0, 400).map(e => ({
      id: `entry:${e.id}`,
      title: e.name,
      sub: [e.username, e.url].filter(Boolean).join(' · '),
      kind: 'entry' as Kind,
      run: () => {
        onNavigate('passwordManager');
        setPmSubPage('dashboard');
        setSearchQuery(e.name);
      },
    }));

    const fromSnippets: Cmd[] = extra.snippets.slice(0, 200).map((s: any) => ({
      id: `snippet:${s.id}`,
      title: s.title || '（无标题片段）',
      sub: (s.tags || []).join(' '),
      kind: 'snippet' as Kind,
      run: () => onNavigate('snippets'),
    }));

    const fromNotes: Cmd[] = extra.notes.slice(0, 200).map((n: any) => ({
      id: `note:${n.id}`,
      title: n.title || '（无标题笔记）',
      sub: '',
      kind: 'note' as Kind,
      run: () => onNavigate('notes'),
    }));

    const fromAccounts: Cmd[] = extra.accounts.slice(0, 200).map((a: any) => ({
      id: `account:${a.id}`,
      title: `${a.system || '未分组'} · ${a.username || ''}`,
      sub: a.role || '',
      kind: 'account' as Kind,
      run: () => onNavigate('accounts'),
    }));

    return [...base, ...fromEntries, ...fromSnippets, ...fromNotes, ...fromAccounts];
  }, [entries, extra, onNavigate, onLock, setSearchQuery, setPmSubPage, signalNewEntry, signalCmd, settings.theme, updateSettings]);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) {
      // 没输入时只列页面与操作，保持清爽
      return cmds.filter(c => c.kind === 'page' || c.kind === 'action').slice(0, 40);
    }
    return cmds
      .filter(c => `${c.title} ${c.sub || ''}`.toLowerCase().includes(key))
      .slice(0, 60);
  }, [cmds, q]);

  useEffect(() => { setIdx(0); }, [q]);

  // 焦点不在输入框（点过列表）时 Esc 也要能关
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const runAt = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    onClose();
    setTimeout(() => c.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); runAt(idx); }
  };

  return (
    <>
      <div className="cmdk-mask" onClick={onClose} />
      <div className="cmdk" role="dialog" aria-label="命令面板">
        <div className="cmdk-search">
          <Icons.search size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、网址、片段、笔记…"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk-empty">没有匹配项</div>
          ) : filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cmdk-item${i === idx ? ' is-active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => runAt(i)}
            >
              <span className={`cmdk-kind is-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <span className="cmdk-title">{c.title}</span>
              {c.sub && <span className="cmdk-sub">{c.sub}</span>}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
          <span>{filtered.length} 项</span>
        </div>
      </div>
    </>
  );
}
