import React, { useMemo, useState } from 'react';
import type { Checklist, ChecklistItem } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Modal } from '../components/Modal';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons, Pill } from '../components/ui';

const emptyChecklist = (): Checklist => ({
  id: '', title: '', description: '', items: [], updatedAt: new Date().toISOString(),
});

export function Checklists() {
  const { items, save, loading } = useCollection<Checklist>('checklists');
  const [editing, setEditing] = useState<Checklist | null>(null);
  const [newItem, setNewItem] = useState('');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(c => [c.title, c.description, ...c.items.map(i => i.text)]
      .some(v => (v || '').toLowerCase().includes(q)));
  }, [items, search]);

  const totals = useMemo(() => {
    let done = 0, all = 0;
    for (const c of items) {
      all += c.items.length;
      done += c.items.filter(i => i.done).length;
    }
    return { done, all };
  }, [items]);

  const saveEditing = async () => {
    if (!editing || !editing.title.trim()) return;
    const entry: Checklist = { ...editing, id: editing.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
  };

  const remove = async (id: string) => {
    if (!confirm('确定删除这个清单？')) return;
    await save(items.filter(i => i.id !== id));
  };

  const toggleItem = async (list: Checklist, itemId: string) => {
    const next = items.map(c => c.id === list.id
      ? { ...c, items: c.items.map(it => (it.id === itemId ? { ...it, done: !it.done } : it)) }
      : c);
    await save(next);
  };

  const addItem = () => {
    if (!editing || !newItem.trim()) return;
    const item: ChecklistItem = { id: crypto.randomUUID(), text: newItem.trim(), done: false };
    setEditing({ ...editing, items: [...editing.items, item] });
    setNewItem('');
  };

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.list size={16} />}
          title="用例清单"
          desc="沉淀可复用的测试点 / 回归清单，勾选状态自动保存"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索清单或检查项" />
              <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyChecklist())}>
                <Icons.plus size={13} /> 新建清单
              </button>
            </>
          }
        />

        {loading ? (
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : filtered.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.list size={22} />}
              title={search ? '没有匹配的清单' : '还没有清单'}
              desc={search ? '换个关键词试试' : '例如「登录功能回归清单」：验证密码错误提示、连续输错锁定、记住密码是否生效…'}
              action={search ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyChecklist())}>
                  <Icons.plus size={13} /> 新建清单
                </button>
              )}
            />
          </Panel>
        ) : (
          <>
            <div className="pg-sub" style={{ marginTop: -8 }}>
              共 {items.length} 个清单 · {totals.all} 个检查项，已完成 <strong style={{ color: 'var(--success)' }}>{totals.done}</strong>
            </div>
            <div className="cards">
              {filtered.map(list => {
                const done = list.items.filter(i => i.done).length;
                const total = list.items.length;
                const percent = total ? Math.round((done / total) * 100) : 0;
                const finished = total > 0 && done === total;
                return (
                  <div key={list.id} className="card2">
                    <div className="card2-head">
                      <div className="card2-title" title={list.title}>{list.title}</div>
                      {finished
                        ? <Pill tone="ok" dot>已全部通过</Pill>
                        : <Pill tone="mute">{done}/{total}</Pill>}
                      <div className="card2-actions">
                        <IconBtn title="编辑" onClick={() => setEditing(list)}><Icons.pencil size={13} /></IconBtn>
                        <IconBtn title="删除" danger onClick={() => remove(list.id)}><Icons.trash size={13} /></IconBtn>
                      </div>
                    </div>

                    {list.description && <div className="card2-meta">{list.description}</div>}

                    <div className={`prog${finished ? ' is-done' : ''}`}><i style={{ width: percent + '%' }} /></div>

                    <div className="card2-body" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {list.items.length === 0 && (
                        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>还没有检查项，点右上角编辑添加</div>
                      )}
                      {list.items.slice(0, 8).map(it => (
                        <label key={it.id} className={`ck${it.done ? ' is-done' : ''}`}>
                          <input type="checkbox" checked={it.done} onChange={() => toggleItem(list, it.id)} />
                          <span>{it.text}</span>
                        </label>
                      ))}
                      {list.items.length > 8 && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingLeft: 8, marginTop: 4 }}>
                          还有 {list.items.length - 8} 项…
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Page>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑清单' : '新建清单'}
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
              <label>清单名称 *</label>
              <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="例如：登录功能回归清单" autoFocus />
            </div>
            <div className="form-group">
              <label>说明</label>
              <input value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} placeholder="适用范围、前置条件等" />
            </div>
            <div className="form-group">
              <label>检查项（{editing.items.length}）</label>
              <div className="tool-line">
                <input
                  value={newItem}
                  onChange={e => setNewItem(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
                  placeholder="输入检查项后回车添加"
                />
                <button className="btn btn-sm btn-secondary" onClick={addItem}>添加</button>
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {editing.items.map(it => (
                  <div key={it.id} className={`ck${it.done ? ' is-done' : ''}`} style={{ paddingRight: 4 }}>
                    <input type="checkbox" checked={it.done}
                      onChange={() => setEditing({
                        ...editing,
                        items: editing.items.map(x => (x.id === it.id ? { ...x, done: !x.done } : x)),
                      })} />
                    <span style={{ flex: 1 }}>{it.text}</span>
                    <IconBtn title="移除" danger onClick={() => setEditing({
                      ...editing,
                      items: editing.items.filter(x => x.id !== it.id),
                    })}><Icons.close size={12} /></IconBtn>
                  </div>
                ))}
                {editing.items.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>还没有检查项</div>
                )}
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
