/**
 * 接口回归：回归集定义、到期判定、与上次结果比对。
 *
 * 这里只放**纯函数**——不碰 IPC、不碰 React。定时器（useRegressionScheduler）
 * 和页面（ApiClient）共用同一份判定，避免出现「手动跑显示通过、定时跑说不一致」。
 */
import type { RunStep } from './apiRunner';

/** 一个回归集：一组按顺序执行的请求 + 定时规则 */
export interface RegressionSet {
  id: string;
  name: string;
  /** 按顺序执行，前一步提取的变量喂给后一步 */
  requestIds: string[];
  /** 分钟；0 表示不定时（只能手动跑） */
  intervalMin: number;
  enabled: boolean;
  /** 上次运行时间（ISO）；从没跑过就没有这个字段 */
  lastRunAt?: string;
  lastRunId?: string;
  lastStatus?: 'pass' | 'fail';
  createdAt: string;
}

/** 一次回归运行的结果（存在库里，只留最近若干次） */
export interface RegressionRun {
  id: string;
  setId: string;
  /** 集合名快照：集合被改名或删掉后，历史记录还看得懂 */
  setName: string;
  at: string;
  trigger: 'manual' | 'schedule';
  steps: RunStep[];
}

export interface RunSummary {
  total: number;
  pass: number;
  fail: number;
  /** 所有步骤耗时之和（毫秒） */
  totalMs: number;
}

export function summarizeRun(steps: RunStep[]): RunSummary {
  const pass = steps.filter(s => s.ok).length;
  return {
    total: steps.length,
    pass,
    fail: steps.length - pass,
    totalMs: steps.reduce((n, s) => n + (s.timeMs || 0), 0),
  };
}

/** 可选间隔（分钟）：0 是不定时 */
export const REGRESSION_INTERVALS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不定时' },
  { value: 15, label: '每 15 分钟' },
  { value: 30, label: '每 30 分钟' },
  { value: 60, label: '每小时' },
  { value: 180, label: '每 3 小时' },
  { value: 720, label: '每 12 小时' },
  { value: 1440, label: '每天' },
];

export const intervalLabel = (min: number): string =>
  REGRESSION_INTERVALS.find(i => i.value === Number(min))?.label || `每 ${min} 分钟`;

/** 下次该跑的时间（毫秒）；不定时或没开就返回 null */
export function nextRunAt(set: RegressionSet): number | null {
  if (!set.enabled || !set.intervalMin) return null;
  const last = set.lastRunAt ? Date.parse(set.lastRunAt) : NaN;
  if (!Number.isFinite(last)) return Date.now();
  return last + set.intervalMin * 60_000;
}

/**
 * 现在是否该跑。
 *
 * 从未跑过的集合**立刻算到期**：勾上开关就该马上跑一次，
 * 否则要等满一个间隔才看得见结果，容易以为没生效。
 */
export function isDue(set: RegressionSet, now: number = Date.now()): boolean {
  if (!set.enabled || !set.intervalMin) return false;
  if (!set.lastRunAt) return true;
  const last = Date.parse(set.lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= set.intervalMin * 60_000;
}

export type DiffKind =
  /** 上次通过，这次也通过 */
  | 'same-pass'
  /** 上次失败，这次还是失败 */
  | 'same-fail'
  /** 上次通过，这次失败 —— 最需要看的一条 */
  | 'new-fail'
  /** 上次失败，这次通过 */
  | 'recovered'
  /** 这次才出现在集合里 */
  | 'added'
  /** 上次有、这次没有（请求被删或集合改了） */
  | 'gone';

export interface StepDiff {
  id: string;
  name: string;
  kind: DiffKind;
  /** 状态码和上次不同（两边都有状态码时才有意义） */
  statusChanged: boolean;
  /** 这次耗时 - 上次耗时；没有可比数据时为 null */
  timeDeltaMs: number | null;
}

/**
 * 逐条比对两次运行。
 *
 * 用请求 id 对齐（不是顺序）——集合里调整顺序不应该被当成「新失败」。
 */
export function compareRuns(prev: RunStep[] | null, cur: RunStep[]): StepDiff[] {
  const prevMap = new Map((prev || []).map(s => [s.id, s]));
  const curIds = new Set(cur.map(s => s.id));
  const out: StepDiff[] = [];

  cur.forEach((s) => {
    const before = prevMap.get(s.id);
    if (!before) {
      out.push({ id: s.id, name: s.name, kind: 'added', statusChanged: false, timeDeltaMs: null });
      return;
    }
    const kind: DiffKind = before.ok
      ? (s.ok ? 'same-pass' : 'new-fail')
      : (s.ok ? 'recovered' : 'same-fail');
    out.push({
      id: s.id,
      name: s.name,
      kind,
      statusChanged: !!before.status && !!s.status && before.status !== s.status,
      // 失败步骤的 timeMs 是 0（请求没发出去），拿它算差只会显示「快了 120ms」这种误导
      timeDeltaMs: before.timeMs > 0 && s.timeMs > 0 ? s.timeMs - before.timeMs : null,
    });
  });

  (prev || []).forEach((s) => {
    if (!curIds.has(s.id)) {
      out.push({ id: s.id, name: s.name, kind: 'gone', statusChanged: false, timeDeltaMs: null });
    }
  });

  return out;
}

/** 比对里值得提醒的条数（新失败 + 新消失） */
export function diffAlerts(diffs: StepDiff[]): number {
  return diffs.filter(d => d.kind === 'new-fail' || d.kind === 'gone').length;
}

/** 差异的中文说明，界面上直接显示 */
export const DIFF_LABEL: Record<DiffKind, string> = {
  'same-pass': '仍通过',
  'same-fail': '仍失败',
  'new-fail': '新失败',
  recovered: '已恢复',
  added: '新增',
  gone: '已移除',
};

/**
 * 每个集合只保留最近 N 次，按时间倒序。
 * 不清理的话，每天的定时会让库文件无限长（结果是整段响应摘要，几百 KB 很容易）。
 */
export function pruneRuns(runs: RegressionRun[], keepPerSet = 20): RegressionRun[] {
  const bySet = new Map<string, RegressionRun[]>();
  runs.forEach((r) => {
    const arr = bySet.get(r.setId) || [];
    arr.push(r);
    bySet.set(r.setId, arr);
  });
  const out: RegressionRun[] = [];
  bySet.forEach((list) => {
    list
      .slice()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, keepPerSet)
      .forEach(r => out.push(r));
  });
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** 找出某集合最近一次运行（用于「与上次比对」） */
export function latestRunOf(runs: RegressionRun[], setId: string): RegressionRun | null {
  let hit: RegressionRun | null = null;
  runs.forEach((r) => {
    if (r.setId !== setId) return;
    if (!hit || r.at > hit.at) hit = r;
  });
  return hit;
}
