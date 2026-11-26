/**
 * 代码体检（1.36.0 B3：原「代码体检 / Git 影响面」两页签 → **单页**）。
 *
 * Git 影响面按 §11.1 的两问判定「删」（改代码→该跑哪些用例，属一次性结论，离开不用重来），
 * 所以这一页不再有页签。
 *
 * ⚠️ **不要**为了「保持结构一致」留一个只有单个页签的 `.tabs` 壳：空壳会让读屏用户
 * 看到一个只有一个选项的页签栏（无意义的交互层级），视觉上也是一条没有内容的横线。
 * 方案 §3.5 与本批验收都写死 `.pg .tabs = 0`、`.tab2 = 0`。
 *
 * 仍然成立的两条口径（改盘点逻辑前先看）：
 *
 * 1. **判不出来就说判不出来**。体检的结论标签只有 `启发式命中`（`pack='audit'` 全部是启发式，
 *    不是语法树分析）。
 * 2. **跳过几个符号链接要说出来**（[C-54]）。「已扫 812 个文件」不写「跳过 12 个符号链接」，
 *    这个数字就不可信——用户没法判断这次扫描完不完整。
 *
 * 视觉：三态标签用 `.dev-tag`（`.pill-*` 压玻璃 2.78:1 不达标）；表格套 `.dev-scroll`
 * （`.pnl` 是 `overflow:hidden`，不套会裁列）；不写 css、不改 `types.ts`。
 */

import { Page, PageHead, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { AuditTab } from '../components/codeaudit/AuditTab';

export function CodeAudit() {
  const { toasts, addToast, removeToast } = useToast();

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.bug size={16} />}
          title="代码体检"
          desc="只读扫描本机代码目录找可疑写法。扫描结果只在本机展示，不写日志、不联网。"
        />

        <AuditTab addToast={addToast} />
      </Page>
    </div>
  );
}
