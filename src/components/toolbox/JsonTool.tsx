import React, { useCallback, useMemo, useState } from 'react';
import { repairJson, type JsonRepairOptions, type RepairResult } from '../../utils/jsonRepair';
import { pickByPath, collectKey } from '../../utils/jsonPath';
import { useToolState, useToolResult, copyText } from './shell';

/**
 * JSON 工具（1.11.0 起把原来的「JSON 转化」页和「JSON 提取」工具合成一个）
 *
 * 两个页签：
 * - 修复/格式化：单引号、无引号键、注释、多余逗号都能救
 * - 按路径提取：`data.list[*].name` 或按字段名递归捞
 */

const DEFAULT_OPTS: Partial<JsonRepairOptions> = {
  fixSingleQuote: true,
  fixUnquotedKeys: true,
  removeComments: true,
  trailingComma: 'remove',
  missingComma: false,
  closeBrackets: true,
  inferStructure: true,
  formatMode: 'beautify',
  indentSize: 2,
  sortKeys: false,
};

const EXAMPLES: Array<{ label: string; hint: string; text: string }> = [
  { label: '单引号', hint: '键和值都用单引号（从 JS 里复制出来的）', text: "{ 'id': 1, 'name': '张三', 'tags': ['a','b'] }" },
  { label: '无引号键', hint: '对象的键没有引号（console 里打印的样子）', text: '{ id: 1, name: "李四", ok: true }' },
  {
    label: '带注释+尾逗号',
    hint: '含 // 注释与多余逗号（配置文件常见）',
    text: '{\n  // 用户信息\n  "id": 1,\n  "roles": ["admin", "qa"],\n}',
  },
  {
    label: '日志里的片段',
    hint: '夹在日志文本中间的 JSON',
    text: '2026-11-02 10:00:00 INFO resp = {code: 0, data: {list: [{id: 1}]}}',
  },
];

