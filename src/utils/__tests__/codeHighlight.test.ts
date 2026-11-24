// 代码高亮 tokenizer 的回归（契约 docs/acceptance/W8-组件契约.md §1.7 全表）
//
// 断言风格照 src/utils/__tests__/scanRules.test.ts：每条语义都**成对**断言
// （该命中什么 + 不该命中什么），避免「把分类删掉照样绿」的假测试。
//
// 这里不测渲染（CodeBlock 的 DOM 由真窗口/探针验；jsdom 没有布局，测不出行号对齐）。
import { describe, it, expect } from 'vitest';

import {
  highlightCode,
  langFromPath,
  HIGHLIGHT_FOLD_LINES,
} from '../codeHighlight';
import type { CodeToken } from '../codeHighlight';

/** 取「包含 needle 的那个 token」的类名 —— token 会合并相邻同类的默认文本，不能按全等找 */
const clsOf = (tokens: CodeToken[], needle: string): string | undefined =>
  tokens.find((t) => t.text.includes(needle))?.cls;

const one = (src: string, lang: string): CodeToken[] =>
  highlightCode(src, lang, { maxLines: Number.POSITIVE_INFINITY }).lines[0].tokens;

/** 还原文本（无损不变量的左半边） */
const flat = (code: string, lang?: string): string =>
  highlightCode(code, lang, { maxLines: Number.POSITIVE_INFINITY })
    .lines.map((l) => l.tokens.map((t) => t.text).join(''))
    .join('\n');

describe('Java：七类语义各自成对命中', () => {
  it('注解 @Test → tok-ann（且不是 tok-kw）', () => {
    const t = one('@Test', 'java');
    expect(clsOf(t, '@Test')).toBe('tok-ann');
    expect(clsOf(t, '@Test')).not.toBe('tok-kw');
  });

  it('关键字 public / void → tok-kw（普通标识符不是）', () => {
    const t = one('public void open() { }', 'java');
    expect(clsOf(t, 'public')).toBe('tok-kw');
    expect(clsOf(t, 'void')).toBe('tok-kw');
    expect(clsOf(t, 'open')).not.toBe('tok-kw');
  });

  it('类型 String / int / By / Locator → tok-type', () => {
    const t = one('String a = null; int b = 0; By c = null; Locator d = null;', 'java');
    expect(clsOf(t, 'String')).toBe('tok-type');
    expect(clsOf(t, 'int')).toBe('tok-type');
    expect(clsOf(t, 'By')).toBe('tok-type');
    expect(clsOf(t, 'Locator')).toBe('tok-type');
  });

  it('字符串字面量 → tok-str（含转义引号不被截断）', () => {
    const t = one('String s = "a\\"b";', 'java');
    expect(clsOf(t, '"a\\"b"')).toBe('tok-str');
    expect(clsOf(t, 'String')).not.toBe('tok-str');
  });

  it('数字字面量 → tok-num（含 0x / 小数 / 下划线 / 后缀）', () => {
    expect(clsOf(one('int n = 42;', 'java'), '42')).toBe('tok-num');
    expect(clsOf(one('long m = 1_000L;', 'java'), '1_000L')).toBe('tok-num');
    expect(clsOf(one('double d = 0x1F + 2.5e3;', 'java'), '0x1F')).toBe('tok-num');
    expect(clsOf(one('int n = 42;', 'java'), 'n')).not.toBe('tok-num');
  });

  it('行注释与块注释 → tok-cmt（注释里的关键字不再单独上色）', () => {
    expect(clsOf(one('int a = 1; // public void', 'java'), '// public void')).toBe('tok-cmt');
    expect(clsOf(one('/* public */ int a = 1;', 'java'), '/* public */')).toBe('tok-cmt');
    expect(clsOf(one('int a = 1;', 'java'), 'int')).not.toBe('tok-cmt');
  });

  it('方法调用 → tok-fn（后面紧跟 "(" 才算）', () => {
    const t = one('driver.findElement(By.id("x"));', 'java');
    expect(clsOf(t, 'findElement')).toBe('tok-fn');
    expect(clsOf(t, 'id')).toBe('tok-fn');
    expect(clsOf(t, 'driver')).not.toBe('tok-fn'); // 后面是 "."，不是 "("
  });
});

