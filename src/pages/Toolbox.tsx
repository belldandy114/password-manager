import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { Page, PageHead, Panel, Icons } from '../components/ui';
import { ToolShellProvider, copyText, useToolState, useToolResult } from '../components/toolbox/shell';
import { parseTimestamp } from '../utils/timeParse';
import { cronFromText } from '../utils/cron';
import { validateIdCard } from '../utils/idCard';
import { JsonTool } from '../components/toolbox/JsonTool';

/* =============================================================
   工具箱：按用途分组的小工具集合（全部本地计算，数据不出本机）
   ============================================================= */

// 重工具按需加载：qrcode / js-yaml 只在打开对应工具时才进内存
const YamlTool = lazy(() => import('../components/toolbox/DataTools').then(m => ({ default: m.YamlTool })));
const JsonDiffTool = lazy(() => import('../components/toolbox/DataTools').then(m => ({ default: m.JsonDiffTool })));
const IdTool = lazy(() => import('../components/toolbox/DataTools').then(m => ({ default: m.IdTool })));
const SqlTool = lazy(() => import('../components/toolbox/DataTools').then(m => ({ default: m.SqlTool })));
const JwtTool = lazy(() => import('../components/toolbox/SecTools').then(m => ({ default: m.JwtTool })));
const SignTool = lazy(() => import('../components/toolbox/SecTools').then(m => ({ default: m.SignTool })));
const TimelineTool = lazy(() => import('../components/toolbox/MiscTools').then(m => ({ default: m.TimelineTool })));
const MediaTool = lazy(() => import('../components/toolbox/MiscTools').then(m => ({ default: m.MediaTool })));
const RedactTool = lazy(() => import('../components/toolbox/RedactTool').then(m => ({ default: m.RedactTool })));

type ToolId = 'timestamp' | 'encode' | 'hash' | 'regex' | 'regexExtract' | 'jsonRepair' | 'jsonExtract' | 'aes' | 'cron' | 'timezone' | 'urlParams' | 'diff' | 'validate'
  | 'yaml' | 'jsonDiff' | 'idGen' | 'sql' | 'jwt' | 'sign' | 'timeline' | 'media' | 'redact';

interface ToolDef { id: ToolId; label: string; icon: React.ReactNode; desc: string }

/** 分组顺序 = 用户查找习惯：时间 → 编码/加密 → 文本 → 数据/接口 → 安全 */
const TOOL_GROUPS: Array<{ title: string; tools: ToolDef[] }> = [
  {
    title: '时间与日期',
    tools: [
      { id: 'timestamp', label: '时间戳', icon: <Icons.refresh size={13} />, desc: '时间戳与日期互转，自动识别秒/毫秒/微秒/纳秒' },
      { id: 'timeline', label: '时间轴/耗时', icon: <Icons.clock size={13} />, desc: '多行时间算相邻间隔与总耗时，贴进缺陷单很直观' },
      { id: 'timezone', label: '时区换算', icon: <Icons.clock size={13} />, desc: '一个时间同时看多个时区，排国际联调最有用' },
      { id: 'cron', label: 'Cron 解析', icon: <Icons.refresh size={13} />, desc: '表达式翻中文 + 接下来 5 次执行时间，也能反向生成' },
    ],
  },
  {
    title: '编码与加密',
    tools: [
      { id: 'encode', label: '编码转换', icon: <Icons.terminal size={13} />, desc: 'Base64 / URL / HTML / Unicode / Hex / GBK 互转' },
      { id: 'hash', label: '哈希 / HMAC', icon: <Icons.key size={13} />, desc: 'MD5 / SHA 摘要、HMAC 签名、文件校验' },
      { id: 'sign', label: '签名计算', icon: <Icons.key size={13} />, desc: '按 key 排序拼参 + secret，直出 md5/sha 签名与原文' },
      { id: 'jwt', label: 'JWT 生成', icon: <Icons.key size={13} />, desc: 'HS256 本地签名 + 解析过期时间' },
      { id: 'aes', label: 'AES 加解密', icon: <Icons.lock size={13} />, desc: 'AES-GCM，可选 128/256，记住上次口令' },
    ],
  },
  {
    title: '文本处理',
    tools: [
      { id: 'regex', label: '正则测试', icon: <Icons.search size={13} />, desc: '实时匹配高亮，支持全局/忽略大小写/多行与替换预览' },
      { id: 'regexExtract', label: '正则提取', icon: <Icons.list size={13} />, desc: '按正则批量抽取内容，可只取分组、去重、拼成 JSON' },
      { id: 'diff', label: '文本对比', icon: <Icons.list size={13} />, desc: '两段文本逐行差异，可忽略空白/大小写' },
    ],
  },
  {
    title: '数据与接口',
    tools: [
      { id: 'jsonRepair', label: 'JSON 转化', icon: <Icons.db size={13} />, desc: '修复/美化/压缩 JSON，也能按路径取值' },
      { id: 'jsonDiff', label: 'JSON 对比', icon: <Icons.db size={13} />, desc: '按 key 逐层比结构，只报真正变化的路径' },
      { id: 'yaml', label: 'YAML ↔ JSON', icon: <Icons.db size={13} />, desc: '配置文件互转，自动判断方向' },
      { id: 'urlParams', label: 'URL 参数', icon: <Icons.terminal size={13} />, desc: '拆解 query 参数，原始值 / 解码值对照' },
      { id: 'sql', label: 'SQL 参数化', icon: <Icons.terminal size={13} />, desc: '字面量 ↔ ? 占位互转，供缺陷单与脚本复用' },
      { id: 'idGen', label: 'ID / 流水号', icon: <Icons.plus size={13} />, desc: 'UUID / TraceId / 订单号 / 雪花 ID / 序号' },
    ],
  },
  {
    title: '校验与其它',
    tools: [
      { id: 'validate', label: '数据校验', icon: <Icons.check size={13} />, desc: '身份证（含校验位）/ 手机号 / 银行卡 / 统一社会信用代码' },
      { id: 'media', label: '图片/二维码', icon: <Icons.db size={13} />, desc: '生成二维码、图片与 base64 互转' },
      { id: 'redact', label: '脱敏 / 还原', icon: <Icons.lock size={13} />, desc: '手机号 / 身份证 / 银行卡 / 邮箱 / IP 一键打码，可生成映射还原' },
    ],
  },
];

