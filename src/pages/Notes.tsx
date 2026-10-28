import React, { useMemo, useState } from 'react';
import type { Note } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons } from '../components/ui';

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

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

export function Notes() {
  const { items, save, loading } = useCollection<Note>('notes');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const { ask, confirmNode } = useConfirm();
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
    await save(items.filter(i => i.id !== id));
  };

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.note size={16} />}
          title="测试笔记"
          desc="踩坑记录、测试结论、环境说明，支持 Markdown，加密保存在本地"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索标题 / 内容" />
              <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyNote())}>
                <Icons.plus size={13} /> 新建笔记
              </button>
            </>
          }
        />

        {loading ? (
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : filtered.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.note size={22} />}
              title={search ? '没有匹配的笔记' : '还没有笔记'}
              desc={search ? '换个关键词试试' : '记下第一个测试结论或踩坑记录，支持 Markdown 语法'}
              action={search ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyNote())}>
                  <Icons.plus size={13} /> 新建笔记
                </button>
              )}
            />
          </Panel>
        ) : (
          <div className="cards">
            {filtered.map(n => (
              <div key={n.id} className="card2 is-clickable" onClick={() => setPreview(n)}>
                <div className="card2-head">
                  <div className="card2-title" title={n.title}>{n.title}</div>
                  <div className="card2-actions" onClick={e => e.stopPropagation()}>
                    <IconBtn title="编辑" onClick={() => setEditing(n)}><Icons.pencil size={13} /></IconBtn>
                    <IconBtn
                      title="删除"
                      danger
                      onClick={() => ask({
                        title: '删除笔记',
                        message: `确定删除「${n.title}」？删除后不可恢复。`,
                        confirmText: '删除',
                        onOk: () => remove(n.id),
                      })}
                    ><Icons.trash size={13} /></IconBtn>
                  </div>
                </div>

                <div className="card2-meta">
                  <Icons.note size={11} />
                  {fmtDate(n.updatedAt)}
                  {n.tags?.length > 0 && <span className="chip" style={{ marginLeft: 'auto' }}>{n.tags.join(' · ')}</span>}
                </div>

                <div className="card2-body" style={{
                  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {(n.content || '').replace(/[#*`>]/g, '').replace(/\n+/g, ' ').trim() || '（空笔记）'}
                </div>
              </div>
            ))}
          </div>
        )}
      </Page>

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

      {confirmNode}
    </div>
  );
}
