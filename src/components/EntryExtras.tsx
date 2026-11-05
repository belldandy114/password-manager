import React, { useCallback, useEffect, useState } from 'react';
import type { PasswordEntry, PasswordHistoryItem, CustomField, Attachment } from '../types';

interface Props {
  form: PasswordEntry;
  onChange: (patch: Partial<PasswordEntry>) => void;
  isEditing: boolean;
}

/** TOTP 动态码预览（每 30 秒刷新） */
function TotpPreview({ secret }: { secret: string }) {
  const [code, setCode] = useState('');
  const [remain, setRemain] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await window.electronAPI.totpCode({ secret });
      if (!alive) return;
      if (res.success && res.data) {
        setCode(res.data.code);
        setRemain(res.data.remain);
        setError('');
      } else {
        setError(res.error || '密钥无效');
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [secret]);

  if (error) return <div className="input-hint" style={{ color: 'var(--danger)' }}>{error}</div>;

  return (
    <div className="totp-preview">
      <span className="totp-code">{code || '------'}</span>
      <span className="text-sm text-muted">{remain}s 后刷新</span>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={() => navigator.clipboard.writeText(code)}
      >
        复制验证码
      </button>
    </div>
  );
}

/** 列表/卡片上的精简动态码，点击复制 */
export function TotpBadge({ secret, onCopy }: { secret: string; onCopy?: (code: string) => void }) {
  const [code, setCode] = useState('');
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const res = await window.electronAPI.totpCode({ secret });
      if (alive && res.success && res.data) setCode(res.data.code);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [secret]);

  if (!code) return null;
  return (
    <span
      className="totp-badge"
      title="两步验证码，点击复制"
      onClick={e => {
        e.stopPropagation();
        if (onCopy) onCopy(code);
        else navigator.clipboard.writeText(code);
      }}
    >
      🔐 {code}
    </span>
  );
}

export function EntryExtras({ form, onChange, isEditing }: Props) {
  const [history, setHistory] = useState<PasswordHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const fields = form.customFields || [];
  const attachments = form.attachments || [];

  useEffect(() => {
    if (!isEditing || !form.id) return;
    window.electronAPI.historyGet(form.id).then(res => {
      if (res.success && res.data) setHistory(res.data);
    });
  }, [isEditing, form.id]);

  const addField = useCallback(() => {
    const next: CustomField = { id: crypto.randomUUID(), name: '', value: '', secret: false };
    onChange({ customFields: [...fields, next] });
  }, [fields, onChange]);

  const updateField = (id: string, patch: Partial<CustomField>) => {
    onChange({ customFields: fields.map(f => (f.id === id ? { ...f, ...patch } : f)) });
  };

  const removeField = (id: string) => {
    onChange({ customFields: fields.filter(f => f.id !== id) });
  };

  const pickAttachment = async () => {
    const res = await window.electronAPI.attachmentPick();
    if (!res.success || !res.data) return;
    onChange({ attachments: [...attachments, res.data as Attachment] });
  };

  const removeAttachment = async (att: Attachment) => {
    await window.electronAPI.attachmentDelete({ id: att.id });
    onChange({ attachments: attachments.filter(a => a.id !== att.id) });
  };

  return (
    <>
      {/* TOTP */}
      <div className="form-group">
        <div className="field-label-row">
          <label>两步验证（TOTP）</label>
        </div>
        <input
          type="text"
          value={form.totpSecret || ''}
          onChange={e => onChange({ totpSecret: e.target.value.trim() })}
          placeholder="可选：粘贴 Base32 密钥，如 JBSWY3DPEHPK3PXP"
        />
        {form.totpSecret ? <TotpPreview secret={form.totpSecret} /> : (
          <div className="input-hint">配置后可在列表里直接查看 6 位动态验证码</div>
        )}
      </div>

      {/* 自定义字段 */}
      <div className="form-group">
        <div className="field-label-row">
          <label>自定义字段</label>
          <button type="button" className="btn btn-sm btn-secondary" onClick={addField}>+ 添加字段</button>
        </div>
        {fields.length === 0 && <div className="input-hint">可添加“安全问题”“API Key”“二级密码”等任意字段</div>}
        {fields.map(f => (
          <div key={f.id} className="custom-field-row">
            <input
              type="text" value={f.name} placeholder="字段名"
              onChange={e => updateField(f.id, { name: e.target.value })}
            />
            <input
              type={f.secret ? 'password' : 'text'} value={f.value} placeholder="值"
              onChange={e => updateField(f.id, { value: e.target.value })}
            />
            <label className="gen-check" title="按密码处理（默认隐藏）">
              <input type="checkbox" checked={!!f.secret} onChange={e => updateField(f.id, { secret: e.target.checked })} />
              保密
            </label>
            <button type="button" className="btn-icon-danger" onClick={() => removeField(f.id)} title="删除字段">×</button>
          </div>
        ))}
      </div>

      {/* 附件 */}
      <div className="form-group">
        <div className="field-label-row">
          <label>附件</label>
          <button type="button" className="btn btn-sm btn-secondary" onClick={pickAttachment}>+ 添加附件</button>
        </div>
        {attachments.length === 0 && <div className="input-hint">可上传密钥文件、证书等，内容会加密存储在本地（单个 ≤ 20MB）</div>}
        {attachments.map(att => (
          <div key={att.id} className="attachment-row">
            <span className="attachment-name" title={att.name}>{att.name}</span>
            <span className="text-sm text-muted">{(att.size / 1024).toFixed(0)} KB</span>
            <button type="button" className="btn btn-sm btn-secondary"
              onClick={() => window.electronAPI.attachmentOpen({ id: att.id, name: att.name })}>
              打开
            </button>
            <button type="button" className="btn-icon-danger" onClick={() => removeAttachment(att)} title="删除附件">×</button>
          </div>
        ))}
      </div>

      {/* 密码历史 */}
      {isEditing && history.length > 0 && (
        <div className="form-group">
          <div className="field-label-row">
            <label>密码历史（{history.length}）</label>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowHistory(v => !v)}>
              {showHistory ? '收起' : '查看'}
            </button>
          </div>
          {showHistory && history.map((h, i) => (
            <div key={i} className="history-row">
              <code>{h.password}</code>
              <span className="text-sm text-muted">{new Date(h.changedAt).toLocaleString('zh-CN')}</span>
              <button type="button" className="btn btn-sm btn-secondary"
                onClick={() => onChange({ password: h.password })}>
                回滚
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