const ALL_TOOLS: ToolDef[] = TOOL_GROUPS.flatMap((g) => g.tools);

/* ---------------- 时间戳 ---------------- */
function TimestampTool() {
  const [ts, setTs] = useToolState('ts', String(Date.now()));
  const [unit, setUnit] = useToolState<'auto' | 's' | 'ms' | 'us' | 'ns'>('unit', 'auto');
  const [now, setNow] = useState(Date.now());
  const [dateStr, setDateStr] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const parsed = useMemo(() => {
    const p = parseTimestamp(ts, unit);
    if (!p.ok || p.ms === undefined) return null;
    const d = new Date(p.ms);
    return {
      ms: p.ms,
      unit: p.unit || 'ms',
      sec: Math.floor(p.ms / 1000),
      micro: Math.round(p.ms * 1000),
      nano: String(Math.round(p.ms * 1e6)),
      local: d.toLocaleString('zh-CN', { hour12: false }),
      utc: d.toUTCString(),
      iso: d.toISOString(),
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
    };
  }, [ts, unit]);

  useToolResult(parsed
    ? `秒级: ${parsed.sec}\n毫秒: ${parsed.ms}\n本地: ${parsed.local} ${parsed.weekday}\nUTC: ${parsed.utc}\nISO: ${parsed.iso}`
    : '');

  /** 按毫秒偏移后写回（写回时保持当前单位，避免 1000 倍误差） */
  const shift = (deltaMs: number) => {
    const base = parsed ? parsed.ms : Date.now();
    const next = base + deltaMs;
    const u = unit === 'auto' ? (parsed?.unit || 'ms') : unit;
    if (u === 's') setTs(String(Math.floor(next / 1000)));
    else if (u === 'us') setTs(String(next * 1000));
    else if (u === 'ns') setTs(String(next * 1e6));
    else setTs(String(next));
  };

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>时间戳 / 日期字符串（10 位=秒、13 位=毫秒、16 位=微秒、19 位=纳秒，自动识别）</label>
        <div className="tool-inline">
          <input value={ts} onChange={e => setTs(e.target.value)} placeholder="1700000000 或 2026-10-27 12:00:00" />
          <select className="json-indent" value={unit} onChange={e => setUnit(e.target.value as 'auto' | 's' | 'ms' | 'us' | 'ns')} title="单位" aria-label="单位">
            <option value="auto">自动</option>
            <option value="s">秒</option>
            <option value="ms">毫秒</option>
            <option value="us">微秒</option>
            <option value="ns">纳秒</option>
          </select>
          <button className="btn btn-sm btn-secondary" onClick={() => setTs(String(Date.now()))}>当前毫秒</button>
          <button className="btn btn-sm btn-secondary" onClick={() => setTs(String(Math.floor(Date.now() / 1000)))}>当前秒</button>
        </div>
        <div className="tool-inline">
          <span className="text-sm text-muted">快捷偏移：</span>
          <button className="btn btn-sm btn-secondary" onClick={() => shift(3600_000)}>+1 小时</button>
          <button className="btn btn-sm btn-secondary" onClick={() => shift(86400_000)}>+1 天</button>
          <button className="btn btn-sm btn-secondary" onClick={() => shift(7 * 86400_000)}>+7 天</button>
          <button className="btn btn-sm btn-secondary" onClick={() => shift(-86400_000)}>-1 天</button>
        </div>
      </div>

      <div className="tool-result">
        <div className="tool-live">
          当前时间：{new Date(now).toLocaleString('zh-CN', { hour12: false })}（{Math.floor(now / 1000)} 秒 / {now} 毫秒）
        </div>
        {!parsed && <div className="text-muted text-sm">无法解析，请输入数字时间戳或可识别的日期</div>}
        {parsed && (
          <table className="kv-table">
            <tbody>
              <tr><td>识别单位</td><td><code>{parsed.unit}</code></td></tr>
              <tr><td>秒级时间戳</td><td><code>{parsed.sec}</code></td></tr>
              <tr><td>毫秒时间戳</td><td><code>{parsed.ms}</code></td></tr>
              <tr><td>微秒 / 纳秒</td><td><code>{parsed.micro} / {parsed.nano}</code></td></tr>
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
const ENCODINGS = ['Base64', 'URL', 'URL(整段)', 'HTML', 'Unicode', 'Hex', 'GBK(仅解码)'] as const;
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
    case 'URL(整段)': return encodeURI(text);
    case 'GBK(仅解码)': throw new Error('GBK 只支持解码（浏览器没有内置 GBK 编码表）');
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
    case 'URL(整段)': return decodeURI(text);
    case 'GBK(仅解码)': {
      const bytes = new Uint8Array(Array.from(text.trim().match(/../g) || []).map(h => parseInt(h, 16)));
      return new TextDecoder('gbk').decode(bytes);
    }
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
  const [kind, setKind] = useToolState<Encoding>('kind', 'Base64');
  const [input, setInput] = useToolState('input', '');
  const [mode, setMode] = useToolState<'encode' | 'decode'>('mode', 'encode');
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

  useToolResult(output);

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

  useToolResult(Object.entries(hashes).map(([k, v]) => `${k}: ${v}`).join('\n'));

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>文本哈希</label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={4} placeholder="输入要计算摘要的文本" />
      </div>
      <HashExtras text={text} />
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

/* ---------------- HMAC / 文件校验（B8） ---------------- */
function HashExtras({ text }: { text: string }) {
  const [secret, setSecret] = useToolState('hmacSecret', '');
  const [hmacAlg, setHmacAlg] = useToolState<'SHA-1' | 'SHA-256'>('hmacAlg', 'SHA-256');
  const [hmacOut, setHmacOut] = useState('');
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number; hash: string } | null>(null);
  const [fileErr, setFileErr] = useState('');

  const calcHmac = async () => {
    if (!secret || !text) { setHmacOut(''); return; }
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: hmacAlg }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
    setHmacOut(Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join(''));
  };

  const pickFile = async (f: File | undefined) => {
    setFileErr('');
    setFileInfo(null);
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) { setFileErr('文件超过 200MB，建议用 certutil 单独校验'); return; }
    try {
      const buf = await f.arrayBuffer();
      const d = await crypto.subtle.digest('SHA-256', buf);
      setFileInfo({
        name: f.name,
        size: f.size,
        hash: Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join(''),
      });
    } catch (e) {
      setFileErr(String((e as Error).message || e));
    }
  };

  return (
    <div className="tool-field">
      <label>HMAC 签名（用上面的文本做消息）</label>
      <div className="tool-inline">
        <input value={secret} onChange={e => setSecret(e.target.value)} placeholder="HMAC secret" spellCheck={false} aria-label="HMAC secret" />
        <select className="json-indent" value={hmacAlg} onChange={e => setHmacAlg(e.target.value as 'SHA-1' | 'SHA-256')} aria-label="算法">
          <option value="SHA-256">HMAC-SHA256</option>
          <option value="SHA-1">HMAC-SHA1</option>
        </select>
        <button className="btn btn-sm btn-secondary" onClick={calcHmac}>计算 HMAC</button>
        {hmacOut && <button className="btn btn-sm btn-secondary" onClick={() => copyText(hmacOut)}>复制</button>}
      </div>
      {hmacOut && <div className="hash-value" style={{ wordBreak: 'break-all' }}>{hmacOut}</div>}

      <label style={{ marginTop: 10, display: 'block' }}>文件校验（SHA-256，本地读取不上传）</label>
      <input className="tb-input" type="file" aria-label="选择文件计算哈希" onChange={e => pickFile(e.target.files?.[0])} />
      {fileErr && <div className="input-hint" style={{ color: 'var(--danger)' }}>{fileErr}</div>}
      {fileInfo && (
        <div className="text-sm text-muted">
          {fileInfo.name} · {(fileInfo.size / 1024).toFixed(1)} KB
          <div className="hash-value" style={{ wordBreak: 'break-all' }}>{fileInfo.hash}</div>
          <button className="btn btn-sm btn-secondary" onClick={() => copyText(fileInfo.hash)}>复制</button>
        </div>
      )}
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
  const [pattern, setPattern] = useToolState('pattern', '');
  const [flags, setFlags] = useToolState('flags', 'g');
  const [text, setText] = useToolState('text', '');
  const [replacement, setReplacement] = useToolState('replacement', '');
  const [useReplace, setUseReplace] = useToolState('useReplace', false);

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

  useToolResult(result.error ? '' : result.matches.map(m => m.value).join('\n'));

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

/* ---------------- 正则提取 ---------------- */
const PRESET_EXTRACT: { name: string; pattern: string; group: number }[] = [
  { name: 'URL', pattern: 'https?://[^\s"\'<>]+', group: 0 },
  { name: '邮箱', pattern: '[\w.+-]+@[\w-]+\.[\w.-]+', group: 0 },
  { name: '手机号', pattern: '1[3-9]\d{9}', group: 0 },
  { name: 'IPv4', pattern: '(?:\d{1,3}\.){3}\d{1,3}', group: 0 },
  { name: 'JSON 里的 id', pattern: '"id"\s*:\s*"?(\d+)"?', group: 1 },
  { name: '中文片段', pattern: '[\u4e00-\u9fa5]{2,}', group: 0 },
  { name: '日期', pattern: '\d{4}-\d{2}-\d{2}', group: 0 },
];

function RegexExtractTool() {
  const [pattern, setPattern] = useState('');
  const [flags, setFlags] = useState('g');
  const [group, setGroup] = useState(0);
  const [text, setText] = useState('');
  const [dedupe, setDedupe] = useState(true);
  const [format, setFormat] = useState<'lines' | 'comma' | 'json'>('lines');
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => {
    if (!pattern.trim()) return { error: '', values: [] as string[] };
    try {
      const re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
      const values: string[] = [];
      let m: RegExpExecArray | null;
      let guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 5000) {
        const v = group > 0 ? (m[group] ?? '') : m[0];
        if (v !== '') values.push(v);
        if (m[0] === '') re.lastIndex++;
      }
      return { error: '', values: dedupe ? Array.from(new Set(values)) : values };
    } catch (e: any) {
      return { error: e.message || '正则语法错误', values: [] as string[] };
    }
  }, [pattern, flags, group, text, dedupe]);

  const output = useMemo(() => {
    if (format === 'lines') return result.values.join('\n');
    if (format === 'comma') return result.values.join(', ');
    return JSON.stringify(result.values, null, 2);
  }, [result.values, format]);

  const copy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  useToolResult(output);

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>正则表达式</label>
        <div className="tool-inline">
          <span className="regex-slash">/</span>
          <input value={pattern} onChange={e => setPattern(e.target.value)} placeholder={'例如 "id"\\s*:\\s*"?(\\d+)"?'} />
          <span className="regex-slash">/</span>
          <input className="regex-flags" value={flags} onChange={e => setFlags(e.target.value)} placeholder="gi" />
          <select value={group} onChange={e => setGroup(Number(e.target.value))} title="只取第几个分组">
            <option value={0}>整个匹配</option>
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>第 {n} 个分组</option>)}
          </select>
        </div>
        <div className="regex-presets">
          {PRESET_EXTRACT.map(p => (
            <button key={p.name} className="btn btn-sm btn-secondary" onClick={() => { setPattern(p.pattern); setGroup(p.group); }}>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="tool-field">
        <label>源文本</label>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={7} placeholder="粘贴接口响应 / 日志 / 表格内容" />
      </div>

      <div className="tool-inline">
        <label className="wk-check">
          <input type="checkbox" checked={dedupe} onChange={e => setDedupe(e.target.checked)} /> 去重
        </label>
        <select value={format} onChange={e => setFormat(e.target.value as 'lines' | 'comma' | 'json')}>
          <option value="lines">每行一条</option>
          <option value="comma">逗号分隔</option>
          <option value="json">JSON 数组</option>
        </select>
        <span className="text-sm text-muted">共 {result.values.length} 条</span>
        <button className="btn btn-sm btn-secondary" onClick={copy} disabled={!output}>{copied ? '已复制' : '复制结果'}</button>
      </div>

      {result.error
        ? <div className="input-hint" style={{ color: 'var(--danger)' }}>{result.error}</div>
        : <pre className="code2" style={{ maxHeight: '38vh' }}>{output || '（还没有提取结果）'}</pre>}
    </div>
  );
}

/* ---------------- JSON 提取 ---------------- */
/** 把 a.b[0].c、a[*].name 这类路径解析成数组（* 为通配） */
function pickByPath(root: any, path: string): any {
  const clean = path.trim().replace(/^\$\.?/, '');
  if (!clean) return root;
  const tokens = clean.replace(/\[(\d+|\*)\]/g, '.$1').split('.').filter(t => t !== '');
  let cur: any[] = [root];
  for (const t of tokens) {
    const next: any[] = [];
    for (const v of cur) {
      if (v === null || v === undefined) continue;
      if (t === '*') {
        if (Array.isArray(v)) next.push(...v);
        else if (typeof v === 'object') next.push(...Object.values(v));
      } else if (Array.isArray(v) && /^\d+$/.test(t)) {
        if (v[Number(t)] !== undefined) next.push(v[Number(t)]);
      } else if (typeof v === 'object' && (v as any)[t] !== undefined) {
        next.push((v as any)[t]);
      }
    }
    cur = next;
  }
  return cur.length === 1 ? cur[0] : cur;
}

/** 递归收集某个 key 的所有值（不管嵌套多深） */
function collectKey(root: any, key: string, out: any[] = []): any[] {
  if (Array.isArray(root)) {
    root.forEach(v => collectKey(v, key, out));
  } else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (k === key) out.push(v);
      collectKey(v, key, out);
    }
  }
  return out;
}

