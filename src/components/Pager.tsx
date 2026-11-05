import React from 'react';

/** 通用分页器：列表底部一行，左侧统计、右侧翻页 */
export function Pager({
  total, page, pageSize, onPage, onPageSize, pageSizes = [50, 100, 200],
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize?: (n: number) => void;
  pageSizes?: number[];
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (cur - 1) * pageSize + 1;
  const to = Math.min(total, cur * pageSize);

  return (
    <div className="pager">
      <span className="pager-info">
        第 {from}–{to} 条，共 {total} 条
      </span>
      <div className="pager-ctrl">
        {onPageSize && (
          <select
            className="pager-size"
            value={pageSize}
            onChange={e => { onPageSize(Number(e.target.value)); onPage(1); }}
            title="每页条数"
          >
            {pageSizes.map(n => <option key={n} value={n}>{n} 条/页</option>)}
          </select>
        )}
        <button className="pager-btn" disabled={cur <= 1} onClick={() => onPage(1)} title="第一页">«</button>
        <button className="pager-btn" disabled={cur <= 1} onClick={() => onPage(cur - 1)} title="上一页">‹</button>
        <span className="pager-cur">{cur} / {pages}</span>
        <button className="pager-btn" disabled={cur >= pages} onClick={() => onPage(cur + 1)} title="下一页">›</button>
        <button className="pager-btn" disabled={cur >= pages} onClick={() => onPage(pages)} title="最后一页">»</button>
      </div>
    </div>
  );
}
