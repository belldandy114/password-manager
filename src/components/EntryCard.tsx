import React, { useState, useEffect, useRef } from 'react';
import type { PasswordEntry, EntryAccount } from '../types';
import { useStore } from '../store/useStore';
import { BrowserMenu } from './BrowserMenu';
import { TotpBadge } from './EntryExtras';
import { Modal } from './Modal';
import { Icons } from './ui';
import { openUrlInDefaultBrowser } from '../utils/openUrl';
import { recordEntryUse } from '../utils/recent';
/** 非 button 元素的键盘激活：Enter / Space 触发自身 click（复用原 onClick） */
const onKeyClick = (e: React.KeyboardEvent<HTMLElement>) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
};
/** 容器内还有按钮时，只在焦点落在容器本身才响应，避免按内部按钮误触发 */
const onKeyClickStrict = (e: React.KeyboardEvent<HTMLElement>) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
};


interface Props {
  entry: PasswordEntry;
  onEdit: (entry: PasswordEntry) => void;
  onCopy: (text: string, label: string, entryName?: string) => void;
  /** 用默认浏览器打开网址；不传就直接走 IPC（失败时由 utils/openUrl 兜底复制） */
  onOpen?: (url: string) => void;
  /** 安全体检标记：弱密码 / 重复密码 */
  security?: { weak: boolean; duplicate: boolean };
  onToggleFavorite?: (entry: PasswordEntry) => void;
  /**
   * 点卡片主体 / Enter / Space 打开详情抽屉。
   * `trigger` 是卡片元素本身：抽屉关闭后要把焦点还给它（可访问性验收项）。
   */
  onOpenDetail?: (entry: PasswordEntry, trigger: HTMLElement) => void;
}

const envLabel: Record<string, string> = {
  production: '\u6B63\u5F0F',   // 正式
  testing: '\u6D4B\u8BD5',      // 测试
  development: '\u5F00\u53D1',  // 开发
  staging: '\u9884\u53D1\u5E03', // 预发布
};

/**
 * 多角色账号面板。
 *
 * 以前卡片上的 `+N` 只在 `title` 里拼了一串角色名 —— 鼠标悬停能看到，但**复制不了**，
 * 用户还得点进编辑弹窗翻。这里把每个角色的账号/密码都摆出来，各自带复制按钮。
 *
 * 用 `Modal` 而不是手写 popover：项目硬约束「Esc 必须能关掉一切浮层」，
 * Modal 已内置 Esc + 焦点陷阱 + 叠放栈（内层先关）。
 */
