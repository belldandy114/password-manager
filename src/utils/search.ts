import { pinyin } from 'pinyin-pro';

interface Indexed {
  lower: string;
  initials: string;
  full: string;
}

const cache = new Map<string, Indexed>();

function buildIndex(text: string): Indexed {
  const lower = text.toLowerCase();
  if (!/[\u4e00-\u9fa5]/.test(text)) {
    // 纯 ASCII：首字母/全拼就是自身
    return { lower, initials: lower.replace(/[^a-z0-9]/g, ''), full: lower.replace(/[^a-z0-9]/g, '') };
  }
  try {
    const first = (pinyin(text, { pattern: 'first', toneType: 'none', type: 'array' }) as string[])
      .join('').toLowerCase().replace(/[^a-z0-9]/g, '');
    const full = (pinyin(text, { pattern: 'pinyin', toneType: 'none', type: 'array' }) as string[])
      .join('').toLowerCase().replace(/[^a-z0-9]/g, '');
    return { lower, initials: first, full };
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

/**
 * 模糊匹配：原文包含 / 拼音首字母 / 拼音全拼。
 * 「ali」「aly」「阿里」都能命中「阿里云」。
 */
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
