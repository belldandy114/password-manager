import React, { useEffect, useMemo, useState } from 'react';
import type { ApiRequest, ApiResponseData, ApiEnv, ApiHistoryItem, ApiJarCookie, AssertRule, SchemaDiff, ApiSnapshot } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Page, PageHead, Panel, Empty, IconBtn, Icons, Pill } from '../components/ui';
import { Modal } from '../components/Modal';
import { formatRecent } from '../utils/time';
import { runAssertions, hasAssertions, migrateAssertions, toAssertions, makeRule, ASSERT_OPS, type AssertResult } from '../utils/apiAssert';
import { schemaFromBody, diffSchema, isSameStructure } from '../utils/apiSchema';
import { codegenFromBody } from '../utils/apiCodegen';
import { useConfirm } from '../components/confirm';
import { parseCurl, buildCurl } from '../utils/curl';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

/** 请求体的发送方式：决定 Content-Type 与正文如何编码 */
const BODY_TYPES: { v: NonNullable<ApiRequest['bodyType']>; label: string; ph: string; hint: string }[] = [
  { v: 'json', label: 'JSON', ph: '{\n  "name": "test"\n}', hint: '原样发送，自动带 Content-Type: application/json（自己写了请求头就不覆盖）' },
  { v: 'form', label: '表单', ph: 'name=test\npage=1', hint: '每行 key=value，编码成 application/x-www-form-urlencoded' },
  { v: 'multipart', label: '文件', ph: 'file=@C:\\Users\\a\\test.png\ndesc=说明', hint: '每行 key=value；值以 @ 开头表示上传本地文件，其余当普通字段' },
  { v: 'raw', label: '原文', ph: '<user><name>test</name></user>', hint: '原样发送正文，Content-Type 在下面自己填（如 text/xml、text/plain）' },
  { v: 'none', label: '无', ph: '', hint: '不发送请求体' },
];

const emptyReq = (): ApiRequest => ({
  id: '', name: '', method: 'GET', url: '', headers: '', body: '', variables: '',
  cookies: '', assertions: {}, bodyType: 'json', rawContentType: '',
  updatedAt: new Date().toISOString(),
});

/** 旧数据的 cookies 合并进 headers（Cookie 现在统一写在请求头里） */
function migrateReq(r: ApiRequest): ApiRequest {
  if (!r.cookies) return { ...r, bodyType: r.bodyType || 'json' };
  const merged = withCookies(r.headers || '', r.cookies);
  return { ...r, headers: merged, cookies: '', bodyType: r.bodyType || 'json' };
}

