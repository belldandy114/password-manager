/**
 * 目录模式下 SQL 片段的文件格式（纯函数，无 React / 无 fs / 无 DOM）。
 *
 * 用户选定的格式是 **YAML frontmatter + 空行 + SQL 正文**：
 *
 *   ---
 *   dbOrEnv: test_order / 预发
 *   varHint: "{{orderNo}} = 订单号"
 *   remark: 只读，别在生产跑
 *   starred: true
 *   tags: [订单, 造数]
 *   updatedAt: 2026-11-21T12:05:00.000Z
 *   ---
 *   SELECT * FROM t_refund WHERE order_no = {{orderNo}}
 *
 * 这里**不是**一个完整的 YAML 实现，只解析「第一层 key: value」，理由：
 * 1) 目录里的文件是用户手也可能改的，容错比严格更重要（见下「容错边界」）；
 * 2) 只认这 6 个键，别的键一律忽略，不引入 yaml 依赖。
 *
 * ## 容错边界（写单测锁住）
 * - **没有 frontmatter**（首行不是 `---`，或 `---` 没有闭合）：字段全空，**整篇都是 SQL 正文** ——
 *   1.25 时代的老 `.sql.md` 就是这个形状，读进来不能丢正文，保存时再补 frontmatter。
 * - 值里含冒号：只按**第一个**冒号切分，所以 `dbOrEnv: test_order / 预发` 原样保留。
 * - 值里含 `#`：**不当注释**，原样保留（严格 YAML 会把 ` #` 之后当注释吃掉，这里宁可保数据）。
 * - 值首尾有空格 / 含 `#` / 含 `:` / 以特殊符号开头：写文件时用双引号包裹（`JSON.stringify`），
 *   解析时剥掉外层引号并还原 `\"` `\'` `\\` `\n`。
 * - `tags`：`[a, b]` 与 `a, b` 两种写法都能读，**写一律 `[a, b]`**；元素里含逗号时用引号包住。
 * - `starred`：`true/yes/1` 为真（忽略大小写），其余（含缺省、乱写）为假。
 * - CRLF / BOM / 前导空行都能吃；读出来的正文统一成 LF（写盘也一律 LF，避免同一文件两种行尾）。
 * - 正文尾部空白在读取时去掉（写盘时统一只留一个结尾换行）。
 */

import type { Note } from '../types';

/** 目录模式下落库的 6 个字段 */
export interface SqlMeta {
  dbOrEnv: string;
  varHint: string;
  remark: string;
  starred: boolean;
  tags: string[];
  updatedAt: string;
}

export interface SqlFile {
  meta: SqlMeta;
  /** SQL 正文（已去掉文件首尾的空行；正文内部的缩进与换行原样） */
  content: string;
  /** 文件里到底有没有 frontmatter（没有 = 老文件；保存时会补上） */
  hasFrontmatter: boolean;
}

export const EMPTY_META: SqlMeta = {
  dbOrEnv: '', varHint: '', remark: '', starred: false, tags: [], updatedAt: '',
};

/** 目录模式下 Note.id 的前缀：真身是文件名，页面用它区分「库里的条目」与「目录里的文件」 */
export const DIR_ID_PREFIX = 'dir::';
export const dirId = (name: string): string => DIR_ID_PREFIX + String(name || '');
export const dirNameOf = (id: string): string => (
  String(id || '').startsWith(DIR_ID_PREFIX) ? String(id).slice(DIR_ID_PREFIX.length) : ''
);

/** 文件名 → 显示标题（去掉 `.sql.md` / `.md` / `.sql` 后缀，与笔记页的 titleOf 同规则） */
export function titleOfSqlFile(name: string): string {
  return String(name || '')
    .replace(/\.sql\.(md|markdown|txt)$/i, '')
    .replace(/\.(md|markdown|txt|sql)$/i, '');
}

