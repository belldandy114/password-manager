import React, { useCallback, useRef, useState } from 'react';
import { repairJson, type JsonRepairOptions, type RepairResult } from '../utils/jsonRepair';

/**
 * JSON 转化（修复 / 格式化 / 压缩 / 排序键）
 *
 * 1.11.0 起从独立页面并进「工具箱」，作为其中一个工具页签。
 * 组件本身不自带页头与外层滚动：由工具箱的 Panel 负责，保证和其它工具观感一致。
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
  {
    label: '单引号',
    hint: "键和值都用单引号（从 JS 里复制出来的）",
    text: "{ 'id': 1, 'name': '张三', 'tags': ['a', 'b'] }",
  },
  {
    label: '无引号键',
    hint: '对象的键没有引号（console 里打印的样子）',
    text: '{ id: 1, name: "李四", ok: true }',
  },
  {
    label: '带注释+尾逗号',
    hint: '含 // 注释与多余逗号（配置文件常见）',
    text: `{
  // 用户信息
  "id": 1,
  "name": "王五",
  "roles": ["admin", "qa"],
}`,
  },
  {
    label: '嵌套/日志',
    hint: '夹在日志文本里的 JSON 片段',
    text: '2026-11-02 10:00:00 INFO resp = {code: 0, data: {list: [{id: 1}]}}',
  },
];

export function JsonRepairTool() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<RepairResult | null>(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const convert = useCallback(() => {
    if (!input.trim()) return;
    setResult(repairJson(input, opts));
  }, [input, opts]);

  const copyOut = useCallback(async () => {
    if (!result?.json) return;
    try {
      await navigator.clipboard.writeText(result.json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  }, [result]);

  const inputLines = input ? input.split('\n').length : 0;
  const outputLines = result?.json ? result.json.split('\n').length : 0;

  return (
    <div className="json-tool">
      {/* 选项条 */}
      <div className="json-opts">
        <div className="json-opts-group">
          <label className="json-chk"><input type="checkbox" checked={!!opts.fixSingleQuote} onChange={e => setOpts(s => ({ ...s, fixSingleQuote: e.target.checked }))} />单引号</label>
          <label className="json-chk"><input type="checkbox" checked={!!opts.fixUnquotedKeys} onChange={e => setOpts(s => ({ ...s, fixUnquotedKeys: e.target.checked }))} />无引号键</label>
          <label className="json-chk"><input type="checkbox" checked={!!opts.removeComments} onChange={e => setOpts(s => ({ ...s, removeComments: e.target.checked }))} />去注释</label>
          <label className="json-chk"><input type="checkbox" checked={!!opts.closeBrackets} onChange={e => setOpts(s => ({ ...s, closeBrackets: e.target.checked }))} />补括号</label>
          <label className="json-chk"><input type="checkbox" checked={!!opts.sortKeys} onChange={e => setOpts(s => ({ ...s, sortKeys: e.target.checked }))} />排序键</label>
          <label className="json-chk"><input type="checkbox" checked={opts.formatMode === 'minify'} onChange={e => setOpts(s => ({ ...s, formatMode: e.target.checked ? 'minify' : 'beautify' }))} />压缩</label>
        </div>
        <div className="json-opts-group">
          <select
            className="json-indent"
            value={opts.indentSize}
            onChange={e => setOpts(s => ({ ...s, indentSize: Number(e.target.value) }))}
            title="美化时的缩进宽度"
            aria-label="缩进"
          >
            <option value={2}>缩进 2</option>
            <option value={4}>缩进 4</option>
            <option value={8}>缩进 8</option>
          </select>
          <button className="btn btn-primary btn-sm json-run" onClick={convert} disabled={!input.trim()}>转化</button>
        </div>
      </div>

      {/* 示例快捷入口 */}
      <div className="json-samples">
        <span className="json-samples-label">示例：</span>
        {EXAMPLES.map(ex => (
          <button key={ex.label} className="chip json-sample" title={ex.hint} onClick={() => { setInput(ex.text); setResult(null); }}>
            {ex.label}
          </button>
        ))}
        <span className="json-samples-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => { setInput(''); setResult(null); inputRef.current?.focus(); }}>清空</button>
      </div>

      {/* 输入 / 输出 */}
      <div className="json-panes">
        <div className="json-pane">
          <div className="json-pane-head">
            <span>输入</span>
            <span className="json-pane-meta">{inputLines ? `${inputLines} 行` : '待输入'}</span>
          </div>
          <textarea
            ref={inputRef}
            className="json-io"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); convert(); } }}
            spellCheck={false}
            placeholder="粘贴要修复的 JSON（支持单引号、无引号键、注释、多余逗号、日志里夹着的片段），Ctrl+Enter 转化" aria-label="粘贴要修复的 JSON（支持单引号、无引号键、注释、多余逗号、日志里夹着的片段），Ctrl+Enter 转化" />
        </div>

        <div className="json-pane">
          <div className="json-pane-head">
            <span>结果</span>
            <span className="json-pane-meta">{result?.success ? `${outputLines} 行` : result ? '有错误' : '待转化'}</span>
            <span className="json-pane-spacer" />
            {result?.success && (
              <button className="btn btn-ghost btn-sm" onClick={copyOut}>{copied ? '已复制' : '复制'}</button>
            )}
          </div>
          <div className="json-io json-out">
            {!result && (
              <div className="json-empty">
                {input.trim() ? '点「转化」开始修复（Ctrl+Enter）' : '左侧粘贴 JSON，右侧显示修复结果'}
              </div>
            )}

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
          </div>
        </div>
      </div>
    </div>
  );
}
