import React, { useState } from 'react';
import { Page, PageHead, Empty, Icons } from '../components/ui';

/**
 * 代码体检（开发辅助）—— 1.33.0 的「接线 + 空壳」。
 *
 * 本页最终承载两项（见 docs/拆分-渲染层.md §3.2）：
 *   ① 3 代码体检（UI 反模式 / 硬编码凭据 / 弱断言 / 依赖冲突）
 *   ② 6 Git Diff 影响面（只读：只跑白名单命令，不执行任何写命令）
 *
 * 两个功能共用一个「代码根目录」，所以放在同一页的两个页签里。
 * 本批（W1-B）只做接线与空壳：**不引用任何集合类型、不调任何尚未实现的 IPC**（scan:* / git:* 在 W1-A 与 W5/W6）。
 */

const TABS = [
  { id: 'audit', label: '代码体检' },
  { id: 'git', label: 'Git 影响面' },
] as const;

type TabId = typeof TABS[number]['id'];

export function CodeAudit() {
  const [tab, setTab] = useState<TabId>('audit');
  const active = TABS.find(t => t.id === tab) || TABS[0];

  return (
    <Page>
      <PageHead
        icon={<Icons.check size={16} />}
        title="代码体检"
        desc="按规则扫一遍代码根目录，再把改动文件与用例台账对上。只读扫描：不写、不删、不发网络请求。"
      />

      <div className="tabs" role="tablist" aria-label="代码体检">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`codeaudit-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`codeaudit-panel-${t.id}`}
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
        id={`codeaudit-panel-${tab}`}
        aria-labelledby={`codeaudit-tab-${tab}`}
        tabIndex={0}
      >
        <div className="pnl-body">
          <Empty
            icon={<Icons.search size={22} />}
            title={`${active.label}：待实现（W2–W6）`}
            desc="启发式检查，不是语法树分析：结果可能误报，也漏报；命中内容只在本机展示，不写日志、不进导出。选目录与扫描入口会在 W5 / W6 落地。"
            hint="本批只有接线与空壳，页签里暂时没有可点的动作。"
          />
        </div>
      </div>
    </Page>
  );
}