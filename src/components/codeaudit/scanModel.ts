/**
 * 代码体检的数据形状、三级严重度词表与两个纯函数
 *
 * 被 AuditTab / FindingsTable 共用；不依赖 React，也不碰 IPC。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */



/** `scan:run` 返回（types.ts 里是 unknown，在此收窄：契约 [C-46]） */
export interface ScanRunData {
  root?: string;
  pack?: string;
  files?: number;
  fileList?: string[];
  bytes?: number;
  skippedSymlinks?: number;
  truncated?: boolean;
  truncatedReason?: string;
  counts?: { high?: number; medium?: number; low?: number };
  findings?: ScanFinding[];
  ms?: number;
}

export interface ScanFinding {
  ruleId: string;
  severity: 'high' | 'medium' | 'low' | string;
  title: string;
  file: string;
  line: number;
  snippet?: string;
}

/** `scan:rules` 的规则包（`{ packs: [{id,label,rules[]}] }`） */
export interface ScanRule { id: string; severity: string; title: string; desc: string; category?: string; keyFrom?: boolean }
export interface ScanPack { id: string; label: string; rules: ScanRule[] }

/** `scanRuns` 集合的一条（契约 §1.3） */
export interface ScanRunRecord {
  id: string;
  at: string;
  root: string;
  pack: 'audit';
  files: number;
  bytes?: number;
  skippedSymlinks?: number;
  truncated: boolean;
  truncatedReason?: string;
  counts: { high: number; medium: number; low: number };
  findings: ScanFinding[];
  ruleIds?: string[];
  ms?: number;
}

/**
 * 严重度词表（契约 v14 / [C-30]：三级 **high / medium / low**）。
 *
 * 为什么只剩一套拼写：v13 之前契约写 `mid`、实现用 `medium`，本页当时两套都认（归一到 mid 桶）。
 * v14 契约裁「跟实现走」，所以现在**只认 medium**，落库也只写 medium。
 * 历史遗留的 `mid` 只在**读老记录**时兼容（见 `readHistoryCounts`）——那是读取容错，不是第二套词表。
 */
export const SEVERITY_TEXT: Record<string, string> = { high: '高', medium: '中', low: '低' };
export const SEVERITY_ORDER = ['high', 'medium', 'low'] as const;
export type SeverityKey = typeof SEVERITY_ORDER[number];

/**
 * 单次扫描 findings 的硬上限（`electron/ipc-scan.js` 的 MAX_FINDINGS = 300）。
 * 到了上限后端就 `break`（有意的时间预算设计），所以**全量总数物理上不可知**——
 * 界面只能说「已展示 N 条（达到上限，实际可能更多）」，不能说「命中 N 条」。
 */
export const FINDINGS_CAP = 300;

/**
 * 从 findings 现算分布（摘要与列表**必须同源**，[C-30]）。
 *
 * 为什么不能直接信后端 `counts`：两个来源各算一次，迟早对不上——t46 的「摘要中 0、列表 236 条」
 * 就是读了 `counts.mid`（后端写的是 `medium`）造成的。这里认不出的 severity 单独记 `other`，
 * 不归到任何一档、也不丢。
 */
export function summarizeSeverity(findings: ScanFinding[]): Record<SeverityKey, number> & { other: number } {
  const out = { high: 0, medium: 0, low: 0, other: 0 };
  for (const f of Array.isArray(findings) ? findings : []) {
    const s = String(f?.severity || '').toLowerCase();
    if (s === 'high' || s === 'medium' || s === 'low') out[s] += 1;
    else out.other += 1;
  }
  return out;
}

/**
 * 历史记录容错：早期落库的 `scanRuns[].counts` 可能用 `mid`（当时代码跟着契约写 mid）。
 * 读取时按 **medium** 处理；**键缺失返回 null**，界面显示 `—`。
 * 不用 `|| 0` 兜底：把「没有这个数」显示成 0，会让用户以为那次扫描真的没有中危。
 */
export function readHistoryCounts(c: Record<string, unknown> | undefined): Record<SeverityKey, number | null> {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const medium = num(c?.medium);
  const legacyMid = num(c?.mid);
  return {
    high: num(c?.high),
    // 两者同时出现就相加；老记录只有 mid、新记录只有 medium
    medium: medium === null && legacyMid === null ? null : (medium ?? 0) + (legacyMid ?? 0),
    low: num(c?.low),
  };
}