function JsonExtractTool() {
  const [json, setJson] = useState('');
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'path' | 'key'>('path');
  const [pretty, setPretty] = useState(true);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => {
    if (!json.trim()) return { error: '', value: undefined as any };
    try {
      return { error: '', value: JSON.parse(json) };
    } catch (e: any) {
      return { error: 'JSON 解析失败：' + (e.message || '').slice(0, 120), value: undefined };
    }
  }, [json]);

  const output = useMemo(() => {
    if (parsed.error) return '';
    if (parsed.value === undefined) return '';
    try {
      const v = mode === 'path' ? pickByPath(parsed.value, path) : collectKey(parsed.value, path.trim());
      if (v === undefined) return '';
      return typeof v === 'string' ? v : JSON.stringify(v, null, pretty ? 2 : 0);
    } catch {
      return '';
    }
  }, [parsed, path, mode, pretty]);

  const copy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const formatJson = () => {
    if (parsed.error) return;
    setJson(JSON.stringify(parsed.value, null, 2));
  };

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>原始 JSON</label>
        <textarea value={json} onChange={e => setJson(e.target.value)} rows={7} placeholder='{"code":0,"data":{"list":[{"id":1,"name":"a"}]}}' />
        <div className="tool-inline">
          <button className="btn btn-sm btn-secondary" onClick={formatJson} disabled={!!parsed.error}>格式化</button>
          <button className="btn btn-sm btn-secondary" onClick={() => { setJson(''); setPath(''); }}>清空</button>
        </div>
      </div>

      <div className="tool-field">
        <label>{mode === 'path' ? '取值路径（空 = 全部）' : '要提取的字段名'}</label>
        <div className="tool-inline">
          <select value={mode} onChange={e => setMode(e.target.value as 'path' | 'key')}>
            <option value="path">按路径取</option>
            <option value="key">按字段名递归提取</option>
          </select>
          <input
            value={path}
            onChange={e => setPath(e.target.value)}
            placeholder={mode === 'path' ? 'data.list[0].name   或   data.list[*].id' : 'id'}
            spellCheck={false}
          />
          <label className="wk-check">
            <input type="checkbox" checked={pretty} onChange={e => setPretty(e.target.checked)} /> 格式化
          </label>
          <button className="btn btn-sm btn-secondary" onClick={copy} disabled={!output}>{copied ? '已复制' : '复制结果'}</button>
        </div>
        <div className="pg-sub" style={{ marginTop: 4 }}>
          路径支持 <code>a.b[0].c</code>；<code>[*]</code> 表示取数组每一项，<code>data.list[*].name</code> 会得到名字数组。
        </div>
      </div>

      {parsed.error
        ? <div className="input-hint" style={{ color: 'var(--danger)' }}>{parsed.error}</div>
        : <pre className="code2" style={{ maxHeight: '38vh' }}>{output || '（没有取到内容：检查路径是否正确）'}</pre>}
    </div>
  );
}

