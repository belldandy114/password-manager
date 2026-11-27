/**
 * 三语法共用的「行扫描器」（A₁ 输入侧，契约 [A1-8]）。
 *
 * 为什么不能再用正则切动作尾巴：Playwright codegen 在三种 Target 下产出的行形态不同，且
 * Java 的选项是**嵌套构造**（`new Page.GetByRoleOptions().setName("登录")`）、Python 的
 * `.first` / `.last` 是**无括号属性**——正则都会切错。这里按「引号 + 括号深度」扫描，
 * 保证：
 *   1. 字符串字面量里的 `.` / `(` / `)` / `,` **不参与**结构判断
 *      （否则 `getByText('行内有 .click( 字样')` 会被切在字符串中间，整行静默丢弃）；
 *   2. 允许无括号段（Python 的 `.first`）；
 *   3. 只从 `page` / `page0..N`（codegen 的弹窗别名）起扫，其它对象一律不当定位行。
 *
 * 纯函数：零 IPC、零 window、零 React。
 */

/** 一条链上的一个方法调用（`undefined` 括号段 = Python 的 `.first` 这类属性） */
export interface ScannedCall {
  /** 源码里的方法名（`get_by_role` / `getByRole`） */
  name: string;
  /** 归一后（`getByRole`）——三语法在这一步拉平 */
  camel: string;
  /** 括号里的原文（不解引号，交给各语法自己取值） */
  argsRaw: string;
  /** 有没有括号（Python 的 `.first` / `.last` / `.content_frame` 没有） */
  hadParen: boolean;
  /**
   * 括号/引号**到行尾都没闭合**（review-code 确认的行为：有界、不会死循环，但这一段是半截的）。
   * 调用方必须把整行判「认不出」并计入 `skippedLines`，**不许**拿半截实参硬造候选。
   */
  unclosed?: boolean;
}

export interface ScannedLine {
  /** `page` / `page0` / `page1`（弹窗别名） */
  alias: string;
  calls: ScannedCall[];
}

/** 页对象调用：`page.` / `page0.` / `page1.`，且 `page` 必须是独立词（`mypage.` 不算） */
const PAGE_CALL = /\bpage\d*\s*\./;

/**
 * 这行/这段文本是哪种 codegen Target 的写法（契约 [A1-8] (4)：**自动判定 + 只读回显**，不是用户选择）。
 *
 * 判定顺序固定（先命中先赢）：Java → Python → JS。
 * - Java 的特征是枚举常量与**选项对象构造**（类名有三种：`Page` / `Locator` / `FrameLocator`）；
 * - Python 的特征是蛇形方法名 `get_by_*`；
 * - 其余含 `getBy*` / `locator(` 的都按 JS（也是缺省）。
 *
 * 注意：**这是「输入侧」的判定**，产物侧仍只出 Java（`[N-4]`）；界面不得因此长出语种选择控件。
 */
export function targetOfText(text: string): 'js' | 'python' | 'java' {
  const s = String(text ?? '');
  if (/AriaRole\s*\./.test(s) || /new\s+(?:Page|Locator|FrameLocator)\.[A-Za-z]*Options\s*\(/.test(s)) return 'java';
  if (/\bget_by_[a-z_]+\s*\(/.test(s) || /\bframe_locator\s*\(/.test(s)) return 'python';
  return 'js';
}

/** `get_by_role` → `getByRole`：Python 的蛇形与 JS/Java 的驼峰在这一步拉平 */
export function camelOf(name: string): string {
  return String(name ?? '').replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 选项键归一：`has_text` / `hasText` / `setHasText` → `hastext`（三语法同一把尺） */
export function normKey(key: string): string {
  return String(key ?? '').replace(/_/g, '').toLowerCase();
}

/** 从 `src[start] === '('` 开始读到配对的 `)`；返回括号内原文、下一个下标，以及**是否真的闭合** */
function readBalanced(src: string, start: number): { raw: string; next: number; closed: boolean } {
  let depth = 0;
  let out = '';
  let quote = '';
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '(') { depth += 1; if (depth === 1) continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { raw: out, next: i + 1, closed: true };
    }
    out += ch;
  }
  // 走到行尾都没闭合：有界（不会死循环），但这一段是半截的 —— 由调用方整行丢弃
  return { raw: out, next: src.length, closed: false };
}

/** 标识符首字符（`[A-Za-z_$]`）；用 charCode 判，**不切子串**（见 scanLine 的 O(n) 说明） */
function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
}

/** 标识符后续字符（`[\w$]`） */
function isIdentPart(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

/**
 * 扫一行的顶层方法链。返回 `null` = 这行没有 `page*.` 调用（不是定位行，直接忽略）。
 *
 * 扫描是**语法无关**的：三语法在「方法名归一后」结构一致，差异只在实参写法上，
 * 由各语法自己的解析器读（见 `parsePython.ts` / `parseJava.ts`）。
 *
 * ## 复杂度（review-code C-10）
 * 标识符是**按下标推进**的一份状态机，不写 `src.slice(i)` —— 老实现每段都切一次"剩余全文"，
 * 一行 N 段链就是 O(n²)：`'page' + ".getByText('x')".repeat(20000)`（≈340KB）能卡到秒级。
 * 现在整行只被扫**一遍**（O(n)），性能回归单测见 `__tests__/elementPastePerf.test.ts`。
 */
export function scanLine(line: string): ScannedLine | null {
  const src = String(line ?? '');
  const at = PAGE_CALL.exec(src);
  if (!at) return null;
  const aliasMatch = /page\d*/.exec(at[0]);
  const alias = aliasMatch ? aliasMatch[0] : 'page';
  // `at[0]` 以 `.` 结尾 → 指针落在那个点上
  let i = at.index + at[0].length - 1;
  const calls: ScannedCall[] = [];
  while (i < src.length && src[i] === '.') {
    i += 1;
    // 标识符：按下标扫，O(标识符长度)，不切剩余子串
    if (!isIdentStart(src.charCodeAt(i))) break;
    const nameStart = i;
    i += 1;
    while (i < src.length && isIdentPart(src[i])) i += 1;
    const name = src.slice(nameStart, i);
    let argsRaw = '';
    let hadParen = false;
    let unclosed = false;
    if (src[i] === '(') {
      const r = readBalanced(src, i);
      argsRaw = r.raw;
      i = r.next;
      hadParen = true;
      unclosed = !r.closed;
    }
    calls.push({ name, camel: camelOf(name), argsRaw, hadParen, ...(unclosed ? { unclosed } : {}) });
    if (unclosed) break; // 半截实参后面不可能再有可信的段
    while (src[i] === ' ' || src[i] === '\t') i += 1;
    if (src[i] !== '.') break;
  }
  return calls.length ? { alias, calls } : null;
}

/** 按顶层逗号切实参（跳过字符串与嵌套括号/对象字面量） */
export function splitArgs(raw: string): string[] {
  const src = String(raw ?? '');
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += src[i + 1] ?? ''; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 去一层引号并解转义。不是字符串字面量 → `null`（调用方据此判「实参不是字面量，跳过」）。
 * `"xpath=//div[@id=\"a\"]"` → `xpath=//div[@id="a"]`
 */
export function unquoteLiteral(raw: string): string | null {
  const s = String(raw ?? '').trim();
  const q = s[0];
  if ((q !== '"' && q !== "'" && q !== '`') || s.length < 2 || !s.endsWith(q)) return null;
  return s.slice(1, -1).replace(/\\([\s\S])/g, '$1');
}
