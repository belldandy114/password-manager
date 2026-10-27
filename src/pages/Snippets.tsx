import React, { useMemo, useState } from 'react';
import type { Snippet } from '../types';
import { useCollection, PageHeader, EmptyHint } from '../hooks/useCollection';
import { Modal } from '../components/Modal';

const emptySnippet = (): Snippet => ({
  id: '', title: '', sql: '', tags: [], updatedAt: new Date().toISOString(),
});

export function Snippets() {
  const { items, save, loading } = useCollection<Snippet>('snippets');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [copied, setCopied] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? items.filter(s => [s.title, s.sql, (s.tags || []).join(' ')].some(v => (v || '').toLowerCase().includes(q)))
      : items;
    return [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [items, search]);

  const saveEditing = async () => {
    if (!editing || !editing.title.trim()) return;
    const entry: Snippet = { ...editing, id: editing.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
    setTagInput('');
  };

  const remove = async (id: string) => {
    if (!confirm('确定删除这个片段？')) return;
    await save(items.filter(i => i.id !== id));
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied('已复制到剪贴板');
    setTimeout(() => setCopied(''), 1500);
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!editing || !t || editing.tags.includes(t)) { setTagInput(''); return; }
    setEditing({ ...editing, tags: [...editing.tags, t] });
    setTagInput('');
  };

  return (
    <div className="content-area">
      <div className="module-page">
        <PageHeader title="SQL 片段" desc="常用查询 / 造数语句，加密保存在本地，一键复制">
          <input className="module-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索标题 / 内容 / 标签" />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptySnippet())}>+ 新增片段</button>
        </PageHeader>

        {copied && <div className="inline-hint">{copied}</div>}

        {loading ? (
          <div className="module-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <EmptyHint
            text="还没有 SQL 片段，把常用的查数语句存进来"
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing(emptySnippet())}>新增片段</button>}
          />
        ) : (
          <div className="card-list">
            {filtered.map(s => (
              <div key={s.id} className="module-card">
                <div className="module-card-head">
                  <strong>{s.title}</strong>
                  <div>
                    <button className="mini-btn" onClick={() => copy(s.sql)}>复制</button>
                    <button className="mini-btn" onClick={() => setEditing(s)}>编辑</button>
                    <button className="mini-btn danger" onClick={() => remove(s.id)}>删除</button>
                  </div>
                </div>
                <pre className="code-block">{s.sql}</pre>
                {s.tags.length > 0 && (
                  <div className="card-tags">
                    <span className="card-tags-icon">🏷️</span>
                    <span className="card-tags-text">{s.tags.join(', ')}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑片段' : '新增片段'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={saveEditing}>保存</button>
          </>
        }
      >
        {editing && (
          <>
            <div className="form-group">
              <label>标题 *</label>
              <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="例如：查询某学生全部成绩" autoFocus />
            </div>
            <div className="form-group">
              <label>SQL</label>
              <textarea
                value={editing.sql}
                onChange={e => setEditing({ ...editing, sql: e.target.value })}
                rows={10}
                className="code-input"
                placeholder="SELECT * FROM ..."
              />
            </div>
            <div className="form-group">
              <label>标签</label>
              <div className="tool-inline">
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                  placeholder="回车添加标签"
                />
                <button className="btn btn-sm btn-secondary" onClick={addTag}>添加</button>
              </div>
              {editing.tags.length > 0 && (
                <div className="card-tags" style={{ marginTop: 8 }}>
                  {editing.tags.map(t => (
                    <span key={t} className="tag">
                      {t}
                      <span className="remove-tag" onClick={() => setEditing({ ...editing, tags: editing.tags.filter(x => x !== t) })}>×</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
