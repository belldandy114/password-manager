import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { EnvEntry, EnvProbeResult } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { useEnvProbeStore, formatAt } from '../store/envProbeStore';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { newId } from '../utils/id';
import { copyPlain } from '../utils/clipboard';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons, Pill, type PillTone } from '../components/ui';

const ENVS = [
  { id: 'production', label: '正式', tone: 'bad' as PillTone },
  { id: 'testing', label: '测试', tone: 'info' as PillTone },
  { id: 'development', label: '开发', tone: 'warn' as PillTone },
  { id: 'staging', label: '预发', tone: 'mute' as PillTone },
];
const envOf = (id: string) => ENVS.find(e => e.id === id);

const TIMEOUTS = [3000, 8000, 15000];

const empty = (): EnvEntry => ({
  id: '', system: '', envType: 'testing', url: '', note: '', updatedAt: new Date().toISOString(),
});

/** 巡检结果 → 徽标文案与颜色；只在这里判一次口径 */
function probeBadge(r: EnvProbeResult): { tone: PillTone; label: string } {
  if (!r.ok) return { tone: 'bad', label: '失败' };
  const s = r.status || 0;
  if (s >= 400) return { tone: 'warn', label: String(s) };
  return { tone: 'ok', label: s ? String(s) : '可达' };
}

/** 一行状态：徽标 + 耗时 + 失败原因（超长省略，title 里给全文） */
function ProbeState({ r }: { r?: EnvProbeResult }) {
  if (!r) return <span className="env-idle">未巡检</span>;
  const badge = probeBadge(r);
  return (
    <span className="env-probe" title={r.error ? `${r.error}（${r.ms} ms）` : `${r.status || '—'} · ${r.ms} ms`}>
      <Pill tone={badge.tone}>{badge.label}</Pill>
      <span className="env-ms">{r.ms} ms</span>
      {r.error && <span className="env-err">{r.error}</span>}
    </span>
  );
}

