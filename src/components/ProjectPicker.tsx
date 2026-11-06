import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ZentaoProject } from '../types';
import { Icons } from './ui';

/**
 * 当前项目选择器：可搜索、可多选，交互与「安全问题提交人」保持一致。
 *
 * - 默认不选任何项目；选中后才由宿主加载数据
 * - 浮层用 position:fixed + JS 定位，避开祖先 overflow:hidden 的裁切
 * - 支持按项目名 / 项目集名 / 编号搜索，以及全选 / 清空
 */
export function ProjectPicker({
  projects, value, onChange, placeholder, disabled,
}: {
  projects: ZentaoProject[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const idOf = (p: ZentaoProject) => String(p.id);
  const labelOf = (p: ZentaoProject) => p.programName ? `${p.programName} / ${p.name}` : p.name;

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return projects;
    return projects.filter(p =>
      String(p.name || '').toLowerCase().includes(k)
      || String(p.programName || '').toLowerCase().includes(k)
      || String(p.id).includes(k));
  }, [projects, q]);

  const selected = useMemo(
    () => value.map(id => projects.find(p => idOf(p) === id)).filter(Boolean) as ZentaoProject[],
    [value, projects],
  );

  // 触发框恒定单行：最多露出 2 个名字，其余折叠成 "+N"，避免选得越多越高
  const visible = selected.slice(0, 2);
  const rest = selected.length - visible.length;
  const fullTitle = selected.length
    ? `已选 ${selected.length} 个项目：\n${selected.map(p => `· ${labelOf(p)}`).join('\n')}\n\n点击展开可搜索、多选或清空`
    : '点击展开，可按项目名 / 项目集 / 编号搜索并多选';

  // fixed 定位：跟随触发按钮，下方空间不够时向上展开
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const useAbove = below < 240 && above > below;
      const room = Math.max(180, Math.min(340, useAbove ? above : below));
      setPos({
        left: r.left,
        width: Math.max(280, r.width),
        maxHeight: room,
        ...(useAbove
          ? { top: 'auto', bottom: window.innerHeight - r.top + 6 }
          : { top: r.bottom + 6, bottom: 'auto' }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  };

  return (
    <div className="person-picker project-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`person-picker-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={fullTitle}
        aria-label={selected.length ? `当前项目：已选 ${selected.length} 个` : '当前项目：未选择'}
      >
        {selected.length === 0 ? (
          <span className="person-picker-placeholder">
            {placeholder || `从 ${projects.length} 个项目中选择`}
          </span>
        ) : (
          <span className="person-picker-chips">
            {visible.map(p => (
              <span
                key={p.id}
                className={`person-picker-chip${visible.length === 1 ? ' is-single' : ''}`}
                title={labelOf(p)}
              >{p.name}</span>
            ))}
            {rest > 0 && <span className="person-picker-more">+{rest}</span>}
          </span>
        )}
        <span className="person-picker-caret">▾</span>
      </button>

      {open && (
        <div className="person-picker-pop" style={pos} role="listbox" aria-label="选择项目">
          <div className="person-picker-search">
            <Icons.search size={12} />
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="搜索项目名 / 项目集 / 编号"
              aria-label="搜索项目"
            />
            <span className="person-picker-count">{list.length} / {projects.length}</span>
          </div>
          <div className="project-picker-actions">
            <button type="button" onClick={() => onChange(projects.map(idOf))}>全选</button>
            <button type="button" onClick={() => onChange([])}>清空</button>
            <span>已选 {value.length} 个</span>
          </div>
          <div className="person-picker-list">
            {list.length === 0 && <div className="person-picker-none">没有匹配的项目</div>}
            {list.map(p => {
              const on = value.includes(idOf(p));
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`person-picker-item${on ? ' is-on' : ''}`}
                  onClick={() => toggle(idOf(p))}
                  title={`#${p.id} ${labelOf(p)}`}
                >
                  <span className="person-picker-check">{on ? <Icons.check size={11} /> : null}</span>
                  <span className="project-picker-id">#{p.id}</span>
                  <span className="person-picker-name">{labelOf(p)}</span>
                  {on && <span className="person-picker-tag">已选</span>}
                </button>
              );
            })}
          </div>
          <div className="person-picker-foot">选择一个或多个项目后才会加载数据 · Esc 关闭</div>
        </div>
      )}
    </div>
  );
}
