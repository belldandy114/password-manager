import React, { useState } from 'react';
import { Page, PageHead, Empty, Icons } from '../components/ui';

/**
 * 代码生成（开发辅助）—— 1.33.0 的「接线 + 空壳」。
 *
 * 本页最终承载两项（见 docs/拆分-渲染层.md §3.1）：
 *   ① 1.1 OpenAPI/Swagger → Java RestAssured 测试骨架
 *   ② 1.2 元素库（可视化维护定位器）→ Java Playwright POM
 *
 * 本批（W1-B）只做接线与空壳：**不引用任何集合类型、不调任何尚未实现的 IPC**，
 * 页签内的解析 / 生成 / 保存留给 W4；生成器是渲染层纯函数（零新 IPC）。
 *
 * 页签容器用 `.tabs` + `.tab2`（与笔记 / 缺陷管理 / 用例库页面同一形态），
 * **不用 `.toolbar`**：它自带 `--z-toolbar: 20` 且会被 `.pm-main .toolbar` 卡片化，
 * 拿它当页签条会给后续浮层埋层级雷（ui 的 docs/视觉-开发辅助.md §3）。
 */

const TABS = [
  { id: 'openapi', label: 'OpenAPI → 骨架' },
  { id: 'pom', label: '元素库 → POM' },
] as const;

type TabId = typeof TABS[number]['id'];

export function CodeGen() {
  const [tab, setTab] = useState<TabId>('openapi');
  const active = TABS.find(t => t.id === tab) || TABS[0];

  return (
    <Page>
      <PageHead
        icon={<Icons.terminal size={16} />}
        title="代码生成"
        desc="OpenAPI/Swagger 与页面元素库 → Java 测试骨架（RestAssured / Playwright POM）。文件只在本机保存，不上传、不联网。"
      />

      <div className="tabs" role="tablist" aria-label="代码生成">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`codegen-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`codegen-panel-${t.id}`}
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
        id={`codegen-panel-${tab}`}
        aria-labelledby={`codegen-tab-${tab}`}
        tabIndex={0}
      >
        <div className="pnl-body">
          <Empty
            icon={<Icons.tool size={22} />}
            title={`${active.label}：待实现（W2–W6）`}
            desc="本批只完成页面接线与两个页签的空壳；解析、代码生成与另存为会在 W4 落地。"
            hint="当前没有可操作的内容，先别在这里找按钮——生成器还没进来。"
          />
        </div>
      </div>
    </Page>
  );
}