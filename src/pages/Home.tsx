import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IconHome2 } from '@tabler/icons-react';
import type { EnvEntry, Note, PasswordEntry, WorkspaceKey } from '../types';
import { useStore } from '../store/useStore';
import { useZentaoStore } from '../store/zentaoStore';
import { useEnvProbeStore, formatAt } from '../store/envProbeStore';
import { Page, PageHead, Icons, Pill } from '../components/ui';
import { formatRecent, localDay } from '../utils/time';
import { latestRunOf, summarizeRun, type RegressionRun, type RegressionSet } from '../utils/regression';

/**
 * 今日工作台（1.25.0，1.25.1 重做）。
 *
 * 为什么要有这一页：以前打开应用落在「网址管理」，而一天里真正要先看的是
 * 「有没有新缺陷压过来 / 环境是不是挂了 / 回归是不是红了 / 备份多久没做 / 今天记了什么」。
 * 这五件事分散在五个页面，每次都要点五下才知道今天要不要紧张。
 *
 * 1.25.1 重做的原因（用户反馈「很丑、内容很空洞」）：
 *   - 旧版是 5 张等高卡片 + 几个数字，下半屏全空，信息密度极低；
 *   - `auto-fill minmax(320px)` 在 1100px 内容区只排 3 列，第一张卡 span 2 后
 *     第二行只剩 3 张矮卡，右侧留一大块空白，视觉上完全失衡。
 *
 * 现在的结构：
 *   - **12 栅格**：左 8 列放「需要动手的清单」，右 4 列放「状态概览」，
 *     两列高度自适应，不再出现半屏空白。
 *   - **清单而不是数字**：缺陷列出具体单号+标题+挂了几天，环境列出具体地址+错误，
 *     点单条直接跳过去。数字只在右栏做汇总。
 *   - **右栏补了「今日速览」**：密码库条目数、环境可达率、最近笔记、快捷入口，
 *     让右栏不再是三张空卡。
 *
 * 设计约束（不变）：
 * - **只读**：不写禅道、不改任何集合，纯聚合展示；点条目只是跳页。
 * - 数据源全部是现成的（zentaoStore / envProbeStore / vault 集合 / backupList），
 *   不新增 IPC、不新增集合。
 * - 未解锁 / IPC 全失败时也必须能渲染（每个数据源都按「拿不到就当空」处理）。
 * - 日期一律用**本地日期**（`utils/time.ts` 的 `localDay`），不用 UTC。
 */

const DAY = 86400000;

/** 距今天数（向下取整）；时间串坏了返回 null，不要显示 NaN 天 */
function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

/** 读 vault 集合：失败 / 未解锁 / 形状不对一律当空数组，页面不因此崩 */
async function safeWsGet<T>(key: WorkspaceKey): Promise<T[]> {
  try {
    const r = await window.electronAPI?.wsGet(key);
    return r && r.success && Array.isArray(r.data) ? (r.data as T[]) : [];
  } catch {
    return [];
  }
}

/** 备份列表：拿不到就当「不知道」，不要显示成「0 天前」 */
async function safeBackupList(): Promise<{ at: string; count: number }> {
  try {
    const r = await window.electronAPI?.backupList();
    if (!r || !r.success || !Array.isArray(r.data)) return { at: '', count: 0 };
    const first = r.data[0] as { mtime?: string } | undefined;
    return { at: String(first?.mtime || r.lastAt || ''), count: r.data.length };
  } catch {
    return { at: '', count: 0 };
  }
}

/** 禅道严重程度：1 致命 / 2 严重 / 3 一般 / 4 轻微 */
const SEVERITY_LABEL: Record<string, string> = { '1': '致命', '2': '严重', '3': '一般', '4': '轻微' };
const SEVERITY_TONE: Record<string, string> = { '1': 'bad', '2': 'bad', '3': 'warn', '4': 'mute' };

