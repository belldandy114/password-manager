import React, { useEffect, useMemo, useState } from 'react';
import type { ApiRequest, ApiResponseData, ApiEnv, ApiHistoryItem } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Page, PageHead, Panel, Empty, IconBtn, Icons, Pill } from '../components/ui';
import { Modal } from '../components/Modal';
import { formatRecent } from '../utils/time';
import { useConfirm } from '../components/confirm';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

const emptyReq = (): ApiRequest => ({
  id: '', name: '', method: 'GET', url: '', headers: '', body: '', variables: '',
  updatedAt: new Date().toISOString(),
});

/** 把 {{var}} 替换成变量表里的值 */
function applyVars(text: string, vars: string): string {
  const map: Record<string, string> = {};
  (vars || '').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return (text || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => map[k] !== undefined ? map[k] : m);
}

/* ---------------- 每行一个的 key/value 编辑器 ---------------- */

export interface KvRow { k: string; v: string }

function parseKv(text: string, sep: ':' | '='): KvRow[] {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const i = line.search(sep === ':' ? /:/ : /=/);
      if (i < 0) return { k: line, v: '' };
      return { k: line.slice(0, i).trim(), v: line.slice(i + 1).trim() };
    });
}

function serializeKv(rows: KvRow[], sep: ':' | '='): string {
  return rows
    .filter(r => r.k.trim() || r.v.trim())
    .map(r => `${r.k.trim()}${sep === ':' ? ': ' : '='}${r.v.trim()}`)
    .join('\n');
}

/** 一行一个输入框：key ｜ value ｜ 删除；末尾常留一个空行用于新增 */
function KvEditor({
  value, onChange, keyPlaceholder, valuePlaceholder, sep,
}: {
  value: string;
  onChange: (next: string) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  sep: ':' | '=';
}) {
  const [rows, setRows] = useState<KvRow[]>(() => [...parseKv(value, sep), { k: '', v: '' }]);

  // 切换到另一条已保存请求时，外部值变化 → 重建行
  useEffect(() => {
    if (String(value || '') !== serializeKv(rows, sep)) {
      setRows([...parseKv(value, sep), { k: '', v: '' }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: KvRow[]) => {
    const list = next.slice();
    const last = list[list.length - 1];
    if (!last || last.k.trim() || last.v.trim()) list.push({ k: '', v: '' });
    setRows(list);
    onChange(serializeKv(list, sep));
  };

  const setCell = (i: number, patch: Partial<KvRow>) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    commit(next);
  };

  const filled = rows.filter(r => r.k.trim() || r.v.trim()).length;

  return (
    <div className="kv-rows">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input
            value={r.k}
            onChange={e => setCell(i, { k: e.target.value })}
            placeholder={keyPlaceholder}
            spellCheck={false}
          />
          <span className="kv-sep">{sep}</span>
          <input
            value={r.v}
            onChange={e => setCell(i, { v: e.target.value })}
            placeholder={valuePlaceholder}
            spellCheck={false}
          />
          <button
            type="button"
            className="ibtn"
            title="删除这一行"
            aria-label="删除这一行"
            disabled={i === rows.length - 1 && !r.k && !r.v}
            onClick={() => commit(rows.filter((_, idx) => idx !== i))}
          >
            <Icons.close size={12} />
          </button>
        </div>
      ))}
      <div className="kv-rows-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => commit([...rows, { k: '', v: '' }])}>
          <Icons.plus size={12} /> 添加一行
        </button>
        <span className="text-sm text-muted">{filled} 条</span>
      </div>
    </div>
  );
}

