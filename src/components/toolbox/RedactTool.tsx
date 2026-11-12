import React, { useEffect, useMemo, useRef, useState } from 'react';
import { redactText, restoreText, countHits, REDACT_KIND_LABEL, type RedactKind } from '../../utils/redact';
import {
  readTable, redactColumns, toDelimited, columnLabel, detectDelimiter,
  type Delimiter,
} from '../../utils/tableRedact';
import { useToolState, useToolResult, copyText, ToolBlock } from './shell';

const KINDS: Array<{ id: Exclude<RedactKind, 'custom'>; hint: string }> = [
  { id: 'idcard', hint: '18 位，含 X 结尾' },
  { id: 'phone', hint: '1 开头的 11 位' },
  { id: 'bankcard', hint: '16–19 位纯数字' },
  { id: 'email', hint: '保留域名' },
  { id: 'ip', hint: '保留前两段' },
];

/** 表头像敏感列的，默认勾上（用户仍可改） */
const SENSITIVE_HEADER = /手机|电话|联系方式|身份证|证件|邮箱|email|mail|卡号|银行卡|账号|account|ip/i;

const DELIMS: Array<{ id: '' | Delimiter; label: string }> = [
  { id: '', label: '自动识别' },
  { id: ',', label: '逗号 ,' },
  { id: '\t', label: '制表符 Tab' },
  { id: ';', label: '分号 ;' },
];

type Tab = 'redact' | 'table' | 'restore';

/**
 * 自定义打码区间：从第 N 位打到第 M 位（1 基、含端点）。
 * 只在「星号打码」下有意义——占位符风格是整段替换。
 */
function MaskRange({ from, to, onFrom, onTo }: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const onlyDigits = (v: string) => v.replace(/[^\d]/g, '').slice(0, 3);
  return (
    <div className="redact-range">
      <span className="redact-range-label">打码范围</span>
      <input
        className="redact-range-input"
        type="number"
        min={1}
        inputMode="numeric"
        placeholder="起"
        value={from}
        onChange={(e) => onFrom(onlyDigits(e.target.value))}
        aria-label="从第几位开始打码"
      />
      <span className="redact-range-sep">~</span>
      <input
        className="redact-range-input"
        type="number"
        min={1}
        inputMode="numeric"
        placeholder="止"
        value={to}
        onChange={(e) => onTo(onlyDigits(e.target.value))}
        aria-label="打到第几位"
      />
      <span className="redact-range-unit">位</span>
      <span className="redact-range-hint">
        留空按类型默认（手机号留前 3 后 4、身份证留前 4 后 4…）
      </span>
    </div>
  );
}

