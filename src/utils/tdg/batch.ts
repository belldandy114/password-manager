/**
 * 十万级造数的「切批 / 进度 / 格式能力」纯函数（契约 §2.5 / C-65~C-69；任务 t25 第 5 条）。
 *
 * 为什么单独成文件：这三件事都是**可以在点按钮之前算清楚**的判定，
 * 一旦写进 React 组件就只能靠点一次才知道对不对（而且「超限才发现」「XLSX 到 8 万行才炸」
 * 这类问题恰恰是最贵的）。所以：
 *   - 切批：`batchSizes` / `decidePath`
 *   - 进度：`progressPercent`
 *   - 能力矩阵：`capabilityOf` / `FORMAT_CAPABILITIES`
 * 本文件**不依赖 React、不碰 IPC、不读文件**，单测见 `__tests__/tdgBatch.test.ts`。
 *
 * 上限常量与主进程 `electron/tdg-write.js` 的 `TDG_LIMITS` 必须一致
 * （那里是 CommonJS，渲染层 import 不到 TS，只能两边各写一份**并各自有测试**——
 * 本文件把值导出来，`tdgBatch.test.ts` 断言的就是这些数字，改一处漏另一处会被单测发现）。
 */

import type { ExportFormat } from './types';

/** 单批最多多少行（与 tdg-write.js 的 maxRowsPerBatch 一致，[C-67]：分批大小由渲染层决定） */
export const BATCH_MAX_ROWS = 5000;

/** 单个文件累计最多多少行（与 tdg-write.js 的 maxRows 一致） */
export const STREAM_MAX_ROWS = 1_000_000;

/** 单行最多多少字节（转义后的行内容，与 tdg-write.js 的 maxLineBytes 一致） */
export const MAX_LINE_BYTES = 64 * 1024;

/** 能走流式的格式（[C-65]：只有 csv / json / txt 三条通道格式） */
export const STREAM_FORMATS: readonly ExportFormat[] = ['csv', 'json', 'txt'];

/** 「界面单次上限」——与 DataGenerator.tsx 的 MAX_COUNT 同值；本文件只做判定，不改界面常量 */
export const SINGLE_MAX_ROWS = 5000;

export interface FormatCapability {
  format: ExportFormat;
  /** 能否走流式（大批量） */
  stream: boolean;
  /** 原路径（内存导出）的行数上限 */
  singleMaxRows: number;
  /** 流式导出的行数上限；不能流式时为 0 */
  streamMaxRows: number;
  /** 不能走流式的原因（UI 直接显示这句话，不要改写成「暂不支持」这种笼统说法） */
  reason?: string;
}

const SINGLE_ONLY_REASON: Partial<Record<ExportFormat, string>> = {
  xlsx: 'XLSX 不支持大批量：exceljs 会把整本工作簿驻留内存，10 万行会卡死界面；请改用 CSV（表格软件都能打开）',
  md: 'Markdown 表格不支持大批量：整张表要一次性拼成字符串，10 万行会占满内存；请改用 CSV / TXT',
  sql: 'SQL 导出不支持大批量：当前只做「整段脚本一次性生成」；需要导入数据库请改用 CSV',
};

/**
 * 单格式的能力判定。判据只有两条：
 * 1. 通道层面能不能流式（csv/json/txt 能，md/sql/xlsx 不能）；
 * 2. 不能流式时的**具体原因**（必须能直接给用户看）。
 */
export function capabilityOf(format: ExportFormat): FormatCapability {
  const stream = STREAM_FORMATS.includes(format);
  return {
    format,
    stream,
    singleMaxRows: SINGLE_MAX_ROWS,
    streamMaxRows: stream ? STREAM_MAX_ROWS : 0,
    ...(stream ? {} : { reason: SINGLE_ONLY_REASON[format] || `${format} 不支持大批量导出` }),
  };
}

/** 六种格式的能力矩阵（给 UI 直接 map 出来渲染，避免界面自己再写一套 if） */
export const FORMAT_CAPABILITIES: FormatCapability[] = (
  ['txt', 'csv', 'md', 'xlsx', 'json', 'sql'] as ExportFormat[]
).map(capabilityOf);

/** 把用户输入的行数夹到合法区间：<1 → 1；>上限 → 上限（NaN/负数也走这里） */
export function clampStreamRows(input: number): number {
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, STREAM_MAX_ROWS);
}

/**
 * 每批的行数序列：每项 ≤ batchSize，和恰好等于 total；`total<=0` 返回空数组。
 *
 * 为什么返回「每批多少行」而不是 offset：调用方只需要知道「这一批生成几条」，
 * offset 由累加得到；两套都返回容易出现「offset 与 count 对不上」的错位 bug。
 */
export function batchSizes(total: number, batchSize: number = BATCH_MAX_ROWS): number[] {
  const sum = Math.max(0, Math.floor(Number(total) || 0));
  const size = Math.max(1, Math.floor(Number(batchSize) || BATCH_MAX_ROWS));
  const out: number[] = [];
  let left = sum;
  while (left > 0) {
    const take = Math.min(size, left);
    out.push(take);
    left -= take;
  }
  return out;
}

/** 进度百分比：0–100 的整数，边界夹紧（done<0 当 0；done>total 当 100；total<=0 当 0） */
export function progressPercent(done: number, total: number): number {
  const t = Math.floor(Number(total) || 0);
  if (t <= 0) return 0;
  const d = Math.max(0, Math.min(Math.floor(Number(done) || 0), t));
  return Math.round((d / t) * 100);
}

export type ExportPlan =
  | { path: 'single'; reason: string }
  | { path: 'stream'; total: number; batchSize: number; batches: number }
  | { path: 'blocked'; reason: string };

/**
 * 决定「这一单走哪条路」——UI 的按钮可用性与提示文案都从这里来，页面里不再写 if。
 *
 * - `rows <= 5000` → `single`（**既有路径，行为一字不改**；appearance 上要提示用户用上面的「导出」）
 * - `rows > 5000` 且格式能流式 → `stream`
 * - `rows > 5000` 且格式不能流式 → `blocked` + 具体原因（例：XLSX 超过 5000 行直接禁用）
 * - `rows > 1,000,000` → `blocked`（超过单文件上限，**点之前**就拦住）
 */
export function decidePath(rows: number, format: ExportFormat): ExportPlan {
  const cap = capabilityOf(format);
  const n = Math.floor(Number(rows) || 0);
  if (n <= 0) return { path: 'blocked', reason: '行数至少为 1' };
  if (n > STREAM_MAX_ROWS) {
    return {
      path: 'blocked',
      reason: `超过单文件上限（${STREAM_MAX_ROWS.toLocaleString('en-US')} 行），请拆成多个文件`,
    };
  }
  if (n <= SINGLE_MAX_ROWS) {
    return {
      path: 'single',
      reason: `≤ ${SINGLE_MAX_ROWS.toLocaleString('en-US')} 行请用上面的「导出」（原路径，支持全部 6 种格式）`,
    };
  }
  if (!cap.stream) {
    return { path: 'blocked', reason: cap.reason || `${format} 不支持大批量` };
  }
  const sizes = batchSizes(n);
  return { path: 'stream', total: n, batchSize: BATCH_MAX_ROWS, batches: sizes.length };
}