/* ---------------- AES 加解密 ---------------- */
const toB64 = (buf: Uint8Array) => {
  let bin = '';
  buf.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
};

const fromB64 = (s: string) => Uint8Array.from(atob(s.trim()), c => c.charCodeAt(0));

async function deriveAesKey(pass: string, salt: Uint8Array, keyBits: 128 | 256 = 256): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 120000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: keyBits },
    false,
    ['encrypt', 'decrypt'],
  );
}

function AesTool() {
  const [mode, setMode] = useState<'enc' | 'dec'>('enc');
  const [text, setText] = useState('');
  const [pass, setPass] = useToolState('pass', '');
  const [keyBits, setKeyBits] = useToolState<128 | 256>('keyBits', 256);
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setErr('');
    setOut('');
    if (!pass) { setErr('请先输入口令'); return; }
    setBusy(true);
    try {
      if (mode === 'enc') {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveAesKey(pass, salt, keyBits);
        const ct = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv as unknown as BufferSource },
          key,
          new TextEncoder().encode(text) as unknown as BufferSource,
        );
        const all = new Uint8Array(16 + 12 + ct.byteLength);
        all.set(salt, 0);
        all.set(iv, 16);
        all.set(new Uint8Array(ct), 28);
        setOut(toB64(all));
      } else {
        const raw = fromB64(text);
        if (raw.length < 29) throw new Error('short');
        const salt = raw.slice(0, 16);
        const iv = raw.slice(16, 28);
        const body = raw.slice(28);
        const key = await deriveAesKey(pass, salt);
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: iv as unknown as BufferSource },
          key,
          body as unknown as BufferSource,
        );
        setOut(new TextDecoder().decode(pt));
      }
    } catch {
      setErr(mode === 'dec' ? '解密失败：口令不对，或密文被改动过' : '加密失败，请检查输入');
    }
    setBusy(false);
  };

  useToolResult(out);

  return (
    <div className="tool-panel">
      <div className="tool-inline">
        <button className={`btn btn-sm ${mode === 'enc' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('enc')}>加密模式</button>
        <button className={`btn btn-sm ${mode === 'dec' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('dec')}>解密模式</button>
        <input
          type="password"
          value={pass}
          onChange={e => setPass(e.target.value)}
          placeholder="口令（不保存、不上传）"
          style={{ maxWidth: 260 }}
        />
        <button className="btn btn-sm btn-primary aes-run" onClick={run} disabled={busy || !text.trim()}>
          {busy ? '处理中…' : mode === 'enc' ? '加密' : '解密'}
        </button>
      </div>

      <div className="tool-field">
        <label>{mode === 'enc' ? '明文' : '密文（Base64）'}</label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={6}
          placeholder={mode === 'enc' ? '要加密的内容' : '粘贴 Base64 密文'}
        />
      </div>

      {err && <div className="input-hint" style={{ color: 'var(--danger)' }}>{err}</div>}

      <div className="tool-field">
        <label>结果</label>
        <textarea value={out} readOnly rows={6} placeholder="结果会显示在这里" />
        {out && (
          <button className="btn btn-sm btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => navigator.clipboard.writeText(out)}>
            复制结果
          </button>
        )}
      </div>

      <div className="pg-sub">
        AES-256-GCM，PBKDF2-SHA256（12 万次）派生密钥；输出 = salt(16) + iv(12) + 密文，Base64 编码。
        同一份密文每次结果不同属正常。
      </div>
    </div>
  );
}

