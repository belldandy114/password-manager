import React, { useMemo, useState } from 'react';
import type { ZentaoBug } from '../types';
import { moduleWeekHeatmap } from '../utils/bugSummary';
import { Icons } from './ui';

/**
 * 缺陷热力图：模块 × 周。
 *
 * 回答两个不同的问题：
 * - 「新增口径」（默认）：哪几周、哪些模块集中爆问题 —— 按提交日期分桶；
 * - 「遗留口径」：现在还没修的都压在哪些模块 —— 只算未修复/未关闭的，不看提交时间。
 *
 * 模块取完整路径的最后一段，跨项目同名短模块合并；超出行数的模块合并成「其他」。
 */
export function ZentaoHeatmap({
  bugs, cutoffMin, exclude, now,
}: {
  bugs: ZentaoBug[];
  cutoffMin: number;
  exclude: string[];
  now: Date;
}) {
  const [weeks, setWeeks] = useState(8);
  const [onlyOpen, setOnlyOpen] = useState(false);

  const h = useMemo(
    () => moduleWeekHeatmap(bugs, {
      weeks, cutoffMin, exclude: new Set(exclude), now, onlyOpen, topN: 12,
    }),
    [bugs, weeks, cutoffMin, exclude, now, onlyOpen],
  );

  /** 0 = 空，1..5 = 深浅档位（按占最大值的比例分档，避免个别极值把其余都压成浅色） */
  const levelOf = (v: number) => {
    if (!v) return 0;
    if (!h.max) return 1;
    return Math.max(1, Math.min(5, Math.ceil((v / h.max) * 5)));
  };

  const total = h.rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="zt-heat">
      <div className="zt-heat-bar">
        <div className="zt-heat-toggle" role="group" aria-label="统计口径">
          <button
            className={`zt-heat-seg${onlyOpen ? '' : ' is-on'}`}
            onClick={() => setOnlyOpen(false)}
            title="按提交日期分周，看哪几周集中爆问题"
          >按新增</button>
          <button
            className={`zt-heat-seg${onlyOpen ? ' is-on' : ''}`}
            onClick={() => setOnlyOpen(true)}
            title="只算当前未修复/未关闭的，看遗留压在哪些模块"
          >按遗留</button>
        </div>
        <span className="zt-heat-spacer" />
        <label className="zt-heat-inline">
          范围
          <select value={weeks} onChange={e => setWeeks(Number(e.target.value))} aria-label="周数范围">
            <option value={4}>最近 4 周</option>
            <option value={6}>最近 6 周</option>
            <option value={8}>最近 8 周</option>
            <option value={12}>最近 12 周</option>
            <option value={16}>最近 16 周</option>
            <option value={26}>最近 26 周（半年）</option>
            <option value={52}>最近 52 周（一年）</option>
            <option value={104}>最近 104 周（两年）</option>
          </select>
        </label>
        <span className="zt-heat-sum">
          共 <b>{total}</b> 个 · <b>{h.rows.length}</b> 个模块
          {h.mergedModules > 0 && <em>（含其他 {h.mergedModules} 个）</em>}
        </span>
      </div>

      {h.rows.length === 0 ? (
        <div className="zt-sum-empty" style={{ padding: '18px 16px' }}>
          {onlyOpen ? '没有未修复的缺陷' : '所选范围内没有缺陷记录'}
        </div>
      ) : (
        <div className="zt-heat-scroll">
          <table className="zt-heat-table">
            <thead>
              <tr>
                <th className="zt-heat-mod">模块</th>
                {h.weeks.map((w, i) => (
                  <th key={w} title={`${w} 起的一周`}>
                    {/* 半年/一年档位下每列都标日期会糊成一片，隔 4 周标一个 */}
                    {h.weeks.length > 20 ? (i % 4 === 0 ? w.slice(5) : '') : w.slice(5)}
                  </th>
                ))}
                <th className="zt-heat-total">合计</th>
              </tr>
            </thead>
            <tbody>
              {h.rows.map((r) => (
                <tr key={r.module}>
                  <th className="zt-heat-mod" title={r.module}>{r.module}</th>
                  {r.counts.map((v, i) => (
                    <td key={`${r.module}-${h.weeks[i]}`}>
                      <span
                        className={`zt-heat-cell is-${levelOf(v)}`}
                        title={`${r.module} · ${h.weeks[i]} 起的一周 · ${v} 个`}
                      >
                        {v || ''}
                      </span>
                    </td>
                  ))}
                  <td className="zt-heat-total">{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="zt-heat-foot">
        <span>
          <Icons.chart size={12} /> 颜色越深表示同一周内该模块缺陷越多；格子来自
          {onlyOpen ? '当前未修复/未关闭' : '提交日期'}，按周一分桶
          {cutoffMin > 0 ? `（换日时间 ${String(Math.floor(cutoffMin / 60)).padStart(2, '0')}:${String(cutoffMin % 60).padStart(2, '0')}）` : ''}
        </span>
      </div>
    </div>
  );
}
