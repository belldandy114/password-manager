// @vitest-environment jsdom
//
// FindingsTable 分页结构门（`docs/acceptance/W8-组件契约.md` §4.1）。
//
// 这一条是**结构门**，不是时序门：jsdom 没有布局/绘制，`< 300 ms` 的首屏判据在
// jsdom 里测不出来（所以那个数字只认真窗口实测，见回执里的「已降级」说明）。
// 结构门能钉住的是**分页真的生效**：一次只渲染一页 200 行、翻页落在第 201 条、
// findings 引用一变回第 1 页、0 条/单页不进分页条。
//
// 走的是仓里既有写法（`notesCopy.test.tsx` / `ui.test.tsx` 同源）：
// `@vitest-environment jsdom` + `@testing-library/react`，并**显式** `afterEach(cleanup)`
// —— 仓里没有开 `globals`，RTL 的自动清理不会生效，多个 render 会互相污染查询。
//
// 1.34.0 / W8 第 1 轮评审修复（t14）在本文件追加了两块：
//   ① 分页边界 201 条（跨页 1 条，评审 C11 指出的缺口）；
//   ② `scanModel` 纯函数口径（评审 C1/C2/C3/C4/R-01/R-04/R-07/R-08）。它们为什么落在这里：
//      t14 的 inScope 只给了这一个测试文件，而这几个判据（截断分流 / 中文口径 / 历史兼容 /
//      死代码删除）都是渲染层直接依赖的，没有测试就只能靠读代码判定。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import { FindingsTable, FINDINGS_PAGE_SIZE } from '../codeaudit/FindingsTable';
import type { ScanFinding, ScanRunRecord } from '../codeaudit/scanModel';
import * as scanModel from '../codeaudit/scanModel';
import {
  scanCutState, scanCountsMismatch, auditConditionText, coverageConditionText, conditionTone,
  historyConditionText, truncatedReasonText, numOrDash, readHistoryCounts, FINDINGS_CAP,
} from '../codeaudit/scanModel';

/** 造 n 条命中：`file` 里带 1-based 序号，用来断言「第 201 条」具体是哪一条 */
function makeFindings(n: number): ScanFinding[] {
  return Array.from({ length: n }, (_, i) => ({
    ruleId: 'ui-hard-sleep',
    severity: 'medium' as const,
    title: '固定等待',
    file: `src/test/java/Case${i + 1}.java`,
    line: i + 1,
    snippet: `Thread.sleep(${i + 1});`,
  }));
}

const rowsOf = (c: HTMLElement) => c.querySelectorAll('tbody tr');
const pagerCur = (c: HTMLElement) => c.querySelector('.pager-cur')?.textContent ?? null;
const noop = () => {};

afterEach(cleanup);

