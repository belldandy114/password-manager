/**
 * 代码工具（开发辅助）—— 1.36.0（B5）把「代码生成」与「代码体检」并成**一个页面**。
 *
 * 结构（裁定 Z1）：**扁平三页签**，同页只有一条 `.tabs` / 一个 `role=tablist`：
 * `OpenAPI → 骨架` ／ `元素库 → POM` ／ `代码体检`。默认第 1 个。
 * 为什么不按方案 §11.3 的字面「外层两页签（代码生成 / 代码体检）」做：代码生成本来就有两个页签，
 * 再套一层＝**两层 `role=tablist` 嵌套**，读屏用户分不清层级，视觉上也是两条并排的横线。
 * 要禁的是「tablist 嵌套」，不是「几层」——扁平三条同时满足「代码生成两页签仍可达」「不嵌套」。
 *
 * 三个面板**始终挂载、靠 `hidden` 互斥**（不是条件渲染）：
 * `ElementLibTab` 的「页面草稿」在它自己的 state 里，条件渲染会在切页签时把没保存的编辑丢掉
 * （B5 验收的一条硬要求就是「状态不丢」）。代价是隐藏面板的元素仍算在 DOM 里 ——
 * 玻璃扫描因此把这页的 `dev*` 自证限定在 `[role=tabpanel]:not([hidden])`（见脚本内注释）。
 *
 * 两块子功能各自的四条规矩仍在：见 `components/codegen/OpenApiTab.tsx` 与
 * `components/codeaudit/AuditTab.tsx` 的文件头（本批**一行未改**它们）。
 *
 * 存储：两块都走既有集合（`pomPages` / `scanRuns`），经 `useCollection`（`ws:get`/`ws:set`），
 * **不新造存储、不加 IPC**（[C-81]）。
 */

import { useState } from 'react';
import { Page, PageHead, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { useConfirm } from '../components/confirm';
import { OpenApiTab } from '../components/codegen/OpenApiTab';
import { ElementLibTab } from '../components/codegen/ElementLibTab';
import { AuditTab } from '../components/codeaudit/AuditTab';

export type CodeToolTab = 'openapi' | 'pom' | 'audit';

/** 页签顺序固定：代码生成的两块在前（原有顺序不变），代码体检在后 */
const TABS: { id: CodeToolTab; label: string }[] = [
  { id: 'openapi', label: 'OpenAPI → 骨架' },
  { id: 'pom', label: '元素库 → POM' },
  { id: 'audit', label: '代码体检' },
];

/**
 * @param initialTab 老路由 `codeAudit` 进来时落「代码体检」页签（双 key 方案，裁定 A-7）；
 *                   从 `codeGen` 进来落默认的「OpenAPI → 骨架」。
 */
export function CodeTools({ initialTab = 'openapi' }: { initialTab?: CodeToolTab }) {
  const [tab, setTab] = useState<CodeToolTab>(initialTab);
  const { toasts, addToast, removeToast } = useToast();
  const { ask, confirmNode } = useConfirm();

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.terminal size={16} />}
          title="代码工具"
          desc="OpenAPI/Swagger 与页面元素库 → Java 测试骨架（RestAssured / Playwright POM）；另可只读扫描本机代码目录找可疑写法。文件只在本机保存，不上传、不联网。"
        />

        <div className="tabs" role="tablist" aria-label="代码工具">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`codetools-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`codetools-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab2${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* 三个面板常挂、靠 hidden 互斥（理由见文件头）。不要改成 `tab === 'x' && <X/>`： */}
        {/* 那会让元素库的未保存草稿在切页签时丢掉。 */}
        <div role="tabpanel" id="codetools-panel-openapi" aria-labelledby="codetools-tab-openapi" hidden={tab !== 'openapi'}>
          <OpenApiTab addToast={addToast} />
        </div>
        <div role="tabpanel" id="codetools-panel-pom" aria-labelledby="codetools-tab-pom" hidden={tab !== 'pom'}>
          <ElementLibTab addToast={addToast} ask={ask} />
        </div>
        <div role="tabpanel" id="codetools-panel-audit" aria-labelledby="codetools-tab-audit" hidden={tab !== 'audit'}>
          <AuditTab addToast={addToast} />
        </div>
      </Page>
      {confirmNode}
    </div>
  );
}
