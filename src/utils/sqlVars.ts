/**
 * SQL 片段的「变量填充」。
 *
 * 三条规则写死在这里（页面只做展示，纯逻辑全部落在这三个函数上，方便单测）：
 *   1. 只有 `{{名字}}` 算变量；名字字符集 = `\w` + `.` + `-`，两侧可有空格。
 *      **与接口调试的 `apiVars.applyVars` 保持同一形状**（见 sqlVars.test.ts 最后一组：
 *      两处一旦漂移，同一个 `{{a-b}}` 在接口调试能替换、在 SQL 片段里却认不出来）。
 *   2. 变量按**首次出现顺序去重** —— 弹窗里输入框的顺序要和读 SQL 时看到的顺序一致。
 *   3. 留空（或全是空白）**保留原样**，不把语句替换成 `where =1` 这种残缺 SQL。
 *      使用者自己负责值里的引号 / 分号转义，这里不做任何 SQL 字符串处理。
 */

/** token 形状的唯一写法；每次 new 一个，避免全局正则的 lastIndex 串状态 */
const VAR_TOKEN = String.raw`\{\{\s*([\w.-]+)\s*\}\}`;
const varRe = (): RegExp => new RegExp(VAR_TOKEN, 'g');

/** 提取变量名（按首次出现顺序去重）。正文为空 / null 返回空数组。 */
export function extractVars(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(text ?? '').matchAll(varRe())) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * 把 `{{var}}` 换成变量表里的值。
 * 未提供 / 空串 / 纯空白的值一律**保留原 token**（包括两侧空格，便于对照原文）。单遍替换，
 * 值里即使带 `{{...}}` 也不会被二次替换。
 */
export function fillVars(text: string, values: Record<string, string>): string {
  return String(text ?? '').replace(varRe(), (whole, name: string) => {
    const v = values ? values[name] : undefined;
    return typeof v === 'string' && v.trim() !== '' ? v : whole;
  });
}

/**
 * 解析「变量说明」字段 → `{ 变量名: 释义 }`，用于在输入框下方显示这个变量是什么。
 *
 * 支持文档里约定的写法 `{{orderNo}} = 订单号；{{today}} = 今天`，分隔符接受
 * `;` `；` `,` `，` 与换行；`=` `:` `：` 都算赋值号。没有说明 / 没有赋值号 /
 * 非法 token 的片段直接忽略（说明字段本来就是自由文本，不能因为它写得不规整就报错）。
 */
