import React, { useEffect, useMemo, useState } from 'react';
import type { TestAccount } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { newId } from '../utils/id';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons, Pill } from '../components/ui';
import { useStore } from '../store/useStore';
import { parseAccountLines, daysSince } from '../../electron/accounts-import';

const ENVS = [
  { id: 'production', label: '正式', tone: 'bad' as const },
  { id: 'testing', label: '测试', tone: 'info' as const },
  { id: 'development', label: '开发', tone: 'warn' as const },
  { id: 'staging', label: '预发', tone: 'mute' as const },
];
const envOf = (id: string) => ENVS.find(e => e.id === id);

const empty = (): TestAccount => ({
  id: '', role: '', system: '', envType: 'testing', username: '', password: '', note: '',
  updatedAt: new Date().toISOString(),
});

export function Accounts() {
  const { items, save, loading } = useCollection<TestAccount>('accounts');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<TestAccount | null>(null);
  const { ask, confirmNode } = useConfirm();
  const [showPw, setShowPw] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState('');
  // 批量导入：粘贴多行「系统 | 角色 | 账号 | 密码 | 备注」
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkBad, setBulkBad] = useState<{ line: number; text: string }[]>([]);
  // 「系统」直接可从已有数据挑：网址管理的条目名 + 环境矩阵里的 system
  const pwEntries = useStore(s => s.entries);
  const [envSystems, setEnvSystems] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const r = await window.electronAPI.wsGet('environments');
      if (r && r.success && Array.isArray(r.data)) {
        setEnvSystems(Array.from(new Set(r.data.map((x: any) => String(x && x.system || '').trim()).filter(Boolean))));
      }
    })();
  }, []);

  /** 可选系统：网址管理条目名 → 环境矩阵 → 已存账号，去重后给下拉用 */
  const systemOptions = useMemo(() => {
    const all = [
      ...pwEntries.map((e: any) => String(e.name || '').trim()),
      ...envSystems,
      ...items.map((i: any) => String(i.system || '').trim()),
    ].filter(Boolean);
    return Array.from(new Set(all)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [pwEntries, envSystems, items]);

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
      id: editing.id || newId(),
      updatedAt: new Date().toISOString(),
    };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
  };

  /** 批量导入：解析粘贴的文本并追加（不覆盖已有账号） */
  const runBulkImport = async () => {
    const parsed = parseAccountLines(bulkText);
    setBulkBad(parsed.bad);
    if (!parsed.rows.length) { setToast('没有可导入的行（格式：系统 | 角色 | 账号 | 密码）'); return; }
    const now = new Date().toISOString();
    const added: TestAccount[] = parsed.rows.map(r => ({
      id: newId(),
      system: r.system,
      role: r.role,
      envType: 'testing',
      username: r.username,
      password: r.password,
      note: r.note,
      updatedAt: now,
      passwordUpdatedAt: now,
    }));
    await save([...items, ...added]);
    setToast(`已导入 ${added.length} 条${parsed.bad.length ? `，${parsed.bad.length} 行格式不对已跳过` : ''}`);
    setBulkText('');
    setBulkOpen(false);
  };

  const remove = async (id: string) => {
    await save(items.filter(i => i.id !== id));
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setToast(`${label}已复制`);
    setTimeout(() => setToast(''), 1500);
  };

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.key size={16} />}
          title="测试账号"
          desc="按系统与角色归档测试账号，账号密码一键复制，避免每次翻聊天记录"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索角色 / 系统 / 账号" />
              <button className="btn btn-secondary btn-sm" onClick={() => { setBulkText(''); setBulkBad([]); setBulkOpen(true); }}>批量导入</button>
