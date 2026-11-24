/**
 * 页签①：代码体检
 *
 * 选目录 → 勾规则 → 扫描 → 摘要与明细 → 落 scanRuns；明细表（含分页）在 FindingsTable.tsx。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开。
 * 1.34.0 / W8（t7）按 `docs/acceptance/W8-组件契约.md` §4 与 `docs/acceptance/W8-视觉口径.md` §4
 * 改了**六处口径**（每处都在下面就地写明依据）：
 *   1. §4.2 截断文案六分流：明细到顶 / 折叠 / 四种「扫描覆盖被砍」分开说，不再一刀切「本次扫描结果被截断」；
 *   2. §4.3 摘要取 `data.counts + data.totalFindings` —— **不再用 findings 现算**（明细只有 2000 条，
 *      现算出来的是「明细分布」，会把 5231 条显示成 2000 条的分布，`[C-30]` v16）；
 *   3. §4.3 落库改用 `SCAN_HISTORY_FINDINGS_CAP`（300）并写入 `totalFindings`；
 *   4. §4.5 历史表去掉不存在的「阻断」档，新增「总数」列（缺失显示 —，不显示 0）；
 *   5. §4.4 「启发式检查」说明区：常驻一句话 + 其余可展开（默认收起），规则清单也折叠；
 *   6. §4.6 局部刷新**不清空旧结果**（不再 `setData(null)`），旧结果 + 顶部 `BusyProgress`。
 *
 * 1.34.0 / W8 **第 1 轮评审修复（t14）** 又改了五处（编号对应 `.reviews/password-manager/`）：
 *   ① `detailCut` / `hitCap` 改按**数值**判（`findings.length < totalFindings`），不再只看
 *      `truncatedReason === 'findings'` —— 原因优先级让 `suppressed` 盖住 `findings` 时，
 *      旧写法会让面板写「命中 2500」、分页条写「共 2000」且无解释（C1 / R-01）；
 *   ② 所有 `totalFindings` 显示走 `numOrDash`（缺失 ⇒ `—`），不变量校验只在两边都是有限数时做
 *      （旧后端下不再渲染「命中 NaN 条」、不再假红，C3 / R-07 / R-08）；
 *   ③ **落库不再写 findings**（契约 C-29 v17 / S-01、S-02）：明细只在内存，历史只留计数；
 *   ④ 历史表新增「运行条件」列（中文口径，含旧记录「明细仅 300 条、总数未知」，R-04）；
 *   ⑤ 并入后端的 `skippedByGuard`（目录/产物守卫跳过数，S-03）到「本次运行条件」那一条里。
 */