export function ApiClient() {
  const { items, save } = useCollection<ApiRequest>('apiRequests');
  const { items: envs, save: saveEnvs } = useCollection<ApiEnv>('apiEnvs');
  const { items: history, save: saveHistory } = useCollection<ApiHistoryItem>('apiHistory');
  const [req, setReq] = useState<ApiRequest>(emptyReq);
  const { ask, confirmNode } = useConfirm();
  const [sideTab, setSideTab] = useState<'saved' | 'history'>('saved');
  const [activeEnvId, setActiveEnvId] = useState('');
  const [envOpen, setEnvOpen] = useState(false);
  const [envDraft, setEnvDraft] = useState<ApiEnv | null>(null);
  const [response, setResponse] = useState<ApiResponseData | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [showVars, setShowVars] = useState(false);
  const [respTab, setRespTab] = useState<'body' | 'headers'>('body');

  const prettyBody = useMemo(() => {
    if (!response) return '';
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }, [response]);

  /** 选环境：把环境变量合并进变量表（同名覆盖） */
  const applyEnv = (id: string) => {
    setActiveEnvId(id);
    const env = envs.find(e => e.id === id);
    if (!env) return;
    const map = new Map<string, string>();
    parseKv(req.variables || '', '=').forEach(r => { if (r.k) map.set(r.k, r.v); });
    parseKv(env.vars || '', '=').forEach(r => { if (r.k) map.set(r.k, r.v); });
    setReq({ ...req, variables: [...map].map(([k, v]) => `${k}=${v}`).join('\n') });
  };

  const saveEnv = async () => {
    if (!envDraft || !envDraft.name.trim()) return;
    const entry: ApiEnv = {
      ...envDraft,
      id: envDraft.id || `env-${Date.now().toString(36)}`,
      name: envDraft.name.trim(),
      updatedAt: new Date().toISOString(),
    };
    const next = envs.some(e => e.id === entry.id)
      ? envs.map(e => (e.id === entry.id ? entry : e))
      : [...envs, entry];
    await saveEnvs(next);
    setEnvOpen(false);
    setEnvDraft(null);
    if (!activeEnvId) setActiveEnvId(entry.id);
  };

  const removeEnv = async (id: string) => {
    await saveEnvs(envs.filter(e => e.id !== id));
    if (activeEnvId === id) setActiveEnvId('');
  };

  const pushHistory = async (method: string, url: string, status: number, timeMs: number) => {
    const entry: ApiHistoryItem = {
      id: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      method, url, status, timeMs, at: new Date().toISOString(),
    };
    await saveHistory([entry, ...history].slice(0, 50));
  };

  const send = async () => {
    if (!req.url.trim()) { setError('请输入 URL'); return; }
    setSending(true);
    setError('');
    setResponse(null);
    const url = applyVars(req.url, req.variables || '');
    const headers = applyVars(req.headers, req.variables || '');
    const body = applyVars(req.body, req.variables || '');
    const res = await window.electronAPI.apiSend({ method: req.method, url, headers, body });
    setSending(false);
    if (res.success && res.data) {
      setResponse(res.data);
      pushHistory(req.method, url, res.data.status, res.data.timeMs);
    } else {
      setError(res.error || '请求失败');
      pushHistory(req.method, url, 0, 0);
    }
  };

  const saveRequest = async () => {
    if (!req.url.trim()) return;
    const entry: ApiRequest = {
      ...req,
      name: req.name.trim() || `${req.method} ${req.url.replace(/^https?:\/\//, '').slice(0, 40)}`,
      id: req.id || crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    const next = req.id ? items.map(i => (i.id === entry.id ? entry : i)) : [entry, ...items];
    await save(next);
    setReq(entry);
  };

  const removeRequest = async (id: string) => {
    await save(items.filter(i => i.id !== id));
    if (req.id === id) setReq(emptyReq());
  };

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.terminal size={16} />}
          title="接口调试"
          desc="直接发 HTTP 请求（不受 CORS 限制），支持 {{变量}} 替换与请求保存"
          tools={
            <>
              <button className="btn btn-secondary btn-sm" onClick={() => setReq(emptyReq())}>
                <Icons.plus size={13} /> 新建请求
              </button>
              <button className="btn btn-primary btn-sm" onClick={saveRequest}>保存请求</button>
            </>
          }
        />

        <div className="split" style={{ gridTemplateColumns: '248px minmax(0, 1fr)' }}>
          <Panel
            title={sideTab === 'saved' ? '已保存' : '请求历史'}
            meta={sideTab === 'saved' ? items.length : history.length}
            flush
            tools={
              <div className="resp-tabs">
                <button className={`tab2${sideTab === 'saved' ? ' is-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => setSideTab('saved')}>保存</button>
                <button className={`tab2${sideTab === 'history' ? ' is-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => setSideTab('history')}>历史</button>
              </div>
            }
          >
            <div className="api-side" style={{ padding: 8 }}>
              {sideTab === 'history' && (
                history.length === 0 ? (
                  <div style={{ padding: '18px 10px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                    还没有请求记录。<br />发送一次请求后会自动记录（保留最近 50 条）。
                  </div>
                ) : (
                  history.map(h => (
                    <div
                      key={h.id}
                      className="api-list-item"
                      onClick={() => {
                        setReq({ ...emptyReq(), method: h.method, url: h.url });
                        setResponse(null);
                        setError('');
                      }}
                      title={`${h.method} ${h.url}`}
                    >
                      <span className={`method m-${h.method}`}>{h.method}</span>
                      <span className="api-name">{h.url.replace(/^https?:\/\//, '')}</span>
                      <span className="api-hist-time">{formatRecent(h.at)}</span>
                      <span className={`api-hist${h.status >= 200 && h.status < 400 ? ' is-ok' : ' is-bad'}`}>
                        {h.status || 'ERR'}
                      </span>
                    </div>
                  ))
                )
              )}
              {sideTab === 'saved' && (<>
              {items.length === 0 ? (
                <div style={{ padding: '18px 10px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                  还没有保存的请求。<br />填好地址后点右上角「保存请求」。
                </div>
              ) : (
                items.map(i => (
                  <div
                    key={i.id}
                    className={`api-list-item${req.id === i.id ? ' is-active' : ''}`}
                    onClick={() => { setReq(i); setResponse(null); setError(''); }}
                    title={i.url}
                  >
                    <span className={`method m-${i.method}`}>{i.method}</span>
                    <span className="api-name">{i.name}</span>
                    <IconBtn
                      title="删除"
                      danger
                      onClick={e => {
                        e.stopPropagation();
                        ask({
                          title: '删除请求',
                          message: `确定删除「${i.name}」？删除后不可恢复。`,
                          confirmText: '删除',
                          onOk: () => removeRequest(i.id),
                        });
                      }}
                    >
                      <Icons.trash size={12} />
                    </IconBtn>
                  </div>
                ))
              )}
              </>)}
            </div>
          </Panel>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <Panel
              title="请求"
              meta={req.name || '未命名'}
              tools={
                <button
                  className={`tab2${showVars ? ' is-active' : ''}`}
                  style={{ padding: '4px 10px', fontSize: 11.5 }}
                  onClick={() => setShowVars(v => !v)}
                  title="展开/收起变量表"
                >
                  <Icons.tag size={12} /> 变量
                </button>
              }
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="api-env-row">
                  <span className="api-env-label">环境</span>
                  <select value={activeEnvId} onChange={e => applyEnv(e.target.value)}>
                    <option value="">不使用环境</option>
                    {envs.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setEnvDraft({ id: '', name: '', vars: 'baseUrl=https://test.example.com', updatedAt: '' }); setEnvOpen(true); }}
                  >
                    <Icons.plus size={12} /> 环境
                  </button>
                  {activeEnvId && <span className="api-env-tip">变量已合并到下方变量表</span>}
                </div>

                <div className="url-bar">
                  <select value={req.method} onChange={e => setReq({ ...req, method: e.target.value })}>
                    {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input
                    value={req.url}
                    onChange={e => setReq({ ...req, url: e.target.value })}
                    placeholder="https://api.example.com/users   支持 {{baseUrl}}/path"
                    onKeyDown={e => { if (e.key === 'Enter') send(); }}
                  />
                  <button className="btn btn-primary btn-sm" onClick={send} disabled={sending} style={{ minWidth: 76 }}>
                    {sending ? '发送中…' : '发送'}
                  </button>
                </div>

                <div className="field">
                  <span className="field-label">请求名称（保存时使用）</span>
                  <input
                    value={req.name}
                    onChange={e => setReq({ ...req, name: e.target.value })}
                    placeholder="例如：查询用户列表"
                  />
                </div>

                {showVars && (
                  <div className="field">
                    <span className="field-label">变量（一行一个，地址/请求头里用 {'{{名字}}'} 引用）</span>
                    <KvEditor
                      value={req.variables || ''}
                      onChange={v => setReq({ ...req, variables: v })}
                      keyPlaceholder="变量名，如 baseUrl"
                      valuePlaceholder="值，如 https://test.example.com"
                      sep="="
                    />
                  </div>
                )}

                <div className="api-io">
                  <div className="field">
                    <span className="field-label">请求头（一行一个）</span>
                    <KvEditor
                      value={req.headers}
                      onChange={v => setReq({ ...req, headers: v })}
                      keyPlaceholder="Header，如 Authorization"
                      valuePlaceholder="值，如 Bearer {{token}}"
                      sep=":"
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">
                      请求体{['GET', 'HEAD'].includes(req.method) ? '（该请求方式不使用）' : ''}
                    </span>
                    <textarea
                      value={req.body}
                      onChange={e => setReq({ ...req, body: e.target.value })}
                      rows={7}
                      placeholder={'{\n  "name": "test"\n}'}
                      disabled={['GET', 'HEAD'].includes(req.method)}
                    />
                  </div>
                </div>

                {error && (
                  <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', fontWeight: 400 }}>
                    {error}
                  </div>
                )}
              </div>
            </Panel>

            <Panel
              title="响应"
              meta={response ? `${response.status} · ${response.timeMs} ms` : '待发送'}
              tools={response && (
                <div className="resp-tabs">
                  <button className={`tab2${respTab === 'body' ? ' is-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => setRespTab('body')}>Body</button>
                  <button className={`tab2${respTab === 'headers' ? ' is-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => setRespTab('headers')}>Headers</button>
                  <IconBtn title="复制响应内容" onClick={() => navigator.clipboard.writeText(response.body)}>
                    <Icons.copy size={13} />
                  </IconBtn>
                </div>
              )}
            >
              {!response ? (
                <Empty
                  compact
                  icon={<Icons.terminal size={20} />}
                  title="还没有响应"
                  desc="填好地址后点右上角「发送」，响应体会显示在这里；JSON 会自动格式化"
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="resp-meta">
                    <span className={`resp-status ${response.status < 400 ? 'is-ok' : 'is-bad'}`}>
                      {response.status} {response.statusText}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {response.timeMs} ms · {(response.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  {respTab === 'body' ? (
                    <pre className="code2" style={{ maxHeight: '46vh' }}>{prettyBody || '（空响应体）'}</pre>
                  ) : (
                    <div style={{ maxHeight: '46vh', overflow: 'auto' }}>
                      <table className="kv">
                        <tbody>
                          {Object.entries(response.headers).map(([k, v]) => (
                            <tr key={k}><td>{k}</td><td><code>{v}</code></td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </Page>

      {/* 环境变量管理 */}
      <Modal
        open={envOpen}
        onClose={() => { setEnvOpen(false); setEnvDraft(null); }}
        title="环境变量"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setEnvOpen(false); setEnvDraft(null); }}>取消</button>
            <button className="btn btn-primary" onClick={saveEnv} disabled={!envDraft || !envDraft.name.trim()}>保存</button>
          </>
        }
      >
        {envs.length > 0 && (
          <div className="preset-list" style={{ marginBottom: 16 }}>
            {envs.map(e => (
              <div key={e.id} className="preset-row">
                <button className="preset-name" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setEnvDraft(e)}>
                  {e.name}
                </button>
                <span className="preset-desc">{e.vars.split('\n').filter(Boolean).join(' · ') || '（无变量）'}</span>
                <button className="ibtn" title="删除环境" onClick={() => removeEnv(e.id)}>
                  <Icons.trash size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {envDraft ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-group">
              <label>环境名称</label>
              <input
                value={envDraft.name}
                onChange={ev => setEnvDraft({ ...envDraft, name: ev.target.value })}
                placeholder="例如：测试环境"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>变量（每行 key=value）</label>
              <textarea
                value={envDraft.vars}
                onChange={ev => setEnvDraft({ ...envDraft, vars: ev.target.value })}
                rows={6}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                placeholder={'baseUrl=https://test.example.com\ntoken=abc123'}
              />
            </div>
          </div>
        ) : (
          <button className="btn btn-secondary btn-sm" onClick={() => setEnvDraft({ id: '', name: '', vars: 'baseUrl=', updatedAt: '' })}>
            <Icons.plus size={12} /> 新建环境
          </button>
        )}
      </Modal>

      {confirmNode}
    </div>
  );
}
