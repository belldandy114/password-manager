import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Page, PageHead, Pill, Icons } from '../components/ui';
import type { CodelabDetect, CodelabDone } from '../types';
import { useToast } from '../hooks/useToast';

/**
 * 代码调试：写一段代码、在本机跑、看输出。
 *
 * 布局：顶栏（语言 / 超时 / 运行）→ 运行时提示 → 代码区（上，内部滚动）→ 输出区（下，内部滚动）
 * 代码再长也不会把按钮顶出屏幕。
 *
 * 语言：
 * - JavaScript / Python / Java：本机起进程执行（Node 应用内置，Python/Java 用本机装的）
 * - HTML：不起进程，直接在本页 iframe 里渲染预览；页面里的 console / 报错通过 postMessage 回显到「控制台」
 *
 * ⚠️ 进程模式是本机真实执行，不是沙箱，页面上必须保留提示。
 */

const LANGS = [
  { id: 'javascript', label: 'JavaScript', hint: '应用内置 Node，装了就能跑' },
  { id: 'python', label: 'Python', hint: '需要本机 python 3.x' },
  { id: 'java', label: 'Java', hint: '需要 JDK（javac + java）' },
  { id: 'html', label: 'HTML', hint: '在本页 iframe 里预览，console 回显到「控制台」' },
];

