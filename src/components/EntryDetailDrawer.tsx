import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PasswordEntry } from '../types';
import { Icons } from './ui';
import { TotpBadge } from './EntryExtras';
import { copyPlain, copySensitive } from '../utils/clipboard';
import { openUrlInDefaultBrowser } from '../utils/openUrl';
import { formatDateTime } from '../utils/time';

/**
 * 条目详情抽屉（右侧滑出）。
 *
 * 为什么单独成组件：`Dashboard.tsx` 已经 900+ 行，详情逻辑再堆进去就彻底没法读了
 * （契约 §6 的风险条目）。这里只做**展示 + 复制 + 回调**，编辑/删除的弹窗仍归调用方，
 * 避免抽屉里再造一套写库路径。
 *
 * 复用 `components/BugDrawer.tsx` 的 `.drawer` 体系（同款遮罩/头部/正文/底栏类名），
 * 宽度在 `redesign.css` 末尾用 `.drawer.entry-drawer` 收到 460px —— 不改 `.drawer` 本体，
 * 否则缺陷管理的 BugDrawer 会被一起改窄。
 *
 * 安全口径（与卡片/编辑弹窗一致）：
 * - 密码**默认打码**，`open` 每次变 true 都复位；
 * - 密码与角色账号密码的复制**只走 `copySensitive`**（主进程定时清空剪贴板 + 写审计），
 *   不用 `copyPlain`；URL / 用户名才走普通复制；
 * - 不在这里读写的库结构，`entry` 由调用方从 store 取实时副本传进来。
 */
export interface EntryDetailDrawerProps {
  open: boolean;
  entry: PasswordEntry | null;
  /** 打开抽屉的元素：关闭后焦点还给它（`document.activeElement` 已丢失时兜底） */
  trigger: HTMLElement | null;
  onClose: () => void;
  /** 下面三个入口都是可选的：成员账号 tab 只借用只读展示，不传就整块不渲染 */
  onEdit?: (entry: PasswordEntry) => void;
  onDelete?: (entry: PasswordEntry) => void;
  onOpen?: (url: string) => void;
}

const ENV_LABEL: Record<string, string> = {
  production: '正式',
  testing: '测试',
  development: '开发',
  staging: '预发布',
};

/** 打码占位：与卡片/账号弹窗同一串（8 个圆点） */
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

