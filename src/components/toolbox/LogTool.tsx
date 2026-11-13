import React, { useEffect, useMemo, useState } from 'react';
import { analyzeLog, onlyErrors, toSummaryText, type LogCluster } from '../../utils/logAnalysis';
import {
  looksLikeAccessLog, parseAccessLog, summarizeAccess, accessSummaryText,
} from '../../utils/accessLog';
import { useToolShell, useToolResult, copyText, ToolBlock } from './shell';

/* ============================ 日志分析 ============================ */

const LV_TONE: Record<string, string> = {
  TRACE: 'mute', DEBUG: 'mute', INFO: 'info', WARN: 'warn', ERROR: 'bad', FATAL: 'bad',
};

function levelClass(lv: string): string {
  return `log-lv is-${(LV_TONE[lv] || 'mute')}`;
}

/**
 * 两种日志，两条路：
 * - 应用日志：按异常堆栈聚类（analyzeLog）；
 * - 访问日志（Nginx / Apache）：一行一条请求，按路径 / 状态码 / IP 聚合（accessLog）。
 * 用首行格式判断走哪条，不做手动切换 —— 贴进来不该还要先选类型。
 */
export function LogTool() {
  const { seed } = useToolShell();
  const [text, setText] = useState(seed || '');
  const [onlyErr, setOnlyErr] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (seed) setText(seed);
  }, [seed]);

  /** 访问日志判定：首行命中格式，且命中行占比过半（混合内容不硬转） */
  const access = useMemo(() => {
    if (!text.trim() || !looksLikeAccessLog(text)) return null;
    const parsed = parseAccessLog(text);
    if (!parsed.total || parsed.matched / parsed.total < 0.5) return null;
    return { rows: parsed.rows, summary: summarizeAccess(parsed.rows), matched: parsed.matched, total: parsed.total };
  }, [text]);

  const analysis = useMemo(() => (access ? null : analyzeLog(text)), [access, text]);
  const list = useMemo(
    () => (!analysis ? [] : (onlyErr ? onlyErrors(analysis.clusters) : analysis.clusters)),
    [analysis, onlyErr],
  );

  const summary = useMemo(() => {
    if (access) return accessSummaryText(access.rows);
    return analysis ? toSummaryText(analysis, { onlyError: onlyErr, max: 50 }) : '';
  }, [access, analysis, onlyErr]);

  useToolResult(summary);

  const toggle = (key: string) => setOpen((s) => ({ ...s, [key]: !s[key] }));
  const hasError = analysis ? analysis.levelCounts.ERROR + analysis.levelCounts.FATAL > 0 : false;

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <span className="text-sm text-muted">
          支持应用日志（按异常堆栈聚类）与 Nginx / Apache 访问日志（按路径、状态码、IP 聚合），自动识别
        </span>
        <span className="tb-row-spacer" />
        {access && <span className="log-stat-ok">{access.matched} 条请求</span>}
        {!access && (
          <label className="log-switch">
            <input type="checkbox" checked={onlyErr} onChange={(e) => setOnlyErr(e.target.checked)} />
            只看错误
          </label>
        )}
        <button
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            if (summary && await copyText(summary)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
          disabled={!summary}
        >
          {copied ? '已复制' : '复制摘要'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setText('')} disabled={!text}>清空</button>
      </div>

      <div className="tb-panes log-panes">
        <ToolBlock title="日志原文">
          <textarea
            className="tb-textarea log-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={'应用日志：\n2026-11-13 14:20:32 ERROR java.lang.NullPointerException: user is null\n\tat com.foo.UserService.load(UserService.java:42)\n\nNginx 访问日志：\n203.0.113.47 - - [13/Nov/2026:09:14:02 +0800] "GET /api/v2/users/me HTTP/1.1" 200 1234 "-" "Mozilla/5.0"'}
          />
        </ToolBlock>

        {access ? (
          <ToolBlock
            title="访问分析"
            extra={(
              <span className="log-stats">
                <span>{access.summary.total} 条</span>
                {access.summary.statusBuckets.map(b => (
                  <span key={b.label} className={b.label === '5xx' || b.label === '4xx' ? 'log-stat-bad' : undefined}>
                    {b.label} {b.count}
                  </span>
                ))}
              </span>
            )}
          >
            <div className="log-list">
              <div className="log-item is-open">
                <div className="log-item-head is-static">
                  <span className="log-count">{access.summary.topPaths.length}</span>
                  <span className="log-title">Top 路径</span>
                  <span className="log-when">次数 · 失败 · 平均 ms</span>
                </div>
                <div className="log-detail">
                  <table className="log-table">
                    <tbody>
                      {access.summary.topPaths.map(p => (
                        <tr key={p.key}>
                          <td className="log-path" title={p.sample}>{p.key}</td>
                          <td className="log-num">{p.count}</td>
                          <td className={`log-num${p.fail ? ' is-bad' : ''}`}>{p.fail || ''}</td>
                          <td className="log-num">{p.ms ? Math.round(p.ms / p.count) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="log-item is-open">
                <div className="log-item-head is-static">
                  <span className="log-count">{access.summary.topIps.length}</span>
                  <span className="log-title">Top 来源 IP</span>
                </div>
                <div className="log-detail">
                  <div className="log-chips">
                    {access.summary.topIps.map(x => (
                      <span key={x.label} className="log-chip">{x.label} × {x.count}</span>
                    ))}
                  </div>
                </div>
              </div>

              {access.summary.slowest.length > 0 && (
                <div className="log-item is-open">
                  <div className="log-item-head is-static">
                    <span className="log-count">{access.summary.slowest.length}</span>
                    <span className="log-title">最慢请求</span>
                    <span className="log-when">毫秒</span>
                  </div>
                  <div className="log-detail">
                    {access.summary.slowest.map((r, i) => (
                      <div key={`${i}-${r.path}`} className="log-slow">
                        <span className="log-num is-bad">{Math.round((r.seconds || 0) * 1000)}</span>
                        <span className="log-path" title={r.raw}>{r.method} {r.path}</span>
                        <span className="log-when">{r.status} · {r.ip}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ToolBlock>
        ) : (
          <ToolBlock
            title="分析结果"
            extra={text.trim() ? (
              <span className="log-stats">
                <span>{analysis!.filledLines} 行</span>
                {hasError && <span className="log-stat-bad">ERROR {analysis!.levelCounts.ERROR + analysis!.levelCounts.FATAL}</span>}
                {analysis!.levelCounts.WARN > 0 && <span className="log-stat-warn">WARN {analysis!.levelCounts.WARN}</span>}
                <span>{analysis!.clusters.length} 类</span>
                {analysis!.from && (
                  <span className="log-range">
                    {analysis!.from}{analysis!.to && analysis!.to !== analysis!.from ? ` ~ ${analysis!.to}` : ''}
                  </span>
                )}
              </span>
            ) : undefined}
          >
            {!text.trim() ? (
              <div className="log-empty">
                <div>左侧粘贴日志后，这里会列出：</div>
                <ul>
                  <li>应用日志：每类异常出现多少次、首次和末次是什么时候</li>
                  <li>访问日志：Top 路径、状态码分布、来源 IP、最慢请求</li>
                  <li>相同堆栈折叠成一条；数字与行号会被忽略，<code>Foo.java:42</code> 和 <code>Foo.java:87</code> 算同一类</li>
                </ul>
              </div>
            ) : !list.length ? (
              <div className="log-empty">
                {onlyErr ? '没有 ERROR / FATAL 级别的记录，取消「只看错误」看看全部事件。' : '没有识别出可聚类的事件（普通消息行不会被当成异常）。'}
              </div>
            ) : (
              <div className="log-list">
                {list.map((c: LogCluster) => {
                  const expanded = !!open[c.key];
                  return (
                    <div key={c.key} className="log-item">
                      <button className="log-item-head" onClick={() => toggle(c.key)}>
                        <span className="log-count">{c.count}×</span>
                        <span className={levelClass(c.level)}>{c.level}</span>
                        <span className="log-title" title={c.title}>{c.title}</span>
                        <span className="log-when">
                          {c.firstAt || `第 ${c.firstLine} 行`}
                          {c.lastAt && c.lastAt !== c.firstAt ? ` → ${c.lastAt}` : ''}
                        </span>
                        <span className="log-caret">{expanded ? '▴' : '▾'}</span>
                      </button>
                      {expanded && (
                        <div className="log-detail">
                          <pre className="log-pre">{c.message}</pre>
                          {c.stack.length > 0 && (
                            <pre className="log-pre log-stack">{c.stack.join('\n')}</pre>
                          )}
                          <div className="log-meta">
                            首次第 {c.firstLine} 行 · 末次第 {c.lastLine} 行
                            {c.count > 1 ? ` · 共 ${c.count} 次` : ''}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {list.length >= 50 && <div className="log-meta">只列出前 50 类，完整内容请复制摘要或缩小范围。</div>}
              </div>
            )}
          </ToolBlock>
        )}
      </div>
    </div>
  );
}
