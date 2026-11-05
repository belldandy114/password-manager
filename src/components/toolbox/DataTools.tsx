import React, { useMemo, useState } from 'react';
import { jsonToYaml, yamlToJson, autoConvert } from '../../utils/yaml';
import { diffJson, diffToText, formatDiffValue } from '../../utils/jsonDiff';
import { generateIds, idsToText, type IdKind } from '../../utils/idGen';
import { useToolState, useToolResult, copyText, ToolBlock } from './shell';

/* ============================ YAML ↔ JSON ============================ */

export function YamlTool() {
  const [input, setInput] = useToolState('input', '');
  const [direction, setDirection] = useToolState<'auto' | 'j2y' | 'y2j'>('dir', 'auto');
  const [indent, setIndent] = useToolState('indent', 2);
  const [copied, setCopied] = useState(false);

  const out = useMemo(() => {
    if (!input.trim()) return { ok: false, error: '' } as const;
    if (direction === 'j2y') return jsonToYaml(input);
    if (direction === 'y2j') return yamlToJson(input, indent);
    return autoConvert(input, indent);
  }, [input, direction, indent]);

  const outText = out.ok ? out.text : '';
  useToolResult(outText);

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <select className="json-indent" value={direction} onChange={(e) => setDirection(e.target.value as 'auto' | 'j2y' | 'y2j')} aria-label="转换方向">
          <option value="auto">自动判断</option>
          <option value="j2y">JSON → YAML</option>
          <option value="y2j">YAML → JSON</option>
        </select>
        <span className="text-sm text-muted">缩进</span>
        <select className="json-indent" value={indent} onChange={(e) => setIndent(Number(e.target.value))} aria-label="缩进">
          {[2, 4].map((n) => <option key={n} value={n}>{n} 空格</option>)}
        </select>
        <span className="tb-row-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (outText && await copyText(outText)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} disabled={!outText}>{copied ? '已复制' : '复制结果'}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setInput('')}>清空</button>
      </div>

      <div className="tb-panes">
        <ToolBlock title="输入">
          <textarea className="tb-textarea" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} placeholder="粘贴 JSON 或 YAML，右边实时转换" />
        </ToolBlock>
        <ToolBlock title="结果">
          {!input.trim() && <div className="tb-empty">左侧粘贴内容，这里自动判断方向并转换</div>}
          {input.trim() && out.ok && <pre className="json-pre">{out.text}</pre>}
          {input.trim() && !out.ok && <div className="json-error"><div className="json-error-title">❌ 转换失败</div><div className="json-error-msg">{out.error}</div></div>}
        </ToolBlock>
      </div>
      <div className="text-sm text-muted">说明：YAML 用官方 js-yaml 解析，支持锚点/多行标量；`是/否` 这类 YAML 1.1 隐式布尔按字符串处理，避免值被悄悄改写。</div>
    </div>
  );
}

/* ============================ JSON 结构对比 ============================ */