<button className="btn btn-primary btn-sm" onClick={() => setEditing(empty())}>
                <Icons.plus size={13} /> 新增账号
              </button>
            </>
          }
        />

        {toast && <div className="inline-hint">{toast}</div>}

        {loading ? (
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : grouped.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.key size={22} />}
              title={search ? '没有匹配的账号' : '还没有测试账号'}
              desc={search ? '换个关键词试试' : '把各系统的常用测试账号存进来，按角色区分，取用时不用再去问同事'}
              action={search ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(empty())}>
                  <Icons.plus size={13} /> 新增账号
                </button>
              )}
            />
          </Panel>
        ) : (
          grouped.map(([system, list]) => (
            <Panel key={system} title={system} meta={`${list.length} 个账号`} flush>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 180 }}>角色 / 权限</th>
                    <th style={{ width: 88 }}>环境</th>
                    <th style={{ width: 210 }}>账号</th>
                    <th style={{ width: 220 }}>密码</th>
                    <th>备注</th>
                    <th style={{ width: 92 }} />
                  </tr>
                </thead>
                <tbody>
                  {list.map(a => {
                    const env = envOf(a.envType);
                    return (
                      <tr key={a.id}>
                        <td className="cell-strong">{a.role}</td>
                        <td>
                          {env
                            ? <Pill tone={env.tone} dot>{env.label}</Pill>
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        <td>
                          <span className="cell-mono">{a.username}</span>
                          <IconBtn title="复制账号" onClick={() => copy(a.username, '账号')}>
                            <Icons.copy size={12} />
                          </IconBtn>
                        </td>
                        <td>
                          <span className="cell-mono" style={{ letterSpacing: showPw[a.id] ? 0 : 1.5 }}>
                            {showPw[a.id] ? a.password : '•'.repeat(Math.min(10, (a.password || '').length || 6))}
                          </span>
                          <IconBtn
                            title={showPw[a.id] ? '隐藏密码' : '显示密码'}
                            active={showPw[a.id]}
                            onClick={() => setShowPw(s => ({ ...s, [a.id]: !s[a.id] }))}
                          >
                            {showPw[a.id] ? <Icons.eyeOff size={12} /> : <Icons.eye size={12} />}
                          </IconBtn>
                          <IconBtn title="复制密码" onClick={() => copy(a.password, '密码')}>
                            <Icons.copy size={12} />
                          </IconBtn>
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>{a.note || '—'}</td>
                        <td className="cell-actions">
                          <IconBtn title="编辑" onClick={() => setEditing(a)}><Icons.pencil size={13} /></IconBtn>
                          <IconBtn
                            title="删除"
                            danger
                            onClick={() => ask({
                              title: '删除测试账号',
                              message: `确定删除「${a.system || '未分组'} · ${a.username}」？删除后不可恢复。`,
                              confirmText: '删除',
                              onOk: () => remove(a.id),
                            })}
                          ><Icons.trash size={13} /></IconBtn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          ))
        )}
      <Modal
        open={bulkOpen}
        onClose={() => { setBulkOpen(false); setBulkBad([]); }}
        title="批量导入账号"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => { setBulkOpen(false); setBulkBad([]); }}>取消</button>
            <button className="btn btn-primary" disabled={!bulkText.trim()} onClick={runBulkImport}>导入</button>
          </>
        )}
      >
        <div className="form-group">
          <label>每行一个账号：系统 | 角色 | 账号 | 密码 | 备注（备注可省）</label>
          <textarea
            className="bulk-text"
            rows={8}
            value={bulkText}
            onChange={e => setBulkText(e.target.value)}
            spellCheck={false}
            placeholder={'资产管理系统 | 管理员 | admin | 123456\n华贸学工 | 教师 | t001 | Test@123 | 只读账号'}
            autoFocus
          />
          <div className="input-hint">也支持从 Excel 复制（Tab 分隔）；<code>#</code> 开头的行当注释跳过。</div>
        </div>
        {bulkBad.length > 0 && (
          <div className="pill pill-warn" style={{ padding: "6px 10px", borderRadius: 8, fontWeight: 400 }}>
            有 {bulkBad.length} 行格式不对（第 {bulkBad.slice(0, 5).map(b => b.line).join("、")} 行），导入时会跳过
          </div>
        )}
      </Modal>
      </Page>

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
                placeholder="例如：资产管理系统" autoFocus />
              {/* 不要用 <datalist>（会导致 Chromium 原生崩溃），用下拉 + 可点标签 */}
              {systemOptions.length > 0 && (
                <select
                  className="suggest-select"
                  value=""
                  onChange={e => { if (e.target.value) setEditing({ ...editing, system: e.target.value }); }}
                  title="从「网址管理」等已有数据里选一个系统"
                >
                  <option value="">从已有系统选择（网址管理 / 历史账号）…</option>
                  {systemOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              {systemOptions.length > 0 && (
                <div className="suggest-row">
                  {systemOptions.slice(0, 8).map(s => (
                    <button key={s} type="button" className="chip" onClick={() => setEditing({ ...editing, system: s })}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
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

      {confirmNode}
    </div>
  );
}
