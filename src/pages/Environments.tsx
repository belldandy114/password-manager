import React, { useMemo, useState } from 'react';
import type { EnvEntry } from '../types';
import { useCollection, PageHeader, EmptyHint } from '../hooks/useCollection';
import { Modal } from '../components/Modal';

const ENVS = [
  { id: 'production', label: '正式' },
  { id: 'testing', label: '测试' },
  { id: 'development', label: '开发' },
  { id: 'staging', label: '预发' },
];

interface Editing {
  id?: string;
  system: string;
  envType: string;
  url: string;
  note: string;
}

export function Environments() {
  const { items, save, loading } = useCollection<EnvEntry>('environments');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);

  const systems = useMemo(() => {
    const set = new Set(items.map(i => i.system).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [items]);

  const visibleSystems = useMemo(
    () => systems.filter(s => !search || s.toLowerCase().includes(search.toLowerCase())),
    [systems, search],
  );

  const cell = (system: string, envType: string) =>
    items.find(i => i.system === system && i.envType === envType);

  const openCell = (system: string, envType: string) => {
    const found = cell(system, envType);
    setEditing({
      id: found?.id,
      system,
      envType,
      url: found?.url || '',
      note: found?.note || '',
    });
  };

  const saveEditing = async () => {
    if (!editing) return;
    const now = new Date().toISOString();
    const rest = items.filter(i => i.id !== editing.id
      && !(i.system === editing.system && i.envType === editing.envType));
    const next = editing.url.trim() || editing.note.trim()
      ? [...rest, {
        id: editing.id || crypto.randomUUID(),
        system: editing.system,
        envType: editing.envType,
        url: editing.url.trim(),
        note: editing.note.trim(),
        updatedAt: now,
      }]
      : rest; // 清空即删除该格
    await save(next);
    setEditing(null);
  };

  const removeSystem = async (system: string) => {
    if (!confirm(`确定删除「${system}」的全部环境地址？`)) return;
    await save(items.filter(i => i.system !== system));
  };

  const openUrl = (url: string) => {
    if (!url) return;
    window.electronAPI.browserOpen({ browser: 'default', url });
  };

  return (
    <div className="content-area">
      <div className="module-page">
        <PageHeader
          title="环境地址"
          desc="按系统 × 环境维护访问入口，点击网址直接打开浏览器；与密码库账号配合使用"
        >
          <input className="module-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索系统" />
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({ system: '', envType: 'testing', url: '', note: '' })}>
            + 新增地址
          </button>
        </PageHeader>

        {loading ? (
          <div className="module-empty">加载中…</div>
        ) : visibleSystems.length === 0 ? (
          <EmptyHint
            text="还没有环境地址，先添加一个系统（例如「资产管理」），再为它填上各环境 URL"
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing({ system: '', envType: 'testing', url: '', note: '' })}>新增地址</button>}
          />
        ) : (
          <div className="env-matrix-wrap">
            <table className="env-matrix">
              <thead>
                <tr>
                  <th className="env-system-col">系统</th>
                  {ENVS.map(e => <th key={e.id}>{e.label}</th>)}
                  <th className="env-op-col" />
                </tr>
              </thead>
              <tbody>
                {visibleSystems.map(system => (
                  <tr key={system}>
                    <td className="env-system-col">{system}</td>
                    {ENVS.map(env => {
                      const c = cell(system, env.id);
                      return (
                        <td key={env.id} className="env-cell" onClick={() => openCell(system, env.id)}>
                          {c && c.url ? (
                            <span
                              className="env-url"
                              title={c.url + (c.note ? `\n${c.note}` : '')}
                              onClick={e => { e.stopPropagation(); openUrl(c.url); }}
                            >
                              {c.url.replace(/^https?:\/\//, '').slice(0, 34)}
                            </span>
                          ) : c && c.note ? (
                            <span className="env-note-only" title={c.note}>{c.note.slice(0, 30)}</span>
                          ) : (
                            <span className="env-empty">+</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="env-op-col">
                      <button className="btn-icon-danger" title="删除该系统" onClick={() => removeSystem(system)}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="module-tip">提示：点击单元格编辑，清空内容即删除该格</div>
          </div>
        )}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑环境地址' : '新增环境地址'}
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
              <label>系统 / 项目名 *</label>
              <input
                value={editing.system}
                onChange={e => setEditing({ ...editing, system: e.target.value })}
                placeholder="例如：资产管理系统"
                autoFocus
                list="env-system-list"
              />
              <datalist id="env-system-list">
                {systems.map(s => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="form-group">
              <label>环境</label>
              <select value={editing.envType} onChange={e => setEditing({ ...editing, envType: e.target.value })}>
                {ENVS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>访问地址</label>
              <input value={editing.url} onChange={e => setEditing({ ...editing, url: e.target.value })} placeholder="https://test.example.com" />
            </div>
            <div className="form-group">
              <label>备注</label>
              <input value={editing.note} onChange={e => setEditing({ ...editing, note: e.target.value })} placeholder="例如：需要 VPN" />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
