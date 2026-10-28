import type { ZentaoBug } from '../types';

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 本周（offset=0）/ 上周（offset=1）的周一到周日 */
export function weekRange(offset = 0): { start: string; end: string; friday: string } {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;           // 周一 = 0
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow - offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return { start: fmt(monday), end: fmt(sunday), friday: fmt(friday) };
}

/**
 * 下拉选项：offset 是「几周前」。
 * 1.6.0 这里写成 -i（0,-1,-2…），而 weekRange 的方向是「减去 offset*7 天」，
 * 于是「上周」实际取到了下一周（11.02~11.08），整份草稿/对比全错。
 * 现在把映射收进这里，并配了单测钉住顺序。
 */
export function weekOptions(count = 9): { offset: number; label: string; start: string; end: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const { start, end } = weekRange(i);
    const label = i === 0 ? '本周' : i === 1 ? '上周' : `${i} 周前`;
    return { offset: i, label, start, end };
  });
}

const inRange = (d: string | undefined, start: string, end: string) =>
  !!d && d.slice(0, 10) >= start && d.slice(0, 10) <= end;

const isClosed = (b: ZentaoBug) => String(b.status) === 'closed';
const isFixed = (b: ZentaoBug) => String(b.resolution) === 'fixed';

/** 一周的缺陷统计（本周/上周共用同一套口径，才能横向比） */
export interface WeekStats {
  start: string;
  end: string;
  created: number;
  resolved: number;
  closed: number;
  /** 截至区间末仍未关闭的总数 */
  unclosed: number;
  fatal: number;
  serious: number;
  byProject: { name: string; created: number; resolved: number; closed: number }[];
}

export function weekStats(bugs: ZentaoBug[], start: string, end: string): WeekStats {
  const created = bugs.filter(b => inRange(b.date, start, end));
  const resolved = bugs.filter(b => inRange(b.resolvedDate, start, end));
  const closed = bugs.filter(b => inRange(b.closedDate, start, end));

  const map = new Map<string, { created: number; resolved: number; closed: number }>();
  const touch = (name: string) => {
    const cur = map.get(name) || { created: 0, resolved: 0, closed: 0 };
    map.set(name, cur);
    return cur;
  };
  for (const b of created) touch(b.productName || '未分类').created++;
  for (const b of resolved) touch(b.productName || '未分类').resolved++;
  for (const b of closed) touch(b.productName || '未分类').closed++;

  const unclosed = bugs.filter(b => !isClosed(b));
  return {
    start, end,
    created: created.length,
    resolved: resolved.length,
    closed: closed.length,
    unclosed: unclosed.length,
    fatal: unclosed.filter(b => String(b.severity) === '1').length,
    serious: unclosed.filter(b => String(b.severity) === '2').length,
    byProject: Array.from(map.entries())
      .map(([name, c]) => ({ name, ...c }))
      .sort((a, b) => (b.created + b.resolved + b.closed) - (a.created + a.resolved + a.closed)),
  };
}

/** 本周 vs 上周：负值 = 比上周少 */
export function compareWeeks(bugs: ZentaoBug[], offset = 0): { cur: WeekStats; prev: WeekStats } {
  const a = weekRange(offset);
  const b = weekRange(offset + 1);
  return {
    cur: weekStats(bugs, a.start, a.end),
    prev: weekStats(bugs, b.start, b.end),
  };
}

/**
 * 群消息文案：短、整行、不依赖 Markdown。
 * 直接粘到企微/钉钉群里就能看，不用再手动删格式。
 */
export function buildGroupMessage(bugs: ZentaoBug[], start: string, end: string): string {
  const s = weekStats(bugs, start, end);
  const mmdd = (d: string) => d.slice(5).replace('-', '.');
  const lines: string[] = [];
  lines.push(`【测试周报 ${mmdd(start)}-${mmdd(end)}】`);
  lines.push(`缺陷：新提 ${s.created} / 解决 ${s.resolved} / 关闭 ${s.closed}`);
  lines.push(`未关闭：${s.unclosed}（致命 ${s.fatal}、严重 ${s.serious}）`);
  const top = s.byProject.filter(p => p.created + p.resolved + p.closed > 0).slice(0, 3);
  if (top.length) {
    lines.push('重点：');
    top.forEach(p => lines.push(`· ${p.name}：新提 ${p.created}、解决 ${p.resolved}、关闭 ${p.closed}`));
  }
  const fatalList = bugs.filter(b => !isClosed(b) && String(b.severity) === '1').slice(0, 3);
  if (fatalList.length) {
    lines.push('待处理：');
    fatalList.forEach(b => lines.push(`· #${b.id} ${b.title}`));
  }
  return lines.join('\n');
}
export function buildWeeklyDraft(bugs: ZentaoBug[], start: string, end: string): string {
  const created = bugs.filter(b => inRange(b.date, start, end));
  const resolved = bugs.filter(b => inRange(b.resolvedDate, start, end));
  const closed = bugs.filter(b => inRange(b.closedDate, start, end));

  /** 按项目分组计数 */
  const group = (list: ZentaoBug[]) => {
    const map = new Map<string, { created: number; resolved: number; closed: number }>();
    for (const b of list) {
      const key = b.productName || '未分类';
      const cur = map.get(key) || { created: 0, resolved: 0, closed: 0 };
      if (inRange(b.date, start, end)) cur.created++;
      if (inRange(b.resolvedDate, start, end)) cur.resolved++;
      if (inRange(b.closedDate, start, end)) cur.closed++;
      map.set(key, cur);
    }
    return Array.from(map.entries()).sort((a, b) =>
      (b[1].created + b[1].resolved + b[1].closed) - (a[1].created + a[1].resolved + a[1].closed));
  };

  const perProject = group([...created, ...resolved, ...closed]);
  const unclosed = bugs.filter(b => !isClosed(b));
  const fatal = unclosed.filter(b => String(b.severity) === '1');
  const serious = unclosed.filter(b => String(b.severity) === '2');

  const lines: string[] = [];
  lines.push('**一、本周工作**');
  lines.push('');
  lines.push(`1. 禅道缺陷（${start} ~ ${end}）：新提 ${created.length} 条、解决 ${resolved.length} 条、关闭 ${closed.length} 条`);
  perProject.forEach(([name, c], i) => {
    const parts = [];
    if (c.created) parts.push(`新提 ${c.created}`);
    if (c.resolved) parts.push(`解决 ${c.resolved}`);
    if (c.closed) parts.push(`关闭 ${c.closed}`);
    if (parts.length === 0) return;
    lines.push(`   （${i + 1}）${name}：${parts.join('、')}`);
  });
  lines.push('2. ');

  lines.push('');
  lines.push('**二、问题与风险**');
  lines.push('');
  lines.push(`1. 当前未关闭缺陷 ${unclosed.length} 条，其中致命 ${fatal.length} 条、严重 ${serious.length} 条`);
  fatal.slice(0, 5).forEach((b, i) => {
    lines.push(`   （${i + 1}）#${b.id} ${b.title}（${b.productName || '未分类'}）`);
  });
  if (fatal.length === 0) lines.push('   （1）本周无致命缺陷，重点关注严重级别');

  lines.push('');
  lines.push('**三、下周计划**');
  lines.push('');
  lines.push('1. ');

  return lines.join('\n');
}