/* ---------------- Cron 解析 ---------------- */
function cronValues(expr: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of expr.split(',')) {
    if (!part) return null;
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return null;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
        lo = a; hi = b;
      } else {
        const v = Number(range);
        if (!Number.isInteger(v)) return null;
        lo = v; hi = v;
      }
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

interface CronSpec { minutes: number[]; hours: number[]; days: number[]; months: number[]; dows: number[] }

function parseCron(expr: string): CronSpec | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, ho, da, mo, dw] = parts;
  const minutes = cronValues(mi, 0, 59);
  const hours = cronValues(ho, 0, 23);
  const days = cronValues(da, 1, 31);
  const months = cronValues(mo, 1, 12);
  const dows = cronValues(dw.replace(/7/g, '0'), 0, 6);
  if (!minutes || !hours || !days || !months || !dows) return null;
  return { minutes, hours, days, months, dows };
}

function cronMatches(spec: CronSpec, d: Date): boolean {
  return spec.minutes.includes(d.getMinutes())
    && spec.hours.includes(d.getHours())
    && spec.months.includes(d.getMonth() + 1)
    && spec.days.includes(d.getDate())
    && spec.dows.includes(d.getDay());
}

function describeCron(expr: string, spec: CronSpec): string {
  const p = expr.trim().split(/\s+/);
  const seg: string[] = [];
  const f = (v: number[], unit: string) => (v.length === 1 ? `${v[0]}${unit}` : `${v.join(',')}${unit}`);

  if (p[0].startsWith('*/')) seg.push(`每 ${p[0].slice(2)} 分钟`);
  else if (p[0] === '*') seg.push('每分钟');
  else if (!p[0].includes(',') && !p[0].includes('-')) seg.push(`${f(spec.minutes, '分')}`);

  if (p[1] === '*') { if (p[0] !== '*') seg.push('每小时'); }
  else if (p[1].startsWith('*/')) seg.push(`每 ${p[1].slice(2)} 小时`);
  else seg.push(`${f(spec.hours, '点')}`);

  if (p[2] !== '*') seg.push(`${f(spec.days, '号')}`);
  if (p[3] !== '*') seg.push(`${f(spec.months, '月')}`);
  if (p[4] !== '*') {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    seg.push(spec.dows.map(d => names[d]).join(','));
  }
  return seg.join(' · ') || '每分钟';
}

