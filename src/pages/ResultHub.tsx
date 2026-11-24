/**
 * 结果中心（模块 5.1 Allure / 5.2 .jtl 指标）。
 *
 * 三条口径写死在这一页里，都是「数字长得像但意思完全不同」的那种坑：
 *
 * 1. **flaky 必须带分母**（[C-38] / AC-11）。`1/3` 和 `3/3` 都叫"flaky"，但前者是偶发、后者是必挂，
 *    只给用例名等于没给判据。所以表里固定列「失败/运行」，形如 `1/3`。
 * 2. **skippedFiles 与 skipped 是两个数**（[C-63]）：前者是「跳过的**文件**数」（附件、非结果文件），
 *    后者是「用例状态为 skipped 的**用例**数」。混用会让用户以为"跳过了 3 个用例"，其实跳的是附件。
 * 3. **.jtl 的数字必须和真实文件对得上**：`AI(3)-2026-11-20_15-24-59.jtl` 的 t17 结论是
 *    700 样本 / 100 错误 / 14.29% / tps 51.6。界面只做展示，不自己算分位数——
 *    一旦显示的数与后端不一致，就是取错字段，不是「显示问题」。
 *
 * 视觉：状态词用 `.dev-tag`（`.pill-*` 压玻璃 2.78:1 不达标）；大表套 `.dev-scroll`
 * （`.pnl` 是 `overflow:hidden`，不套会裁列）；计数卡复用既有 `.home-stats` / `.home-stat`；不写 css。
 */

const TABS = [
  { id: 'allure', label: 'Allure' },
  { id: 'jtl', label: '.jtl 指标' },
] as const;

type TabId = typeof TABS[number]['id'];


import { useState } from 'react';
import { Page, PageHead, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { AllureTab } from '../components/resulthub/AllureTab';
import { JtlTab } from '../components/resulthub/JtlTab';

export function ResultHub() {
  const [tab, setTab] = useState<TabId>('allure');
  const { toasts, addToast, removeToast } = useToast();

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.chart size={16} />}
          title="结果中心"
          desc="把 Allure 结果目录和 JMeter .jtl 读成可比的数字：用例分布、失败聚类、flaky 追踪、分位耗时与按接口错误。全部只在本机解析，不上传。"
        />

        <div className="tabs" role="tablist" aria-label="结果中心">
          {TABS.map((t) => (
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

        <div role="tabpanel" id={`resulthub-panel-${tab}`} aria-labelledby={`resulthub-tab-${tab}`}>
          {tab === 'allure' ? <AllureTab addToast={addToast} /> : <JtlTab addToast={addToast} />}
        </div>
      </Page>
    </div>
  );
}