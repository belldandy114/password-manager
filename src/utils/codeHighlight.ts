/**
 * 代码高亮 tokenizer —— 纯函数、零依赖、不碰 DOM/React
 *
 * 契约：docs/acceptance/W8-组件契约.md §1.3（本文件是它的实现；改签名前先改契约）。
 * 配色不在这里定：7 个语义类名对应 redesign.css §1.34.0 段（tok-kw / tok-ann / tok-type /
 * tok-str / tok-num / tok-cmt / tok-fn），颜色全走既有 token，本文件只负责「打标」。
 *
 * 三条设计约束（都是硬要求，别为了省事绕开）：
 * 1) **逐字符无损**：`lines[i].tokens` 拼起来必须还原该行原文（含空白）。任何 token 分支都要
 *    吞掉 ≥1 个字符，绝不吞行 —— 无损是可断言的不变量，也是「高亮错了只是颜色不对、信息不丢」
 *    这句承诺的技术前提。
 * 2) **不用 dangerouslySetInnerHTML 的替代**：返回结构化 token，由 React 用 `<span>` 渲染，
 *    转义交给 React（渲染的是用户本机项目代码，属于不可信输入）。
 * 3) **不为高亮引入依赖**：highlight.js / prism 的主题体系与本仓库 token 体系冲突，且关键字表
 *    随语言版本漂移（理由见契约 §1.1 的三维取舍表）。
 */

/* ================================================================
   对外类型与常量（契约 §1.3：名字与签名不许改）
   ================================================================ */

export type CodeLang = 'java' | 'json' | 'js' | 'ts' | 'sql' | 'xml' | 'text';

/**
 * 语义类名。空串 = 默认色（继承 `.dev-code` 的 `--text-1`）。
 * 只允许这 7 个 —— CSS 里没有第 8 个选择器，自造类名等于不上色（或更糟：命中别的规则）。
 */
export type TokClass =
  | ''
  | 'tok-kw'
  | 'tok-ann'
  | 'tok-type'
  | 'tok-str'
  | 'tok-num'
  | 'tok-cmt'
  | 'tok-fn';

export interface CodeToken {
  text: string;
  cls: TokClass;
}

export interface CodeLine {
  /** 1-based 行号（与文件行号一致，`scan:reveal` 之类按行定位时能对上） */
  no: number;
  tokens: CodeToken[];
}

export interface HighlightResult {
  /** 实际生效的语言（回退后是 'text'） */
  lang: CodeLang;
  /**
   * `false` 只表示「调用方给的语言名不认识、或压根没给」，已按纯文本处理。
   * 注意：`highlightCode(code, 'text')` 是**显式要纯文本**，`detected` 为 `true`。
   */
  detected: boolean;
  /** 已按 maxLines 截断的行 */
  lines: CodeLine[];
  /** 原文真实行数（不受 maxLines 影响） */
  totalLines: number;
  /** `totalLines > lines.length`，渲染层据此出「已显示前 N 行（共 M 行）」+ 展开按钮 */
  folded: boolean;
}

/**
 * 默认折叠阈值：超过它的内容只 tokenize 前 maxLines 行。
 *
 * 为什么是 400：单页元素上限 `MAX_ELEMENTS = 200`（`components/codegen/pomModel.ts`），
 * 生成器**每个元素 5 行、文件头 29 行**（`utils/codegen/pageobject.ts`；真窗口实测 3 元素 = 44 行、
 * 120 元素 = 629 行，两条都吻合 5n+29）⇒ 200 元素 ≈ **1,029 行**。400 行 ≈ 74 个元素。
 * 再大就默认折叠，用户点一次「展开全部」再全量渲染（`<span>` 渲染的 DOM 数 ≈ token 数，
 * 400×8 ≈ 3,200 个是能接受的量级；实测 120 元素 629 行 = 870 个 token span）。
 */
export const HIGHLIGHT_FOLD_LINES = 400;

/* ================================================================
   语言配置（语言差异只有三件事：注释定界、字符串定界、关键字/类型表）
   ================================================================ */