export function parseVarHint(hint: string): Record<string, string> {
  const out: Record<string, string> = {};
  String(hint ?? '').split(/[;；,\n\r，]/).forEach(chunk => {
    const m = chunk.match(/^\s*\{\{\s*([\w.-]+)\s*\}\}\s*[=:：]\s*(.+?)\s*$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim();
  });
  return out;
}

/* ============================================================
   第二批（docs/agents/sql-copy-vars-next.md §3.A / §3.B）
   ============================================================ */

/** 说明末尾已是分隔符就不再补一个（忽略尾部空白；但原文空白不改写） */
const HINT_SEP_END = /[;；,，\n\r]\s*$/;

/**
 * 「按正文生成」变量说明：已有条目**原样保留**，缺的追加 `{{name}} = `（全角分号分隔）。
 *
 * 判据 = `extractVars(hint)` 里出现过就跳过（队长裁定 §8）：裸 `{{t}}` 也算「已提到」，
 * 不会产出 `{{t}}；{{t}} = ` 这种重复条目；刚补出来的空条目 `{{t}} = ` 同理不会二次追加。
 * 幂等：第二次调用缺失集合为空 → 原文返回。已有文字一个字符都不改写（不 trim、不动空格/冒号/换行）。
 */
export function mergeVarHint(hint: string, vars: string[]): string {
  const text = String(hint ?? '');
  const list = Array.isArray(vars) ? vars.filter(v => typeof v === 'string' && v !== '') : [];
  if (list.length === 0) return text;
  const known = new Set(extractVars(text));
  const missing = list.filter(v => !known.has(v));
  if (missing.length === 0) return text;
  const add = missing.map(v => `{{${v}}} = `).join('；');
  // 说明是空的（或只有空白）→ 不加前导分号，也不把纯空白留在开头
  if (text.trim() === '') return add;
  return HINT_SEP_END.test(text) ? text + add : `${text}；${add}`;
}

export type DateVarKind = 'date' | 'datetime' | null;

/** `today` / `today±Nd` 是日期；`now` 是日期时间。其它名字不猜（§3.B「不认识的变量名不给按钮」） */
const DATE_VAR = /^today(?:([+-])(\d{1,3})d)?$/;

export function dateVarKind(name: string): DateVarKind {
  const s = String(name ?? '');
  if (s === 'now') return 'datetime';
  if (DATE_VAR.test(s)) return 'date';
  return null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 日期变量的值（**本地时区**）。`now` 必须由调用方注入 —— 函数内部不取 `new Date()`，
 * 单测才能把时间钉死（§3.B）。
 *
 * ⚠️ 禁止 `toISOString().slice(0,10)`：那是 UTC，东八区本地凌晨会差一天；
 * 这里一律用 getFullYear/getMonth/getDate 拼，`today±Nd` 走 `new Date(y, m, d + delta)`，
 * 跨月 / 跨年 / 闰年交给 Date 自己算。
 */
export function dateVarValue(name: string, now: Date): string {
  const kind = dateVarKind(name);
  if (kind === null) return '';
  const base = now instanceof Date ? now : new Date(NaN);
  if (Number.isNaN(base.getTime())) return '';
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  if (kind === 'datetime') {
    return `${y}-${pad2(m + 1)}-${pad2(d)} ${pad2(base.getHours())}:${pad2(base.getMinutes())}:${pad2(base.getSeconds())}`;
  }
  const mt = String(name).match(DATE_VAR);
  const delta = mt && mt[1] ? (mt[1] === '-' ? -1 : 1) * Number(mt[2]) : 0;
  const t = new Date(y, m, d + delta);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

/* ============================================================
   第三批：选中一段文字 → 转成 {{变量}}（编辑弹窗「转化为变量」）
   ============================================================ */

/** 正则里的转义（变量名允许 `.` `-`，不能直接拼进 RegExp） */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把选中的原文变成变量名：只保留 token 允许的 `\w . -`，其它字符连续段折成一个 `_`，
 * 再去掉首尾下划线（`order id` → `order_id`、`id;` → `id`、`{{id}}` → `id`）。
 * 纯中文 / 纯符号 → 空串：**不猜**，让用户自己起名（空串时弹窗里「确定」不可用）。
 */
export function sanitizeVarName(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  return s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** wrapSelection 的结果：替换后的整段文本 + 插入后光标应落的位置（token 之后） */
export interface WrapSelectionResult {
  text: string;
  caret: number;
}

/**
 * 把 `text[start, end)` 换成 `{{name}}`。空选区 / 反向选区 / 越界 / 空名字一律返回 `null`
 * —— 调用方据此提示「先选中一段文字」，**不要**悄悄改文本。
 */
export function wrapSelection(text: string, start: number, end: number, name: string): WrapSelectionResult | null {
  const src = String(text ?? '');
  const s = Math.trunc(Number(start));
  const e = Math.trunc(Number(end));
  const n = String(name ?? '').trim();
  if (!n || !Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (s < 0 || e > src.length || s >= e) return null;
  const token = `{{${n}}}`;
  return { text: src.slice(0, s) + token + src.slice(e), caret: s + token.length };
}

/**
 * 把「名称 / 说明」写进变量说明文本：
 * - 该变量**还没有**条目 → 追加 `{{name}} = desc`（用 `；` 分隔；desc 空则只留 `{{name}} = `）；
 * - **已有**条目 → 只改它的释义，赋值符（`=` / `:` / `：`）按原文保留；desc 留空则**不改**（不擦掉用户写的）；
 * - 其它条目逐字保留（含换行与全角分号，不重新排版）。
 */
export function upsertVarHint(hint: string, name: string, desc: string): string {
  const text = String(hint ?? '');
  const n = String(name ?? '').trim();
  if (!n) return text;
  const d = String(desc ?? '').trim();
  const token = `{{${n}}}`;
  // 保留分隔符本身，拼回时原样不动
  const chunks = text.split(/([;；\n\r，,])/);
  for (let i = 0; i < chunks.length; i += 2) {
    const part = chunks[i];
    if (!part || !extractVars(part).includes(n)) continue;
    if (!d) return text; // 说明留空：已有释义一个字都不动
    const re = new RegExp(`\\{\\{\\s*${escapeRe(n)}\\s*\\}\\}(\\s*[=:：]\\s*)?[\\s\\S]*$`);
    chunks[i] = part.replace(re, (_m, sep: string | undefined) => `${token}${sep === undefined ? ' = ' : sep}${d}`);
    return chunks.join('');
  }
  const add = `${token} = ${d}`;
  if (text.trim() === '') return add;
  return /[;；,\n\r，]\s*$/.test(text) ? text + add : `${text}；${add}`;
}
