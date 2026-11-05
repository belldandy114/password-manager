/**
 * 缺陷汇总的历史快照（只在 localStorage 里，跨会话保留）。
 *
 * 为什么不用 zustand 的 persist：那个 store 走 sessionStorage 且只存数据，
 * 而这里的「上次统计」必须跨启动才有意义——今天打开应用要能跟昨天那次比。
 * 也正因为单独存，不会把几 MB 的 bug 列表塞进 localStorage。
 *
 * 口径对齐 zt_daily.py 的 prev_snapshot：取「上一个不同统计日」的最近一条作基准。
 * 同一天内多次统计会覆盖当天记录，否则下午再点一次，环比就退化成几个小时。
 */

export interface SumSnapshot {
  /** 项目组合 + 时间窗，换了组合就不比 */
  key: string;
  /** 统计时刻 'YYYY-MM-DD HH:mm' */
  at: string;
  /** 统计日（按换日时间切分） */
  day: string;
  total: number;
  fixed: number;
  active: number;
  resolved: number;
  closed: number;
  /** 剔除的安全问题条数 */
  security: number;
}

const STORE_KEY = 'pm.zentao.sumHistory';
/** 只留最近 60 条：一天一条的话够看两个月 */
const MAX = 60;

export function readHistory(): SumSnapshot[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is SumSnapshot => !!x && typeof x.key === 'string' && typeof x.at === 'string');
  } catch {
    return [];
  }
}

function write(list: SumSnapshot[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    // 隐私模式 / 配额满：历史丢了不影响主流程，静默降级为「首次统计」
  }
}

/** 记一次统计结果；同 key + 同统计日视为重跑，覆盖当天那条 */
export function pushHistory(snap: SumSnapshot): SumSnapshot[] {
  const list = readHistory().filter(x => !(x.key === snap.key && x.day === snap.day));
  list.push(snap);
  list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  write(list);
  return list;
}

/** 上一个不同统计日的最近一条（没有就 null，表示首次统计） */
export function prevOf(key: string, day: string): SumSnapshot | null {
  const older = readHistory().filter(x => x.key === key && x.day < day);
  return older.length ? older[older.length - 1] : null;
}

/** 当前有哪些基准可用（给「清空历史」用） */
export function clearHistory() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}
