/**
 * 「从禅道生成周报」的选择记忆。
 *
 * 使用者每周只关心固定的那几个项目，之前每次打开弹窗都要重新勾一遍，
 * 所以把上一次性用过的配置存到 localStorage（和周的报目录一样，只存本机）。
 *
 * 两个刻意的设计：
 * 1. **时间口径存「预设名」而不是具体日期**。存 `2026-11-02~2026-11-06` 的话，
 *    下周打开会算出上周的数据，属于静默的错。只有用户手改过日期（custom）才存死。
 * 2. **项目只存 id，加载时按当前项目列表过滤**。禅道里的项目会改名、会删，
 *    直接拿旧 id 去请求会 404；过滤掉即可，不需要报错。
 */
import { DEFAULT_DIGEST_OPTIONS, mondayOf, ymd, type DigestOptions } from './weeklyDigest';

export const DIGEST_PREFS_KEY = 'pm.weekly.digest';

export type RangePreset = 'thisWeek' | 'lastWeek' | 'thisWeekToFriday' | 'custom';

export interface DigestPrefs {
  /** 时间口径；custom 才用下面的 from/to */
  range: RangePreset;
  from: string;
  to: string;
  /** 上次勾了哪些项目：{ 实例 id: [产品 id] } */
  productIds: Record<string, string[]>;
  /** 上次按哪些创建人统计：{ 实例 id: [姓名或账号] } */
  openedBy: Record<string, string[]>;
  /** 剩下的排版选项（不含时间与创建人，那两项单独存） */
  opts: Omit<DigestOptions, 'from' | 'to' | 'openedBy'>;
}

const PRESETS: RangePreset[] = ['thisWeek', 'lastWeek', 'thisWeekToFriday', 'custom'];
const LAYOUTS: Array<DigestOptions['layout']> = ['byProject', 'byCompany'];

/** 预设时间窗。`thisWeekToFriday` 在周五之前会截到今天，不然会把未来日期写进文件名 */
export function presetRange(kind: Exclude<RangePreset, 'custom'>, now = new Date()): { from: string; to: string } {
  const mon = mondayOf(now);
  if (kind === 'thisWeek') return { from: ymd(mon), to: ymd(now) };

  if (kind === 'lastWeek') {
    const lastMon = new Date(mon); lastMon.setDate(mon.getDate() - 7);
    const lastSun = new Date(mon); lastSun.setDate(mon.getDate() - 1);
    return { from: ymd(lastMon), to: ymd(lastSun) };
  }

  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  return { from: ymd(mon), to: ymd(fri > now ? now : fri) };
}

/** 把存下来的口径换算成真正要用的起止日期 */
export function resolveRange(prefs: DigestPrefs | null, now = new Date()): { from: string; to: string } {
  if (!prefs) return presetRange('thisWeek', now);
  if (prefs.range === 'custom') {
    // 手改的日期若已经坏了，宁可退回本周，也不要用一个空区间去请求
    if (prefs.from && prefs.to && prefs.from <= prefs.to) return { from: prefs.from, to: prefs.to };
    return presetRange('thisWeek', now);
  }
  return presetRange(prefs.range as Exclude<RangePreset, 'custom'>, now);
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.map(x => String(x).trim()).filter(Boolean))) : [];

const record = (v: unknown): Record<string, string[]> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const list = strList(val);
    if (k && list.length) out[k] = list;
  }
  return out;
};

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验并补全。localStorage 里的东西不可信（可能被手改、可能是旧版本格式）,
 * 一律按字段白名单重建，坏的字段回落默认值而不是整个丢掉。
 */
export function sanitizePrefs(raw: unknown): DigestPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const optSrc = (o.opts && typeof o.opts === 'object' ? o.opts : {}) as Record<string, unknown>;

  const layout = LAYOUTS.includes(optSrc.layout as DigestOptions['layout'])
    ? (optSrc.layout as DigestOptions['layout'])
    : DEFAULT_DIGEST_OPTIONS.layout;
  const over = Number(optSrc.mergeModulesOver);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

  return {
    range: PRESETS.includes(o.range as RangePreset) ? (o.range as RangePreset) : 'thisWeek',
    from: ymdRe.test(String(o.from || '')) ? String(o.from) : '',
    to: ymdRe.test(String(o.to || '')) ? String(o.to) : '',
    productIds: record(o.productIds),
    openedBy: record(o.openedBy),
    opts: {
      layout,
      includeWeekly: bool(optSrc.includeWeekly, DEFAULT_DIGEST_OPTIONS.includeWeekly),
      mergeModulesOver: Number.isFinite(over) ? Math.max(0, Math.min(200, Math.round(over))) : DEFAULT_DIGEST_OPTIONS.mergeModulesOver,
      includeSummary: bool(optSrc.includeSummary, DEFAULT_DIGEST_OPTIONS.includeSummary),
      includeNextWeek: bool(optSrc.includeNextWeek, DEFAULT_DIGEST_OPTIONS.includeNextWeek),
    },
  };
}

/** 读；没有或坏了都当「没存过」，不抛异常 */
export function loadDigestPrefs(): DigestPrefs | null {
  try {
    const raw = localStorage.getItem(DIGEST_PREFS_KEY);
    if (!raw) return null;
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 写；配额满 / 隐私模式禁写时静默失败（记不住选择不该拦住生成） */
export function saveDigestPrefs(prefs: DigestPrefs): void {
  try {
    localStorage.setItem(DIGEST_PREFS_KEY, JSON.stringify(prefs));
  } catch { /* 忽略 */ }
}

/**
 * 只保留当前项目列表里还存在 id。
 * 项目被删掉后旧 id 会一直留在存储里，勾上一堆不存在的项目会让「生成」看起来没反应。
 */
export function keepKnownProductIds(
  saved: Record<string, string[]>,
  projects: Record<string, Array<{ id: string | number }>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [iid, ids] of Object.entries(saved || {})) {
    const list = projects[iid];
    if (!list || list.length === 0) continue; // 这家公司这次没拉到列表，先不勾
    const known = new Set(list.map(p => String(p.id)));
    const keep = (ids || []).filter(id => known.has(String(id)));
    if (keep.length) out[iid] = keep;
  }
  return out;
}
