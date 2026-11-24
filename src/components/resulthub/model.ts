/**
 * Allure / .jtl 的数据形状与截断文案
 *
 * 被 AllureTab / JtlTab 共用；不依赖 React，也不碰 IPC。
 *
 * 来源：t53 把 `src/pages/ResultHub.tsx`（625 行）按 `docs/拆分-渲染层.md` 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */


/** `allure:parse` 的返回（types.ts 里是 unknown，在此收窄：契约 [C-46]） */
export interface AllureFlakyItem { name: string; fullName: string; runs: number; pass: number; fail: number }
export interface AllureClusterItem { key: string; count: number; sample: string; samples: string[] }
export interface AllureCaseItem { name: string; fullName?: string; status: string; durationMs?: number; retries?: number; runs?: number; pass?: number; fail?: number; flaky?: boolean; message?: string }
export interface AllureParseData {
  root?: string;
  total?: number;
  passed?: number;
  failed?: number;
  broken?: number;
  skipped?: number;
  retries?: number;
  skippedFiles?: number;
  cases?: AllureCaseItem[];
  environment?: Record<string, string>;
  clusters?: AllureClusterItem[];
  flaky?: AllureFlakyItem[];
  truncated?: boolean;
  truncatedReason?: string;
  ms?: number;
}

/** `allureRuns` 集合的一条（契约 §1.6） */
export interface AllureRunRecord {
  id: string;
  at: string;
  root: string;
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  retries: number;
  skippedFiles?: number;
  clusters: AllureClusterItem[];
  flaky: AllureFlakyItem[];
}

export const TRUNCATED_TEXT: Record<string, string> = {
  timeout: '解析超时', files: '文件数超过上限', 'file-size': '单个结果文件过大', cases: '用例数超过上限', flaky: 'flaky 记录超过上限',
};
export const JTL_TRUNCATED_TEXT: Record<string, string> = { rows: '行数超过上限', labels: '接口维度超过上限' };