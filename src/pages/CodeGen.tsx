/**
 * 代码生成（开发辅助）—— 1.1 OpenAPI → RestAssured 骨架 ／ 1.2 元素库 → Java POM。
 *
 * 页签壳是 t13 定的（`.tabs` + `.tab2`，不用 `.toolbar`：它自带 `--z-toolbar: 20`，
 * 当页签条会给后续浮层埋层级雷）。本批把它接成**真页面**。
 *
 * 四条贯穿全页的规矩（都是踩出来才写下的）：
 *
 * 1. **两条导入路径并列**：选文件（`file:pick` → `file:read-text`，扩展名白名单含 `.yaml`/`.yml`）
 *    与粘贴文本。§8 的 1.1 验收明确要求「真选文件」能跑通，只做粘贴不算。
 * 2. **告警必须常显**：`parseOpenApi` 的 `warnings[]` 是用户判断「导入是否完整」的唯一依据
 *    （webhooks / callbacks / oneOf / discriminator 都在这），所以**一条一行、默认展开、
 *    没有「更多」折叠**。折叠起来等于把「你少了 40 个接口」藏起来。
 * 3. **生成 ≠ 保存**：代码生成是纯函数（[C-81]），保存是另一次由用户点的动作
 *    （`file:save-text` 会弹系统保存框）。绝不「点生成就写盘」——那是覆盖用户文件。
 * 4. **三态 / 四态齐全**：空态、解析中（按钮 disabled）、解析失败（`role="alert"`）、
 *    0 接口（解析成功但没内容，文案要说清为什么）、生成失败、未解锁。
 *
 * 视觉口径（css 全归 ui，本页一行样式都不写）：结论标签只用 `.dev-tag`（`is-ok/is-warn/
 * is-unverified/is-fail`），**不用 `.pill-*`**（压玻璃实测最差 2.78:1）；大表一律套 `.dev-scroll`
 * （`.pnl` 是 `overflow:hidden`，不套会把右侧列裁掉）；表格 `tableLayout:'fixed'` + 内联列宽。
 *
 * 存储：元素库走既有 `pomPages` 集合（[C-18] 全复数键名，`WorkspaceKey` 里已有），
 * 经 `useCollection` 读写（内部就是 `ws:get`/`ws:set`），**不新造存储、不加 IPC**（[C-81]）。
 */


import { useState } from 'react';
import { Page, PageHead, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { useConfirm } from '../components/confirm';
import { OpenApiTab } from '../components/codegen/OpenApiTab';
import { ElementLibTab } from '../components/codegen/ElementLibTab';

/* ================================================================
   页面
   ================================================================ */

const TABS = [
  { id: 'openapi', label: 'OpenAPI → 骨架' },
  { id: 'pom', label: '元素库 → POM' },
] as const;

type TabId = typeof TABS[number]['id'];

export function CodeGen() {
  const [tab, setTab] = useState<TabId>('openapi');
  const { toasts, addToast, removeToast } = useToast();
  const { ask, confirmNode } = useConfirm();

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.terminal size={16} />}
          title="代码生成"
          desc="OpenAPI/Swagger 与页面元素库 → Java 测试骨架（RestAssured / Playwright POM）。文件只在本机保存，不上传、不联网。"
        />

        <div className="tabs" role="tablist" aria-label="代码生成">
          {TABS.map((t) => (
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

        <div role="tabpanel" id={`codegen-panel-${tab}`} aria-labelledby={`codegen-tab-${tab}`}>
          {tab === 'openapi'
            ? <OpenApiTab addToast={addToast} />
            : <ElementLibTab addToast={addToast} ask={ask} />}
        </div>
      </Page>
      {confirmNode}
    </div>
  );
}