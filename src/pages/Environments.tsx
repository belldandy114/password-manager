import React, { useMemo, useState } from 'react';
import type { EnvEntry } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Modal } from '../components/Modal';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons, Pill } from '../components/ui';

const ENVS = [
  { id: 'production', label: '正式', color: 'var(--danger)' },
  { id: 'testing', label: '测试', color: 'var(--accent)' },
  { id: 'development', label: '开发', color: 'var(--warning)' },
  { id: 'staging', label: '预发', color: 'var(--text-muted)' },
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

  const filled = useMemo(() => items.filter(i => i.url || i.note).length, [items]);

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

  const addNew = () => setEditing({ system: '', envType: 'testing', url: '', note: '' });

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.server size={16} />}
          title="环境地址"
          desc="按「系统 × 环境」维护访问入口，点击网址直接打开浏览器，与密码库账号配合使用"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索系统" />
              <button className="btn btn-primary btn-sm" onClick={addNew}>
                <Icons.plus size={13} /> 新增地址
              </button>
            </>
          }
        />

        {loading ? (
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : visibleSystems.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.server size={22} />}
              title={search ? '没有匹配的系统' : '还没有环境地址'}
              desc={search ? '换个关键词试试' : '先添加一个系统（例如「资产管理系统」），再为它填上各环境的访问地址'}
              action={search ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={addNew}>
                  <Icons.plus size={13} /> 新增地址
                </button>
              )}
            />
          </Panel>
        ) : (
          <Panel
            title={<>环境矩阵</>}
            meta={`${visibleSystems.length} 个系统 · ${filled} 条地址`}
            tools={<IconBtn title="新增地址" onClick={addNew}><Icons.plus size={14} /></IconBtn>}
            flush
            foot="点击任意单元格即可编辑；把地址和备注都清空即删除该格"
          >
            <table className="envx">
              <thead>
                <tr>
                  <th style={{ width: 190 }}>系统 / 项目</th>
                  {ENVS.map(e => (
                    <th key={e.id}>
                      <span className="envx-dot" style={{ background: e.color }} />
                      {e.label}
                    </th>
                  ))}
                  <th className="envx-op" />
                </tr>
              </thead>
              <tbody>
                {visibleSystems.map(system => (
                  <tr key={system}>
                    <td className="envx-system">{system}</td>
                    {ENVS.map(env => {
                      const c = cell(system, env.id);
                      return (
                        <td key={env.id}>
                          <div className="envx-cell" onClick={() => openCell(system, env.id)}>
                            {c && c.url ? (
                              <span
                                className="envx-url"
                                title={`${c.url}${c.note ? `\n${c.note}` : ''}`}
                                onClick={e => { e.stopPropagation(); openUrl(c.url); }}
                              >
                                {c.url.replace(/^https?:\/\//, '')}
                              </span>
                            ) : c && c.note ? (
                              <span className="envx-note" title={c.note}>{c.note}</span>
                            ) : (
                              <>
                                <Pill tone="mute">未配置</Pill>
                                <span className="envx-plus">+</span>
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
                    <td className="envx-op">
                      <IconBtn title="删除该系统" danger onClick={() => removeSystem(system)}>
                        <Icons.trash size={13} />
                      </IconBtn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Page>

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