/** 提示文案里回显地址：太长就截断，保证「复制/打开的是网址」一眼可核对 */
function shortenAddress(text: string, max = 46): string {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 占比文案：分母为 0 时给「—」，不要除零出 NaN% */
function pct(part: number, total: number): string {
  if (!total) return '—';
  return `${Math.round((part / total) * 1000) / 10}%`;
}

/** 从地址里取主机名，统计卡上比整条 URL 好读 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return String(url || '');
  }
}

export function Environments() {
  const { items, save, loading } = useCollection<EnvEntry>('environments');
  const pwEntries = useStore(s => s.entries);

  const [search, setSearch] = useState('');
  const [envFilter, setEnvFilter] = useState<string>('all');
  /** 报告区展开 / 收起（统计卡与失败明细一起收） */
  const [reportOpen, setReportOpen] = useState(true);
  /** 失败明细下钻（只有出错才有） */
  const [failsOpen, setFailsOpen] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(8000);
  const [editing, setEditing] = useState<EnvEntry | null>(null);
  const [hint, setHint] = useState('');
  const { ask, confirmNode } = useConfirm();

  const results = useEnvProbeStore(s => s.results);
  const summary = useEnvProbeStore(s => s.summary);
  const currentId = useEnvProbeStore(s => s.currentId);
  const at = useEnvProbeStore(s => s.at);
  const running = useEnvProbeStore(s => s.running);
  const lastError = useEnvProbeStore(s => s.lastError);
  const history = useEnvProbeStore(s => s.history);
  const storedSig = useEnvProbeStore(s => s.sig);
  const runProbeAction = useEnvProbeStore(s => s.run);
  const viewRecord = useEnvProbeStore(s => s.viewRecord);
  const clearProbe = useEnvProbeStore(s => s.clear);
  const clearHistory = useEnvProbeStore(s => s.clearHistory);

  /**
   * 页面内的一次性提示。
   *
   * 必须自己持有一个 timer 并在下次提示时清掉旧的：否则「复制」的 2.6s 定时器会把
   * 紧接着「打开」产生的新提示提前清空，表现为「点了打开，什么提示都没有」。
   */
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => { setHint(''); }, 2600);
  };
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  /** 地址指纹：增删改地址后旧结果就未必对应当前这一行了，只提示「可能过期」，不自动清 */
  const sig = useMemo(() => items.map(i => `${i.id}:${i.url}`).join('|'), [items]);
  const stale = !!storedSig && storedSig !== sig;

  const systemOptions = useMemo(() => {
    const all = [
      ...items.map(i => String(i.system || '').trim()),
      ...pwEntries.map((e: any) => String(e.name || '').trim()),
    ].filter(Boolean);
    return Array.from(new Set(all)).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [items, pwEntries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (envFilter !== 'all' && (i.envType || '') !== envFilter) return false;
      if (!q) return true;
      return [i.system, i.url, i.note].some(v => (v || '').toLowerCase().includes(q));
    });
  }, [items, search, envFilter]);

  /** 环境类型计数：给筛选胶囊显示「正式 3 / 测试 5」，比空筛选器好点 */
  const envCounts = useMemo(() => {
    const map: Record<string, number> = { all: items.length };
    for (const it of items) {
      const k = it.envType || 'testing';
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  }, [items]);

  const grouped = useMemo(() => {
    const map = new Map<string, EnvEntry[]>();
    for (const it of filtered) {
      const key = it.system || '未分组';
      const list = map.get(key) || [];
      list.push(it);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  }, [filtered]);

  /** 一键巡检：只探当前筛选出来的地址，结果按条目 id 回填 */
  const runProbe = async () => {
    const targets = filtered
      .filter(i => String(i.url || '').trim())
      .map(i => ({ id: i.id, url: i.url }));
    if (!targets.length) { flash('当前列表里没有可巡检的地址'); return; }
    const ok = await runProbeAction(targets, timeoutMs, sig);
    if (!ok) flash(useEnvProbeStore.getState().lastError || '巡检失败');
    else if (search.trim()) flash('已按当前筛选结果巡检');
  };

  const saveEditing = async () => {
    if (!editing) return;
    const url = editing.url.trim();
    if (!editing.system.trim() || !url) return;
    const dup = items.some(i => i.id !== editing.id && i.url.trim().toLowerCase() === url.toLowerCase());
    if (dup) { flash('这个地址已经存在了'); return; }
    const entry: EnvEntry = {
      ...editing,
      system: editing.system.trim(),
      url,
      id: editing.id || newId(),
      updatedAt: new Date().toISOString(),
    };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
  };

  const remove = async (id: string) => {
    await save(items.filter(i => i.id !== id));
  };

  /**
   * 打开地址：交给系统浏览器。
   *
   * 打不开时（没有默认浏览器 / 被系统策略拦截 / 应用以管理员身份运行）不能只是静默失败——
   * 把地址复制到剪贴板再明确说一句，用户至少能自己粘到浏览器里。
   * 这里传的是行里的地址本身，不是系统名；失败文案也把地址回显出来，避免「以为复制了网址，
   * 粘出来却是名字」这种误会。
   */
  const openUrl = async (url: string) => {
    const target = String(url || '').trim();
    if (!target) { flash('这条没有填地址'); return; }
    const r = await window.electronAPI.envOpen({ url: target });
    if (r.success) { flash(`已交给系统浏览器打开：${shortenAddress(target)}`); return; }
    await copyPlain(target);
    flash(`没能打开浏览器（${r.error || '系统未响应'}），地址已复制：${shortenAddress(target)}`);
  };

  const copyUrl = async (url: string) => {
    const target = String(url || '').trim();
    if (!target) { flash('这条没有填地址'); return; }
    await copyPlain(target);
    flash(`网址已复制：${shortenAddress(target)}`);
  };

  /**
   * 从「网址管理」导入地址。
   *
   * 两个集合是分开存的（environments 只放地址，entries 是带账号密码的条目），
   * 所以这里做一次性单向导入：按 url 去重，已经有的不重复加。
   * 不做自动同步——网址管理里改一条就悄悄改环境矩阵，反而容易误删。
   */
  const importable = useMemo(() => {
    const have = new Set(items.map(i => String(i.url || '').trim().toLowerCase()).filter(Boolean));
    const seen = new Set<string>();
    const out: EnvEntry[] = [];
    for (const e of pwEntries as any[]) {
      const url = String(e?.url || '').trim();
      const key = url.toLowerCase();
      if (!url || have.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: newId(),
        system: String(e.name || '').trim() || '未分组',
        envType: ENVS.some(x => x.id === e.envType) ? e.envType : 'testing',
        url,
        note: String(e.notes || '').trim(),
        updatedAt: new Date().toISOString(),
      });
    }
    return out;
  }, [items, pwEntries]);

  const importFromVault = async () => {
    if (!importable.length) { flash('网址管理里没有新的地址可导入'); return; }
    await save([...items, ...importable]);
    flash(`已从网址管理导入 ${importable.length} 个地址`);
  };

  const stated = useMemo(
    () => filtered.filter(i => results[i.id]).length,
    [filtered, results],
  );

  const failures = useMemo(
    () => filtered
      .map(i => ({ entry: i, r: results[i.id] }))
      .filter(x => x.r && !x.r.ok),
    [filtered, results],
  );

  /** 报告文本：贴到群里 / 缺陷里都够用 */
  const buildReportText = () => {
    if (!summary) return '';
    const lines = [
      `环境巡检 ${formatAt(at)}（超时 ${timeoutMs / 1000}s）`,
      `可达 ${summary.ok}/${summary.total}，失败 ${summary.fail}，慢 ${summary.slow}，平均 ${summary.avgMs} ms`,
    ];
    if (summary.slowest) lines.push(`最慢：${summary.slowest}`);
    if (failures.length) {
      lines.push('', '失败明细：');
      for (const { entry, r } of failures) {
        lines.push(`- ${entry.system || '未分组'} ${entry.url} — ${r?.error || '未拿到状态码'}`);
      }
    }
    return lines.join('\n');
  };

  /**
   * 当前看的是不是「历史记录」。
   *
   * 不能只判 `history.some(h => h.id === currentId)`——刚跑完的那次也在 history 里，
   * 那样每次巡检完都会显示「历史记录」，用户会以为看到的是旧数据。
   * 只有当前 id 不是最新一条时才算回看历史。
   */
  const viewingRecord = !!currentId && history.length > 0 && currentId !== history[0].id;

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.server size={16} />}
          title="环境矩阵"
          desc="把各系统的开发 / 测试 / 预发 / 正式地址收在一起，点一下全部探活；结果会留下历史，切页面也不会丢"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索系统 / 地址 / 备注" />
              <select
                className="env-check-timeout"
                value={timeoutMs}
                onChange={e => setTimeoutMs(Number(e.target.value))}
                title="单条地址的超时时间"
                disabled={running}
              >
                {TIMEOUTS.map(t => <option key={t} value={t}>超时 {t / 1000}s</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" onClick={runProbe} disabled={running || !filtered.length}>
                <Icons.refresh size={13} /> {running ? '巡检中…' : '一键巡检'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={importFromVault}
                disabled={!importable.length}
                title={importable.length ? `网址管理里有 ${importable.length} 个地址还没进来` : '网址管理里的地址都已经在这里了'}
              >
                <Icons.download size={13} /> 从网址管理导入{importable.length ? ` (${importable.length})` : ''}
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setEditing(empty())}>
                <Icons.plus size={13} /> 新增环境
              </button>
            </>
          }
        />

        {hint && <div className="inline-hint">{hint}</div>}
        {lastError && !running && !summary && <div className="inline-hint is-error">{lastError}</div>}

        {/* ---- 环境类型快筛：一条地址一个环境，先按类型收敛再巡检，比搜索框快 ---- */}
        {items.length > 0 && (
          <div className="env-filters" role="tablist" aria-label="按环境筛选">
            <button
              type="button"
              role="tab"
              aria-selected={envFilter === 'all'}
              className={`env-filter${envFilter === 'all' ? ' is-on' : ''}`}
              onClick={() => setEnvFilter('all')}
            >
              全部<span className="env-filter-n">{envCounts.all || 0}</span>
            </button>
            {ENVS.map(e => {
              const n = envCounts[e.id] || 0;
              return (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={envFilter === e.id}
                  className={`env-filter env-filter-${e.id}${envFilter === e.id ? ' is-on' : ''}${n ? '' : ' is-empty'}`}
                  onClick={() => setEnvFilter(envFilter === e.id ? 'all' : e.id)}
                  title={n ? `${e.label}环境 ${n} 个地址` : `还没有${e.label}环境的地址`}
                >
                  <span className="env-filter-dot" aria-hidden="true" />
                  {e.label}<span className="env-filter-n">{n}</span>
                </button>
              );
            })}
            <span className="env-filters-spacer" />
            <span className="env-filters-hint">
              {filtered.length} 个地址{envFilter !== 'all' ? `（只看${envOf(envFilter)?.label || ''}）` : ''}
            </span>
          </div>
        )}

        {/* ---- 巡检报告：把「这次跑出了什么」写清楚，而不是只在每行塞一个徽标 ---- */}
        {summary && (
          <section className="env-report">
            <header className="env-report-head">
              <div className="env-report-headl">
                <div className="env-report-title">巡检报告</div>
                <div className="env-report-sub">
                  上次巡检 <b className="env-report-at">{formatAt(at)}</b> · 超时 {timeoutMs / 1000}s
                  {viewingRecord ? ' · 历史记录' : ' · 最新'}
                  {stale && <span className="env-stale"> · 地址有变动，建议重跑</span>}
                </div>
              </div>
              <div className="env-report-acts">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setReportOpen(v => !v)}
                  aria-expanded={reportOpen}
                  title={reportOpen ? '收起统计卡与失败明细' : '展开统计卡与失败明细'}
                >
                  <Icons.chevron size={12} className={reportOpen ? 'is-open' : ''} />
                  {reportOpen ? '收起' : '展开'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => copyPlain(buildReportText())}>复制报告</button>
                <button className="btn btn-ghost btn-sm" onClick={clearProbe}>清空当前</button>
              </div>
            </header>

            {/* 一眼看出「这次巡检结果的比例」：可达绿条 + 失败红条 */}
            <div className="env-bar" title={`可达 ${summary.ok} · 失败 ${summary.fail} · 慢 ${summary.slow}`}>
              <span className="env-bar-seg is-ok" style={{ flexGrow: summary.ok || 0.0001 }} />
              {summary.fail > 0 && <span className="env-bar-seg is-bad" style={{ flexGrow: summary.fail }} />}
              <span className="env-bar-seg is-rest" style={{ flexGrow: Math.max(0, summary.total - summary.ok - summary.fail) || 0.0001 }} />
            </div>

            {/* 统计卡：一次巡检后一直留着，再巡检就原地刷新数字与时间 */}
            {reportOpen && (
            <div className="env-kpis">
              <div className="env-kpi is-total">
                <span className="env-kpi-num">{summary.total}</span>
                <span className="env-kpi-label">地址总数</span>
                <span className="env-kpi-sub">本次巡检 {summary.total} 个</span>
              </div>
              <div className="env-kpi is-ok">
                <span className="env-kpi-num">{summary.ok}</span>
                <span className="env-kpi-label">可达</span>
                <span className="env-kpi-sub">占 {pct(summary.ok, summary.total)}</span>
              </div>
              <button
                type="button"
                className={`env-kpi is-bad${failures.length ? ' is-clickable' : ''}${failsOpen ? ' is-open' : ''}`}
                onClick={() => failures.length && setFailsOpen(v => !v)}
                disabled={!failures.length}
                title={failures.length ? (failsOpen ? '收起失败明细' : `展开 ${failures.length} 条失败明细`) : '本次没有失败'}
              >
                <span className="env-kpi-num">{summary.fail}</span>
                <span className="env-kpi-label">
                  失败
                  {failures.length > 0 && <Icons.chevron size={11} className={failsOpen ? 'is-open' : ''} />}
                </span>
                <span className="env-kpi-sub">
                  {failures.length ? (failsOpen ? '点此收起明细' : `点此看 ${failures.length} 条明细`) : '占 0%'}
                </span>
              </button>
              <div className="env-kpi is-warn">
                <span className="env-kpi-num">{summary.slow}</span>
                <span className="env-kpi-label">慢（≥2s）</span>
                <span className="env-kpi-sub">占可达 {pct(summary.slow, summary.ok)}</span>
              </div>
              <div className="env-kpi is-time">
                <span className="env-kpi-num">{summary.ok ? summary.avgMs : '—'}<span className="env-kpi-unit">{summary.ok ? ' ms' : ''}</span></span>
                <span className="env-kpi-label">平均耗时</span>
                <span className="env-kpi-sub" title={summary.slowest || ''}>
                  {summary.slowest ? `最慢 ${hostOf(summary.slowest)}` : '无可用结果'}
                </span>
              </div>
              <div className="env-kpi is-at">
                <span className="env-kpi-num env-kpi-at">{formatAt(at).slice(5, 16)}</span>
                <span className="env-kpi-label">上次巡检</span>
                <span className="env-kpi-sub">{viewingRecord ? '历史记录' : '最新一次'}</span>
              </div>
            </div>
            )}

            {/* 失败明细：只有出错才下钻，默认收起，点「失败」卡或这里展开 */}
            {reportOpen && failures.length > 0 && failsOpen && (
              <ul className="env-report-fails">
                {failures.map(({ entry, r }) => (
                  <li key={entry.id}>
                    <span className="env-fail-url">{entry.url}</span>
                    <span className="env-fail-why">{r?.error || '未拿到状态码'}</span>
                  </li>
                ))}
              </ul>
            )}

            {reportOpen && summary.total > 0 && summary.fail === 0 && (
              <div className="env-report-ok">全部可达，链路正常。</div>
            )}
          </section>
        )}

        {/* ---- 巡检历史：每次一条卡片，点一下回看那一次的结果 ---- */}
        {history.length > 0 && (
          <section className="env-hist">
            <div className="env-hist-head">
              <span className="env-hist-title">巡检历史</span>
              <span className="env-hist-sub">保留最近 {history.length}/{12} 次</span>
              <span className="env-hist-spacer" />
              <button className="btn btn-ghost btn-sm" onClick={() => ask({
                title: '清除巡检历史',
                message: '只清掉这些历史卡片，不影响环境地址本身。',
                confirmText: '清除',
                onOk: clearHistory,
              })}>清除历史</button>
            </div>
            <div className="env-hist-row">
              {history.map(h => {
                const on = h.id === currentId;
                return (
                  <button
                    key={h.id}
                    type="button"
                    className={`env-hist-card${on ? ' is-on' : ''}${h.summary.fail ? ' has-fail' : ''}`}
                    onClick={() => viewRecord(h.id)}
                    title={`${formatAt(h.at)} · 超时 ${h.timeoutMs / 1000}s`}
                  >
                    <span className="env-hist-time">{formatAt(h.at).slice(5, 16)}</span>
                    <span className="env-hist-nums">
                      <b>{h.summary.ok}</b>/{h.summary.total} 可达
                      {h.summary.fail > 0 && <em> · {h.summary.fail} 失败</em>}
                    </span>
                    <span className="env-hist-meta">
                      {h.summary.ok ? `平均 ${h.summary.avgMs} ms` : '无可用结果'}
                      {h.summary.slow > 0 ? ` · 慢 ${h.summary.slow}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* ---- 列表：按系统分卡片，一行一个地址 ---- */}
        {loading ? (
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : grouped.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.server size={22} />}
              title={search || envFilter !== 'all' ? '没有匹配的环境' : '还没有环境地址'}
              desc={
                search ? '换个关键词试试'
                  : envFilter !== 'all' ? `当前只看「${envOf(envFilter)?.label || ''}」环境，切回「全部」看其它地址`
                    : '把各系统的地址录进来，改配置或发版前先点一次「一键巡检」，比逐个打开浏览器快'
              }
              hint={<>巡检走的是系统网络栈，公司代理与内网证书和浏览器一致</>}
              action={search ? undefined : (
                <>
                  <button className="btn btn-primary btn-sm" onClick={() => setEditing(empty())}>
                    <Icons.plus size={13} /> 新增环境
                  </button>
                  {importable.length > 0 && (
                    <button className="btn btn-secondary btn-sm" onClick={importFromVault}>
                      <Icons.download size={13} /> 从网址管理导入 {importable.length} 个
                    </button>
                  )}
                </>
              )}
            />
          </Panel>
        ) : (
          <>
            <div className="env-cards">
              {grouped.map(([system, list]) => {
                const okCount = list.filter(i => results[i.id]?.ok).length;
                const done = list.filter(i => results[i.id]).length;
                return (
                  <section className="env-card" key={system}>
                    <header className="env-card-head">
                      <span className="env-card-title" title={system}>{system}</span>
                      <span className="env-card-count">{list.length}</span>
                      <span className="env-card-spacer" />
                      {done > 0 && (
                        <span className={`env-card-stat${okCount < done ? ' is-bad' : ' is-ok'}`}>
                          {okCount === done ? `全部可达 ${okCount}/${done}` : `可达 ${okCount}/${done}`}
                        </span>
                      )}
                      <IconBtn title="在这一组里新增" onClick={() => setEditing({ ...empty(), system })}>
                        <Icons.plus size={13} />
                      </IconBtn>
                    </header>
                    <div className="env-rows">
                      {list.map(it => {
                        const env = envOf(it.envType);
                        const r = results[it.id];
                        return (
                          <div className={`env-row${r && !r.ok ? ' is-bad' : ''}`} key={it.id}>
                            <span className="env-row-env">
                              {env ? <Pill tone={env.tone} dot>{env.label}</Pill> : <span className="env-dash">—</span>}
                            </span>
                            <div className="env-row-main">
                              <button
                                type="button"
                                className="env-url"
                                title={`${it.url}\n点击用系统浏览器打开`}
                                onClick={() => void openUrl(it.url)}
                              >
                                {it.url}
                              </button>
                              {it.note && <span className="env-note" title={it.note}>{it.note}</span>}
                            </div>
                            <span className="env-row-state"><ProbeState r={r} /></span>
                            <span className="env-row-acts">
                              <IconBtn title="用浏览器打开（默认浏览器）" onClick={() => void openUrl(it.url)}><Icons.extern size={13} /></IconBtn>
                              <IconBtn title="复制网址（复制的是地址，不是系统名）" onClick={() => void copyUrl(it.url)}><Icons.copy size={13} /></IconBtn>
                              <span className="env-acts-sep" aria-hidden="true" />
                              <IconBtn title="编辑" onClick={() => setEditing(it)}><Icons.pencil size={13} /></IconBtn>
                              <IconBtn
                                title="删除"
                                danger
                                onClick={() => ask({
                                  title: '删除环境地址',
                                  message: `确定删除「${it.system || '未分组'} · ${it.url}」？删除后不可恢复。`,
                                  confirmText: '删除',
                                  onOk: () => remove(it.id),
                                })}
                              ><Icons.trash size={13} /></IconBtn>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="env-foot">
              共 {filtered.length} 个地址{stated > 0 ? ` · 本次已巡检 ${stated} 个` : ''}
              {envFilter !== 'all' ? `（只看${envOf(envFilter)?.label || ''}）` : ''}
              {search.trim() ? '（已按搜索过滤）' : ''}
            </div>
          </>
        )}
      </Page>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑环境' : '新增环境'}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>取消</button>
            <button
              className="btn btn-primary"
              disabled={!editing || !editing.system.trim() || !editing.url.trim()}
              onClick={saveEditing}
            >保存</button>
          </>
        )}
      >
        {editing && (
          <>
            <div className="form-group">
              <label>系统 *</label>
              <input
                value={editing.system}
                onChange={e => setEditing({ ...editing, system: e.target.value })}
                placeholder="例如：示例系统 A"
                autoFocus aria-label="系统" />
              {systemOptions.length > 0 && (
                <div className="suggest-row">
                  {systemOptions.slice(0, 8).map(s => (
                    <button key={s} type="button" className="chip" onClick={() => setEditing({ ...editing, system: s })}>{s}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="form-group">
              <label>环境</label>
              <select value={editing.envType} onChange={e => setEditing({ ...editing, envType: e.target.value })} aria-label="环境">
                {ENVS.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>地址 *</label>
              <input
                value={editing.url}
                onChange={e => setEditing({ ...editing, url: e.target.value })}
                placeholder="192.0.2.10:8080 或 https://demo.example.com" aria-label="地址" />
              <div className="input-hint">没写协议按 http:// 处理；只支持 http / https。</div>
            </div>
            <div className="form-group">
              <label>备注</label>
              <input
                value={editing.note}
                onChange={e => setEditing({ ...editing, note: e.target.value })}
                placeholder="例如：只在内网可访问 / 需要跳板机" aria-label="备注" />
            </div>
          </>
        )}
      </Modal>

      {confirmNode}
    </div>
  );
}