function AccountsModal({
  open, onClose, entry, onCopy,
}: {
  open: boolean;
  onClose: () => void;
  entry: PasswordEntry;
  onCopy: (text: string, label: string, entryName?: string) => void;
}) {
  const accounts = entry.accounts || [];
  /** 按账号 id 记录「密码已显示」，默认全部打码 */
  const [shown, setShown] = useState<Set<string>>(new Set());

  // 每次重新打开都复位成打码状态，避免上次点开的密码一直露着
  useEffect(() => {
    if (open) setShown(new Set());
  }, [open]);

  const toggle = (id: string) => {
    setShown(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`「${entry.name}」的其他角色账号（${accounts.length}）`}
      footer={<button className="btn btn-secondary" onClick={onClose}>关闭</button>}
    >
      <div className="role-acc-list">
        {accounts.map((a: EntryAccount, i) => {
          const role = a.role || `角色 ${i + 1}`;
          const visible = shown.has(a.id);
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
                  disabled={!a.username}
                  // label 用「角色-账号」，审计日志里能区分是哪个角色被复制
                  onClick={() => onCopy(a.username, `${role}-账号`, entry.name)}
                >复制</button>
              </div>
              <div className="role-acc-line">
                <span className="role-acc-label">密码</span>
                <span className="role-acc-value role-acc-pwd">
                  {visible ? (a.password || '--') : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => toggle(a.id)}
                  title={visible ? '隐藏密码' : '显示密码'}
                >{visible ? '隐藏' : '显示'}</button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!a.password}
                  onClick={() => onCopy(a.password, `${role}-密码`, entry.name)}
                >复制</button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function EntryCard({ entry, onEdit, onCopy, onOpen, security, onToggleFavorite, onOpenDetail }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const selected = useStore(s => s.selectedIds.has(entry.id));
  const toggleSelected = useStore(s => s.toggleSelected);
  const settings = useStore(s => s.settings);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (showPassword) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setShowPassword(false), settings.passwordAutoHideDelay * 1000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [showPassword, settings.passwordAutoHideDelay]);

  const attachments = entry.attachments || [];
  const customFields = entry.customFields || [];
  const notes = String(entry.notes || '').trim();
  /** 备注悬浮提示：前 80 字，太长会撑爆 tooltip */
  const notesTitle = notes ? (notes.length > 80 ? `${notes.slice(0, 80)}…` : notes) : '';

  return (
    <>
    <div
      className={`entry-card ${selected ? 'selected' : ''}`}
      /* 卡片主体 = 打开详情抽屉（契约 §3.1）。多选入口只剩左上角勾选框，
         所以这里不再切换 selectedIds —— 「选 ≠ 看」，两者别混在一个动作里。
         recordEntryUse 仍留在这里：点开详情就是「用过这条」，
         scripts/ui-round17-test.js 也按这个动作验「最近」条。 */
      onClick={(e) => { recordEntryUse(entry.id); onOpenDetail?.(entry, e.currentTarget); }}
      tabIndex={0}
      onKeyDown={onKeyClickStrict}
    >
      {/* Row 1: Title + Env badge */}
      <div className="card-header">
        {/* 勾选框：卡片里**唯一**改 selectedIds 的元素。
            放流内第一个子元素 = 左上角；绝对定位会压住同一行的收藏 ★。
            label 上的 stopPropagation 让点它不会冒泡成「打开详情」。 */}
        <label className="entry-card-check" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => toggleSelected(entry.id)}
            onClick={e => e.stopPropagation()}
            aria-label={`选择 ${entry.name}`}
          />
        </label>
        {onToggleFavorite && (
          <button
            className={`fav-btn ${entry.favorite ? 'active' : ''}`}
            title={entry.favorite ? '取消收藏' : '收藏（置顶）'}
            onClick={e => { e.stopPropagation(); onToggleFavorite(entry); }}
          >
            ★
          </button>
        )}
        <span className="card-title">{entry.name}</span>
        {security?.weak && <span className="sec-flag sec-flag-weak" title="弱密码，建议更换">弱</span>}
        {security?.duplicate && <span className="sec-flag sec-flag-dup" title="与其他网址共用了同一个密码">重</span>}
        <span className={`env-badge env-${entry.envType}`}>
          {envLabel[entry.envType] || entry.envType}
        </span>
      </div>

      {/* Row 2: URL —— 地址本身可点（打开默认浏览器），旁边单独给「复制网址」，别再让人猜图标 */}
      <div className="card-url-row">
        <button
          type="button"
          className="card-url"
          title={`${entry.url}\n点击用默认浏览器打开`}
          onClick={e => {
            e.stopPropagation();
            if (!entry.url) return;
            if (onOpen) onOpen(entry.url);
            else void openUrlInDefaultBrowser(entry.url);
          }}
        >
          {entry.url}
        </button>
        <button
          type="button"
          className="card-url-copy"
          title="复制网址（复制的是 URL，不是名称）"
          aria-label="复制网址"
          onClick={e => { e.stopPropagation(); onCopy(entry.url, 'URL', entry.name); }}
        >
          <Icons.copy size={13} />
        </button>
        <BrowserMenu url={entry.url} />
      </div>

      {/* Row 3: Tags — icon prefix + comma separated */}
      {entry.tags.length > 0 && (
        <div className="card-tags">
          <span className="card-tags-icon"><Icons.tag size={12} /></span>
          <span className="card-tags-text">{entry.tags.join(', ')}</span>
        </div>
      )}

      {/* Row 3.5: TOTP 动态验证码 */}
      {entry.totpSecret && (
        <div className="card-totp-row">
          <TotpBadge secret={entry.totpSecret} onCopy={code => onCopy(code, '两步验证码', entry.name)} />
        </div>
      )}

      {/* Row 3.6: 附件 / 自定义字段 / 备注 —— 一行小字，不撑高卡片。
          以前这三样在卡片上完全不可见，用户不知道条目里还挂着证书、API Key 或备注。 */}
      {(attachments.length > 0 || customFields.length > 0 || notes) && (
        <div className="card-meta-row">
          {attachments.length > 0 && (
            <span className="card-meta-item" title={attachments.map(a => a.name).join('、')}>
              <Icons.clip size={12} />{attachments.length}
            </span>
          )}
          {customFields.length > 0 && (
            <span
              className="card-meta-item"
              title={customFields.map(f => `${f.name}${f.secret ? '（保密）' : ''}`).join('、')}
            >
              <Icons.list size={12} />
              {customFields.slice(0, 2).map(f => f.name || '未命名字段').join('、')}
              {customFields.length > 2 ? ` +${customFields.length - 2}` : ''}
            </span>
          )}
          {notes && (
            <span className="card-meta-item card-meta-notes" title={notesTitle}>
              <Icons.note size={12} />{notesTitle}
            </span>
          )}
        </div>
      )}

      {/* Row 4: Account + Password — icon-only prefixes, eye next to password */}
      <div className="card-credential-row">
        <span className="cred-account">
          <Icons.user size={13} /> {entry.username || '--'}
          {(entry.accounts?.length || 0) > 0 && (
            <button
              type="button"
              className="cred-more"
              title={`还有 ${entry.accounts!.length} 个角色账号，点击查看并复制`}
              aria-label={`查看 ${entry.accounts!.length} 个其他角色账号`}
              onClick={e => { e.stopPropagation(); setShowAccounts(true); }}
            >
              +{entry.accounts!.length}
            </button>
          )}
        </span>
        <span className="cred-gap">{'  '}</span>
        <span className="cred-password-wrapper">
          <Icons.key size={13} />
          <span className={`cred-password ${showPassword ? 'visible' : ''}`}>
            {showPassword ? (entry.password || '--') : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
          </span>
          <button
            className="cred-eye-btn"
            onClick={e => { e.stopPropagation(); setShowPassword(!showPassword); }}
            title={showPassword ? '隐藏密码' : '显示密码'}
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
          >
            {showPassword ? <Icons.eyeOff size={14} /> : <Icons.eye size={14} />}
          </button>
        </span>
      </div>

      {/* Row 5: Action buttons — icon only, right-aligned */}
      <div className="card-actions">
        <button onClick={e => { e.stopPropagation(); onCopy(entry.url, 'URL'); }} title="复制URL"><Icons.link size={13} /></button>
        <button onClick={e => { e.stopPropagation(); onCopy(entry.username, '\u8D26\u53F7'); }} title="复制账号"><Icons.user size={13} /></button>
        <button className="copy-password" onClick={e => { e.stopPropagation(); onCopy(entry.password, '\u5BC6\u7801'); }} title="复制密码"><Icons.key size={13} /></button>
        <button onClick={e => { e.stopPropagation(); onEdit(entry); }} title="编辑"><Icons.pencil size={13} /></button>
        <button
          onClick={e => { e.stopPropagation(); void window.electronAPI.pinOpen(entry.id); }}
          title="钉成小窗（浮在桌面上看）"
          aria-label="钉成小窗"
        ><Icons.pin size={13} /></button>
      </div>

      {/* 多角色账号面板：Esc 由 Modal 内置处理。
          放在卡片 div 外面 —— Modal 是 fixed 全屏遮罩，嵌在卡片里点遮罩会冒泡到卡片的
          onClick（选中/取消选中），关个弹窗顺手把条目选中状态也翻了。 */}
    </div>
    <AccountsModal
      open={showAccounts}
      onClose={() => setShowAccounts(false)}
      entry={entry}
      onCopy={onCopy}
    />
    </>
  );
}