describe('FindingsTable 分页（结构门）', () => {
  it('每页固定 200 行：2000 条只渲染 200 个 tbody tr', () => {
    const { container } = render(<FindingsTable findings={makeFindings(2000)} onReveal={noop} />);
    expect(FINDINGS_PAGE_SIZE).toBe(200);
    expect(rowsOf(container).length).toBe(200);
  });

  it('2000 条 → 分页文案 1 / 10，统计给全量', () => {
    const { container, getByText } = render(<FindingsTable findings={makeFindings(2000)} onReveal={noop} />);
    expect(pagerCur(container)).toBe('1 / 10');
    // 分页条左侧统计必须是全量（不是「本页 200」）：共 2000 条 / 第 1–200 条
    expect(getByText('第 1–200 条，共 2000 条')).toBeTruthy();
  });

  it('点「下一页」后页首行是第 201 条', () => {
    const { container, getByTitle } = render(<FindingsTable findings={makeFindings(2000)} onReveal={noop} />);
    fireEvent.click(getByTitle('下一页'));
    expect(pagerCur(container)).toBe('2 / 10');
    const firstRow = rowsOf(container)[0] as HTMLElement;
    expect(firstRow.textContent).toContain('Case201.java');
  });

  it('findings 引用变化 → 回到第 1 页（不是停在上次的第 10 页）', () => {
    const { container, getByTitle, rerender } = render(<FindingsTable findings={makeFindings(2000)} onReveal={noop} />);
    fireEvent.click(getByTitle('最后一页'));
    expect(pagerCur(container)).toBe('10 / 10');
    // 新引用 = 「又扫了一次」：必须回第 1 页，否则用户以为没结果
    rerender(<FindingsTable findings={makeFindings(2000)} onReveal={noop} />);
    expect(pagerCur(container)).toBe('1 / 10');
    expect((rowsOf(container)[0] as HTMLElement).textContent).toContain('Case1.java');
  });

  it('0 条 → 走 Empty，不渲染分页条', () => {
    const { container, queryByText } = render(<FindingsTable findings={[]} onReveal={noop} />);
    expect(container.querySelector('.empty')).toBeTruthy();
    expect(queryByText('这次没有命中')).toBeTruthy();
    expect(container.querySelector('.pager')).toBeNull();
    expect(rowsOf(container).length).toBe(0);
  });

  it('total ≤ 200 → 单页不渲染分页条，但 200 行照常出', () => {
    const { container } = render(<FindingsTable findings={makeFindings(200)} onReveal={noop} />);
    expect(rowsOf(container).length).toBe(200);
    expect(container.querySelector('.pager')).toBeNull();
  });

  it('保留 caption 与每行「定位」按钮（分页只切 slice，不动语义）', () => {
    const onReveal = vi.fn();
    const { container, getAllByRole } = render(<FindingsTable findings={makeFindings(3)} onReveal={onReveal} />);
    expect(container.querySelector('caption')?.textContent).toContain('体检命中明细');
    const btns = getAllByRole('button').filter((b) => /定位/.test(b.getAttribute('aria-label') || ''));
    expect(btns.length).toBe(3);
    fireEvent.click(btns[1]);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal.mock.calls[0][0]).toMatchObject({ file: 'src/test/java/Case2.java', line: 2 });
  });

  // 边界档：201 条 = 跨页 1 条（评审 C11 指出的缺口）。这一档最容易出 off-by-one：
  // pages 必须算成 2、第 1 页满 200、第 2 页只剩 1 条。
  it('201 条 → 页码 1 / 2，第 1 页 200 行、第 2 页 1 行', () => {
    const { container, getByTitle } = render(<FindingsTable findings={makeFindings(201)} onReveal={noop} />);
    expect(pagerCur(container)).toBe('1 / 2');
    expect(rowsOf(container).length).toBe(200);
    expect((rowsOf(container)[0] as HTMLElement).textContent).toContain('Case1.java');

    fireEvent.click(getByTitle('下一页'));
    expect(pagerCur(container)).toBe('2 / 2');
    expect(rowsOf(container).length).toBe(1);
    expect((rowsOf(container)[0] as HTMLElement).textContent).toContain('Case201.java');
  });
});

/* ================================================================
   scanModel 的纯函数口径（第 1 轮评审 C1/C2/C3/C4/R-01/R-04/R-07/R-08）

   为什么这些用例落在**这个文件**里：t14 的 inScope 只给了这一个测试文件，
   而这几条判据（截断分流 / 文案中文口径 / 历史兼容 / 死代码删除）都是渲染层直接依赖的，
   没有它们就只能靠「读代码」判定。测试对象是 `src/components/codeaudit/scanModel.ts` 的
   纯函数，与 FindingsTable 无关 —— 分成独立 describe，不混在分页用例里。
   ================================================================ */

/** 一条新记录（v17：没有 findings） */
const newRecord = (patch: Partial<ScanRunRecord> = {}): ScanRunRecord => ({
  id: 'r1', at: '2026-11-25T00:00:00.000Z', root: '/repo', pack: 'audit',
  files: 704, truncated: false, counts: { high: 1, medium: 2, low: 3 }, totalFindings: 6,
  ...patch,
});

