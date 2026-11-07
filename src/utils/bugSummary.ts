import type { ZentaoBug } from '../types';

/**
 * 缺陷汇总口径（对齐历史日报脚本口径）：
 * - 总数      = 该项目全部 Bug（含已关闭、含已解决待验证）
 * - 已修复    = resolution === 'fixed'
 * - 未修复    = status === 'active'
 * - 已解决待验证 = status === 'resolved'
 * - 已关闭    = status === 'closed'
 * - 修复率    = 已修复 / 总数
 * - 未关闭修复率 = 未关闭且已修复 / 未关闭（把历史已关闭的从分母里去掉，看「还剩多少没弄完」）
 * - 近期新增 / 修复 = 最近 7 天（含今天）按 openedDate / resolvedDate 计
 *
 * 人员分布（「谁身上还挂着多少」）：
 * - 只看「当前指派人」，已关闭的不算（关闭后禅道会清空指派人），未指派的单列；
 * - 「排除人员」只作用于这一块——用途是把测试人员去掉，只看开发身上压了多少，
 *   所以匹配的是指派人，不是提交人；
 * - 项目 / 模块 / 总数 / 修复率始终按全量口径，跟定时任务 zt_daily.py 的日报一致。
 */

export interface BugStat {
  total: number;
  fixed: number;
  active: number;
  resolved: number;
  closed: number;
  /** 延期等其他状态 */
  other: number;
  /** 已修复 / 总数，百分比，保留 1 位 */
  rate: number;
  /** 未关闭 = 总数 - 已关闭 */
  open: number;
  /** 未关闭中的已修复（一般是「已解决待验证」那些） */
  fixedOpen: number;
  /** 已修复(未关闭中) / 未关闭，百分比，保留 1 位 */
  openRate: number;
  /** 最近 7 天新增 */
  recentNew: number;
  /** 最近 7 天解决 */
  recentFixed: number;
}

export interface ModuleRow extends BugStat {
  name: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  stat: BugStat;
  modules: ModuleRow[];
  /** 该项目按「当前指派人」的分布，按条数降序 */
  persons: PersonRow[];
  /** 未关闭且没有指派人的条数（人员之和 + 未指派 + 已排除 = 未关闭数） */
  unassigned: number;
  /** 挂在「被排除人员」名下、因而没进人员分布的条数 */
  skipped: number;
  /** 严重程度分布：{'1': n, '2': n, ...} */
  severity: Record<string, number>;
}

export interface PersonRow {
  name: string;
  /** 指派给该人的未关闭缺陷数 */
  total: number;
  fixed: number;
  active: number;
  resolved: number;
  closed: number;
  other: number;
  /** 占「已指派缺陷」的比例，百分比，保留 1 位 */
  share: number;
  /** 最近 7 天新指派到他身上的 */
  recentNew: number;
  /** 最近 7 天他这边解决的 */
  recentFixed: number;
}

/** 严重程度：禅道 1 致命 / 2 严重 / 3 一般 / 4 轻微 */
export const SEVERITY_LABELS: Record<string, string> = {
  '1': '致命',
  '2': '严重',
  '3': '一般',
  '4': '轻微',
};

export const bugIsFixed = (b: ZentaoBug) => String(b.resolution || '') === 'fixed';
export const bugIsClosed = (b: ZentaoBug) => String(b.status || '') === 'closed';

const emptyStat = (): BugStat => ({
  total: 0, fixed: 0, active: 0, resolved: 0, closed: 0, other: 0, rate: 0,
  open: 0, fixedOpen: 0, openRate: 0, recentNew: 0, recentFixed: 0,
});

const rateOf = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/** 日期部分：优先 openedDate（主进程已转本地时间），退回 date 字段 */
const dayOf = (v?: string) => String(v || '').trim().slice(0, 10);

function count(stat: BugStat, b: ZentaoBug, since7: string) {
  const st = String(b.status || '');
  const fixed = bugIsFixed(b);
  stat.total += 1;
  if (fixed) stat.fixed += 1;

  if (st === 'closed') {
    stat.closed += 1;
  } else {
    stat.open += 1;
    if (fixed) stat.fixedOpen += 1;
    if (st === 'active') stat.active += 1;
    else if (st === 'resolved') stat.resolved += 1;
    else stat.other += 1;
  }

  const opened = dayOf(b.openedDate || b.date);
  if (opened && opened >= since7) stat.recentNew += 1;
  const resolved = dayOf(b.resolvedDate);
  if (resolved && resolved >= since7) stat.recentFixed += 1;
}

const finish = (stat: BugStat): BugStat => ({
  ...stat,
  rate: rateOf(stat.fixed, stat.total),
  openRate: rateOf(stat.fixedOpen, stat.open),
});

