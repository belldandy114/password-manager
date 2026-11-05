/**
 * 时间戳解析与耗时计算（工具箱「时间戳」「时间轴/耗时」）
 *
 * 手输时间戳最容易错的就是单位：10 位是秒、13 位是毫秒、16 位是微秒、19 位是纳秒。
 * 这里按位数推断，并允许手动指定。
 */

export type TimeUnit = 'auto' | 's' | 'ms' | 'us' | 'ns';

export interface ParsedStamp {
  ok: boolean;
  error?: string;
  /** 推断/指定的单位 */
  unit?: Exclude<TimeUnit, 'auto'>;
  /** 毫秒时间戳 */
  ms?: number;
  /** 本地时间文本 */
  local?: string;
  /** ISO（UTC） */
  iso?: string;
}

const UNIT_DIV: Record<Exclude<TimeUnit, 'auto'>, number> = {
  s: 1000,
  ms: 1,
  us: 1 / 1000,
  ns: 1 / 1e6,
};

/** 按位数推断单位（同时接受负数与小数） */
export function detectUnit(raw: string): Exclude<TimeUnit, 'auto'> {
  const digits = String(raw).replace(/[^\d]/g, '');
  if (digits.length >= 19) return 'ns';
  if (digits.length >= 16) return 'us';
  if (digits.length >= 13) return 'ms';
  if (digits.length >= 12) return 'ms';
  return 's';
}

export function parseTimestamp(raw: string, unit: TimeUnit = 'auto'): ParsedStamp {
  const t = String(raw || '').trim();
  if (!t) return { ok: false, error: '请输入时间戳或日期' };
  if (!/^-?\d+(\.\d+)?$/.test(t)) {
    // 不是纯数字：当成日期字符串解析（方便「粘贴日期反查时间戳」）
    const d = new Date(t.replace(/\//g, '-'));
    if (Number.isNaN(d.getTime())) return { ok: false, error: '既不是时间戳也不是可识别的日期' };
    return { ok: true, unit: 'ms', ms: d.getTime(), local: d.toLocaleString('zh-CN', { hour12: false }), iso: d.toISOString() };
  }
  const u = unit === 'auto' ? detectUnit(t) : unit;
  const num = Number(t);
  const ms = num * UNIT_DIV[u];
  if (!Number.isFinite(ms)) return { ok: false, error: '数值超出范围' };
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return { ok: false, error: '换算后不是合法时间' };
  return { ok: true, unit: u, ms, local: d.toLocaleString('zh-CN', { hour12: false }), iso: d.toISOString() };
}

/** 毫秒 → 「1 天 2 小时 3 分 4 秒」；小于 1 秒给毫秒 */
export function formatDuration(ms: number): string {
  const n = Math.abs(Number(ms) || 0);
  const sign = ms < 0 ? '-' : '';
  if (n < 1000) return `${sign}${Math.round(n)} 毫秒`;
  const sec = Math.floor(n / 1000);
  const parts: string[] = [];
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分`);
  if (s) parts.push(`${s} 秒`);
  return sign + (parts.length ? parts.join(' ') : '0 秒');
}

export interface TimelineRow {
  /** 原始输入 */
  raw: string;
  /** 毫秒时间戳 */
  ms: number;
  /** 本地时间 */
  local: string;
  /** 相对前一行的间隔（毫秒），第一行为 0 */
  delta: number;
  /** 相对第一行的累计（毫秒） */
  offset: number;
  error?: string;
}

/** 把多行时间戳（或日期）算成时间轴：每行间隔 + 相对首行偏移 */
export function buildTimeline(text: string): { rows: TimelineRow[]; error?: string } {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], error: '请输入至少一行时间' };
  const rows: TimelineRow[] = [];
  const first = parseTimestamp(lines[0]);
  if (!first.ok || first.ms === undefined) return { rows: [], error: `第 1 行无法解析：${first.error}` };

  let prev = first.ms;
  for (let i = 0; i < lines.length; i += 1) {
    const p = i === 0 ? first : parseTimestamp(lines[i]);
    if (!p.ok || p.ms === undefined) {
      rows.push({ raw: lines[i], ms: NaN, local: '', delta: 0, offset: 0, error: p.error });
      continue;
    }
    rows.push({
      raw: lines[i],
      ms: p.ms,
      local: p.local || '',
      delta: i === 0 ? 0 : p.ms - prev,
      offset: p.ms - first.ms,
    });
    prev = p.ms;
  }
  return { rows };
}

/** 时间轴结果转文本（方便贴到缺陷单） */
export function timelineToText(rows: TimelineRow[], total = true): string {
  const lines = rows.map((r, i) => {
    if (r.error) return `${i + 1}. ${r.raw} —— ${r.error}`;
    const gap = i === 0 ? '起点' : `距上一行 ${formatDuration(r.delta)}`;
    return `${i + 1}. ${r.local}  ${gap}（累计 ${formatDuration(r.offset)}）`;
  });
  if (total && rows.length > 1) {
    const ok = rows.filter((r) => !r.error);
    if (ok.length > 1) lines.push(`总耗时：${formatDuration(ok[ok.length - 1].ms - ok[0].ms)}`);
  }
  return lines.join('\n');
}