describe('scanCutState：detailCut 按数值判（C1 / R-01）', () => {
  it('reason=suppressed 且 findings.length===cap、totalFindings=2500 → detailCut 仍为真', () => {
    const st = scanCutState({
      truncated: true, reason: 'suppressed', suppressed: 7,
      findingsLength: FINDINGS_CAP, totalFindings: 2500,
    });
    // 收集器优先级让 suppressed 盖住 findings：旧写法（只认 reason==='findings'）这里会 false
    expect(st.detailCut).toBe(true);
    expect(st.folded).toBe(true);
    // 折叠不是「扫描覆盖被砍」，不许说「命中数可能偏少」
    expect(st.coverageCut).toBe(false);
  });

  it('同一组合的文案仍写「命中 2500 条，明细展示前 2000 条」，且面板/分页两个数有解释', () => {
    const text = auditConditionText({
      truncated: true, reason: 'suppressed', suppressed: 7,
      findingsLength: FINDINGS_CAP, totalFindings: 2500, files: 704, skippedSymlinks: 0,
    });
    expect(text).toContain(`命中 2500 条，明细展示前 ${FINDINGS_CAP} 条`);
    expect(text).toContain('另有 7 条同类命中已折叠，不是没扫到');
    expect(text).toContain('；');                       // 同档 ≥2 条合并成一条
    expect(text).not.toContain('命中数可能偏少');        // 折叠/明细到顶都不许说这句
    expect(text).not.toContain('suppressed');            // 不泄露内部枚举名
  });

  it('明细已给全（findings.length === totalFindings）→ detailCut 为假', () => {
    const st = scanCutState({ truncated: false, suppressed: 0, findingsLength: 300, totalFindings: 300 });
    expect(st.detailCut).toBe(false);
    expect(scanCutState({ truncated: false, suppressed: 0, findingsLength: 300, totalFindings: NaN }).detailCut).toBe(false);
  });

  it('旧主进程无 totalFindings（NaN）→ 不出现 NaN、不出现「偏少」、额外说明总数未知', () => {
    const text = auditConditionText({
      truncated: true, reason: 'findings', suppressed: 0,
      findingsLength: 500, totalFindings: NaN, files: 12, skippedSymlinks: 0,
    });
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('命中数可能偏少');
  });

  it('coverageCut 只有 timeout/max-files/depth/file-size 会带「命中数可能偏少」，其余原因不外露枚举名', () => {
    for (const reason of ['timeout', 'max-files', 'depth', 'file-size']) {
      const text = auditConditionText({ truncated: true, reason, suppressed: 0, findingsLength: 0, totalFindings: 10, files: 12, skippedSymlinks: 0 });
      expect(text).toContain('命中数可能偏少');
      expect(text).not.toContain(reason); // 'file-size' 等枚举名不许出现在界面文案里
    }
    const other = auditConditionText({ truncated: true, reason: 'files', suppressed: 0, findingsLength: 0, totalFindings: 10, files: 12, skippedSymlinks: 0 });
    expect(other).not.toContain('命中数可能偏少');
    expect(other).not.toContain('files');
  });

  it('skippedByGuard 并入运行条件；单位是「条目」不是文件数；缺失时不显示、不崩', () => {
    const withGuard = auditConditionText({
      truncated: false, suppressed: 0, findingsLength: 3, totalFindings: 3,
      files: 10, skippedSymlinks: 0, skippedByGuard: 42,
    });
    // 队长 t14 追加要求：计的是「条目」（目录记 1、产物记 1），文案不许写「N 个文件」
    expect(withGuard).toContain('另有 42 处目录/产物被跳过');
    expect(withGuard).not.toMatch(/跳过\s*42\s*个文件/);
    const noGuard = auditConditionText({
      truncated: false, suppressed: 0, findingsLength: 3, totalFindings: 3, files: 10, skippedSymlinks: 0,
    });
    expect(noGuard).not.toContain('目录/产物被跳过');
    expect(noGuard).not.toContain('NaN');
  });

  it('语气档：只有 coverageCut 是 is-warn；折叠 / 明细到顶 / 守卫跳过条目都是 is-info', () => {
    const infoOnly = [
      // 折叠
      { truncated: true, reason: 'suppressed', suppressed: 9, findingsLength: 10, totalFindings: 10, files: 10, skippedSymlinks: 0 },
      // 明细到顶（含折叠）
      { truncated: true, reason: 'suppressed', suppressed: 9, findingsLength: FINDINGS_CAP, totalFindings: 2500, files: 10, skippedSymlinks: 0 },
      // 只跳过了守卫条目与符号链接
      { truncated: false, suppressed: 0, findingsLength: 3, totalFindings: 3, files: 10, skippedSymlinks: 2, skippedByGuard: 7 },
    ];
    for (const input of infoOnly) {
      expect(conditionTone(scanCutState(input))).toBe('is-info');
    }
    // 真·覆盖被砍才升级为 warn（整条升级，不是只升级某一句话）
    const cut = scanCutState({
      truncated: true, reason: 'timeout', suppressed: 2, findingsLength: 10, totalFindings: 10,
    });
    expect(conditionTone(cut)).toBe('is-warn');
  });
});

