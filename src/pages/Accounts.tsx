import React, { useMemo, useState } from 'react';
import type { TestAccount } from '../types';
import { useCollection, PageHeader, EmptyHint } from '../hooks/useCollection';
import { Modal } from '../components/Modal';

const ENVS = [
  { id: 'production', label: '正式' },
  { id: 'testing', label: '测试' },
  { id: 'development', label: '开发' },
  { id: 'staging', label: '预发' },
];
const envLabel = (id: string) => ENVS.find(e => e.id === id)?.label || id || '—';

const empty = (): TestAccount => ({
  id: '', role: '', system: '', envType: 'testing', username: '', password: '', note: '',
  updatedAt: new Date().toISOString(),
});

export function Accounts() {
  const { items, save, loading } = useCollection<TestAccount>('accounts');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<TestAccount | null>(null);
  const [showPw, setShowPw] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i =>
      [i.role, i.system, i.username, i.note].some(v => (v || '').toLowerCase().includes(q)));
  }, [items, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, TestAccount[]>();
    for (const a of filtered) {
      const key = a.system || '未分组';
      const list = map.get(key) || [];
      list.push(a);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [filtered]);

  const saveEditing = async () => {
    if (!editing || !editing.role.trim() || !editing.username.trim()) return;
    const entry: TestAccount = {
      ...editing,
      id: editing.id || crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
  };

  const remove = async (id: string) => {
    if (!confirm('确定删除这个账号？')) return;
    await save(items.filter(i => i.id !== id));
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(`${label}已复制`);
    setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="content-area">
      <div className="module-page">
        <PageHeader title="测试账号" desc="按角色归档各系统账号，一键复制账号密码">
          <input className="module-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索角色 / 系统 / 账号" />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing(empty())}>+ 新增账号</button>
        </PageHeader>

        {copied && <div className="inline-hint">{copied}</div>}

        {loading ? (
          <div className="module-empty">加载中…</div>
        ) : grouped.length === 0 ? (
          <EmptyHint
            text="还没有测试账号，添加后可以按角色快速取用"
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing(empty())}>新增账号</button>}
          />
        ) : (
          grouped.map(([system, list]) => (
            <div key={system} className="module-section">
              <div className="module-section-title">{system} <span className="text-muted text-sm">({list.length})</span></div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>角色</th>
                    <th style={{ width: 80 }}>环境</th>
                    <th style={{ width: 190 }}>账号</th>
                    <th style={{ width: 190 }}>密码</th>
                    <th>备注</th>
                    <th style={{ width: 150 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(a => (
                    <tr key={a.id}>
                      <td>{a.role}</td>
                      <td><span className={`env-badge env-${a.envType}`}>{envLabel(a.envType)}</span></td>
                      <td>
                        <span className="mono-cell">{a.username}</span>
                        <button className="mini-btn" onClick={() => copy(a.username, '账号')}>复制</button>
                      </td>
                      <td>
                        <span className="mono-cell">{showPw[a.id] ? a.password : '•'.repeat(Math.min(10, (a.password || '').length))}</span>
                        <button className="mini-btn" onClick={() => setShowPw(s => ({ ...s, [a.id]: !s[a.id] }))}>
                          {showPw[a.id] ? '隐藏' : '显示'}
                        </button>
                        <button className="mini-btn" onClick={() => copy(a.password, '密码')}>复制</button>
                      </td>
                      <td className="text-muted">{a.note}</td>
                      <td>
                        <button className="mini-btn" onClick={() => setEditing(a)}>编辑</button>
                        <button className="mini-btn danger" onClick={() => remove(a.id)}>删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑账号' : '新增账号'}
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
              <label>系统 *</label>
              <input value={editing.system} onChange={e => setEditing({ ...editing, system: e.target.value })}
                placeholder="例如：资产管理系统" autoFocus list="account-system-list" />
              <datalist id="account-system-list">
                {Array.from(new Set(items.map(i => i.system).filter(Boolean))).map(s => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="form-group">
              <label>角色 / 权限说明 *</label>
              <input value={editing.role} onChange={e => setEditing({ ...editing, role: e.target.value })} placeholder="例如：超级管理员 / 只能查看" />
            </div>
            <div className="form-group">
              <label>环境</label>
              <select value={editing.envType} onChange={e => setEditing({ ...editing, envType: e.target.value })}>
                {ENVS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>账号 *</label>
              <input value={editing.username} onChange={e => setEditing({ ...editing, username: e.target.value })} placeholder="admin" />
            </div>
            <div className="form-group">
              <label>密码</label>
              <input value={editing.password} onChange={e => setEditing({ ...editing, password: e.target.value })} placeholder="密码" />
            </div>
            <div className="form-group">
              <label>备注</label>
              <input value={editing.note} onChange={e => setEditing({ ...editing, note: e.target.value })} placeholder="例如：数据会定期重置" />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
