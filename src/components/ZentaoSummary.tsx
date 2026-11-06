import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ZentaoConfig, ZentaoProject, ZentaoBug } from '../types';
import { useZentaoStore } from '../store/zentaoStore';
import { Panel, Empty, Icons, SearchBox, IconBtn, Pill } from './ui';
import { Modal } from './Modal';
import { PersonPicker } from './PersonPicker';
import { formatHm } from '../utils/time';
import {
  summarize, summaryTo, projectToText, personsToText, severityRows, personOf,
  daysAgoDay, dailyNew, parseCutoff, fmtCutoff, statWindowOf,
  periodOf, growthOf, splitSecurity, dailyReportText,
  type ProjectSummary, type SummaryFormat, type ReportInput,
} from '../utils/bugSummary';
import { pushHistory, prevOf, clearHistory, type SumSnapshot } from '../utils/sumHistory';

/** 进入页面自动拉一次（每个会话只自动拉一次，避免来回切 tab 反复打禅道） */
let autoPulledOnce = false;

/** 缓存有效期（与主进程 ZT_SUM_TTL 一致）：超过这个时间就提示「数据可能已过期」 */
const TTL_MS = 10 * 60 * 1000;

const SINCE_OPTIONS: { v: number; label: string }[] = [
  { v: 0, label: '全部时间' },
  { v: 7, label: '近 7 天' },
  { v: 30, label: '近 30 天' },
  { v: 90, label: '近 90 天' },
];

type CopyFormat = SummaryFormat | 'daily';

const COPY_FORMATS: { v: CopyFormat; label: string; hint: string }[] = [
  { v: 'daily', label: '日报文本', hint: '跟定时任务一样的整段话' },
  { v: 'text', label: '结构化文本', hint: '按项目分行，便于对照' },
  { v: 'markdown', label: 'Markdown', hint: '贴飞书 / 企微 保持表格' },
  { v: 'csv', label: 'CSV', hint: '粘到 Excel 自动分列' },
];

type TabId = 'proj' | 'person' | 'daily';

