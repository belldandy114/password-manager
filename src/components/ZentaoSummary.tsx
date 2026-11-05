import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ZentaoConfig, ZentaoProject } from '../types';
import { useZentaoStore } from '../store/zentaoStore';
import { Panel, Empty, Icons, SearchBox, IconBtn, Pill } from './ui';
import { Modal } from './Modal';
import { formatHm } from '../utils/time';
import {
  summarize, summaryTo, projectToText, personsToText, severityRows, personOf,
  daysAgoDay, dailyNew, parseCutoff, fmtCutoff, type ProjectSummary, type SummaryFormat,
} from '../utils/bugSummary';

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

const COPY_FORMATS: { v: SummaryFormat; label: string; hint: string }[] = [
  { v: 'text', label: '纯文本', hint: '直接粘到群里' },
  { v: 'markdown', label: 'Markdown', hint: '贴飞书 / 企微 保持表格' },
  { v: 'csv', label: 'CSV', hint: '粘到 Excel 自动分列' },
];

/**
 * 缺陷汇总 tab：
 * 1. 多选项目，一次拉这些项目的全部 Bug（含已关闭）
 * 2. 统计 缺陷数 / 已修复 / 未修复 / 待验证 / 已关闭 / 修复率（全量或仅未关闭），可排除人员、可按时间窗
 * 3. 按项目列出、展开看模块；按人员列出、点人看明细
 * 4. 一键复制（文本 / Markdown / CSV）或导出
 */
