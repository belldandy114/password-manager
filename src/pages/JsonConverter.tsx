import React, { useState, useCallback, useRef } from 'react';
import { repairJson, type JsonRepairOptions, type RepairResult } from '../utils/jsonRepair';

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

export function JsonConverter() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<RepairResult | null>(null);
  const [opts, setOpts] = useState(DEFAULT_OPTS);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleConvert = useCallback(() => {
    if (!input.trim()) return;
    const res = repairJson(input, opts);
    setResult(res);
  }, [input, opts]);

  const handleCopy = useCallback(async () => {
    if (!result?.json) return;
    try {
      await navigator.clipboard.writeText(result.json);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [result]);

  const handlePasteExample = useCallback((example: string) => {
    setInput(example);
    setResult(null);
  }, []);

  // Format lines display
  const inputLines = input.split('\n').length;
  const outputLines = result?.json?.split('\n').length ?? 0;

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'var(--bg-primary)',
    }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 20px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '14px' }}>
          JSON 转化
        </span>

        <div className="toolbar-separator" style={{ width: 1, height: 24, background: 'var(--border)' }} />

        {/* Options */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={opts.fixSingleQuote} onChange={e => setOpts(s => ({ ...s, fixSingleQuote: e.target.checked }))} />
          单引号
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={opts.fixUnquotedKeys} onChange={e => setOpts(s => ({ ...s, fixUnquotedKeys: e.target.checked }))} />
          无引号键
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={opts.removeComments} onChange={e => setOpts(s => ({ ...s, removeComments: e.target.checked }))} />
          去注释
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={opts.closeBrackets} onChange={e => setOpts(s => ({ ...s, closeBrackets: e.target.checked }))} />
          补括号
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={opts.sortKeys} onChange={e => setOpts(s => ({ ...s, sortKeys: e.target.checked }))} />
          排序
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={opts.formatMode === 'minify'} onChange={e => setOpts(s => ({ ...s, formatMode: e.target.checked ? 'minify' : 'beautify' }))} />
          压缩
        </label>

        {/* Indent size */}
        <select
          value={opts.indentSize}
          onChange={e => setOpts(s => ({ ...s, indentSize: Number(e.target.value) }))}
          style={{
            background: 'var(--bg-input)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 4,
            padding: '2px 8px', fontSize: 12,
          }}
        >
          <option value={2}>缩进 2</option>
          <option value={4}>缩进 4</option>
          <option value={8}>缩进 8</option>
        </select>
      </div>

      {/* Main content: two panels */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        overflow: 'hidden',
        gap: 0,
      }}>
        {/* Input panel */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border)',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '6px 16px',
            fontSize: 12,
            color: 'var(--text-muted)',
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <span>输入（{inputLines} 行）</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { label: '{key: val}', text: '{"name": "张三",\n  "age": 25,\n  "city": "北京"\n}' },
                { label: "单引号", text: "{'name': '张三', 'age': 25}" },
                { label: '尾逗号', text: '{"a": 1, "b": 2,}' },
                { label: '注释', text: '/* 用户信息 */\n{"name": "张三" // 姓名\n}' },
              ].map(ex => (
                <span
                  key={ex.label}
                  onClick={() => handlePasteExample(ex.text)}
                  style={{
                    cursor: 'pointer', color: 'var(--accent)', fontSize: 11,
                    padding: '1px 6px', borderRadius: 3,
                    border: '1px solid var(--accent)',
                    opacity: 0.7,
                  }}
                >{ex.label}</span>
              ))}
            </div>
          </div>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); setResult(null); }}
            placeholder="粘贴需要修复/格式化的 JSON..."
            spellCheck={false}
            style={{
              flex: 1,
              width: '100%',
              padding: '16px',
              background: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              border: 'none',
              outline: 'none',
              resize: 'none',
              fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
              fontSize: 13,
              lineHeight: 1.6,
              tabSize: 2,
            }}
          />
        </div>

        {/* Output panel */}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '6px 16px',
            fontSize: 12,
            color: 'var(--text-muted)',
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <span>输出（{result?.json ? `${outputLines} 行` : '—'}）{result?.success === false ? '⚠️ 错误' : ''}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {result?.warnings && result.warnings.length > 0 && (
                <span style={{ color: 'var(--warning)', fontSize: 11 }}>
                  {result.warnings.length} 个修复警告
                </span>
              )}
              <button
                onClick={handleConvert}
                disabled={!input.trim()}
                className="btn btn-primary"
                style={{ padding: '4px 16px', fontSize: 13 }}
              >
                转化
              </button>
              <button
                onClick={handleCopy}
                disabled={!result?.json}
                className="btn"
                style={{ padding: '4px 12px', fontSize: 13 }}
              >
                {copied ? '✅ 已复制' : '复制'}
              </button>
            </div>
          </div>

          {/* Output content area */}
          <div style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px',
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>
            {!result && !input.trim() && (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: 60, fontSize: 14 }}>
                在左侧输入 JSON，然后点击「转化」
              </div>
            )}

            {!result && input.trim() && (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: 60, fontSize: 14 }}>
                <div style={{ fontSize: 24, marginBottom: 12 }}>⌨️</div>
                点击「转化」开始修复
              </div>
            )}

            {result?.success && result.json && (
              <pre style={{
                margin: 0,
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>{result.json}</pre>
            )}

            {result?.success === false && result.error && (
              <div style={{ color: 'var(--danger)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                  ❌ {result.error.type}
                </div>
                <div style={{ marginBottom: 12, fontSize: 13 }}>{result.error.message}</div>
                <div style={{
                  background: 'var(--bg-card)',
                  padding: '12px',
                  borderRadius: 6,
                  fontSize: 13,
                  color: 'var(--text-secondary)',
                  marginBottom: 12,
                }}>
                  💡 {result.error.suggestion}
                </div>
                {result.error.quickFix && (
                  <div>
                    <button
                      onClick={() => {
                        setInput(result.error!.quickFix!);
                        setResult(repairJson(result.error!.quickFix!, opts));
                      }}
                      className="btn"
                      style={{ padding: '6px 16px', fontSize: 13 }}
                    >
                      🔧 一键修复
                    </button>
                    <pre style={{
                      marginTop: 8,
                      padding: 12,
                      background: 'var(--bg-card)',
                      borderRadius: 6,
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      overflow: 'auto',
                    }}>{result.error.quickFix}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