describe('scanCountsMismatch：缺失不假红（C3 / R-08）', () => {
  const counts = { high: 1, medium: 2, low: 3 };
  it('两边都是有限数且自洽 → false', () => {
    expect(scanCountsMismatch(counts, 6, 6)).toBe(false);
    // 截断时「明细条数 < 总数」是正常态：counts 合计 2500 = 总数，明细 2000 ≤ 2500 → 不报
    expect(scanCountsMismatch({ high: 1000, medium: 1000, low: 500 }, 2500, 2000)).toBe(false);
  });
  it('合计 ≠ 总数、或明细条数 > 总数 → true', () => {
    expect(scanCountsMismatch(counts, 7, 6)).toBe(true);
    expect(scanCountsMismatch(counts, 3, 6)).toBe(true);
  });
  it('totalFindings 缺失（NaN）或 counts 缺失 → false（不校验，不假红）', () => {
    expect(scanCountsMismatch(counts, NaN, 6)).toBe(false);
    expect(scanCountsMismatch(undefined, 6, 6)).toBe(false);
    expect(scanCountsMismatch({ high: NaN, medium: 0, low: 0 }, 6, 6)).toBe(false);
  });
});

describe('numOrDash：非有限数一律「—」（C3 / R-07）', () => {
  it('NaN / undefined / null / 字符串 ⇒ 「—」；0 与正数原样返回', () => {
    expect(numOrDash(NaN)).toBe('—');
    expect(numOrDash(undefined)).toBe('—');
    expect(numOrDash(null)).toBe('—');
    expect(numOrDash('12')).toBe('—');
    expect(numOrDash(Infinity)).toBe('—');
    expect(numOrDash(0)).toBe(0);       // 0 是「确实一条都没命中」，不是「不知道」
    expect(numOrDash(5231)).toBe(5231);
  });
});