function CronTool() {
  const [expr, setExpr] = useToolState('expr', '0 9 * * 1-5');
  const [plain, setPlain] = useToolState('plain', '');

  const result = useMemo(() => {
    const spec = parseCron(expr);
    if (!spec) return { error: '表达式应为 5 段：分 时 日 月 周（例如 0 9 * * 1-5）', runs: [] as string[], desc: '' };
    const runs: string[] = [];
    const cur = new Date();
    cur.setSeconds(0, 0);
    cur.setMinutes(cur.getMinutes() + 1);
    for (let i = 0; i < 60 * 24 * 366 && runs.length < 5; i++) {
      if (cronMatches(spec, cur)) runs.push(cur.toLocaleString('zh-CN', { hour12: false }));
      cur.setMinutes(cur.getMinutes() + 1);
    }
    return { error: '', runs, desc: describeCron(expr, spec) };
  }, [expr]);

  useToolResult(result.error ? '' : [result.desc, ...result.runs].join('\n'));

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>Cron 表达式（分 时 日 月 周）</label>
        <div className="tool-inline">
          <input value={expr} onChange={e => setExpr(e.target.value)} placeholder="0 9 * * 1-5" spellCheck={false} />
        </div>
        <div className="tool-inline" style={{ marginBottom: 6 }}>
          <input value={plain} onChange={e => setPlain(e.target.value)} placeholder="反向生成：输入「工作日 9 点」这类说法" aria-label="反向生成" />
          <button className="btn btn-sm btn-secondary" onClick={() => { const e = cronFromText(plain); if (e) setExpr(e); }}>生成表达式</button>
        </div>
        <div className="regex-presets">
          {[
            ['每分钟', '* * * * *'],
            ['每天 9 点', '0 9 * * *'],
            ['工作日 9 点', '0 9 * * 1-5'],
            ['每 30 分钟', '*/30 * * * *'],
            ['每月 1 号 0 点', '0 0 1 * *'],
          ].map(([label, value]) => (
            <button key={value} className="btn btn-sm btn-secondary" onClick={() => setExpr(value)}>{label}</button>
          ))}
        </div>
      </div>

      {result.error
        ? <div className="input-hint" style={{ color: 'var(--danger)' }}>{result.error}</div>
        : (
          <>
            <div className="tool-result">
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{result.desc}</div>
            </div>
            <div className="tool-field">
              <label>接下来 5 次执行时间</label>
              <table className="kv-table">
                <tbody>
                  {result.runs.map((r, i) => (
                    <tr key={i}><td>{i + 1}</td><td><code>{r}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}

/* ---------------- 时区换算 ---------------- */
const ZONES: [string, string][] = [
  ['Asia/Shanghai', '北京'],
  ['UTC', 'UTC'],
  ['Asia/Tokyo', '东京'],
  ['Asia/Singapore', '新加坡'],
  ['Europe/London', '伦敦'],
  ['Europe/Berlin', '柏林'],
  ['America/New_York', '纽约'],
  ['America/Los_Angeles', '洛杉矶'],
];

/** 把「某时区的本地时间」换算成真实 UTC 时刻 */
function zonedToUtc(local: string, tz: string): Date {
  const naive = new Date(`${local}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(naive).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfLocal = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return new Date(naive.getTime() - (asIfLocal - naive.getTime()));
}

function TimezoneTool() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const [local, setLocal] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const [tz, setTz] = useState('Asia/Shanghai');

  const rows = useMemo(() => {
    if (!local) return [];
    const utc = zonedToUtc(local, tz);
    return ZONES.map(([zone, name]) => ({
      name,
      zone,
      time: new Intl.DateTimeFormat('zh-CN', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
      }).format(utc),
    }));
  }, [local, tz]);

  useToolResult(rows.map(r => `${r.name}\t${r.time}`).join('\n'));

  return (
    <div className="tool-panel">
      <div className="tool-inline">
        <input type="datetime-local" value={local} onChange={e => setLocal(e.target.value)} />
        <select value={tz} onChange={e => setTz(e.target.value)}>
          {ZONES.map(([zone, name]) => <option key={zone} value={zone}>{name}（{zone}）</option>)}
        </select>
        <span className="text-sm text-muted">上面这个时间按所选时区理解</span>
      </div>

      <table className="kv-table">
        <thead><tr><th>时区</th><th>当地时间</th><th>IANA</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.zone}>
              <td>{r.name}</td>
              <td><code>{r.time}</code></td>
              <td style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>{r.zone}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- URL 参数解析 ---------------- */
function UrlParamsTool() {
  const [input, setInput] = useState('');

  const parsed = useMemo(() => {
    const raw = input.trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const rows: { key: string; value: string; enc: string }[] = [];
      u.searchParams.forEach((value, key) => {
        rows.push({ key, value, enc: encodeURIComponent(value) });
      });
      return { ok: true as const, u, rows };
    } catch {
      return { ok: false as const };
    }
  }, [input]);

  useToolResult(parsed && parsed.rows ? parsed.rows.map(r => `${r.key}=${r.value}`).join('\n') : '');

  return (
    <div className="tool-panel">
      <div className="tool-field">
        <label>URL</label>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          rows={4}
          placeholder="https://api.example.com/users?page=1&size=20&keyword=%E6%B5%8B%E8%AF%95"
        />
      </div>

      {!parsed && <div className="text-sm text-muted">粘贴一个完整 URL，自动拆出协议、主机、路径与查询参数</div>}
      {parsed && !parsed.ok && <div className="input-hint" style={{ color: 'var(--danger)' }}>不是合法的 URL（记得带 http:// 或 https://）</div>}

      {parsed && parsed.ok && (
        <>
          <table className="kv-table">
            <tbody>
              <tr><td>协议</td><td><code>{parsed.u.protocol.replace(':', '')}</code></td></tr>
              <tr><td>主机</td><td><code>{parsed.u.host}</code></td></tr>
              <tr><td>路径</td><td><code>{parsed.u.pathname}</code></td></tr>
              {parsed.u.hash && <tr><td>Hash</td><td><code>{parsed.u.hash}</code></td></tr>}
            </tbody>
          </table>

          <div className="tool-field">
            <label>查询参数（{parsed.rows.length} 个）</label>
            {parsed.rows.length === 0 ? (
              <div className="text-sm text-muted">这个 URL 没有查询参数</div>
            ) : (
              <table className="kv-table">
                <thead><tr><th>参数</th><th>值</th><th>URL 编码</th></tr></thead>
                <tbody>
                  {parsed.rows.map((r, i) => (
                    <tr key={`${r.key}-${i}`}>
                      <td><code>{r.key}</code></td>
                      <td>{r.value || <span style={{ color: 'var(--text-muted)' }}>（空）</span>}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 11.5 }}><code>{r.enc}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <button
            className="btn btn-sm btn-secondary"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => navigator.clipboard.writeText(JSON.stringify(Object.fromEntries(parsed.rows.map(r => [r.key, r.value])), null, 2))}
          >
            复制为 JSON
          </button>
        </>
      )}
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
  const [left, setLeft] = useToolState('left', '');
  const [right, setRight] = useToolState('right', '');
  const [ignoreWs, setIgnoreWs] = useToolState('ignoreWs', false);
  const [ignoreCase, setIgnoreCase] = useToolState('ignoreCase', false);

  /** 归一化后再比：忽略行尾空白 / 全部空白 / 大小写 */
  const norm = (v: string) => {
    let out = v;
    if (ignoreWs) out = out.replace(/[ \t]+$/gm, '').replace(/[ \t]{2,}/g, ' ');
    if (ignoreCase) out = out.toLowerCase();
    return out;
  };

  const lines = useMemo(() => diffLines(norm(left), norm(right)), [left, right, ignoreWs, ignoreCase]);
  const stats = useMemo(() => ({
    add: lines.filter(l => l.type === 'add').length,
    del: lines.filter(l => l.type === 'del').length,
  }), [lines]);

  useToolResult(lines.filter(l => l.type !== 'same').map(l => (l.type === 'add' ? '+ ' : '- ') + l.text).join('\n'));

  return (
    <div className="tool-panel">
      <div className="tool-inline" style={{ marginBottom: 8 }}>
        <label className="json-chk"><input type="checkbox" checked={ignoreWs} onChange={e => setIgnoreWs(e.target.checked)} />忽略空白差异</label>
        <label className="json-chk"><input type="checkbox" checked={ignoreCase} onChange={e => setIgnoreCase(e.target.checked)} />忽略大小写</label>
        <span className="text-sm text-muted">归一化后再比较，避免只改了缩进就整段标红</span>
      </div>
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
  // 身份证额外给出「校验位 / 生日 / 性别 / 年龄」的结构化结论
  const idInfo = type === 'idcard' && value.trim() ? validateIdCard(value) : null;
  useToolResult(result ? `${result.ok ? '通过' : '不通过'}：${result.msg}` : '');

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
      {idInfo && (
        <div className="tool-inline text-sm text-muted">
          {idInfo.valid
            ? <>生日 {idInfo.birthday} · {idInfo.gender} · {idInfo.age} 岁 · 地区码 {idInfo.region}</>
            : <>校验位：{idInfo.checksumOk === false ? '不正确' : '正确'}{idInfo.checksumOk === false ? '（按 ISO 7064 MOD 11-2 计算）' : ''}</>}
        </div>
      )}
    </div>
  );
}

/* ---------------- 页面 ---------------- */
export function Toolbox() {
  const { toasts, addToast, removeToast } = useToast();
  const settings = useStore(s => s.settings);
  const toolboxIntent = useStore(s => s.toolboxIntent);
  const consumeToolboxIntent = useStore(s => s.consumeToolboxIntent);

  const [active, setActive] = useState<ToolId>(() => {
    try {
      const saved = sessionStorage.getItem('pm.toolbox.active') as ToolId | null;
      if (saved && ALL_TOOLS.some(t => t.id === saved)) return saved;
      // 1.11.0 之前「JSON 提取」是独立工具，已并入 JSON 转化
      if (saved === ('jsonExtract' as ToolId)) return 'jsonRepair';
    } catch { /* ignore */ }
    return 'timestamp';
  });
  const [resultText, setResultText] = useState('');
  const [seed, setSeed] = useState('');
  const [copiedAll, setCopiedAll] = useState(false);
  const [toolQuery, setToolQuery] = useState('');

  /** 搜索过滤：label/desc 都匹配，命中的组才显示 */
  const visibleGroups = useMemo(() => {
    const q = toolQuery.trim().toLowerCase();
    if (!q) return TOOL_GROUPS;
    return TOOL_GROUPS
      .map(g => ({ ...g, tools: g.tools.filter(t => t.label.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)) }))
      .filter(g => g.tools.length > 0);
  }, [toolQuery]);

  const currentGroupTitle = useMemo(
    () => (TOOL_GROUPS.find(g => g.tools.some(t => t.id === active)) || { title: '' }).title,
    [active],
  );
  const tabListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme',
      settings.theme === 'light' ? 'light' : settings.theme === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : 'dark');
  }, [settings.theme]);

  // 记住上次用的工具
  useEffect(() => {
    try { sessionStorage.setItem('pm.toolbox.active', active); } catch { /* ignore */ }
    setResultText('');
  }, [active]);

  // 从命令面板 / 接口调试跳进来：定位到指定工具，并带上初始文本
  useEffect(() => {
    if (!toolboxIntent) return;
    const id = (toolboxIntent.tool === 'jsonExtract' ? 'jsonRepair' : toolboxIntent.tool) as ToolId;
    if (ALL_TOOLS.some(t => t.id === id)) setActive(id);
    if (toolboxIntent.text) setSeed(toolboxIntent.text);
    consumeToolboxIntent();
  }, [toolboxIntent, consumeToolboxIntent]);

  // 快捷键：Alt+↓ / Alt+↑ 换工具，Ctrl+Enter 由各工具自己处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const i = ALL_TOOLS.findIndex(t => t.id === active);
      const next = e.key === 'ArrowDown' ? (i + 1) % ALL_TOOLS.length : (i - 1 + ALL_TOOLS.length) % ALL_TOOLS.length;
      setActive(ALL_TOOLS[next].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const current = ALL_TOOLS.find(t => t.id === active);

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = ALL_TOOLS.findIndex(t => t.id === active);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % ALL_TOOLS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + ALL_TOOLS.length) % ALL_TOOLS.length;
    else if (e.key === 'Home') next = 0;
    else next = ALL_TOOLS.length - 1;
    setActive(ALL_TOOLS[next].id);
    const btn = tabListRef.current?.querySelectorAll<HTMLButtonElement>('.tab2')[next];
    btn?.focus();
  };

  const copyResult = async () => {
    if (!resultText) return;
    if (await copyText(resultText)) {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1600);
    } else {
      addToast('复制失败，请手动选中复制', 'error');
    }
  };

  const exportResult = async () => {
    if (!resultText) return;
    const r = await window.electronAPI.saveText(resultText, `toolbox-${active}-${new Date().toISOString().slice(0, 10)}.txt`, [{ name: '文本', extensions: ['txt'] }]);
    if (r.success) addToast('已导出', 'success');
    else if (!r.canceled) addToast(`导出失败：${r.error}`, 'error');
  };

  const renderTool = () => {
    switch (active) {
      case 'timestamp': return <TimestampTool />;
      case 'encode': return <EncodeTool />;
      case 'hash': return <HashTool />;
      case 'regex': return <RegexTool />;
      case 'regexExtract': return <RegexExtractTool />;
      case 'jsonRepair': return <JsonTool />;
      case 'aes': return <AesTool />;
      case 'cron': return <CronTool />;
      case 'timezone': return <TimezoneTool />;
      case 'urlParams': return <UrlParamsTool />;
      case 'diff': return <DiffTool />;
      case 'validate': return <ValidateTool />;
      case 'yaml': return <YamlTool />;
      case 'jsonDiff': return <JsonDiffTool />;
      case 'idGen': return <IdTool />;
      case 'sql': return <SqlTool />;
      case 'jwt': return <JwtTool />;
      case 'sign': return <SignTool />;
      case 'timeline': return <TimelineTool />;
      case 'media': return <MediaTool />;
    case 'redact': return <RedactTool />;
      default: return null;
    }
  };

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.tool size={16} />}
          title="工具箱"
          desc="测试过程中高频用到的小工具，全部在本地计算，数据不出本机"
        />

<div className="tb-shell">
          {/* 左侧：分组工具导航（可搜索，窄屏收成下拉） */}
          <aside className="tb-rail">
            <div className="tb-rail-search">
              <input
                value={toolQuery}
                onChange={e => setToolQuery(e.target.value)}
                placeholder="搜索工具…"
                aria-label="搜索工具"
              />
              <select
                className="tb-rail-select"
                value={active}
                onChange={e => setActive(e.target.value as ToolId)}
                aria-label="选择工具"
              >
                {TOOL_GROUPS.map(g => (
                  <optgroup key={g.title} label={g.title}>
                    {g.tools.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="tb-rail-scroll" role="tablist" aria-label="工具箱" ref={tabListRef} onKeyDown={onTabKeyDown}>
              {visibleGroups.map(g => (
                <div key={g.title} className="tb-rail-group">
                  <div className="tool-group-label">{g.title}</div>
                  {g.tools.map(t => (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={active === t.id}
                      tabIndex={active === t.id ? 0 : -1}
                      className={`tb-rail-item${active === t.id ? ' is-active' : ''}`}
                      onClick={() => setActive(t.id)}
                      title={t.desc}
                    >
                      <span className="tb-rail-icon">{t.icon}</span>
                      <span className="tb-rail-label">{t.label}</span>
                    </button>
                  ))}
                </div>
              ))}
              {!visibleGroups.length && <div className="tb-rail-empty">没有匹配的工具</div>}
            </div>
          </aside>

          {/* 右侧：当前工具 */}
          <section className="tb-main">
            <header className="tb-main-head">
              <span className="tb-main-icon">{current?.icon}</span>
              <div className="tb-main-title">
                <h3>{current?.label}</h3>
                <span className="tb-main-group">{currentGroupTitle}</span>
              </div>
              <p className="tb-main-desc">{current?.desc}</p>
              <div className="tb-main-actions">
                <button className="btn btn-ghost btn-sm" onClick={copyResult} disabled={!resultText} title="复制当前工具的结果">{copiedAll ? '已复制' : '复制结果'}</button>
                <button className="btn btn-ghost btn-sm" onClick={exportResult} disabled={!resultText} title="导出为 txt">导出</button>
              </div>
            </header>

            <div className="tb-body">
              <ToolShellProvider toolId={active} onResult={setResultText} seed={seed}>
                <Suspense fallback={<div className="tb-loading">加载工具…</div>}>
                  {renderTool()}
                </Suspense>
              </ToolShellProvider>
            </div>
          </section>
        </div>
      </Page>
    </div>
  );
}