/**
 * 标题 → SQL 片段文件名（`标题.sql.md`）。
 *
 * ⚠️ 与 `src/pages/Notes.tsx` 的 `fileOf(title, 'sql')` 是**同一套规则**：
 * 非法字符（`\ / : * ? " < > |`）→ `_`、连续空白折叠成一个空格、截 80 字、
 * 空标题兜底「未命名笔记」，再拼 `.sql.md`。那个函数没有导出（`Notes.tsx` 不在本轮
 * 改动范围内），所以这里复刻一份 —— **改一处必须改另一处**。
 * 正确做法是把它提到共享模块，属于本轮之外的后续清理。
 */
export function sqlFileName(title: string): string {
  const base = String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .replace(/\.sql\.(md|markdown|txt)$/i, '')
    .replace(/\.(md|markdown|txt)$/i, '') || '未命名笔记';
  return `${base}.sql.md`;
}

/**
 * 重名时加 `-2`、`-3`…（与主进程 `notesFileName` 的算法同思路，但后缀插在 `.sql.md` 之前，
 * 否则 `标题.sql-2.md` 就不再被 `kindDecidedByName` 认成 SQL 片段了）。
 * Windows 文件系统大小写不敏感，比较时统一小写。
 */
export function uniqueSqlFileName(desired: string, taken: string[]): string {
  const set = new Set((taken || []).map(t => String(t || '').toLowerCase()));
  const want = String(desired || '').trim() || '未命名笔记.sql.md';
  if (!set.has(want.toLowerCase())) return want;
  const m = want.match(/\.sql\.(md|markdown|txt)$/i);
  const base = m ? want.slice(0, m.index) : want.replace(/\.(md|markdown|txt)$/i, '');
  const ext = m ? want.slice(m.index) : '.sql.md';
  let i = 2;
  while (set.has(`${base}-${i}${ext}`.toLowerCase())) i += 1;
  return `${base}-${i}${ext}`;
}

/* ---------------- 值 / 列表的读写 ---------------- */

/** 拆 `[a, b]` / `a, b`：支持元素用引号包住（元素里可以有逗号） */
function splitList(raw: string): string[] {
  let s = String(raw || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',' || ch === '，') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/** `true/yes/1` → true；其余（含缺省、乱写）→ false */
function parseBool(raw: string): boolean {
  return /^(true|yes|1)$/i.test(String(raw || '').trim());
}

/** 剥掉外层引号并还原转义；没包引号就原样返回（不 trim 内部） */
function parseValue(raw: string): string {
  const v = String(raw ?? '').trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q)) {
      return v.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\(["'\\])/g, '$1');
    }
  }
  return v;
}

