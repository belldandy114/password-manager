import React from 'react';

/**
 * 页面懒加载骨架屏（1.26.0）。
 *
 * 以前 fallback 只有居中一行「正在加载…」，切页时会先看到一片空白再「砰」地出内容；
 * 现在按页面通用结构给出占位（页头 / 概览卡 / 列表面板），视觉上是「在加载」而不是「没反应」。
 *
 * 纯装饰：`aria-hidden` + 外层 role=status 播报一次，读屏不会把灰块念一遍。
 */
export function PageSkeleton() {
  return (
    <div className="content-area page-skel" role="status" aria-label="页面加载中">
      <div className="pg" aria-hidden="true">
        <div className="ps-head">
          <span className="ps-bar ps-title" />
          <span className="ps-bar ps-sub" />
          <span className="ps-actions">
            <span className="ps-bar ps-btn" />
            <span className="ps-bar ps-btn" />
          </span>
        </div>
        <div className="ps-cards">
          {[0, 1, 2].map(i => (
            <div key={i} className="ps-card">
              <span className="ps-bar ps-num" />
              <span className="ps-bar ps-line is-short" />
            </div>
          ))}
        </div>
        <div className="ps-panel">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="ps-row">
              <span className="ps-bar ps-dot" />
              <span className="ps-bar ps-line" />
              <span className="ps-bar ps-line is-tail" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