describe('coverageConditionText：折叠 ≠ 截断，且不外露枚举（C2）', () => {
  const base = { files: 10, skippedSymlinks: 0 };
  it('只有 suppressed → 说折叠，绝不说「覆盖统计偏低」，也不出现 suppressed', () => {
    const text = coverageConditionText({
      ...base, truncated: true, reason: 'suppressed', suppressed: 12, findingsLength: 300, totalFindings: 300,
    });
    expect(text).toContain('另有 12 条同类命中已折叠');
    expect(text).not.toContain('偏低');
    expect(text).not.toContain('suppressed');
  });
  it('真·覆盖被砍（file-size）→ 允许说「覆盖统计可能偏低」，但枚举名转中文', () => {
    const text = coverageConditionText({
      ...base, truncated: true, reason: 'file-size', suppressed: 0, findingsLength: 10, totalFindings: 10,
    });
    expect(text).toContain('覆盖统计可能偏低');
    expect(text).not.toContain('file-size');
  });
  it('timeout 带上扫过的文件数', () => {
    const text = coverageConditionText({
      ...base, files: 12, truncated: true, reason: 'timeout', suppressed: 0, findingsLength: 10, totalFindings: 10,
    });
    expect(text).toContain('扫描超时（60 s），只扫了 12 个文件，覆盖统计可能偏低');
  });
  it('明细到顶：未覆盖数可能偏多（方向与体检页相反，不能复用「偏低」）', () => {
    const text = coverageConditionText({
      ...base, truncated: true, reason: 'suppressed', suppressed: 0, findingsLength: 2000, totalFindings: 2500,
    });
    expect(text).toContain(`只展开前 ${FINDINGS_CAP} 条代码引用，未覆盖数可能偏多`);
  });
  it('守卫跳过条目：单位是「条目」、不写「个文件」、且不进 is-warn 档', () => {
    const input = {
      ...base, truncated: false, suppressed: 0, findingsLength: 3, totalFindings: 3, skippedByGuard: 7,
    };
    const text = coverageConditionText(input);
    expect(text).toContain('另有 7 处目录/产物被跳过');
    expect(text).not.toMatch(/跳过\s*7\s*个文件/);
    expect(text).not.toContain('偏低');
    expect(conditionTone(scanCutState(input))).toBe('is-info');
  });
});

describe('historyConditionText：历史运行条件（R-04）', () => {
  it('新记录 + 折叠 → 「同类已折叠」，不出现枚举名、不标旧记录', () => {
    const text = historyConditionText(newRecord({ truncated: true, truncatedReason: 'suppressed', totalFindings: 5231 }));
    expect(text).toContain('同类已折叠');
    expect(text).not.toContain('suppressed');
    expect(text).not.toContain('旧记录');
  });
  it('旧记录（无 totalFindings）→ 并列注明「明细仅 300 条、总数未知」', () => {
    const old = newRecord({ totalFindings: undefined, truncated: true, truncatedReason: 'findings', skippedSymlinks: 2 });
    const text = historyConditionText(old);
    expect(text).toContain('明细到顶');
    expect(text).toContain('旧记录：明细仅 300 条、总数未知');
    expect(text).toContain('跳过 2 个符号链接');
    expect(text).not.toContain('findings');
  });
  it('什么都没有 → 「—」（不是 0）', () => {
    const plain = newRecord();
    expect(historyConditionText(plain)).toBe('—');
  });
  it('未知 truncatedReason 不回显原值', () => {
    expect(truncatedReasonText('weird-new-reason')).toBe('其它原因');
    const text = historyConditionText(newRecord({ truncated: true, truncatedReason: 'weird-new-reason' }));
    expect(text).not.toContain('weird-new-reason');
  });
});

describe('readHistoryCounts：老记录 mid→medium 兼容（不动）', () => {
  it('只有 mid → 读成 medium', () => {
    expect(readHistoryCounts({ high: 1, mid: 2, low: 3 })).toEqual({ high: 1, medium: 2, low: 3 });
  });
  it('medium 与 mid 同时出现 → 相加', () => {
    expect(readHistoryCounts({ medium: 2, mid: 3 }).medium).toBe(5);
  });
  it('缺键返回 null（不兜 0），null/非对象输入也不崩', () => {
    expect(readHistoryCounts({ high: 1 })).toEqual({ high: 1, medium: null, low: null });
    expect(readHistoryCounts(undefined)).toEqual({ high: null, medium: null, low: null });
    expect(readHistoryCounts('oops')).toEqual({ high: null, medium: null, low: null });
  });
});

describe('死代码已删（C4）', () => {
  it('scanModel 不再导出 summarizeSeverity（摘要一律取 counts + totalFindings）', () => {
    expect('summarizeSeverity' in scanModel).toBe(false);
  });
});