describe('无损与边界', () => {
  it('逐字符无损 round-trip（中文 / emoji / 制表符 / 多个空格）', () => {
    const src = [
      'public class 登录页Test {',
      '\t// 𠮷 与 emoji 😀 都要原样保留',
      '  String s = "  三个空格开头";',
      '}',
    ].join('\n');
    expect(flat(src, 'java')).toBe(src);
  });

  it('CRLF 归一成 LF，行数按 \\n 计', () => {
    const r = highlightCode('a\r\nb', 'java');
    expect(r.totalLines).toBe(2);
    expect(r.lines.map((l) => l.tokens.map((t) => t.text).join('')).join('\n')).toBe('a\nb');
    expect(JSON.stringify(r)).not.toContain('\\r');
  });

  it('空串 → lines 为空、totalLines 0、folded false', () => {
    const r = highlightCode('', 'java');
    expect(r.lines).toEqual([]);
    expect(r.totalLines).toBe(0);
    expect(r.folded).toBe(false);
  });

  it('未知语言回退 text：detected=false、文本逐字符还原、不抛错', () => {
    const src = 'a = 1\nif (x) { }';
    const r = highlightCode(src, 'kotlin');
    expect(r.lang).toBe('text');
    expect(r.detected).toBe(false);
    expect(r.lines.map((l) => l.tokens.map((t) => t.text).join('')).join('\n')).toBe(src);
    // 纯文本不做分类：不会有任何 tok-* 类名
    expect(r.lines.every((l) => l.tokens.every((t) => t.cls === ''))).toBe(true);
  });

  it('省略语言参数 → text / detected=false', () => {
    const r = highlightCode('a');
    expect(r.lang).toBe('text');
    expect(r.detected).toBe(false);
  });

  it('未闭合字符串：不抛错、到行尾为止、不吞下一行', () => {
    const r = highlightCode('String s = "abc\nint b = 1;', 'java');
    expect(clsOf(r.lines[0].tokens, '"abc')).toBe('tok-str');
    expect(clsOf(r.lines[1].tokens, 'int')).toBe('tok-type'); // 第二行照常分类
    expect(clsOf(r.lines[1].tokens, 'int')).not.toBe('tok-str');
  });

  it('未闭合块注释：跨行保持注释态，闭合后恢复正常分类', () => {
    const r = highlightCode('int a = 1; /* 未闭合\n仍然注释\n*/ int b = 2;', 'java');
    expect(clsOf(r.lines[0].tokens, '/* 未闭合')).toBe('tok-cmt');
    expect(clsOf(r.lines[1].tokens, '仍然注释')).toBe('tok-cmt');
    expect(r.lines[1].tokens).toHaveLength(1); // 整行都在注释里
    expect(clsOf(r.lines[2].tokens, '*/')).toBe('tok-cmt');
    expect(clsOf(r.lines[2].tokens, 'int')).toBe('tok-type');
  });

  it('行号连续且 1-based', () => {
    const r = highlightCode('a\nb\nc', 'java');
    expect(r.lines.map((l) => l.no)).toEqual([1, 2, 3]);
  });

  it('纯函数：同输入两次调用结果深度相等', () => {
    const src = 'public class A { int x = 1; }';
    expect(highlightCode(src, 'java')).toEqual(highlightCode(src, 'java'));
  });
});

