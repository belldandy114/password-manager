/**
 * 目录模式笔记的类型判定（纯函数，无 React / 无 fs / 无 DOM）。
 *
 * 背景：1.24.3 把「SQL 片段」并进了「测试笔记」，本地加密库模式靠 `note.kind` 区分。
 * 但目录模式（一篇一个 .md 文件）**没有类型元数据** —— 磁盘上只有一个文件名和正文，
 * 所以目录模式下类型筛选条一直是隐藏的（`{!dirMode && ...}`）。
 *
 * 这里用「文件名约定 + 正文特征」把类型判出来：
 *   1. 文件名以 `.sql.md`（或 `.sql`）结尾 → SQL 片段（新建 SQL 片段时就是这么命名的）；
 *   2. 正文以 `--` 或 `/*` 开头，且含 SELECT / INSERT / UPDATE / DELETE / CREATE / ALTER / DROP
 *      等语句关键字 → SQL 片段（用户从 DBeaver / Navicat 里复制出来的片段通常带注释头）；
 *   3. 其余一律当普通 Markdown 笔记。
 *
 * 为什么先看文件名：目录里可能有几百个文件，为了分类把所有正文都读一遍会让页面卡住
 * （每个文件一次 IPC + 一次磁盘读）。文件名能定的直接定，定不了的才按需读正文，
 * 且只读前 N 个（`planDirKinds` 的 `maxBodyReads`），剩下的默认 note —— 宁可少判几个，
 * 也不能为了一个筛选条把整个目录读一遍。
 */

/** 目录模式下笔记的类型（与本地库的 `Note.kind` 同构） */
export type DirNoteKind = 'note' | 'sql';

/**
 * SQL 语句关键字。
 *
 * 用 `\b` 包住，避免把 `SELECTED` / `CREATED_AT` 这类标识符误判成语句；
 * 只认「语句开头那几个词」，不追求完整 SQL 语法（这里只做分类，不做解析）。
 */
export const SQL_KEYWORD_RE =
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|MERGE|GRANT|REVOKE)\b/i;

/** 文件名是否已经能确定类型（`.sql.md` / `.sql` 结尾） */
export function kindDecidedByName(name: string): boolean {
  const n = String(name || '').trim().toLowerCase();
  return /\.sql\.(md|markdown|txt)$/.test(n) || /\.sql$/.test(n);
}

/**
 * 判断目录里的一个文件是普通笔记还是 SQL 片段。
 *
 * @param name 文件名（含扩展名，例如 `查用户.sql.md`）
 * @param body 正文；**没读过就传 undefined**，此时只有文件名能决定类型
 */
export function kindOfDirFile(name: string, body?: string): DirNoteKind {
  if (kindDecidedByName(name)) return 'sql';
  // BOM 会让 startsWith('--') 失效（Windows 记事本另存的文件常带 BOM）
  const text = String(body == null ? '' : body).replace(/^\uFEFF/, '').trimStart();
  if (!text) return 'note';
  // 只有「注释开头」才可能是 SQL：Markdown 正文里出现 SELECT 不该被当成片段
  if (!text.startsWith('--') && !text.startsWith('/*')) return 'note';
  return SQL_KEYWORD_RE.test(text) ? 'sql' : 'note';
}

export interface DirKindPlan {
  /** 文件名 → 类型（未读正文的按文件名/默认值先给一个） */
  kinds: Record<string, DirNoteKind>;
  /** 还需要读正文才能判定的文件名（已按 maxBodyReads 截断） */
  toRead: string[];
}

/**
 * 批量规划：哪些文件需要读正文才能分类。
 *
 * 调用方拿到 `toRead` 后逐条读正文，再带着新的 `bodies` 调一次本函数即可得到最终分类
 * （第二次调用时 `toRead` 会是空数组，不会重复读盘）。
 *
 * @param names       目录里的文件名列表
 * @param bodies      已读到的正文（name → content）；没读过的不放进来
 * @param maxBodyReads 最多为分类读多少个正文（默认 20）
 */
export function planDirKinds(
  names: string[],
  bodies: Record<string, string | undefined> = {},
  maxBodyReads = 20,
): DirKindPlan {
  const kinds: Record<string, DirNoteKind> = {};
  const toRead: string[] = [];
  const limit = Math.max(0, Math.floor(Number(maxBodyReads) || 0));
  for (const raw of names || []) {
    const name = String(raw || '');
    if (!name) continue;
    const body = bodies[name];
    if (body !== undefined) {
      kinds[name] = kindOfDirFile(name, body);
      continue;
    }
    if (kindDecidedByName(name)) {
      kinds[name] = 'sql';
      continue;
    }
    if (toRead.length < limit) {
      toRead.push(name);
      // 先按 note 占位：正文读回来之前不要让它从「全部」里消失
      kinds[name] = 'note';
      continue;
    }
    kinds[name] = 'note';
  }
  return { kinds, toRead };
}

/** 统计各类型的数量（筛选条上的计数） */
export function countDirKinds(kinds: Record<string, DirNoteKind>): { all: number; note: number; sql: number } {
  let note = 0;
  let sql = 0;
  for (const k of Object.values(kinds || {})) {
    if (k === 'sql') sql += 1;
    else note += 1;
  }
  return { all: note + sql, note, sql };
}
