import React, { useState, useEffect, useRef } from 'react';
import type { PasswordEntry } from '../types';
import { useStore } from '../store/useStore';
import { BrowserMenu } from './BrowserMenu';

interface Props {
  entry: PasswordEntry;
  onEdit: (entry: PasswordEntry) => void;
  onCopy: (text: string, label: string) => void;
}

const envLabel: Record<string, string> = {
  production: '\u6B63\u5F0F',   // 正式
  testing: '\u6D4B\u8BD5',      // 测试
  development: '\u5F00\u53D1',  // 开发
  staging: '\u9884\u53D1\u5E03', // 预发布
};

export function EntryCard({ entry, onEdit, onCopy }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const selected = useStore(s => s.selectedIds.has(entry.id));
  const toggleSelected = useStore(s => s.toggleSelected);
  const settings = useStore(s => s.settings);
  const timerRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (showPassword) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setShowPassword(false), settings.passwordAutoHideDelay * 1000);
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [showPassword, settings.passwordAutoHideDelay]);

  return (
    <div className={`entry-card ${selected ? 'selected' : ''}`} onClick={() => toggleSelected(entry.id)}>
      {/* Row 1: Title + Env badge */}
      <div className="card-header">
        <span className="card-title">{entry.name}</span>
        <span className={`env-badge env-${entry.envType}`}>
          {envLabel[entry.envType] || entry.envType}
        </span>
      </div>

      {/* Row 2: URL */}
      <div className="card-url-row">
        <span className="card-url" title={entry.url}>{entry.url}</span>
        <BrowserMenu url={entry.url} />
      </div>

      {/* Row 3: Tags — icon prefix + comma separated */}
      {entry.tags.length > 0 && (
        <div className="card-tags">
          <span className="card-tags-icon">{'\u{1F3F7}\uFE0F'}</span>
          <span className="card-tags-text">{entry.tags.join(', ')}</span>
        </div>
      )}

      {/* Row 4: Account + Password — icon-only prefixes, eye next to password */}
      <div className="card-credential-row">
        <span className="cred-account">
          {'\u{1F464}'} {entry.username || '--'}
        </span>
        <span className="cred-gap">{'  '}</span>
        <span className="cred-password-wrapper">
          {'\u{1F511}'}
          <span className={`cred-password ${showPassword ? 'visible' : ''}`}>
            {showPassword ? (entry.password || '--') : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
          </span>
          <button
            className="cred-eye-btn"
            onClick={e => { e.stopPropagation(); setShowPassword(!showPassword); }}
            title={showPassword ? '隐藏密码' : '显示密码'}
          >
            {showPassword ? '\u{1F648}' : '\u{1F441}'}
          </button>
        </span>
      </div>

      {/* Row 5: Action buttons — icon only, right-aligned */}
      <div className="card-actions">
        <button onClick={e => { e.stopPropagation(); onCopy(entry.url, 'URL'); }} title="复制URL">{'\u{1F517}'}</button>
        <button onClick={e => { e.stopPropagation(); onCopy(entry.username, '\u8D26\u53F7'); }} title="复制账号">{'\u{1F464}'}</button>
        <button className="copy-password" onClick={e => { e.stopPropagation(); onCopy(entry.password, '\u5BC6\u7801'); }} title="复制密码">{'\u{1F511}'}</button>
        <button onClick={e => { e.stopPropagation(); onEdit(entry); }} title="编辑">{'\u270F\uFE0F'}</button>
      </div>
    </div>
  );
}