describe('其它语言', () => {
  it('SQL：关键字大小写不敏感 + -- 行注释 + 单引号字符串', () => {
    const t = one("SELECT id FROM t WHERE name = 'x' -- 注释", 'sql');
    expect(clsOf(t, 'SELECT')).toBe('tok-kw');
    expect(clsOf(t, 'FROM')).toBe('tok-kw');
    expect(clsOf(t, 'WHERE')).toBe('tok-kw');
    expect(clsOf(t, "'x'")).toBe('tok-str');
    expect(clsOf(t, '-- 注释')).toBe('tok-cmt');
    expect(clsOf(t, 'name')).not.toBe('tok-kw');
  });

  it('JSON：字符串 / 数字 / true·false·null 三类，且 // 不当注释', () => {
    const t = one('{"a": 1, "b": true, "c": null}', 'json');
    expect(clsOf(t, '"a"')).toBe('tok-str');
    expect(clsOf(t, '1')).toBe('tok-num');
    expect(clsOf(t, 'true')).toBe('tok-kw');
    expect(clsOf(t, 'null')).toBe('tok-kw');
    // JSON 没有行注释：`//` 只能是普通字符
    const noCmt = one('{"a": "//x"}', 'json');
    expect(noCmt.some((x) => x.cls === 'tok-cmt')).toBe(false);
  });

  it('JS/TS：模板串跨行保持字符串态', () => {
    const r = highlightCode('const a = `x\n y`;', 'js');
    expect(clsOf(r.lines[0].tokens, '`x')).toBe('tok-str');
    expect(clsOf(r.lines[1].tokens, ' y`')).toBe('tok-str');
    expect(clsOf(r.lines[1].tokens, ';')).not.toBe('tok-str');
  });

  it('JS/TS：关键字与类型分开（const → kw，string → type）', () => {
    const t = one('const a: string = "x";', 'ts');
    expect(clsOf(t, 'const')).toBe('tok-kw');
    expect(clsOf(t, 'string')).toBe('tok-type');
  });

  it('XML：标签名 = 类型色、属性名 = 关键字色、属性值 = 字符串色，且闭合标签也对', () => {
    const t = one('<a href="x">t</a>', 'xml');
    // 标签名单独成 token（`<` / `</` 留在默认色）→ 这里按全等找，不能用 includes
    expect(t.filter((x) => x.text === 'a').map((x) => x.cls)).toEqual(['tok-type', 'tok-type']);
    expect(t.find((x) => x.text === 'href')?.cls).toBe('tok-kw');
    expect(t.find((x) => x.text === '"x"')?.cls).toBe('tok-str');
    expect(t.find((x) => x.text === 'href')?.cls).not.toBe('tok-type');
  });

  it('XML：<!-- --> 注释跨行', () => {
    const r = highlightCode('<!-- 注释\n还在注释 --> <a/>', 'xml');
    expect(clsOf(r.lines[0].tokens, '<!-- 注释')).toBe('tok-cmt');
    expect(clsOf(r.lines[1].tokens, '还在注释 -->')).toBe('tok-cmt');
  });

  it('text：每行（非空）恰好 1 个 token，且不带任何类名', () => {
    const r = highlightCode('a\n\nb', 'text');
    expect(r.lines[0].tokens).toEqual([{ text: 'a', cls: '' }]);
    expect(r.lines[1].tokens).toEqual([]); // 空行 0 个 token（契约 §1.3 不变量 2 的边界）
    expect(r.lines[2].tokens).toEqual([{ text: 'b', cls: '' }]);
    expect(r.detected).toBe(true); // 显式要 text 不算「回退」
  });
});

describe('折叠与合并', () => {
  it('maxLines 折叠：只切前 N 行，totalLines 仍给真数', () => {
    const src = 'a\nb\nc\nd\ne';
    const r = highlightCode(src, 'java', { maxLines: 2 });
    expect(r.lines).toHaveLength(2);
    expect(r.totalLines).toBe(5);
    expect(r.folded).toBe(true);
    expect(r.lines[1].no).toBe(2);
    // 未折叠时 folded=false
    expect(highlightCode(src, 'java', { maxLines: 5 }).folded).toBe(false);
  });

  it('默认阈值就是 HIGHLIGHT_FOLD_LINES（400）', () => {
    expect(HIGHLIGHT_FOLD_LINES).toBe(400);
    const small = highlightCode('a\nb', 'java');
    expect(small.folded).toBe(false);
    const big = Array.from({ length: 401 }, () => 'int a = 1;').join('\n');
    const r = highlightCode(big, 'java');
    expect(r.folded).toBe(true);
    expect(r.lines).toHaveLength(400);
    expect(r.totalLines).toBe(401);
  });

  it('相邻同类 token 合并（数字不会被逐字符拆开，默认文本整段一个 token）', () => {
    expect(one('42', 'java')).toEqual([{ text: '42', cls: 'tok-num' }]);
    expect(one('   ', 'java')).toEqual([{ text: '   ', cls: '' }]);
    const t = one('int a = 1 + 2;', 'java');
    // 没有相邻同类的两个 token
    for (let i = 1; i < t.length; i += 1) expect(t[i].cls).not.toBe(t[i - 1].cls);
  });
});

describe('langFromPath', () => {
  it('扩展名映射 + 大小写 + 未知回退 text', () => {
    expect(langFromPath('src/test/java/pages/LoginPage.java')).toBe('java');
    expect(langFromPath('pom.xml')).toBe('xml');
    expect(langFromPath('data.JSON')).toBe('json');
    expect(langFromPath('a/b/c.tsx')).toBe('ts');
    expect(langFromPath('m.mjs')).toBe('js');
    expect(langFromPath('q.sql')).toBe('sql');
    expect(langFromPath('README')).toBe('text');
    expect(langFromPath('notes.txt')).toBe('text');
    expect(langFromPath('')).toBe('text');
    expect(langFromPath('weird.')).toBe('text');
  });
});