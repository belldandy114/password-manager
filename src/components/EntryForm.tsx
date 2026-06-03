import React, { useState, useEffect, useRef } from 'react';
import type { PasswordEntry } from '../types';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  entry: PasswordEntry | null;
  tags: string[];
  onSave: (entry: PasswordEntry) => void;
  onClose: () => void;
}

const emptyEntry = (): PasswordEntry => ({
  id: '',
  name: '',
  envType: 'production',
  url: '',
  username: '',
  password: '',
  notes: '',
  tags: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export function EntryForm({ open, entry, tags, onSave, onClose }: Props) {
  const [form, setForm] = useState<PasswordEntry>(emptyEntry());
  const [showPassword, setShowPassword] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const tagBlurTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (open) {
      if (entry) {
        setForm({ ...entry, tags: entry.tags || [] });
      } else {
        setForm(emptyEntry());
      }
      setShowPassword(false);
      setTagInput('');
      setErrors({});
      setShowTagSuggestions(false);
    }
  }, [open, entry]);

  const update = (field: keyof PasswordEntry, value: any) => {
    setForm(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }));
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) { setTagInput(''); return; }
    setTagInput('');
    setForm(prev => {
      if (prev.tags.includes(t)) return prev;
      return { ...prev, tags: [...prev.tags, t] };
    });
  };

  const addSuggestedTag = (t: string) => {
    setForm(prev => {
      if (prev.tags.includes(t)) return prev;
      return { ...prev, tags: [...prev.tags, t] };
    });
  };

  const removeTag = (t: string) => {
    setForm(prev => ({
      ...prev,
      tags: prev.tags.filter(x => x !== t),
    }));
  };

  // Filter out already-selected tags for suggestions
  const availableTags = tags.filter(t => !form.tags.includes(t));
  const filteredSuggestions = tagInput.trim()
    ? availableTags.filter(t => t.toLowerCase().includes(tagInput.toLowerCase()))
    : [];

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = '请输入名称';
    if (!form.url.trim()) errs.url = '请输入URL';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;
    const now = new Date().toISOString();
    const saved: PasswordEntry = {
      ...form,
      id: form.id || crypto.randomUUID(),
      updatedAt: now,
      createdAt: form.createdAt || now,
      tags: form.tags || [],
    };
    onSave(saved);
  };

  return (
    <Modal open={open} onClose={onClose} title={entry ? '编辑网址' : '新增网址'} closeOnOverlay={false}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={handleSave}>保存</button>
        </>
      }
    >
      <div className="form-group">
        <label>名称 *</label>
        <input type="text" value={form.name} onChange={e => update('name', e.target.value)} placeholder="例如: 阿里云管理后台" autoFocus />
        {errors.name && <div className="input-hint" style={{ color: 'var(--danger)' }}>{errors.name}</div>}
      </div>

      <div className="form-group">
        <label>环境类型</label>
        <select value={form.envType} onChange={e => update('envType', e.target.value)}>
          <option value="production">正式</option>
          <option value="testing">测试</option>
          <option value="development">开发</option>
          <option value="staging">预发布</option>
        </select>
      </div>

      <div className="form-group">
        <label>URL *</label>
        <input type="url" value={form.url} onChange={e => update('url', e.target.value)} placeholder="https://example.com" />
        {errors.url && <div className="input-hint" style={{ color: 'var(--danger)' }}>{errors.url}</div>}
      </div>

      <div className="form-group">
        <label>账号</label>
        <input type="text" value={form.username} onChange={e => update('username', e.target.value)} placeholder="admin@example.com" />
        {errors.username && <div className="input-hint" style={{ color: 'var(--danger)' }}>{errors.username}</div>}
      </div>

      <div className="form-group">
        <label>密码</label>
        <div className="password-input-wrapper">
          <input type={showPassword ? 'text' : 'password'} value={form.password} onChange={e => update('password', e.target.value)} placeholder="输入密码" />
          <button className="password-toggle" onClick={() => setShowPassword(!showPassword)} type="button">
            {showPassword ? '🙈' : '👁'}
          </button>
        </div>
        {errors.password && <div className="input-hint" style={{ color: 'var(--danger)' }}>{errors.password}</div>}
      </div>

      <div className="form-group">
        <label>标签</label>
        <div className="tag-field-wrapper">
          <div className="tags-input" onClick={e => { (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus(); }}>
            {form.tags.map(t => (
              <span key={t} className="tag">
                {t}
                <span className="remove-tag" onClick={() => removeTag(t)}>&times;</span>
              </span>
            ))}
            <input
              type="text"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onFocus={() => {
                if (tagBlurTimerRef.current) clearTimeout(tagBlurTimerRef.current);
                setShowTagSuggestions(true);
              }}
              onBlur={() => {
                tagBlurTimerRef.current = setTimeout(() => setShowTagSuggestions(false), 200);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  // If input matches a suggestion, pick the first match
                  if (tagInput.trim() && filteredSuggestions.length > 0) {
                    addSuggestedTag(filteredSuggestions[0]);
                    setTagInput('');
                    return;
                  }
                  addTag();
                }
              }}
              placeholder={form.tags.length === 0 ? '输入标签后回车...' : ''}
            />
          </div>
          {showTagSuggestions && filteredSuggestions.length > 0 && (
            <div className="tag-suggestions">
              {filteredSuggestions.map(t => (
                <div key={t} className="tag-suggestion-item" onMouseDown={() => { addSuggestedTag(t); setTagInput(''); }}>{t}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="form-group">
        <label>备注</label>
        <textarea value={form.notes} onChange={e => update('notes', e.target.value)} placeholder="备注信息..." />
      </div>
    </Modal>
  );
}