export function JsonDiffTool() {
  const [left, setLeft] = useToolState('left', '');
  const [right, setRight] = useToolState('right', '');
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => {
    if (!left.trim() || !right.trim()) return { entries: [], error: '' };
    try {
      const a = JSON.parse(left);
      const b = JSON.parse(right);
      return { entries: diffJson(a, b), error: '' };
    } catch (e) {
      return { entries: [], error: `解析失败：${(e as Error).message}`.slice(0, 160) };
    }
  }, [left, right]);

  const text = result.error ? '' : diffToText(result.entries);
  useToolResult(text);

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <span className="tb-row-spacer" />
        <span className="tb-badge">{result.error ? '解析失败' : `${result.entries.length} 处差异`}</span>
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (text && await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} disabled={!text}>{copied ? '已复制' : '复制'}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setLeft(''); setRight(''); }}>清空</button>
      </div>

      <div className="tb-panes">
        <ToolBlock title="JSON A（旧）">
          <textarea className="tb-textarea" value={left} onChange={(e) => setLeft(e.target.value)} spellCheck={false} placeholder='{"code":0,"data":{"name":"甲","age":18}}' />
        </ToolBlock>
        <ToolBlock title="JSON B（新）">
          <textarea className="tb-textarea" value={right} onChange={(e) => setRight(e.target.value)} spellCheck={false} placeholder='{"code":0,"data":{"name":"乙","age":18}}' />
        </ToolBlock>
      </div>

      <ToolBlock title="差异">
        {result.error && <div className="json-error"><div className="json-error-msg">{result.error}</div></div>}
        {!result.error && !result.entries.length && <div className="tb-empty">{left.trim() && right.trim() ? '✅ 两份 JSON 没有差异' : '左右各粘贴一份 JSON'}</div>}
        {!result.error && result.entries.length > 0 && (
          <div className="jd-list">
            {result.entries.map((e, i) => (
              <div key={i} className={`jd-row jd-${e.kind}`}>
                <span className="jd-sign">{e.kind === 'added' ? '+' : e.kind === 'removed' ? '-' : '~'}</span>
                <code className="jd-path">{e.path}</code>
                <span className="jd-val">
                  {e.kind === 'added' && formatDiffValue(e.after)}
                  {e.kind === 'removed' && formatDiffValue(e.before)}
                  {e.kind === 'changed' && <>{formatDiffValue(e.before)} <span className="jd-arrow">→</span> {formatDiffValue(e.after)}</>}
                </span>
              </div>
            ))}
          </div>
        )}
      </ToolBlock>
    </div>
  );
}

/* ============================ ID / 流水号 ============================ */

const ID_KINDS: Array<{ id: IdKind; label: string; hint: string }> = [
  { id: 'uuid', label: 'UUID v4', hint: '标准 36 位 UUID' },
  { id: 'trace', label: 'TraceId', hint: '32 位十六进制，链路追踪常用' },
  { id: 'order', label: '订单号', hint: 'yyyyMMddHHmmss + 4 位随机' },
  { id: 'snowflake', label: '雪花 ID', hint: '时间有序的 19 位数字' },
  { id: 'seq', label: '自增序号', hint: '按宽度补零' },
  { id: 'hex', label: '随机 Hex', hint: '自定义长度' },
];

export function IdTool() {
  const [kind, setKind] = useToolState<IdKind>('kind', 'uuid');
  const [count, setCount] = useToolState('count', 10);
  const [prefix, setPrefix] = useToolState('prefix', '');
  const [length, setLength] = useToolState('length', 8);
  const [start, setStart] = useToolState('start', 1);
  const [seed, setSeed] = useToolState('seed', 0);
  const [copied, setCopied] = useState(false);

  const rows = useMemo(
    () => generateIds({ kind, count, prefix, length, start }),
    // seed 变化时重新生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, count, prefix, length, start, seed],
  );
  const text = idsToText(rows);
  useToolResult(text);

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <select className="json-indent" value={kind} onChange={(e) => setKind(e.target.value as IdKind)} aria-label="类型">
          {ID_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input className="tb-input tb-w-90" type="number" min={1} max={500} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} aria-label="条数" />
        <span className="text-sm text-muted">条</span>
        {(kind === 'seq' || kind === 'hex' || kind === 'trace') && (
          <>
            <span className="text-sm text-muted">宽度</span>
            <input className="tb-input tb-w-70" type="number" min={1} max={64} value={length} onChange={(e) => setLength(Number(e.target.value) || 1)} aria-label="宽度" />
          </>
        )}
        {kind === 'seq' && (
          <>
            <span className="text-sm text-muted">起始</span>
            <input className="tb-input tb-w-90" type="number" value={start} onChange={(e) => setStart(Number(e.target.value) || 1)} aria-label="起始值" />
          </>
        )}
        <input className="tb-input tb-w-140" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="前缀（可选）" aria-label="前缀" />
        <button className="btn btn-primary btn-sm" onClick={() => setSeed(seed + 1)}>重新生成</button>
        <span className="tb-row-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>{copied ? '已复制' : '复制全部'}</button>
      </div>

      <ToolBlock title={`${ID_KINDS.find((k) => k.id === kind)?.hint || ''} · ${rows.length} 条`}>
        <pre className="tb-pre tb-pre-list">{text}</pre>
      </ToolBlock>
    </div>
  );
}

