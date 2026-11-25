/**
 * 集合上限裁剪（契约 [C-24] / [C-25]，v10 更正落点）。
 *
 * **为什么要单独一个文件**：C-24 给了 5 个集合的字节上限、C-25 要求「超上限从最旧丢，并在 UI 提示
 * 最早 N 条已清理」，但这条规则原先指向的 `src/utils/runHistory.ts` **从未存在** ——
 * 结果就是 5 个集合一条裁剪都没有，涨到多大都照写。t33 核对时发现，v10 把落点改成本文件。
 *
 * 三条口径（写死在单测里）：
 * 1. **从最旧丢**：按 `at` → `updatedAt` → `createdAt` → 数组原顺序 找到「最旧」，优先丢它。
 *    不用「丢数组尾部」：历史集合里新的都在头部，尾部未必最旧，按时间排才对得上用户的直觉。
 * 2. **两种上限同时生效**：条数上限（`maxItems`，如 scanRuns ≤ 20）与字节上限
 *    （`maxBytes`，明文字节 = `JSON.stringify(集合)` 的 UTF-8 长度）。先按条数裁，再按字节裁。
 * 3. **不许静默丢**：返回值带 `dropped`，调用方必须在 UI 上说出来（[C-25] 的原话是
 *    「历史记录已按上限裁剪，最早 N 条已清理」）。本文件不打印、不弹窗，只把数字交出去。
 *
 * 纯函数：不 import 任何 React / IPC / fs；不原地改入参数组（返回新数组，入参保持原样）。
 */

/** 两个上限都可选；都不给 = 不裁剪（只做一次字节统计） */
export interface TrimCaps {
  /** 条数上限 */
  maxItems?: number;
  /** 字节上限（JSON.stringify 结果的 UTF-8 字节数） */
  maxBytes?: number;
}

export interface TrimResult<T> {
  /** 裁剪后的数组（**新数组**，入参数组不被修改） */
  items: T[];
  /** 被丢掉多少条；0 表示没超限 */
  dropped: number;
}

export interface TrimOptions<T> {
  /**
   * 取「这条有多旧」的时间戳。缺省依次尝试 `at` → `updatedAt` → `createdAt`，
   * 都取不到就按数组顺序（前面的更旧）。
   */
  timeOf?: (item: T) => string | number | undefined;
  /**
   * 单条本身就超过 `maxBytes` 时怎么办：
   * - `'keep'`（缺省）：保留它 —— 丢掉会让集合神秘清空，用户更没法处理；
   *   此时结果的字节数仍可能超过上限，属「不可再裁」的已知状态。
   * - `'drop'`：丢掉它（调用方自己权衡）。
   */
  singleOverflow?: 'keep' | 'drop';
}

/** 明文字节数：按契约 C-24 的口径用 `JSON.stringify` + UTF-8，不用 `.length`（中文 3 字节） */
export function byteLenOf(value: unknown): number {
  const s = JSON.stringify(value);
  if (s === undefined) return 0;
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // 代理对：一个字符 4 字节，跳过下一个半区
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * 一个 JSON 数组的明文字节数。
 *
 * 直接算 `byteLenOf(items)` 会每次重新序列化整个数组（O(n) 次 × O(n) 长度 = O(n²)），
 * 裁 2 万条时明显卡。这里用等价公式：`2 + 各项字节之和 + (n-1) 个逗号` ——
 * `JSON.stringify([a,b])` 就是 `[` + a + `,` + b + `]`，对任意 JSON 值都成立。
 */
export function bytesOfArray(items: unknown[]): number {
  if (!items.length) return 2; // "[]"
  let sum = 0;
  for (const it of items) sum += byteLenOf(it);
  return 2 + sum + (items.length - 1);
}

/** 默认时间键：`at` → `updatedAt` → `createdAt` */
function defaultTimeOf(item: unknown): string | number | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;
  for (const key of ['at', 'updatedAt', 'createdAt']) {
    const v = o[key];
    if (typeof v === 'string' || typeof v === 'number') return v;
  }
  return undefined;
}

/** 时间比较：能解析成时间就按时间，否则按字符串比较（ISO 字符串的字典序 == 时间序） */
function timeValue(v: string | number | undefined, fallbackIndex: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  // 取不到时间：用下标兜底（越靠前越旧）
  return Number.MAX_SAFE_INTEGER - 1e9 + fallbackIndex;
}

/**
 * 按上限裁剪集合：**从最旧开始丢**，直到同时满足条数与字节上限。
 *
 * @param items 待写入集合的数组（不会被修改）
 * @param caps  上限（见 `COLLECTION_CAPS`）
 * @param opts  时间键与单条超限策略
 * @returns     `{ items, dropped }`；`dropped > 0` 时调用方必须提示用户
 */