export function ZentaoSummary({
  projects, getCfg, ready, onError,
}: {
  projects: ZentaoProject[];
  getCfg: () => ZentaoConfig;
  ready: () => boolean;
  onError: (msg: string) => void;
}) {
  const sumBugs = useZentaoStore(s => s.sumBugs);
  const productIds = useZentaoStore(s => s.sumProductIds);
  const dataIds = useZentaoStore(s => s.sumDataIds);
  const exclude = useZentaoStore(s => s.sumExclude);
  const testers = useZentaoStore(s => s.sumTesters);
  const sinceDays = useZentaoStore(s => s.sumSince);
  const dayCutoff = useZentaoStore(s => s.sumDayCutoff);
  const snapshot = useZentaoStore(s => s.sumSnapshot);
  const format = useZentaoStore(s => s.sumFormat);
  const fetchedAt = useZentaoStore(s => s.sumFetchedAt);
  const setSummary = useZentaoStore(s => s.setSummary);
  const setProductIds = useZentaoStore(s => s.setSumProductIds);
  const setExclude = useZentaoStore(s => s.setSumExclude);
  const setTesters = useZentaoStore(s => s.setSumTesters);
  const setSinceDays = useZentaoStore(s => s.setSumSince);
  const setDayCutoff = useZentaoStore(s => s.setSumDayCutoff);
  const setFormat = useZentaoStore(s => s.setSumFormat);
  const saveSnapshot = useZentaoStore(s => s.saveSumSnapshot);

  const [busy, setBusy] = useState(false);
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
  const [delta, setDelta] = useState<{ at: string; total: number; active: number; fixed: number } | null>(null);

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

  // 统计结果（排除人员 / 时间窗改了立刻重算，不用重新拉数据）
  const result = useMemo(
    () => summarize(sumBugs, { productIds, productNames, exclude, since, now }),
    [sumBugs, productIds, productNames, exclude, since, now],
  );

  // 人员候选：不带排除口径算一遍，否则被排除的人会从候选里消失，没法再点回来
  const allPersons = useMemo(
    () => summarize(sumBugs, { productIds, productNames, exclude: [], since, now }).persons,
    [sumBugs, productIds, productNames, since, now],
  );

  const assignedTotal = useMemo(() => result.persons.reduce((s, p) => s + p.total, 0), [result.persons]);
  // 人员表默认只列前 12 人（一个项目动辄二三十人，全列出来表格太长）
  const shownPersons = personAll ? result.persons : result.persons.slice(0, 12);
  const sevRows = useMemo(() => severityRows(result.severity), [result.severity]);

  // 按「统计日」切分的新增趋势（默认 17:30 → 次日 17:30 算一天）
  const cutoffMin = useMemo(() => parseCutoff(dayCutoff), [dayCutoff]);
  const daily = useMemo(
    () => dailyNew(sumBugs, { cutoffMin, days: 7, now, since }),
    [sumBugs, cutoffMin, now, since],
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
    setBusy(true);
    setCopyOpen(false);
    const res = await window.electronAPI.zentaoSummary(getCfg(), productIds, force);
    setBusy(false);
    if (res.success && res.data) {
      setSummary(res.data, res.modules || {}, productIds);
      const failed = res.errors || [];
      if (failed.length) onError(`部分项目拉取失败：${failed.slice(0, 3).join('；')}`);

      // 环比：跟「上一次拉取」比，然后把这次存成新基准
      const fresh = summarize(res.data, { productIds, productNames, exclude, since, now: new Date() });
      const key = `${productIds.slice().sort().join(',')}|${sinceDays}`;
      if (snapshot && snapshot.key === key) {
        setDelta({
          at: snapshot.at,
          total: fresh.overall.total - snapshot.total,
          active: fresh.overall.active - snapshot.active,
          fixed: fresh.overall.fixed - snapshot.fixed,
        });
      } else {
        setDelta(null);
      }
      saveSnapshot({
        key,
        at: new Date().toISOString(),
        total: fresh.overall.total,
        fixed: fresh.overall.fixed,
        active: fresh.overall.active,
        resolved: fresh.overall.resolved,
        closed: fresh.overall.closed,
      });

      flash(res.cached
        ? `命中缓存（${Math.max(1, Math.round((res.ageMs || 0) / 60000))} 分钟前）`
        : `已拉取 ${res.data.length} 条缺陷`);
    } else {
      onError(res.error || '拉取失败');
    }
  };

  useEffect(() => {
    if (autoPulledOnce || busy) return;
    if (!productIds.length) return;
    if (sumBugs.length > 0) return;
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
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /* ---------------- 复制 / 导出 ---------------- */

  const buildText = (fmt: SummaryFormat) => summaryTo(fmt, result.projects, result.overall, {
    exclude,
    persons: result.persons,
    unassigned: result.unassigned,
    skipped: result.skipped,
    withModules,
    sinceLabel,
  });

  const copyAll = async (fmt: SummaryFormat = format) => {
    if (result.projects.length === 0) return;
    setCopyOpen(false);
    setFormat(fmt);
    try {
      await navigator.clipboard.writeText(buildText(fmt));
      flash(fmt === 'text' ? '已复制汇总' : fmt === 'markdown' ? '已复制 Markdown' : '已复制 CSV');
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
    return sumBugs
      .filter(b => personOf(b) === drill)
      .filter(b => !since || String(b.openedDate || b.date || '').slice(0, 10) >= since)
      .sort((a, b) => Number(b.id) - Number(a.id));
  }, [drill, sumBugs, since]);

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

  return (
    <>
      {/* 汇总范围 */}
      <Panel
        title="汇总范围"
        meta={productIds.length
          ? `${productIds.length} 个项目${sinceDays ? ` · ${SINCE_OPTIONS.find(o => o.v === sinceDays)?.label}` : ''}`
          : '未选择项目'}
        tools={
          <div className="zt-filters">
            {tip && <span className="zt-sum-tip">{tip}</span>}
            {fetchedAt && <span className="pg-sub" style={{ margin: 0 }}>{formatHm(fetchedAt)} 拉取</span>}
            <select
              value={sinceDays}
              onChange={e => setSinceDays(Number(e.target.value))}
              title="只看这些天里新提交的缺陷（按提交时间筛选）"
            >
              {SINCE_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={openPicker}>
              <Icons.folder size={12} /> 选择项目
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => pull(true)}
              disabled={busy || !productIds.length}
              title="忽略 10 分钟缓存，重新拉取"
            >
              <Icons.refresh size={12} /> 强制刷新
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => pull(false)} disabled={busy || !productIds.length}>
              {busy ? '拉取中…' : '拉取并汇总'}
            </button>
          </div>
        }
      >
        <div className="zt-sum-picked">
          {selectedProjects.length === 0 && (
            <span className="pg-sub" style={{ margin: 0 }}>还没选项目：点右上角「选择项目」，可多选</span>
          )}
          {selectedProjects.map(p => (
            <span key={p.id} className="zt-sum-chip">
              <span className="zt-sum-chip-name" title={`#${p.id}`}>{p.name}</span>
              <button
                title="移除"
                onClick={() => setProductIds(productIds.filter(id => id !== String(p.id)))}
              >
                <Icons.close size={10} />
              </button>
            </span>
          ))}
          {selectedProjects.length > 1 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setProductIds([])}>清空</button>
          )}
        </div>

        <div className="zt-sum-exclude">
          <span className="zt-sum-exclude-label">不计入人员表</span>
          <button className="btn btn-ghost btn-sm" onClick={openPersonPicker}>
            <Icons.key size={12} /> 选择人员（已选 {exclude.length}）
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={excludeTesters}
            title={testers.length
              ? `把标记为测试人员的 ${testers.length} 人一起排除`
              : '还没标记测试人员：点这里会打开选人弹窗，把测试同学标成「测试」'}
          >
            <Icons.bug size={12} /> 排除测试人员{testers.length ? `（${testers.length}）` : ''}
          </button>
          {exclude.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => applyExclude([])}>全部恢复</button>
          )}
          <span className="zt-sum-cutoff">
            <span className="pg-sub" style={{ margin: 0 }}>统计日切换点</span>
            <input
              type="time"
              value={dayCutoff}
              onChange={e => setDayCutoff(e.target.value || '17:30')}
              title="按这个时间切分「一天」：17:30 → 次日 17:30 算一个统计日"
            />
            <span className="pg-sub" style={{ margin: 0 }}>
              {fmtCutoff(cutoffMin)} → 次日 {fmtCutoff(cutoffMin)}
            </span>
          </span>
        </div>

        <div className="zt-sum-persons">
          {exclude.length === 0 && (
            <span className="pg-sub" style={{ margin: 0 }}>
              没排除任何人；一般把测试人员排掉，剩下的就是「开发身上压着多少」
            </span>
          )}
          {exclude.map(name => (
            <button key={name} className="zt-sum-person is-off" onClick={() => togglePerson(name)} title="点击恢复">
              {name}
              <Icons.close size={10} />
            </button>
          ))}
        </div>

        {/* 测试人员名单单独显示出来：以前藏在选人弹窗的小标签里，根本找不到 */}
        <div className="zt-sum-persons">
          <span className="zt-sum-exclude-label">测试人员</span>
          {testers.length === 0 ? (
            <span className="pg-sub" style={{ margin: 0 }}>
              还没标记：在「选择人员」弹窗里点某人右侧的「测试」即可标上，标好后「排除测试人员」一键生效
            </span>
          ) : (
            testers.map(name => (
              <button
                key={name}
                className="zt-sum-person is-test"
                onClick={() => toggleTester(name)}
                title="点击取消「测试」标记"
              >
                {name}
                <Icons.close size={10} />
              </button>
            ))
          )}
        </div>

        <div className="pg-sub" style={{ marginTop: 10 }}>
          统计口径：已修复 = 解决状态为「已修复」；未修复 = 仍为「激活」；待验证 = 「已解决」未关闭；
          修复率 = 已修复 ÷ 缺陷总数（点「修复率」卡片可切成「仅未关闭」作分母）。「按人员」只统计未关闭且
          指派到人的缺陷（禅道关闭后会清空指派人），排除人员只影响这张人员表，不改项目 / 模块 / 总数的数字。
        </div>
      </Panel>

      {stale && (
        <div className="pill pill-warn" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400 }}>
          选择的项目与已拉取的数据不一致，点「拉取并汇总」更新（也可以先改排除人员 / 时间窗，统计会实时重算）。
        </div>
      )}
      {expired && !stale && (
        <div className="pill pill-warn" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400 }}>
          数据是 {formatHm(fetchedAt)} 拉的，已超过 10 分钟缓存期，禅道里可能又变了——点「强制刷新」拿最新。
        </div>
      )}

      {!hasData ? (
        <Panel>
          <Empty
            icon={<Icons.chart size={22} />}
            title={busy ? '正在拉取…' : productIds.length ? '还没有汇总数据' : '先选几个项目'}
            desc={productIds.length
              ? '点「拉取并汇总」，会读取选中项目的全部缺陷（含已关闭）并按项目 / 模块 / 人员统计'
              : '汇总支持多选项目，一次看清每个项目还剩多少未修复、多少待验证，以及压在谁身上'}
            action={
              <button className="btn btn-primary btn-sm" onClick={() => (productIds.length ? pull(false) : openPicker())} disabled={busy}>
                {productIds.length ? '拉取并汇总' : '选择项目'}
              </button>
            }
          />
        </Panel>
      ) : (
        <>
          <Panel
            title="总计"
            meta={`${result.projects.length} 个项目 · ${result.overall.total} 条缺陷`}
            tools={
              <div className="zt-filters" style={{ position: 'relative' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => copyAll()} title={`复制为${COPY_FORMATS.find(f => f.v === format)?.label}`}>
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
            <div className="zt-sum-cards">
              <SumCard label="缺陷总数" value={result.overall.total} tone="info" />
              <SumCard label="已修复" value={result.overall.fixed} tone="ok" />
              <SumCard label="未修复" value={result.overall.active} tone="bad" />
              <SumCard label="待验证" value={result.overall.resolved} tone="warn" />
              <SumCard label="已关闭" value={result.overall.closed} tone="mute" />
              <SumCard
                label={rateBasis === 'all' ? '修复率' : '未关闭修复率'}
                value={`${rate}%`}
                tone="ok"
                bar={rate}
                onClick={() => setRateBasis(v => (v === 'all' ? 'open' : 'all'))}
                title={rateBasis === 'all'
                  ? `已修复 ÷ 全部缺陷（${result.overall.fixed}/${result.overall.total}）· 点击换成「仅未关闭」口径`
                  : `未关闭里已修复的比例（${result.overall.fixedOpen}/${result.overall.open}）· 点击换回「全部」口径`}
              />
              <SumCard label="近 7 天新增" value={result.overall.recentNew} tone="info" />
              <SumCard label="近 7 天修复" value={result.overall.recentFixed} tone="ok" />
              <SumCard
                label="今日新增"
                value={daily.today}
                tone={daily.delta > 0 ? 'bad' : daily.delta < 0 ? 'ok' : 'info'}
                title={`统计日 ${daily.currentDay} ${fmtCutoff(cutoffMin)} 起算；昨日 ${daily.yesterday} 个`}
              />
            </div>

            {/* 按「统计日」切分的新增趋势：17:30 → 次日 17:30 算一天 */}
            <div className="zt-sum-daily">
              <div className="zt-sum-daily-head">
                <span>
                  今日新增 <strong>{daily.today}</strong> 个
                </span>
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
                <span className="zt-sum-daily-note">
                  统计日按每天 {fmtCutoff(cutoffMin)} 切分，可在上方改时间
                </span>
              </div>
              <div className="zt-sum-days">
                {daily.series.map(p => {
                  const max = Math.max(1, ...daily.series.map(x => x.count));
                  const isToday = p.day === daily.currentDay;
                  return (
                    <div
                      key={p.day}
                      className={`zt-sum-day${isToday ? ' is-today' : ''}`}
                      title={`${p.day} ${fmtCutoff(cutoffMin)} → 次日 ${fmtCutoff(cutoffMin)}：新增 ${p.count} 个${isToday ? '（进行中）' : ''}`}
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
                  <span>严重程度：</span>
                  {sevRows.map(s => (
                    <Pill key={s.key} tone={s.key === '1' ? 'bad' : s.key === '2' ? 'warn' : 'mute'}>
                      {s.label} {s.count}
                    </Pill>
                  ))}
                </>
              )}
              {delta && (
                <>
                  <span className="zt-sum-sep" />
                  <span title={`上次拉取：${formatHm(delta.at)}`}>
                    较上次：总数 {delta.total >= 0 ? '+' : ''}{delta.total}、未修复 {delta.active >= 0 ? '+' : ''}{delta.active}、已修复 {delta.fixed >= 0 ? '+' : ''}{delta.fixed}
                  </span>
                </>
              )}
            </div>
          </Panel>

          <Panel
            title="按项目"
            meta={`${result.projects.length} 个 · 点行展开模块明细`}
            flush
          >
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
          </Panel>

          <Panel
            title="按人员（谁身上还挂着缺陷）"
            meta={`${result.persons.length} 人 · 已指派 ${assignedTotal} 个${
              result.unassigned > 0 ? ` · 未指派 ${result.unassigned} 个` : ''}${
              result.skipped > 0 ? ` · 已排除 ${result.skipped} 个` : ''}`}
            tools={
              <button className="btn btn-secondary btn-sm" onClick={copyPersons} title="复制成「人员指派共 N 个：某某 X 个」一行文本">
                <Icons.copy size={12} /> 复制人员分布
              </button>
            }
            flush
          >
            {result.persons.length === 0 ? (
              <div className="zt-sum-empty" style={{ padding: '14px 16px' }}>
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
            )}
          </Panel>
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
                  onChange={() => setDraft(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))}
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
                  onChange={() => setPersonDraft(prev => (prev.includes(p.name) ? prev.filter(x => x !== p.name) : [...prev, p.name]))}
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

function SumCard({
  label, value, tone, bar, onClick, title,
}: {
  label: string;
  value: number | string;
  tone: string;
  bar?: number;
  onClick?: () => void;
  title?: string;
}) {
  const cls = `zt-sum-card is-${tone}${onClick ? ' is-clickable' : ''}`;
  if (onClick) {
    return (
      <button className={cls} onClick={onClick} title={title}>
        <span className="zt-sum-card-num">{value}</span>
        <span className="zt-sum-card-label">{label}</span>
        {bar !== undefined && (
          <span className="zt-sum-bar zt-sum-card-bar"><i style={{ width: `${Math.min(100, bar)}%` }} /></span>
        )}
      </button>
    );
  }
  return (
    <div className={cls} title={title}>
      <span className="zt-sum-card-num">{value}</span>
      <span className="zt-sum-card-label">{label}</span>
      {bar !== undefined && (
        <span className="zt-sum-bar zt-sum-card-bar"><i style={{ width: `${Math.min(100, bar)}%` }} /></span>
      )}
    </div>
  );
}