interface LangProfile {
  /** 行注释起始（可以有多个；同一个位置按数组顺序先到先认） */
  lineComment: string[];
  /** 块注释定界 [open, close]；可跨行（跨行状态由调用方传的 state 携带） */
  blockComment: [string, string] | null;
  /** 单行字符串定界符 */
  quotes: string[];
  /** 可跨行的模板串定界符（js/ts 的反引号） */
  templateQuote: string | null;
  keywords: Set<string>;
  types: Set<string>;
  /** 关键字/类型表是否大小写不敏感（SQL） */
  caseInsensitive: boolean;
  /** 注解/装饰器前缀（java 的 @Test、ts 的 @Component） */
  annotation: string | null;
  /** XML 家族：走标签扫描（标签名 = 类型色，属性名 = 关键字色） */
  markup: boolean;
}

const set = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const JAVA: LangProfile = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  templateQuote: null,
  keywords: set(`
    abstract assert break case catch class continue default do else enum extends final finally
    for if implements import instanceof interface native new package private protected public
    record return static strictfp super switch synchronized this throw throws transient try
    volatile while yield void true false null
  `),
  // 类型：基本类型 + 生成物里真正会出现的常见类型（Codegen 只产出 Playwright / RestAssured 两类）
  types: set(`
    int long double float boolean byte short char var
    String Object Integer Long Double Float Boolean Byte Short Character Void
    List Map Set ArrayList HashMap HashSet LinkedList Optional Stream Arrays Collections
    By WebDriver WebElement WebElementLocator Select Actions JavascriptExecutor
    Locator Page Response Request RequestSpecification ResponseSpecification ValidatableResponse
    JsonPath JsonNode Duration TimeUnit AriaRole
    Override Deprecated SuppressWarnings FunctionalInterface
  `),
  caseInsensitive: false,
  annotation: '@',
  markup: false,
};

const JS: LangProfile = {
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  templateQuote: '`',
  keywords: set(`
    const let var function return if else for while do switch case default break continue try
    catch finally throw new class extends implements interface type enum import from export
    await async yield typeof instanceof in of delete void this super null undefined true false
    readonly public private protected static get set as satisfies declare namespace
  `),
  types: set(`
    string number boolean any unknown never object symbol bigint
    Record Array Promise Map Set Date JSON RegExp Error Object String Number Boolean
  `),
  caseInsensitive: false,
  annotation: '@',
  markup: false,
};

const TS: LangProfile = { ...JS };

const JSON_PROFILE: LangProfile = {
  lineComment: [],
  blockComment: null,
  quotes: ['"'],
  templateQuote: null,
  // JSON 的三个字面量用关键字色（唯一有色相的「非字符串/非数字」记号）
  keywords: set('true false null'),
  types: new Set<string>(),
  caseInsensitive: false,
  annotation: null,
  markup: false,
};

const SQL: LangProfile = {
  lineComment: ['--'],
  blockComment: ['/*', '*/'],
  quotes: ["'"],
  templateQuote: null,
  keywords: set(`
    select from where and or not null insert into values update set delete create table index
    view drop alter add column join left right inner outer full cross on group by order having
    limit offset as distinct union all case when then else end is in like between exists primary
    key foreign references default asc desc with recursive truncate begin commit rollback
    transaction if exists unique constraint cascade
  `),
  types: set(`
    int integer varchar char text date datetime timestamp time boolean decimal numeric bigint
    smallint tinyint float double real blob json jsonb uuid serial
  `),
  caseInsensitive: true,
  annotation: null,
  markup: false,
};

const XML: LangProfile = {
  lineComment: [],
  blockComment: ['<!--', '-->'],
  quotes: ['"', "'"],
  templateQuote: null,
  keywords: new Set<string>(),
  types: new Set<string>(),
  caseInsensitive: false,
  annotation: null,
  markup: true,
};

const PROFILES: Record<Exclude<CodeLang, 'text'>, LangProfile> = {
  java: JAVA,
  json: JSON_PROFILE,
  js: JS,
  ts: TS,
  sql: SQL,
  xml: XML,
};

const KNOWN_LANGS: ReadonlySet<string> = new Set(['java', 'json', 'js', 'ts', 'sql', 'xml', 'text']);

/* ================================================================
   扩展名 → 语言
   ================================================================ */

const EXT_LANG: Record<string, CodeLang> = {
  java: 'java',
  json: 'json',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  sql: 'sql',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  svg: 'xml',
};

/**
 * 按路径取语言。认不出（无扩展名 / 未知扩展名）→ `'text'`。
 * 用最后一段路径取扩展名，`src/test/java/pages/LoginPage.java` 这类 POSIX 路径与 Windows
 * 反斜杠路径都能吃。
 */