export function trimToCaps<T>(items: T[], caps: TrimCaps, opts: TrimOptions<T> = {}): TrimResult<T> {
  const src = Array.isArray(items) ? items : [];
  if (!src.length) return { items: [], dropped: 0 };

  const maxItems = typeof caps.maxItems === 'number' && Number.isFinite(caps.maxItems)
    ? Math.max(0, Math.floor(caps.maxItems))
    : undefined;
  const maxBytes = typeof caps.maxBytes === 'number' && Number.isFinite(caps.maxBytes)
    ? Math.max(0, Math.floor(caps.maxBytes))
    : undefined;

  // 没给任何上限：仍然返回**新数组**（调用方可以放心当副本用）
  if (maxItems === undefined && maxBytes === undefined) return { items: [...src], dropped: 0 };

  const timeOf = opts.timeOf || (defaultTimeOf as (item: T) => string | number | undefined);
  const strategy = opts.singleOverflow === 'drop' ? 'drop' : 'keep';

  // 先算出「从旧到新」的下标序（旧 → 新），裁剪时从头部丢
  const order = src
    .map((item, index) => ({ index, t: timeValue(timeOf(item), index) }))
    .sort((a, b) => (a.t === b.t ? a.index - b.index : a.t - b.t))
    .map((x) => x.index);

  const drop = new Set<number>();
  let kept = src.length;

  const removeOldest = (): boolean => {
    for (const idx of order) {
      if (!drop.has(idx)) {
        drop.add(idx);
        kept -= 1;
        return true;
      }
    }
    return false;
  };

  // 1) 条数上限
  if (maxItems !== undefined) {
    while (kept > maxItems && removeOldest()) { /* 继续丢最旧 */ }
  }

  // 2) 字节上限：每丢一条重算一次（kept 很小，实际代价可接受；也可改成累减优化）
  if (maxBytes !== undefined) {
    const current = (): T[] => src.filter((_, i) => !drop.has(i));
    while (kept > 0 && bytesOfArray(current()) > maxBytes) {
      if (kept === 1) {
        // 只剩一条还超限：这是「不可再裁」的状态，必须明确选择保留还是丢弃
        if (strategy === 'drop') removeOldest();
        break;
      }
      if (!removeOldest()) break;
    }
  }

  const out = src.filter((_, i) => !drop.has(i));
  return { items: out, dropped: src.length - out.length };
}

/* ================================================================
   6 个集合的上限（[C-24] 的字节 + 各自契约给的条数）
   ================================================================ */

/** 1 KB / 1 MB 的十进制常量（契约里写的是 KB/MB，按 1024 算，与代码里的“字节上限”一致） */
const KB = 1024;
const MB = 1024 * 1024;

/**
 * 每个集合的写入上限。**条数上限来自各集合自己的契约**：
 * - `scanRuns` ≤ 20 条（[C-29]）
 * - `coverageRuns` ≤ 20 条、单条 items ≤ 5000（[C-33]）
 * - `caseMaps` ≤ 20000 条（[C-34]）
 * - `pomPages` ≤ 200 条（[C-27]）
 * - `allureRuns` ≤ 20 条（[C-63] 附近的历史记录口径，与本文件同一套「从最旧丢」）
 * - `uiRecordings` ≤ 20 条 / 1536 KB（[C-24a]：20 份 × 300 步 × 一步约 180–250 B ≈ 54–75 KB/份）
 */
export const COLLECTION_CAPS: Record<string, Required<Pick<TrimCaps, 'maxBytes'>> & Pick<TrimCaps, 'maxItems'>> = {
  pomPages: { maxItems: 200, maxBytes: 512 * KB },
  scanRuns: { maxItems: 20, maxBytes: 1536 * KB },
  coverageRuns: { maxItems: 20, maxBytes: 1536 * KB },
  caseMaps: { maxItems: 20000, maxBytes: 1536 * KB },
  allureRuns: { maxItems: 20, maxBytes: 1024 * KB },
  uiRecordings: { maxItems: 20, maxBytes: 1536 * KB },
};

/**
 * 「未知集合」的字节兜底上限（[C-24] v18：**7.5 MB**，裁定 J-1）。
 *
 * ⚠️ 这个常量**不是**"6 个集合合计的运行时校验"——**代码里没有任何跨集合求和**。
 * 它目前只有一个用处：`capsOf()` 遇到 `COLLECTION_CAPS` 里没有的键时，回落到这个字节上限
 * （不裁条数、只按字节裁）。所以它挡住的是「将来新增集合忘了登记上限」，不是「总量超了」。
 *
 * 为什么从 6 MB 改成 7.5 MB（v18，裁定 J-1）：**六个**集合的单集合上限相加
 * = 512 + 1536 × 3 + 1024 + 1536 = **7680 KB = 7.5 MB**，6 MB 在物理上就不可能满足（全满即违约）。
 * 维持 6 MB 就只能删掉单测里那条 `Σcaps === TOTAL` 的硬断言，而 [C-113] 明令「不许删既有 it」
 * —— 那等于制造一条假绿。提到 7.5 MB 只是让契约自洽；**没有**因此新增求和校验——要真做总量约束
 * 得单独实现并配测试，现在没有，就不假装有。
 */
export const TOTAL_COLLECTION_BYTES = 7.5 * MB;

/** 取某个集合的上限；未知键回落到「不裁条数、7.5 MB 字节」这种保守值 */
export function capsOf(key: string): TrimCaps {
  return COLLECTION_CAPS[key] || { maxBytes: TOTAL_COLLECTION_BYTES };
}

/**
 * 给 UI 用的提示文案（[C-25] 的原话口径）。
 * 放在纯函数模块里，是为了让「提示什么」也能被单测锁住，而不是散在页面里各写一份。
 */
export function trimNotice(dropped: number): string {
  if (!dropped) return '';
  return `历史记录已按上限裁剪，最早 ${dropped} 条已清理`;
}