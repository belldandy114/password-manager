import React, { useState, useEffect, useRef } from 'react';
import type { PasswordEntry, PasswordGenOptions } from '../types';
import { Modal } from './Modal';
import { EntryExtras } from './EntryExtras';
import { passwordStrength } from '../utils/security';

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
  const tagBlurTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 密码生成器
  const [showGen, setShowGen] = useState(false);
  const [genOpts, setGenOpts] = useState<PasswordGenOptions>({
    length: 16, upper: true, lower: true, digits: true, symbols: true, excludeAmbiguous: true,
  });
  const [genPreview, setGenPreview] = useState('');

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

  const applyPatch = (patch: Partial<PasswordEntry>) => setForm(prev => ({ ...prev, ...patch }));

  // 每次改动选项或展开时重新生成（主进程用 crypto 保证随机性）
  const regenerate = async () => {
    const result = await window.electronAPI.passwordGenerate(genOpts);
    if (result.success && result.data) setGenPreview(result.data);
  };

  useEffect(() => {
    if (showGen) regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGen, genOpts.length, genOpts.upper, genOpts.lower, genOpts.digits, genOpts.symbols, genOpts.excludeAmbiguous]);

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
        <div className="field-label-row">
          <label>名称 *</label>
          <label className="favorite-toggle" title="收藏后排在列表最前">
            <input type="checkbox" checked={!!form.favorite} onChange={e => update('favorite', e.target.checked)} />
            ★ 收藏
          </label>
        </div>
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
        <div className="field-label-row">
          <label>密码</label>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowGen(v => !v)}>
            {showGen ? '收起生成器' : '🎲 生成'}
          </button>
        </div>
        <div className="password-input-wrapper">
          <input type={showPassword ? 'text' : 'password'} value={form.password} onChange={e => update('password', e.target.value)} placeholder="输入密码" />
          <button className="password-toggle" onClick={() => setShowPassword(!showPassword)} type="button">
            {showPassword ? '🙈' : '👁'}
          </button>
        </div>
        {form.password && (
          <div className={`pw-strength pw-strength-${passwordStrength(form.password).score}`}>
            <span className="pw-strength-bar"><i style={{ width: `${(passwordStrength(form.password).score / 4) * 100}%` }} /></span>
            <span>{passwordStrength(form.password).label}</span>
            {passwordStrength(form.password).reasons.length > 0 && (
              <span className="text-muted">（{passwordStrength(form.password).reasons.join('、')}）</span>
            )}
          </div>
        )}
        {errors.password && <div className="input-hint" style={{ color: 'var(--danger)' }}>{errors.password}</div>}

        {showGen && (
          <div className="password-gen-panel">
            <div className="gen-preview">
              <code>{genPreview || '生成中…'}</code>
              <button type="button" className="btn btn-sm btn-secondary" onClick={regenerate} title="重新生成">↻</button>
            </div>
            <div className="gen-row">
              <span>长度</span>
              <input
                type="range" min={8} max={64} value={genOpts.length || 16}
                onChange={e => setGenOpts(o => ({ ...o, length: Number(e.target.value) }))}
              />
              <span className="gen-len">{genOpts.length}</span>
            </div>
            <div className="gen-checks">
              {([
                ['upper', '大写 A-Z'],
                ['lower', '小写 a-z'],
                ['digits', '数字 0-9'],
                ['symbols', '符号 !@#'],
                ['excludeAmbiguous', '排除易混 Il1O0'],
              ] as const).map(([key, label]) => (
                <label key={key} className="gen-check">
                  <input
                    type="checkbox"
                    checked={!!genOpts[key]}
                    onChange={e => setGenOpts(o => ({ ...o, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="gen-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!genPreview || !(genOpts.lower !== false || genOpts.upper !== false || genOpts.digits !== false || genOpts.symbols)}
                onClick={() => { update('password', genPreview); setShowGen(false); }}
              >
                使用此密码
              </button>
            </div>
          </div>
        )}
      </div>

      <EntryExtras form={form} onChange={applyPatch} isEditing={!!entry} />

      <div className="form-group">
        <label>标签</label>
        <div className="tag-field-wrapper">          <div className="tags-input" onClick={e => { (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus(); }}>
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
