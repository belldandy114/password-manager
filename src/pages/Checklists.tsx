import React, { useState } from 'react';
import type { Checklist, ChecklistItem } from '../types';
import { useCollection, PageHeader, EmptyHint } from '../hooks/useCollection';
import { Modal } from '../components/Modal';

const emptyChecklist = (): Checklist => ({
  id: '', title: '', description: '', items: [], updatedAt: new Date().toISOString(),
});

export function Checklists() {
  const { items, save, loading } = useCollection<Checklist>('checklists');
  const [editing, setEditing] = useState<Checklist | null>(null);
  const [newItem, setNewItem] = useState('');

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
      <div className="module-page">
        <PageHeader title="用例清单" desc="沉淀可复用的测试点 / 回归清单，勾选状态自动保存">
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyChecklist())}>+ 新建清单</button>
        </PageHeader>

        {loading ? (
          <div className="module-empty">加载中…</div>
        ) : items.length === 0 ? (
          <EmptyHint
            text="还没有清单。例如「登录功能回归清单」：验证密码错误提示、验证锁定、验证记住密码…"
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyChecklist())}>新建清单</button>}
          />
        ) : (
          <div className="card-list">
            {items.map(list => {
              const done = list.items.filter(i => i.done).length;
              const total = list.items.length;
              const percent = total ? Math.round((done / total) * 100) : 0;
              return (
                <div key={list.id} className="module-card">
                  <div className="module-card-head">
                    <strong>{list.title}</strong>
                    <div>
                      <button className="mini-btn" onClick={() => setEditing(list)}>编辑</button>
                      <button className="mini-btn danger" onClick={() => remove(list.id)}>删除</button>
                    </div>
                  </div>
                  {list.description && <div className="text-muted text-sm">{list.description}</div>}
                  <div className="progress-line"><i style={{ width: percent + '%' }} /></div>
                  <div className="text-sm text-muted">{done} / {total} 项完成（{percent}%）</div>
                  <div className="check-items">
                    {list.items.slice(0, 6).map(it => (
                      <label key={it.id} className={`check-item ${it.done ? 'done' : ''}`}>
                        <input type="checkbox" checked={it.done} onChange={() => toggleItem(list, it.id)} />
                        <span>{it.text}</span>
                      </label>
                    ))}
                    {list.items.length > 6 && <div className="text-sm text-muted">还有 {list.items.length - 6} 项…</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
              <div className="tool-inline">
                <input
                  value={newItem}
                  onChange={e => setNewItem(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }}
                  placeholder="输入检查项后回车添加"
                />
                <button className="btn btn-sm btn-secondary" onClick={addItem}>添加</button>
              </div>
              <div className="check-items" style={{ marginTop: 8 }}>
                {editing.items.map(it => (
                  <div key={it.id} className="check-item editable">
                    <input type="checkbox" checked={it.done}
                      onChange={() => setEditing({
                        ...editing,
                        items: editing.items.map(x => (x.id === it.id ? { ...x, done: !x.done } : x)),
                      })} />
                    <span className={it.done ? 'done-text' : ''}>{it.text}</span>
                    <button className="btn-icon-danger" onClick={() => setEditing({
                      ...editing,
                      items: editing.items.filter(x => x.id !== it.id),
                    })}>×</button>
                  </div>
                ))}
                {editing.items.length === 0 && <div className="text-muted text-sm">还没有检查项</div>}
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