import { useState, useEffect } from 'react';
import { Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { trimToCaps, capsOf, trimNotice } from '../../utils/collectionTrim';
import { useCollection } from '../../hooks/useCollection';
import { newId } from '../../utils/id';
import { formatRecent } from '../../utils/time';
import { FindingsTable } from './FindingsTable';
import {
  readHistoryCounts, SEVERITY_ORDER, SEVERITY_TEXT, FINDINGS_CAP,
  auditConditionText, scanCutState, scanCountsMismatch, conditionTone, numOrDash, historyConditionText,
} from './scanModel';
import type { SeverityKey, ScanRunData, ScanFinding, ScanPack, ScanRunRecord } from './scanModel';

/* ================================================================
   页签①：代码体检
   ================================================================ */

/**
 * `SCAN_MAX_FILES` / `SCAN_MAX_DEPTH` / `SCAN_TIMEOUT_MS` / `MAX_HITS_PER_RULE` **已下沉到 scanModel.ts**：
 * 运行条件的文案全在 `auditConditionText` 里拼，常量必须跟文案住在一起 ——
 * 否则「改一个数字忘另一处」必然再次发生（评审 C10 已登记为已知缺口）。
 */

/**
 * 三档严重度 → `.dev-tag` 变体。
 *
 * 三档是**结论**，所以不占两个中性档：`is-unknown` 只给「无法判定」、`is-unverified` 只给
 * 「还没有结论 / 中性运行信息」（`redesign.css:8799-8832` 的语义）。改前四档全用 `is-unknown`，
 * 等于把「高/中/低」说成「无法判定」，与视觉口径 §4「三态标签」冲突。
 */
const SEVERITY_CLS: Record<SeverityKey, string> = { high: 'is-fail', medium: 'is-heur', low: 'is-ok' };

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
    // 刻意**不** setData(null)：局部刷新保留旧结果 + 顶部 BusyProgress。
    // 清空会让用户以为「第二次扫出来是空的」（视觉口径 §4「空态/加载」的现存违规点）。
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
      // 官方类型 [C-46]：r.data 已经是 ScanRunResult。
      // 「success 但没有 data」= 主进程版本不匹配：**不写空记录、也不清空旧结果**，直接报错。
      const d = r.data;
      if (!d) {
        setErr('扫描完成但没拿到结果数据（主进程返回为空）：重试一次，仍为空请把这条报给开发');
        return;
      }
      setData(d);

      // 落一条 scanRuns：**先裁剪再写**（[C-24]/[C-25]），dropped 必须说出来
      const truncated = !!d.truncated;
      const truncatedReason = d.truncatedReason;
      /**
       * `counts` 取**后端同源**那一份，不再由明细现算（`[C-30]` 第 2 条 / v16）。
       * 万一老主进程没给，三键 0 兜住（避免把 `undefined` 写进 vault）；界面会因不变量「不可校验」
       * 而**不报警**（不再假红，见下面的 invariantsCheckable）。
       */
      const counts = d.counts ?? { high: 0, medium: 0, low: 0 };
      /**
       * `totalFindings` 缺失时**不写这个键**，绝不固化成 0（评审 R-07）：
       * `Number(x) || 0` 会把「不知道」写成 0，历史页于是显示 0 而不是 `—` ——
       * 而 0 会被读成「那次一条都没命中」，与「不知道」是两件事。
       */
      const totalRaw = typeof d.totalFindings === 'number' && Number.isFinite(d.totalFindings)
        ? d.totalFindings
        : NaN;
      /**
       * **v17 起明细不落库**（契约 C-29 v17 / 评审 S-01）：`sec-*` 规则命中的那一行本身就是
       * 明文口令/token，而历史页**没有任何读明细的入口** → 存而不用，还随整库备份与异地镜像外发。
       * 于是记录只留计数与运行条件；当次明细只活在内存（FindingsTable 直接读 `data.findings`）。
       */
      const record: ScanRunRecord = {
        id: newId('run-'),
        at: new Date().toISOString(),
        root: d.root || root,
        pack: 'audit',
        files: Number(d.files) || 0,
        ...(typeof d.bytes === 'number' ? { bytes: d.bytes } : {}),
        // [C-54] 写入时必填：取当次返回的 skippedSymlinks
        skippedSymlinks: Number(d.skippedSymlinks) || 0,
        truncated,
        ...(truncatedReason ? { truncatedReason } : {}),
        counts,
        ...(Number.isFinite(totalRaw) ? { totalFindings: totalRaw } : {}),
        ruleIds,
        ...(typeof d.ms === 'number' ? { ms: d.ms } : {}),
      };
      const caps = capsOf('scanRuns');
      const cut = trimToCaps([record, ...runs], caps, { timeOf: (x) => (x as ScanRunRecord).at });
      const wr = await saveRuns(cut.items);
      if (!wr.success) { addToast(wr.error || '保存体检记录失败', 'error'); return; }
      // notice 只承担「历史被裁剪」这类**落库**提示；截断/折叠由结果区的常驻提示条说（§4.6）
      if (cut.dropped) setNotice(trimNotice(cut.dropped));
      /**
       * toast：总数已知就**不许**再说「实际可能更多」（`[C-30]` v16）；判据同样走**数值**
       * （`findings.length < totalFindings`），不认单一 reason（评审 C1）。
       * 总数缺失（旧主进程）时显示 `—` 并直说「未回传总数」，不渲染 NaN（评审 C3）。
       */
      const detailCutNow = Number.isFinite(totalRaw) && (d.findings || []).length < totalRaw;
      addToast(
        detailCutNow
          ? `体检完成：命中 ${numOrDash(totalRaw)} 条（明细展示前 ${FINDINGS_CAP} 条），扫了 ${record.files} 个文件`
          : `体检完成：命中 ${numOrDash(totalRaw)} 条，扫了 ${record.files} 个文件${Number.isFinite(totalRaw) ? '' : '（旧版主进程未回传总数）'}`,
        Number.isFinite(totalRaw) && totalRaw > 0 ? 'info' : 'success',
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
    // `f.file` 是**相对本次扫描 root 的路径**，必须把 root 一起传：
    // 主进程按 root 拼绝对路径（打包版的 cwd 不是仓库根，靠 cwd 解析必然失败，S-06）
    const scanRoot = data?.root || '';
    if (!scanRoot) { addToast('还没扫描过，无法定位（请先跑一次体检）', 'error'); return; }
    const r = await window.electronAPI.scanReveal({ root: scanRoot, file: f.file, line: f.line });
    if (!r.success) { addToast(r.error || '定位失败', 'error'); return; }
    setRevealed(`${f.file}:${f.line}`);
  };

  const findings = data?.findings || [];
  const scanned = Number(data?.files) || 0;
  const skipped = Math.max(0, Math.floor(Number(data?.skippedSymlinks ?? 0) || 0));
  /**
   * 被「同一文件同一规则最多 MAX_HITS_PER_RULE 条」折叠掉的命中数。
   * 与明细到顶是**两件事**：明细到顶是「总数已知、只给前 2000 条明细」；这里是「知道确切数字，只是没展示」。
   * 旧主进程不返回该字段 → 取 0 → 不显示（不制造「0 条未展示」的噪音）。
   */
  const suppressed = Math.max(0, Math.floor(Number(data?.suppressed ?? 0) || 0));
  /**
   * 被目录/产物守卫跳过的条目数（评审 S-03：`coverage` 目录与 `*.min.js`/`app.asar.unpacked`
   * 的守卫是**静默生效**的，不计这笔数用户会把「0 命中」当成「干净」）。
   *
   * `types.ts` 的 `ScanRunResult` 还没有这个字段（该文件不在本片 inScope），所以按
   * 「可选 + 缺失不显示」读取：读不到就当 0，不显示、不崩、不编数。
   */
  const skippedByGuard = (() => {
    const raw = (data as unknown as Record<string, unknown> | null | undefined)?.skippedByGuard;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  })();
  /**
   * 摘要口径（`[C-30]` v16）：**总数与分布取 `counts` + `totalFindings`，明细取 `findings`**。
   *
   * `totalFindings` 缺失（旧主进程 / 降级运行）时是 `NaN`：界面一律走 `numOrDash` 显示 `—`，
   * 且**不参与任何断言式比较** —— 旧写法 `Number(undefined)` 会渲染「命中 NaN 条」并触发
   * 「后端计数与总数对不上」的假红（评审 C3 / R-08）。
   */
  const counts = data?.counts;
  const totalFindings = typeof data?.totalFindings === 'number' && Number.isFinite(data.totalFindings)
    ? data.totalFindings
    : NaN;
  /**
   * 两条可断言不变量（`[C-30]` 第 2 条）—— **只在两边都是有限数时才算**：
   *   ① `counts.high + counts.medium + counts.low === totalFindings`
   *   ② `findings.length <= totalFindings`（未到明细上限时两者取等）
   * 实现在 `scanModel.scanCountsMismatch`（纯函数，有单测）：缺失 `totalFindings`（旧主进程）时
   * 返回 false = 不报警 —— 绝不把「不知道」报成一个不存在的问题（评审 R-08）。
   */
  const serverMismatch = !!data && scanCountsMismatch(counts, totalFindings, findings.length);

  /* ---- 截断 / 折叠的三个判据：唯一实现在 scanModel.scanCutState（纯函数，有单测） ----
     `coverageCut` = 真有文件没扫全 → 只有这里才允许说「命中数可能偏少」；
     `detailCut`   = **按数值判**「明细没给全」→ 说确切数字，不许说「偏少」（评审 C1 / R-01）；
     `folded`      = 同文件同规则折叠 → 说「不是没扫到」。 */
  const cut = scanCutState({
    truncated: !!data?.truncated,
    reason: data?.truncatedReason,
    suppressed,
    findingsLength: findings.length,
    totalFindings,
  });
  const { coverageCut, detailCut } = cut;
  /** 面板 meta 用的同一判据（保留旧名：meta 与提示条共用 detailCut，避免两处判据漂移） */
  const hitCap = detailCut;

  /**
   * 同档 ≥2 条合并成一条、用「；」连接、数字一个不少（视觉口径 §4.3；常驻区 ≤4 行）。
   * 文案的唯一实现在 `scanModel.auditConditionText` —— 页面只负责渲染，不在这里拼句子，
   * 这样「六分流」的口径能被单测直接锁住（t14）。
   */
  const legacyNoTotalLine = data && !Number.isFinite(totalFindings)
    ? '旧版主进程未回传命中总数：下面只展示已返回的明细条数，总数未知'
    : '';
  const conditionLine = [
    auditConditionText({
      truncated: !!data?.truncated,
      reason: data?.truncatedReason,
      suppressed,
      findingsLength: findings.length,
      totalFindings,
      files: scanned,
      skippedSymlinks: skipped,
      skippedByGuard,
    }),
    legacyNoTotalLine,
  ].filter(Boolean).join('；');

  /** 三档取值：缺失显示 `—`（禁 `counts[k] || 0` —— 兜 0 正是 t46「中 0」的成因） */
  const countOf = (k: SeverityKey): number | string => (counts && typeof counts[k] === 'number' ? counts[k] : '—');

  const ruleCount = packs.reduce((s, p) => s + p.rules.length, 0);

  return (
    <div>
      {busy && <BusyProgress active label="扫描中…（可随时取消）" />}

      {/* 常驻第 1 位（视觉口径 §4.3 位次 1）：口径句，**不可折叠** —— 用户能否读懂「启发式命中」
          这个标签全靠它。三件事一句说完：会误报漏报 / 只读不写文件 / 命中不出本机。 */}
      <div className="dev-banner is-info">
        <Icons.bug size={14} />
        <div className="text-sm">
          启发式检查，不是语法树分析：<strong>可能误报，也会漏报</strong>；只读不写你的文件；
          <strong>命中明细只在本机内存</strong>，不进导出、不写日志，历史只留计数。
        </div>
      </div>

      <Panel
        title="① 取数"
        meta={data ? `${scanned} 个文件 · ${data.ms ?? 0} ms` : undefined}
        tools={
          <div className="tool-inline">
            <button className="btn btn-secondary btn-sm" onClick={() => void pickRoot()} disabled={busy}>
              <Icons.folder size={13} /> 选择目录
            </button>
            {busy
              ? <button className="btn btn-secondary btn-sm" onClick={() => void cancel()}>取消扫描</button>
              : <button className="btn btn-primary btn-sm" onClick={() => void run()}><Icons.search size={13} /> 开始体检</button>}
          </div>
        }
      >
        <Field label="代码目录">
          <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="先用「选择目录」挑一个" />
        </Field>

        {rulesErr && <div className="dev-banner is-error mt-8" role="alert"><div className="text-sm">{rulesErr}</div></div>}
        {err && <div className="dev-banner is-error mt-8" role="alert"><Icons.bug size={14} /><div className="text-sm">{err}</div></div>}
        {notice && <div className="dev-banner is-warn mt-8" role="status"><Icons.clock size={14} /><div className="text-sm">{notice}</div></div>}
      </Panel>

      {/* 规则清单折叠（视觉口径 §4.3「可展开只给证据与长内容」）：19 条规则会占掉整屏，
          把结果表推到折线以下。标题里给条数与「默认全选」，不用点开也知道现状。 */}
      <Panel collapsible defaultOpen={false} title={`规则（${ruleCount} 条，默认全选）`} meta={`已勾 ${ruleIds.length} 条`}>
        {packs.map((p) => (
          <div key={p.id} className="mb-8">
            <div className="text-sm mb-8"><span className="dev-tag is-unverified">{p.label}</span></div>
            {p.rules.map((rule) => {
              const on = ruleIds.includes(rule.id);
              return (
                <label key={rule.id} className="text-sm tool-inline" title={rule.desc}>
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
        ))}
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
          <Panel title="② 结果" meta={hitCap ? `命中 ${numOrDash(totalFindings)} 条 · 明细前 ${FINDINGS_CAP}` : `命中 ${numOrDash(totalFindings)} 条`}>
            {/* 摘要：三档（当次扫描**不渲染** other 档 —— 那是历史老记录的兼容位）+ 文件数/跳过数 */}
            <div className="tool-inline mb-8">
              {SEVERITY_ORDER.map((k) => (
                <span key={k} className={`dev-tag ${SEVERITY_CLS[k]}`}>
                  {SEVERITY_TEXT[k]} {countOf(k)}
                </span>
              ))}
              <span className="dev-tag is-unverified">
                已扫 {scanned} 个文件
                {skipped > 0 ? `，跳过 ${skipped} 个符号链接` : '（未跳过符号链接）'}
              </span>
              <span className="dev-tag is-heur">启发式命中</span>
            </div>

            {/* 常驻第 3 位：本次运行条件**合并成一条**（同档 ≥2 条用「；」连接、数字一个不少）。
                语气档由 `scanModel.conditionTone` 统一决定：只有 coverageCut（真有文件没扫全）才是
                .is-warn；明细到顶 / 同类折叠 / 跳过符号链接 / 守卫跳过条目这四类都在说「这次扫的范围」，
                一律 .is-info —— 别把「说清范围」混进「承认漏扫」那一档（队长 t14 追加要求 + 评审 C2）。
                「可展开」不给结论与运行条件（把截断折叠起来 = 隐藏「这次扫描不完整」）。 */}
            {conditionLine && (
              <div className={`dev-banner ${conditionTone(cut)}`} role="status">
                <Icons.bug size={14} />
                <div className="text-sm">{conditionLine}</div>
              </div>
            )}

            {/* [C-30] 不变量（**只在两边都是有限数时校验**，缺失不假红 —— 评审 R-08）：
                计数合计对不上总数、或明细条数超过总数 → 明说，不拿一方盖另一方 */}
            {serverMismatch && (
              <div className="dev-banner is-error" role="alert">
                <Icons.bug size={14} />
                <div className="text-sm">
                  后端计数与总数对不上（高 {String(countOf('high'))} + 中 {String(countOf('medium'))} + 低 {String(countOf('low'))}
                  {' ≠ '}总数 {numOrDash(totalFindings)}，明细 {findings.length} 条）
                  —— 请把这条报给开发；本次结果已按原样落库，不静默修正。
                </div>
              </div>
            )}

            {revealed && <div className="text-sm text-muted mb-8">已在文件管理器中定位：{revealed}</div>}

            <FindingsTable findings={findings} onReveal={(f) => void reveal(f)} />
          </Panel>
        )}

      <Panel title="③ 历史记录" meta={`${runs.length}/20`}>
        {runs.length === 0
          ? <div className="text-sm text-muted">还没有历史记录。跑一次体检就会在这里留一条（单集合最多 20 条，超出丢最旧）。</div>
          : (
            <div className="dev-scroll is-short">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 100 }}>时间</th>
                    <th scope="col">目录</th>
                    <th scope="col" style={{ width: 70 }}>文件数</th>
                    <th scope="col" style={{ width: 110 }}>符号链接</th>
                    {/* 三档（v14 起只有 high/medium/low）：v13 之前的「阻断」档已不存在，留着等于
                        向用户显示一个后端永远不会产出的级别（契约 §4.5）。 */}
                    <th scope="col" style={{ width: 160 }}>命中（高/中/低）</th>
                    <th scope="col" style={{ width: 70 }}>总数</th>
                    {/* R-04：记录里本来就有 truncated / truncatedReason，历史表却不显示 →
                        等于把「这次扫描不完整」的历史痕迹藏起来。这里用中文口径补上（不外露枚举名）。 */}
                    <th scope="col" style={{ width: 190 }}>运行条件</th>
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
                      <td>
                        {/* [C-29] v16：v16 之前的记录没有 totalFindings，缺失显示 — 而不是 0 ——
                            0 会被读成「那次一条都没命中」，与「不知道」是两件事（评审 R-07 的读取侧） */}
                        {numOrDash(r.totalFindings)}
                      </td>
                      <td>
                        {/* R-04：truncated/truncatedReason 转中文；旧记录并列注明「明细仅 300 条、总数未知」；
                            [C-54] 跳过符号链接数 >0 时同样不折叠。全文案由 scanModel.historyConditionText 产出。 */}
                        <span className="text-sm text-muted">{historyConditionText(r)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>

      {/* 常驻第 4 位：其余说明**可展开**（默认收起）。结论与运行条件在上面常驻，不在这里。 */}
      <Panel collapsible defaultOpen={false} title="说明：怎么读这些结论">
        <div className="text-sm text-muted">
          <p>
            <strong>误报与漏报</strong>：规则是正则启发式，不是语法树分析。<code>ui-no-timeout</code> 这类只能看
            <strong>本文件内</strong>有没有超时——写在基类或全局配置里就会漏；反过来，注释掉的代码已被剥离，不会命中。
          </p>
          <p>
            <strong>只读</strong>：整个流程只有目录遍历 + 正则匹配，不改你的文件、不落盘、不需要网络。
          </p>
          <p>
            <strong>命中明细只在内存</strong>：当次明细（含命中行原文）不落库、不进导出、不写日志；
            「历史记录」只留计数（高/中/低、总数、运行条件）。写库前明细就被丢掉了。
          </p>
          <p>
            <strong>计数会随库走</strong>：历史里的计数存在加密库的 <code>scanRuns</code> 集合里，
            所以它跟着整库备份 / 异地镜像一起复制 —— 明细不跟着走，原因同上。
          </p>
          <p>
            <strong>想知道「为什么这条没报」</strong>：展开上面的「规则」清单，悬停规则名可看它的判定说明。
          </p>
        </div>
      </Panel>
    </div>
  );
}