/** 禅道状态中文 */
const STATUS_LABEL: Record<string, string> = {
  active: '激活', resolved: '已解决', closed: '已关闭',
  postponed: '已延期', resolved_bug: '已解决',
};

/** 环境类型中文（与 Dashboard 的 envLabel 同口径） */
const ENV_LABEL: Record<string, string> = {
  production: '正式', testing: '测试', development: '开发', staging: '预发布',
};

/** 面板：左栏清单 / 右栏概览共用 */
function Panel({
  icon, title, badge, action, children, className, hasItems,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** 有清单内容时允许吃掉左栏剩余高度（空态面板保持自然高度，避免被拉成一张巨大的空卡） */
  hasItems?: boolean;
}) {
  return (
    <section className={`home-panel${hasItems ? ' is-has-items' : ''}${className ? ` ${className}` : ''}`}>
      <header className="home-panel-head">
        <span className="home-panel-ico">{icon}</span>
        <h3 className="home-panel-title">{title}</h3>
        {badge}
        <span className="home-panel-spacer" />
        {action}
      </header>
      <div className="home-panel-body">{children}</div>
    </section>
  );
}

/** 一行可点的清单项（整行可点，键盘可达） */
function Row({
  onClick, tone, main, sub, meta, right,
}: {
  onClick?: () => void;
  tone?: 'bad' | 'warn' | 'info' | 'mute';
  main: React.ReactNode;
  sub?: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
}) {
  const cls = `home-item${tone ? ` is-${tone}` : ''}${onClick ? ' is-clickable' : ''}`;
  if (!onClick) {
    return (
      <div className={cls}>
        <span className="home-item-dot" />
        <span className="home-item-main">{main}</span>
        {sub && <span className="home-item-sub">{sub}</span>}
        {meta && <span className="home-item-meta">{meta}</span>}
        {right}
      </div>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick}>
      <span className="home-item-dot" />
      <span className="home-item-main">{main}</span>
      {sub && <span className="home-item-sub">{sub}</span>}
      {meta && <span className="home-item-meta">{meta}</span>}
      {right}
      <Icons.chevron size={12} className="home-item-go" />
    </button>
  );
}

/** 空态：一行说明 + 可选行动按钮 */
function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="home-empty">
      <span>{text}</span>
      {action}
    </div>
  );
}

