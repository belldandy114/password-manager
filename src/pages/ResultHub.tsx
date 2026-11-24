import React, { useState } from 'react';
import { Page, PageHead, Empty, Icons } from '../components/ui';

/**
 * 结果中心（开发辅助）—— 1.33.0 的「接线 + 空壳」。
 *
 * 本页最终承载两项（见 docs/拆分-渲染层.md §3.4）：
 *   ① 5.1 Allure results 解析：用例数、失败聚类 Top N、flaky 追踪（flaky 必须显示分母）
 *   ② 5.2 `.jtl` 指标：P50/P90/P95/P99、TPS、按接口错误 Top N（分位数按最近秩法，均值不作达标依据）
 *
 * 本批（W1-B）只做接线与空壳：**不引用任何集合类型（allureRuns 在 W1-A）**、
 * 不调任何尚未实现的 IPC（allure:* / jmeter:analyze-jtl 在 W1-A 与 W6）。
 */

const TABS = [
  { id: 'allure', label: 'Allure' },
  { id: 'jtl', label: '.jtl 指标' },
] as const;

type TabId = typeof TABS[number]['id'];

export function ResultHub() {
  const [tab, setTab] = useState<TabId>('allure');
  const active = TABS.find(t => t.id === tab) || TABS[0];

  return (
    <Page>
      <PageHead
        icon={<Icons.chart size={16} />}
        title="结果中心"
        desc="把跑完的结果读回来：Allure results 的失败聚类与 flaky，JMeter .jtl 的分位数与按接口错误。只读本地目录与文件。"
      />

      <div className="tabs" role="tablist" aria-label="结果中心">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`resulthub-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`resulthub-panel-${t.id}`}
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
        id={`resulthub-panel-${tab}`}
        aria-labelledby={`resulthub-tab-${tab}`}
        tabIndex={0}
      >
        <div className="pnl-body">
          <Empty
            icon={<Icons.chart size={22} />}
            title={`${active.label}：待实现（W2–W6）`}
            desc="结果只读不改：不执行附件、不解析 HTML 报告，命中内容不出本机。选目录 / 选文件与指标展示会在 W6 落地。"
            hint="本批只有接线与空壳，页签里暂时没有可点的动作。"
          />
        </div>
      </div>
    </Page>
  );
}