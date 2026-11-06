import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ZentaoProject } from '../types';
import { Icons } from './ui';

/**
 * 当前项目选择器：主体永远是原生 <select>（下拉框），旁边的放大镜点开一个
 * 小型搜索条；输入关键词会实时过滤下拉选项，方便在几十个项目里定位。
 *
 * 不用「自定义浮层列表」的原因：浮层受父容器定位/层级影响，容易出现
 * 「点开只见输入框、列表不显示」；原生 select 的展开行为最稳定。
 */
export function ProjectCombo({
  projects, value, onChange, allValue, allLabel, disabled,
}: {
  projects: ZentaoProject[];
  value: string;
  onChange: (id: string) => void;
  allValue?: string;
  allLabel?: string;
  disabled?: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return projects;
    return projects.filter(p =>
      String(p.name || '').toLowerCase().includes(k)
      || String(p.programName || '').toLowerCase().includes(k)
      || String(p.id).includes(k));
  }, [projects, q]);

  // 点外部 / Esc 收起搜索条（保留已输入的关键词，方便继续用下拉选）
  useEffect(() => {
    if (!searchOpen) return;
    const away = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setSearchOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [searchOpen]);

  const currentInList = list.some(p => String(p.id) === String(value));
  const label = (p: ZentaoProject) => p.programName ? `${p.programName} / ${p.name}` : p.name;

  return (
    <div className="project-combo" ref={rootRef}>
      <div className="project-combo-control">
        <button
          type="button"
          className={`project-combo-search-btn${q ? ' is-on' : ''}`}
          onClick={() => setSearchOpen(o => !o)}
          disabled={disabled}
          title="搜索定位项目（按名称 / 项目集 / 编号）"
          aria-label="搜索项目"
        >
          <Icons.search size={12} />
        </button>
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          title="当前项目：三个标签都按它统计"
        >
          {!currentInList && value && value !== allValue && (
            <option value={value}>{projects.find(p => String(p.id) === String(value))
              ? label(projects.find(p => String(p.id) === String(value))!)
              : `项目 ${value}`}</option>
          )}
          {list.map(p => (
            <option key={p.id} value={String(p.id)}>{label(p)}</option>
          ))}
          {allValue && <option value={allValue}>{allLabel || '全部项目（总览）'}</option>}
          {list.length === 0 && !value && <option value="">请选择项目</option>}
        </select>
      </div>

      {searchOpen && (
        <div className="project-combo-filter">
          <Icons.search size={12} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索项目名 / 项目集 / 编号"
            aria-label="过滤项目"
          />
          <span className="project-combo-count">{list.length} / {projects.length}</span>
          {q && (
            <button type="button" className="project-combo-clear" onClick={() => setQ('')} title="清空搜索">
              <Icons.close size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
