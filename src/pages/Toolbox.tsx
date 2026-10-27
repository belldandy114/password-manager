import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { Page, PageHead, Panel, Icons } from '../components/ui';

/* =============================================================
   工具箱：时间戳 / 编码 / 哈希&JWT / 正则 / 文本对比 / 数据校验
   ============================================================= */

type ToolId = 'timestamp' | 'encode' | 'hash' | 'regex' | 'diff' | 'validate';

const TOOLS: { id: ToolId; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: 'timestamp', label: '时间戳', icon: <Icons.refresh size={13} />, desc: 'Unix 时间戳与日期互转，造数和看日志时最常用' },
  { id: 'encode', label: '编码转换', icon: <Icons.terminal size={13} />, desc: 'Base64 / URL / HTML / Unicode / Hex 互转' },
  { id: 'hash', label: '哈希 & JWT', icon: <Icons.key size={13} />, desc: 'MD5 / SHA 摘要，JWT 解析（看 token 过期时间）' },
  { id: 'regex', label: '正则测试', icon: <Icons.search size={13} />, desc: '实时匹配高亮，内置常用正则' },
  { id: 'diff', label: '文本对比', icon: <Icons.list size={13} />, desc: '两段文本逐行差异，回归比对很实用' },
  { id: 'validate', label: '数据校验', icon: <Icons.check size={13} />, desc: '身份证 / 手机号 / 银行卡 / 统一社会信用代码' },
];