export function Home() {
  const bugs = useZentaoStore(s => s.bugs);
  const fetchedAt = useZentaoStore(s => s.fetchedAt);
  const mineScope = useZentaoStore(s => s.mineScope);
  const results = useEnvProbeStore(s => s.results);
  const probeAt = useEnvProbeStore(s => s.at);
  const entries = useStore(s => s.entries);

  const [envs, setEnvs] = useState<EnvEntry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [regSets, setRegSets] = useState<RegressionSet[]>([]);
  const [regRuns, setRegRuns] = useState<RegressionRun[]>([]);
  const [backup, setBackup] = useState<{ at: string; count: number }>({ at: '', count: 0 });
  const [loading, setLoading] = useState(true);
  const [reloadAt, setReloadAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const [envList, noteList, sets, runs, bk] = await Promise.all([
      safeWsGet<EnvEntry>('environments'),
      safeWsGet<Note>('notes'),
      safeWsGet<RegressionSet>('regressionSets'),
      safeWsGet<RegressionRun>('regressionRuns'),
      safeBackupList(),
    ]);
    setEnvs(envList);
    setNotes(noteList);
    setRegSets(sets);
    setRegRuns(runs);
    setBackup(bk);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load, reloadAt]);

  const go = (page: string) => { useStore.getState().requestNavigate(page); };

  const today = localDay();

  /* ---------- 1. 缺陷：按「要动手」排序的清单 ---------- */
  /**
   * `bugs` 是「我的 Bug」视图最后一次拉到的数据，口径由 `mineScope` 决定。
   * 卡片标签跟着 scope 走 —— 切到「我提交的」之后还写「指派给我」就是骗人。
   */
  const scopeLabel = mineScope === 'opened' ? '我提交的未关闭'
    : mineScope === 'verify' ? '待我验证'
      : '指派给我未关闭';

  const bugStats = useMemo(() => {
    const st = (b: { status?: string }) => String(b.status || '').toLowerCase();
    const open = bugs.filter(b => st(b) !== 'closed');
    const verify = bugs.filter(b => st(b) === 'resolved');
    const severeToday = bugs.filter(b => {
      const day = String(b.openedDate || b.date || '').slice(0, 10);
      return day === today && ['1', '2'].includes(String(b.severity || ''));
    });
    // 超期：有 deadline 且已过（未关闭）
    const overdue = open.filter(b => {
      const dl = String(b.deadline || '').slice(0, 10);
      return dl && dl < today;
    });
    return { open, verify, severeToday, overdue, total: open.length };
  }, [bugs, today]);

  /** 左栏清单：优先「今日新增致命/严重」→「超期」→「待验证」，最多 8 条 */
  const bugList = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ bug: typeof bugs[number]; why: string; tone: 'bad' | 'warn' | 'info' }> = [];
    const push = (list: typeof bugs, why: string, tone: 'bad' | 'warn' | 'info') => {
      for (const b of list) {
        const id = String(b.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ bug: b, why, tone });
      }
    };
    push(bugStats.severeToday, '今日新增', 'bad');
    push(bugStats.overdue, '已超期', 'bad');
    push(bugStats.verify, '待验证', 'warn');
    push(bugStats.open, scopeLabel, 'info');
    return out.slice(0, 8);
  }, [bugStats, scopeLabel]);

  /* ---------- 2. 环境不可达 ---------- */
  const envNameOf = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of envs) {
      if (!e || e.id == null) continue;
      map[String(e.id)] = [e.system, e.envType].filter(Boolean).join(' · ') || `条目 ${e.id}`;
    }
    return map;
  }, [envs]);

  const downEnvs = useMemo(
    () => Object.entries(results || {})
      .filter(([, r]) => r && r.ok === false)
      .map(([id, r]) => ({
        id,
        name: envNameOf[id] || '（已删除的环境）',
        url: String(r.url || ''),
        error: r.error || '',
        ms: typeof r.ms === 'number' ? r.ms : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [results, envNameOf],
  );

  const envTotal = Object.keys(results || {}).length;
  const envOk = envTotal - downEnvs.length;
  const envRate = envTotal > 0 ? Math.round((envOk / envTotal) * 100) : null;

  /* ---------- 3. 接口回归失败 ---------- */
  const failedSets = useMemo(
    () => regSets
      .filter(s => s && s.enabled !== false && s.lastStatus === 'fail')
      .map((s) => {
        const run = latestRunOf(regRuns, s.id);
        const sum = run ? summarizeRun(run.steps || []) : null;
        return { set: s, run, sum };
      })
      .sort((a, b) => String(b.set.lastRunAt || '').localeCompare(String(a.set.lastRunAt || ''))),
    [regSets, regRuns],
  );

  /* ---------- 4. 备份 ---------- */
  const backupDays = backup.at ? daysSince(backup.at) : null;
  const backupStale = backupDays !== null && backupDays > 3;

  /* ---------- 5. 笔记 ---------- */
  const realNotes = useMemo(
    // 周报片段（kind='weekly'）不是笔记，别混进「今天记了什么」
    () => notes.filter(n => n && String(n.kind || '') !== 'weekly'),
    [notes],
  );
  const todayNotes = useMemo(() => realNotes
    .filter(n => {
      const t = Date.parse(String(n.updatedAt || ''));
      return Number.isFinite(t) && localDay(new Date(t)) === today;
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
  [realNotes, today]);

  /** 最近笔记（不限今天）：右栏「最近记录」用，避免今天没记就一片空白 */
  const recentNotes = useMemo(() => realNotes
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 4),
  [realNotes]);

  /* ---------- 6. 密码库概览 ---------- */
  const vaultStats = useMemo(() => {
    const list = (entries || []) as PasswordEntry[];
    const fav = list.filter(e => e.favorite).length;
    const withTotp = list.filter(e => e.totpSecret).length;
    const withAttach = list.filter(e => (e.attachments || []).length > 0).length;
    // 密码超过 180 天没改（与 SecurityAudit 同口径）
    const stale = list.filter(e => {
      const t = Date.parse(String(e.passwordUpdatedAt || e.updatedAt || ''));
      return Number.isFinite(t) && Date.now() - t > 180 * DAY;
    }).length;
    return { total: list.length, fav, withTotp, withAttach, stale };
  }, [entries]);

  /** 最近改动的条目（左栏「最近改动」用）：按 updatedAt 倒序取 5 条 */
  const recentEntries = useMemo(() => (entries || [])
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 5),
  [entries]);

  const nothingToday = bugStats.total === 0 && downEnvs.length === 0
    && failedSets.length === 0 && todayNotes.length === 0;

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<IconHome2 size={16} stroke={1.8} />}
          title="今日工作台"
          desc={nothingToday
            ? '今天没有需要立刻处理的事，可以安心做手头的活'
            : '一屏看完今天要处理的事：缺陷、环境、回归、备份、笔记'}
          tools={
            <button className="btn btn-secondary btn-sm" onClick={() => setReloadAt(Date.now())} disabled={loading}>
              <Icons.refresh size={13} /> {loading ? '汇总中…' : '刷新'}
            </button>
          }
        />

        <div className="home-layout">
          {/* ================= 左栏：需要动手的清单 ================= */}
          <div className="home-col-main">
            {/* ---- 缺陷待办 ---- */}
            <Panel
              icon={<Icons.bug size={14} />}
              title="缺陷待办"
              hasItems={bugList.length > 0}
              badge={bugStats.total > 0
                ? <Pill tone="bad">{bugStats.total} 个未关闭</Pill>
                : <Pill tone="ok">无待办</Pill>}
              action={<button className="home-link" onClick={() => go('zentao')}>去缺陷管理</button>}
            >
              {bugList.length === 0 ? (
                <Empty
                  text={bugs.length === 0
                    ? '还没有拉取过缺陷数据 —— 去「缺陷管理」拉一次，这里就会显示待办'
                    : '今天没有待办缺陷'}
                  action={<button className="btn btn-ghost btn-sm" onClick={() => go('zentao')}>去拉取</button>}
                />
              ) : (
                <div className="home-items">
                  {bugList.map(({ bug, why, tone }) => (
                    <Row
                      key={String(bug.id)}
                      tone={tone}
                      onClick={() => go('zentao')}
                      main={<><span className="home-bug-id">#{bug.id}</span> {bug.title || '（无标题）'}</>}
                      sub={[
                        SEVERITY_LABEL[String(bug.severity || '')] || '',
                        STATUS_LABEL[String(bug.status || '').toLowerCase()] || String(bug.status || ''),
                        bug.assignedTo ? `指派 ${bug.assignedTo}` : '',
                      ].filter(Boolean).join(' · ')}
                      meta={<span className={`home-tag is-${tone}`}>{why}</span>}
                    />
                  ))}
                  {bugStats.total > bugList.length && (
                    <button className="home-more" onClick={() => go('zentao')}>
                      还有 {bugStats.total - bugList.length} 个未关闭缺陷
                    </button>
                  )}
                </div>
              )}
              {fetchedAt && <div className="home-panel-foot">缺陷数据拉取于 {formatRecent(fetchedAt)}</div>}
            </Panel>

            {/* ---- 环境不可达 ---- */}
            <Panel
              icon={<Icons.server size={14} />}
              title="环境不可达"
              hasItems={downEnvs.length > 0}
              badge={downEnvs.length > 0
                ? <Pill tone="bad">{downEnvs.length} 个</Pill>
                : <Pill tone="ok">全部可达</Pill>}
              action={<button className="home-link" onClick={() => go('environments')}>去环境矩阵</button>}
            >
              {downEnvs.length === 0 ? (
                <Empty
                  text={probeAt ? '上次巡检没有不可达的地址' : '还没巡检过 —— 去「环境矩阵」点一次「一键巡检」'}
                  action={<button className="btn btn-ghost btn-sm" onClick={() => go('environments')}>去巡检</button>}
                />
              ) : (
                <div className="home-items">
                  {downEnvs.slice(0, 6).map(d => (
                    <Row
                      key={d.id}
                      tone="bad"
                      onClick={() => go('environments')}
                      main={d.name}
                      sub={d.url.replace(/^https?:\/\//, '')}
                      meta={d.error || (d.ms != null ? `${d.ms} ms` : '')}
                    />
                  ))}
                  {downEnvs.length > 6 && (
                    <button className="home-more" onClick={() => go('environments')}>
                      还有 {downEnvs.length - 6} 个不可达
                    </button>
                  )}
                </div>
              )}
              {probeAt && <div className="home-panel-foot">上次巡检 {formatAt(probeAt)}</div>}
            </Panel>

            {/* ---- 接口回归 ---- */}
            <Panel
              icon={<Icons.link size={14} />}
              title="接口回归"
              hasItems={failedSets.length > 0}
              badge={failedSets.length > 0
                ? <Pill tone="bad">{failedSets.length} 个失败</Pill>
                : <Pill tone="ok">没有失败</Pill>}
              action={<button className="home-link" onClick={() => go('apiClient')}>去接口调试</button>}
            >
              {failedSets.length === 0 ? (
                <Empty
                  text={regSets.length === 0
                    ? '还没有配置回归集 —— 在「接口调试」里把几条请求存成回归集'
                    : '已配置的回归集最近一次都通过了'}
                />
              ) : (
                <div className="home-items">
                  {failedSets.slice(0, 5).map(({ set, sum }) => (
                    <Row
                      key={set.id}
                      tone="bad"
                      onClick={() => go('apiClient')}
                      main={set.name}
                      sub={sum ? `${sum.fail} / ${sum.total} 条失败` : '上次运行失败'}
                      meta={set.lastRunAt ? formatRecent(set.lastRunAt) : ''}
                    />
                  ))}
                </div>
              )}
            </Panel>

            {/* ---- 最近改动（1.25.1 补）----
                左栏三张卡在「今天没事」时只有三行字，左下会留一大块空白。
                这里补一条真正有用的清单：最近改过的密码条目 ——
                早上开工前扫一眼「昨天动过哪些系统」，比看空白强。 */}
            <Panel
              icon={<Icons.clock size={14} />}
              title="最近改动"
              hasItems={recentEntries.length > 0}
              action={<button className="home-link" onClick={() => go('passwordManager')}>去网址管理</button>}
            >
              {recentEntries.length === 0 ? (
                <Empty
                  text="密码库里还没有条目"
                  action={<button className="btn btn-ghost btn-sm" onClick={() => go('passwordManager')}>新增一条</button>}
                />
              ) : (
                <div className="home-items">
                  {recentEntries.map(e => (
                    <Row
                      key={e.id}
                      onClick={() => go('passwordManager')}
                      main={e.name || '（未命名）'}
                      sub={[ENV_LABEL[e.envType] || e.envType, e.url ? e.url.replace(/^https?:\/\//, '') : ''].filter(Boolean).join(' · ')}
                      meta={formatRecent(e.updatedAt)}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* ================= 右栏：状态概览 ================= */}
          <div className="home-col-side">
            {/* ---- 今日速览 ---- */}
            <Panel icon={<Icons.chart size={14} />} title="今日速览">
              <div className="home-stats">
                <div className="home-stat">
                  <b className={bugStats.total > 0 ? 'is-bad' : ''}>{bugStats.total}</b>
                  <i>未关闭缺陷</i>
                </div>
                <div className="home-stat">
                  <b className={downEnvs.length > 0 ? 'is-bad' : 'is-ok'}>{envRate === null ? '—' : `${envRate}%`}</b>
                  <i>环境可达率</i>
                </div>
                <div className="home-stat">
                  <b className={failedSets.length > 0 ? 'is-bad' : 'is-ok'}>{failedSets.length}</b>
                  <i>回归失败</i>
                </div>
                <div className="home-stat">
                  <b className={backupStale ? 'is-warn' : ''}>{backupDays === null ? '—' : backupDays}</b>
                  <i>距上次备份（天）</i>
                </div>
              </div>
              {backupStale && (
                <div className="home-alert">
                  <Icons.clock size={12} /> 超过 3 天没备份了
                  <button className="home-link" onClick={() => go('settings')}>去备份</button>
                </div>
              )}
            </Panel>

            {/* ---- 密码库 ---- */}
            <Panel
              icon={<Icons.key size={14} />}
              title="密码库"
              action={<button className="home-link" onClick={() => go('passwordManager')}>去网址管理</button>}
            >
              <div className="home-stats is-3">
                <div className="home-stat">
                  <b>{vaultStats.total}</b>
                  <i>条目</i>
                </div>
                <div className="home-stat">
                  <b>{vaultStats.fav}</b>
                  <i>收藏</i>
                </div>
                <div className="home-stat">
                  <b className={vaultStats.stale > 0 ? 'is-warn' : ''}>{vaultStats.stale}</b>
                  <i>超 180 天未改</i>
                </div>
              </div>
              <div className="home-chips">
                {vaultStats.withTotp > 0 && <span className="home-chip">两步验证 {vaultStats.withTotp}</span>}
                {vaultStats.withAttach > 0 && <span className="home-chip">带附件 {vaultStats.withAttach}</span>}
                {vaultStats.withTotp === 0 && vaultStats.withAttach === 0 && (
                  <span className="home-chip is-mute">还没有配置两步验证或附件</span>
                )}
              </div>
            </Panel>

            {/* ---- 今日笔记 / 最近记录 ---- */}
            <Panel
              icon={<Icons.note size={14} />}
              title={todayNotes.length > 0 ? '今日笔记' : '最近记录'}
              badge={todayNotes.length > 0 ? <Pill tone="info">{todayNotes.length} 篇</Pill> : undefined}
              action={<button className="home-link" onClick={() => go('notes')}>去笔记</button>}
            >
              {(todayNotes.length > 0 ? todayNotes : recentNotes).length === 0 ? (
                <Empty
                  text="还没有笔记 —— 踩到的坑随手记一条，周报就不用回忆了"
                  action={<button className="btn btn-ghost btn-sm" onClick={() => go('notes')}>记一条</button>}
                />
              ) : (
                <div className="home-items">
                  {(todayNotes.length > 0 ? todayNotes : recentNotes).slice(0, 4).map(n => (
                    <Row
                      key={n.id}
                      onClick={() => go('notes')}
                      main={n.title || '（未命名笔记）'}
                      meta={formatRecent(n.updatedAt)}
                    />
                  ))}
                </div>
              )}
            </Panel>

            {/* ---- 快捷入口 ---- */}
            <Panel icon={<Icons.tool size={14} />} title="快捷入口">
              <div className="home-shortcuts">
                <button className="home-shortcut" onClick={() => go('dataGenerator')}>
                  <Icons.db size={13} /> 造测试数据
                </button>
                <button className="home-shortcut" onClick={() => go('toolbox')}>
                  <Icons.tool size={13} /> 工具箱
                </button>
                <button className="home-shortcut" onClick={() => go('weeklyReport')}>
                  <Icons.note size={13} /> 写周报
                </button>
                <button className="home-shortcut" onClick={() => go('attachments')}>
                  <Icons.image size={13} /> 附件管理
                </button>
              </div>
            </Panel>
          </div>
        </div>
      </Page>
    </div>
  );
}