export function langFromPath(path: string): CodeLang {
  const raw = String(path ?? '');
  const base = raw.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'text';
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] || 'text';
}

/* ================================================================
   扫描器
   ================================================================ */

interface ScanState {
  /** 上一行结束时块注释还没闭合 */
  inBlock: boolean;
  /** 上一行结束时模板串还没闭合（js/ts） */
  inTemplate: boolean;
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;
/** 数字字面量：0x / 0b / 0o / 十进制（含小数、指数），后面允许跟 Java 的 l/L/f/F/d/D 后缀 */
const NUM_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[lLfFdD]?/;

function classifyWord(word: string, p: LangProfile): TokClass {
  const key = p.caseInsensitive ? word.toLowerCase() : word;
  if (p.keywords.has(key)) return 'tok-kw';
  if (p.types.has(key)) return 'tok-type';
  return '';
}

/** 扫一行；返回的 token 拼起来必须等于入参行（无损） */
function scanLine(line: string, p: LangProfile, st: ScanState): CodeToken[] {
  const out: CodeToken[] = [];
  const push = (text: string, cls: TokClass): void => {
    if (!text) return;
    const last = out[out.length - 1];
    // 相邻同类合并：少 DOM 节点，也让单测能断言「没有相邻同类 token」
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };

  const n = line.length;
  let i = 0;

  // ① 续上上一行未闭合的块注释
  if (st.inBlock && p.blockComment) {
    const close = p.blockComment[1];
    const idx = line.indexOf(close);
    if (idx < 0) {
      push(line, 'tok-cmt');
      return out;
    }
    push(line.slice(0, idx + close.length), 'tok-cmt');
    i = idx + close.length;
    st.inBlock = false;
  }

  // ② 续上上一行未闭合的模板串（js/ts）
  if (st.inTemplate && p.templateQuote) {
    const q = p.templateQuote;
    const end = indexOfUnescaped(line, q, 0);
    if (end < 0) {
      push(line, 'tok-str');
      return out;
    }
    push(line.slice(0, end + q.length), 'tok-str');
    i = end + q.length;
    st.inTemplate = false;
  }

  while (i < n) {
    const c = line[i];

    // 块注释
    if (p.blockComment && line.startsWith(p.blockComment[0], i)) {
      const [open, close] = p.blockComment;
      const idx = line.indexOf(close, i + open.length);
      if (idx < 0) {
        push(line.slice(i), 'tok-cmt');
        st.inBlock = true;
        return out;
      }
      push(line.slice(i, idx + close.length), 'tok-cmt');
      i = idx + close.length;
      continue;
    }

    // 行注释：吃掉整行剩余
    const lc = p.lineComment.find((t) => line.startsWith(t, i));
    if (lc) {
      push(line.slice(i), 'tok-cmt');
      return out;
    }

    // 注解 / 装饰器（@Test、@Component）
    if (p.annotation && c === p.annotation) {
      let j = i + 1;
      while (j < n && ID_PART.test(line[j])) j++;
      if (j > i + 1) {
        push(line.slice(i, j), 'tok-ann');
        i = j;
        continue;
      }
      push(c, '');
      i += 1;
      continue;
    }

    // 模板串（可跨行）
    if (p.templateQuote && c === p.templateQuote) {
      const q = p.templateQuote;
      const end = indexOfUnescaped(line, q, i + 1);
      if (end < 0) {
        push(line.slice(i), 'tok-str');
        st.inTemplate = true;
        return out;
      }
      push(line.slice(i, end + q.length), 'tok-str');
      i = end + q.length;
      continue;
    }

    // 单行字符串：未闭合就到行尾为止（不跨行 —— Java 文本块 """ 也按普通串处理，见契约 §1.3）
    if (p.quotes.includes(c)) {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === c) { j += 1; break; }
        j += 1;
      }
      const end = Math.min(j, n);
      push(line.slice(i, end), 'tok-str');
      i = end;
      continue;
    }

    // 数字（前面紧贴标识符字符时不认：`a1` 已在标识符分支整段吃掉）
    if (c >= '0' && c <= '9') {
      const m = NUM_RE.exec(line.slice(i));
      if (m) {
        push(m[0], 'tok-num');
        i += m[0].length;
        continue;
      }
    }

