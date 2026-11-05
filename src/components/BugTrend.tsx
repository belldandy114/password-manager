import React, { useMemo } from 'react';
import type { ZentaoBug } from '../types';

/** 一周的起止（周一 ~ 周日），offset=0 表示本周 */
function weekStart(offset: number): Date {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;           // 周一 = 0
  const d = new Date(now);
  d.setDate(now.getDate() - dow - offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

const fmtDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 落在 [start, end] 的日期字符串数量 */
const inWeek = (date: string | undefined, start: string, end: string) =>
  !!date && date.slice(0, 10) >= start && date.slice(0, 10) <= end;

interface Point { label: string; added: number; resolved: number; closed: number }

/**
 * 近 N 周的趋势折线：新增 / 解决 / 关闭。
 * 纯 SVG 手绘，不引图表库（要跟着主题色走，体积也小）。
 */
export function BugTrend({ bugs, weeks = 8 }: { bugs: ZentaoBug[]; weeks?: number }) {
  const data = useMemo<Point[]>(() => {
    const out: Point[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const mon = weekStart(i);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      const start = fmtDate(mon);
      const end = fmtDate(sun);
      out.push({
        label: start.slice(5),
        added: bugs.filter(b => inWeek(b.date, start, end)).length,
        resolved: bugs.filter(b => inWeek(b.resolvedDate, start, end)).length,
        closed: bugs.filter(b => inWeek(b.closedDate, start, end)).length,
      });
    }
    return out;
  }, [bugs, weeks]);

  const max = Math.max(1, ...data.map(d => Math.max(d.added, d.resolved, d.closed)));

  // 绘图区（viewBox 固定，宽度交给 CSS 拉伸）
  const W = 640;
  const H = 168;
  const padL = 30;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const x = (i: number) => padL + (data.length <= 1 ? innerW / 2 : (innerW * i) / (data.length - 1));
  const y = (v: number) => padT + innerH - (innerH * v) / max;

  const pathOf = (pick: (p: Point) => number) =>
    data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');

  const total = {
    added: data.reduce((s, d) => s + d.added, 0),
    resolved: data.reduce((s, d) => s + d.resolved, 0),
    closed: data.reduce((s, d) => s + d.closed, 0),
  };

  const series = [
    { key: 'added', name: '新增', color: 'var(--accent)', total: total.added, d: pathOf(p => p.added) },
    { key: 'resolved', name: '解决', color: 'var(--warning)', total: total.resolved, d: pathOf(p => p.resolved) },
    { key: 'closed', name: '关闭', color: 'var(--success)', total: total.closed, d: pathOf(p => p.closed) },
  ];

  return (
    <div className="trend">
      <div className="trend-head">
        <div className="trend-legend">
          {series.map(s => (
            <span key={s.key} className="trend-legend-item">
              <i style={{ background: s.color }} />
              {s.name}
              <em>{s.total}</em>
            </span>
          ))}
        </div>
        <span className="trend-range">近 {weeks} 周 · 纵轴峰值 {max}</span>
      </div>
      <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="近几周缺陷趋势">
        {/* 横向网格线 */}
        {[0, 0.5, 1].map(r => (
          <line
            key={r}
            x1={padL} x2={W - padR}
            y1={padT + innerH * r} y2={padT + innerH * r}
            stroke="currentColor" strokeOpacity={0.12} strokeWidth={1}
          />
        ))}
        {/* 纵轴刻度 */}
        {[0, Math.round(max / 2), max].map((v, i) => (
          <text key={i} x={padL - 6} y={padT + innerH - (innerH * v) / max + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.45}>
            {v}
          </text>
        ))}
        {series.map(s => (
          <g key={s.key}>
            <path d={s.d} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
            {data.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y((p as any)[s.key])} r={2} fill={s.color}>
                <title>{`${data[i].label} 那一周：${s.name} ${(p as any)[s.key]}`}</title>
              </circle>
            ))}
          </g>
        ))}
        {/* 横轴标签：隔一个显示，避免拥挤 */}
        {data.map((p, i) => (
          (i % 2 === 0 || i === data.length - 1) && (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.5}>
              {p.label}
            </text>
          )
        ))}
      </svg>
    </div>
  );
}
