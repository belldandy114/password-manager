/**
 * 体检命中明细表（分页）
 *
 * 原 AuditTab 里那段「空态 + .dev-scroll 表格」的 JSX 整体搬出来；1.34.0 / W8 起加分页。
 *
 * 为什么**必须**分页（不是优化，是硬配套）：契约 `[C-53]` v16 把当次明细上限从 300 提到 2000，
 * 而本表没有虚拟化 —— 2000 行 = 14,000 个 `<td>`，全部进 DOM。扫描口径 §2.2(b) 已写明
 * 「2000 必须配分页或虚拟化」，判据是「2000 行时首屏可交互 < 300 ms」。
 *
 * 口径（`docs/acceptance/W8-组件契约.md` §4.1）：
 * - 每页**固定 200 行**，刻意不给「每页条数」选择器：固定值才让 `1 / 10` 成为可断言的结构门；
 * - 复用 `Pager`（`.pager` 本就是玻璃登记里的锚点），**不传** `onPageSize`；
 * - `findings` 引用一变就回第 1 页 —— 否则扫完一次仍停在上次的第 10 页，用户以为没结果；
 * - `total <= 200` 不渲染 `Pager`（单页时它只是噪声，翻页信息由「命中 N 条」承担）；
 * - 0 条走 `Empty`，不渲染 `Pager`；
 * - `caption`、每行「定位」按钮、`Empty` 三处语义只为分页让出 `slice`，一个字没动。
 *
 * 样式全部走既有类：滚动容器 `.dev-scroll`（默认 56vh），表格 `table.tbl` 由
 * `redesign.css:9185` 的 `.dev-scroll > table.tbl { table-layout: fixed }` 收编 ——
 * 这里**不再**写内联 `maxHeight` / `tableLayout` / `width`。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开；
 * 本文件在 W8（t7）加的分页是唯一的行为变更。
 */

import { useEffect, useState } from 'react';
import { Empty, Icons } from '../ui';
import { Pager } from '../Pager';
import { SEVERITY_TEXT } from './scanModel';
import type { ScanFinding } from './scanModel';

/**
 * 每页固定行数（200）。
 *
 * 2000 / 200 = 10 页；结构门单测（`src/components/__tests__/findingsPager.test.tsx`）断言
 * 「2000 条 → tbody 恰 200 行、分页文案 1 / 10、第 2 页首行是第 201 条」。
 * 改这个数要同步改那条单测（它锁的是「首屏只渲染一页」这个事实，不是某个魔法数）。
 */
export const FINDINGS_PAGE_SIZE = 200;

export function FindingsTable({
  findings,
  onReveal,
}: {
  findings: ScanFinding[];
  onReveal: (f: ScanFinding) => void;
}) {
  const [page, setPage] = useState(1);

  // findings 引用变化 → 回第 1 页（扫完一次还停在上次的第 10 页 = 「看起来没结果」）
  useEffect(() => {
    setPage(1);
  }, [findings]);

  if (findings.length === 0) {
    return (
      <Empty
        compact
        icon={<Icons.check size={20} />}
        title="这次没有命中"
        desc="勾选的规则一条都没命中。注意这是启发式检查：没命中不等于没问题。"
        hint="可以少勾几条规则再扫一次，看是不是规则被筛掉了。"
      />
    );
  }

  const total = findings.length;
  const pages = Math.max(1, Math.ceil(total / FINDINGS_PAGE_SIZE));
  // 与 Pager 内部同一套夹取：page 只可能被 setPage 写成合法值，这里再夹一次防边界
  const cur = Math.min(Math.max(1, page), pages);
  const start = (cur - 1) * FINDINGS_PAGE_SIZE;
  const rows = findings.slice(start, start + FINDINGS_PAGE_SIZE);

  return (
    <>
      <div className="dev-scroll">
        <table className="tbl">
          <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            体检命中明细：规则 / 文件 / 行 / 命中原文 / 严重度
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ width: 170 }}>规则</th>
              <th scope="col">文件</th>
              <th scope="col" style={{ width: 56 }}>行</th>
              <th scope="col" style={{ width: 260 }}>命中原文</th>
              <th scope="col" style={{ width: 64 }}>严重度</th>
              <th scope="col" style={{ width: 92 }}>结论</th>
              <th scope="col" style={{ width: 64 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={`${f.ruleId}-${f.file}-${f.line}-${start + i}`}>
                <td title={f.title} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</td>
                <td title={f.file} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}</td>
                <td>{f.line}</td>
                <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <code title={f.snippet}>{f.snippet || '—'}</code>
                </td>
                <td>{SEVERITY_TEXT[f.severity] || f.severity}</td>
                <td><span className="dev-tag is-heur">启发式</span></td>
                <td>
                  <button className="btn btn-ghost btn-sm" onClick={() => void onReveal(f)} aria-label={`定位 ${f.file} 第 ${f.line} 行`}>
                    <Icons.link size={13} /> 定位
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* 单页不渲染分页条：它只重复「共 N 条」，占一行高度还多一个焦点停靠点 */}
      {total > FINDINGS_PAGE_SIZE && (
        <Pager total={total} page={cur} pageSize={FINDINGS_PAGE_SIZE} onPage={setPage} />
      )}
    </>
  );
}