const pad2 = (n: number) => String(n).padStart(2, '0');
const nowStamp = (d: Date = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * 缺陷汇总 tab（日报口径）：
 * 1. 多选项目，一次拉全部 Bug（含已关闭）
 * 2. 概览：总数 / 已修复 / 未修复 / 待验证 / 修复率 + 本期新增·修复·关闭 + 总数环比 + 7 日趋势
 * 3. 明细：按项目（可展开模块）/ 按人员（可下钻）/ 日报预览
 * 4. 一键复制（日报 / 结构化 / Markdown / CSV）或导出
 *
 * 「本期」的窗口边界固定用换日时间（默认 17:30），不跟运行时刻走 ——
 * 领导随时点开都是同一个区间；只有「较上次统计」的基准取历史快照。
 */
export function ZentaoSummary({
  projects, getCfg, ready, onError, sharedBugs, sharedModules, scopeProjectIds, onRefresh,
}: {
  projects: ZentaoProject[];
  getCfg: () => ZentaoConfig;
  ready: () => boolean;
  onError: (msg: string) => void;
  /** 页面已按「当前项目」拉好的全量 Bug：有它就本地统计，不再请求禅道 */
  sharedBugs?: ZentaoBug[];
  sharedModules?: Record<string, Record<string, string>>;
  scopeProjectIds?: string[];
  /** 宿主提供的「按当前项目拉取最新」，三个 tab 共用同一个动作 */
  onRefresh?: () => void;
}) {
  const scopeIds = scopeProjectIds || [];
  const useShared = scopeIds.length > 0 && Array.isArray(sharedBugs);
  const sumBugs = useZentaoStore(s => s.sumBugs);
  const productIds = useZentaoStore(s => s.sumProductIds);
  const dataIds = useZentaoStore(s => s.sumDataIds);
  const exclude = useZentaoStore(s => s.sumExclude);
  const testers = useZentaoStore(s => s.sumTesters);
  const security = useZentaoStore(s => s.sumSecurity);
  const sinceDays = useZentaoStore(s => s.sumSince);
  const dayCutoff = useZentaoStore(s => s.sumDayCutoff);
  const format: CopyFormat = useZentaoStore(s => s.sumFormat);
  const fetchedAt = useZentaoStore(s => s.sumFetchedAt);
  const setSummary = useZentaoStore(s => s.setSummary);
  const setProductIds = useZentaoStore(s => s.setSumProductIds);
  const setExclude = useZentaoStore(s => s.setSumExclude);
  const setTesters = useZentaoStore(s => s.setSumTesters);
  const setSecurity = useZentaoStore(s => s.setSumSecurity);
  const setSinceDays = useZentaoStore(s => s.setSumSince);
  const setDayCutoff = useZentaoStore(s => s.setSumDayCutoff);
  const setFormat = useZentaoStore(s => s.setSumFormat);
  const saveSnapshot = useZentaoStore(s => s.saveSumSnapshot);

  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>('proj');
  const [advanced, setAdvanced] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [pickQuery, setPickQuery] = useState('');
  const [personOpen, setPersonOpen] = useState(false);
  const [personDraft, setPersonDraft] = useState<string[]>([]);
  const [personQuery, setPersonQuery] = useState('');
  const [drill, setDrill] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [personAll, setPersonAll] = useState(false);
  const [tip, setTip] = useState('');
  const [rateBasis, setRateBasis] = useState<'all' | 'open'>('all');
  const [copyOpen, setCopyOpen] = useState(false);
  const copyBtnRef = useRef<HTMLButtonElement>(null);
  const [withModules, setWithModules] = useState(true);
  const [histTick, setHistTick] = useState(0);
  const [prev, setPrev] = useState<SumSnapshot | null>(null);

  const flash = (msg: string) => { setTip(msg); setTimeout(() => setTip(''), 2400); };

  const toggleCopyMenu = () => setCopyOpen(v => !v);

  // 点别处 / Esc 关掉复制菜单
  useEffect(() => {
    if (!copyOpen) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.zt-sum-menu') || t.closest('.zt-sum-menu-btn')) return;
      setCopyOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCopyOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [copyOpen]);

  // fetchedAt 变了就重算「今天」，让「近 7 天」「数据过期」跟着刷新
  const now = useMemo(() => new Date(), [fetchedAt]);
  const since = sinceDays > 0 ? daysAgoDay(sinceDays, now) : '';
  const sinceLabel = sinceDays > 0 ? `${SINCE_OPTIONS.find(o => o.v === sinceDays)?.label}（${since} 起提交）` : '';

  const productNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) {
      m[String(p.id)] = p.programName ? `${p.programName} / ${p.name}` : p.name;
    }
    return m;
  }, [projects]);

  /* ---------- 统计日窗口（固定边界，不跟运行时刻走） ---------- */
  const cutoffMin = useMemo(() => parseCutoff(dayCutoff), [dayCutoff]);
  const daily = useMemo(
    () => dailyNew(sumBugs, { cutoffMin, days: 7, now, since, ignored: security }),
    [sumBugs, cutoffMin, now, since, security],
  );
  const currentDay = daily.currentDay;
  const [winStart, winEnd] = useMemo(() => statWindowOf(currentDay, cutoffMin), [currentDay, cutoffMin]);

  /* ---------- 安全问题剔除（单独统计，不计入功能缺陷） ---------- */
  const { bugs: funcBugs, security: secTotal } = useMemo(
    () => splitSecurity(sumBugs, security),
    [sumBugs, security],
  );

  // 统计结果（排除人员 / 时间窗改了立刻重算，不用重新拉数据）
  const result = useMemo(
    () => summarize(funcBugs, { productIds, productNames, exclude, since, now }),
    [funcBugs, productIds, productNames, exclude, since, now],
  );

  // 人员候选：不带排除口径算一遍，否则被排除的人会从候选里消失，没法再点回来
  const allPersons = useMemo(
    () => summarize(funcBugs, { productIds, productNames, exclude: [], since, now }).persons,
    [funcBugs, productIds, productNames, since, now],
  );

  const assignedTotal = useMemo(() => result.persons.reduce((s, p) => s + p.total, 0), [result.persons]);
  // 人员表默认只列前 12 人（一个项目动辄二三十人，全列出来表格太长）
  const shownPersons = personAll ? result.persons : result.persons.slice(0, 12);
  const sevRows = useMemo(() => severityRows(result.severity), [result.severity]);

  /* ---------- 本期（固定窗口）：新增 / 修复 / 关闭 ---------- */
  const period = useMemo(() => periodOf(funcBugs, winStart, winEnd), [funcBugs, winStart, winEnd]);
  const atNow = nowStamp(now);

  /* ---------- 总数环比（基准 = 上一个统计日的历史快照） ---------- */
  const histKey = `${productIds.slice().sort().join(',')}|${sinceDays}`;
  useEffect(() => {
    setPrev(prevOf(histKey, currentDay));
  }, [histKey, currentDay, histTick, result.overall.total]);

  const growth = useMemo(
    () => (prev ? growthOf(prev.at, prev.total, atNow, result.overall.total) : null),
    [prev, atNow, result.overall.total],
  );

  const selectedProjects = useMemo(
    () => productIds.map(id => projects.find(p => String(p.id) === id)).filter(Boolean) as ZentaoProject[],
    [productIds, projects],
  );

  const stale = dataIds.length > 0
    && (dataIds.slice().sort().join(',') !== productIds.slice().sort().join(','));

  // 数据超过缓存有效期 → 提示可能已过期（别人改了禅道，这里还是旧数字）
  const expired = !!fetchedAt && (now.getTime() - new Date(fetchedAt).getTime()) > TTL_MS;

  const pull = async (force = false) => {
    if (!ready()) return;
    if (!productIds.length) {
      onError('请先选择要汇总的项目');
      setDraft([]);
      setPickQuery('');
      setPickerOpen(true);
      return;
    }
    onError('');
    setCopyOpen(false);
    // 共享模式：直接用页面已拉取的同一份项目数据，零网络请求
    // 即使没拿到共享数据，也只查当前项目，绝不退回「全部项目」
    const ids = scopeIds.length ? scopeIds : productIds;
    const res = useShared
      ? { success: true, data: sharedBugs || [], modules: sharedModules || {}, errors: [], error: '', cached: false, ageMs: 0 }
      : await (async () => { setBusy(true); const r = await window.electronAPI.zentaoSummary(getCfg(), ids, force); setBusy(false); return r; })();
    if (res.success && res.data) {
      setSummary(res.data, res.modules || {}, productIds);
      const failed = res.errors || [];
      if (failed.length) onError(`部分项目拉取失败：${failed.slice(0, 3).join('；')}`);

      // 记历史基准：同一天重跑会覆盖当天那条（避免环比退化成几小时）
      const fresh = summarize(res.data, { productIds, productNames, exclude, since, now: new Date() });
      const day = dailyNew(res.data, { cutoffMin, days: 2, now: new Date(), ignored: security }).currentDay;
      pushHistory({
        key: histKey,
        at: nowStamp(),
        day,
        total: fresh.overall.total,
        fixed: fresh.overall.fixed,
        active: fresh.overall.active,
        resolved: fresh.overall.resolved,
        closed: fresh.overall.closed,
        security: splitSecurity(res.data, security).security,
      });
      saveSnapshot({
        key: histKey,
        at: new Date().toISOString(),
        total: fresh.overall.total,
        fixed: fresh.overall.fixed,
        active: fresh.overall.active,
        resolved: fresh.overall.resolved,
        closed: fresh.overall.closed,
      });
      setHistTick(t => t + 1);

      flash(useShared
        ? `已按当前项目统计 ${res.data.length} 条缺陷`
        : res.cached
          ? `命中缓存（${Math.max(1, Math.round((res.ageMs || 0) / 60000))} 分钟前）`
          : `已拉取 ${res.data.length} 条缺陷`);
    } else {
      onError(res.error || '拉取失败');
    }
  };

  useEffect(() => {
    if (autoPulledOnce || busy) return;
    if (!productIds.length) return;
    if (sumBugs.length > 0 && !useShared) return;
    autoPulledOnce = true;
    void pull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPicker = () => {
    setDraft(productIds);
    setPickQuery('');
    setPickerOpen(true);
  };

  const filtered = useMemo(() => {
    const q = pickQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
      String(p.name || '').toLowerCase().includes(q)
      || String(p.programName || '').toLowerCase().includes(q)
      || String(p.id).includes(q));
  }, [projects, pickQuery]);

  const toggleExpand = (id: string) => {
    setExpanded(prevSet => {
      const next = new Set(prevSet);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /* ---------------- 复制 / 导出 ---------------- */

  const excludedAreTesters = exclude.length > 0 && exclude.every(n => testers.includes(n));

  /** 每个项目的日报段落输入 */
  const reportInputs: ReportInput[] = useMemo(() => result.projects.map(p => {
    const pbugs = funcBugs.filter(b => String(b.product) === p.id);
    // 日报里用产品短名（不带项目集前缀），跟定时任务的标题一致
    const short = projects.find(x => String(x.id) === p.id)?.name || p.name;
    return {
      name: short,
      stat: p.stat,
      period: periodOf(pbugs, winStart, winEnd),
      growth: result.projects.length === 1 ? growth : null,
      persons: p.persons,
      excludedCount: exclude.length,
      excludedAreTesters,
      // 模块平铺到一句话里，用最后一段短名，否则「内控管理/…/添置资产」会把整段撑爆
      modules: p.modules.map(m => ({
        name: String(m.name).split('/').pop() || m.name,
        total: m.total,
        active: m.active,
      })),
      security: splitSecurity(pbugs, security).security,
    };
  }), [result.projects, funcBugs, winStart, winEnd, growth, exclude.length, excludedAreTesters, security]);

  const buildText = (fmt: CopyFormat) => {
    if (fmt === 'daily') return dailyReportText(reportInputs, atNow);
    return summaryTo(fmt, result.projects, result.overall, {
      exclude,
      persons: result.persons,
      unassigned: result.unassigned,
      skipped: result.skipped,
      withModules,
      sinceLabel,
    });
  };

  const copyAll = async (fmt: CopyFormat = format) => {
    if (result.projects.length === 0) return;
    setCopyOpen(false);
    setFormat(fmt);
    try {
      await navigator.clipboard.writeText(buildText(fmt));
      flash(fmt === 'daily' ? '已复制日报' : fmt === 'text' ? '已复制汇总' : fmt === 'markdown' ? '已复制 Markdown' : '已复制 CSV');
    } catch {
      flash('复制失败：窗口没有焦点，点一下窗口再试');
    }
  };

  const exportCsv = async () => {
    if (result.projects.length === 0) return;
    setCopyOpen(false);
    const r = await window.electronAPI.saveText(
      buildText('csv'),
      `缺陷汇总-${new Date().toISOString().slice(0, 10)}.csv`,
      [{ name: 'CSV', extensions: ['csv'] }],
    );
    if (r.success) flash('已导出 CSV');
    else if (!r.canceled) flash(r.error || '导出失败');
  };

  const personsText = () => personsToText(result.persons, {
    unassigned: result.unassigned,
    closedCount: result.overall.closed,
    exclude,
    skipped: result.skipped,
  });

  const copyPersons = async () => {
    try {
      await navigator.clipboard.writeText(personsText());
      flash('已复制人员分布');
    } catch {
      flash('复制失败：窗口没有焦点，点一下窗口再试');
    }
  };

  const copyOne = async (p: ProjectSummary) => {
    try {
      await navigator.clipboard.writeText(projectToText(p));
      flash(`已复制「${p.name}」`);
    } catch {
      flash('复制失败：窗口没有焦点，点一下窗口再试');
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(dailyReportText(reportInputs, atNow));
      flash('已复制日报');
    } catch {
      flash('复制失败：窗口没有焦点，点一下窗口再试');
    }
  };

  /* ---------------- 不计入人员表的人 ---------------- */

  const applyExclude = (names: string[]) => {
    const uniq = Array.from(new Set(names.map(s => String(s).trim()).filter(Boolean)));
    setExclude(uniq);
  };

  const togglePerson = (name: string) => {
    applyExclude(exclude.includes(name) ? exclude.filter(x => x !== name) : [...exclude, name]);
  };

  const toggleTester = (name: string) => {
    setTesters(testers.includes(name) ? testers.filter(x => x !== name) : [...testers, name]);
  };

  /** 当前项目缺陷的创建人（安全问题提交人的候选项，不掺指派人） */
  const creatorNames = useMemo(
    () => Array.from(new Set(sumBugs.map(b => String(b.openedBy || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [sumBugs],
  );

  const excludeTesters = () => {
    if (!testers.length) {
      openPersonPicker();
      flash('先把测试同学标成「测试」，再点这里一键排除');
      return;
    }
    applyExclude([...exclude, ...testers]);
    flash(`已排除 ${testers.length} 名测试人员`);
  };

  const openPersonPicker = () => {
    setPersonDraft(exclude);
    setPersonQuery('');
    setPersonOpen(true);
  };

  const filteredPersons = useMemo(() => {
    const q = personQuery.trim().toLowerCase();
    if (!q) return allPersons;
    return allPersons.filter(p => p.name.toLowerCase().includes(q));
  }, [allPersons, personQuery]);

  /* ---------------- 人员下钻 ---------------- */

  const drillBugs = useMemo(() => {
    if (!drill) return [];
    return funcBugs
      .filter(b => personOf(b) === drill)
      .filter(b => !since || String(b.openedDate || b.date || '').slice(0, 10) >= since)
      .sort((a, b) => Number(b.id) - Number(a.id));
  }, [drill, funcBugs, since]);

  const copyDrill = async () => {
    if (!drillBugs.length) return;
    const lines = drillBugs.map(b => {
      const st = b.status === 'active' ? '未修复' : b.status === 'resolved' ? '待验证' : String(b.status || '');
      return `#${b.id} ${b.title}（${st}${b.moduleName ? ` · ${b.moduleName}` : ''}）`;
    });
    try {
      await navigator.clipboard.writeText(`【${drill}】名下 ${drillBugs.length} 个未关闭缺陷：\n${lines.join('\n')}`);
      flash('已复制清单');
    } catch {
      flash('复制失败：窗口没有焦点，点一下窗口再试');
    }
  };

  const hasData = result.projects.length > 0 && sumBugs.length > 0;
  const rate = rateBasis === 'all' ? result.overall.rate : result.overall.openRate;
  const fixedInClosed = result.overall.closed > 0
    ? Math.round((result.overall.fixed / result.overall.closed) * 1000) / 10
    : 0;
  const reportText = reportInputs.length ? dailyReportText(reportInputs, atNow) : '';

  /* ================================================================ */

  return (
    <>
      {/* ---------- 统计范围：一行工具条，次要项收进「高级」 ---------- */}
      <section className="zt-sumbar">
        <div className="zt-sumbar-main">
          <div className="zt-sumbar-projects">
            <span className="zt-sumbar-label">项目</span>
            {scopeIds.length ? (
              <>
                {selectedProjects.map(p => (
                  <span key={p.id} className="zt-sum-chip">
                    <span className="zt-sum-chip-name" title={`#${p.id}`}>{p.name}</span>
                  </span>
                ))}
                <span className="zt-sumbar-hint">与页面顶部「当前项目」一致，切换只需操作一次</span>
              </>
            ) : (
              <>
                {selectedProjects.length === 0 && (
                  <span className="zt-sumbar-empty">还没选，点右侧「选择项目」可多选</span>
                )}
                {selectedProjects.map(p => (
                  <span key={p.id} className="zt-sum-chip">
                    <span className="zt-sum-chip-name" title={`#${p.id}`}>{p.name}</span>
                    <button title="移除" onClick={() => setProductIds(productIds.filter(id => id !== String(p.id)))}>
                      <Icons.close size={10} />
                    </button>
                  </span>
                ))}
                <button className="zt-sumbar-add" onClick={openPicker} title="选择要汇总的项目（可多选）">
                  <Icons.folder size={12} /> 选择项目
                </button>
                {selectedProjects.length > 1 && (
                  <button className="zt-sumbar-link" onClick={() => setProductIds([])}>清空</button>
                )}
              </>
            )}
          </div>

          <div className="zt-sumbar-actions">
            <select
              className="zt-sumbar-since"
              value={sinceDays}
              onChange={e => setSinceDays(Number(e.target.value))}
              title="只看这些天里新提交的缺陷（按提交时间筛选）"
            >
              {SINCE_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <label className="zt-sumbar-cutoff zt-sum-cutoff" title="每天几点换一天：默认 17:30，即「昨天 17:30 → 今天 17:30」算一个统计日">
              换日
              <input
                type="time"
                value={dayCutoff}
                onChange={e => setDayCutoff(e.target.value || '17:30')}
              />
            </label>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onRefresh ? onRefresh() : pull(true)}
              disabled={busy || !scopeIds.length}
              title="忽略 10 分钟缓存，按当前项目重新拉取最新缺陷，三个标签同步更新"
            >
              <Icons.refresh size={12} /> {busy ? '拉取中…' : '重新拉取'}
            </button>
          </div>
        </div>

        <div className="zt-sumbar-sub zt-sum-exclude">
          <span className="zt-sumbar-label">不计入人员表</span>
          {exclude.length === 0
            ? <span className="zt-sumbar-empty">未排除（一般把测试人员排掉，剩下的就是开发身上压着的）</span>
            : exclude.map(name => (
              <button key={name} className="zt-sum-person is-off" onClick={() => togglePerson(name)} title="点击恢复">
                {name}<Icons.close size={10} />
              </button>
            ))}
          <button className="zt-sumbar-link" onClick={openPersonPicker}>选择人员（{exclude.length}）</button>
          <button
            className="zt-sumbar-link"
            onClick={excludeTesters}
            title={testers.length ? `把标记为测试人员的 ${testers.length} 人一起排除` : '还没标记测试人员：点这里打开选人弹窗'}
          >
            排除测试人员{testers.length ? `（${testers.length}）` : ''}
          </button>
          {exclude.length > 0 && (
            <button className="zt-sumbar-link" onClick={() => applyExclude([])} title="把「不计入人员表」的名单清空">
              全部恢复
            </button>
          )}
          <span className="zt-sumbar-div" />
          <span className="zt-sumbar-label">测试人员</span>
          {testers.length === 0
            ? <span className="zt-sumbar-empty">未标记</span>
            : testers.map(name => (
              <button key={name} className="zt-sum-person is-test" onClick={() => toggleTester(name)} title="点击取消「测试」标记">
                {name}<Icons.close size={10} />
              </button>
            ))}
          <button className={`zt-sumbar-more${advanced ? ' is-on' : ''}`} onClick={() => setAdvanced(v => !v)}>
            {advanced ? '收起' : '更多设置'}
            <Icons.chevron size={11} />
          </button>
        </div>

        {advanced && (
          <div className="zt-sumbar-adv">
            <div className="zt-adv-row">
              <span className="zt-sumbar-label">安全问题提交人</span>
              <PersonPicker
                options={creatorNames}
                value={security}
                onChange={setSecurity}
                placeholder={`从当前项目 ${creatorNames.length} 位缺陷创建人中搜索选择`}
              />
              <span className="zt-adv-hint">这些人提交的算安全问题，单独统计、不计入功能缺陷</span>
            </div>
            <div className="zt-adv-row">
              <span className="zt-sumbar-label">口径</span>
              <span className="zt-adv-note">
                已修复 = 解决的 Bug（含已关闭里的）；未修复 = 仍在「激活」；待验证 = 「已解决」未关闭；
                修复率 = 已修复 ÷ 缺陷总数。「本期」按换日时间切分，边界固定，随时点开都是同一个区间；
                「较上次统计」取上一次拉取的快照（跨启动保留）。
              </span>
              <button
                className="zt-sumbar-link"
                onClick={() => { clearHistory(); setPrev(null); setHistTick(t => t + 1); flash('已清空历史基准，下次拉取将作为首次统计'); }}
                title="清掉本机的历史快照，下次拉取会显示「首次统计」"
              >
                清空历史基准
              </button>
            </div>
          </div>
        )}

      </section>

      {stale && (
        <div className="zt-banner is-warn">
          <Icons.bug size={13} />
          选择的项目已变，但下面的数字还是上次拉的那批 —— 点「拉取并汇总」更新（改排除人员 / 时间窗会实时重算，不用重拉）。
        </div>
      )}
      {expired && !stale && (
        <div className="zt-banner is-warn">
          <Icons.bug size={13} />
          数据是 {formatHm(fetchedAt)} 拉的，已超过 10 分钟缓存期，禅道里可能又变了 —— 点「刷新」拿最新。
        </div>
      )}

      {!hasData ? (
        <Panel>
          <Empty
            icon={<Icons.chart size={22} />}
            title={busy ? '正在拉取…' : productIds.length ? '还没有汇总数据' : '先选几个项目'}
            desc={productIds.length
              ? '点「拉取并汇总」，读取选中项目的全部缺陷（含已关闭），按日报口径统计'
              : '支持多选项目，一次看清每个项目还剩多少未修复、压在谁身上、今天新增了多少'}
            action={
              <button className="btn btn-primary btn-sm" onClick={() => onRefresh ? onRefresh() : (productIds.length ? pull(false) : openPicker())} disabled={busy}>
                {scopeIds.length || productIds.length ? '重新拉取' : '选择项目'}
              </button>
            }
          />
        </Panel>
      ) : (
        <>
          {/* ---------- 概览 ---------- */}
          <Panel
            title="概览"
            meta={`${result.projects.length} 个项目 · ${result.overall.total} 条${fetchedAt ? ` · ${formatHm(fetchedAt)} 拉取` : ''}`}
            tools={
              <div className="zt-filters zt-sum-copybar">
                {tip && <span className="zt-sum-tip">{tip}</span>}
                <span className="zt-sumbar-time">{currentDay.slice(5)} 统计日</span>
                <button className="btn btn-secondary btn-sm" onClick={() => copyAll()} title={`复制为${COPY_FORMATS.find(f => f.v === format)?.label || '日报文本'}`}>
                  <Icons.copy size={12} /> 一键复制
                </button>
                <button
                  ref={copyBtnRef}
                  className="btn btn-ghost btn-sm zt-sum-menu-btn"
                  onClick={toggleCopyMenu}
                  title="选择复制格式 / 导出"
                  aria-haspopup="menu"
                  aria-expanded={copyOpen}
                >
                  <Icons.chevron size={12} />
                </button>
                {copyOpen && (
                  <div className="zt-sum-menu" role="menu">
                    <div className="zt-sum-menu-title">复制为</div>
                    {COPY_FORMATS.map(f => (
                      <button
                        key={f.v}
                        className={`zt-sum-menu-item${format === f.v ? ' is-on' : ''}`}
                        onClick={() => copyAll(f.v)}
                        title={f.hint}
                      >
                        {f.label}
                        <span>{f.hint}</span>
                      </button>
                    ))}
                    <div className="zt-sum-menu-sep" />
                    <button className="zt-sum-menu-item" onClick={exportCsv}>
                      导出 CSV 文件
                      <span>存到本地，Excel 打开</span>
                    </button>
                    <div className="zt-sum-menu-sep" />
                    <label className="zt-sum-menu-check">
                      <input type="checkbox" checked={withModules} onChange={e => setWithModules(e.target.checked)} />
                      含模块明细
                    </label>
                  </div>
                )}
              </div>
            }
          >
            <div className="zt-sum-kpis">
              <SumCard label="缺陷总数" value={result.overall.total} tone="info" sub={`未关闭 ${result.overall.open}`} />
              <SumCard
                label="已修复"
                value={result.overall.fixed}
                tone="ok"
                sub={`占已关闭 ${fixedInClosed}%`}
                title={`已关闭 ${result.overall.closed} 条里有 ${result.overall.fixed} 条是「已修复」解决的`}
              />
              <SumCard label="未修复" value={result.overall.active} tone="bad" sub={`占未关闭 ${result.overall.open ? Math.round((result.overall.active / result.overall.open) * 1000) / 10 : 0}%`} />
              <SumCard label="待验证" value={result.overall.resolved} tone="warn" sub="已解决，等测试回归" />
              <SumCard
                label="今日新增"
                value={daily.today}
                tone={daily.delta > 0 ? 'bad' : daily.delta < 0 ? 'ok' : 'info'}
                sub={daily.delta === 0 ? '与昨日持平' : `较昨日 ${daily.delta > 0 ? '+' : ''}${daily.delta}`}
                title={`统计日「${currentDay}」= ${winStart} → ${winEnd}（昨日 ${daily.yesterday} 个）`}
              />
              <button
                className="zt-sum-card is-rate is-clickable"
                onClick={() => setRateBasis(v => (v === 'all' ? 'open' : 'all'))}
                title={rateBasis === 'all'
                  ? `已修复 ÷ 全部缺陷（${result.overall.fixed}/${result.overall.total}）· 点击换成「仅未关闭」口径`
                  : `未关闭里已修复的比例（${result.overall.fixedOpen}/${result.overall.open}）· 点击换回「全部」口径`}
              >
                <Ring value={rate} size={52} />
                <span className="zt-sum-card-body">
                  <span className="zt-sum-card-num">{rate}%</span>
                  <span className="zt-sum-card-label">{rateBasis === 'all' ? '修复率' : '未关闭修复率'}</span>
                  <span className="zt-sum-card-sub">
                    {rateBasis === 'all'
                      ? `${result.overall.fixed} / ${result.overall.total}`
                      : `${result.overall.fixedOpen} / ${result.overall.open}`}
                  </span>
                </span>
              </button>
            </div>

            {/* 本期：固定窗口内的新增 / 修复 / 关闭 + 总数环比 */}
            <div className="zt-sum-period">
              <div className="zt-period-left">
                <div className="zt-period-head">
                  本期
                  <code>{winStart.slice(5)} → {winEnd.slice(5)}</code>
                  <span className="zt-period-live">进行中</span>
                </div>
                <div className="zt-period-nums">
                  <span className="zt-period-num is-add"><b>{period.created}</b>新增</span>
                  <span className="zt-period-num is-fix"><b>{period.resolved}</b>修复</span>
                  <span className="zt-period-num is-close"><b>{period.closed}</b>关闭</span>
                </div>
              </div>
              <div className="zt-period-right">
                {growth ? (
                  <>
                    <div className="zt-period-growth">
                      较上次统计（{growth.prevAt.slice(5)}，{growth.prevTotal} 个）
                      <b className={growth.delta > 0 ? 'is-bad' : growth.delta < 0 ? 'is-ok' : ''}>
                        净增 {growth.delta} 个
                      </b>
                    </div>
                    <div className="zt-period-sub">
                      增长 {growth.pct}% · 含 {growth.workdays} 个工作日 · 日均 {growth.daily}%
                    </div>
                  </>
                ) : (
                  <>
                    <div className="zt-period-growth">本次为首次统计，暂无环比基准</div>
                    <div className="zt-period-sub">拉取一次后，下次就会显示总数环比</div>
                  </>
                )}
              </div>
            </div>

            {/* 按统计日切分的新增趋势 */}
            <div className="zt-sum-daily">
              <div className="zt-sum-daily-head">
                <span>今日新增 <strong>{daily.today}</strong> 个</span>
                <span className="zt-sum-sep" />
                <span>
                  昨日 {daily.yesterday} 个 · 环比{' '}
                  <strong className={daily.delta > 0 ? 'is-bad' : daily.delta < 0 ? 'is-ok' : ''}>
                    {daily.delta >= 0 ? '+' : ''}{daily.delta}
                    {daily.pct === null ? '' : `（${daily.pct >= 0 ? '+' : ''}${daily.pct}%）`}
                  </strong>
                </span>
                <span className="zt-sum-sep" />
                <span>近 6 日日均 {daily.avg} 个</span>
              </div>
              <div className="zt-sum-daily-window">
                统计窗口 <code>{winStart}</code> → <code>{winEnd}</code>
                <span className="zt-sum-daily-note">
                  「今天」= 昨天 {fmtCutoff(cutoffMin)} 之后到今天 {fmtCutoff(cutoffMin)}；换日时间可改
                </span>
              </div>
              <div className="zt-sum-days">
                {daily.series.map(p => {
                  const max = Math.max(1, ...daily.series.map(x => x.count));
                  const isToday = p.day === daily.currentDay;
                  const [ws, we] = statWindowOf(p.day, cutoffMin);
                  return (
                    <div
                      key={p.day}
                      className={`zt-sum-day${isToday ? ' is-today' : ''}`}
                      title={`${p.day}：${ws} → ${we}，新增 ${p.count} 个${isToday ? '（进行中）' : ''}`}
                    >
                      <span className="zt-sum-day-n">{p.count}</span>
                      <span className="zt-sum-day-bar">
                        <i style={{ height: `${Math.max(4, Math.round((p.count / max) * 100))}%` }} />
                      </span>
                      <span className="zt-sum-day-label">{p.day.slice(5)}{isToday ? ' 今' : ''}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="zt-sum-meta">
              <span>
                未关闭 <strong>{result.overall.open}</strong> 个（未修复 {result.overall.active} · 待验证 {result.overall.resolved}）
              </span>
              {sevRows.length > 0 && (
                <>
                  <span className="zt-sum-sep" />
                  <span>严重程度</span>
                  {sevRows.map(s => (
                    <Pill key={s.key} tone={s.key === '1' ? 'bad' : s.key === '2' ? 'warn' : 'mute'}>
                      {s.label} {s.count}
                    </Pill>
                  ))}
                </>
              )}
              {secTotal > 0 && (
                <>
                  <span className="zt-sum-sep" />
                  <span className="zt-sum-sec">另有安全问题 {secTotal} 个，已单独统计、未计入以上数据</span>
                </>
              )}
            </div>
          </Panel>

          {/* ---------- 明细：按项目 / 按人员 / 日报 ---------- */}
          <section className="pnl zt-sum-detail-pnl">
            <header className="pnl-head zt-detail-head">
              <div className="zt-detail-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === 'proj'}
                  className={`zt-detail-tab${tab === 'proj' ? ' is-on' : ''}`}
                  onClick={() => setTab('proj')}
                >
                  按项目 <span>{result.projects.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'person'}
                  className={`zt-detail-tab${tab === 'person' ? ' is-on' : ''}`}
                  onClick={() => setTab('person')}
                >
                  按人员 <span>{result.persons.length}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'daily'}
                  className={`zt-detail-tab${tab === 'daily' ? ' is-on' : ''}`}
                  onClick={() => setTab('daily')}
                >
                  日报预览
                </button>
              </div>
              <div className="pnl-tools">
                {tab === 'person' && (
                  <button className="btn btn-ghost btn-sm" onClick={copyPersons} title="复制成「人员分布共 N 个：某某 X 个」一行文本">
                    <Icons.copy size={12} /> 复制人员分布
                  </button>
                )}
                {tab === 'daily' && (
                  <button className="btn btn-secondary btn-sm" onClick={copyReport}>
                    <Icons.copy size={12} /> 复制日报
                  </button>
                )}
                {tab === 'proj' && (
                  <span className="zt-detail-hint">点行展开模块明细</span>
                )}
              </div>
            </header>
            <div className="pnl-body flush">
              {tab === 'proj' && (
                <div className="zt-proj-wrap">
                  <table className="tbl zt-sum-tbl">
                    <thead>
                      <tr>
                        <th style={{ minWidth: 200 }}>项目</th>
                        <th className="num">缺陷</th>
                        <th className="num">已修复</th>
                        <th className="num">未修复</th>
                        <th className="num">待验证</th>
                        <th className="num">已关闭</th>
                        <th className="num" style={{ minWidth: 120 }}>修复率</th>
                        <th style={{ width: 46 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {result.projects.map(p => {
                        const open = expanded.has(p.id);
                        return (
                          <Fragment key={p.id}>
                            <tr
                              className={`zt-sum-row${open ? ' is-open' : ''}`}
                              tabIndex={0}
                              role="button"
                              aria-expanded={open}
                              onClick={() => toggleExpand(p.id)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  toggleExpand(p.id);
                                }
                              }}
                            >
                              <td>
                                <span className="zt-sum-caret">{open ? '▾' : '▸'}</span>
                                <span className="zt-sum-name" title={`#${p.id}`}>{p.name}</span>
                                {p.skipped > 0 && (
                                  <span className="zt-sum-skip" title={`有 ${p.skipped} 条挂在你不计入的人员名下，没进「按人员」`}>
                                    排除 {p.skipped}
                                  </span>
                                )}
                              </td>
                              <td className="cell-num">{p.stat.total}</td>
                              <td className="cell-num is-ok">{p.stat.fixed}</td>
                              <td className={`cell-num${p.stat.active ? ' is-bad' : ''}`}>{p.stat.active}</td>
                              <td className={`cell-num${p.stat.resolved ? ' is-warn' : ''}`}>{p.stat.resolved}</td>
                              <td className="cell-num">{p.stat.closed}</td>
                              <td className="cell-num">
                                <span className="zt-sum-rate">
                                  <span className="zt-sum-bar"><i style={{ width: `${Math.min(100, p.stat.rate)}%` }} /></span>
                                  {p.stat.rate}%
                                </span>
                              </td>
                              <td onClick={e => e.stopPropagation()}>
                                <IconBtn title="复制这个项目" onClick={() => copyOne(p)}>
                                  <Icons.copy size={12} />
                                </IconBtn>
                              </td>
                            </tr>
                            {open && (
                              <tr className="zt-sum-detail">
                                <td colSpan={8}>
                                  {p.modules.length === 0 ? (
                                    <div className="zt-sum-empty">该项目没有可统计的缺陷</div>
                                  ) : (
                                    <table className="tbl zt-sum-mtbl">
                                      <thead>
                                        <tr>
                                          <th>模块（{p.modules.length}）</th>
                                          <th className="num">缺陷</th>
                                          <th className="num">已修复</th>
                                          <th className="num">未修复</th>
                                          <th className="num">未验证</th>
                                          <th className="num">已关闭</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {p.modules.map(m => (
                                          <tr key={m.name}>
                                            <td className="zt-sum-mod-name" title={m.name}>{m.name}</td>
                                            <td className="cell-num">{m.total}</td>
                                            <td className="cell-num is-ok">{m.fixed}</td>
                                            <td className={`cell-num${m.active ? ' is-bad' : ''}`}>{m.active}</td>
                                            <td className={`cell-num${m.resolved ? ' is-warn' : ''}`}>{m.resolved}</td>
                                            <td className="cell-num">{m.closed}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>合计</td>
                        <td className="cell-num">{result.overall.total}</td>
                        <td className="cell-num is-ok">{result.overall.fixed}</td>
                        <td className="cell-num is-bad">{result.overall.active}</td>
                        <td className="cell-num is-warn">{result.overall.resolved}</td>
                        <td className="cell-num">{result.overall.closed}</td>
                        <td className="cell-num">{result.overall.rate}%</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {tab === 'person' && (
                result.persons.length === 0 ? (
                  <div className="zt-sum-empty" style={{ padding: '18px 16px' }}>
                    {busy ? '正在拉取…' : exclude.length
                      ? '选中的项目里，未关闭的缺陷都不在这些人的名下'
                      : '这些项目没有指派到人的未关闭缺陷'}
                  </div>
                ) : (
                  <>
                    <div className="zt-proj-wrap">
                      <table className="tbl zt-sum-tbl">
                        <thead>
                          <tr>
                            <th style={{ minWidth: 120 }}>人员</th>
                            <th className="num">指派</th>
                            <th className="num" style={{ minWidth: 90 }}>占比</th>
                            <th className="num">未修复</th>
                            <th className="num">待验证</th>
                            <th className="num">已修复</th>
                            <th className="num">近 7 天新增</th>
                            <th className="num">近 7 天修复</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shownPersons.map(p => (
                            <tr
                              key={p.name}
                              className="zt-sum-prow"
                              tabIndex={0}
                              role="button"
                              title={`点开看 ${p.name} 名下的缺陷`}
                              onClick={() => setDrill(p.name)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill(p.name); }
                              }}
                            >
                              <td>
                                <span className="zt-sum-name">{p.name}</span>
                                {testers.includes(p.name) && <span className="zt-sum-tag">测试</span>}
                              </td>
                              <td className="cell-num">{p.total}</td>
                              <td className="cell-num">
                                <span className="zt-sum-rate">
                                  <span className="zt-sum-bar"><i style={{ width: `${Math.min(100, p.share)}%` }} /></span>
                                  {p.share}%
                                </span>
                              </td>
                              <td className={`cell-num${p.active ? ' is-bad' : ''}`}>{p.active}</td>
                              <td className={`cell-num${p.resolved ? ' is-warn' : ''}`}>{p.resolved}</td>
                              <td className="cell-num is-ok">{p.fixed}</td>
                              <td className="cell-num">{p.recentNew || ''}</td>
                              <td className="cell-num">{p.recentFixed || ''}</td>
                            </tr>
                          ))}
                        </tbody>
                        {(result.unassigned > 0 || result.persons.length > 12) && (
                          <tfoot>
                            <tr>
                              <td colSpan={8} className="zt-sum-more">
                                {result.unassigned > 0 && <span>未指派 {result.unassigned} 个</span>}
                                {result.persons.length > 12 && (
                                  <button className="btn btn-ghost btn-sm" onClick={() => setPersonAll(v => !v)}>
                                    {personAll ? '只看前 12 人' : `展开全部 ${result.persons.length} 人`}
                                  </button>
                                )}
                              </td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                    <div className="zt-sum-note">
                      {personsText()}
                      <span className="zt-sum-note-sub">
                        只算未关闭且指派到人的缺陷；点任意一行可看这人名下的缺陷清单。
                      </span>
                    </div>
                  </>
                )
              )}

              {tab === 'daily' && (
                <div className="zt-report">
                  <pre className="zt-report-text">{reportText}</pre>
                  <div className="zt-report-foot">
                    直接粘到群里 / 日报里即可。窗口按换日时间固定切分（当前 {fmtCutoff(cutoffMin)} → 次日 {fmtCutoff(cutoffMin)}）。
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {/* 项目多选 */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="选择要汇总的项目（可多选）"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setDraft([])}>清空</button>
            <button className="btn btn-secondary" onClick={() => setDraft(filtered.map(x => String(x.id)))}>
              全选（{filtered.length}）
            </button>
            <button
              className="btn btn-primary"
              disabled={!draft.length}
              onClick={() => {
                setProductIds(draft);
                setPickerOpen(false);
              }}
            >
              确定（{draft.length} 个）
            </button>
          </>
        )}
      >
        <div className="zt-proj-search">
          <SearchBox value={pickQuery} onChange={setPickQuery} placeholder="搜索项目名或编号，例如 58" />
          <span className="zt-proj-count">
            {pickQuery.trim() ? `${filtered.length} / ${projects.length}` : `${projects.length} 个项目`}
          </span>
        </div>
        <div className="zt-proj-list">
          {projects.length === 0 && <div className="zt-proj-empty">还没有项目列表，请先点右上角「登录并保存」或刷新项目列表</div>}
          {projects.length > 0 && filtered.length === 0 && <div className="zt-proj-empty">没有匹配「{pickQuery}」的项目</div>}
          {filtered.map(p => {
            const id = String(p.id);
            const on = draft.includes(id);
            return (
              <label key={id} className={`zt-proj-item${on ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setDraft(prevD => (prevD.includes(id) ? prevD.filter(x => x !== id) : [...prevD, id]))}
                />
                <span className="zt-proj-name">
                  {p.programName && <span className="zt-proj-program" title={`项目集：${p.programName}`}>{p.programName} / </span>}
                  {p.name}
                </span>
                <span className="zt-proj-id">#{id}</span>
              </label>
            );
          })}
        </div>
      </Modal>

      {/* 选人：不计入人员表 + 标记测试人员 */}
      <Modal
        open={personOpen}
        onClose={() => setPersonOpen(false)}
        title="选择不计入人员表的人"
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setPersonDraft([])}>全部恢复</button>
            <button
              className="btn btn-secondary"
              onClick={() => setPersonDraft(Array.from(new Set([...personDraft, ...testers])))}
              disabled={!testers.length}
              title={testers.length ? '把标记为测试人员的一起勾上' : '先在列表里把测试人员标成「测试」'}
            >
              勾上测试人员（{testers.length}）
            </button>
            <button
              className="btn btn-primary"
              onClick={() => { applyExclude(personDraft); setPersonOpen(false); }}
            >
              确定（不计入 {personDraft.length} 人）
            </button>
          </>
        )}
      >
        <div className="zt-proj-search">
          <SearchBox value={personQuery} onChange={setPersonQuery} placeholder="搜索姓名" />
          <span className="zt-proj-count">名下还挂着缺陷的 {allPersons.length} 人</span>
        </div>
        <div className="pg-sub" style={{ margin: '0 0 8px' }}>
          勾上 = 不把他计入「按人员」；右边「测试」是本地标记，标好后可用「排除测试人员」一键处理。
        </div>
        <div className="zt-proj-list">
          {allPersons.length === 0 && <div className="zt-proj-empty">当前没有挂在任何人名下的未关闭缺陷</div>}
          {allPersons.length > 0 && filteredPersons.length === 0 && <div className="zt-proj-empty">没有匹配「{personQuery}」的人</div>}
          {filteredPersons.map(p => {
            const on = personDraft.includes(p.name);
            const isTester = testers.includes(p.name);
            return (
              <label key={p.name} className={`zt-proj-item${on ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setPersonDraft(prevD => (prevD.includes(p.name) ? prevD.filter(x => x !== p.name) : [...prevD, p.name]))}
                />
                <span className="zt-proj-name">{p.name}</span>
                <span className="zt-proj-id">{p.total} 个</span>
                <button
                  type="button"
                  className={`zt-test-tag${isTester ? ' is-on' : ''}`}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); toggleTester(p.name); }}
                  title={isTester ? '取消测试标记' : '标记为测试人员（可一键排除）'}
                >
                  测试
                </button>
              </label>
            );
          })}
        </div>
      </Modal>

      {/* 人员下钻：这人名下有哪些缺陷 */}
      <Modal
        open={!!drill}
        onClose={() => setDrill(null)}
        title={`${drill || ''} 名下的未关闭缺陷（${drillBugs.length}）`}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setDrill(null)}>关闭</button>
            <button className="btn btn-primary" onClick={copyDrill} disabled={!drillBugs.length}>
              <Icons.copy size={12} /> 复制清单
            </button>
          </>
        )}
      >
        {drillBugs.length === 0 ? (
          <div className="zt-proj-empty">没有未关闭的缺陷</div>
        ) : (
          <div className="zt-sum-drill">
            {drillBugs.map(b => (
              <div key={b.id} className="zt-sum-drill-row">
                <span className="zt-sum-drill-id">#{b.id}</span>
                <span className="zt-sum-drill-title" title={b.title}>{b.title}</span>
                <Pill tone={b.status === 'active' ? 'bad' : b.status === 'resolved' ? 'ok' : 'mute'} dot>
                  {b.status === 'active' ? '未修复' : b.status === 'resolved' ? '待验证' : b.status}
                </Pill>
                <span className="zt-sum-drill-mod" title={b.moduleName}>{b.moduleName || '未指定模块'}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}

/** KPI 卡：左侧一条语义色标记 + 数字 + 标签 + 一句补充 */
function SumCard({
  label, value, tone, sub, onClick, title,
}: {
  label: string;
  value: number | string;
  tone: string;
  sub?: string;
  onClick?: () => void;
  title?: string;
}) {
  const cls = `zt-sum-card is-${tone}${onClick ? ' is-clickable' : ''}`;
  const inner = (
    <>
      <span className="zt-sum-card-num">{value}</span>
      <span className="zt-sum-card-label">{label}</span>
      {sub && <span className="zt-sum-card-sub">{sub}</span>}
    </>
  );
  if (onClick) {
    return <button className={cls} onClick={onClick} title={title}>{inner}</button>;
  }
  return <div className={cls} title={title}>{inner}</div>;
}

/** 修复率环：只画弧，数字由旁边的 .zt-sum-card-num 承担（避免重复显示） */
function Ring({ value, size = 52 }: { value: number; size?: number }) {
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(100, Math.max(0, value));
  return (
    <svg className="zt-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border-light)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--success)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
