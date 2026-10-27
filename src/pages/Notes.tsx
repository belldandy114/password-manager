import React, { useMemo, useState } from 'react';
import type { Note } from '../types';
import { useCollection, PageHeader, EmptyHint } from '../hooks/useCollection';
import { Modal } from '../components/Modal';

const emptyNote = (): Note => ({
  id: '', title: '', content: '', tags: [], updatedAt: new Date().toISOString(),
});

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
}

/** 极简 Markdown 渲染（标题/列表/粗体/行内代码/代码块），内容全部先转义 */
function mdToHtml(md: string): string {
  const lines = escapeHtml(md || '').split('\n');
  let html = '';
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += line + '\n'; continue; }
    if (/^### /.test(line)) html += `<h4>${line.slice(4)}</h4>`;
    else if (/^## /.test(line)) html += `<h3>${line.slice(3)}</h3>`;
    else if (/^# /.test(line)) html += `<h2>${line.slice(2)}</h2>`;
    else if (/^\s*[-*] /.test(line)) html += `<li>${line.replace(/^\s*[-*] /, '')}</li>`;
    else if (line.trim() === '') html += '<div style="height:8px"></div>';
    else html += `<p>${line}</p>`;
  }
  if (inCode) html += '</code></pre>';
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function Notes() {
  const { items, save, loading } = useCollection<Note>('notes');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const [preview, setPreview] = useState<Note | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? items.filter(n => [n.title, n.content, (n.tags || []).join(' ')].some(v => (v || '').toLowerCase().includes(q)))
      : items;
    return [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [items, search]);

  const saveEditing = async () => {
    if (!editing || !editing.title.trim()) return;
    const entry: Note = { ...editing, id: editing.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
  };

  const remove = async (id: string) => {
    if (!confirm('确定删除这篇笔记？')) return;
    await save(items.filter(i => i.id !== id));
  };

  return (
    <div className="content-area">
      <div className="module-page">
        <PageHeader title="测试笔记" desc="踩坑记录、测试结论、环境说明，支持 Markdown，加密保存在本地">
          <input className="module-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索标题 / 内容" />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyNote())}>+ 新建笔记</button>
        </PageHeader>

        {loading ? (
          <div className="module-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <EmptyHint
            text="还没有笔记，记下第一个测试结论或踩坑记录"
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyNote())}>新建笔记</button>}
          />
        ) : (
          <div className="card-list">
            {filtered.map(n => (
              <div key={n.id} className="module-card clickable" onClick={() => setPreview(n)}>
                <div className="module-card-head">
                  <strong>{n.title}</strong>
                  <div onClick={e => e.stopPropagation()}>
                    <span className="text-sm text-muted" style={{ marginRight: 8 }}>
                      {new Date(n.updatedAt).toLocaleDateString('zh-CN')}
                    </span>
                    <button className="mini-btn" onClick={() => setEditing(n)}>编辑</button>
                    <button className="mini-btn danger" onClick={() => remove(n.id)}>删除</button>
                  </div>
                </div>
                <div className="note-excerpt">{(n.content || '').replace(/[#*`]/g, '').slice(0, 120) || '（空）'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑笔记' : '新建笔记'}
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
              <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="例如：资产系统登录偶发 500 的排查" autoFocus />
            </div>
            <div className="form-group">
              <label>内容（支持 Markdown）</label>
              <textarea
                value={editing.content}
                onChange={e => setEditing({ ...editing, content: e.target.value })}
                rows={16}
                className="code-input"
                placeholder={'## 现象\n\n## 原因\n\n## 结论'}
              />
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.title || ''}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setPreview(null)}>关闭</button>
            <button className="btn btn-primary" onClick={() => { setEditing(preview); setPreview(null); }}>编辑</button>
          </>
        }
      >
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: mdToHtml(preview?.content || '') }} />
      </Modal>
    </div>
  );
}