    // 标识符 / 关键字 / 类型 / 方法调用
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(line[j])) j++;
      const word = line.slice(i, j);
      const cls = classifyWord(word, p);
      if (cls) {
        push(word, cls);
        i = j;
        continue;
      }
      // 方法调用：后面（跳过空格）紧跟 '(' —— 4 个色相已用尽，靠字重 + 括号区分
      let k = j;
      while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
      push(word, line[k] === '(' ? 'tok-fn' : '');
      i = j;
      continue;
    }

    // XML：标签名 / 属性名 / 属性值
    if (p.markup) {
      if (c === '<') {
        let j = i + 1;
        const closing = line[j] === '/';
        if (closing) j += 1;
        let k = j;
        while (k < n && /[A-Za-z0-9_:.-]/.test(line[k])) k++;
        if (k > j) {
          push(line.slice(i, j), '');
          push(line.slice(j, k), 'tok-type');
          i = k;
          // 标签内：属性名 = 关键字色，属性值 = 字符串色
          while (i < n && line[i] !== '>' && !line.startsWith('/>', i)) {
            const ch = line[i];
            if (p.quotes.includes(ch)) {
              let m = i + 1;
              while (m < n && line[m] !== ch) m += 1;
              const end = Math.min(m + 1, n);
              push(line.slice(i, end), 'tok-str');
              i = end;
              continue;
            }
            if (/[A-Za-z_:]/.test(ch)) {
              let m = i + 1;
              while (m < n && /[A-Za-z0-9_:.-]/.test(line[m])) m += 1;
              push(line.slice(i, m), 'tok-kw');
              i = m;
              continue;
            }
            push(ch, '');
            i += 1;
          }
          continue;
        }
      }
    }

    // 其它（括号 / 操作符 / 空白 / 标点）：单字符，靠 push 的合并压成一个 token
    push(c, '');
    i += 1;
  }

  return out;
}

/** 从 from 起找未转义的定界符位置；找不到返回 -1 */
function indexOfUnescaped(line: string, needle: string, from: number): number {
  for (let i = from; i < line.length; i += 1) {
    if (line[i] === '\\') { i += 1; continue; }
    if (line.startsWith(needle, i)) return i;
  }
  return -1;
}

/* ================================================================
   入口
   ================================================================ */

function normalizeCap(maxLines: number | undefined): number {
  if (maxLines === undefined) return HIGHLIGHT_FOLD_LINES;
  if (!Number.isFinite(maxLines)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(maxLines));
}

/**
 * 把源码切成「行 → token」。
 *
 * - 未知语言 / 省略语言参数 → 按 `'text'` 处理（整行一个 token，不做分类），`detected=false`；
 * - 空串 → `lines: []`、`totalLines: 0`；
 * - CRLF 一律归一成 `\n`（生成器的 `normalizeJava` 保证 LF，但用户可能粘贴 CRLF 进来）；
 * - 超过 `maxLines` 只 tokenize 前 N 行，`totalLines` 仍是真实行数（折叠提示要用）。
 *
 * 纯函数：同一入参两次调用结果深度相等，不读全局、不写外部状态。
 */
export function highlightCode(
  code: string,
  lang?: CodeLang | string,
  opts?: { maxLines?: number },
): HighlightResult {
  const raw = typeof code === 'string' ? code : String(code ?? '');
  const asked = typeof lang === 'string' ? lang : undefined;
  const langOk = asked !== undefined && KNOWN_LANGS.has(asked);
  const resolved = (langOk ? asked : 'text') as CodeLang;
  const detected = langOk;

  const norm = raw.replace(/\r\n?/g, '\n');
  if (norm === '') {
    return { lang: resolved, detected, lines: [], totalLines: 0, folded: false };
  }

  const all = norm.split('\n');
  const totalLines = all.length;
  const cap = normalizeCap(opts?.maxLines);
  const visible = Math.min(totalLines, cap);
  const profile = resolved === 'text' ? null : PROFILES[resolved];
  const st: ScanState = { inBlock: false, inTemplate: false };

  const lines: CodeLine[] = [];
  for (let k = 0; k < visible; k += 1) {
    const text = all[k];
    // 空行不给 token（0 个）；非空行至少 1 个 —— 见契约 §1.3 不变量 2 的边界说明
    const tokens = text === ''
      ? []
      : profile
        ? scanLine(text, profile, st)
        : [{ text, cls: '' as TokClass }];
    lines.push({ no: k + 1, tokens });
  }

  return { lang: resolved, detected, lines, totalLines, folded: totalLines > lines.length };
}