export function RedactTool() {
  const [tab, setTab] = useToolState<Tab>('tab', 'redact');
  const [input, setInput] = useToolState('input', '');
  const [style, setStyle] = useToolState<'star' | 'token'>('style', 'star');
  const [enabled, setEnabled] = useToolState<Record<string, boolean>>('kinds', {
    idcard: true, phone: true, bankcard: true, email: true, ip: true, custom: false,
  });
  const [customText, setCustomText] = useToolState('custom', '');
  const [copied, setCopied] = useState<'' | 'text' | 'mapping'>('');
  const [hint, setHint] = useState('');

  // 自定义打码区间（1 基、含端点）。留空 = 按类型默认
  const [maskFrom, setMaskFrom] = useToolState('mask.from', '');
  const [maskTo, setMaskTo] = useToolState('mask.to', '');
  const range = useMemo(() => {
    const toNum = (v: string) => {
      const n = Number(String(v).trim());
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    };
    return { maskFrom: toNum(maskFrom), maskTo: toNum(maskTo) };
  }, [maskFrom, maskTo]);

  // 按列脱敏
  const [tableText, setTableText] = useToolState('table.text', '');
  const [delim, setDelim] = useToolState<'' | Delimiter>('table.delim', '');
  const [cols, setCols] = useToolState<number[]>('table.cols', []);
  const [fileName, setFileName] = useToolState('table.file', '');
  const [loadingFile, setLoadingFile] = useState(false);

  // 还原页
  const [masked, setMasked] = useToolState('restore.masked', '');
  const [mapping, setMapping] = useToolState('restore.mapping', '');
  const [restoredCopied, setRestoredCopied] = useState(false);

  const flash = (text: string) => {
    setHint(text);
    setTimeout(() => setHint(''), 2600);
  };

  const customWords = useMemo(
    () => customText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
    [customText],
  );

  const kinds = useMemo(
    () => Object.keys(enabled).filter((k) => enabled[k]) as RedactKind[],
    [enabled],
  );

  const result = useMemo(() => {
    if (!input.trim()) return { text: '', hits: [], mapping: '' };
    return redactText(input, { kinds, style, customWords, ...range });
  }, [input, kinds, style, customWords, range]);

  /* ---------------- 按列脱敏 ---------------- */

  const table = useMemo(
    () => readTable(tableText, delim || undefined),
    [tableText, delim],
  );

  const tableOut = useMemo(() => {
    if (!tableText.trim() || !cols.length) return null;
    const r = redactColumns(table.rows, { columns: cols, kinds, style, customWords, ...range });
    const rows = table.hasHeader ? [table.headers, ...r.rows] : r.rows;
    return { ...r, text: toDelimited(rows, table.delimiter) };
  }, [tableText, table, cols, kinds, style, customWords, range]);

  // 换了文件 / 换了分隔符就重新猜一次敏感列；用户手动勾选后不再覆盖
  const autoKey = useRef('');
  useEffect(() => {
    const key = `${tableText.length}:${tableText.slice(0, 64)}:${delim}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    if (!tableText.trim()) { setCols([]); return; }
    const guess = table.headers
      .map((h, i) => (SENSITIVE_HEADER.test(h) ? i : -1))
      .filter((i) => i >= 0);
    setCols(guess);
  }, [tableText, delim, table.headers, setCols]);

  const toggleCol = (i: number) => {
    setCols(cols.includes(i) ? cols.filter((c) => c !== i) : [...cols, i].sort((a, b) => a - b));
  };

  const pickTableFile = async () => {
    setLoadingFile(true);
    try {
      const picked = await window.electronAPI.pickFile('选择要脱敏的表格 / 文本文件', [
        { name: '表格与文本', extensions: ['csv', 'tsv', 'txt', 'json', 'log', 'md', 'sql'] },
      ]);
      if (!picked.success || !picked.data) {
        if (!picked.canceled) flash(picked.error || '选择文件失败');
        return;
      }
      const r = await window.electronAPI.readTextFile(picked.data.file);
      if (!r.success || !r.data) { flash(r.error || '读取文件失败'); return; }
      setTableText(r.data.text);
      setFileName(r.data.name);
      setDelim('');
      // 编码不是 UTF-8 时明确告诉用户（Excel 另存的 CSV 多为 GBK），免得以为又乱码了
      const enc = r.data.encodingLabel && r.data.encodingLabel !== 'UTF-8' ? `，按 ${r.data.encodingLabel} 解码` : '';
      flash(`已载入 ${r.data.name}（${(r.data.size / 1024).toFixed(1)} KB${enc}）`);
    } finally {
      setLoadingFile(false);
    }
  };

  const exportTable = async () => {
    if (!tableOut?.text) return;
    const base = (fileName || '脱敏结果').replace(/\.\w+$/, '');
    const ext = table.delimiter === '\t' ? 'tsv' : 'csv';
    const r = await window.electronAPI.saveText(tableOut.text, `${base}-脱敏.${ext}`, [
      { name: ext === 'tsv' ? 'TSV 文件' : 'CSV 文件', extensions: [ext] },
    ]);
    if (r.success) flash('已导出');
    else if (!r.canceled) flash(r.error || '导出失败');
  };

  /* ---------------- 结果回填到工具头（复制 / 导出） ---------------- */

  const headerResult = tab === 'redact' ? result.text : tab === 'table' ? (tableOut?.text || '') : '';
  useToolResult(headerResult);

  const summary = useMemo(() => countHits(result.hits), [result.hits]);

  const copy = async (text: string, which: 'text' | 'mapping') => {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(which);
      setTimeout(() => setCopied(''), 1500);
    }
  };

  const colCount = table.headers.length || (table.rows[0]?.length || 0);

  return (
    <div className="json-tool redact-tool">
      <div className="tb-subtabs" role="tablist" aria-label="脱敏工具">
        <button role="tab" aria-selected={tab === 'redact'} className={`tb-subtab${tab === 'redact' ? ' is-on' : ''}`} onClick={() => setTab('redact')}>脱敏</button>
        <button role="tab" aria-selected={tab === 'table'} className={`tb-subtab${tab === 'table' ? ' is-on' : ''}`} onClick={() => setTab('table')}>按列脱敏</button>
        <button role="tab" aria-selected={tab === 'restore'} className={`tb-subtab${tab === 'restore' ? ' is-on' : ''}`} onClick={() => setTab('restore')}>还原</button>
      </div>

      {hint && <div className="inline-hint">{hint}</div>}

      {tab === 'redact' && (
        <>
          <div className="tb-row redact-opts">
            {KINDS.map((k) => (
              <label key={k.id} className="redact-check" title={k.hint}>
                <input
                  type="checkbox"
                  checked={!!enabled[k.id]}
                  onChange={(e) => setEnabled({ ...enabled, [k.id]: e.target.checked })}
                />
                {REDACT_KIND_LABEL[k.id]}
              </label>
            ))}
            <label className="redact-check" title="自己填的项目名 / 客户名 / 内网域名">
              <input
                type="checkbox"
                checked={!!enabled.custom}
                onChange={(e) => setEnabled({ ...enabled, custom: e.target.checked })}
              />
              自定义词
            </label>
            <span className="tb-row-spacer" />
            <select
              className="json-indent"
              value={style}
              onChange={(e) => setStyle(e.target.value as 'star' | 'token')}
              title="星号打码适合直接贴出去；占位符会生成映射表，能还原"
            >
              <option value="star">星号打码</option>
              <option value="token">占位符 + 映射</option>
            </select>
          </div>

          {/* 打码范围单独一行：和勾选项挤在一行会被压成竖排文字 */}
          {style === 'star' && (
            <MaskRange from={maskFrom} to={maskTo} onFrom={setMaskFrom} onTo={setMaskTo} />
          )}

          {enabled.custom && (
            <input
              className="redact-custom"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="要打码的敏感词，逗号或空格分隔，例如：示例科技 内网域名.local" aria-label="要打码的敏感词，逗号或空格分隔，例如：示例科技 内网域名.local" />
          )}

          <div className="tb-panes redact-panes">
            <ToolBlock title="原文">
              <textarea
                className="tb-textarea"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                spellCheck={false}
                placeholder={'粘贴日志 / 请求报文 / 缺陷描述\n例如：用户 13800138000，身份证 110101199001011234，内网 192.0.2.24'}
              />
            </ToolBlock>
            <ToolBlock
              title="脱敏结果"
              extra={(
                <>
                  <span className="tb-badge">{result.hits.length ? `命中 ${result.hits.length} 处` : '无命中'}</span>
                  <button className="btn btn-ghost btn-sm" disabled={!result.text} onClick={() => copy(result.text, 'text')}>
                    {copied === 'text' ? '已复制' : '复制结果'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setInput('')}>清空</button>
                </>
              )}
            >
              {!input.trim() && <div className="tb-empty">左侧粘贴内容，这里实时给出脱敏结果</div>}
              {!!input.trim() && <pre className="json-pre">{result.text}</pre>}
            </ToolBlock>
          </div>

          {summary.length > 0 && (
            <div className="redact-hits">
              {summary.map((s) => (
                <span key={s.kind} className="pill pill-info">{s.label} × {s.count}</span>
              ))}
            </div>
          )}

          {result.mapping && (
            <ToolBlock
              title={style === 'token' ? '映射表（占位符 = 原文，用于还原）' : '映射表（打码结果 = 原文，用于还原）'}
              extra={<button className="btn btn-ghost btn-sm" onClick={() => copy(result.mapping, 'mapping')}>{copied === 'mapping' ? '已复制' : '复制映射'}</button>}
            >
              <pre className="json-pre redact-mapping">{result.mapping}</pre>
            </ToolBlock>
          )}

          <div className="text-sm text-muted">
            说明：身份证先于银行卡匹配，避免 18 位身份证被当成卡号；同一段文本重复脱敏不会二次命中。
            {style === 'star'
              ? ' 星号结果也能还原——映射表按打码后的字面量对回去，只是两个不同的值打出同一串星号时，只能还原成先遇到的那个。'
              : ' 映射表不落盘，关掉窗口就没了，需要还原请先复制出去。'}
          </div>
        </>
      )}

      {tab === 'table' && (
        <>
          <div className="tb-row redact-opts">
            <button className="btn btn-secondary btn-sm" onClick={pickTableFile} disabled={loadingFile}>
              {loadingFile ? '读取中…' : '上传文件'}
            </button>
            {fileName && <span className="tb-badge" title={fileName}>{fileName}</span>}
            <span className="tb-row-spacer" />
            <select
              className="json-indent"
              value={delim}
              onChange={(e) => setDelim(e.target.value as '' | Delimiter)}
              title="分隔符；自动识别按首行出现最多的那个"
            >
              {DELIMS.map((d) => <option key={d.label} value={d.id}>{d.label}</option>)}
            </select>
            <select
              className="json-indent"
              value={style}
              onChange={(e) => setStyle(e.target.value as 'star' | 'token')} aria-label="脱敏样式">
              <option value="star">星号打码</option>
              <option value="token">占位符 + 映射</option>
            </select>
          </div>

          <div className="tb-row redact-opts">
            {KINDS.map((k) => (
              <label key={k.id} className="redact-check" title={k.hint}>
                <input
                  type="checkbox"
                  checked={!!enabled[k.id]}
                  onChange={(e) => setEnabled({ ...enabled, [k.id]: e.target.checked })}
                />
                {REDACT_KIND_LABEL[k.id]}
              </label>
            ))}
          </div>

          {style === 'star' && (
            <MaskRange from={maskFrom} to={maskTo} onFrom={setMaskFrom} onTo={setMaskTo} />
          )}

          {colCount > 0 && (
            <div className="redact-cols">
              <span className="redact-cols-label">脱敏列</span>
              {Array.from({ length: colCount }).map((_, i) => {
                const on = cols.includes(i);
                const hits = tableOut?.perColumn.find((p) => p.column === i)?.hits || 0;
                return (
                  <button
                    key={i}
                    type="button"
                    className={`redact-col${on ? ' is-on' : ''}`}
                    onClick={() => toggleCol(i)}
                    title={on ? '点击取消这一列' : '点击只脱敏这一列'}
                  >
                    {columnLabel(table.headers, i)}
                    {on && hits > 0 && <span className="redact-col-hits">{hits}</span>}
                  </button>
                );
              })}
              {cols.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCols([])}>全不选</button>
              )}
            </div>
          )}

          <div className="tb-panes redact-panes">
            <ToolBlock title="表格内容（可直接粘贴）">
              <textarea
                className="tb-textarea"
                value={tableText}
                onChange={(e) => { setTableText(e.target.value); setFileName(''); }}
                spellCheck={false}
                placeholder={'粘贴 CSV / TSV，或点上方「上传文件」\n例如：\n姓名,手机号,备注\n张三,13800138000,内网 192.0.2.24'}
              />
            </ToolBlock>
            <ToolBlock
              title="脱敏结果"
              extra={(
                <>
                  <span className="tb-badge">
                    {!cols.length ? '未选列' : tableOut ? `命中 ${tableOut.total} 处` : '无命中'}
                  </span>
                  <button className="btn btn-ghost btn-sm" disabled={!tableOut?.text} onClick={() => copy(tableOut?.text || '', 'text')}>
                    {copied === 'text' ? '已复制' : '复制结果'}
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={!tableOut?.text} onClick={exportTable}>导出文件</button>
                </>
              )}
            >
              {!tableText.trim() && <div className="tb-empty">粘贴表格或上传文件，勾选要脱敏的列</div>}
              {!!tableText.trim() && !cols.length && <div className="tb-empty">上面点一下要脱敏的列（可多选）</div>}
              {!!tableText.trim() && !!cols.length && tableOut && (
                <pre className="json-pre">{tableOut.text}</pre>
              )}
            </ToolBlock>
          </div>

          {tableOut && tableOut.perColumn.some((p) => p.hits > 0) && (
            <div className="redact-hits">
              {tableOut.perColumn.filter((p) => p.hits > 0).map((p) => (
                <span key={p.column} className="pill pill-info">
                  {columnLabel(table.headers, p.column)} × {p.hits}
                </span>
              ))}
            </div>
          )}

          {tableOut?.mapping && (
            <ToolBlock
              title={style === 'token' ? '映射表（占位符 = 原文，用于还原）' : '映射表（打码结果 = 原文，用于还原）'}
              extra={<button className="btn btn-ghost btn-sm" onClick={() => copy(tableOut.mapping, 'mapping')}>{copied === 'mapping' ? '已复制' : '复制映射'}</button>}
            >
              <pre className="json-pre redact-mapping">{tableOut.mapping}</pre>
            </ToolBlock>
          )}

          <div className="text-sm text-muted">
            说明：只处理勾选的列，其余列原样保留；分隔符
            {delim ? `按「${DELIMS.find((d) => d.id === delim)?.label}」` : `自动识别为「${detectDelimiter(tableText) === '\t' ? '制表符' : detectDelimiter(tableText) === ';' ? '分号' : '逗号'}」`}
            ，带引号的字段与字段内换行都按 RFC 4180 处理。
          </div>
        </>
      )}

      {tab === 'restore' && (
        <>
          <div className="tb-row redact-opts">
            <button
              className="btn btn-secondary btn-sm"
              disabled={!result.text || !result.mapping}
              onClick={() => {
                setMasked(result.text);
                setMapping(result.mapping);
                flash('已带入刚才的脱敏结果与映射表');
              }}
              title="用「脱敏」页当前的结果直接验证还原"
            >
              带入本次脱敏结果
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setMasked(''); setMapping(''); }}
            >
              清空
            </button>
            <span className="tb-row-spacer" />
            <span className="text-sm text-muted">映射一行一条：<code>打码结果=原文</code> 或 <code>[类型#序号]=原文</code></span>
          </div>
          <div className="tb-panes redact-panes">
            <ToolBlock title="脱敏后的文本">
              <textarea
                className="tb-textarea"
                value={masked}
                onChange={(e) => setMasked(e.target.value)}
                spellCheck={false}
                placeholder={'粘贴脱敏后的文本，例如：\n甲 138****8000，邮箱 a***@b.com'}
              />
            </ToolBlock>
            <ToolBlock title="映射表">
              <textarea
                className="tb-textarea redact-map-input"
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
                spellCheck={false}
                placeholder={'138****8000=13800138000\na***@b.com=a@b.com'}
              />
            </ToolBlock>
          </div>
          <ToolBlock
            title="还原结果"
            extra={(
              <button
                className="btn btn-ghost btn-sm"
                disabled={!masked.trim() || !mapping.trim()}
                onClick={async () => {
                  if (await copyText(restoreText(masked, mapping))) {
                    setRestoredCopied(true);
                    setTimeout(() => setRestoredCopied(false), 1500);
                  }
                }}
              >
                {restoredCopied ? '已复制' : '复制结果'}
              </button>
            )}
          >
            {!masked.trim() || !mapping.trim()
              ? <div className="tb-empty">左右都填上，这里给出还原后的原文</div>
              : <pre className="json-pre">{restoreText(masked, mapping)}</pre>}
          </ToolBlock>
          <div className="text-sm text-muted">映射表一行一条 <code>打码结果=原文</code>；找不到的项会原样保留，不会猜。星号与占位符两种风格都能还原。</div>
        </>
      )}
    </div>
  );
}
