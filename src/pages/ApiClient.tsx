import React, { useMemo, useState } from 'react';
import type { ApiRequest, ApiResponseData } from '../types';
import { useCollection, PageHeader, EmptyHint } from '../hooks/useCollection';

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
      <div className="module-page api-page">
        <PageHeader title="接口调试" desc="直接发 HTTP 请求（不受 CORS 限制），支持 {{变量}} 替换与请求保存">
          <button className="btn btn-secondary btn-sm" onClick={() => setReq(emptyReq())}>新建请求</button>
          <button className="btn btn-secondary btn-sm" onClick={saveRequest}>保存请求</button>
        </PageHeader>

        <div className="api-layout">
          {/* 左侧：已保存请求 */}
          <div className="api-sidebar">
            <div className="api-sidebar-title">已保存（{items.length}）</div>
            {items.length === 0 ? (
              <div className="text-sm text-muted" style={{ padding: '8px 4px' }}>发送并保存后会出现在这里</div>
            ) : (
              items.map(i => (
                <div key={i.id} className={`api-item ${req.id === i.id ? 'active' : ''}`} onClick={() => { setReq(i); setResponse(null); }}>
                  <span className={`api-method m-${i.method}`}>{i.method}</span>
                  <span className="api-item-name" title={i.url}>{i.name}</span>
                  <button className="btn-icon-danger" onClick={e => { e.stopPropagation(); removeRequest(i.id); }}>×</button>
                </div>
              ))
            )}
          </div>

          {/* 右侧：编辑与响应 */}
          <div className="api-main">
            <div className="api-url-row">
              <select value={req.method} onChange={e => setReq({ ...req, method: e.target.value })}>
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="api-url"
                value={req.url}
                onChange={e => setReq({ ...req, url: e.target.value })}
                placeholder="https://api.example.com/users  支持 {{baseUrl}}/path"
                onKeyDown={e => { if (e.key === 'Enter') send(); }}
              />
              <button className="btn btn-primary btn-sm" onClick={send} disabled={sending}>
                {sending ? '发送中…' : '发送'}
              </button>
            </div>

            <div className="api-tabs">
              <button className={`api-tab ${showVars ? 'active' : ''}`} onClick={() => setShowVars(v => !v)}>
                变量 {showVars ? '▴' : '▾'}
              </button>
              <input
                className="api-name"
                value={req.name}
                onChange={e => setReq({ ...req, name: e.target.value })}
                placeholder="请求名称（保存时使用）"
              />
            </div>

            {showVars && (
              <textarea
                className="code-input api-vars"
                value={req.variables || ''}
                onChange={e => setReq({ ...req, variables: e.target.value })}
                rows={4}
                placeholder={'baseUrl=https://test.example.com\ntoken=abc123'}
              />
            )}

            <div className="api-pair">
              <div className="api-field">
                <label>请求头（每行 key: value）</label>
                <textarea
                  className="code-input"
                  value={req.headers}
                  onChange={e => setReq({ ...req, headers: e.target.value })}
                  rows={5}
                  placeholder={'Content-Type: application/json\nAuthorization: Bearer {{token}}'}
                />
              </div>
              <div className="api-field">
                <label>请求体</label>
                <textarea
                  className="code-input"
                  value={req.body}
                  onChange={e => setReq({ ...req, body: e.target.value })}
                  rows={5}
                  placeholder={'{\n  "name": "test"\n}'}
                  disabled={['GET', 'HEAD'].includes(req.method)}
                />
              </div>
            </div>

            {error && <div className="api-error">{error}</div>}

            {response && (
              <div className="api-response">
                <div className="api-response-meta">
                  <span className={`api-status ${response.status < 400 ? 'ok' : 'bad'}`}>
                    {response.status} {response.statusText}
                  </span>
                  <span className="text-sm text-muted">{response.timeMs} ms · {(response.size / 1024).toFixed(1)} KB</span>
                  <div className="api-resp-tabs">
                    <button className={`api-tab ${respTab === 'body' ? 'active' : ''}`} onClick={() => setRespTab('body')}>Body</button>
                    <button className={`api-tab ${respTab === 'headers' ? 'active' : ''}`} onClick={() => setRespTab('headers')}>Headers</button>
                    <button className="api-tab" onClick={() => navigator.clipboard.writeText(response.body)}>复制</button>
                  </div>
                </div>
                {respTab === 'body' ? (
                  <pre className="code-block api-resp-body">{prettyBody}</pre>
                ) : (
                  <table className="kv-table">
                    <tbody>
                      {Object.entries(response.headers).map(([k, v]) => (
                        <tr key={k}><td>{k}</td><td><code>{v}</code></td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