/** 需要引号的值：空串、首尾空格、含 `#` / `:`、以 YAML 特殊字符开头（含 `{` —— `{{变量}}` 开头必须引号）、含换行 */
function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (/^\s|\s$/.test(s) || /[#:]/.test(s) || /[\n\r]/.test(s)) return true;
  return /^[-?*&!|>%@`"'[\]{}]/.test(s);
}

function quoteValue(s: string): string {
  return needsQuote(s) ? JSON.stringify(s) : s;
}

/* ---------------- 解析 ---------------- */

/**
 * 解析一个 `.sql.md` 文件。
 *
 * @param raw 文件原始内容（可以是 BOM / CRLF）
 */
export function parseSqlFile(raw: string | null | undefined): SqlFile {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  /** 老文件分支的正文：统一成 LF（否则同一个文件在 Windows 上读出来是 CRLF，写回去又变 LF） */
  const plain = text.split(/\r?\n/).join('\n').replace(/\s+$/, '');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;

  // 首行不是 `---` → 老文件：整篇都是 SQL
  if (i >= lines.length || lines[i].trim() !== '---') {
    return { meta: { ...EMPTY_META }, content: plain, hasFrontmatter: false };
  }

  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== '---') j += 1;
  // 只有开头没有结尾 → 不当前言，整篇当正文（宁可多当正文，也不吞掉用户的 SQL）
  if (j >= lines.length) {
    return { meta: { ...EMPTY_META }, content: plain, hasFrontmatter: false };
  }

  const meta: SqlMeta = { ...EMPTY_META };
  for (const line of lines.slice(i + 1, j)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue; // 空行 / 注释
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1);
    switch (key) {
      case 'dbOrEnv': meta.dbOrEnv = parseValue(value); break;
      case 'varHint': meta.varHint = parseValue(value); break;
      case 'remark': meta.remark = parseValue(value); break;
      case 'starred': meta.starred = parseBool(parseValue(value)); break;
      case 'tags': meta.tags = splitList(parseValue(value)); break;
      case 'updatedAt': meta.updatedAt = parseValue(value); break;
      default: break; // 未知键忽略（用户手写的注释性字段不该报错）
    }
  }

  // 正文：闭合 `---` 之后，去掉紧随其后的**一个**空行
  const bodyLines = lines.slice(j + 1);
  if (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift();
  return { meta, content: bodyLines.join('\n').replace(/\s+$/, ''), hasFrontmatter: true };
}

/* ---------------- 序列化 ---------------- */

/**
 * 序列化：frontmatter（键顺序固定 dbOrEnv → varHint → remark → starred → tags → updatedAt）
 * + 一个空行 + SQL 正文 + 结尾换行。
 *
 * - `dbOrEnv` / `varHint` / `remark` 为空时**整行不写**（文件干净；读回来还是空字段）
 * - `starred` / `tags` / `updatedAt` 始终写（`starred: false`、`tags: []` 也是有效信息）
 * - 正文只去掉尾部空白，**不做 trim、不转义**（SQL 的缩进与 `{{变量}}` 一字不差）
 */
export function serializeSqlFile(meta: Partial<SqlMeta> | null | undefined, content: string): string {
  const m = { ...EMPTY_META, ...(meta || {}) };
  const lines: string[] = [];
  const db = String(m.dbOrEnv || '').trim();
  if (db) lines.push(`dbOrEnv: ${quoteValue(db)}`);
  const vars = String(m.varHint || '').trim();
  if (vars) lines.push(`varHint: ${quoteValue(vars)}`);
  const remark = String(m.remark || '').trim();
  if (remark) lines.push(`remark: ${quoteValue(remark)}`);
  lines.push(`starred: ${m.starred === true ? 'true' : 'false'}`);
  const tags = (m.tags || []).map(t => String(t || '').trim()).filter(Boolean);
  lines.push(`tags: [${tags.map(t => (needsQuote(t) ? quoteValue(t) : t)).join(', ')}]`);
  // updatedAt 是 ISO 串（自带冒号），不引号 —— 与用户确认的样例格式一致；空值写 "" 占位
  const at = String(m.updatedAt || '').trim();
  lines.push(`updatedAt: ${at || '""'}`);
  const body = String(content ?? '').replace(/\s+$/, '');
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

/* ---------------- Note <-> 文件 的映射（页面只跟 Note 打交道） ---------------- */

/** 文件 → 页面用的 Note（id 带 `dir::` 前缀，真身是文件名） */
export function noteFromSqlFile(name: string, raw: string, mtime?: string): Note {
  const { meta, content } = parseSqlFile(raw);
  return {
    id: dirId(name),
    title: titleOfSqlFile(name),
    content,
    tags: meta.tags,
    kind: 'sql',
    dbOrEnv: meta.dbOrEnv,
    varHint: meta.varHint,
    remark: meta.remark,
    starred: meta.starred,
    updatedAt: meta.updatedAt || String(mtime || ''),
  };
}

/** Note → 文件内容（页面上改完直接写盘） */
export function sqlFileText(n: Note): string {
  return serializeSqlFile({
    dbOrEnv: n.dbOrEnv,
    varHint: n.varHint,
    remark: n.remark,
    starred: n.starred,
    tags: n.tags,
    updatedAt: n.updatedAt,
  }, n.content || '');
}
