/**
 * 「SQL 片段」并入「测试笔记」之后，搜索面板的数据视图。
 *
 * 1.24.3 之前有两个独立集合：notes（Markdown 笔记）和 snippets（SQL 片段）。
 * 合并后 SQL 语句存在 notes 里、用 `kind: 'sql'` 区分，旧 snippets 集合**保留不删**
 * 作为兜底（笔记页首次打开时才做迁移）。所以命令面板不能只读其中一个：
 *   - 只读 notes：迁移前新建的旧片段会搜不到；
 *   - 只读 snippets：迁移后的新片段搜不到。
 *
 * 这里把两处合成一份不重复的 SQL 列表，两个搜索入口（Ctrl+K 主面板 /
 * Ctrl+空格 小窗）共用，避免行为再分叉。
 */

export interface NoteLike {
  id?: string;
  title?: string;
  content?: string;
  tags?: string[];
  kind?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface SqlLike {
  id?: string;
  title?: string;
  sql?: string;
  tags?: string[];
  updatedAt?: string;
  [key: string]: unknown;
}

export interface SqlView { id: string; title: string; sql: string; tags: string[] }

const keyOf = (title: unknown, body: unknown) => `${String(title || '')}\u0000${String(body || '')}`;

/**
 * @param notes    notes 集合（可能含 kind==='sql' 的新片段）
 * @param snippets 旧 snippets 集合（迁移后仍保留）
 */
export function mergeSqlViews(notes: NoteLike[], snippets: SqlLike[]): SqlView[] {
  const out: SqlView[] = [];
  const seen = new Set<string>();
  const push = (id: unknown, title: unknown, body: unknown, tags: unknown) => {
    const k = keyOf(title, body);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({
      id: String(id || ''),
      title: String(title || '（未命名 SQL 片段）'),
      sql: String(body || ''),
      tags: Array.isArray(tags) ? tags.map(String) : [],
    });
  };
  for (const n of notes || []) {
    if (n.kind === 'sql') push(n.id, n.title, n.content, n.tags);
  }
  for (const s of snippets || []) {
    push(s.id, s.title, s.sql, s.tags);
  }
  return out;
}

/** 普通 Markdown 笔记（SQL 片段由 mergeSqlViews 单独呈现，避免出现两条重复结果） */
export function plainNotes(notes: NoteLike[]): NoteLike[] {
  return (notes || []).filter(n => n.kind !== 'sql');
}
