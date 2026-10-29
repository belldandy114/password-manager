import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Page, PageHead, Panel, Field, Icons, Pill } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import type { JmeterDone, JmeterLogLine } from '../types';

/**
 * JMeter 非 GUI 运行页。
 *
 * 为什么单独做一页而不是塞进工具箱：它有三块互相依赖的状态（脚本/输出/运行中），
 * 而且运行日志要占一大块高度。
 */
export function PerfTest() {
  const { toasts, addToast, removeToast } = useToast();

  const [jmeterPath, setJmeterPath] = useState('');
  const [javaInfo, setJavaInfo] = useState<{ ok: boolean; version?: string; path: string }>({ ok: false, path: '' });
  const [candidates, setCandidates] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);

  const [jmxPath, setJmxPath] = useState('');
  const [mode, setMode] = useState<'log' | 'report'>('report');
  const [outDir, setOutDir] = useState('');
  const [threads, setThreads] = useState('');
  const [loops, setLoops] = useState('');
  const [extraArgs, setExtraArgs] = useState('');

  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<JmeterLogLine[]>([]);
  const [result, setResult] = useState<JmeterDone | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const keepBottomRef = useRef(true);

  /** 自动探测本机 JMeter / Java */
  const detect = async () => {
    setDetecting(true);
    const r = await window.electronAPI.jmeterDetect();
    setDetecting(false);
    if (!r.success || !r.data) { addToast(r.error || '探测失败', 'error'); return; }
    setJmeterPath(r.data.jmeterPath || '');
    setJavaInfo(r.data.java || { ok: false, path: '' });
    setCandidates(r.data.candidates || []);
    if (r.data.jmeterPath) addToast('已找到 JMeter', 'success');
  };

  useEffect(() => {
    (async () => {
      const d = await window.electronAPI.jmeterDefaults();
      if (d.success && d.data) {
        if (d.data.outDir) setOutDir(d.data.outDir);
        if (d.data.jmxPath) setJmxPath(d.data.jmxPath);
      }
      await detect();
      const st = await window.electronAPI.jmeterStatus();
      if (st.success && st.data) setRunning(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 订阅流式输出：cmd 里看到什么，这里就显示什么 */
  useEffect(() => {
    const offOut = window.electronAPI.onJmeterOutput((payload) => {
      setLines(prev => {
        const next = prev.concat(payload);
        return next.length > 4000 ? next.slice(next.length - 4000) : next;
      });
    });
    const offDone = window.electronAPI.onJmeterDone((payload) => {
      setRunning(false);
      setResult(payload);
      addToast(payload.ok ? '压测完成' : `压测结束（退出码 ${payload.code}）`, payload.ok ? 'success' : 'error');
    });
    return () => { offOut(); offDone(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 日志自动滚到底（用户手动往上翻时不打扰）
  useEffect(() => {
    const el = logRef.current;
    if (el && keepBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const pickExe = async () => {
    const r = await window.electronAPI.jmeterPickExe();
    if (r.canceled) return;
    if (!r.success || !r.data) { addToast(r.error || '选择失败', 'error'); return; }
    setJmeterPath(r.data.jmeterPath);
    addToast('JMeter 路径已保存', 'success');
    await detect();
  };

  const pickScript = async () => {
    const r = await window.electronAPI.jmeterPickScript();
    if (r.canceled) return;
    if (!r.success || !r.data) { addToast(r.error || '选择失败', 'error'); return; }
    setJmxPath(r.data.jmxPath);
    await window.electronAPI.jmeterRemember({ jmxPath: r.data.jmxPath });
  };

  const pickOutDir = async () => {
    const r = await window.electronAPI.jmeterPickOutDir();
    if (r.canceled) return;
    if (!r.success || !r.data) { addToast(r.error || '选择失败', 'error'); return; }
    setOutDir(r.data.outDir);
    await window.electronAPI.jmeterRemember({ outDir: r.data.outDir });
  };

  const start = async () => {
    if (!jmeterPath) { addToast('请先选择 jmeter.bat', 'error'); return; }
    if (!jmxPath) { addToast('请先选择 .jmx 脚本', 'error'); return; }
    if (!outDir) { addToast('请先选择输出目录', 'error'); return; }
    setLines([]);
    setResult(null);
    keepBottomRef.current = true;
    const r = await window.electronAPI.jmeterRun({
      jmeterPath,
      jmxPath,
      mode,
      outDir,
      threads: threads ? Number(threads) : undefined,
      loops: loops ? Number(loops) : undefined,
      extraArgs: extraArgs.trim() ? extraArgs.trim().split(/\s+/) : undefined,
    });
    if (!r.success) { addToast(r.error || '启动失败', 'error'); return; }
    setRunning(true);
  };

  const stop = async () => {
    const r = await window.electronAPI.jmeterStop();
    if (!r.success) { addToast(r.error || '停止失败', 'error'); return; }
    addToast('已发送停止信号', 'info');
  };

  const openPath = async (p: string) => {
    if (!p) return;
    const r = await window.electronAPI.jmeterOpenPath(p);
    if (!r.success) addToast(r.error || '打开失败', 'error');
  };

  const stats = result?.stats || null;
  const errorTone = useMemo(() => {
    if (!stats) return 'mute' as const;
    return stats.errors > 0 ? ('bad' as const) : ('ok' as const);
  }, [stats]);

  return (
    <Page>
      <PageHead
        icon={<Icons.chart size={18} />}
        title="压力测试"
        desc="运行本机 JMeter（非 GUI 模式）：选脚本、定输出，运行过程按 cmd 的样子实时显示"
        tools={
          <>
            <button className="btn btn-secondary" onClick={detect} disabled={detecting}>
              <Icons.refresh size={13} />
              {detecting ? '探测中…' : '重新探测 JMeter'}
            </button>
            <button className="btn btn-primary" onClick={start} disabled={running}>
              {running ? '运行中…' : '开始运行'}
            </button>
          </>
        }
      />

      <Panel title="环境" meta={jmeterPath ? '已就绪' : '未配置'}>
        <div className="perf-env">
          <div className="perf-env-row">
            <span className="perf-env-label">JMeter</span>
            <span className={`perf-env-value${jmeterPath ? '' : ' is-empty'}`} title={jmeterPath}>
              {jmeterPath || '未找到，请手动选择 jmeter.bat'}
            </span>
            <button className="btn btn-secondary btn-sm" onClick={pickExe}>选择 jmeter.bat</button>
          </div>
          <div className="perf-env-row">
            <span className="perf-env-label">Java</span>
            <span className={`perf-env-value${javaInfo.ok ? '' : ' is-empty'}`}>
              {javaInfo.ok ? (javaInfo.version || javaInfo.path) : '未检测到 java（JMeter 需要 JDK/JRE）'}
            </span>
          </div>
          {candidates.length > 1 && (
            <div className="perf-env-row">
              <span className="perf-env-label">其他候选</span>
              <span className="perf-env-value">
                {candidates.slice(0, 4).map(c => (
                  <button key={c} className="perf-cand" title={c} onClick={() => setJmeterPath(c)}>
                    {c.split(/[\\/]/).slice(-3).join('/')}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="运行配置">
        <div className="perf-form">
          <Field label="JMX 脚本" hint="从本机任意位置选，应用只记路径">
            <div className="perf-pick">
              <input value={jmxPath} readOnly placeholder="未选择 .jmx" title={jmxPath} />
              <button className="btn btn-secondary btn-sm" onClick={pickScript}>选择脚本</button>
            </div>
          </Field>

          <Field label="输出目录" hint="结果文件与报告都写到这里">
            <div className="perf-pick">
              <input value={outDir} readOnly placeholder="未选择输出目录" title={outDir} />
              <button className="btn btn-secondary btn-sm" onClick={pickOutDir}>选择目录</button>
            </div>
          </Field>

          <Field label="输出类型">
            <div className="perf-mode">
              <label className={`perf-mode-item${mode === 'log' ? ' is-on' : ''}`}>
                <input type="radio" checked={mode === 'log'} onChange={() => setMode('log')} />
                <span>只要日志（.jtl）</span>
              </label>
              <label className={`perf-mode-item${mode === 'report' ? ' is-on' : ''}`}>
                <input type="radio" checked={mode === 'report'} onChange={() => setMode('report')} />
                <span>日志 + HTML 报告</span>
              </label>
            </div>
          </Field>

          <div className="perf-row2">
            <Field label="线程数" hint="临时覆盖，脚本内用 ${__P(threads,默认)} 才生效">
              <input value={threads} onChange={e => setThreads(e.target.value)} placeholder="如 50" inputMode="numeric" />
            </Field>
            <Field label="循环次数" hint="临时覆盖，脚本内用 ${__P(loops,默认)}">
              <input value={loops} onChange={e => setLoops(e.target.value)} placeholder="如 10" inputMode="numeric" />
            </Field>
          </div>

          <Field label="额外参数" hint="空格分隔，例如 -Jenv=test -Xmx1g">
            <input value={extraArgs} onChange={e => setExtraArgs(e.target.value)} placeholder="可选" />
          </Field>

          <div className="perf-actions">
            {!running ? (
              <button className="btn btn-primary" onClick={start}>开始运行</button>
            ) : (
              <button className="btn btn-secondary" onClick={stop}>停止运行</button>
            )}
            <span className="perf-tip">
              命令：<code>{jmeterPath ? `${jmeterPath} -n -t ${jmxPath || '<脚本>'} -l <结果>.jtl${mode === 'report' ? ' -e -o <报告目录>' : ''}` : '（先配置 JMeter 路径）'}</code>
            </span>
          </div>
        </div>
      </Panel>

      <Panel
        title="运行输出"
        meta={running ? '运行中' : (lines.length ? `${lines.length} 行` : '未运行')}
        tools={lines.length > 0 ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setLines([])}>清空</button>
        ) : undefined}
      >
        <div
          className="perf-log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            keepBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {lines.length === 0 ? (
            <div className="perf-log-empty">点「开始运行」后，这里会像 cmd 一样逐行显示 JMeter 输出</div>
          ) : lines.map((l, i) => (
            <div key={i} className={`perf-line${l.stream === 'err' ? ' is-err' : ''}${l.stream === 'cmd' ? ' is-cmd' : ''}`}>
              {l.line}
            </div>
          ))}
        </div>
      </Panel>

      {result && (
        <Panel
          title="结果"
          meta={result.ok ? '成功' : `退出码 ${result.code}`}
          tools={<Pill tone={errorTone as 'ok' | 'bad' | 'mute'}>{stats ? `错误率 ${stats.errorPct}%` : '无统计'}</Pill>}
        >
          {stats ? (
            <div className="perf-stats">
              <div className="perf-stat"><span>样本数</span><b>{stats.samples}</b></div>
              <div className="perf-stat"><span>平均</span><b>{stats.avg} ms</b></div>
              <div className="perf-stat"><span>最小 / 最大</span><b>{stats.min} / {stats.max} ms</b></div>
              {stats.p90 != null && <div className="perf-stat"><span>P90 / P95</span><b>{stats.p90} / {stats.p95} ms</b></div>}
              <div className="perf-stat"><span>TPS</span><b>{stats.tps}</b></div>
              <div className="perf-stat"><span>错误数</span><b>{stats.errors}{stats.topErrorCode ? `（${stats.topErrorCode.code}×${stats.topErrorCode.count}）` : ''}</b></div>
            </div>
          ) : (
            <div className="perf-tip">没解析到统计（脚本可能没有 Sampler，或结果文件为空）。完整输出见下方日志。</div>
          )}
          <div className="perf-links">
            {result.jtlPath && <button className="btn btn-secondary btn-sm" onClick={() => openPath(result.jtlPath)}>打开 .jtl</button>}
            {result.reportDir && <button className="btn btn-primary btn-sm" onClick={() => openPath(result.reportDir)}>打开 HTML 报告</button>}
            {result.logPath && <button className="btn btn-ghost btn-sm" onClick={() => openPath(result.logPath)}>打开运行日志</button>}
            {result.reportDir && <span className="perf-tip">报告目录：{result.reportDir}</span>}
          </div>
        </Panel>
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </Page>
  );
}