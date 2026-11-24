import React, { useState } from 'react';
import { Page, PageHead, Empty, Icons } from '../components/ui';

/**
 * 资产台账（开发辅助）—— 1.33.0 的「接线 + 空壳」。
 *
 * 本页最终承载两项（见 docs/拆分-渲染层.md §3.3）：
 *   ① 4.1 接口覆盖矩阵（三态：已覆盖 / 未覆盖 / 无法判定，无法判定必须给原因）
 *   ② 4.2 用例 ↔ 脚本映射（手工维护 + 规范化 CSV 导入；明确不支持 xmind / Excel 解析）
 *
 * 本批（W1-B）只做接线与空壳：**不引用任何集合类型（coverageRuns / caseMap 在 W1-A）**、
 * 不调任何尚未实现的 IPC；页签内的取数与导入留给 W5。
 */

const TABS = [
  { id: 'coverage', label: '覆盖矩阵' },
  { id: 'caseMap', label: '用例映射' },
] as const;

type TabId = typeof TABS[number]['id'];

export function AssetLedger() {
  const [tab, setTab] = useState<TabId>('coverage');
  const active = TABS.find(t => t.id === tab) || TABS[0];

  return (
    <Page>
      <PageHead
        icon={<Icons.list size={16} />}
        title="资产台账"
        desc="接口集合与代码引用对齐成覆盖矩阵，再把用例编号映射到具体脚本上。台账支持手工维护与规范化 CSV 导入。"
      />

      <div className="tabs" role="tablist" aria-label="资产台账">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`assetledger-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`assetledger-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`tab2${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div
        className="pnl"
        role="tabpanel"
        id={`assetledger-panel-${tab}`}
        aria-labelledby={`assetledger-tab-${tab}`}
        tabIndex={0}
      >
        <div className="pnl-body">
          <Empty
            icon={<Icons.db size={22} />}
            title={`${active.label}：待实现（W2–W6）`}
            desc="覆盖矩阵会同时给「已覆盖 / 未覆盖 / 无法判定」三个数和分母，不给单一百分比；用例映射只接受规范化 CSV，不支持 xmind / Excel 解析。"
            hint="本批只有接线与空壳；取数、导入与保存会在 W5 落地。"
          />
        </div>
      </div>
    </Page>
  );
}