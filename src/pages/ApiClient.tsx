import React, { useMemo, useState } from 'react';
import type { ApiRequest, ApiResponseData } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Page, PageHead, Panel, Empty, IconBtn, Icons } from '../components/ui';

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

export function ApiClient() {
  const { items, save } = useCollection<ApiRequest>('apiRequests');
  const [req, setReq] = useState<ApiRequest>(emptyReq);
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
    if (res.success && res.data) setResponse(res.data);
    else setError(res.error || '请求失败');
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
    if (!confirm('删除这条请求？')) return;
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
          <Panel title="已保存" meta={items.length} flush>
            <div className="api-side" style={{ padding: 8 }}>
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
                    <IconBtn title="删除" danger onClick={e => { e.stopPropagation(); removeRequest(i.id); }}>
                      <Icons.trash size={12} />
                    </IconBtn>
                  </div>
                ))
              )}
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
                    <span className="field-label">变量（每行 key=value，请求地址/请求头里用 {'{{名字}}'} 引用）</span>
                    <textarea
                      value={req.variables || ''}
                      onChange={e => setReq({ ...req, variables: e.target.value })}
                      rows={3}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
                      placeholder={'baseUrl=https://test.example.com\ntoken=abc123'}
                    />
                  </div>
                )}

                <div className="api-io">
                  <div className="field">
                    <span className="field-label">请求头（每行 key: value）</span>
                    <textarea
                      value={req.headers}
                      onChange={e => setReq({ ...req, headers: e.target.value })}
                      rows={7}
                      placeholder={'Content-Type: application/json\nAuthorization: Bearer {{token}}'}
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
    </div>
  );
}
