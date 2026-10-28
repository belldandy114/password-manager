import React, { useMemo, useState } from 'react';
import type { Snippet } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons } from '../components/ui';

const emptySnippet = (): Snippet => ({
  id: '', title: '', sql: '', tags: [], updatedAt: new Date().toISOString(),
});

export function Snippets() {
  const { items, save, loading } = useCollection<Snippet>('snippets');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [toast, setToast] = useState('');
  const { ask, confirmNode } = useConfirm();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? items.filter(s => [s.title, s.sql, (s.tags || []).join(' ')].some(v => (v || '').toLowerCase().includes(q)))
      : items;
    return [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [items, search]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    items.forEach(s => (s.tags || []).forEach(t => set.add(t)));
    return Array.from(set);
  }, [items]);

  const saveEditing = async () => {
    if (!editing || !editing.title.trim()) return;
    const entry: Snippet = { ...editing, id: editing.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
    setTagInput('');
  };

  const remove = async (id: string) => {
    await save(items.filter(i => i.id !== id));
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setToast('已复制到剪贴板');
    setTimeout(() => setToast(''), 1500);
  };

  const addTag = () => {
    const t = tagInput.trim();
    if (!editing || !t || editing.tags.includes(t)) { setTagInput(''); return; }
    setEditing({ ...editing, tags: [...editing.tags, t] });
    setTagInput('');
  };

  const applyTag = (t: string) => setSearch(search === t ? '' : t);

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.db size={16} />}
          title="SQL 片段"
          desc="常用查询 / 造数 / 清理语句，加密保存在本地，一键复制"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索标题 / 内容 / 标签" />
              <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptySnippet())}>
                <Icons.plus size={13} /> 新增片段
              </button>
            </>
          }
        />

        {toast && <div className="inline-hint">{toast}</div>}

        {allTags.length > 0 && (
          <div className="tags">
            {allTags.map(t => (
              <button
                key={t}
                className="chip"
                style={search === t
                  ? { borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)', color: 'var(--accent)', background: 'var(--accent-light)', cursor: 'pointer' }
                  : { cursor: 'pointer' }}
                onClick={() => applyTag(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : filtered.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.db size={22} />}
              title={search ? '没有匹配的片段' : '还没有 SQL 片段'}
              desc={search ? '换个关键词或点上面的标签筛选' : '把常用的查数、造数、清理语句存进来，下次直接复制'}
              action={search ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptySnippet())}>
                  <Icons.plus size={13} /> 新增片段
                </button>
              )}
            />
          </Panel>
        ) : (
          <div className="cards">
            {filtered.map(s => (
              <div key={s.id} className="card2">
                <div className="card2-head">
                  <div className="card2-title" title={s.title}>{s.title}</div>
                  <div className="card2-actions">
                    <IconBtn title="复制 SQL" onClick={() => copy(s.sql)}><Icons.copy size={13} /></IconBtn>
                    <IconBtn title="编辑" onClick={() => setEditing(s)}><Icons.pencil size={13} /></IconBtn>
                    <IconBtn
                      title="删除"
                      danger
                      onClick={() => ask({
                        title: '删除 SQL 片段',
                        message: `确定删除「${s.title}」？删除后不可恢复。`,
                        confirmText: '删除',
                        onOk: () => remove(s.id),
                      })}
                    ><Icons.trash size={13} /></IconBtn>
                  </div>
                </div>

                <pre className="code2">{s.sql || '（空）'}</pre>

                {s.tags.length > 0 && (
                  <div className="tags">
                    {s.tags.map(t => (
                      <button key={t} className="chip" style={{ cursor: 'pointer' }} onClick={() => applyTag(t)}>{t}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Page>

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
              <div className="tool-line">
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                  placeholder="回车添加标签"
                />
                <button className="btn btn-sm btn-secondary" onClick={addTag}>添加</button>
              </div>
              {editing.tags.length > 0 && (
                <div className="tags" style={{ marginTop: 8 }}>
                  {editing.tags.map(t => (
                    <span key={t} className="chip">
                      {t}
                      <button
                        className="ibtn"
                        style={{ width: 16, height: 16 }}
                        title="移除"
                        onClick={() => setEditing({ ...editing, tags: editing.tags.filter(x => x !== t) })}
                      >
                        <Icons.close size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>

      {confirmNode}
    </div>
  );
}
