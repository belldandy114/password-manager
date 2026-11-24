/**
 * 页签①：代码体检
 *
 * 选目录 → 勾规则 → 扫描 → 摘要与明细 → 落 scanRuns；明细表在 FindingsTable.tsx。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { useState, useEffect } from 'react';
import { Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { trimToCaps, capsOf, trimNotice } from '../../utils/collectionTrim';
import { useCollection } from '../../hooks/useCollection';
import { newId } from '../../utils/id';
import { formatRecent } from '../../utils/time';
import { FindingsTable } from './FindingsTable';
import { summarizeSeverity, readHistoryCounts, SEVERITY_ORDER, SEVERITY_TEXT, FINDINGS_CAP } from './scanModel';
import type { ScanRunData, ScanFinding, ScanPack, ScanRunRecord } from './scanModel';

/* ================================================================
   页签①：代码体检
   ================================================================ */


export function AuditTab({ addToast }: { addToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const { items: runs, save: saveRuns } = useCollection<ScanRunRecord>('scanRuns');
  const [root, setRoot] = useState('');
  const [packs, setPacks] = useState<ScanPack[]>([]);
  const [rulesErr, setRulesErr] = useState('');
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [data, setData] = useState<ScanRunData | null>(null);
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState('');
  const [revealed, setRevealed] = useState('');

  // 规则表：两个包分别列出（audit / coverage），勾选写 ruleIds
  useEffect(() => {
    void (async () => {
      const r = await window.electronAPI.scanRules();
      if (!r.success) { setRulesErr(r.error || '读取规则表失败'); return; }
      // 官方类型 [C-46]：r.data 已经是 ScanRulesResult，不需要本地断言
      const list = (r.data?.packs || []).filter((p) => p.id === 'audit');
      setPacks(list);
      setRuleIds(list.flatMap((p) => p.rules.map((x) => x.id)));
    })();
  }, []);

  const pickRoot = async () => {
    const r = await window.electronAPI.scanPickRoot();
    if (!r.success) { if (!r.canceled) addToast(r.error || '选择目录失败', 'error'); return; }
    setRoot(r.data?.dir || '');
  };

  const run = async () => {
    if (!root) { setErr('还没有选代码目录：先点「选择目录」'); return; }
    if (!ruleIds.length) { setErr('一条规则都没勾：至少勾一条，否则扫了也是空结果'); return; }
    setBusy(true);
    setErr('');
    setNotice('');
    setData(null);
    setRevealed('');
    const tk = newId('scan-');
    setToken(tk);
    try {
      const r = await window.electronAPI.scanRun({ root, pack: 'audit', ruleIds, token: tk });
      if (!r.success) {
        if (r.canceled) { addToast('已取消扫描', 'info'); return; }
        setErr(r.error || '扫描失败');
        return;
      }
      // 官方类型 [C-46]：r.data 已经是 ScanRunResult；用可选链保持「没拿到数据也不炸」的原语义
      const d = r.data;
      setData(d ?? null);

      // 落一条 scanRuns：**先裁剪再写**（[C-24]/[C-25]），dropped 必须说出来
      // 落库的 counts 同样由 findings 现算（[C-30] 同源约束）——不抄后端 counts，免得两处各算一份
      const truncated = !!d?.truncated;
      const truncatedReason = d?.truncatedReason;
      const storedFindings = (d?.findings || []).slice(0, FINDINGS_CAP);
      const sev = summarizeSeverity(storedFindings);
      const counts = { high: sev.high, medium: sev.medium, low: sev.low };
      const record: ScanRunRecord = {
        id: newId('run-'),
        at: new Date().toISOString(),
        root: d?.root || root,
        pack: 'audit',
        files: Number(d?.files) || 0,
        ...(d && typeof d.bytes === 'number' ? { bytes: d.bytes } : {}),
        // [C-54] 写入时必填：取当次返回的 skippedSymlinks
        skippedSymlinks: Number(d?.skippedSymlinks) || 0,
        truncated,
        ...(truncatedReason ? { truncatedReason } : {}),
        counts,
        findings: storedFindings,
        ruleIds,
        ...(d && typeof d.ms === 'number' ? { ms: d.ms } : {}),
      };
      const caps = capsOf('scanRuns');
      const cut = trimToCaps([record, ...runs], caps, { timeOf: (x) => (x as ScanRunRecord).at });
      const wr = await saveRuns(cut.items);
      if (!wr.success) { addToast(wr.error || '保存体检记录失败', 'error'); return; }
      const msgs: string[] = [];
      if (cut.dropped) msgs.push(trimNotice(cut.dropped));
      if (truncated) msgs.push(`本次扫描结果被截断（${truncatedReason || '上限'}），命中数可能偏少`);
      if (msgs.length) setNotice(msgs.join('；'));
      const hit = counts.high + counts.medium + counts.low + sev.other;
      addToast(
        storedFindings.length >= FINDINGS_CAP
          ? `体检完成：已展示 ${storedFindings.length} 条（达到上限，实际可能更多），扫了 ${record.files} 个文件`
          : `体检完成：命中 ${hit} 条，扫了 ${record.files} 个文件`,
        hit ? 'info' : 'success',
      );
    } catch (e) {
      setErr('扫描失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      setToken('');
    }
  };

  const cancel = async () => {
    if (!token) return;
    await window.electronAPI.scanCancel(token);
  };

  const reveal = async (f: ScanFinding) => {
    const r = await window.electronAPI.scanReveal({ file: f.file, line: f.line });
    if (!r.success) { addToast(r.error || '定位失败', 'error'); return; }
    setRevealed(`${f.file}:${f.line}`);
  };

  const findings = data?.findings || [];
  // 摘要以 findings 为准（[C-30] 同源约束）：服务端 counts 只做**交叉校验**，不参与显示
  const counts = summarizeSeverity(findings);
  const total = counts.high + counts.medium + counts.low + counts.other;
  const scanned = Number(data?.files) || 0;
  const skipped = Number(data?.skippedSymlinks) || 0;
  // 禁 `counts[k] || 0`：缺失键要当"缺失"看，不能兜成 0 假装两边一致（t46 的「中 0」就是这么来的）
  const serverCounts = data?.counts as Record<string, unknown> | undefined;
  const serverMismatch = SEVERITY_ORDER.filter((k) => {
    const v = serverCounts?.[k];
    return typeof v === 'number' && v !== counts[k];
  });
  /** 是否已到后端上限（到了就只能说「已展示 N 条」） */
  const hitCap = findings.length >= FINDINGS_CAP;

  return (
    <div>
      {busy && <BusyProgress active label="扫描中…（可随时取消）" />}

      <div className="dev-banner is-info" style={{ marginBottom: 8 }}>
        <Icons.bug size={14} />
        <div className="text-sm">
          启发式检查，不是语法树分析：<strong>可能误报，也会漏报</strong>。命中内容只在本机展示，不写日志、不进导出。
        </div>
      </div>

      <Panel
        title="① 取数"
        meta={data ? `${scanned} 个文件 · ${data.ms ?? 0} ms` : undefined}
        tools={
          <div className="tool-inline" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void pickRoot()} disabled={busy}>
              <Icons.folder size={13} /> 选择目录
            </button>
            {busy
              ? <button className="btn btn-secondary btn-sm" onClick={() => void cancel()}>取消扫描</button>
              : <button className="btn btn-primary btn-sm" onClick={() => void run()}><Icons.search size={13} /> 开始体检</button>}
          </div>
        }
      >
        <Field label="代码目录" hint="只读：遍历 + 正则匹配，不改任何文件、不落日志">
          <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="先用「选择目录」挑一个" />
        </Field>

        {rulesErr && <div className="dev-banner is-error" role="alert" style={{ marginTop: 8 }}><div className="text-sm">{rulesErr}</div></div>}

        <div style={{ marginTop: 10 }}>
          <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
            规则（共 {packs.reduce((s, p) => s + p.rules.length, 0)} 条，默认全选）：
          </div>
          {packs.map((p) => (
            <div key={p.id} style={{ marginBottom: 8 }}>
              <div className="text-sm" style={{ marginBottom: 4 }}>
                <span className="dev-tag is-unknown">{p.label}</span>
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                {p.rules.map((rule) => {
                  const on = ruleIds.includes(rule.id);
                  return (
                    <label key={rule.id} className="text-sm" title={rule.desc} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => setRuleIds((prev) => (e.target.checked ? [...prev, rule.id] : prev.filter((x) => x !== rule.id)))}
                        aria-label={`启用规则 ${rule.title}`}
                      />
                      <span>
                        {rule.title}
                        <span className="text-sm text-muted">（{SEVERITY_TEXT[rule.severity] || rule.severity}）</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {err && <div className="dev-banner is-error" role="alert" style={{ marginTop: 8 }}><Icons.bug size={14} /><div className="text-sm">{err}</div></div>}
        {notice && <div className="dev-banner is-warn" style={{ marginTop: 8 }} role="status"><Icons.clock size={14} /><div className="text-sm">{notice}</div></div>}
      </Panel>

      {!data
        ? (
          <Panel title="② 结果">
            <Empty
              icon={<Icons.search size={22} />}
              title="还没有跑过体检"
              desc="选一个代码目录、勾好规则，再点「开始体检」。只读扫描，不会改动任何文件。"
              hint="结果会按严重度分档展示，每条都标「启发式命中」——它不是语法树分析的结论。"
            />
          </Panel>
        )
        : (
          <Panel title="② 结果" meta={hitCap ? `已展示 ${findings.length} 条（达到上限）` : `命中 ${total} 条`}>
            {/* 摘要：4 档严重度 + 文件数/跳过数（[C-54]：跳过 M>0 不折叠） */}
            <div className="tool-inline" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              {SEVERITY_ORDER.map((k) => (
                <span key={k} className="dev-tag is-unknown">
                  {SEVERITY_TEXT[k]} {counts[k]}
                </span>
              ))}
              {counts.other > 0 && <span className="dev-tag is-unknown">其他档 {counts.other}</span>}
              <span className="dev-tag is-ok">
                已扫 {scanned} 个文件
                {skipped > 0 ? `，跳过 ${skipped} 个符号链接` : '（未跳过符号链接）'}
              </span>
              <span className="dev-tag is-heur">启发式命中</span>
            </div>

            {skipped > 0 && (
              <div className="dev-banner is-warn" style={{ marginBottom: 8 }} role="status">
                <Icons.bug size={14} />
                <div className="text-sm">
                  已扫 {scanned} 个文件，跳过 {skipped} 个符号链接：这几个（及其子目录）里就算有命中也不会出现在下面，
                  别把「没报」当成「没问题」。
                </div>
              </div>
            )}

            {data.truncated && (
              <div className="dev-banner is-warn" style={{ marginBottom: 8 }}>
                <Icons.bug size={14} />
                <div className="text-sm">本次扫描被截断（{data.truncatedReason || '上限'}）：命中数与文件数都可能偏少。</div>
              </div>
            )}

            {hitCap && (
              <div className="dev-banner is-warn" style={{ marginBottom: 8 }} role="status">
                <Icons.list size={14} />
                <div className="text-sm">
                  已展示 {findings.length} 条（达到上限，实际可能更多）——扫描到 {FINDINGS_CAP} 条就停了，
                  总数后端也不知道，所以这里不给「命中 N 条」。下面的分布只统计已展示的这部分。
                </div>
              </div>
            )}

            {/* [C-30] counts 只做冗余校验：对不上就明说，不许用一方的数盖住另一方 */}
            {serverMismatch.length > 0 && (
              <div className="dev-banner is-error" style={{ marginBottom: 8 }} role="alert">
                <Icons.bug size={14} />
                <div className="text-sm">
                  后端计数与列表对不上（
                  {serverMismatch.map((k) => `${SEVERITY_TEXT[k]}：后端 ${String(serverCounts?.[k])} / 本页 ${counts[k]}`).join('；')}
                  ）——本页一律以列表为准，请把这条报给开发。
                </div>
              </div>
            )}

            {revealed && <div className="text-sm text-muted" style={{ marginBottom: 6 }}>已在文件管理器中定位：{revealed}</div>}

            <FindingsTable findings={findings} onReveal={(f) => void reveal(f)} />
          </Panel>
        )}

      <Panel title="③ 历史记录" meta={`${runs.length}/20`}>
        {runs.length === 0
          ? <div className="text-sm text-muted">还没有历史记录。跑一次体检就会在这里留一条（单集合最多 20 条，超出丢最旧）。</div>
          : (
            <div className="dev-scroll" style={{ maxHeight: 260 }}>
              <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 120 }}>时间</th>
                    <th scope="col">目录</th>
                    <th scope="col" style={{ width: 96 }}>文件数</th>
                    <th scope="col" style={{ width: 150 }}>符号链接</th>
                    <th scope="col" style={{ width: 160 }}>命中（阻断/高/中/低）</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.at ? formatRecent(r.at) : '—'}</td>
                      <td title={r.root} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.root}</td>
                      <td>{r.files}</td>
                      <td>
                        {/* [C-54] 老记录没有这个字段：显示 —，不许假装「跳过 0 个」 */}
                        {typeof r.skippedSymlinks === 'number'
                          ? (r.skippedSymlinks > 0
                            ? <span className="dev-tag is-unverified">跳过 {r.skippedSymlinks} 个</span>
                            : <span className="text-sm text-muted">跳过 0 个</span>)
                          : <span className="text-sm text-muted" title="v6 之前的记录没有这个字段">—</span>}
                      </td>
                      <td>
                        {/* 老记录可能是 mid：按 medium 读；缺键显示 —（不兜 0） */}
                        {(() => {
                          const c = readHistoryCounts(r.counts);
                          return `${c.high ?? '—'} / ${c.medium ?? '—'} / ${c.low ?? '—'}`;
                        })()}
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