export function JsonTool() {
  const [tab, setTab] = useToolState<'repair' | 'extract'>('tab', 'repair');
  const [input, setInput] = useToolState('input', '');
  const [opts, setOpts] = useToolState<Partial<JsonRepairOptions>>('opts', DEFAULT_OPTS);
  const [result, setResult] = useState<RepairResult | null>(null);
  const [copied, setCopied] = useState(false);

  // 提取页签
  const [path, setPath] = useToolState('path', '');
  const [mode, setMode] = useToolState<'path' | 'key'>('mode', 'path');
  const [pretty, setPretty] = useToolState('pretty', true);

  const parsed = useMemo(() => {
    if (!input.trim()) return { error: '', value: undefined as unknown };
    try {
      return { error: '', value: JSON.parse(input) as unknown };
    } catch (e) {
      return { error: `JSON 解析失败：${(e as Error).message}`.slice(0, 160), value: undefined };
    }
  }, [input]);

  const extractOut = useMemo(() => {
    if (parsed.error || parsed.value === undefined) return '';
    try {
      const v = mode === 'path' ? pickByPath(parsed.value, path) : collectKey(parsed.value, path.trim());
      if (v === undefined) return '';
      return typeof v === 'string' ? v : JSON.stringify(v, null, pretty ? 2 : 0);
    } catch {
      return '';
    }
  }, [parsed, path, mode, pretty]);

  const outText = tab === 'repair' ? (result?.success ? result.json || '' : '') : extractOut;
  useToolResult(outText);

  const convert = useCallback(() => {
    if (!input.trim()) return;
    setResult(repairJson(input, opts));
  }, [input, opts]);

  const doCopy = async (text: string) => {
    if (!text) return;
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  const inputLines = input ? input.split('\n').length : 0;
  const outLines = outText ? outText.split('\n').length : 0;

  return (
    <div className="json-tool">
      {/* 子页签：修复 / 提取 */}
      <div className="tb-subtabs" role="tablist" aria-label="JSON 工具">
        <button role="tab" aria-selected={tab === 'repair'} className={`tb-subtab${tab === 'repair' ? ' is-on' : ''}`} onClick={() => setTab('repair')}>修复 / 格式化</button>
        <button role="tab" aria-selected={tab === 'extract'} className={`tb-subtab${tab === 'extract' ? ' is-on' : ''}`} onClick={() => setTab('extract')}>按路径提取</button>
      </div>

      {tab === 'repair' ? (
        <>
          <div className="json-opts">
            <div className="json-opts-group">
              <label className="json-chk"><input type="checkbox" checked={!!opts.fixSingleQuote} onChange={(e) => setOpts({ ...opts, fixSingleQuote: e.target.checked })} />单引号</label>
              <label className="json-chk"><input type="checkbox" checked={!!opts.fixUnquotedKeys} onChange={(e) => setOpts({ ...opts, fixUnquotedKeys: e.target.checked })} />无引号键</label>
              <label className="json-chk"><input type="checkbox" checked={!!opts.removeComments} onChange={(e) => setOpts({ ...opts, removeComments: e.target.checked })} />去注释</label>
              <label className="json-chk"><input type="checkbox" checked={!!opts.closeBrackets} onChange={(e) => setOpts({ ...opts, closeBrackets: e.target.checked })} />补括号</label>
              <label className="json-chk"><input type="checkbox" checked={!!opts.sortKeys} onChange={(e) => setOpts({ ...opts, sortKeys: e.target.checked })} />排序键</label>
              <label className="json-chk"><input type="checkbox" checked={opts.formatMode === 'minify'} onChange={(e) => setOpts({ ...opts, formatMode: e.target.checked ? 'minify' : 'beautify' })} />压缩</label>
            </div>
            <div className="json-opts-group">
              <select className="json-indent" value={opts.indentSize} onChange={(e) => setOpts({ ...opts, indentSize: Number(e.target.value) })} title="美化时的缩进宽度" aria-label="缩进">
                <option value={2}>缩进 2</option>
                <option value={4}>缩进 4</option>
                <option value={8}>缩进 8</option>
              </select>
              <button className="btn btn-primary btn-sm json-run" onClick={convert} disabled={!input.trim()}>转化</button>
            </div>
          </div>

          <div className="json-samples">
            <span className="json-samples-label">示例：</span>
            {EXAMPLES.map((ex) => (
              <button key={ex.label} className="chip json-sample" title={ex.hint} onClick={() => { setInput(ex.text); setResult(null); }}>{ex.label}</button>
            ))}
            <span className="json-samples-spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => { setInput(''); setResult(null); }}>清空</button>
          </div>
        </>
      ) : (
        <div className="json-opts">
          <div className="json-opts-group">
            <select className="json-indent" value={mode} onChange={(e) => setMode(e.target.value as 'path' | 'key')} aria-label="提取方式">
              <option value="path">按路径取</option>
              <option value="key">按字段名递归取</option>
            </select>
            <input
              className="tb-input json-path-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={mode === 'path' ? '例如 data.list[*].name（空 = 全部）' : '例如 id'}
              spellCheck={false}
            />
            <label className="json-chk"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} />美化输出</label>
          </div>
          <div className="json-opts-group">
            <button className="btn btn-ghost btn-sm" onClick={() => { setInput(''); setPath(''); }}>清空</button>
          </div>
        </div>
      )}

      <div className="json-panes">
        <div className="json-pane">
          <div className="json-pane-head">
            <span>输入</span>
            <span className="json-pane-meta">{inputLines ? `${inputLines} 行` : '待输入'}</span>
          </div>
          <textarea
            className="json-io"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (tab === 'repair') convert(); } }}
            spellCheck={false}
            placeholder="粘贴 JSON（支持单引号、无引号键、注释、多余逗号、日志里夹着的片段），Ctrl+Enter 转化"
          />
        </div>

        <div className="json-pane">
          <div className="json-pane-head">
            <span>结果</span>
            <span className="json-pane-meta">{outText ? `${outLines} 行` : tab === 'repair' && result && !result.success ? '有错误' : '待转化'}</span>
            <span className="json-pane-spacer" />
            {outText && <button className="btn btn-ghost btn-sm" onClick={() => doCopy(outText)}>{copied ? '已复制' : '复制'}</button>}
          </div>
          <div className="json-io json-out">
            {tab === 'extract' && (
              parsed.error
                ? <div className="json-error"><div className="json-error-title">❌ 解析失败</div><div className="json-error-msg">{parsed.error}</div></div>
                : extractOut
                  ? <pre className="json-pre">{extractOut}</pre>
                  : <div className="json-empty">{input.trim() ? '这个路径没有取到值，检查一下路径写法' : '左侧粘贴 JSON，这里按路径显示结果'}</div>
            )}

            {tab === 'repair' && (
              <>
                {!result && <div className="json-empty">{input.trim() ? '点「转化」开始修复（Ctrl+Enter）' : '左侧粘贴 JSON，右侧显示修复结果'}</div>}
                {result?.success && result.json && <pre className="json-pre">{result.json}</pre>}
                {result?.success === false && result.error && (
                  <div className="json-error">
                    <div className="json-error-title">❌ {result.error.type}</div>
                    <div className="json-error-msg">{result.error.message}</div>
                    <div className="json-error-tip">💡 {result.error.suggestion}</div>
                    {result.error.quickFix && (
                      <>
                        <button className="btn btn-secondary btn-sm" onClick={() => { const q = result.error!.quickFix!; setInput(q); setResult(repairJson(q, opts)); }}>🔧 一键修复</button>
                        <pre className="json-pre json-pre-fix">{result.error.quickFix}</pre>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}