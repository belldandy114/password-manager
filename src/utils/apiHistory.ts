import type { ApiHistoryItem } from '../types';

/**
 * 接口调试左侧列表的纯逻辑：按天分组 + 关键字过滤。
 *
 * 抽出来单独测的原因：分组要处理「今天 / 昨天 / 同年 / 跨年 / 非法时间」五种情况，
 * 全塞进组件里只能靠肉眼点，漏掉一种就是「时间标签显示成 Invalid Date」。
 */

const pad = (n: number) => String(n).padStart(2, '0');

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export interface DayLabel {
  /** 分组键：YYYY-MM-DD（非法时间为 'unknown'） */
  key: string;
  /** 展示文案：今天 / 昨天 / 10 月 27 日 / 2025-12-31 / 未知时间 */
  label: string;
}

/** 把时间戳换成「分组键 + 人话标签」 */
export function dayLabel(iso: string | undefined | null, now: Date = new Date()): DayLabel {
  if (!iso) return { key: 'unknown', label: '未知时间' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { key: 'unknown', label: '未知时间' };
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (sameDay(d, now)) return { key, label: '今天' };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return { key, label: '昨天' };
  if (d.getFullYear() === now.getFullYear()) return { key, label: `${d.getMonth() + 1} 月 ${d.getDate()} 日` };
  return { key, label: key };
}

export interface HistoryGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * 按天分组，**保持原有顺序**（列表本身是新→旧），只在相邻同天的项之间插入组头。
 * 不做排序：万一调用方传进来的是乱序，也不该在展示层偷偷重排。
 */
export function groupByDay<T extends { at?: string }>(list: T[], now: Date = new Date()): HistoryGroup<T>[] {
  const groups: HistoryGroup<T>[] = [];
  for (const item of list) {
    const { key, label } = dayLabel(item.at, now);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label, items: [item] });
    }
  }
  return groups;
}

/** 关键字匹配：任一字段包含即命中；空关键字视为全部命中 */
export function matchesQuery(q: string, ...texts: (string | number | undefined | null)[]): boolean {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  return texts.some((t) => String(t ?? '').toLowerCase().includes(needle));
}

/** 历史列表过滤（方法 / 地址 / 状态码） */
export function filterHistory(list: ApiHistoryItem[], q: string): ApiHistoryItem[] {
  if (!String(q ?? '').trim()) return list;
  return list.filter((h) => matchesQuery(q, h.method, h.url, h.status));
}
