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

const inRange = (d: string | undefined, start: string, end: string) =>
  !!d && d.slice(0, 10) >= start && d.slice(0, 10) <= end;

const isClosed = (b: ZentaoBug) => String(b.status) === 'closed';
const isFixed = (b: ZentaoBug) => String(b.resolution) === 'fixed';

/**
 * 用「我的 Bug」生成本周周报草稿。
 * 只看指派人是我、且发生时间落在区间内的记录：新提 / 解决 / 关闭。
 */
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
