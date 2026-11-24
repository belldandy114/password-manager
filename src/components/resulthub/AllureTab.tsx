/**
 * 页签①：Allure 结果
 *
 * flaky 带分母、skippedFiles 与 skipped 分列、聚类 key + sample/samples。
 *
 * 来源：t53 把 `src/pages/ResultHub.tsx`（625 行）按 `docs/拆分-渲染层.md` 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import React, { useState } from 'react';
import { Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { trimToCaps, capsOf, trimNotice } from '../../utils/collectionTrim';
import { useCollection } from '../../hooks/useCollection';
import { newId } from '../../utils/id';
import { formatRecent } from '../../utils/time';
import { TRUNCATED_TEXT } from './model';
import type { AllureParseData, AllureRunRecord } from './model';
import { num, ms } from './format';

/* ================================================================
   页签①：Allure 结果
   ================================================================ */

export function AllureTab({ addToast }: { addToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const { items: runs, save: saveRuns } = useCollection<AllureRunRecord>('allureRuns');
  const [dir, setDir] = useState('');
  const [data, setData] = useState<AllureParseData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [openCluster, setOpenCluster] = useState<string>('');

  const pickDir = async () => {
    const r = await window.electronAPI.allurePickDir();
    if (!r.success) { if (!r.canceled) addToast(r.error || '选择目录失败', 'error'); return; }
    setDir(r.data?.dir || '');
  };

  const parse = async () => {
    if (!dir) { setErr('还没有选目录：先点「选择目录」'); return; }
    setBusy(true);
    setErr('');
    setNotice('');
    setData(null);
    setOpenCluster('');
    try {
      const r = await window.electronAPI.allureParse({ dir });
      if (!r.success) { setErr(r.error || '解析失败'); return; }
      const d = (r.data || {}) as AllureParseData;
      setData(d);

      // 落 allureRuns：**先裁剪再写**（[C-24]/[C-25]）
      const record: AllureRunRecord = {
        id: newId('allure-'),
        at: new Date().toISOString(),
        root: d.root || dir,
        total: Number(d.total) || 0,
        passed: Number(d.passed) || 0,
        failed: Number(d.failed) || 0,
        broken: Number(d.broken) || 0,
        skipped: Number(d.skipped) || 0,
        retries: Number(d.retries) || 0,
        // [C-63] 写入时必填；读取时兼容缺失
        skippedFiles: Number(d.skippedFiles) || 0,
        clusters: (d.clusters || []).slice(0, 50),
        flaky: (d.flaky || []).slice(0, 500),
      };
      const caps = capsOf('allureRuns');
      const cut = trimToCaps([record, ...runs], caps, { timeOf: (x) => (x as AllureRunRecord).at });
      const wr = await saveRuns(cut.items);
      if (!wr.success) { addToast(wr.error || '保存解析记录失败', 'error'); return; }
      if (cut.dropped) setNotice(trimNotice(cut.dropped));
      addToast(`解析完成：${record.total} 个用例`, 'success');
    } catch (e) {
      setErr('解析失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const flaky = data?.flaky || [];
  const clusters = data?.clusters || [];
  const envEntries = Object.entries(data?.environment || {});
  const skippedFiles = Number(data?.skippedFiles) || 0;
  const clusterTotal = clusters.reduce((s, c) => s + (Number(c.count) || 0), 0);

  return (
    <div>
      {busy && <BusyProgress active label="解析 Allure 结果目录…" />}

      <Panel
        title="① 取数"
        meta={data ? `${num(data.total)} 个用例 · ${num(data.ms)} ms` : undefined}
        tools={
          <div className="tool-inline" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void pickDir()} disabled={busy}>
              <Icons.folder size={13} /> 选择目录
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void parse()} disabled={busy}>
              <Icons.refresh size={13} /> 解析结果
            </button>
          </div>
        }
      >
        <Field label="allure-results 目录" hint="只读：同一目录里同一用例的多次 result 会被合并成一条，用来判 flaky">
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="先用「选择目录」挑一个" />
        </Field>

        {err && (
          <div className="dev-banner is-error" role="alert" style={{ marginTop: 8 }}>
            <Icons.bug size={14} />
            <div className="text-sm">{err}</div>
          </div>
        )}
        {notice && (
          <div className="dev-banner is-warn" role="status" style={{ marginTop: 8 }}>
            <Icons.clock size={14} />
            <div className="text-sm">{notice}</div>
          </div>
        )}
      </Panel>

      {!data
        ? (
          <Panel title="② 结果">
            <Empty
              icon={<Icons.inbox size={22} />}
              title="还没有解析过结果目录"
              desc="选一个 allure-results 目录，点「解析结果」。只看 *-result.json / *-container.json / environment.*，附件不读不解析。"
              hint="flaky 会以「失败/运行」的形式显示（例如 1/3）；跳过的附件文件数和 skipped 用例数分开统计。"
            />
          </Panel>
        )
        : (
          <>
            <Panel title="② 用例分布" meta={`来自 ${(data.root || dir).split(/[\\/]/).pop()}`}>
              <div className="home-stats">
                <div className="home-stat"><b>{num(data.total)}</b><i>用例总数</i></div>
                <div className="home-stat"><b className="is-ok">{num(data.passed)}</b><i>passed</i></div>
                <div className="home-stat"><b className={data.failed ? 'is-bad' : ''}>{num(data.failed)}</b><i>failed</i></div>
                <div className="home-stat"><b className={data.broken ? 'is-warn' : ''}>{num(data.broken)}</b><i>broken</i></div>
                <div className="home-stat"><b>{num(data.skipped)}</b><i>skipped（用例状态）</i></div>
                <div className="home-stat"><b>{num(data.retries)}</b><i>retries（重跑次数）</i></div>
              </div>

              {/* [C-63] skippedFiles 与 skipped 是两个数：这里单独一行，文案不复用上面那条 */}
              <div className="tool-inline" style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                <span className={`dev-tag ${skippedFiles > 0 ? 'is-unverified' : 'is-ok'}`}>
                  <Icons.clip size={13} /> 跳过的文件数 {skippedFiles}
                </span>
                <span className="dev-tag is-unknown">
                  <Icons.list size={13} /> 用例 skipped {num(data.skipped)}
                </span>
                <span className="text-sm text-muted">
                  「跳过的文件数」= 目录里非 *-result.json / *-container.json / environment.* 的文件（附件、日志），
                  不计入用例数；「用例 skipped」才是状态为 skipped 的用例。
                </span>
              </div>

              {skippedFiles > 0 && (
                <div className="dev-banner is-warn" style={{ marginTop: 8 }} role="status">
                  <Icons.clip size={14} />
                  <div className="text-sm">
                    本次导入跳过了 {skippedFiles} 个文件（附件/非结果文件，按 [C-61] 不读不解析）。
                    这些不是"跳过的用例"，别把两个数混在一起看。
                  </div>
                </div>
              )}

              {data.truncated && (
                <div className="dev-banner is-warn" style={{ marginTop: 8 }} role="status">
                  <Icons.bug size={14} />
                  <div className="text-sm">
                    结果被截断（{TRUNCATED_TEXT[data.truncatedReason || ''] || data.truncatedReason || '上限'}）：下面的计数只覆盖已解析部分。
                  </div>
                </div>
              )}
            </Panel>

            <Panel title="③ flaky（失败/运行）" meta={`${flaky.length} 条`}>
              <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
                「失败/运行」是本页的判断依据：<code>1/3</code> 是偶发、<code>3/3</code> 是必挂，两者的处置完全不同。
                只跑过 1 次的用例永远不会被算成 flaky。
              </div>
              {flaky.length === 0
                ? (
                  <Empty
                    compact
                    icon={<Icons.check size={20} />}
                    title="没有 flaky 用例"
                    desc="这个目录里没有「既通过过、又不通过过」的用例。"
                    hint="如果期望有，检查是不是把多轮结果放在同一个目录里——跨目录不会判 flaky。"
                  />
                )
                : (
                  <div className="dev-scroll" style={{ maxHeight: 320 }}>
                    <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                      <thead>
                        <tr>
                          <th scope="col">用例</th>
                          <th scope="col" style={{ width: 120 }}>失败/运行</th>
                          <th scope="col" style={{ width: 80 }}>通过</th>
                          <th scope="col" style={{ width: 90 }}>不通过</th>
                        </tr>
                      </thead>
                      <tbody>
                        {flaky.map((f) => (
                          <tr key={f.fullName || f.name}>
                            <td title={f.fullName} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</td>
                            <td>
                              {/* 分母必须显示（AC-11）：3 次跑挂 1 次 ≠ 3 次全挂 */}
                              <span className="dev-tag is-fail" aria-label={`失败 ${f.fail} 次，共运行 ${f.runs} 次`}>
                                {f.fail}/{f.runs}
                              </span>
                            </td>
                            <td>{f.pass}</td>
                            <td>{f.fail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </Panel>

            <Panel title="④ 失败聚类" meta={`${clusters.length} 类 / ${clusterTotal} 次`}>
              <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
                key 是**归一后的报错模式**（数字、堆栈、耗时都抹掉了），同一个根因会被归到一类；
                「原文」是代表样本，展开可看最多 3 条对照 —— 如果同一类里原文差别很大，说明 key 抹过头了。
              </div>
              {clusters.length === 0
                ? <div className="text-sm text-muted">没有失败用例，或失败信息为空。</div>
                : (
                  <div className="dev-scroll" style={{ maxHeight: 380 }}>
                    <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                      <thead>
                        <tr>
                          <th scope="col">key（归一后的模式）</th>
                          <th scope="col" style={{ width: 70 }}>次数</th>
                          <th scope="col">代表原文</th>
                          <th scope="col" style={{ width: 88 }}>对照</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clusters.map((c) => {
                          const open = openCluster === c.key;
                          const samples = Array.isArray(c.samples) ? c.samples : [];
                          return (
                            <React.Fragment key={c.key}>
                              <tr>
                                <td title={c.key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.key}</td>
                                <td><span className="dev-tag is-fail">{c.count}</span></td>
                                <td title={c.sample} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  <code>{c.sample || '—'}</code>
                                </td>
                                <td>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => setOpenCluster(open ? '' : c.key)}
                                    aria-expanded={open}
                                    aria-label={`展开聚类 ${c.key} 的对照样本`}
                                  >
                                    <Icons.chevron size={13} /> {samples.length || 0} 条
                                  </button>
                                </td>
                              </tr>
                              {open && (
                                <tr>
                                  <td colSpan={4}>
                                    <div style={{ display: 'grid', gap: 4 }}>
                                      {samples.length === 0
                                        ? <div className="text-sm text-muted">这条聚类没有对照样本。</div>
                                        : samples.map((s, i) => (
                                          <code key={`${c.key}-${i}`} className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{s}</code>
                                        ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </Panel>

            {envEntries.length > 0 && (
              <Panel title="⑤ 环境信息" meta={`${envEntries.length} 项`}>
                <div className="dev-scroll" style={{ maxHeight: 160 }}>
                  <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                    <tbody>
                      {envEntries.map(([k, v]) => (
                        <tr key={k}><td style={{ width: 220 }}>{k}</td><td title={v} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </>
        )}

      <Panel title="⑥ 历史记录" meta={`${runs.length}/20`}>
        {runs.length === 0
          ? <div className="text-sm text-muted">还没有历史记录。解析一次就会留一条（单集合最多 20 条，超出丢最旧）。</div>
          : (
            <div className="dev-scroll" style={{ maxHeight: 260 }}>
              <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 110 }}>时间</th>
                    <th scope="col">目录</th>
                    <th scope="col" style={{ width: 60 }}>总数</th>
                    <th scope="col" style={{ width: 120 }}>通过/失败/断开</th>
                    <th scope="col" style={{ width: 80 }}>skipped</th>
                    <th scope="col" style={{ width: 110 }}>跳过的文件数</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.at ? formatRecent(r.at) : '—'}</td>
                      <td title={r.root} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.root}</td>
                      <td>{r.total}</td>
                      <td>{`${r.passed} / ${r.failed} / ${r.broken}`}</td>
                      <td>{r.skipped}</td>
                      <td>
                        {/* [C-63] 老记录没有 skippedFiles：显示 —，不许假装 0 个 */}
                        {typeof r.skippedFiles === 'number'
                          ? (r.skippedFiles > 0
                            ? <span className="dev-tag is-unverified">{r.skippedFiles} 个</span>
                            : <span className="text-sm text-muted">0 个</span>)
                          : <span className="text-sm text-muted" title="v6 之前的记录没有这个字段">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
    </div>
  );
}