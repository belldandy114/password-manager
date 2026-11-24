/**
 * Java 代码生成的**共用转义层**（契约 §3.2 / [C-86]；批次 W2，见 §4.1.1 逆向依赖扫描）。
 *
 * 为什么它是第一个文件：`pojo.ts` / `restassured.ts` / `pageobject.ts` 三个生成器都要把
 * 用户输入（JSON key、定位器、文本）拼进 Java 源码，而 [C-107] 规定 **三个生成器互不引用、
 * 只能共同依赖本文件**。所以「字符串字面量怎么转义」「标识符怎么合法化」只在这里定义一次，
 * 别处一律 import，不许各自抄一份（抄出来的第二份迟早漏掉 `${` 那一类）。
 *
 * 本文件是纯函数：不读文件、不碰 IPC、不含时间戳/随机数（[C-85]：生成物必须可复现）。
 */

/* ================================================================
   契约 §3.1 的判别式联合类型放这里
   ----------------------------------------------------------------
   [C-83] 定义 `GenOk | GenFail` 与 `GeneratedFile`，但没指定落在哪个文件；`src/types.ts` 在
   W1 已冻结（本批不许改），而 [C-107] 又规定三个生成器只能共同依赖 escape.ts ——
   于是这三个类型放在本文件，是**唯一不违反 [C-107]、也不用改冻结文件**的位置。
   W4 若想独立成 `codegen/types.ts`，原样平移即可，语义不变。
   ================================================================ */

/** 生成出的一个文件；`path` 一律 POSIX 相对路径（[C-91]） */
export interface GeneratedFile {
  path: string;
  content: string;
}

/** 生成成功但不完美时的告警（[C-83]：必须能在 UI 上看到，不许吞） */
export type GenOk = { ok: true; files: GeneratedFile[]; warnings: string[] };
export type GenFail = { ok: false; error: string };

/* ================================================================
   字符串字面量
   ================================================================ */

/**
 * Java 字符串字面量的**字面量体**（不含首尾双引号）。
 *
 * 逐字符单趟扫描，不是「先 replace 反斜杠再 replace 引号」：
 * 多趟替换会把刚插进去的 `\"` 再转一次变成 `\\"`，字符串就提前闭合了 —— 这是最容易出的那种错。
 */
export function javaStringLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '$':
        // `${` 不是 Java 语法问题，但它是本项目生成物被贴进模板串（SQL 片段 / 周报模板 /
        // 前端字符串）时的头号事故源。[C-86] 统一转成 `\u0024{`：Java 里等价于 `${`，
        // 但任何模板引擎都不会把它当成插值起点。
        if (s[i + 1] === '{') {
          out += '\\u0024{';
          i++; // 吃掉 `{`，否则会重复输出
        } else {
          out += '$';
        }
        break;
      default:
        if (ch.charCodeAt(0) < 0x20) {
          // 其余控制字符（垂直制表、退格、NUL…）走 Unicode 转义，保证源码里不出现不可见字节
          out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        } else {
          // 中文按原样保留：生成物是 UTF-8 源码，javac 默认按 UTF-8 读
          out += ch;
        }
    }
  }
  return out;
}

/** 含首尾双引号的完整 Java 字符串字面量 */
export function javaString(s: string): string {
  return '"' + javaStringLiteral(s) + '"';
}

/* ================================================================
   标识符 / 命名
   ================================================================ */

/** Java 关键字与字面量保留字（用作标识符时要加后缀 `_`） */
const JAVA_RESERVED = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null', 'var', 'record', 'sealed', 'permits', 'yield',
]);

/** 合法标识符字符：ASCII 字母 / 数字 / 下划线 / 美元符 */
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

/**
 * 把任意字符串归一成**合法 Java 标识符**。
 *
 * 规则（写死，单测覆盖）：
 * - 非 `[A-Za-z0-9_$]` 字符一律变 `_`（**中文也变 `_`**：[C-90] 要求生成物里不出现中文标识符，
 *   留着中文虽然 javac 能过，但贴进模板/日志/禅道会各处乱码）；
 * - 数字开头 → 前面补 `_`；
 * - 空串 / 全非法 → 用 `fallback`；
 * - 命中 Java 关键字 / 字面量 → 末尾加 `_`（`class` → `class_`）。
 */
export function javaIdentifier(s: string, fallback = 'value'): string {
  const raw = String(s ?? '');
  let out = '';
  for (const ch of raw) out += isIdentChar(ch) ? ch : '_';
  if (!out) out = fallback;
  if (!isIdentStart(out[0])) out = '_' + out;
  if (JAVA_RESERVED.has(out)) out = out + '_';
  return out;
}

/** package 的一段：小写 + 非法字符处理（`My-App` → `my_app`，`v1` → `v1`） */
export function javaPackageSegment(s: string): string {
  const seg = javaIdentifier(String(s ?? '').toLowerCase(), 'pkg');
  // 包名段不能以 $ 开头（合法但会被不少工具警告），统一成下划线
  return seg.startsWith('$') ? '_' + seg.slice(1) : seg;
}

/** 按分隔符（`_` `-` 空格 `.`）切词，丢弃空段 */
function words(s: string): string[] {
  return String(s ?? '')
    .split(/[^A-Za-z0-9$]+/)
    .filter(Boolean);
}

/** `user_info` / `user-info` / `user info` → `UserInfo` */
export function pascalCase(s: string): string {
  const parts = words(s);
  if (!parts.length) return javaIdentifier('', 'Value');
  return parts
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('')
    // 切词后仍可能以数字开头（`1st_item` → `1stItem`）
    .replace(/^([0-9])/, '_$1');
}

/** `user_info` → `userInfo`；已是 camelCase 的原样返回 */
export function camelCase(s: string): string {
  const parts = words(s);
  if (!parts.length) return javaIdentifier('', 'value');
  const head = parts[0][0].toLowerCase() + parts[0].slice(1);
  const rest = parts.slice(1).map(w => w[0].toUpperCase() + w.slice(1)).join('');
  return (head + rest).replace(/^([0-9])/, '_$1');
}