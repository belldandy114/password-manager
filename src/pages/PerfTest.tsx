import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Page, PageHead, Panel, Field, Icons, Pill } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import type { JmeterDone, JmeterLogLine, JmeterHistoryRecord, JmxLibMeta } from '../types';
import { JmxLibrary } from '../components/JmxLibrary';

/**
 * JMeter 非 GUI 运行页。
 *
 * 布局（1.28.0）：左边是可折叠的「环境 / 脚本库 / 运行配置」，右边是「实时控制台 / 历史记录」+ 结果 + 运行历史。
 * 早期是整页纵向平铺，选脚本要来回滚：脚本库在上面、控制台在下面，跑起来就看不见配置了。
 */
export function PerfTest() {
  const { toasts, addToast, removeToast } = useToast();

  const [jmeterPath, setJmeterPath] = useState('');
  const [javaInfo, setJavaInfo] = useState<{
    ok: boolean; home: string; exe: string; version?: string; source?: string;
    envHome?: string; envHomeOk?: boolean;
  }>({ ok: false, home: '', exe: '' });
  const [candidates, setCandidates] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);

  const [jmxPath, setJmxPath] = useState('');
  const [mode, setMode] = useState<'log' | 'report'>('report');
  const [outDir, setOutDir] = useState('');
  const [threads, setThreads] = useState('');
  const [loops, setLoops] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  // 脚本是否支持 -J 覆盖：不支持时禁用输入并说明，避免「填了但没生效」
  const [caps, setCaps] = useState<{ supportsThreads: boolean; supportsLoops: boolean } | null>(null);
  // 运行历史（最近在前）：压测要看多轮趋势，跑完就丢太可惜
  const [history, setHistory] = useState<JmeterHistoryRecord[]>([]);

  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<JmeterLogLine[]>([]);
  // 脚本库：当前载入的脚本（运行完成后回写「最近运行」）
  const libRelRef = useRef('');
  const threadsRef = useRef('');
  const loopsRef = useRef('');
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { loopsRef.current = loops; }, [loops]);
  const [libTick, setLibTick] = useState(0);
  // 脚本里 ${__P(...)} 声明出来的参数（运行前可临时改）
  const [scriptParams, setScriptParams] = useState<{ name: string; value: string; def: string }[]>([]);
  const runStartRef = useRef(0);
  const [result, setResult] = useState<JmeterDone | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const keepBottomRef = useRef(true);

  // 布局：右栏页签 + 左栏折叠
  const [openEnv, setOpenEnv] = useState(true);
  const [openLib, setOpenLib] = useState(true);
  const [openRun, setOpenRun] = useState(true);
  // 运行历史：默认只显示最近 5 次，可展开全部
  const [showAllHistory, setShowAllHistory] = useState(false);

  /** 自动探测本机 JMeter / Java */
  const detect = async () => {
    setDetecting(true);
    const r = await window.electronAPI.jmeterDetect();
    setDetecting(false);
    if (!r.success || !r.data) { addToast(r.error || '探测失败', 'error'); return; }
    setJmeterPath(r.data.jmeterPath || '');
    setJavaInfo((r.data.java as typeof javaInfo) || { ok: false, home: '', exe: '' });
    setCandidates(r.data.candidates || []);
    if (r.data.jmeterPath) addToast('已找到 JMeter', 'success');
  };

  useEffect(() => {
    (async () => {
      const d = await window.electronAPI.jmeterDefaults();
      if (d.success && d.data) {
        // 函数式更新：读默认值/探测要 1~2 秒，期间用户可能已经点了脚本；
        // 晚到的默认值不能把用户刚选好的路径或目录顶掉（1.28.1 修）
        if (d.data.outDir) setOutDir(prev => prev || d.data!.outDir);
        if (d.data.jmxPath) setJmxPath(prev => prev || d.data!.jmxPath);
      }
      await detect();
      const hist = await window.electronAPI.jmeterHistory();
      if (hist.success && hist.data) setHistory(hist.data);
      const st = await window.electronAPI.jmeterStatus();
      if (st.success && st.data) setRunning(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 订阅流式输出：cmd 里看到什么，这里就显示什么 */
  useEffect(() => {
    const offOut = window.electronAPI.onJmeterOutput((payload) => {
      // 收到输出就说明有任务在跑：页面重新挂载、或任务由别处启动时，也要能反映「运行中」
      setRunning(true);
      setLines(prev => {
        const next = prev.concat(payload);
        return next.length > 4000 ? next.slice(next.length - 4000) : next;
      });
    });
    const offDone = window.electronAPI.onJmeterDone((payload) => {
      setRunning(false);
      setResult(payload);
      // 从脚本库载入的脚本：把结果写回库里的「最近运行」
      if (libRelRef.current) {
        void window.electronAPI.jmxlibMarkRun(libRelRef.current, {
          ok: !!payload.ok,
          reportDir: payload.reportDir || '',
          threads: threadsRef.current ? Number(threadsRef.current) : undefined,
          loops: loopsRef.current ? Number(loopsRef.current) : undefined,
          durationMs: runStartRef.current ? Date.now() - runStartRef.current : 0,
          stats: payload.stats || undefined,
        }).then(() => setLibTick(t => t + 1));
      }
      void window.electronAPI.jmeterHistory().then(h => { if (h.success && h.data) setHistory(h.data); });
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

  const pickJavaHome = async () => {
    const r = await window.electronAPI.jmeterPickJavaHome();
    if (r.canceled) return;
    if (!r.success || !r.data) { addToast(r.error || '选择失败', 'error'); return; }
    addToast('JDK 已保存', 'success');
    await detect();
  };

  const pickScript = async () => {
    const r = await window.electronAPI.jmeterPickScript();
    if (r.canceled) return;
    if (!r.success || !r.data) { addToast(r.error || '选择失败', 'error'); return; }
    setJmxPath(r.data.jmxPath);
    const ins = await window.electronAPI.jmeterInspectScript(r.data.jmxPath);
    if (ins.success && ins.data) setCaps({ supportsThreads: !!ins.data.supportsThreads, supportsLoops: !!ins.data.supportsLoops });
    await window.electronAPI.jmeterRemember({ jmxPath: r.data.jmxPath });
  };

  /** 脚本库点选：把路径 / 输出目录 / 线程循环一次填好 */
  const loadFromLib = async (absPath: string, rel: string, meta: JmxLibMeta) => {
    setJmxPath(absPath);
    libRelRef.current = rel;
    // 只有脚本自己存了输出目录才切换；没存就完全不动用户当前选的目录（1.28.2）
    if (meta.outDir) setOutDir(meta.outDir);
    setThreads(meta.threads ? String(meta.threads) : '');
    setLoops(meta.loops ? String(meta.loops) : '');
    const ins = await window.electronAPI.jmeterInspectScript(absPath);
    if (ins.success && ins.data) setCaps({ supportsThreads: !!ins.data.supportsThreads, supportsLoops: !!ins.data.supportsLoops });
    // 参数面板：脚本声明了哪些 ${__P(...)}，就从库里取上次填的值
    const val = await window.electronAPI.jmxlibValidate(rel);
    if (val.success && val.data) {
      setScriptParams(val.data.params.map(p => ({
        name: p.name,
        value: (meta.params && meta.params[p.name]) || '',
        def: p.value,
      })));
    } else {
      setScriptParams([]);
    }
    await window.electronAPI.jmeterRemember({ jmxPath: absPath });
    addToast(`已载入「${absPath.split(/[\\/]/).pop() || absPath}」`, 'success');
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
    // 输出目录为空时用默认目录兜底（点脚本不再改它，这里必须能自己起来）
    let dir = outDir;
    if (!dir) {
      const d = await window.electronAPI.jmxlibDefaultOut();
      if (d.success && d.data) { dir = d.data.outDir; setOutDir(dir); }
    }
    if (!dir) { addToast('请先选择输出目录', 'error'); return; }
    setLines([]);
    setResult(null);
    keepBottomRef.current = true;
    // 参数面板的值以 -J 传给 JMeter（-Jthreads/-Jloops 由主进程单独拼）
    const jArgs = scriptParams.filter(p => p.value !== '').map(p => `-J${p.name}=${p.value}`);
    const manual = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : [];
    const args = [...manual, ...jArgs];
    runStartRef.current = Date.now();
    // 记下这次填的参数，下次打开脚本自动带出来
    if (libRelRef.current && scriptParams.length) {
      const params: Record<string, string> = {};
      for (const p of scriptParams) if (p.value !== '') params[p.name] = p.value;
      void window.electronAPI.jmxlibMetaSet(libRelRef.current, { params });
    }
    const r = await window.electronAPI.jmeterRun({
      jmeterPath,
      jmxPath,
      mode,
      outDir: dir,
      threads: threads ? Number(threads) : undefined,
      loops: loops ? Number(loops) : undefined,
      extraArgs: args.length ? args : undefined,
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

  /** 运行历史表：页签里显示全部，右栏下方显示最近几条 */
  const historyTable = (rows: JmeterHistoryRecord[], emptyText: string) => (
    rows.length === 0 ? (
      <div className="perf-tip">{emptyText}</div>
    ) : (
      <table className="tbl perf-hist-tbl">
        <thead>
          <tr>
            <th>时间</th>
            <th>脚本</th>
            <th className="num">样本</th>
            <th className="num">错误率</th>
            <th className="num">TPS</th>
            <th className="num">平均</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(h => (
            <tr key={h.id}>
              <td className="perf-hist-time">{new Date(h.at).toLocaleString()}</td>
              <td className="perf-hist-name" title={h.jmx}>{h.jmxName || '(未记录脚本)'}</td>
              <td className="num">{h.samples}</td>
              <td className={`num${h.errors ? ' is-bad' : ''}`}>{h.errorPct}%</td>
              <td className="num">{h.tps}</td>
              <td className="num">{h.avg} ms</td>
              <td>
                <span className="perf-hist-actions">
                  {h.reportDir && <button className="btn btn-ghost btn-sm" onClick={() => void openPath(h.reportDir)}>报告</button>}
                  {h.jtlPath && <button className="btn btn-ghost btn-sm" onClick={() => void openPath(h.jtlPath)}>.jtl</button>}
                  {!h.reportDir && !h.jtlPath && <span className="perf-tip">无产出</span>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  );

  const clearHistory = async () => {
    const r = await window.electronAPI.jmeterHistoryClear();
    if (r.success) { setHistory([]); addToast('已清空运行历史', 'success'); }
  };

  return (
    <Page>
      <div className="perf-page">
        <PageHead
          icon={<Icons.chart size={18} />}
          title="压力测试"
          desc="运行本机 JMeter（非 GUI 模式）：左边选脚本定参数，右边看实时输出与历史"
          tools={
            <>
              <button className="btn btn-secondary" onClick={detect} disabled={detecting || running}>
                <Icons.refresh size={13} />
                {detecting ? '探测中…' : '重新探测 JMeter'}
              </button>
              {running ? (
                <button className="btn btn-danger" onClick={stop}>停止运行</button>
              ) : (
                <button className="btn btn-primary" onClick={start}>开始运行</button>
              )}
            </>
          }
        />

        <div className="perf-split">
          {/* ---------- 左栏：环境 / 脚本库 / 运行配置 ---------- */}
          <aside className="perf-side">
            <SideFold
              title="环境"
              meta={jmeterPath ? '已就绪' : '未配置'}
              open={openEnv}
              onToggle={() => setOpenEnv(v => !v)}
            >
              <div className="perf-env">
                <div className="perf-env-row is-line">
                  <span className="perf-env-label">JMeter</span>
                  <span className={`perf-env-value${jmeterPath ? '' : ' is-empty'}`} title={jmeterPath}>
                    {jmeterPath || '未找到，请手动选择 jmeter.bat'}
                  </span>
                  <button className="btn btn-secondary btn-sm" onClick={pickExe}>选择</button>
                </div>
                <div className="perf-env-row is-line">
                  <span className="perf-env-label">Java</span>
                  <span className={`perf-env-value${javaInfo.ok ? '' : ' is-warn'}`} title={javaInfo.exe || javaInfo.home}>
                    {javaInfo.ok
                      ? `${javaInfo.version || 'java'}${javaInfo.home ? ` · ${javaInfo.home}` : ''}`
                      : '未找到可用的 Java（建议 JDK 17）'}
                  </span>
                  <button className="btn btn-secondary btn-sm" onClick={pickJavaHome}>选择</button>
                </div>
                {candidates.length > 1 && (
                  <div className="perf-env-row is-line">
                    <span className="perf-env-label">其他</span>
                    <span className="perf-env-value">
                      {candidates.slice(0, 3).map(c => (
                        <button key={c} className="perf-cand" title={c} onClick={() => setJmeterPath(c)}>
                          {c.split(/[\\/]/).slice(-2).join('/')}
                        </button>
                      ))}
                    </span>
                  </div>
                )}
                {javaInfo.envHome && javaInfo.envHomeOk === false && (
                  <div className="perf-tip is-warn">JAVA_HOME 不可用，运行时已改用上方 JDK</div>
                )}
              </div>
            </SideFold>

            <SideFold
              title="脚本库"
              meta={jmxPath ? '已选脚本' : undefined}
              open={openLib}
              onToggle={() => setOpenLib(v => !v)}
            >
              <JmxLibrary onPick={(abs, rel, meta) => void loadFromLib(abs, rel, meta)} refreshKey={libTick} />
            </SideFold>

            <SideFold
              title="运行配置"
              open={openRun}
              onToggle={() => setOpenRun(v => !v)}
            >
              <div className="perf-form">
                <Field label="JMX 脚本" hint="从本机任意位置选，应用只记路径">
                  <div className="perf-pick">
                    <input value={jmxPath} readOnly placeholder="未选择 .jmx" title={jmxPath} aria-label="JMX 文件路径" />
                    <button className="btn btn-secondary btn-sm" onClick={pickScript}>选择</button>
                  </div>
                </Field>

                <Field label="输出目录" hint="结果文件与报告都写到这里">
                  <div className="perf-pick">
                    <input value={outDir} readOnly placeholder="未选择输出目录" title={outDir} aria-label="输出目录" />
                    <button className="btn btn-secondary btn-sm" onClick={pickOutDir}>选择</button>
                  </div>
                </Field>

                <Field label="输出类型">
                  <div className="perf-mode">
                    <label className={`perf-mode-item${mode === 'log' ? ' is-on' : ''}`}>
                      <input type="radio" checked={mode === 'log'} onChange={() => setMode('log')} />
                      <span>只要日志</span>
                    </label>
                    <label className={`perf-mode-item${mode === 'report' ? ' is-on' : ''}`}>
                      <input type="radio" checked={mode === 'report'} onChange={() => setMode('report')} />
                      <span>日志 + HTML 报告</span>
                    </label>
                  </div>
                </Field>

                <div className="perf-row2">
                  <Field
                    label="线程数"
                    hint={caps && !caps.supportsThreads
                      ? "脚本没有 ${__P(threads,默认值)}，填了不生效"
                      : undefined}
                  >
                    <input
                      value={threads}
                      onChange={e => setThreads(e.target.value)}
                      placeholder={caps && !caps.supportsThreads ? "脚本不支持覆盖" : "如 50"}
                      inputMode="numeric"
                      aria-label="线程数"
                      disabled={!!caps && !caps.supportsThreads}
                    />
                  </Field>
                  <Field
                    label="循环次数"
                    hint={caps && !caps.supportsLoops
                      ? "脚本没有 ${__P(loops,默认值)}，填了不生效"
                      : undefined}
                  >
                    <input
                      value={loops}
                      onChange={e => setLoops(e.target.value)}
                      placeholder={caps && !caps.supportsLoops ? "脚本不支持覆盖" : "如 10"}
                      inputMode="numeric"
                      aria-label="循环次数"
                      disabled={!!caps && !caps.supportsLoops}
                    />
                  </Field>
                </div>

                {scriptParams.length > 0 && (
                  <Field
                    label="脚本参数"
                    hint="脚本里 ${__P(名字,默认)} 声明的参数，以 -J名字=值 传给 JMeter；留空用默认值"
                  >
                    <div className="perf-params">
                      {scriptParams.map((p, i) => (
                        <label key={p.name} className="perf-param">
                          <span className="perf-param-name">{p.name}</span>
                          <input
                            value={p.value}
                            onChange={e => setScriptParams(prev => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                            placeholder={p.def ? `默认 ${p.def}` : '未设置'}
                            aria-label={`脚本参数 ${p.name}`}
                          />
                        </label>
                      ))}
                    </div>
                  </Field>
                )}

                <Field label="额外参数" hint="空格分隔，例如 -Jenv=test -Xmx1g">
                  <input value={extraArgs} onChange={e => setExtraArgs(e.target.value)} placeholder="可选" aria-label="额外参数" />
                </Field>

                <div className="perf-cmd">
                  <div className="perf-cmd-label">执行命令</div>
                  <code className="perf-cmd-text" title={jmeterPath ? `${jmeterPath} -n -t ${jmxPath || '<脚本>'} -l <结果>.jtl${mode === 'report' ? ' -e -o <报告目录>' : ''}` : ''}>
                    {jmeterPath
                      ? `${jmeterPath} -n -t ${jmxPath || '<脚本>'} -l <结果>.jtl${mode === 'report' ? ' -e -o <报告目录>' : ''}`
                      : '（先配置 JMeter 路径）'}
                  </code>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!jmeterPath}
                    onClick={() => {
                      const cmd = `${jmeterPath} -n -t "${jmxPath}" -l "${outDir}\\result.jtl"${mode === 'report' ? ` -e -o "${outDir}\\report"` : ''}`;
                      void navigator.clipboard?.writeText(cmd).then(() => addToast('命令已复制', 'success')).catch(() => addToast('复制失败', 'error'));
                    }}
                  >复制</button>
                </div>
              </div>
            </SideFold>
          </aside>

          {/* ---------- 右栏：控制台 / 结果 / 历史 ---------- */}
          <section className="perf-main">
            <div className="pnl perf-console">
              <div className="pnl-head perf-console-head">
                <span className="pnl-title">实时控制台</span>
                <span className="perf-console-tools">
                  <span className="perf-console-hint" title="界面只保留最近 4000 行，更早的会丢弃；完整输出看「打开运行日志」">
                    {lines.length ? `最近 ${lines.length} 行` : '最多保留 4000 行'}
                  </span>
                  {running ? <Pill tone="info">运行中</Pill> : lines.length > 0 ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => { setLines([]); setResult(null); }}>清空</button>
                  ) : null}
                </span>
              </div>
              <div className="pnl-body perf-console-body">
                <div
                  className="perf-log"
                  ref={logRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    keepBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                  }}
                >
                  {lines.length === 0 ? (
                    <div className="perf-log-empty">点右上角「开始运行」后，这里会像 cmd 一样逐行显示 JMeter 输出</div>
                  ) : lines.map((l, i) => (
                    <div key={i} className={`perf-line${l.stream === 'err' ? ' is-err' : ''}${l.stream === 'cmd' ? ' is-cmd' : ''}`}>
                      {l.line}
                    </div>
                  ))}
                </div>
              </div>
            </div>

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
                  <div className="perf-tip">没解析到统计（脚本可能没有 Sampler，或结果文件为空）。完整输出见左侧控制台。</div>
                )}
                <div className="perf-links">
                  {result.jtlPath && <button className="btn btn-secondary btn-sm" onClick={() => void openPath(result.jtlPath)}>打开 .jtl</button>}
                  {result.reportDir && <button className="btn btn-primary btn-sm" onClick={() => void openPath(result.reportDir)}>打开 HTML 报告</button>}
                  {result.logPath && <button className="btn btn-ghost btn-sm" onClick={() => void openPath(result.logPath)}>打开运行日志</button>}
                </div>
              </Panel>
            )}

            <Panel
              title="运行历史"
              meta={history.length ? `共 ${history.length} 次` : '还没有记录'}
              tools={history.length > 0 ? (
                <>
                  {/* 只有超过 5 条才有「展开全部」的意义；否则点了看不出变化，像坏了 */}
                  {history.length > 5 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowAllHistory(v => !v)}>
                      {showAllHistory ? '收起' : `展开全部（${history.length}）`}
                    </button>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => void clearHistory()}>清空历史</button>
                </>
              ) : undefined}
            >
              <div className={showAllHistory ? 'perf-hist-expand' : undefined}>
                {historyTable(showAllHistory ? history : history.slice(0, 5), '跑一次压测后，这里会留下「时间 / 脚本 / 样本 / 错误率 / TPS」，方便对比调参前后。')}
              </div>
            </Panel>
          </section>
        </div>

        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    </Page>
  );
}

/** 左栏可折叠卡片：标题行整行可点，右侧放状态文字 */
function SideFold({
  title, meta, open, onToggle, children,
}: {
  title: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`pnl perf-fold${open ? ' is-open' : ''}`}>
      <div
        className="pnl-head perf-fold-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <span className="perf-fold-chev"><Icons.chevron size={12} /></span>
        <span className="pnl-title">{title}</span>
        {meta && <span className="perf-fold-meta">{meta}</span>}
      </div>
      {open && <div className="pnl-body">{children}</div>}
    </div>
  );
}







