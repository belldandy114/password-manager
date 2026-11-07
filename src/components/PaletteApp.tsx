import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from './ui';
import { applyTheme, applyAccent, applyDensity, watchSystemTheme } from '../utils/theme';
import { PAGES, TOOLBOX_TOOLS, KIND_LABEL, type Kind } from './CommandPalette';

interface Cmd {
  id: string;
  title: string;
  sub?: string;
  kind: Kind;
  /** 网址条目的 URL：选中后直接交给默认浏览器打开 */
  url?: string;
}

/** 空查询时窗口只有一个搜索框；有结果时按条数撑高（主进程会 clamp） */
const MIN_H = 96;
const ROW_H = 36;
const MAX_ROWS = 10;

function desiredHeight(count: number): number {
  if (count === 0) return MIN_H;
  return MIN_H + Math.min(count, MAX_ROWS) * ROW_H + 34; // 34 = 底部提示行
}

/**
 * 独立快速搜索窗（Ctrl+空格）：窗口里只有搜索框，输入后才出结果。
 * - 主题不读 zustand（新窗口里可能还没完成异步 rehydrate），直接走 settings:get 与主窗口一致。
 * - 数据每次弹出时通过 IPC 现取（entries:get-all / ws:get），选中后通过 palette:run 交给主进程。
 */
export function PaletteApp() {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [locked, setLocked] = useState(false);
  const [cmds, setCmds] = useState<Cmd[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const unwatchThemeRef = useRef<(() => void) | null>(null);

  // ---- 主题：以主进程的设置为准，每次弹出都重取一次 ----
  const applyPrefs = useCallback(async () => {
    try {
      // 先清掉上次的监听，避免每次弹出都叠一个
      unwatchThemeRef.current?.();
      unwatchThemeRef.current = null;
      const prefs = await window.electronAPI.settingsGet();
      if (!prefs) return;
      applyTheme(prefs.theme);
      applyAccent(prefs.accent);
      applyDensity(prefs.density);
      if (prefs.theme === 'system') unwatchThemeRef.current = watchSystemTheme(() => applyTheme('system'));
    } catch { /* 拿不到就用默认主题 */ }
  }, []);
  useEffect(() => {
    void applyPrefs();
    return () => { unwatchThemeRef.current?.(); unwatchThemeRef.current = null; };
  }, [applyPrefs]);

  // ---- 数据 ----
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
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pick = (r: any): any[] => (r && r.success ? r.data || [] : []);
      const vault = er.data as unknown as { entries?: any[] };
      // 注意：CommandPalette 里 `PAGES.push(...PAGES_MORE)`，PAGES 已包含全部页面，
      // 这里只能展开 PAGES，再展开 PAGES_MORE 会重复；末尾统一按 id 去重兜底。
      const list: Cmd[] = [
        ...PAGES.map(p => ({ id: `page:${p.page}`, title: p.label, sub: '打开页面', kind: 'page' as Kind })),
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
          url: String(e.url || ''),
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
      // 按 id 去重：重复 key 会让 React 在结果变化时留下上一屏的残留行
      const seen = new Set<string>();
      const unique = list.filter(c => {
        if (!c.id || seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      setCmds(unique);
    } catch {
      setLocked(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const off = window.electronAPI.onPaletteRefresh?.(() => {
      setQ('');            // 每次弹出都是干净的搜索框，不带上次结果
      setIdx(0);
      // 物理高度主动收回去：q 本来就是空时，下面的 resize effect 因依赖没变不会触发
      void window.electronAPI.paletteResize?.(MIN_H);
      void applyPrefs();   // 主窗口里刚换的主题也要跟上
      void load();
    });
    return () => { try { off?.(); } catch { /* 忽略 */ } };
  }, [applyPrefs, load]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // 这个窗口的 body 必须是透明的（CSS 里有 html.palette-root 规则）
  useEffect(() => {
    document.documentElement.classList.add('palette-root');
    return () => document.documentElement.classList.remove('palette-root');
  }, []);

  // 空查询不显示任何菜单项；输入后才出结果
  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return [];
    return cmds
      .filter(c => `${c.title} ${c.sub || ''}`.toLowerCase().includes(key))
      .slice(0, 20);
  }, [cmds, q]);

  useEffect(() => { setIdx(0); }, [q]);

  // 结果条数 / 查询内容变了就调整窗口高度：空查询时只留搜索框
  useEffect(() => {
    void window.electronAPI.paletteResize?.(desiredHeight(filtered.length + (locked ? 1 : 0)));
  }, [filtered.length, locked, q]);

  const run = useCallback((c: Cmd) => {
    void window.electronAPI.paletteRun({ id: c.id, title: c.title, url: c.url });
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
        {/* 空查询时只有搜索框本身，不渲染任何菜单项 */}
        {locked ? (
          <div className="cmdk-list" ref={listRef}>
            <div className="cmdk-empty">
              密码库还没解锁，先回主窗口解锁
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={() => void window.electronAPI.paletteUnlock()}>
                  去解锁
                </button>
              </div>
            </div>
          </div>
        ) : q.trim() !== '' ? (
          <>
            <div className="cmdk-list" ref={listRef}>
              {filtered.length === 0 ? (
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
              <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
              <span>{filtered.length} 项</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
