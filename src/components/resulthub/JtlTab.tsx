/**
 * 页签②：.jtl 指标
 *
 * 总览指标卡 + 按接口（错误率/样本数可排序）；数字全部由主进程算好，本页只展示。
 *
 * 来源：t53 把 `src/pages/ResultHub.tsx`（625 行）按 `docs/拆分-渲染层.md` 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { useState, useMemo } from 'react';
import { Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import type { JtlAnalyzeResult } from '../../../electron/jmeter-args';
import { JTL_TRUNCATED_TEXT } from './model';
import { pct, num, ms } from './format';

/* ================================================================
   页签②：.jtl 指标
   ================================================================ */

export function JtlTab({ addToast }: { addToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const [filePath, setFilePath] = useState('');
  const [data, setData] = useState<JtlAnalyzeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sortBy, setSortBy] = useState<'errorPct' | 'samples'>('errorPct');
  const [showAll, setShowAll] = useState(false);

  const pickFile = async () => {
    const r = await window.electronAPI.pickFile('选择 JMeter .jtl 结果文件', [
      { name: 'JMeter 结果（.jtl / .csv）', extensions: ['jtl', 'csv'] },
    ]);
    if (!r.success) { if (!r.canceled) addToast(r.error || '选择文件失败', 'error'); return; }
    setFilePath(r.data?.file || '');
  };

  const analyze = async () => {
    if (!filePath) { setErr('还没有选文件：先点「选择文件」'); return; }
    setBusy(true);
    setErr('');
    setData(null);
    try {
      const r = await window.electronAPI.jmeterAnalyzeJtl({ path: filePath });
      if (!r.success) { setErr(r.error || '.jtl 解析失败'); return; }
      setData((r.data || null) as JtlAnalyzeResult | null);
      addToast('已解析 .jtl', 'success');
    } catch (e) {
      setErr('.jtl 解析失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  // 排序只在展示层做，后端顺序不动（后端按 samples 降序返回）
  const labels = useMemo(() => {
    const list = [...(data?.byLabel || [])];
    list.sort((a, b) => (sortBy === 'errorPct'
      ? (b.errorPct - a.errorPct) || (b.samples - a.samples)
      : (b.samples - a.samples) || (b.errorPct - a.errorPct)));
    return list;
  }, [data, sortBy]);
  const shown = showAll ? labels : labels.slice(0, 10);

  return (
    <div>
      {busy && <BusyProgress active label="解析 .jtl…" />}

      <Panel
        title="① 取数"
        meta={data ? `${num(data.rows)} 行 · ${num(data.samples)} 样本` : undefined}
        tools={
          <div className="tool-inline">
            <button className="btn btn-secondary btn-sm" onClick={() => void pickFile()} disabled={busy}>
              <Icons.folder size={13} /> 选择文件
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void analyze()} disabled={busy}>
              <Icons.refresh size={13} /> 解析指标
            </button>
          </div>
        }
      >
        <Field label=".jtl 文件" hint="JMeter 的非 GUI 结果文件；只读，不改文件。分位数按最近秩法，均值不作为达标依据">
          <input value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="先用「选择文件」挑一个 .jtl" />
        </Field>

        {err && (
          <div className="dev-banner is-error mt-8" role="alert">
            <Icons.bug size={14} />
            <div className="text-sm">{err}</div>
          </div>
        )}
        {data?.truncated && (
          <div className="dev-banner is-warn mt-8" role="status">
            <Icons.bug size={14} />
            <div className="text-sm">
              已截断（{JTL_TRUNCATED_TEXT[data.truncatedReason || ''] || data.truncatedReason || '上限'}）：
              下面的指标只覆盖已计入的行，别当成全量结论。
            </div>
          </div>
        )}
      </Panel>

      {/* 面板编号：空态与结果块共用同一个 ② 标题。改前空态写「② 指标」、结果写「② 总览指标」+「③ 按接口」，
          同一页会渲染出两个 ② 编号（视觉口径 §4「面板编号」的现存违规）。 */}
      {!data
        ? (
          <Panel title="② 总览指标">
            <Empty
              icon={<Icons.chart size={22} />}
              title="还没有解析过 .jtl"
              desc="选一个 .jtl（或 .csv）结果文件，点「解析指标」。数字全部由主进程算好，本页只负责展示，不自己重算。"
              hint="会给出 samples / errors / errorPct / avg / P50 / P90 / P95 / P99 / TPS / 时间跨度，以及按接口的错误分布。"
            />
          </Panel>
        )
        : (
          <>
            <Panel title="② 总览指标" meta={`${num(data.samples)} 样本 · span ${ms(data.spanMs)}`}>
              <div className="home-stats">
                <div className="home-stat"><b>{num(data.samples)}</b><i>样本数 samples</i></div>
                <div className="home-stat"><b className={data.errors ? 'is-bad' : 'is-ok'}>{num(data.errors)}</b><i>错误数 errors</i></div>
                <div className="home-stat"><b className={data.errorPct > 0 ? 'is-bad' : 'is-ok'}>{pct(data.errorPct)}</b><i>错误率 errorPct</i></div>
                <div className="home-stat"><b>{ms(data.avg)}</b><i>平均 avg</i></div>
              </div>
              <div className="home-stats mt-8">
                <div className="home-stat"><b>{ms(data.p50)}</b><i>P50</i></div>
                <div className="home-stat"><b>{ms(data.p90)}</b><i>P90</i></div>
                <div className="home-stat"><b>{ms(data.p95)}</b><i>P95</i></div>
                <div className="home-stat"><b>{ms(data.p99)}</b><i>P99</i></div>
              </div>
              <div className="tool-inline mt-8">
                <span className="dev-tag is-ok"><Icons.clock size={13} /> TPS {typeof data.tps === 'number' ? data.tps.toFixed(1) : '—'}</span>
                {/* 中性运行信息用 is-unverified；is-unknown 只留给「无法判定」（视觉口径 §4「三态标签」） */}
                <span className="dev-tag is-unverified"><Icons.clock size={13} /> 时间跨度 {ms(data.spanMs)}</span>
                <span className="dev-tag is-unverified"><Icons.list size={13} /> 最快 {ms(data.min)} / 最慢 {ms(data.max)}</span>
                <span className="dev-tag is-heur"><Icons.list size={13} /> 有效行 {num(data.rows)}</span>
              </div>
              <div className="text-sm text-muted mt-8">
                分位数按最近秩法（不用均值做达标依据）：样本少时分位数会跳变，看结论前先确认样本量。
              </div>
            </Panel>

            <Panel
              title="③ 按接口"
              meta={`${labels.length} 个接口${labels.length > 10 ? ` · 显示前 ${shown.length}` : ''}`}
              tools={
                <div className="tool-inline">
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'errorPct' | 'samples')} aria-label="按什么排序">
                    <option value="errorPct">按错误率排序</option>
                    <option value="samples">按样本数排序</option>
                  </select>
                  {labels.length > 10 && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? '只看前 10' : `显示全部 ${labels.length}`}
                    </button>
                  )}
                </div>
              }
            >
              {labels.length === 0
                ? <div className="text-sm text-muted">这份结果里没有带 label 的行。</div>
                : (
                  <div className="dev-scroll">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th scope="col">接口（label）</th>
                          <th scope="col" style={{ width: 80 }}>样本</th>
                          <th scope="col" style={{ width: 70 }}>错误</th>
                          <th scope="col" style={{ width: 96 }}>错误率</th>
                          <th scope="col" style={{ width: 88 }}>P90</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((l) => (
                          <tr key={l.label}>
                            <td title={l.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.label}</td>
                            <td>{l.samples}</td>
                            <td>{l.errors}</td>
                            <td>
                              <span className={`dev-tag ${l.errorPct > 0 ? 'is-fail' : 'is-ok'}`}>{pct(l.errorPct)}</span>
                            </td>
                            <td>{ms(l.p90)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </Panel>
          </>
        )}
    </div>
  );
}