const SAMPLES: Record<string, string> = {
  javascript: `// JavaScript（Node）
const list = [1, 2, 3, 4, 5];
const sum = list.reduce((a, b) => a + b, 0);
console.log('sum =', sum);
console.log(JSON.stringify({ ts: new Date().toISOString(), items: list.length }));
`,
  python: `# Python
items = [1, 2, 3, 4, 5]
print('sum =', sum(items))
print({'items': len(items)})
`,
  html: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>HTML 预览</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 16px; }
    .card { padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; }
    button { padding: 6px 12px; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h3>你好，HTML</h3>
    <p id="msg">点下面的按钮试试</p>
    <button onclick="document.getElementById('msg').textContent = '已点击 ' + new Date().toLocaleTimeString()">点我</button>
  </div>
  <script>
    console.log('页面已加载');
    console.warn('这是 warning，会在控制台里显示');
  </script>
</body>
</html>
`,
  java: `public class Main {
    public static void main(String[] args) {
        int[] list = {1, 2, 3, 4, 5};
        int sum = 0;
        for (int v : list) sum += v;
        System.out.println("sum = " + sum);
        System.out.println("items = " + list.length);
    }
}
`,
};

/** 注入到 HTML 预览里的 console 桥：把 log/warn/error 与未捕获异常 postMessage 给宿主 */
const CONSOLE_BRIDGE = `<script>(function () {
  var send = function (stream, args) {
    try {
      var text = Array.prototype.map.call(args, function (a) {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch (e) { return String(a); }
      }).join(' ');
      parent.postMessage({ __codelab: 1, stream: stream, text: text }, '*');
    } catch (e) {}
  };
  ['log', 'info'].forEach(function (k) { var o = console[k]; console[k] = function () { send('stdout', arguments); o && o.apply(console, arguments); }; });
  ['warn', 'error'].forEach(function (k) { var o = console[k]; console[k] = function () { send('stderr', arguments); o && o.apply(console, arguments); }; });
  window.addEventListener('error', function (e) { send('stderr', '[错误] ' + (e.message || e.error)); });
  window.addEventListener('unhandledrejection', function (e) { send('stderr', '[未处理的 Promise] ' + e.reason); });
})();</script>`;

function injectBridge(html: string): string {
  const src = String(html || '');
  if (/<head[^>]*>/i.test(src)) return src.replace(/<head[^>]*>/i, (m) => m + CONSOLE_BRIDGE);
  return CONSOLE_BRIDGE + src;
}

interface Line {
  stream: string;
  text: string;
}

export function CodeLab() {
  const { addToast } = useToast();
  const [lang, setLang] = useState('javascript');
  const [code, setCode] = useState<string>(SAMPLES.javascript);
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const [detect, setDetect] = useState<CodelabDetect | null>(null);
  const [lastDone, setLastDone] = useState<CodelabDone | null>(null);
  const [timeoutSec, setTimeoutSec] = useState(15);
  const [runFile, setRunFile] = useState('');
  // HTML 模式：iframe 预览 + 「预览 / 控制台」两个页签
  // 预览地址由主进程的 codelab:// 协议提供——不能用 srcDoc，srcdoc 会继承主窗口 CSP，
  // 预览里的内联脚本会被静默拦掉（页面能看、交互和 console 全失效）。
  const [previewUrl, setPreviewUrl] = useState('');
  const [outTab, setOutTab] = useState<'preview' | 'console'>('console');
  const outRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lineCount = useMemo(() => code.split('\n').length, [code]);
  const langMeta = LANGS.find(l => l.id === lang);
  const isHtml = lang === 'html';

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await window.electronAPI.codelabDetect();
      if (alive && r.success && r.data) setDetect(r.data);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const offOut = window.electronAPI.onCodelabOutput(({ stream, line }) => {
      setLines(prev => {
        const next = [...prev, { stream, text: line }];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
    });
    const offMeta = window.electronAPI.onCodelabMeta(({ file }) => setRunFile(file || ''));
    const offDone = window.electronAPI.onCodelabDone((d) => {
      setRunning(false);
      setLastDone(d);
    });
    return () => { offOut && offOut(); offMeta && offMeta(); offDone && offDone(); };
  }, []);

  // HTML 预览里的 console / 报错通过 postMessage 回到这里
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d: any = e.data;
      if (!d || d.__codelab !== 1) return;
      setLines(prev => {
        const next = [...prev, { stream: String(d.stream || 'stdout'), text: String(d.text ?? '') }];
        return next.length > 2000 ? next.slice(next.length - 2000) : next;
      });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [lines]);

  const syncGutter = () => {
    if (gutterRef.current && codeRef.current) gutterRef.current.scrollTop = codeRef.current.scrollTop;
  };

  const runnable = isHtml || (!!detect && ((lang === 'javascript' && detect.node.ok) || (lang === 'python' && detect.python.ok) || (lang === 'java' && detect.java.ok)));

  const run = useCallback(async () => {
    if (running) return;
    if (!code.trim()) { addToast('代码是空的', 'error'); return; }
    setLines([]);
    setLastDone(null);

    if (isHtml) {
      // 纯前端渲染：不起进程，也没有超时限制
      setPreviewUrl('');
      setRunFile('index.html');
      setOutTab('preview');
      setLines([{ stream: 'system', text: '渲染 HTML 预览中…（console 输出见「控制台」页签）' }]);
      const r = await window.electronAPI.codelabPreview(injectBridge(code));
      if (!r.success || !r.data) {
        setLines([{ stream: 'error', text: r.error || '预览失败' }]);
        return;
      }
      setPreviewUrl(r.data.url);
      setLastDone({ runId: String(Date.now()), ok: true, code: 0, timedOut: false, ms: 0, dir: '' });
      return;
    }

    setOutTab('console');
    setRunning(true);
    const r = await window.electronAPI.codelabRun({ lang, code, timeoutMs: timeoutSec * 1000 });
    if (!r.success) {
      setRunning(false);
      setLines([{ stream: 'error', text: r.error || '运行失败' }]);
    }
  }, [addToast, code, isHtml, lang, running, timeoutSec]);

  const stop = async () => {
    await window.electronAPI.codelabStop();
    setRunning(false);
    setLines(prev => [...prev, { stream: 'system', text: '已请求停止' }]);
  };

  const switchLang = (id: string) => {
    setLang(id);
    const keep = code.trim();
    const isSample = Object.values(SAMPLES).some(s => s.trim() === keep);
    if (!keep || isSample) setCode(SAMPLES[id] || '');
    if (id === 'html') setOutTab('preview');
    else setOutTab('console');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart;
      setCode(code.slice(0, start) + '    ' + code.slice(el.selectionEnd));
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 4; });
    }
  };

  const status = running
    ? { cls: 'is-run', text: '运行中…' }
    : lastDone
      ? lastDone.ok
        ? { cls: 'is-ok', text: isHtml ? '已渲染' : `成功 · ${lastDone.ms} ms` }
        : { cls: 'is-bad', text: lastDone.timedOut ? `超时 · ${lastDone.ms} ms` : `退出码 ${lastDone.code} · ${lastDone.ms} ms` }
      : { cls: '', text: '待运行' };

  const pill = (ok: boolean, label: string, extra?: string) => (
    <Pill tone={ok ? 'ok' : 'mute'}>{ok ? '● ' : '○ '}{label}{extra || ''}</Pill>
  );

  return (
    <Page>
      <PageHead
        icon={<Icons.terminal size={16} />}
        title="代码调试"
        desc="写一段代码直接在本机运行或预览，看输出（不走网络编译器，内网可用）"
        tools={
          <div className="codelab-actions">
            <select className="lang-select" value={lang} onChange={e => switchLang(e.target.value)} title={langMeta?.hint}>
              {LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <select
              className="lang-select"
              value={timeoutSec}
              onChange={e => setTimeoutSec(Number(e.target.value))}
              title={isHtml ? 'HTML 预览没有超时限制' : '超时后自动结束进程'}
              disabled={isHtml}
            >
              {[5, 15, 30, 60].map(s => <option key={s} value={s}>{s}s 超时</option>)}
            </select>
            {running
              ? <button className="btn btn-secondary btn-sm codelab-run" onClick={stop}>停止</button>
              : <button className="btn btn-primary btn-sm codelab-run" onClick={run} disabled={!runnable} title={runnable ? '运行（Ctrl+Enter）' : '当前语言的本机运行时没找到'}>{isHtml ? '预览' : '运行'}</button>}
          </div>
        }
      />

      <div className="codelab-stack">
        {/* 运行时 + 安全提示 */}
        <div className="codelab-strip">
          <div className="codelab-runtime">
            {pill(!!detect?.node.ok, 'Node')}
            {pill(!!detect?.python.ok, 'Python')}
            {pill(!!detect?.java.ok, 'JDK', detect?.java.ok ? '' : '（缺 javac）')}
            {pill(true, 'HTML', '（iframe 预览）')}
          </div>
          <span className="codelab-warn">
            <Icons.lock size={12} /> {isHtml ? 'HTML 在本页沙箱 iframe 里渲染' : '本机真实执行，不是沙箱'}
          </span>
        </div>

        {/* 代码区（上） */}
        <section className="codelab-pane">
          <header className="codelab-pane-head">
            <span className="codelab-pane-title">代码</span>
            <span className="codelab-pane-sub">{langMeta?.label} · {lineCount} 行</span>
            <span className="codelab-pane-spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setCode(SAMPLES[lang] || '')}>示例</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setCode('')}>清空</button>
          </header>
          <div className="codelab-editor">
            <div className="codelab-gutter" ref={gutterRef}>
              {Array.from({ length: Math.max(lineCount, 1) }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={codeRef}
              className="codelab-code"
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={syncGutter}
              spellCheck={false}
              wrap="off"
              placeholder="在这里粘贴/编写代码，Ctrl+Enter 运行" aria-label="在这里粘贴/编写代码，Ctrl+Enter 运行" />
          </div>
        </section>

        {/* 输出区（下）：HTML 时有「预览 / 控制台」两个页签 */}
        <section className="codelab-pane">
          <header className="codelab-pane-head">
            <span className={`codelab-term-dot ${status.cls}`} />
            {isHtml ? (
              <div className="codelab-tabs">
                <button className={`codelab-tab${outTab === 'preview' ? ' is-on' : ''}`} onClick={() => setOutTab('preview')}>预览</button>
                <button className={`codelab-tab${outTab === 'console' ? ' is-on' : ''}`} onClick={() => setOutTab('console')}>
                  控制台{lines.length > 0 ? ` (${lines.length})` : ''}
                </button>
              </div>
            ) : (
              <span className="codelab-pane-title">输出</span>
            )}
            <span className="codelab-pane-sub">{runFile || langMeta?.label}</span>
            <span className="codelab-pane-spacer" />
            <span className="codelab-term-status">{status.text}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => { setLines([]); if (isHtml) setPreviewUrl(''); }} disabled={running}>清空</button>
          </header>

          {isHtml && outTab === 'preview' ? (
            previewUrl ? (
              <iframe
                className="codelab-preview"
                title="HTML 预览"
                sandbox="allow-scripts allow-forms allow-modals allow-popups"
                src={previewUrl}
              />
            ) : (
              <div className="codelab-out">
                <div className="codelab-out-empty">点「预览」（或 Ctrl+Enter），HTML 会渲染在这里。</div>
              </div>
            )
          ) : (
            <div className="codelab-out" ref={outRef}>
              {lines.length === 0 && (
                <div className="codelab-out-empty">
                  {isHtml ? '控制台还没有输出——HTML 里的 console.log / 报错会显示在这里。' : '点右上角「运行」（或 Ctrl+Enter），stdout / stderr 会按行显示在这里。'}
                </div>
              )}
              {lines.map((l, i) => (
                <div key={i} className={`codelab-line is-${l.stream}`}>{l.text || '\u00a0'}</div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}