/** 人员桶：PersonRow 去掉最后才可能算出来的 share */
type PersonBucket = Omit<PersonRow, 'share'>;

const emptyPerson = (name: string): PersonBucket =>
  ({ name, total: 0, fixed: 0, active: 0, resolved: 0, closed: 0, other: 0, recentNew: 0, recentFixed: 0 });

/** 往人员桶里加一条（调用方保证 who 非空，且该条未关闭） */
function addPerson(map: Map<string, PersonBucket>, who: string, b: ZentaoBug, since7: string) {
  const p = map.get(who) || emptyPerson(who);
  p.total += 1;
  if (bugIsFixed(b)) p.fixed += 1;
  const st = String(b.status || '');
  if (st === 'active') p.active += 1;
  else if (st === 'resolved') p.resolved += 1;
  else if (st === 'closed') p.closed += 1;
  else p.other += 1;
  const opened = dayOf(b.openedDate || b.date);
  if (opened && opened >= since7) p.recentNew += 1;
  const resolved = dayOf(b.resolvedDate);
  if (resolved && resolved >= since7) p.recentFixed += 1;
  map.set(who, p);
}

/** 人员列表收尾：算占比、按条数降序（同条数按名字，保证两次渲染顺序一致） */
function finishPersons(map: Map<string, PersonBucket>): PersonRow[] {
  const list = Array.from(map.values());
  const denom = list.reduce((s, p) => s + p.total, 0);
  return list
    .map(p => ({ ...p, share: rateOf(p.total, denom) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** 模块名：优先模块路径，其次「模块<id>」，都没有就是「未指定模块」 */
const moduleNameOf = (b: ZentaoBug) => {
  const nm = String(b.moduleName || '').trim();
  if (nm) return nm;
  const id = String(b.module || '').trim();
  if (id && id !== '0') return `模块${id}`;
  return '未指定模块';
};

/**
 * 「谁身上挂着多少」只看当前指派人：
 * - 已关闭的不算（禅道关闭后指派人会被清空，也不该算作某个人的积压）
 * - 指派人为空、或字面量 "closed" 的，算「未指派」
 * 这也是定时任务 zt_daily.py 的 persons() 口径。
 */
export const personOf = (b: ZentaoBug) => {
  if (bugIsClosed(b)) return '';
  const a = String(b.assignedTo || '').trim();
  if (!a || a === 'closed') return '';
  return a;
};

/**
 * 是否被排除：只看当前指派人。
 * 不看提交人——否则「测试提交 + 开发修复」的 Bug 会被连带剔掉，
 * 而且这份名单的用途就是「把测试人员从人员表里去掉，只看开发」。
 */
export const isExcluded = (b: ZentaoBug, exclude: Set<string>) => {
  const who = personOf(b);
  return !!who && exclude.has(who);
};

/** n 天前的本地日期（YYYY-MM-DD），含今天 */
export function daysAgoDay(n: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - n * 86400000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- 按「统计日」切分的新增趋势 ---------------- */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 'HH:mm' → 当天分钟数；写错就退回默认 17:30 */
export function parseCutoff(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return 17 * 60 + 30;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const mi = Math.min(59, Math.max(0, Number(m[2])));
  return h * 60 + mi;
}

export const fmtCutoff = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

/** 'YYYY-MM-DD HH:mm' 的本地格式（now 用） */
function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 日期串前后移动 n 天 */
export function shiftDay(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00`);
  t.setDate(t.getDate() + n);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

/**
 * 某个时间点属于哪个「统计日」。默认以 17:30 为界：
 * 17:30 之前算前一天，17:30 及之后算当天 —— 也就是 17:30 → 次日 17:30 为一个统计日。
 */
export function statDayOf(dateTime: string, cutoffMin: number): string {
  const s = String(dateTime || '').trim();
  const d = s.slice(0, 10);
  const hm = s.slice(11, 16);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  if (!/^\d{2}:\d{2}$/.test(hm)) return d; // 只有日期：算当天
  const [h, mi] = hm.split(':').map(Number);
  // 归属到「窗口结束的那一天」：昨天 17:30 → 今天 17:30 这一整天，记作「今天」。
  // 所以 >= 切分点的（今天 17:30 之后提的）算到明天那一天。
  return h * 60 + mi >= cutoffMin ? shiftDay(d, 1) : d;
}

/** 某个统计日对应的实际窗口，给界面显示用：['2026-11-04 17:30', '2026-11-05 17:30'] */
export function statWindowOf(day: string, cutoffMin: number): [string, string] {
  const c = fmtCutoff(cutoffMin);
  return [`${shiftDay(day, -1)} ${c}`, `${day} ${c}`];
}

export interface DailyPoint {
  /** 统计日（YYYY-MM-DD）：该日 17:30 结束的那个窗口，即 昨天17:30 → 当天17:30 */
  day: string;
  count: number;
}

export interface DailyNew {
  /** 当前统计日（还没走完）已新增 */
  today: number;
  /** 上一个完整统计日 */
  yesterday: number;
  /** today - yesterday */
  delta: number;
  /** 环比百分比；昨天为 0 时为 null（除不了） */
  pct: number | null;
  currentDay: string;
  /** 最近 N 个统计日（含当前这个），从旧到新 */
  series: DailyPoint[];
  /** 除当前这天外，前几天的日均 */
  avg: number;
}

/**
 * 按「统计日」统计新增缺陷数。
 * 之所以不按自然日：需求方每天 17:30 出日报，17:30 之后提的缺陷应算到第二天。
 */
export function dailyNew(
  bugs: ZentaoBug[],
  opts: {
    cutoff?: string;
    cutoffMin?: number;
    days?: number;
    now?: Date;
    since?: string;
    /** 这些提交人提的不算（安全工程师，单独统计） */
    ignored?: string[];
  } = {},
): DailyNew {
  const cutoffMin = opts.cutoffMin !== undefined ? opts.cutoffMin : parseCutoff(opts.cutoff || '17:30');
  const days = Math.max(2, opts.days || 7);
  const now = opts.now || new Date();
  const currentDay = statDayOf(localStamp(now), cutoffMin);
  const ignored = new Set((opts.ignored || []).map(s => String(s).trim()).filter(Boolean));

  const map = new Map<string, number>();
  for (const b of bugs) {
    const t = String(b.openedDate || b.date || '').trim();
    if (!t) continue;
    if (ignored.size && ignored.has(String(b.openedBy || '').trim())) continue;
    if (opts.since && t.slice(0, 10) < opts.since) continue;
    const d = statDayOf(t, cutoffMin);
    if (!d) continue;
    map.set(d, (map.get(d) || 0) + 1);
  }

  const series: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = shiftDay(currentDay, -i);
    series.push({ day, count: map.get(day) || 0 });
  }

  const today = map.get(currentDay) || 0;
  const yesterday = map.get(shiftDay(currentDay, -1)) || 0;
  const delta = today - yesterday;
  const pct = yesterday > 0 ? Math.round((delta / yesterday) * 1000) / 10 : null;
  // 日均只看已经走完的天数（不含今天，否则会被半天拉低）
  const past = series.slice(0, -1);
  const avg = past.length ? Math.round((past.reduce((s, p) => s + p.count, 0) / past.length) * 10) / 10 : 0;

  return { today, yesterday, delta, pct, currentDay, series, avg };
}

export interface SummarizeOpts {
  productIds: string[];
  productNames?: Record<string, string>;
  exclude?: string[];
  /** 时间窗：只统计这个日期（含）之后提交的缺陷，YYYY-MM-DD */
  since?: string;
  /** 注入「今天」，方便单测 */
  now?: Date;
}

export interface SummaryResult {
  projects: ProjectSummary[];
  overall: BugStat;
  persons: PersonRow[];
  unassigned: number;
  skipped: number;
  /** 全局严重程度分布 */
  severity: Record<string, number>;
}

export function summarize(bugs: ZentaoBug[], opts: SummarizeOpts): SummaryResult {
  const exclude = new Set((opts.exclude || []).map(s => String(s).trim()).filter(Boolean));
  const order = opts.productIds || [];
  const since7 = daysAgoDay(7, opts.now || new Date());
  const since = String(opts.since || '').slice(0, 10);

  type Bucket = {
    stat: BugStat;
    modules: Map<string, BugStat>;
    persons: Map<string, PersonBucket>;
    severity: Record<string, number>;
    unassigned: number;
    skipped: number;
  };
  const newBucket = (): Bucket => ({
    stat: emptyStat(), modules: new Map(), persons: new Map(), severity: {}, unassigned: 0, skipped: 0,
  });

  const map = new Map<string, Bucket>();
  // 先按选择的顺序建空行：选中但 0 条的项目也要显示出来
  for (const id of order) map.set(String(id), newBucket());

  const persons = new Map<string, PersonBucket>();
  const overall = emptyStat();
  const severity: Record<string, number> = {};
  let overallUnassigned = 0;
  let overallSkipped = 0;

  for (const b of bugs) {
    // 时间窗：按「提交时间」筛选（看近 N 天新增的这批缺陷现在修了多少）
    if (since) {
      const opened = dayOf(b.openedDate || b.date);
      if (!opened || opened < since) continue;
    }

    const pid = String(b.product || '');
    const key = pid || '__none__';
    if (!map.has(key)) map.set(key, newBucket());
    const bucket = map.get(key)!;

    // 项目 / 模块 / 总数永远按全量口径算；排除人员只影响「按人员」这一块，
    // 否则把测试人员一排除，缺陷总数和修复率也跟着变，跟日报对不上。
    count(bucket.stat, b, since7);
    count(overall, b, since7);

    const mn = moduleNameOf(b);
    if (!bucket.modules.has(mn)) bucket.modules.set(mn, emptyStat());
    count(bucket.modules.get(mn)!, b, since7);

    const sev = String(b.severity || '').trim();
    if (sev) {
      bucket.severity[sev] = (bucket.severity[sev] || 0) + 1;
      severity[sev] = (severity[sev] || 0) + 1;
    }

    // 人员口径按「当前指派人」，未关闭且没指派的单独计数，
    // 保证 人员之和 + 未指派 + 已排除 = 未关闭数
    const who = personOf(b);
    if (!who) {
      // 已关闭的不算「未指派」——它们本来就不该挂在任何人身上
      if (!bugIsClosed(b)) {
        bucket.unassigned += 1;
        overallUnassigned += 1;
      }
      continue;
    }
    if (exclude.size > 0 && exclude.has(who)) {
      bucket.skipped += 1;
      overallSkipped += 1;
      continue;
    }
    addPerson(bucket.persons, who, b, since7);
    addPerson(persons, who, b, since7);
  }

  // 项目名：优先外部传入的名字表（页面上的项目列表），其次 Bug 里带的 productName
  const nameOf = (id: string) => {
    if (opts.productNames && opts.productNames[id]) return opts.productNames[id];
    const hit = bugs.find(b => String(b.product) === id);
    return (hit && hit.productName) || `项目 ${id}`;
  };

  const projects: ProjectSummary[] = Array.from(map.entries()).map(([id, v]) => ({
    id,
    name: nameOf(id),
    stat: finish(v.stat),
    modules: Array.from(v.modules.entries())
      .map(([name, st]) => ({ name, ...finish(st) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    persons: finishPersons(v.persons),
    unassigned: v.unassigned,
    skipped: v.skipped,
    severity: v.severity,
  }));

  // 保持传入顺序（order 在前，其余追加在后）
  projects.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return b.stat.total - a.stat.total;
  });

  return {
    projects,
    overall: finish(overall),
    persons: finishPersons(persons),
    unassigned: overallUnassigned,
    skipped: overallSkipped,
    severity,
  };
}

/** 严重程度分布转成有序数组（只要出现过的） */
export function severityRows(severity: Record<string, number>): { key: string; label: string; count: number }[] {
  return Object.keys(severity)
    .filter(k => severity[k] > 0)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => ({ key: k, label: SEVERITY_LABELS[k] || `严重度${k}`, count: severity[k] }));
}

/** 一行文字概括一个项目（列表与复制共用，保证口径一致） */
const lineOf = (s: BugStat) =>
  `缺陷 ${s.total} · 已修复 ${s.fixed}（${s.rate}%）· 未修复 ${s.active} · 待验证 ${s.resolved} · 已关闭 ${s.closed}`;

export interface TextOpts {
  at?: string;
  exclude?: string[];
  withModules?: boolean;
  /** 人员分布；不传则不输出这一段 */
  persons?: PersonRow[];
  unassigned?: number;
  skipped?: number;
  withPersons?: boolean;
  /** 只写前 N 人（0 / 不传 = 全部） */
  personLimit?: number;
  /** 时间窗说明，会写进标题行 */
  sinceLabel?: string;
}

/**
 * 人员分布行，形如定时任务日报里那句：
 *   人员指派共 36 个：张三 13 个、李四 10 个、……（未指派 1 个，已关闭 910 个不计）
 * 只统计未关闭的 Bug（关闭后禅道会清空指派人，算进任何人名下都没意义）。
 */
export function personsToText(
  persons: PersonRow[],
  opts: {
    /** 未关闭但没有指派人 */
    unassigned?: number;
    /** 已关闭条数（只用于提示「没算进来」） */
    closedCount?: number;
    /** 被排除的人员名单 */
    exclude?: string[];
    /** 这些人名下被略过的条数 */
    skipped?: number;
    /** 只写前 N 人，其余用「等 N 人」收尾 */
    limit?: number;
  } = {},
): string {
  const assigned = persons.reduce((s, p) => s + p.total, 0);
  const shown = opts.limit && opts.limit > 0 ? persons.slice(0, opts.limit) : persons;
  const body = shown.length ? shown.map(p => `${p.name} ${p.total} 个`).join('、') : '暂无';
  const rest = persons.length > shown.length ? ` 等 ${persons.length} 人` : '';

  const notes: string[] = [];
  if (opts.unassigned) notes.push(`未指派 ${opts.unassigned} 个`);
  if (opts.closedCount) notes.push(`已关闭 ${opts.closedCount} 个不计`);
  const ex = (opts.exclude || []).map(s => String(s).trim()).filter(Boolean);
  if (ex.length) {
    notes.push(opts.skipped
      ? `已排除 ${ex.join('、')} 名下 ${opts.skipped} 个`
      : `已排除 ${ex.join('、')}`);
  }
  const tail = notes.length ? `（${notes.join('，')}）` : '';
  return `人员指派共 ${assigned} 个：${body}${rest}${tail}`;
}

const stampOf = (at?: string) => {
  const d = new Date(at || new Date().toISOString());
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 生成可直接粘到群里/周报的纯文本 */
export function summaryToText(
  projects: ProjectSummary[],
  overall: BugStat,
  opts: TextOpts = {},
): string {
  const stamp = stampOf(opts.at);

  const lines: string[] = [];
  lines.push(`【缺陷汇总】${stamp}　${projects.length} 个项目${opts.sinceLabel ? `　统计范围：${opts.sinceLabel}` : ''}`);
  lines.push(`合计 ${lineOf(overall)}`);
  const ex = (opts.exclude || []).filter(Boolean);
  if (ex.length) lines.push(`人员分布已排除（只看开发者）：${ex.join('、')}`);
  lines.push('');

  projects.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name}`);
    lines.push(`   ${lineOf(p.stat)}`);
    if (opts.withModules !== false && p.modules.length) {
      lines.push(`   模块 ${p.modules.length} 个：`);
      p.modules.forEach((m, mi) => {
        lines.push(`   （${mi + 1}）${m.name}：${m.total} 个（未修复 ${m.active}、待验证 ${m.resolved}）`);
      });
    }
  });

  // 人员分布放在最后：放在合计下面会把项目明细挤下去，粘到群里也不好读
  const persons = opts.persons || [];
  if (opts.withPersons !== false && persons.length) {
    lines.push('');
    lines.push(personsToText(persons, {
      unassigned: opts.unassigned || 0,
      closedCount: overall.closed,
      exclude: ex,
      skipped: opts.skipped || 0,
      limit: opts.personLimit || 0,
    }));
  }

  return lines.join('\n');
}

/** Markdown：直接贴到飞书/企微/Confluence 里表格不会散 */
export function summaryToMarkdown(
  projects: ProjectSummary[],
  overall: BugStat,
  opts: TextOpts = {},
): string {
  const stamp = stampOf(opts.at);
  const out: string[] = [];
  out.push(`**【缺陷汇总】${stamp}　${projects.length} 个项目**`);
  out.push('');
  out.push(`合计：${lineOf(overall)}`);
  const ex = (opts.exclude || []).filter(Boolean);
  if (ex.length) out.push(`人员分布已排除：${ex.join('、')}`);
  if (opts.sinceLabel) out.push(`统计范围：${opts.sinceLabel}`);
  out.push('');

  out.push('| 项目 | 缺陷 | 已修复 | 修复率 | 未修复 | 待验证 | 已关闭 |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const p of projects) {
    out.push(`| ${p.name} | ${p.stat.total} | ${p.stat.fixed} | ${p.stat.rate}% | ${p.stat.active} | ${p.stat.resolved} | ${p.stat.closed} |`);
  }
  out.push(`| **合计** | **${overall.total}** | **${overall.fixed}** | **${overall.rate}%** | **${overall.active}** | **${overall.resolved}** | **${overall.closed}** |`);

  if (opts.withModules !== false) {
    const withMods = projects.filter(p => p.modules.length);
    if (withMods.length) {
      out.push('');
      out.push('**模块明细**');
      out.push('');
      out.push('| 项目 | 模块 | 缺陷 | 已修复 | 未修复 | 待验证 |');
      out.push('|---|---|---:|---:|---:|---:|');
      for (const p of withMods) {
        p.modules.forEach((m, mi) => {
          out.push(`| ${p.name} | （${mi + 1}）${m.name} | ${m.total} | ${m.fixed} | ${m.active} | ${m.resolved} |`);
        });
      }
    }
  }

  const persons = opts.persons || [];
  if (opts.withPersons !== false && persons.length) {
    const shown = opts.personLimit && opts.personLimit > 0 ? persons.slice(0, opts.personLimit) : persons;
    out.push('');
    out.push('**人员分布（按当前指派人）**');
    out.push('');
    out.push('| 人员 | 指派 | 占比 | 未修复 | 待验证 | 已修复 | 近 7 天新增 |');
    out.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const p of shown) {
      out.push(`| ${p.name} | ${p.total} | ${p.share}% | ${p.active} | ${p.resolved} | ${p.fixed} | ${p.recentNew} |`);
    }
    if (opts.unassigned) out.push(`| 未指派 | ${opts.unassigned} | - | - | - | - | - |`);
    out.push('');
    out.push(personsToText(persons, {
      unassigned: opts.unassigned || 0,
      closedCount: overall.closed,
      exclude: ex,
      skipped: opts.skipped || 0,
    }));
  }

  return out.join('\n');
}

/** CSV：项目 + 模块两级行，Excel 直接打开 */
export function summaryToCsv(
  projects: ProjectSummary[],
  overall: BugStat,
  opts: TextOpts = {},
): string {
  const rows: string[][] = [];
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const push = (proj: string, mod: string, s: BugStat) => {
    rows.push([proj, mod, String(s.total), String(s.fixed), String(s.rate), String(s.active),
      String(s.resolved), String(s.closed), String(s.openRate), String(s.recentNew), String(s.recentFixed)]
      .map(cell));
  };

  rows.push(['项目', '模块', '缺陷', '已修复', '修复率%', '未修复', '待验证', '已关闭', '未关闭修复率%', '近7天新增', '近7天修复']);
  for (const p of projects) {
    push(p.name, '（全部）', p.stat);
    if (opts.withModules !== false) {
      for (const m of p.modules) push(p.name, m.name, m);
    }
  }
  push('合计', '', overall);

  const persons = opts.persons || [];
  if (opts.withPersons !== false && persons.length) {
    rows.push([]);
    rows.push(['人员', '指派', '占比%', '未修复', '待验证', '已修复', '近7天新增', '近7天修复']);
    for (const p of persons) {
      rows.push([p.name, String(p.total), String(p.share), String(p.active), String(p.resolved),
        String(p.fixed), String(p.recentNew), String(p.recentFixed)].map(cell));
    }
    if (opts.unassigned) rows.push(['未指派', String(opts.unassigned), '', '', '', '', '', '']);
  }

  // 带 BOM，Excel 打开中文不乱码
  return '\ufeff' + rows.map(r => r.join(',')).join('\r\n');
}

export type SummaryFormat = 'text' | 'markdown' | 'csv';

export function summaryTo(
  format: SummaryFormat,
  projects: ProjectSummary[],
  overall: BugStat,
  opts: TextOpts = {},
): string {
  if (format === 'markdown') return summaryToMarkdown(projects, overall, opts);
  if (format === 'csv') return summaryToCsv(projects, overall, opts);
  return summaryToText(projects, overall, opts);
}

/** 只复制单个项目（含模块明细与该项目的指派分布） */
export function projectToText(p: ProjectSummary, at?: string): string {
  return summaryToText([p], p.stat, {
    at,
    withModules: true,
    persons: p.persons,
    unassigned: p.unassigned,
    skipped: p.skipped,
  });
}

/* ================================================================
   日报口径（对齐 zt_daily.py）
   ----------------------------------------------------------------
   窗口边界固定用「换日时间」（默认 17:30），不跟运行时刻走：
   领导随时点开都要是同一个区间。只有「总数环比」的基准取上一次统计快照。
   ================================================================ */

/** 'YYYY-MM-DD HH:mm(:ss)' → 'YYYY-MM-DD HH:mm'；只有日期时补 00:00 */
const hmOf = (v?: string) => {
  const s = String(v || '').trim();
  if (s.length >= 16) return s.slice(0, 16);
  if (s.length === 10) return `${s} 00:00`;
  return s;
};

export interface PeriodStat {
  /** 窗口起点 'YYYY-MM-DD HH:mm' */
  since: string;
  /** 窗口终点 'YYYY-MM-DD HH:mm' */
  until: string;
  /** 区间内提交的 */
  created: number;
  /** 区间内解决的（resolvedDate） */
  resolved: number;
  /** 区间内关闭的（closedDate） */
  closed: number;
}

/**
 * 统计一个区间内「新增 / 修复 / 关闭」三个量，口径同 zt_daily.py 的 in_window：
 * 左开右闭 (since, until]，因为边界那一秒不该被两个窗口都算一次。
 */
export function periodOf(bugs: ZentaoBug[], since: string, until: string): PeriodStat {
  const s = hmOf(since);
  const u = hmOf(until);
  let created = 0;
  let resolved = 0;
  let closed = 0;
  for (const b of bugs) {
    const o = hmOf(b.openedDate || b.date);
    if (o && o > s && o <= u) created += 1;
    const r = hmOf(b.resolvedDate);
    if (r && r > s && r <= u) resolved += 1;
    const c = hmOf(b.closedDate);
    if (c && c > s && c <= u) closed += 1;
  }
  return { since: s, until: u, created, resolved, closed };
}

/** (since, until] 之间的工作日数（周一到周五），最少按 1 天算 */
export function workdaysBetween(since: string, until: string): number {
  const a = new Date(`${String(since).slice(0, 10)}T00:00:00`);
  const b = new Date(`${String(until).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  let n = 0;
  const d = new Date(a);
  while (d < b) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay(); // 0 = 周日
    if (wd >= 1 && wd <= 5) n += 1;
  }
  return Math.max(1, n);
}

export interface Growth {
  /** 上次统计的时刻 */
  prevAt: string;
  prevTotal: number;
  /** 本次 - 上次 */
  delta: number;
  /** 增长百分比（分母是上次总数） */
  pct: number;
  workdays: number;
  /** 按工作日折算的日均增长百分比 */
  daily: number;
}

/** 缺陷总数的环比：分子分母都用「总数」，跟日报一致（不是新增量环比） */
export function growthOf(prevAt: string, prevTotal: number, curAt: string, curTotal: number): Growth | null {
  if (!prevAt || !prevTotal) return null;
  const wd = workdaysBetween(prevAt, curAt);
  const delta = curTotal - prevTotal;
  const pct = Math.round((delta / prevTotal) * 1000) / 10;
  return {
    prevAt: hmOf(prevAt),
    prevTotal,
    delta,
    pct,
    workdays: wd,
    daily: Math.round((pct / wd) * 10) / 10,
  };
}

/**
 * 把「安全工程师提交的」缺陷从功能缺陷里剔出来单独计数。
 * 禅道里这些属于渗透测试问题，混进来会把功能缺陷的总数和修复率带偏。
 */
export function splitSecurity(bugs: ZentaoBug[], names: string[]): { bugs: ZentaoBug[]; security: number } {
  const set = new Set((names || []).map(s => String(s).trim()).filter(Boolean));
  if (!set.size) return { bugs, security: 0 };
  const keep: ZentaoBug[] = [];
  let security = 0;
  for (const b of bugs) {
    if (set.has(String(b.openedBy || '').trim())) security += 1;
    else keep.push(b);
  }
  return { bugs: keep, security };
}

/** 安全问题统计（按「安全问题提交人」= 缺陷创建人筛选） */
export interface SecurityStat {
  total: number;
  closed: number;
  fixed: number;
  active: number;
  resolved: number;
  rate: number;
  /** 按严重程度分布：'1' 致命 / '2' 严重 / '3' 一般 / '4' 轻微 */
  bySeverity: Record<string, number>;
}

/**
 * 安全问题单独统计：只算 openedBy 命中名单的缺陷。
 * 口径与概览一致——已修复 = resolution 为 fixed（含已关闭），待验证 = 状态仍是「已解决」。
 */
export function securityStatOf(bugs: ZentaoBug[], names: string[]): SecurityStat {
  const set = new Set((names || []).map(n => String(n).trim()).filter(Boolean));
  const stat: SecurityStat = { total: 0, closed: 0, fixed: 0, active: 0, resolved: 0, rate: 0, bySeverity: {} };
  if (!set.size) return stat;
  for (const b of bugs) {
    if (!set.has(String(b.openedBy || '').trim())) continue;
    stat.total += 1;
    if (bugIsClosed(b)) stat.closed += 1;
    if (bugIsFixed(b)) stat.fixed += 1;
    const st = String(b.status || '');
    if (st === 'active') stat.active += 1;
    else if (st === 'resolved') stat.resolved += 1;
    const sev = String(b.severity || '').trim() || '0';
    stat.bySeverity[sev] = (stat.bySeverity[sev] || 0) + 1;
  }
  stat.rate = rateOf(stat.fixed, stat.total);
  return stat;
}

/** 安全问题明细清单：按状态（待修复 → 待验证 → 已关闭）与严重程度排序 */
export function securityBugs(bugs: ZentaoBug[], names: string[]): ZentaoBug[] {
  const set = new Set((names || []).map(n => String(n).trim()).filter(Boolean));
  if (!set.size) return [];
  const rank = (b: ZentaoBug) => {
    const st = String(b.status || '');
    if (st === 'active') return 0;
    if (st === 'resolved') return 1;
    if (st === 'closed') return 2;
    return 3;
  };
  return bugs
    .filter(b => set.has(String(b.openedBy || '').trim()))
    .sort((a, b) => rank(a) - rank(b)
      || String(a.severity || '9').localeCompare(String(b.severity || '9'))
      || Number(b.id) - Number(a.id));
}

/** 问题清单文本（复制到会议纪要 / 群里） */
export function securityListText(bugs: ZentaoBug[]): string {
  if (!bugs.length) return '暂无安全问题。';
  const sev = (b: ZentaoBug) => SEVERITY_LABELS[String(b.severity || '')] || '未分级';
  const st = (b: ZentaoBug) => ({ active: '待修复', resolved: '待验证', closed: '已关闭' } as Record<string, string>)[String(b.status || '')] || String(b.status || '');
  const lines = bugs.map((b, i) => `${i + 1}. #${b.id} ${b.title}（${sev(b)} · ${st(b)}${b.assignedTo ? ` · ${b.assignedTo}` : ''}）`);
  return [`安全问题清单（共 ${bugs.length} 条）`, ...lines].join('\n');
}

/** 一键复制的文案（固定格式，直接粘到群里/周报里） */
export function securityReportText(stat: SecurityStat): string {
  if (!stat.total) return '禅道中暂无安全缺陷。';
  return `禅道中共记录安全缺陷 ${stat.total} 个，其中已关闭 ${stat.closed} 个，`
    + `已修复 ${stat.fixed} 个，待修复 ${stat.active} 个，`
    + `另有 ${stat.resolved} 个已解决待验证，修复率${stat.rate}%。`;
}

export interface ReportInput {
  name: string;
  stat: BugStat;
  period: PeriodStat;
  growth: Growth | null;
  persons: PersonRow[];
  /** 人员分布里被剔除的人数（用于「已剔除测试人员 / 已剔除 N 人」） */
  excludedCount: number;
  /** 被剔除的人是否恰好是标记的测试人员 */
  excludedAreTesters: boolean;
  modules: { name: string; total: number; active: number }[];
  security: number;
}

/** 一行：人员分布（日报口径，只列有人的人） */
const personLineOf = (r: ReportInput) => {
  const head = r.excludedAreTesters && r.excludedCount > 0
    ? '人员分布（按当前指派，已剔除测试人员）'
    : r.excludedCount > 0
      ? `人员分布（按当前指派，已剔除 ${r.excludedCount} 人）`
      : '人员分布（按当前指派）';
  const total = r.persons.reduce((s, p) => s + p.total, 0);
  if (!r.persons.length) return `${head}：当前无在办缺陷挂在个人名下。`;
  const items = r.persons.map(p => `${p.name} ${p.total} 个`).join('、');
  return `${head}共 ${total} 个：${items}。`;
};

/** 模块分布：编号分点、一个模块一行（日报/一键复制共用） */
const moduleLineOf = (r: ReportInput) => {
  if (!r.modules.length) return '';
  const total = r.modules.reduce((s, m) => s + m.total, 0);
  const items = r.modules.map((m, i) => `（${i + 1}）${m.name} ${m.total} 个（待修复 ${m.active}）`);
  return `\n模块分布（全部缺陷，括号内为当前待修复数）共 ${total} 个：\n${items.join('\n')}\n`;
};

/** 一个项目的整段日报正文（不含标题行） */
export function reportParaOf(r: ReportInput, at: string): string {
  const hm = hmOf(at).slice(11, 16);
  const s = r.stat;
  const parts: string[] = [];
  parts.push(
    `截至 ${hm}，禅道中共记录缺陷 ${s.total} 个，其中已关闭 ${s.closed} 个，已修复 ${s.fixed} 个，`
    + `待修复 ${s.active} 个，另有 ${s.resolved} 个已解决待验证，修复率 ${s.rate}%。`,
  );
  parts.push(
    `本期（${r.period.since.slice(5)} — ${r.period.until.slice(5)}）新增 ${r.period.created} 个、`
    + `修复 ${r.period.resolved} 个、关闭 ${r.period.closed} 个。`,
  );
  if (r.growth) {
    parts.push(
      `缺陷总数较上次统计（${r.growth.prevAt.slice(5)}，${r.growth.prevTotal} 个）`
      + `净增 ${r.growth.delta} 个，增长 ${r.growth.pct}%；该区间含 ${r.growth.workdays} 个工作日，`
      + `按工作日计日均增长 ${r.growth.daily}%。`,
    );
  } else {
    parts.push('本次为首次统计，暂无环比基准。');
  }
  parts.push(personLineOf(r));
  const ml = moduleLineOf(r);
  if (ml) parts.push(ml);
  if (r.security > 0) parts.push(`（另有安全问题 ${r.security} 个，由安全工程师提交，单独统计，未计入上述数据。）`);
  return parts.join('');
}

/**
 * 完整日报：标题 + 每个项目一段。
 * 单项目时和定时任务输出的一致，多项目时按项目分段（每段前面带项目名）。
 */
export function dailyReportText(list: ReportInput[], at: string): string {
  const stamp = hmOf(at);
  const title = list.length === 1
    ? `【${list[0].name}】禅道缺陷日报　${stamp}`
    : `【缺陷汇总】禅道缺陷日报　${stamp}　${list.length} 个项目`;
  const body = list.map((r, i) => (list.length === 1 ? reportParaOf(r, at) : `${i + 1}. ${r.name}\n${reportParaOf(r, at)}`));
  return [title, '', ...body].join('\n');
}