export function EntryDetailDrawer({
  open, entry, trigger, onClose, onEdit, onDelete, onOpen,
}: EntryDetailDrawerProps) {
  /** 主密码是否明文展示；打开时复位成打码 */
  const [showPassword, setShowPassword] = useState(false);
  /** 角色账号里哪些密码已展示（按账号 id） */
  const [shownAccounts, setShownAccounts] = useState<Set<string>>(new Set());
  const [hint, setHint] = useState('');
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 打开前的焦点位置：关闭时归还 */
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  /**
   * onClose 常是内联箭头（每次渲染新引用）。放进 ref，effect 只随 open 跑，
   * 否则「关抽屉」的清理函数会在每次父组件重渲染时提前执行、把焦点抢回去。
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 打开：复位打码状态 + 记住焦点 + 把焦点移进抽屉；关闭/卸载：焦点归还
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement) || null;
    setShowPassword(false);
    setShownAccounts(new Set());
    setHint('');
    const raf = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      const back = restoreRef.current;
      // activeElement 还停在触发元素上就用它；否则（点到别处/程序化关闭）退回 trigger
      const target = back && back !== document.body && document.contains(back) ? back : trigger;
      if (target && document.contains(target)) {
        try { target.focus(); } catch { /* 元素可能已卸载 */ }
      }
    };
  }, [open, trigger]);

  // Esc 关闭。监听放冒泡阶段：Modal（确认框/编辑弹窗）在 document 捕获阶段就
  // preventDefault + stopPropagation，所以「弹窗盖在抽屉上」时 Esc 只关弹窗。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  const flash = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(''), 3000);
  }, []);

  if (!open || !entry) return null;

  const accounts = entry.accounts || [];
  const attachments = entry.attachments || [];
  const notes = String(entry.notes || '').trim();
  const tags = entry.tags || [];
  const envLabel = ENV_LABEL[entry.envType] || entry.envType;

  const copyText = async (text: string, label: string) => {
    if (!text) { flash(`这条没有填${label}`); return; }
    await copyPlain(text);
    flash(`${label}已复制`);
  };

  /** 敏感复制：走主进程定时清空 + 审计（与 Dashboard.handleCopy / OrphanAccounts 同一口径） */
  const copySecret = async (text: string, label: string) => {
    if (!text) { flash(`这条没有填${label}`); return; }
    const ok = await copySensitive(text, label);
    if (ok) window.electronAPI.auditLog?.(`复制${label}`, entry.name).catch(() => { /* 审计失败不影响复制 */ });
    flash(ok ? `${label}已复制，剪贴板稍后自动清空` : `${label}复制失败`);
  };

  const toggleAccount = (id: string) => {
    setShownAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer entry-drawer" aria-label={`「${entry.name}」详情`}>
        <header className="drawer-head">
          <div className="drawer-title">
            <div className="drawer-title-text" title={entry.name}>
              <span className="entry-detail-name">{entry.name}</span>
            </div>
            <div className="drawer-meta">
              <span className={`env-badge env-${entry.envType}`}>{envLabel}</span>
              {entry.favorite && <span className="chip" title="已收藏">★ 收藏</span>}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="ibtn"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <Icons.close size={14} />
          </button>
        </header>

        <div className="drawer-body">
          <dl className="drawer-kv">
            <div>
              <dt>网址</dt>
              <dd>
                <span className="cell-mono entry-detail-url" title={entry.url}>{entry.url || '—'}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="复制网址"
                  disabled={!entry.url}
                  onClick={() => void copyText(entry.url, '网址')}
                >复制</button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="打开网址"
                  disabled={!entry.url}
                  onClick={() => {
                    if (!entry.url) return;
                    if (onOpen) onOpen(entry.url);
                    else void openUrlInDefaultBrowser(entry.url);
                  }}
                ><Icons.extern size={12} /> 打开</button>
              </dd>
            </div>

            <div>
              <dt>用户名</dt>
              <dd>
                <span className="cell-mono" title={entry.username}>{entry.username || '—'}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="复制用户名"
                  disabled={!entry.username}
                  onClick={() => void copyText(entry.username, '用户名')}
                >复制</button>
              </dd>
            </div>

            <div>
              <dt>密码</dt>
              <dd>
                <span className="cell-mono entry-detail-pwd">
                  {showPassword ? (entry.password || '—') : MASK}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword(v => !v)}
                >{showPassword ? '隐藏' : '显示'}</button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label="复制密码"
                  disabled={!entry.password}
                  onClick={() => void copySecret(entry.password, '密码')}
                >复制</button>
              </dd>
            </div>

            <div>
              <dt>标签</dt>
              <dd>{tags.length > 0 ? tags.join('、') : '—'}</dd>
            </div>

            <div>
              <dt>备注</dt>
              <dd className="entry-detail-notes">{notes || '—'}</dd>
            </div>

            <div>
              <dt>附件</dt>
              <dd>{attachments.length} 个</dd>
            </div>

            <div>
              <dt>时间</dt>
              <dd>
                创建 {formatDateTime(entry.createdAt)}
                {entry.updatedAt ? ` · 更新 ${formatDateTime(entry.updatedAt)}` : ''}
              </dd>
            </div>
          </dl>

          {/* TOTP：没有绑定就整块不渲染（不占位） */}
          {entry.totpSecret && (
            <div className="drawer-section">
              <h5>两步验证</h5>
              <div className="entry-detail-totp">
                <TotpBadge secret={entry.totpSecret} showRemaining />
              </div>
            </div>
          )}

          <div className="drawer-section">
            <h5>其他角色账号（{accounts.length}）</h5>
            {accounts.length === 0 ? (
              <div className="drawer-hint">没有其他角色账号。在编辑弹窗或「成员账号」里添加。</div>
            ) : (
              <div className="role-acc-list">
                {accounts.map((a, i) => {
                  const role = a.role || `角色 ${i + 1}`;
                  const visible = shownAccounts.has(a.id);
                  return (
                    <div className="role-acc-row" key={a.id || `${role}-${i}`}>
                      <div className="role-acc-head">
                        <span className="role-acc-role">{role}</span>
                        {a.note && <span className="role-acc-note" title={a.note}>{a.note}</span>}
                      </div>
                      <div className="role-acc-line">
                        <span className="role-acc-label">账号</span>
                        <span className="role-acc-value" title={a.username}>{a.username || '--'}</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={`复制「${role}」的账号`}
                          disabled={!a.username}
                          onClick={() => void copyText(a.username, `${role}-账号`)}
                        >复制</button>
                      </div>
                      <div className="role-acc-line">
                        <span className="role-acc-label">密码</span>
                        <span className="role-acc-value role-acc-pwd">
                          {visible ? (a.password || '--') : MASK}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          title={visible ? '隐藏密码' : '显示密码'}
                          aria-label={`${visible ? '隐藏' : '显示'}「${role}」的密码`}
                          onClick={() => toggleAccount(a.id)}
                        >{visible ? '隐藏' : '显示'}</button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={`复制「${role}」的密码`}
                          disabled={!a.password}
                          onClick={() => void copySecret(a.password, `${role}-密码`)}
                        >复制</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {hint && <div className="drawer-hint-inline" role="status">{hint}</div>}
        </div>

        <footer className="drawer-foot">
          {onEdit && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(entry)}>
              <Icons.pencil size={12} /> 编辑
            </button>
          )}
          {onDelete && (
            <button type="button" className="btn btn-danger btn-sm" onClick={() => onDelete(entry)}>
              <Icons.trash size={12} /> 删除
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>关闭</button>
        </footer>
      </aside>
    </>
  );
}
