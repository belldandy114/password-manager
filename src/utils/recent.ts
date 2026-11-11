/**
 * 最近使用（条目 + 页面）。
 *
 * 为什么放 localStorage 而不是进库：这纯粹是「这台机器上我怎么用」的本地习惯，
 * 既不该跟着加密库同步到别的机器，也不该出现在导出文件里。内容只有 id 和一个
 * 计数器，不含名称/网址，所以明文放 localStorage 也不泄露条目内容。
 *
 * 条目 id 被删除后这里可能残留，读取时由调用方按现有条目过滤，不做主动清理
 * （清理要么写定时任务要么在改库时顺便扫，都不值得为此动数据层）。
 */

const ENTRY_KEY = 'pm.recent.entries';
const PAGE_KEY = 'pm.recent.pages';
/** 条目记 40 条，够覆盖一天的工作；页面就 12 个，记次数即可 */
const MAX_ENTRIES = 40;

export interface RecentEntry {
  id: string;
  /** 毫秒时间戳 */
  at: number;
  /** 使用次数（命令面板按它排序） */
  n: number;
}

export interface RecentPage {
  page: string;
  at: number;
  n: number;
}

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储满/被禁用时静默降级：最近使用丢失不影响主流程 */
  }
}

/** 记一次条目使用（选中、复制、打开、编辑都算） */
export function recordEntryUse(id: string): void {
  const key = String(id || '');
  if (!key) return;
  const list = read<RecentEntry>(ENTRY_KEY);
  const hit = list.find((x) => x && x.id === key);
  if (hit) {
    hit.at = Date.now();
    hit.n = (hit.n || 0) + 1;
  } else {
    list.unshift({ id: key, at: Date.now(), n: 1 });
  }
  list.sort((a, b) => (b.at || 0) - (a.at || 0));
  write(ENTRY_KEY, list.slice(0, MAX_ENTRIES));
}

export function getRecentEntries(): RecentEntry[] {
  return read<RecentEntry>(ENTRY_KEY).filter((x) => x && typeof x.id === 'string');
}

/** 命令面板排序用：0~1，用得多且用得近的分数高 */
export function entryUseScore(id: string): number {
  const hit = getRecentEntries().find((x) => x.id === id);
  if (!hit) return 0;
  const times = Math.min(hit.n || 1, 20) / 20;
  const ageDays = Math.max(0, (Date.now() - (hit.at || 0)) / 86400000);
  const fresh = Math.max(0, 1 - ageDays / 30);
  return times * 0.6 + fresh * 0.4;
}

/** 记一次页面访问（侧栏切换、命令面板跳页都算） */
export function recordPageUse(page: string): void {
  const key = String(page || '');
  if (!key) return;
  const list = read<RecentPage>(PAGE_KEY);
  const hit = list.find((x) => x && x.page === key);
  if (hit) {
    hit.at = Date.now();
    hit.n = (hit.n || 0) + 1;
  } else {
    list.unshift({ page: key, at: Date.now(), n: 1 });
  }
  write(PAGE_KEY, list);
}

export function getRecentPages(): RecentPage[] {
  return read<RecentPage>(PAGE_KEY).filter((x) => x && typeof x.page === 'string');
}

/** 页面使用得分（同上，用于把常用页排到前面） */
export function pageUseScore(page: string): number {
  const hit = getRecentPages().find((x) => x.page === page);
  if (!hit) return 0;
  const times = Math.min(hit.n || 1, 30) / 30;
  const ageDays = Math.max(0, (Date.now() - (hit.at || 0)) / 86400000);
  const fresh = Math.max(0, 1 - ageDays / 30);
  return times * 0.6 + fresh * 0.4;
}

/** 设置页「清除使用记录」用 */
export function clearRecent(): void {
  try {
    localStorage.removeItem(ENTRY_KEY);
    localStorage.removeItem(PAGE_KEY);
  } catch {
    /* 忽略 */
  }
}
