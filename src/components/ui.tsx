import React from 'react';
import {
  IconSearch, IconPlus, IconPencil, IconTrash, IconCopy, IconEye, IconEyeOff,
  IconLink, IconExternalLink, IconServer, IconKey, IconCheck, IconList,
  IconDatabase, IconFileText, IconBug, IconTool, IconTerminal2, IconLock,
  IconClock, IconDownload, IconChartBar, IconRefresh, IconX, IconChevronRight,
  IconTag, IconInbox, IconFolder,
} from '@tabler/icons-react';

/* ================================================================
   工作台页面共用的 UI 原子组件
   —— 统一页面骨架、面板、表格、徽标、图标按钮，
      让新增的 8 个页面看起来像同一个产品里的东西。
   ================================================================ */

type IconProps = { size?: number; className?: string; stroke?: number | string; style?: React.CSSProperties };

export type IconComponent = React.ComponentType<IconProps>;

/** 统一图标：Tabler（ISC），1.8 描边与旧手写图标同视觉重量 */
const icon = (C: React.ComponentType<IconProps>): React.ComponentType<IconProps> =>
  function T({ size = 15, className }: IconProps) {
    return <C size={size} className={className} stroke={1.8} style={{ flex: 'none' }} />;
  };

export const Icons = {
  search: icon(IconSearch),
  plus: icon(IconPlus),
  pencil: icon(IconPencil),
  trash: icon(IconTrash),
  copy: icon(IconCopy),
  eye: icon(IconEye),
  eyeOff: icon(IconEyeOff),
  link: icon(IconLink),
  extern: icon(IconExternalLink),
  server: icon(IconServer),
  key: icon(IconKey),
  check: icon(IconCheck),
  list: icon(IconList),
  db: icon(IconDatabase),
  note: icon(IconFileText),
  bug: icon(IconBug),
  tool: icon(IconTool),
  terminal: icon(IconTerminal2),
  lock: icon(IconLock),
  clock: icon(IconClock),
  download: icon(IconDownload),
  chart: icon(IconChartBar),
  refresh: icon(IconRefresh),
  close: icon(IconX),
  chevron: icon(IconChevronRight),
  tag: icon(IconTag),
  inbox: icon(IconInbox),
  folder: icon(IconFolder),
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
          role={collapsible ? 'button' : undefined}
          tabIndex={collapsible ? 0 : undefined}
          aria-expanded={collapsible ? open : undefined}
          onClick={collapsible ? () => setOpen(o => !o) : undefined}
          onKeyDown={collapsible ? (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(o => !o);
            }
          } : undefined}
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
  icon, title, desc, action, compact, hint,
}: {
  icon?: React.ReactNode;
  title: string;
  desc?: string;
  action?: React.ReactNode;
  compact?: boolean;
  /** 下一步引导：告诉用户从哪里开始、或给一个快捷键 */
  hint?: React.ReactNode;
}) {
  return (
    <div className="empty" style={compact ? { padding: '32px 20px' } : undefined}>
      <div className="empty-ico" style={compact ? { width: 44, height: 44, borderRadius: 13 } : undefined}>
        {icon || <Icons.inbox size={22} />}
      </div>
      <div className="empty-title">{title}</div>
      {desc && <div className="empty-desc">{desc}</div>}
      {hint && <div className="empty-hint">{hint}</div>}
      {action}
    </div>
  );
}

/**
 * 长任务进度条：不确定进度时给一条持续的细条 + 当前动作说明，
 * 避免禅道抓取、Excel 导出这类耗时操作看起来像「卡死了」。
 */
export function BusyProgress({ active, label }: { active: boolean; label?: string }) {
  if (!active) return null;
  return (
    <div className="busy-progress" role="status" aria-live="polite" aria-label={label || '正在处理'}>
      <div className="busy-progress-track"><div className="busy-progress-bar" /></div>
      {label && <span className="busy-progress-label">{label}</span>}
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
