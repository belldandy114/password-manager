import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { Icons } from './ui';
import { applyTheme, applyAccent, applyDensity, watchSystemTheme } from '../utils/theme';
import { PAGES, PAGES_MORE, TOOLBOX_TOOLS, KIND_LABEL, type Kind } from './CommandPalette';

interface Cmd {
  id: string;
  title: string;
  sub?: string;
  kind: Kind;
}

/**
 * 独立快速搜索窗（Ctrl+空格）：窗口里只有命令面板本身，不显示主界面。
 * 数据每次弹出时通过 IPC 现取（entries:get-all / ws:get），选中后通过
 * palette:run 交给主窗口执行 —— 这里不复制任何业务逻辑。
 */
export function PaletteApp() {
  // 主题跟着设置走（zustand persist 同源共享，直接用）
  const themeMode = useStore(s => s.settings.theme);
  const accentColor = useStore(s => s.settings.accent);
  const density = useStore(s => s.settings.density);
  useEffect(() => {
    applyTheme(themeMode);
    if (themeMode !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [themeMode]);
  useEffect(() => { applyAccent(accentColor); }, [accentColor]);
  useEffect(() => { applyDensity(density); }, [density]);

  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [locked, setLocked] = useState(false);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [er, sn, nt, ac, rq, ck, ev] = await Promise.all([
        window.electronAPI.entriesGetAll?.(),
        window.electronAPI.wsGet('snippets'),
        window.electronAPI.wsGet('notes'),
        window.electronAPI.wsGet('accounts'),
        window.electronAPI.wsGet('apiRequests'),
        window.electronAPI.wsGet('checklists'),
        window.electronAPI.wsGet('environments'),
      ]);
      if (!er || !er.success || !er.data) {
        setLocked(true);
        setCmds([]);
        return;
      }
      setLocked(false);
      // 和 CommandPalette 一样按宽松类型处理（字段全靠运行时数据）
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pick = (r: any): any[] => (r && r.success ? r.data || [] : []);
      const vault = er.data as unknown as { entries?: any[] };
      const list: Cmd[] = [
        ...[...PAGES, ...PAGES_MORE].map(p => ({ id: `page:${p.page}`, title: p.label, sub: '打开页面', kind: 'page' as Kind })),
        ...TOOLBOX_TOOLS.map(t => ({ id: `toolbox:${t.id}`, title: t.label, sub: `工具箱 · ${t.kw}`, kind: 'action' as Kind })),
        { id: 'action:new-entry', title: '新建网址', sub: '相当于 Ctrl+N', kind: 'action' },
        { id: 'action:lock', title: '锁定密码库', sub: '立即锁屏', kind: 'action' },
        { id: 'action:zt-refresh', title: '刷新：我的 Bug', sub: '重新拉缺陷管理「我的 Bug」', kind: 'action' },
        { id: 'action:weekly-draft', title: '生成周报草稿', sub: '用禅道「我的 Bug」生成本周草稿', kind: 'action' },
        { id: 'action:theme', title: '切换深浅主题', sub: '立即切换界面配色', kind: 'action' },
        ...((vault.entries || []).slice(0, 400).map((e: any) => ({
          id: `entry:${e.id}`,
          title: String(e.name || ''),
          sub: [e.username, e.url].filter(Boolean).join(' · '),
          kind: 'entry' as Kind,
        }))),
        ...pick(sn).slice(0, 200).map((s: any) => ({
          id: `snippet:${s.id}`, title: String(s.title || '（无标题片段）'), sub: (s.tags || []).join(' '), kind: 'snippet' as Kind,
        })),
        ...pick(nt).slice(0, 200).map((n: any) => ({
          id: `note:${n.id}`, title: String(n.title || '（无标题笔记）'), sub: '', kind: 'note' as Kind,
        })),
        ...pick(ac).slice(0, 200).map((a: any) => ({
          id: `account:${a.id}`, title: `${a.system || '未分组'} · ${a.username || ''}`, sub: String(a.role || ''), kind: 'account' as Kind,
        })),
        ...pick(rq).slice(0, 200).map((r: any) => ({
          id: `request:${r.id}`,
          title: (r.name && r.name !== '未命名') ? String(r.name) : `${r.method || 'GET'} ${String(r.url || '').replace(/^https?:\/\//, '')}`.slice(0, 70),
          sub: `${r.method || 'GET'} ${String(r.url || '').replace(/^https?:\/\//, '').slice(0, 60)}`,
          kind: 'request' as Kind,
        })),
        ...pick(ck).slice(0, 200).map((c: any) => ({
          id: `checklist:${c.id}`, title: String(c.title || '（无标题用例）'), sub: (c.items || []).length ? `${(c.items as any[]).length} 项` : '', kind: 'checklist' as Kind,
        })),
        ...pick(ev).slice(0, 200).map((e: any) => ({
          id: `env:${e.id}`, title: `${e.system || '未命名'} · ${e.env || ''}`.trim(), sub: String(e.url || '').slice(0, 70), kind: 'env' as Kind,
        })),
      ];
      setCmds(list);
    } catch {
      setLocked(true);
    }
  }, []);

  // 弹出时主进程会喊一嗓子，顺便初次加载
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const off = window.electronAPI.onPaletteRefresh?.(() => { void load(); });
    return () => { try { off?.(); } catch { /* 忽略 */ } };
  }, [load]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // 这个窗口的 body 必须是透明的（CSS 里有 html.palette-root 规则）
  useEffect(() => {
    document.documentElement.classList.add('palette-root');
    return () => document.documentElement.classList.remove('palette-root');
  }, []);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return cmds.filter(c => c.kind === 'page' || c.kind === 'action').slice(0, 40);
    return cmds
      .filter(c => `${c.title} ${c.sub || ''}`.toLowerCase().includes(key))
      .slice(0, 60);
  }, [cmds, q]);

  useEffect(() => { setIdx(0); }, [q]);

  const run = useCallback((c: Cmd) => {
    void window.electronAPI.paletteRun({ id: c.id, title: c.title });
    setQ('');
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); void window.electronAPI.paletteHide(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const c = filtered[idx];
      if (c) run(c);
      else if (locked) void window.electronAPI.paletteUnlock();
    }
  }, [filtered, idx, run, locked]);

  // 滚动到选中项
  useEffect(() => {
    const el = listRef.current?.querySelector('.cmdk-item.is-active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx, filtered]);

  return (
    <div className="palette-root">
      <div className="cmdk" role="dialog" aria-label="快速搜索">
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
          {locked ? (
            <div className="cmdk-empty">
              密码库还没解锁，先回主窗口解锁
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => void window.electronAPI.paletteUnlock()}>
                  去解锁
                </button>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="cmdk-empty">没有匹配项</div>
          ) : filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cmdk-item${i === idx ? ' is-active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(c)}
            >
              <span className="cmdk-kind">{KIND_LABEL[c.kind]}</span>
              <span className="cmdk-title">{c.title}</span>
              {c.sub && <span className="cmdk-sub">{c.sub}</span>}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭</span>
          <span>{locked ? '未解锁' : `${filtered.length} 项`}</span>
        </div>
      </div>
    </div>
  );
}