/** 把 cookies（每行 key=value）拼成 Cookie 头；已有 Cookie 头时不覆盖 */
function withCookies(headers: string, cookies?: string): string {
  const ck = String(cookies || '').split('\n').map(l => l.trim()).filter(Boolean).join('; ');
  if (!ck) return headers;
  if (/^cookie\s*:/im.test(headers || '')) return headers;
  const base = String(headers || '').replace(/\n+$/, '');
  return `${base ? `${base}\n` : ''}Cookie: ${ck}`;
}

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
  // cURL 互转：粘贴导入 / 一键复制
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlText, setCurlText] = useState('');
  const [curlError, setCurlError] = useState('');
  const [curlCopied, setCurlCopied] = useState(false);
  const [sideTab, setSideTab] = useState<'saved' | 'history'>('saved');
  const [activeEnvId, setActiveEnvId] = useState('');
  const [envOpen, setEnvOpen] = useState(false);
  const [envDraft, setEnvDraft] = useState<ApiEnv | null>(null);
  const [response, setResponse] = useState<ApiResponseData | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [showVars, setShowVars] = useState(false);
  const [respTab, setRespTab] = useState<'body' | 'headers' | 'ts' | 'md'>('body');
  // 会话保持：把响应 Set-Cookie 收进主进程内存 Cookie 罐，后续请求自动补 Cookie 头
  const [autoSession, setAutoSession] = useState(() => {
    try { return localStorage.getItem('pm.api.autosession') !== '0'; } catch { return true; }
  });
  const [jar, setJar] = useState<ApiJarCookie[]>([]);
  /** 与已存快照的结构差异（有快照才会算） */
  const [schemaDiff, setSchemaDiff] = useState<SchemaDiff | null>(null);
  // 断言结果 / 断言编辑区展开
  const [assertResults, setAssertResults] = useState<AssertResult[]>([]);
  const [showAssert, setShowAssert] = useState(false);
  // 批量运行
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchRows, setBatchRows] = useState<{
    id: string; name: string; method: string; url: string; ok: boolean;
    status: number; timeMs: number; error?: string; asserts: AssertResult[];
  }[]>([]);

  const prettyBody = useMemo(() => {
    if (!response) return '';
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }, [response]);

  // 响应体 → TS 接口 / Markdown 表格（只在切到对应页签时用得上，但算一次就够）
  const codegen = useMemo(() => (response ? codegenFromBody(response.body) : null), [response]);

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

  const removeHistory = async (id: string) => {
    await saveHistory(history.filter(h => h.id !== id));
  };

  const clearHistory = async () => {
    await saveHistory([]);
  };

  /** 请求头里补一行 Cookie（Cookie 已并入请求头，不再单独一个字段） */
  const addCookieRow = () => {
    if (/^cookie\s*:/im.test(req.headers || '')) return;
    const base = String(req.headers || '').replace(/\n+$/, '');
    setReq({ ...req, headers: `${base ? `${base}\n` : ''}Cookie: ` });
  };

  /** multipart 选文件：把 `file=@绝对路径` 追加到请求体 */
  const pickUploadFile = async () => {
    const res = await window.electronAPI.pickFile('选择要上传的文件');
    if (!res.success || !res.data) return;
    const base = String(req.body || '').replace(/\n+$/, '');
    setReq({ ...req, body: `${base ? `${base}\n` : ''}file=@${res.data.file}` });
  };

  const refreshJar = async () => {
    const r = await window.electronAPI.apiCookies();
    if (r.success) setJar(r.data || []);
  };

  // 断言统一走「规则列表」：旧数据（5 个固定槽位）在这里被迁移成行，随后编辑都写回 rules
  const assertRules = useMemo(() => migrateAssertions(req.assertions), [req.assertions]);
  const setRules = (next: AssertRule[]) => setReq({ ...req, assertions: toAssertions(next) });

  useEffect(() => { refreshJar(); }, []);

  const send = async () => {
    if (!req.url.trim()) { setError('请输入 URL'); return; }
    setSending(true);
    setError('');
    setResponse(null);
    setAssertResults([]);
    const url = applyVars(req.url, req.variables || '');
    const headers = withCookies(applyVars(req.headers, req.variables || ''), req.cookies);
    const body = applyVars(req.body, req.variables || '');
    const res = await window.electronAPI.apiSend({
      method: req.method, url, headers, body,
      bodyType: req.bodyType || 'json', rawContentType: req.rawContentType || '',
      autoSession,
    });
    setSending(false);
    if (res.success && res.data) {
      setResponse(res.data);
      setAssertResults(runAssertions(req.assertions, res.data));
      // 有快照就比对结构（只比类型/字段，不比值）
      const next = schemaFromBody(res.data.body);
      if (req.snapshot) {
        setSchemaDiff(next ? diffSchema(req.snapshot.schema, next) : { added: [], removed: [], changed: [], comparable: false });
      } else {
        setSchemaDiff(null);
      }
      pushHistory(req.method, url, res.data.status, res.data.timeMs);
      if (res.data.setCookies && res.data.setCookies.length) refreshJar();
    } else {
      setError(res.error || '请求失败');
      pushHistory(req.method, url, 0, 0);
    }
  };

  /** 批量跑一组已保存请求（顺序执行，避免把对方服务打满） */
  const runBatch = async (list: ApiRequest[]) => {
    if (list.length === 0) return;
    setBatchRunning(true);
    setBatchRows([]);
    const rows: typeof batchRows = [];
    for (const r of list) {
      const url = applyVars(r.url, r.variables || '');
      const headers = withCookies(applyVars(r.headers, r.variables || ''), r.cookies);
      const body = applyVars(r.body, r.variables || '');
      const res = await window.electronAPI.apiSend({
        method: r.method, url, headers, body,
        bodyType: r.bodyType || 'json', rawContentType: r.rawContentType || '',
        autoSession,
      });
      const asserts = res.success && res.data ? runAssertions(r.assertions, res.data) : [];
      const ok = !!(res.success && res.data) && (asserts.length === 0 || asserts.every(a => a.ok));
      rows.push({
        id: r.id, name: r.name, method: r.method, url,
        ok, status: res.data?.status || 0, timeMs: res.data?.timeMs || 0,
        error: res.success ? undefined : res.error, asserts,
      });
      setBatchRows([...rows]);
    }
    setBatchRunning(false);
  };

  /** 把当前响应的结构存成快照（只存类型，不存值） */
  const saveSnapshot = async () => {
    if (!response) return;
    const schema = schemaFromBody(response.body);
    if (!schema) { setError('响应不是合法 JSON，无法存结构快照'); return; }
    const snapshot: ApiSnapshot = { at: new Date().toISOString(), schema };
    const nextReq: ApiRequest = { ...req, snapshot, updatedAt: new Date().toISOString() };
    setReq(nextReq);
    setSchemaDiff(null);
    setError('');
    // 已经保存过的请求顺手落盘，避免「存了快照但没保存请求」
    if (nextReq.id) await save(items.map(i => (i.id === nextReq.id ? nextReq : i)));
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

  /**
   * 复制当前请求为 curl。
   * clipboard API 在窗口未聚焦/无权限时会抛错，兜底用 textarea + execCommand，
   * 否则用户点了没反应（报错也只停在控制台）。
   */
  const copyCurlCmd = async () => {
    const text = buildCurl(req);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 1600);
    } else {
      setError('复制失败：剪贴板不可用（窗口失去焦点时可能出现）');
    }
  };

  const removeRequest = async (id: string) => {
    await save(items.filter(i => i.id !== id));
    if (req.id === id) { setReq(emptyReq()); setSchemaDiff(null); }
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
              <button className="btn btn-secondary btn-sm" onClick={() => { setCurlText(''); setCurlError(''); setCurlOpen(true); }} title="粘贴同事/文档里的 curl 命令，自动拆成方法、地址、请求头、请求体">
                <Icons.download size={13} /> 从 cURL 导入
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setReq(emptyReq()); setSchemaDiff(null); setResponse(null); }}>
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
                {sideTab === 'history' && history.length > 0 && (
                  <button
                    className="ibtn"
                    title="清空请求历史"
                    aria-label="清空请求历史"
                    onClick={() => ask({
                      title: '清空请求历史',
                      message: `确定清空全部 ${history.length} 条请求记录？`,
                      confirmText: '清空',
                      onOk: clearHistory,
                    })}
                  >
                    <Icons.trash size={12} />
                  </button>
                )}
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
                      <IconBtn
                        title="删除这条记录"
                        onClick={e => { e.stopPropagation(); removeHistory(h.id); }}
                      >
                        <Icons.close size={12} />
                      </IconBtn>
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
                    onClick={() => { setReq(migrateReq(i)); setResponse(null); setSchemaDiff(null); setError(''); }}
                    title={i.url}
                  >
                    <span className="api-pick" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="tbl-check"
                        checked={picked.has(i.id)}
                        onChange={() => setPicked(prev => {
                          const next = new Set(prev);
                          if (next.has(i.id)) next.delete(i.id); else next.add(i.id);
                          return next;
                        })}
                        title="勾选后批量运行"
                      />
                    </span>
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
            {sideTab === 'saved' && items.length > 0 && (
              <div className="api-batch-bar">
                <label className="wk-check">
                  <input
                    type="checkbox"
                    checked={picked.size > 0 && picked.size === items.length}
                    onChange={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map(x => x.id)))}
                  />
                  全选
                </label>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={picked.size === 0 || batchRunning}
                  onClick={() => {
                    setBatchOpen(true);
                    runBatch(items.filter(x => picked.has(x.id)));
                  }}
                >
                  {batchRunning ? `运行中 ${batchRows.length}/${picked.size}` : `批量运行（${picked.size}）`}
                </button>
              </div>
            )}
          </Panel>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <Panel
              title="请求"
              meta={req.name || '未命名'}
              tools={
                <div className="resp-tabs">
                  <button
                    className="tab2"
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    onClick={copyCurlCmd}
                    title="把当前请求复制成 curl 命令，可直接粘给同事或在终端跑"
                  >
                    <Icons.copy size={12} /> {curlCopied ? '已复制' : '复制 cURL'}
                  </button>
                  <button
                    className={`tab2${showVars ? ' is-active' : ''}`}
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    onClick={() => setShowVars(v => !v)}
                    title="展开/收起变量表"
                  >
                    <Icons.tag size={12} /> 变量
                  </button>
                </div>
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

                {/* 会话保持：响应里的 Set-Cookie 收进内存 Cookie 罐，下次请求自动带上 */}
                <div className="api-session-row">
                  <label className="api-session-toggle" title="开启后，响应里的 Set-Cookie 会收进内存 Cookie 罐，后续请求自动补 Cookie 头（仅本次运行有效，锁定即清空）">
                    <input
                      type="checkbox"
                      checked={autoSession}
                      onChange={e => {
                        const v = e.target.checked;
                        setAutoSession(v);
                        try { localStorage.setItem('pm.api.autosession', v ? '1' : '0'); } catch { /* ignore */ }
                      }}
                    />
                    <span>自动保持会话</span>
                  </label>
                  {jar.length > 0 ? (
                    <>
                      <span className="pill pill-ok" style={{ padding: '2px 8px', fontSize: 11 }}>
                        Cookie 罐 {jar.length} 个
                      </span>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          await window.electronAPI.apiCookiesClear();
                          setJar([]);
                        }}
                      >
                        清空
                      </button>
                    </>
                  ) : (
                    <span className="text-sm text-muted">Cookie 罐为空（登录接口返回 Set-Cookie 后自动填充）</span>
                  )}
                  {response?.setCookies && response.setCookies.length > 0 && (
                    <span className="text-sm text-muted">本次收到 {response.setCookies.length} 个 Set-Cookie</span>
                  )}
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
                    <div className="field-label-row">
                      <span className="field-label">请求头（一行一个，Cookie 写在里面）</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={addCookieRow}
                        title="在请求头里追加一行 Cookie"
                      >
                        <Icons.plus size={11} /> Cookie
                      </button>
                    </div>
                    <KvEditor
                      value={req.headers}
                      onChange={v => setReq({ ...req, headers: v })}
                      keyPlaceholder="Header，如 Authorization / Cookie"
                      valuePlaceholder="值，如 Bearer {{token}}"
                      sep=":"
                    />
                    <div className="assert-hint">
                      Cookie 直接写成一行：<code>Cookie: token=abc; SESSION=xxx</code>
                    </div>
                  </div>

                  {(() => {
                    const bodyless = ['GET', 'HEAD'].includes(req.method);
                    const bt = req.bodyType || 'json';
                    const meta = BODY_TYPES.find(b => b.v === bt) || BODY_TYPES[0];
                    return (
                      <div className="field">
                        <div className="field-label-row">
                          <span className="field-label">
                            请求体{bodyless ? '（该请求方式不使用）' : ''}
                          </span>
                          {!bodyless && (
                            <div className="resp-tabs">
                              {BODY_TYPES.map(b => (
                                <button
                                  key={b.v}
                                  className={`tab2${bt === b.v ? ' is-active' : ''}`}
                                  style={{ padding: '3px 8px', fontSize: 11 }}
                                  onClick={() => setReq({ ...req, bodyType: b.v })}
                                  title={b.hint}
                                >
                                  {b.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {!bodyless && bt !== 'none' && (
                          <textarea
                            value={req.body}
                            onChange={e => setReq({ ...req, body: e.target.value })}
                            rows={7}
                            placeholder={meta.ph}
                          />
                        )}

                        {!bodyless && bt === 'raw' && (
                          <input
                            value={req.rawContentType || ''}
                            onChange={e => setReq({ ...req, rawContentType: e.target.value })}
                            placeholder="Content-Type，如 text/xml; charset=UTF-8（留空用 text/plain）"
                            spellCheck={false}
                          />
                        )}

                        {!bodyless && bt === 'multipart' && (
                          <div className="mp-bar">
                            <button type="button" className="btn btn-ghost btn-sm" onClick={pickUploadFile}>
                              <Icons.plus size={11} /> 选择文件
                            </button>
                            <span className="text-sm text-muted">值以 @ 开头 = 上传本地文件</span>
                          </div>
                        )}

                        <div className="assert-hint">{bodyless ? 'GET / HEAD 不发送请求体' : meta.hint}</div>
                      </div>
                    );
                  })()}

                  <div className={`field api-sec`}>
                    <button
                      type="button"
                      className="assert-toggle"
                      onClick={() => setShowAssert(v => !v)}
                    >
                      <span>断言</span>
                      <span className={`assert-badge${hasAssertions(req.assertions) ? ' is-on' : ''}`}>
                        {hasAssertions(req.assertions) ? '已配置' : '未配置'}
                      </span>
                      <span className="assert-caret">{showAssert ? '收起' : '展开'}</span>
                    </button>
                    {showAssert && (
                      <div className="assert-rules">
                        {assertRules.length === 0 && (
                          <div className="assert-hint" style={{ marginTop: 0 }}>
                            还没有断言。点下面「添加断言」按需加行，例如「状态码 = 2xx」+「data.list[0].id 存在」。
                          </div>
                        )}
                        {assertRules.map((r) => {
                          const meta = ASSERT_OPS.find(o => o.v === r.op) || ASSERT_OPS[0];
                          return (
                            <div className="assert-rule" key={r.id}>
                              <select
                                value={r.op}
                                onChange={e => {
                                  const op = e.target.value as AssertRule['op'];
                                  setRules(assertRules.map(x => x.id === r.id ? { ...x, op, target: '', value: '' } : x));
                                }}
                              >
                                {ASSERT_OPS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                              </select>
                              <input
                                value={r.target || ''}
                                disabled={meta.targetPh === '—'}
                                placeholder={meta.targetPh}
                                onChange={e => setRules(assertRules.map(x => x.id === r.id ? { ...x, target: e.target.value } : x))}
                              />
                              <input
                                value={r.value || ''}
                                disabled={meta.valuePh === '—'}
                                placeholder={meta.valuePh}
                                onChange={e => setRules(assertRules.map(x => x.id === r.id ? { ...x, value: e.target.value } : x))}
                              />
                              <label className="assert-neg" title="取反：不等于 / 不包含 / 不存在">
                                <input
                                  type="checkbox"
                                  checked={!!r.negate}
                                  onChange={e => setRules(assertRules.map(x => x.id === r.id ? { ...x, negate: e.target.checked } : x))}
                                />
                                <span>取反</span>
                              </label>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => setRules(assertRules.filter(x => x.id !== r.id))}
                              >
                                删除
                              </button>
                            </div>
                          );
                        })}
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ alignSelf: 'flex-start' }}
                          onClick={() => setRules([...assertRules, makeRule('status')])}
                        >
                          ＋ 添加断言
                        </button>
                      </div>
                    )}
                    <div className="assert-hint">
                      发送后自动校验，通过看「响应」上方的断言条；批量运行时也会按断言判断成败。
                    </div>
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
                  <button className={`tab2${respTab === 'ts' ? ' is-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => setRespTab('ts')} title="根据响应结构生成 TypeScript 接口">TS 类型</button>
                  <button className={`tab2${respTab === 'md' ? ' is-active' : ''}`} style={{ padding: '4px 10px', fontSize: 11.5 }} onClick={() => setRespTab('md')} title="把响应转成 Markdown 表格，可直接粘进禅道/群消息">表格</button>
                  <button
                    className="tab2"
                    style={{ padding: '4px 10px', fontSize: 11.5 }}
                    title="把这次响应的结构存成快照；以后每次发送都会跟它比，字段被删/改名/换类型会提示"
                    onClick={saveSnapshot}
                  >
                    {req.snapshot ? '重存快照' : '存结构快照'}
                  </button>
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
                  {assertResults.length > 0 && (
                    <div className={`assert-bar${assertResults.every(a => a.ok) ? ' is-ok' : ' is-bad'}`}>
                      <div className="assert-bar-head">
                        断言 {assertResults.filter(a => a.ok).length} / {assertResults.length}
                        {assertResults.every(a => a.ok) ? ' 全部通过' : ' 有失败项'}
                      </div>
                      <div className="assert-list">
                        {assertResults.map((a, i) => (
                          <div key={i} className={`assert-row${a.ok ? ' is-ok' : ' is-bad'}`}>
                            <span className="assert-flag">{a.ok ? '✓' : '✗'}</span>
                            <span className="assert-name">{a.name}</span>
                            <span className="assert-detail">{a.detail}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {schemaDiff && (
                    <div className={`assert-bar${!schemaDiff.comparable ? ' is-bad' : isSameStructure(schemaDiff) ? ' is-ok' : ' is-bad'}`}>
                      <div className="assert-bar-head">
                        <span>
                          结构比对：
                          {!schemaDiff.comparable
                            ? '响应不是 JSON，无法比对'
                            : isSameStructure(schemaDiff)
                              ? '与快照一致'
                              : `新增 ${schemaDiff.added.length} · 缺失 ${schemaDiff.removed.length} · 类型变化 ${schemaDiff.changed.length}`}
                        </span>
                        {req.snapshot && (
                          <span className="text-sm text-muted" style={{ marginLeft: 'auto', fontWeight: 400 }}>
                            快照于 {formatRecent(req.snapshot.at)}
                          </span>
                        )}
                      </div>
                      <div className="assert-list">
                        {schemaDiff.added.slice(0, 20).map(p => (
                          <div key={`a-${p}`} className="assert-row">
                            <span className="assert-flag">＋</span>
                            <span className="assert-name">{p}</span>
                            <span className="assert-detail">新增字段</span>
                          </div>
                        ))}
                        {schemaDiff.removed.slice(0, 20).map(p => (
                          <div key={`r-${p}`} className="assert-row is-bad">
                            <span className="assert-flag">－</span>
                            <span className="assert-name">{p}</span>
                            <span className="assert-detail">快照里有、这次没有</span>
                          </div>
                        ))}
                        {schemaDiff.changed.slice(0, 20).map(c => (
                          <div key={`c-${c.path}`} className="assert-row is-bad">
                            <span className="assert-flag">≠</span>
                            <span className="assert-name">{c.path}</span>
                            <span className="assert-detail">{c.from} → {c.to}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {respTab === 'body' ? (
                    <pre className="code2" style={{ maxHeight: '46vh' }}>{prettyBody || '（空响应体）'}</pre>
                  ) : respTab === 'ts' ? (
                    codegen ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(codegen.ts)}>复制类型</button>
                          <span className="text-sm text-muted" style={{ alignSelf: 'center' }}>按响应结构生成，字段类型冲突时降级为 unknown</span>
                        </div>
                        <pre className="code2" style={{ maxHeight: '42vh' }}>{codegen.ts}</pre>
                      </div>
                    ) : (
                      <Empty compact icon={<Icons.terminal size={20} />} title="响应不是 JSON" desc="只有 JSON 响应才能生成 TypeScript 类型" />
                    )
                  ) : respTab === 'md' ? (
                    codegen ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(codegen.md)}>复制表格</button>
                          <span className="text-sm text-muted" style={{ alignSelf: 'center' }}>可直接粘进禅道、周报或群消息</span>
                        </div>
                        <pre className="code2" style={{ maxHeight: '42vh' }}>{codegen.md}</pre>
                      </div>
                    ) : (
                      <Empty compact icon={<Icons.terminal size={20} />} title="响应不是 JSON" desc="只有 JSON 响应才能转成表格" />
                    )
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

      {/* 从 cURL 导入 */}
      <Modal
        open={curlOpen}
        onClose={() => setCurlOpen(false)}
        title="从 cURL 导入"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setCurlOpen(false)}>取消</button>
            <button
              className="btn btn-primary"
              disabled={!curlText.trim()}
              onClick={() => {
                const r = parseCurl(curlText);
                if (!r.ok) { setCurlError(r.error); return; }
                setReq(prev => ({
                  ...prev,
                  method: r.request.method,
                  url: r.request.url,
                  headers: r.request.headers,
                  body: r.request.body,
                  bodyType: r.request.bodyType,
                  rawContentType: r.request.rawContentType,
                }));
                setResponse(null);
                setSchemaDiff(null);
                setError('');
                setCurlError('');
                setCurlText('');
                setCurlOpen(false);
              }}
            >
              解析并填入
            </button>
          </>
        }
      >
        <div className="curl-import">
          <div className="form-group">
            <label>curl 命令</label>
            <textarea
              className="curl-input"
              value={curlText}
              onChange={e => { setCurlText(e.target.value); setCurlError(''); }}
              rows={8}
              spellCheck={false}
              placeholder={`curl -X POST 'https://api.example.com/users' \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"name":"张三"}'`}
              autoFocus
            />
            <div className="input-hint">
              支持 <code>-X</code> / <code>-H</code> / <code>-d</code> / <code>--data-raw</code> /
              <code>--data-urlencode</code> / <code>-F</code> / <code>-b</code> / <code>-u</code> /
              <code>-G</code>；<code>{'{{变量}}'}</code> 原样保留。多行（含 <code>\</code> 或 <code>^</code> 续行）也能识别。
            </div>
          </div>
          {curlError && (
            <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400, whiteSpace: 'pre-wrap' }}>
              {curlError}
            </div>
          )}
        </div>
      </Modal>

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

      <Modal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title="批量运行结果"
        footer={<button className="btn btn-secondary" onClick={() => setBatchOpen(false)}>关闭</button>}
      >
        {batchRows.length === 0 ? (
          <div className="pg-sub">正在运行…</div>
        ) : (
          <>
            <div className="batch-summary">
              <span className={`batch-pass${batchRows.filter(r => r.ok).length === batchRows.length ? ' is-all' : ''}`}>
                通过 {batchRows.filter(r => r.ok).length} / {batchRows.length}
              </span>
              <span className="pg-sub" style={{ marginTop: 0 }}>
                失败 {batchRows.filter(r => !r.ok).length} 条
              </span>
            </div>
            <div className="batch-list">
              {batchRows.map(r => (
                <div key={r.id} className={`batch-row${r.ok ? ' is-ok' : ' is-bad'}`}>
                  <span className="batch-flag">{r.ok ? '✓' : '✗'}</span>
                  <span className={`method m-${r.method}`}>{r.method}</span>
                  <span className="batch-name" title={r.url}>{r.name || r.url}</span>
                  <span className="batch-meta">
                    {r.error ? r.error : `${r.status} · ${r.timeMs}ms`}
                  </span>
                  {r.asserts.length > 0 && (
                    <span className="batch-asserts">
                      断言 {r.asserts.filter(a => a.ok).length}/{r.asserts.length}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      {confirmNode}
    </div>
  );
}