/* ============================ SQL 参数化 ============================ */

export interface SqlParamResult {
  sql: string;
  params: string[];
  error?: string;
}

/** 把 SQL 里的字面量换成 ?（跳过注释；不做语法分析，只是文本级替换） */
export function sqlToParams(sql: string): SqlParamResult {
  const src = String(sql || '');
  const params: string[] = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // 行注释
    if (c === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    // 单引号字符串（支持 '' 转义）
    if (c === "'") {
      let j = i + 1;
      let val = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { val += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        val += src[j];
        j += 1;
      }
      params.push(val);
      out += '?';
      i = j + 1;
      continue;
    }
    // 数字（前面不是标识符字符，后面也不是）
    if (/[0-9]/.test(c)) {
      const prev = src[i - 1] || '';
      if (!/[A-Za-z0-9_$.]/.test(prev)) {
        let j = i;
        let val = '';
        while (j < src.length && /[0-9.]/.test(src[j])) { val += src[j]; j += 1; }
        const next = src[j] || '';
        if (!/[A-Za-z0-9_]/.test(next)) {
          params.push(val);
          out += '?';
          i = j;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return { sql: out, params };
}

/** 把 ? 按顺序填回值（values 每行一个） */
export function fillSqlParams(sql: string, values: string[]): string {
  let idx = 0;
  let out = '';
  let i = 0;
  const src = String(sql || '');
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '?') {
      const v = values[idx++];
      out += v === undefined ? '?' : /^[-\d.]+$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function SqlTool() {
  const [mode, setMode] = useToolState<'toParam' | 'fill'>('mode', 'toParam');
  const [sql, setSql] = useToolState('sql', '');
  const [values, setValues] = useToolState('values', '');
  const [copied, setCopied] = useState(false);

  const valuesArr = useMemo(() => values.split(/\r?\n/).map((v) => v.trim()).filter(Boolean), [values]);
  const out = useMemo(() => {
    if (!sql.trim()) return { sql: '', params: [] as string[] };
    if (mode === 'fill') return { sql: fillSqlParams(sql, valuesArr), params: valuesArr };
    return sqlToParams(sql);
  }, [mode, sql, valuesArr]);

  const text = mode === 'fill' ? out.sql : `${out.sql}\n\n-- 参数（${out.params.length} 个）\n${out.params.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
  useToolResult(text.trim());

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <select className="json-indent" value={mode} onChange={(e) => setMode(e.target.value as 'toParam' | 'fill')} aria-label="模式">
          <option value="toParam">字面量 → ? 占位</option>
          <option value="fill">? 占位 → 填回值</option>
        </select>
        <span className="text-sm text-muted">{mode === 'toParam' ? '把引号字符串与独立数字换成 ?，并列出参数' : '每行一个值，按顺序填回 ?'}</span>
        <span className="tb-row-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }}>{copied ? '已复制' : '复制'}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setSql(''); setValues(''); }}>清空</button>
      </div>

      <div className="tb-panes">
        <ToolBlock title="SQL">
          <textarea className="tb-textarea" value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} placeholder={mode === 'toParam' ? "select * from users where name = '张三' and age > 18" : 'select * from users where name = ? and age > ?'} />
        </ToolBlock>
        <ToolBlock title={mode === 'fill' ? '参数值（每行一个）' : '结果'}>
          {mode === 'toParam' ? (
            <pre className="json-pre">{`${out.sql}${out.params.length ? `\n\n-- 参数（${out.params.length} 个）\n${out.params.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : ''}`}</pre>
          ) : (
            <>
              <textarea className="tb-textarea tb-textarea-sm" value={values} onChange={(e) => setValues(e.target.value)} spellCheck={false} placeholder={'张三\n18'} />
              <div className="tb-divider" />
              <pre className="json-pre">{out.sql}</pre>
            </>
          )}
        </ToolBlock>
      </div>
      <div className="text-sm text-muted">只是文本级替换：注释会被跳过，字符串里的 '' 转义按 SQL 规则处理；复杂语法（子查询里的数字、日期函数）请人工核对。</div>
    </div>
  );
}