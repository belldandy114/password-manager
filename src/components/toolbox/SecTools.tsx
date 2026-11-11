import React, { useMemo, useState } from 'react';
import { signJwt, verifyJwtHs256, decodeJwt } from '../../utils/jwt';
import { computeSign, type SignAlgo, type SignMode } from '../../utils/sign';
import { useToolState, useToolResult, copyText, ToolBlock } from './shell';

/* ============================ JWT 生成 / 解析 ============================ */

const JWT_PRESETS: Array<{ label: string; payload: string }> = [
  { label: '最小', payload: '{\n  "sub": "1001",\n  "name": "张三"\n}' },
  { label: '带角色', payload: '{\n  "sub": "1001",\n  "name": "张三",\n  "roles": ["qa", "admin"],\n  "tenant": "acme"\n}' },
  { label: '带 scope', payload: '{\n  "sub": "svc-order",\n  "scope": "order:read order:write",\n  "iss": "https://auth.example.com"\n}' },
];

export function JwtTool() {
  const [payload, setPayload] = useToolState('payload', JWT_PRESETS[0].payload);
  const [secret, setSecret] = useToolState('secret', 'your-256-bit-secret');
  const [expSec, setExpSec] = useToolState('exp', 3600);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const decoded = useMemo(() => (token ? decodeJwt(token) : {}), [token]);
  useToolResult(token);

  const gen = async () => {
    setMsg('');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload) as Record<string, unknown>;
    } catch (e) {
      setMsg(`payload 不是合法 JSON：${(e as Error).message}`);
      return;
    }
    const r = await signJwt({ payload: body, secret, expiresInSec: expSec });
    if (!r.ok) { setMsg(r.error); return; }
    setToken(r.token);
    const ok = await verifyJwtHs256(r.token, secret);
    setMsg(ok ? '已生成，并用同一 secret 自校验通过' : '已生成，但自校验失败（少见，检查 secret 是否含不可见字符）');
  };

  const expText = useMemo(() => {
    const p = decoded.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.exp !== 'number') return '';
    const d = new Date(p.exp * 1000);
    const left = Math.round((p.exp * 1000 - Date.now()) / 60000);
    return `过期时间 ${d.toLocaleString('zh-CN', { hour12: false })}（${left > 0 ? `${left} 分钟后过期` : '已过期'}）`;
  }, [decoded]);

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <span className="tb-row-spacer" />
        <span className="text-sm text-muted">有效期</span>
        <select className="json-indent" value={expSec} onChange={(e) => setExpSec(Number(e.target.value))} aria-label="有效期">
          {[0, 300, 3600, 7200, 86400, 604800].map((s) => <option key={s} value={s}>{s === 0 ? '不设 exp' : s < 3600 ? `${s / 60} 分钟` : s < 86400 ? `${s / 3600} 小时` : `${s / 86400} 天`}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={gen}>生成 token</button>
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (token && await copyText(token)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} disabled={!token}>{copied ? '已复制' : '复制 token'}</button>
      </div>

      <div className="tb-panes">
        <ToolBlock title="Payload（JSON）" extra={
          <div className="tb-chip-row">
            {JWT_PRESETS.map((p) => <button key={p.label} className="chip" onClick={() => { setPayload(p.payload); setToken(''); }}>{p.label}</button>)}
          </div>
        }>
          <textarea className="tb-textarea" value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} aria-label="JWT Payload" />
        </ToolBlock>

        <ToolBlock title="Secret（HS256）">
          <input className="tb-input" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} placeholder="your-256-bit-secret" aria-label="your-256-bit-secret" />
          <div className="tb-divider" />
          <div className="tb-label">Token</div>
          <pre className="tb-pre tb-pre-wrap">{token || '（点「生成 token」）'}</pre>
          {msg && <div className="text-sm text-muted">{msg}</div>}
          {expText && (<><div className="tb-divider" /><div className="tb-badge">{expText}</div></>)}
        </ToolBlock>
      </div>

      {token && (
        <ToolBlock title="解析结果（不校验签名）">
          <pre className="tb-pre tb-pre-wrap">{JSON.stringify({ header: decoded.header, payload: decoded.payload }, null, 2)}</pre>
        </ToolBlock>
      )}
    </div>
  );
}

/* ============================ 签名计算 ============================ */

export function SignTool() {
  const [params, setParams] = useToolState('params', 'name=张三\nage=18\nnonce=abc123');
  const [secret, setSecret] = useToolState('secret', 'my-secret');
  const [mode, setMode] = useToolState<SignMode>('mode', 'kv');
  const [algo, setAlgo] = useToolState<SignAlgo>('algo', 'md5');
  const [upper, setUpper] = useToolState('upper', false);
  const [secretAt, setSecretAt] = useToolState<'end' | 'start' | 'none'>('secretAt', 'end');
  const [result, setResult] = useState<{ input: string; sign: string; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useToolResult(result?.sign || '');

  const run = async () => {
    const r = await computeSign({ params, secret, mode, algo, upper, secretAt });
    if (!r.ok) { setResult({ input: '', sign: '', error: r.error }); return; }
    setResult({ input: r.signingInput || '', sign: r.sign || '' });
  };

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <select className="json-indent" value={mode} onChange={(e) => setMode(e.target.value as SignMode)} aria-label="拼接方式">
          <option value="kv">k=v 按 key 排序</option>
          <option value="concat">只拼值</option>
          <option value="json">排序后 JSON</option>
        </select>
        <select className="json-indent" value={algo} onChange={(e) => setAlgo(e.target.value as SignAlgo)} aria-label="算法">
          <option value="md5">MD5</option>
          <option value="sha1">SHA-1</option>
          <option value="sha256">SHA-256</option>
        </select>
        <select className="json-indent" value={secretAt} onChange={(e) => setSecretAt(e.target.value as 'end' | 'start' | 'none')} aria-label="secret 位置">
          <option value="end">secret 拼在末尾</option>
          <option value="start">secret 拼在开头</option>
          <option value="none">不拼 secret</option>
        </select>
        <label className="json-chk"><input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} />大写</label>
        <span className="tb-row-spacer" />
        <button className="btn btn-primary btn-sm" onClick={run}>计算签名</button>
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (result?.sign && await copyText(result.sign)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} disabled={!result?.sign}>{copied ? '已复制' : '复制签名'}</button>
      </div>

      <div className="tb-panes">
        <ToolBlock title="参数（每行 key=value，或直接粘 JSON 对象）">
          <textarea className="tb-textarea" value={params} onChange={(e) => setParams(e.target.value)} spellCheck={false} aria-label="签名参数" />
          <div className="tb-divider" />
          <div className="tb-label">Secret</div>
          <input className="tb-input" value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} aria-label="Secret" />
        </ToolBlock>

        <ToolBlock title="结果">
          {!result && <div className="tb-empty">填好参数点「计算签名」</div>}
          {result?.error && <div className="json-error"><div className="json-error-title">❌ 参数有误</div><div className="json-error-msg">{result.error}</div></div>}
          {result && !result.error && (
            <>
              <div className="tb-label">参与摘要的原文</div>
              <pre className="tb-pre tb-pre-wrap">{result.input}</pre>
              <div className="tb-divider" />
              <div className="tb-label">签名</div>
              <pre className="tb-pre tb-pre-sign">{result.sign}</pre>
            </>
          )}
        </ToolBlock>
      </div>
      <div className="text-sm text-muted">空值参数会参与排序与拼接（多数网关如此）；secret 拼接方式按你对接的文档选，原文会显示出来方便比对。</div>
    </div>
  );
}