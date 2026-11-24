/**
 * 代码体检 / Git 影响面（模块 3 与 6）。
 *
 * 这一页最容易做错的三件事，代码里都对着一一处理：
 *
 * 1. **判不出来就说判不出来**。体检的结论标签只有 `启发式命中`（`pack='audit'` 全部是启发式，
 *    不是语法树分析）；影响面里对不上的文件进 `unmapped`，**不塞进「受影响脚本」凑数**。
 * 2. **台账为空 ≠ 没有影响**。`caseMaps` 空时 `gitImpact` 返回 `status='empty-maps'`，
 *    页面必须显示「无映射数据，无法计算影响面」，绝不允许渲染成「影响 0 个脚本」。
 * 3. **跳过几个符号链接要说出来**（[C-54]）。「已扫 812 个文件」不写「跳过 12 个符号链接」，
 *    这个数字就不可信——用户没法判断这次扫描完不完整。
 *
 * 视觉：三态标签用 `.dev-tag`（`.pill-*` 压玻璃 2.78:1 不达标）；两张表都套 `.dev-scroll`
 * （`.pnl` 是 `overflow:hidden`，不套会裁列）；不写 css、不改 `types.ts`。
 */

import { useState } from 'react';
import { Page, PageHead, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { AuditTab } from '../components/codeaudit/AuditTab';
import { GitImpactTab } from '../components/codeaudit/GitImpactTab';

const TABS = [
  { id: 'audit', label: '代码体检' },
  { id: 'impact', label: 'Git 影响面' },
] as const;

type TabId = typeof TABS[number]['id'];

export function CodeAudit() {
  const [tab, setTab] = useState<TabId>('audit');
  const { toasts, addToast, removeToast } = useToast();

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.bug size={16} />}
          title="代码体检"
          desc="只读扫描本机代码目录找可疑写法，再把代码改动换算成「该跑哪些用例脚本」。扫描结果只在本机展示，不写日志、不联网。"
        />

        <div className="tabs" role="tablist" aria-label="代码体检">
          {TABS.map((t) => (
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

        <div role="tabpanel" id={`codeaudit-panel-${tab}`} aria-labelledby={`codeaudit-tab-${tab}`}>
          {tab === 'audit' ? <AuditTab addToast={addToast} /> : <GitImpactTab addToast={addToast} />}
        </div>
      </Page>
    </div>
  );
}