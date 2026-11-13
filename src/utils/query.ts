/**
 * 命令面板的搜索语法。
 *
 * 支持：
 *   tag:内网          按标签过滤（可写多次，取交集）
 *   env:prod|test|dev|stag  按环境过滤
 *   name:登录  url:api  user:admin   限定字段
 *   @note @snippet @account @request @case @env @entry @page @history @code  只看某一类
 *   其余自由文本按原来的包含匹配
 *
 * 为什么不把语法做进 Dashboard 的搜索框：那里的搜索是「在网址里找」，
 * 而全局搜索要跨六类数据，语法只在跨类时才有意义。
 */

export type QueryKind = 'page' | 'action' | 'entry' | 'snippet' | 'note' | 'account' | 'request' | 'checklist' | 'env' | 'history' | 'code';

const KIND_ALIAS: Record<string, QueryKind> = {
  '@page': 'page',
  '@action': 'action',
  '@entry': 'entry',
  '@url': 'entry',
  '@snippet': 'snippet',
  '@sql': 'snippet',
  '@note': 'note',
  '@account': 'account',
  '@request': 'request',
  '@api': 'request',
  '@case': 'checklist',
  '@checklist': 'checklist',
  '@env': 'env',
  '@history': 'history',
  '@code': 'code',
};

export interface ParsedQuery {
  /** 剩余的自由文本，已转小写 */
  text: string;
  kinds: QueryKind[];
  tags: string[];
  /** 'prod' | 'test' | ... 保存输入的前缀，比较时按前缀匹配 */
  envs: string[];
  name: string;
  url: string;
  user: string;
  /** 有没有用到语法（用来决定是否显示「语法生效中」提示） */
  syntax: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = { text: '', kinds: [], tags: [], envs: [], name: '', url: '', user: '', syntax: false };
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const free: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    const alias = KIND_ALIAS[lower];
    if (alias) { out.kinds.push(alias); out.syntax = true; continue; }
    const m = /^(tag|env|name|url|user):(.*)$/i.exec(w);
    if (m && m[2]) {
      const key = m[1].toLowerCase();
      const val = m[2].toLowerCase();
      if (key === 'tag') out.tags.push(val);
      else if (key === 'env') out.envs.push(val);
      else if (key === 'name') out.name = val;
      else if (key === 'url') out.url = val;
      else out.user = val;
      out.syntax = true;
      continue;
    }
    free.push(lower);
  }
  out.text = free.join(' ');
  return out;
}

export interface QueryTarget {
  kind: QueryKind;
  title: string;
  sub?: string;
  tags?: string[];
  env?: string;
  url?: string;
  user?: string;
}

/** 过滤 + 打分：命中字段越多分越高，供命令面板排序用 */
export function scoreTarget(t: QueryTarget, q: ParsedQuery): number {
  if (q.kinds.length > 0 && !q.kinds.includes(t.kind)) return -1;
  if (q.tags.length > 0) {
    const have = (t.tags || []).map((x) => x.toLowerCase());
    if (!q.tags.every((need) => have.some((h) => h.includes(need)))) return -1;
  }
  if (q.envs.length > 0) {
    const env = String(t.env || '').toLowerCase();
    if (!q.envs.every((need) => env.startsWith(need) || env.includes(need))) return -1;
  }
  let score = 0;
  if (q.name) {
    if (!t.title.toLowerCase().includes(q.name)) return -1;
    score += 3;
  }
  if (q.url) {
    if (!String(t.url || '').toLowerCase().includes(q.url)) return -1;
    score += 3;
  }
  if (q.user) {
    if (!String(t.user || '').toLowerCase().includes(q.user)) return -1;
    score += 3;
  }
  if (q.text) {
    const hay = `${t.title} ${t.sub || ''}`.toLowerCase();
    if (!hay.includes(q.text)) return -1;
    // 命中在标题上比命中在副标题上更相关
    score += t.title.toLowerCase().includes(q.text) ? 2 : 1;
  }
  return score;
}
