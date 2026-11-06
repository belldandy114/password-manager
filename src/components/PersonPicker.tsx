import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from './ui';

/**
 * 可搜索的多选人员下拉。
 * 汇总「安全问题提交人」用：选项来自当前项目缺陷的创建人（openedBy），
 * 支持按名字搜索、点击勾选/取消，已选的人以 chip 展示。
 *
 * 浮层用 position:fixed + JS 定位：祖先 .zt-sumbar 有 overflow:hidden
 * （为了圆角），绝对定位的浮层会被它裁掉，表现为「列表显示不全」。
 */
export function PersonPicker({
  options, value, onChange, placeholder,
}: {
  options: string[];
  value: string[];
  onChange: (names: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const all = Array.from(new Set([...value, ...options])).filter(Boolean);
    const k = q.trim().toLowerCase();
    const shown = k ? all.filter(n => n.toLowerCase().includes(k)) : all;
    return shown.sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [options, value, q]);

  // 浮层定位：跟随触发按钮，下方空间不够时向上展开
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const useAbove = below < 240 && above > below;
      const room = Math.max(160, Math.min(320, useAbove ? above : below));
      setPos({
        left: r.left,
        width: Math.max(240, r.width),
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

  const toggle = (name: string) => {
    onChange(value.includes(name) ? value.filter(n => n !== name) : [...value, name]);
  };

  return (
    <div className="person-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`person-picker-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="点击展开，可按姓名搜索并多选"
      >
        {value.length === 0 ? (
          <span className="person-picker-placeholder">{placeholder || '请选择人员'}</span>
        ) : (
          <span className="person-picker-chips">
            {value.map(n => <span key={n} className="person-picker-chip">{n}</span>)}
          </span>
        )}
        <span className="person-picker-caret">▾</span>
      </button>

      {open && (
        <div className="person-picker-pop" style={pos} role="listbox" aria-label="选择人员">
          <div className="person-picker-search">
            <Icons.search size={12} />
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="搜索姓名"
              aria-label="搜索姓名"
            />
            <span className="person-picker-count">{list.length} 人</span>
          </div>
          <div className="person-picker-list">
            {list.length === 0 && <div className="person-picker-none">没有匹配的创建人</div>}
            {list.map(n => {
              const on = value.includes(n);
              return (
                <button
                  key={n}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`person-picker-item${on ? ' is-on' : ''}`}
                  onClick={() => toggle(n)}
                >
                  <span className="person-picker-check">{on ? <Icons.check size={11} /> : null}</span>
                  <span className="person-picker-name">{n}</span>
                  {on && <span className="person-picker-tag">已选</span>}
                </button>
              );
            })}
          </div>
          <div className="person-picker-foot">
            已选 {value.length} 人 · 共 {list.length} 位创建人 · 点击名称可取消 · Esc 关闭
          </div>
        </div>
      )}
    </div>
  );
}