/* ---------------- 时间戳 ---------------- */
function TimestampTool() {
  const [ts, setTs] = useState(String(Date.now()));
  const [now, setNow] = useState(Date.now());
  const [dateStr, setDateStr] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const parsed = useMemo(() => {
    const raw = ts.trim();
    if (!raw) return null;
    let ms: number;
    if (/^\d+$/.test(raw)) {
      ms = raw.length >= 13 ? Number(raw) : Number(raw) * 1000;
    } else {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return null;
      ms = d.getTime();
    }
    const d = new Date(ms);
    return {
      ms,
      sec: Math.floor(ms / 1000),
      local: d.toLocaleString('zh-CN', { hour12: false }),
      utc: d.toUTCString(),
      iso: d.toISOString(),
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
    };
  }, [ts]);

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>时间戳 / 日期字符串</label>
        <div className="tool-inline">
          <input value={ts} onChange={e => setTs(e.target.value)} placeholder="1700000000 或 2026-10-27 12:00:00" />
          <button className="btn btn-sm btn-secondary" onClick={() => setTs(String(Date.now()))}>填入当前毫秒</button>
          <button className="btn btn-sm btn-secondary" onClick={() => setTs(String(Math.floor(Date.now() / 1000)))}>填入当前秒</button>
        </div>
      </div>

      <div className="tool-result">
        <div className="tool-live">当前时间：{new Date(now).toLocaleString('zh-CN', { hour12: false })}（{Math.floor(now / 1000)} 秒 / {now} 毫秒）</div>
        {!parsed && <div className="text-muted text-sm">无法解析，请输入数字时间戳或可识别的日期</div>}
        {parsed && (
          <table className="kv-table">
            <tbody>
              <tr><td>秒级时间戳</td><td><code>{parsed.sec}</code></td></tr>
              <tr><td>毫秒时间戳</td><td><code>{parsed.ms}</code></td></tr>
              <tr><td>本地时间</td><td><code>{parsed.local} {parsed.weekday}</code></td></tr>
              <tr><td>UTC</td><td><code>{parsed.utc}</code></td></tr>
              <tr><td>ISO 8601</td><td><code>{parsed.iso}</code></td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="tool-field">
        <label>日期 → 时间戳</label>
        <div className="tool-inline">
          <input value={dateStr} onChange={e => setDateStr(e.target.value)} placeholder="2026-10-27T16:00" type="datetime-local" />
          <button className="btn btn-sm btn-secondary" onClick={() => {
            if (!dateStr) return;
            const d = new Date(dateStr);
            if (!isNaN(d.getTime())) setTs(String(d.getTime()));
          }}>转换</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 编码转换 ---------------- */
const ENCODINGS = ['Base64', 'URL', 'HTML', 'Unicode', 'Hex'] as const;
type Encoding = typeof ENCODINGS[number];

function encodeText(text: string, kind: Encoding): string {
  switch (kind) {
    case 'Base64': {
      const bytes = new TextEncoder().encode(text);
      let bin = '';
      bytes.forEach(b => { bin += String.fromCharCode(b); });
      return btoa(bin);
    }
    case 'URL': return encodeURIComponent(text);
    case 'HTML': return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    case 'Unicode': return Array.from(text).map(c => (/[^\x00-\x7F]/.test(c) ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c)).join('');
    case 'Hex': return Array.from(new TextEncoder().encode(text)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }
}

function decodeText(text: string, kind: Encoding): string {
  switch (kind) {
    case 'Base64': {
      const bin = atob(text.trim().replace(/\s/g, ''));
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    case 'URL': return decodeURIComponent(text);
    case 'HTML': {
      const div = document.createElement('textarea');
      div.innerHTML = text;
      return div.value;
    }
    case 'Unicode': return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    case 'Hex': {
      const clean = text.replace(/[^0-9a-fA-F]/g, '');
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
      return new TextDecoder().decode(bytes);
    }
  }
}

function EncodeTool() {
  const [kind, setKind] = useState<Encoding>('Base64');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'encode' | 'decode'>('encode');
  const [error, setError] = useState('');

  const output = useMemo(() => {
    if (!input) return '';
    try {
      setError('');
      return mode === 'encode' ? encodeText(input, kind) : decodeText(input, kind);
    } catch (e: any) {
      setError('转换失败：' + (e.message || '格式不正确'));
      return '';
    }
  }, [input, kind, mode]);

  return (
    <div className="tool-panel">
      <div className="tool-inline">
        <select value={kind} onChange={e => setKind(e.target.value as Encoding)}>
          {ENCODINGS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <button className={`btn btn-sm ${mode === 'encode' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('encode')}>编码</button>
        <button className={`btn btn-sm ${mode === 'decode' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('decode')}>解码</button>
        <button className="btn btn-sm btn-secondary" onClick={() => { setInput(output); setMode(mode === 'encode' ? 'decode' : 'encode'); }}>反向</button>
      </div>
      <div className="tool-field">
        <label>输入</label>
        <textarea value={input} onChange={e => setInput(e.target.value)} rows={6} placeholder={mode === 'encode' ? '要编码的文本' : '要解码的内容'} />
      </div>
      <div className="tool-field">
        <label>输出</label>
        <textarea value={output} readOnly rows={6} placeholder="结果" />
        {error && <div className="input-hint" style={{ color: 'var(--danger)' }}>{error}</div>}
      </div>
    </div>
  );
}

/* ---------------- 哈希 & JWT ---------------- */
function md5(input: string): string {
  // 精简 MD5（UTF-8 输入），仅用于生成校验值，不用于安全用途
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const words: number[] = [];
  for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8));
  const bitLen = len * 8;
  const total = (((len + 8) >> 6) + 1) * 16;
  while (words.length < total) words.push(0);
  words[total - 2] = bitLen >>> 0;
  words[total - 1] = Math.floor(bitLen / 4294967296);

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K: number[] = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  for (let i = 0; i < total; i += 16) {
    const A = a, B = b, C = c, D = d;
    for (let j = 0; j < 64; j++) {
      let f: number, g: number;
      if (j < 16) { f = (b & c) | (~b & d); g = j; }
      else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[j] + (words[i + g] || 0)) >>> 0;
      const s = S[(j >> 4) * 4 + (j % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = tmp;
    }
    a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0;
  }
  const hex = (n: number) => Array.from({ length: 4 }, (_, i) => ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('');
  return hex(a) + hex(b) + hex(c) + hex(d);
}

async function sha(alg: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512', text: string) {
  const buf = await crypto.subtle.digest(alg, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64urlDecode(part: string): string {
  const pad = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function HashTool() {
  const [text, setText] = useState('');
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [jwt, setJwt] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!text) { setHashes({}); return; }
      const out: Record<string, string> = { MD5: md5(text) };
      for (const alg of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
        out[alg] = await sha(alg, text);
      }
      if (alive) setHashes(out);
    })();
    return () => { alive = false; };
  }, [text]);

  const jwtInfo = useMemo(() => {
    const raw = jwt.trim();
    if (!raw) return null;
    const parts = raw.split('.');
    if (parts.length < 2) return { error: '不是有效的 JWT（应为 header.payload.signature）' };
    try {
      const header = JSON.parse(b64urlDecode(parts[0]));
      const payload = JSON.parse(b64urlDecode(parts[1]));
      return { header, payload, signature: parts[2] || '(无)' };
    } catch (e: any) {
      return { error: '解析失败：' + (e.message || '格式错误') };
    }
  }, [jwt]);

  const fmtPayload = (payload: any) => {
    const copy = { ...payload };
    const notes: string[] = [];
    if (typeof copy.exp === 'number') {
      const d = new Date(copy.exp * 1000);
      notes.push(`过期时间 exp：${d.toLocaleString('zh-CN', { hour12: false })}${d.getTime() < Date.now() ? '（已过期）' : ''}`);
    }
    if (typeof copy.iat === 'number') {
      notes.push(`签发时间 iat：${new Date(copy.iat * 1000).toLocaleString('zh-CN', { hour12: false })}`);
    }
    return { copy, notes };
  };

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>文本哈希</label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="输入要计算摘要的文本" />
      </div>
      {Object.keys(hashes).length > 0 && (
        <table className="kv-table">
          <tbody>
            {Object.entries(hashes).map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td><code className="hash-value">{v}</code></td>
                <td><button className="btn btn-sm btn-secondary" onClick={() => navigator.clipboard.writeText(v)}>复制</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="tool-field" style={{ marginTop: 20 }}>
        <label>JWT 解析</label>
        <textarea value={jwt} onChange={e => setJwt(e.target.value)} rows={4} placeholder="粘贴 JWT（eyJhbGciOi...）" />
      </div>
      {jwtInfo && ('error' in jwtInfo ? (
        <div className="input-hint" style={{ color: 'var(--danger)' }}>{jwtInfo.error}</div>
      ) : (
        <div className="jwt-result">
          <div className="jwt-section">
            <h5>Header</h5>
            <pre>{JSON.stringify(jwtInfo.header, null, 2)}</pre>
          </div>
          <div className="jwt-section">
            <h5>Payload</h5>
            <pre>{JSON.stringify(fmtPayload(jwtInfo.payload).copy, null, 2)}</pre>
            {fmtPayload(jwtInfo.payload).notes.map((n, i) => <div key={i} className="text-sm text-muted">{n}</div>)}
          </div>
          <div className="jwt-section">
            <h5>Signature</h5>
            <pre className="text-muted">{jwtInfo.signature}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 正则 ---------------- */
const PRESET_REGEX: { name: string; pattern: string }[] = [
  { name: '手机号', pattern: '^1[3-9]\\d{9}$' },
  { name: '邮箱', pattern: '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$' },
  { name: '身份证', pattern: '^\\d{17}[\\dXx]$' },
  { name: 'URL', pattern: '^https?://[^\\s]+$' },
  { name: 'IPv4', pattern: '^((25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)$' },
  { name: '中文字符', pattern: '[\\u4e00-\\u9fa5]+' },
  { name: '日期 YYYY-MM-DD', pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$' },
];

function RegexTool() {
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('g');
  const [text, setText] = useState('');

  const result = useMemo(() => {
    if (!pattern) return { error: '', matches: [] as { value: string; index: number; groups: string[] }[] };
    try {
      const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
      const matches: { value: string; index: number; groups: string[] }[] = [];
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 500) {
        matches.push({ value: m[0], index: m.index, groups: m.slice(1).map(g => g ?? '') });
        if (m[0] === '') re.lastIndex++;
      }
      return { error: '', matches };
    } catch (e: any) {
      return { error: e.message || '正则语法错误', matches: [] };
    }
  }, [pattern, flags, text]);

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>正则表达式</label>
        <div className="tool-inline">
          <span className="regex-slash">/</span>
          <input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="例如 \\d{4}-\\d{2}-\\d{2}" />
          <span className="regex-slash">/</span>
          <input className="regex-flags" value={flags} onChange={e => setFlags(e.target.value)} placeholder="gi" />
        </div>
        <div className="regex-presets">
          {PRESET_REGEX.map(p => (
            <button key={p.name} className="btn btn-sm btn-secondary" onClick={() => setPattern(p.pattern)}>{p.name}</button>
          ))}
        </div>
      </div>
      <div className="tool-field">
        <label>测试文本</label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={6} placeholder="粘贴要匹配的文本" />
      </div>
      <div className="tool-result">
        {result.error
          ? <div className="input-hint" style={{ color: 'var(--danger)' }}>{result.error}</div>
          : <div className="text-sm text-muted">匹配到 {result.matches.length} 处</div>}
        {result.matches.length > 0 && (
          <table className="kv-table">
            <thead><tr><th>#</th><th>位置</th><th>匹配内容</th><th>分组</th></tr></thead>
            <tbody>
              {result.matches.map((m, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{m.index}</td>
                  <td><code>{m.value}</code></td>
                  <td><code className="text-muted">{m.groups.join(' | ') || '-'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ---------------- 文本对比 ---------------- */
function diffLines(a: string, b: string) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length, m = B.length;
  // LCS 动态规划（行数控制在 1500 以内，避免内存爆炸）
  if (n * m > 2_250_000) {
    return [{ type: 'same' as const, text: `文本过大（${n} 行 × ${m} 行），请缩小对比范围` }];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

function DiffTool() {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');

  const lines = useMemo(() => diffLines(left, right), [left, right]);
  const stats = useMemo(() => ({
    add: lines.filter(l => l.type === 'add').length,
    del: lines.filter(l => l.type === 'del').length,
  }), [lines]);

  return (
    <div className="tool-panel">
      <div className="diff-inputs">
        <div className="tool-field">
          <label>原始文本</label>
          <textarea value={left} onChange={e => setLeft(e.target.value)} rows={8} placeholder="旧内容" />
        </div>
        <div className="tool-field">
          <label>对比文本</label>
          <textarea value={right} onChange={e => setRight(e.target.value)} rows={8} placeholder="新内容" />
        </div>
      </div>
      <div className="tool-result">
        <div className="text-sm text-muted">
          新增 <span style={{ color: 'var(--success)' }}>{stats.add}</span> 行，
          删除 <span style={{ color: 'var(--danger)' }}>{stats.del}</span> 行
        </div>
        {(left || right) && (
          <pre className="diff-view">
            {lines.map((l, i) => (
              <div key={i} className={`diff-line diff-${l.type}`}>
                <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
                {l.text || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ---------------- 数据校验 ---------------- */
function checkIdCard(id: string) {
  const v = id.trim();
  if (!/^\d{17}[\dXx]$/.test(v)) return { ok: false, msg: '格式应为 18 位（最后一位可为 X）' };
  const weight = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(v[i]) * weight[i];
  if (codes[sum % 11] !== v[17].toUpperCase()) return { ok: false, msg: '校验位不正确' };
  const y = Number(v.slice(6, 10)), mo = Number(v.slice(10, 12)), d = Number(v.slice(12, 14));
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return { ok: false, msg: '出生日期不存在' };
  return { ok: true, msg: `校验通过 · ${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} · ${Number(v[16]) % 2 ? '男' : '女'}` };
}

function checkLuhn(num: string) {
  const v = num.replace(/\s/g, '');
  if (!/^\d{12,19}$/.test(v)) return { ok: false, msg: '银行卡号应为 12-19 位数字' };
  let sum = 0;
  let alt = false;
  for (let i = v.length - 1; i >= 0; i--) {
    let d = Number(v[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return { ok: sum % 10 === 0, msg: sum % 10 === 0 ? 'Luhn 校验通过' : 'Luhn 校验失败' };
}

function checkUscc(code: string) {
  const v = code.trim().toUpperCase();
  const chars = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  if (v.length !== 18) return { ok: false, msg: '统一社会信用代码应为 18 位' };
  const weight = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = chars.indexOf(v[i]);
    if (idx === -1) return { ok: false, msg: `第 ${i + 1} 位包含非法字符` };
    sum += idx * weight[i];
  }
  const c = (31 - (sum % 31)) % 31;
  return { ok: chars[c] === v[17], msg: chars[c] === v[17] ? '校验通过' : `校验位应为 ${chars[c]}` };
}

const VALIDATORS: { id: string; name: string; placeholder: string; run: (v: string) => { ok: boolean; msg: string } }[] = [
  { id: 'idcard', name: '身份证号', placeholder: '18 位身份证', run: checkIdCard },
  { id: 'phone', name: '手机号', placeholder: '13800138000', run: v => (/^1[3-9]\d{9}$/.test(v.trim()) ? { ok: true, msg: '格式正确' } : { ok: false, msg: '应为 11 位手机号' }) },
  { id: 'bankcard', name: '银行卡号', placeholder: '6222 0000 0000 0000', run: checkLuhn },
  { id: 'uscc', name: '统一社会信用代码', placeholder: '18 位', run: checkUscc },
  { id: 'email', name: '邮箱', placeholder: 'name@example.com', run: v => (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(v.trim()) ? { ok: true, msg: '格式正确' } : { ok: false, msg: '邮箱格式不正确' }) },
  { id: 'url', name: 'URL', placeholder: 'https://example.com', run: v => { try { new URL(v.trim()); return { ok: true, msg: 'URL 合法' }; } catch { return { ok: false, msg: 'URL 不合法' }; } } },
  { id: 'ip', name: 'IPv4', placeholder: '192.168.1.1', run: v => (/^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/.test(v.trim()) ? { ok: true, msg: 'IPv4 合法' } : { ok: false, msg: 'IPv4 不合法' }) },
];

function ValidateTool() {
  const [type, setType] = useState(VALIDATORS[0].id);
  const [value, setValue] = useState('');
  const current = VALIDATORS.find(v => v.id === type) || VALIDATORS[0];
  const result = value.trim() ? current.run(value) : null;

  return (
    <div className="tool-panel">
      <div className="tool-inline">
        <select value={type} onChange={e => { setType(e.target.value); setValue(''); }}>
          {VALIDATORS.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </div>
      <div className="tool-field">
        <label>{current.name}</label>
        <input value={value} onChange={e => setValue(e.target.value)} placeholder={current.placeholder} />
      </div>
      {result && (
        <div className={`validate-result ${result.ok ? 'ok' : 'bad'}`}>
          {result.ok ? '✅ ' : '❌ '}{result.msg}
        </div>
      )}
    </div>
  );
}

/* ---------------- 页面 ---------------- */
export function Toolbox() {
  const [active, setActive] = useState<ToolId>('timestamp');
  const { toasts, addToast, removeToast } = useToast();
  const settings = useStore(s => s.settings);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme',
      settings.theme === 'light' ? 'light' : settings.theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : 'dark');
  }, [settings.theme]);

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.tool size={16} />}
          title="工具箱"
          desc="测试过程中高频用到的小工具，全部在本地计算，数据不出本机"
        />

        <div className="tabs">
          {TOOLS.map(t => (
            <button
              key={t.id}
              className={`tab2${active === t.id ? ' is-active' : ''}`}
              onClick={() => setActive(t.id)}
              title={t.desc}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <Panel title={TOOLS.find(t => t.id === active)?.label}>
          <div className="tool-lead">{TOOLS.find(t => t.id === active)?.desc}</div>
          {active === 'timestamp' && <TimestampTool />}
          {active === 'encode' && <EncodeTool />}
          {active === 'hash' && <HashTool />}
          {active === 'regex' && <RegexTool />}
          {active === 'diff' && <DiffTool />}
          {active === 'validate' && <ValidateTool />}
        </Panel>
      </Page>
    </div>
  );
}
