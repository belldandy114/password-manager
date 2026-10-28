import React from 'react';

/* ================================================================
   工作台页面共用的 UI 原子组件
   —— 统一页面骨架、面板、表格、徽标、图标按钮，
      让新增的 8 个页面看起来像同一个产品里的东西。
   ================================================================ */

type IconProps = { size?: number; className?: string };

const svg = (path: React.ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ size = 15, className }: IconProps) {
    return (
      <svg width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor"
        strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className}
        aria-hidden="true" style={{ flex: 'none' }}>
        {path}
      </svg>
    );
  };

export const Icons = {
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>),
  plus: svg(<><path d="M12 5v14M5 12h14" /></>),
  pencil: svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  trash: svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v5M14 11v5" /></>),
  copy: svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>),
  eye: svg(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>),
  eyeOff: svg(<><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.4 0 10 7 10 7a17 17 0 0 1-3 4" /><path d="M6.2 6.7A17 17 0 0 0 2 13s3.6 7 10 7a9.6 9.6 0 0 0 3.9-.8" /><path d="M3 3l18 18" /></>),
  link: svg(<><path d="M10 13a5 5 0 0 0 7.5.5l2-2A5 5 0 0 0 12.5 4l-1 1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2A5 5 0 0 0 11.5 20l1-1" /></>),
  extern: svg(<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>),
  server: svg(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>),
  key: svg(<><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3" /><path d="M17 6l2.5 2.5M14 9l2 2" /></>),
  check: svg(<><path d="m4 12 5 5L20 6" /></>),
  list: svg(<><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>),
  db: svg(<><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>),
  note: svg(<><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5" /><path d="M8 13h7M8 17h5" /></>),
  bug: svg(<><rect x="7" y="7" width="10" height="12" rx="4" /><path d="M9 6a3 3 0 0 1 6 0" /><path d="M3 11h4M17 11h4M3 17h4M17 17h4M12 19v3" /></>),
  tool: svg(<><path d="M14.5 4.5a4.5 4.5 0 0 0 5.7 5.7l-9 9-4.4 1.3 1.3-4.4 9-9a4.5 4.5 0 0 0-2.6-2.6Z" /></>),
  terminal: svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 2.5 2.5L7 14" /><path d="M13 15h4" /></>),
  lock: svg(<><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>),
  refresh: svg(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>),
  close: svg(<><path d="M6 6l12 12M18 6L6 18" /></>),
  chevron: svg(<><path d="m9 6 6 6-6 6" /></>),
  tag: svg(<><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z" /><circle cx="7.5" cy="7.5" r="1.2" /></>),
  inbox: svg(<><path d="M3 12h5l2 3h4l2-3h5" /><path d="M4.6 5h14.8l1.6 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l1.6-7Z" /></>),
};

/* ---------------- 页面骨架 ---------------- */

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="pg">{children}</div>;
}

export function PageHead({
  icon, title, desc, tools,
}: {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
  tools?: React.ReactNode;
}) {
  return (
    <div className="pg-head">
      <div className="pg-head-l">
        <h2 className="pg-title">
          {icon && <span className="pg-ico">{icon}</span>}
          {title}
        </h2>
        {desc && <div className="pg-sub">{desc}</div>}
      </div>
      {tools && <div className="pg-tools">{tools}</div>}
    </div>
  );
}

/* ---------------- 面板 ---------------- */

export function Panel({
  title, meta, tools, children, flush, foot, collapsible, defaultOpen = true,
}: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  tools?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  foot?: React.ReactNode;
  /** 可折叠：标题栏整行可点，右侧出现箭头 */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const showed = !collapsible || open;

  return (
    <section className={`pnl${collapsible && !open ? ' is-collapsed' : ''}`}>
      {(title || tools) && (
        <header
          className={`pnl-head${collapsible ? ' is-clickable' : ''}`}
          onClick={collapsible ? () => setOpen(o => !o) : undefined}
        >
          {collapsible && (
            <span className={`pnl-caret${open ? ' is-open' : ''}`}>
              <Icons.chevron size={13} />
            </span>
          )}
          {title && <div className="pnl-title">{title}</div>}
          {meta !== undefined && meta !== null && <span className="pnl-meta">{meta}</span>}
          {tools && <div className="pnl-tools" onClick={e => e.stopPropagation()}>{tools}</div>}
        </header>
      )}
      {showed && <div className={flush ? 'pnl-body flush' : 'pnl-body'}>{children}</div>}
      {showed && foot && <div className="pnl-foot">{foot}</div>}
    </section>
  );
}

/* ---------------- 空状态 ---------------- */

export function Empty({
  icon, title, desc, action, compact,
}: {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="empty" style={compact ? { padding: '32px 20px' } : undefined}>
      <div className="empty-ico" style={compact ? { width: 44, height: 44, borderRadius: 13 } : undefined}>
        {icon || <Icons.inbox size={22} />}
      </div>
      <div className="empty-title">{title}</div>
      {desc && <div className="empty-desc">{desc}</div>}
      {action}
    </div>
  );
}

/* ---------------- 徽标 ---------------- */

export type PillTone = 'ok' | 'warn' | 'bad' | 'info' | 'mute';

export function Pill({ tone = 'mute', dot, children }: { tone?: PillTone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot && <span className="pill-dot" />}
      {children}
    </span>
  );
}

/* ---------------- 图标按钮 ---------------- */

export function IconBtn({
  title, onClick, danger, active, children, size = 14,
}: {
  title: string;
  onClick?: (e: React.MouseEvent) => void;
  danger?: boolean;
  active?: boolean;
  children?: React.ReactNode;
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`ibtn${danger ? ' is-danger' : ''}${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children ?? <Icons.chevron size={size} />}
    </button>
  );
}

/* ---------------- 搜索框 ---------------- */

export function SearchBox({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search">
      <span className="search-ico"><Icons.search size={14} /></span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

/* ---------------- 表单字段 ---------------- */

export function Field({
  label, children, hint,
}: {
  label?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-label" style={{ fontWeight: 400 }}>{hint}</span>}
    </div>
  );
}
