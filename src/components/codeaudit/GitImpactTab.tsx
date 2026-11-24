/**
 * 页签②：Git 影响面
 *
 * 探仓库 → 取三档 diff → gitImpact 算受影响脚本；台账为空时必须说「算不出来」。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { useCollection } from '../../hooks/useCollection';
import { gitImpact, NO_CASE_MAP_NOTICE, isDefiniteVia } from '../../utils/gitImpact';
import type { GitImpactResult } from '../../utils/gitImpact';
import type { CaseMapEntry } from '../../utils/caseMaps';
import type { GitDiffFile, GitProbeResult } from '../../types';

/* ================================================================
   页签②：Git 影响面
   ================================================================ */


const SCOPE_LABEL: Record<string, string> = { unstaged: '未暂存（工作区）', staged: '已暂存（索引）', head: '对比 HEAD' };

export function GitImpactTab({ addToast }: { addToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const { items: caseMaps, loading: mapsLoading } = useCollection<CaseMapEntry>('caseMaps');
  const [root, setRoot] = useState('');
  const [probe, setProbe] = useState<GitProbeResult | null>(null);
  const [scope, setScope] = useState<'unstaged' | 'staged' | 'head'>('unstaged');
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [impact, setImpact] = useState<GitImpactResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ran, setRan] = useState(false);

  const pickRoot = async () => {
    const r = await window.electronAPI.scanPickRoot();
    if (!r.success) { if (!r.canceled) addToast(r.error || '选择目录失败', 'error'); return; }
    setRoot(r.data?.dir || '');
    setProbe(null);
    setImpact(null);
    setFiles([]);
    setRan(false);
  };

  const runProbe = useCallback(async (dir: string) => {
    const p = await window.electronAPI.gitProbe({ root: dir });
    if (!p.success) {
      setProbe(null);
      // 非 git 目录要显示后端的中文文案（[C-60]），不要自己臆造
      setErr(p.error || '不是 git 仓库');
      return false;
    }
    setProbe(p.data ?? null);
    setErr('');
    return true;
  }, []);

  useEffect(() => {
    if (!root) return;
    void runProbe(root);
  }, [root, runProbe]);

  const run = async () => {
    if (!root) { setErr('还没有选目录：先点「选择目录」'); return; }
    setBusy(true);
    setErr('');
    setImpact(null);
    try {
      const ok = await runProbe(root);
      if (!ok) return;
      const r = await window.electronAPI.gitDiff({ root, scope });
      if (!r.success) { setErr(r.error || '读取改动失败'); return; }
      // 官方类型 [C-46]：r.data 已经是 GitDiffResult
      const d = r.data;
      const list: GitDiffFile[] = d && Array.isArray(d.files) ? d.files : [];
      setFiles(list);
      setTruncated(!!d?.truncated);
      // 台账为空 → gitImpact 会返回 empty-maps，页面据此显示「算不出来」
      const res = gitImpact({ changedFiles: list, caseMaps });
      setImpact(res);
      setRan(true);
      addToast(res.status === 'empty-maps' ? NO_CASE_MAP_NOTICE : `影响面：${res.affected.length} 个脚本`, res.status === 'empty-maps' ? 'info' : 'success');
    } finally {
      setBusy(false);
    }
  };

  const copySuggestion = async () => {
    if (!impact) return;
    try {
      await navigator.clipboard.writeText(impact.suggestion);
      addToast('已复制建议', 'success');
    } catch {
      addToast('复制失败（窗口可能未聚焦）', 'error');
    }
  };

  const definite = useMemo(() => (impact?.affected || []).filter((a) => isDefiniteVia(a.via)), [impact]);
  const heuristic = useMemo(() => (impact?.affected || []).filter((a) => !isDefiniteVia(a.via)), [impact]);

  return (
    <div>
      {busy && <BusyProgress active label="读取 git 改动…" />}

      <Panel
        title="① 取改动"
        meta={probe ? `${probe.branch || '—'} @ ${probe.head || '—'}${probe.dirty ? ' · 有未提交改动' : ''}` : undefined}
        tools={
          <div className="tool-inline">
            <button className="btn btn-secondary btn-sm" onClick={() => void pickRoot()} disabled={busy}>
              <Icons.folder size={13} /> 选择仓库
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void run()} disabled={busy}>
              <Icons.refresh size={13} /> 计算影响面
            </button>
          </div>
        }
      >
        <div className="grid2">
          <Field label="仓库目录" hint="只读：只跑 status / diff / rev-parse 三条命令，不执行任何写操作">
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="先用「选择仓库」挑一个" />
          </Field>
          <Field label="比对范围" hint="已暂存 = 索引 vs HEAD；未暂存 = 工作区 vs 索引；对比 HEAD = 工作区 vs HEAD">
            <select value={scope} onChange={(e) => setScope(e.target.value as 'unstaged' | 'staged' | 'head')} aria-label="选择 diff 范围">
              <option value="unstaged">{SCOPE_LABEL.unstaged}</option>
              <option value="staged">{SCOPE_LABEL.staged}</option>
              <option value="head">{SCOPE_LABEL.head}</option>
            </select>
          </Field>
        </div>

        {probe && !probe.isRepo && (
          <div className="dev-banner is-error mt-8" role="alert">
            <Icons.bug size={14} /><div className="text-sm">不是 git 仓库：这个目录里没有 .git。</div>
          </div>
        )}
        {err && <div className="dev-banner is-error mt-8" role="alert"><Icons.bug size={14} /><div className="text-sm">{err}</div></div>}
      </Panel>

      {/* 台账为空：这是「算不出来」，不是「没影响」——必须显眼 */}
      {!mapsLoading && caseMaps.length === 0 && (
        <div className="dev-banner is-warn" role="alert">
          <Icons.bug size={14} />
          <div className="text-sm">
            <strong>{NO_CASE_MAP_NOTICE}</strong>
            ：用例映射是空的，影响面无从算起。先去「资产台账 → 用例映射」导入或新增映射，再回来。
            在那之前，<strong>不要把这里显示的任何「0」当成「本次改动不影响脚本」</strong>。
          </div>
        </div>
      )}

      {ran && impact && (
        <>
          <Panel
            title="② 受影响脚本"
            meta={impact.status === 'empty-maps' ? '算不出来' : `${impact.affected.length} 个`}
            tools={
              <button className="btn btn-secondary btn-sm" onClick={() => void copySuggestion()}>
                <Icons.copy size={13} /> 复制建议
              </button>
            }
          >
            <div className="tool-inline mb-8">
              <span className="dev-tag is-ok">确定命中 {definite.length}</span>
              <span className="dev-tag is-heur">启发式 {heuristic.length}</span>
              <span className="dev-tag is-unverified">未映射改动 {impact.unmapped.length}</span>
              {/* 比对范围 + 文件数是**中性运行信息**，不是「无法判定」：is-unknown 只留给
                  「无法判定」（视觉口径 §4「三态标签」/ v2 面板编号同批口径） */}
              <span className="dev-tag is-unverified">{SCOPE_LABEL[scope]} · {files.length} 个文件</span>
              {truncated && <span className="dev-tag is-fail">改动超过 2000，已截断</span>}
            </div>

            {impact.status === 'empty-maps' && (
              <div className="dev-banner is-warn" role="alert">
                <Icons.bug size={14} />
                <div className="text-sm">{NO_CASE_MAP_NOTICE}（算不出来 ≠ 没有影响）。</div>
              </div>
            )}

            {impact.status === 'no-changes' && (
              <div className="dev-banner is-info">
                <Icons.check size={14} /><div className="text-sm">当前范围没有改动文件。</div>
              </div>
            )}

            <div className="dev-banner is-info" role="status">
              <Icons.tool size={14} />
              <div className="text-sm">{impact.suggestion}</div>
            </div>

            {impact.affected.length > 0 && (
              <div className="dev-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 110 }}>用例编号</th>
                      <th scope="col" style={{ width: 150 }}>标题</th>
                      <th scope="col">脚本</th>
                      <th scope="col" style={{ width: 110 }}>命中方式</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.affected.map((a) => (
                      <tr key={`${a.caseNo}-${a.kind}-${a.script}`}>
                        <td>{a.caseNo}</td>
                        <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.caseTitle}>{a.caseTitle || '—'}</td>
                        <td title={`${a.script}\n${a.reason}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.script}</td>
                        <td>
                          {isDefiniteVia(a.via)
                            ? <span className="dev-tag is-ok">{a.via === 'method' ? '方法级' : '路径命中'}</span>
                            : <span className="dev-tag is-heur">文件名推测</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {impact.unmapped.length > 0 && (
              <div className="mt-8">
                <div className="text-sm mb-8">
                  没匹配到任何脚本的改动文件（{impact.unmapped.length} 个）：这些要人工确认，不能当成「无需回归」。
                </div>
                <div className="dev-scroll is-short">
                  <table className="tbl">
                    <tbody>
                      {impact.unmapped.map((p) => (
                        <tr key={p}><td title={p} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Panel>

          <Panel title="③ 改动文件" meta={`${files.length}${truncated ? '（已截断）' : ''}`}>
            {files.length === 0
              ? (
                <Empty
                  compact
                  icon={<Icons.check size={20} />}
                  title="这个范围没有改动文件"
                  desc="当前比对范围里没有新增 / 修改 / 删除的文件，所以没有可对照的脚本。"
                  hint="换一个比对范围（已暂存 / 对比 HEAD）再看一次：「未暂存」只看工作区相对索引的改动。"
                />
              )
              : (
                <div className="dev-scroll is-short">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">文件</th>
                        <th scope="col" style={{ width: 130 }}>状态</th>
                        <th scope="col" style={{ width: 80 }}>+</th>
                        <th scope="col" style={{ width: 80 }}>−</th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f) => (
                        <tr key={f.path}>
                          <td title={f.origPath ? `${f.origPath} → ${f.path}` : f.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.path}
                          </td>
                          <td>{f.status}</td>
                          <td>{f.additions}</td>
                          <td>{f.deletions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Panel>
        </>
      )}

      {!ran && (
        <Panel title="② 受影响脚本">
          <Empty
            icon={<Icons.chart size={22} />}
            title="还没有算过影响面"
            desc="选一个 git 仓库、挑好比对范围，点「计算影响面」。改动文件会拿去和「资产台账 → 用例映射」对齐。"
            hint="用例映射为空时这里会明确说「算不出来」，而不是给你一个 0。"
          />
        </Panel>
      )}
    </div>
  );
}