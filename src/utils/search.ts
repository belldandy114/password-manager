/**
 * 模糊搜索：原文包含 / 拼音首字母 / 拼音全拼。
 *
 * 拼音字典（pinyin-pro，压缩后仍占主包约 41 KB）不参与首屏：模块加载时只做
 * 原文与子串匹配，应用启动后由 preloadPinyin() 异步把字典拉成独立 chunk，
 * 到手后清空索引缓存并广播一次，搜索框下一次渲染就能用拼音命中。
 * 这样即使字典 chunk 失败（断网、被拦），搜索也只是不支持拼音，不会报错。
 */
type PinyinFn = (text: string, options: Record<string, unknown>) => unknown;

interface Indexed {
  lower: string;
  initials: string;
  full: string;
}

const cache = new Map<string, Indexed>();

let pinyinFn: PinyinFn | null = null;
let preloadPromise: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

/** 字典准备好后派发的全局事件，页面可以据此补一次渲染 */
export const PINYIN_READY_EVENT = 'pm:pinyin-ready';

function toLetters(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildIndex(text: string): Indexed {
  const lower = text.toLowerCase();
  const ascii = toLetters(lower);
  if (!/[\u4e00-\u9fa5]/.test(text)) {
    // 纯 ASCII：首字母/全拼就是自身
    return { lower, initials: ascii, full: ascii };
  }
  const fn = pinyinFn;
  if (!fn) {
    // 字典还没到位：先只支持原文匹配
    return { lower, initials: '', full: '' };
  }
  try {
    const first = (fn(text, { pattern: 'first', toneType: 'none', type: 'array' }) as string[]).join('');
    const full = (fn(text, { pattern: 'pinyin', toneType: 'none', type: 'array' }) as string[]).join('');
    return { lower, initials: toLetters(first), full: toLetters(full) };
  } catch {
    return { lower, initials: '', full: '' };
  }
}

export function getIndex(text: string): Indexed {
  const key = text || '';
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 4000) cache.clear();
  const idx = buildIndex(key);
  cache.set(key, idx);
  return idx;
}

export function isPinyinReady(): boolean {
  return pinyinFn !== null;
}

/** 订阅「字典已就绪」，返回退订函数 */
export function onPinyinReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => { readyListeners.delete(listener); };
}

/**
 * 异步加载拼音字典。重复调用返回同一个 Promise。
 * 失败只记一句话，不抛错——搜索降级为纯原文匹配。
 */
export function preloadPinyin(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  preloadPromise = import('pinyin-pro')
    .then((mod) => {
      pinyinFn = mod.pinyin as unknown as PinyinFn;
      cache.clear(); // 之前按「无字典」建的索引要重算
      for (const fn of Array.from(readyListeners)) {
        try { fn(); } catch { /* 单个订阅者出错不影响其他 */ }
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(PINYIN_READY_EVENT));
      }
    })
    .catch(() => {
      /* 加载失败：保持降级，允许下次再试 */
      preloadPromise = null;
    });
  return preloadPromise;
}

export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const idx = getIndex(text || '');
  if (idx.lower.includes(q)) return true;
  if (idx.initials && idx.initials.includes(q)) return true;
  if (idx.full && idx.full.includes(q)) return true;
  return false;
}
