import { describe, it, expect } from 'vitest';
import {
  javaString,
  javaStringLiteral,
  javaIdentifier,
  javaPackageSegment,
  pascalCase,
  camelCase,
} from '../codegen/escape';

/**
 * escape.ts 的单测（契约 §3.2 / [C-86]）。
 *
 * [C-105] 规定：转义 6 类**不进 golden**（输出是单行片段），全部写成本文件里的内联断言，≥ 6 条；
 * 其中「引号」「反斜杠」两类另有端到端 golden（在 W4 的 restassured / pageobject 里）。
 *
 * 判据不是「看起来转义了」，而是「拼出来的 Java 字面量语法合法」：
 * 每个含特殊字符的用例都额外断言「首尾是双引号、内部没有未转义的裸双引号」。
 */

/** 断言一个字面量语法合法：以 " 开头结尾，且内部的裸 " 全部被反斜杠转义 */
function expectWellFormedLiteral(literal: string) {
  expect(literal.startsWith('"')).toBe(true);
  expect(literal.endsWith('"')).toBe(true);
  const body = literal.slice(1, -1);
  // 逐字符找「没有被奇数个连续反斜杠转义的裸双引号」——有就是提前闭合
  let backslashes = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') expect(backslashes % 2).toBe(1);
    backslashes = 0;
  }
}

describe('javaStringLiteral：6 类转义（[C-86]）', () => {
  it('① 双引号：转成 \\" 且整个字面量仍然闭合', () => {
    expect(javaStringLiteral('他说"你好"')).toBe('他说\\"你好\\"');
    expect(javaString('他说"你好"')).toBe('"他说\\"你好\\""');
    expectWellFormedLiteral(javaString('他说"你好"'));
  });

  it('② 反斜杠：单个 \\ 变两个（不能只转一层）', () => {
    expect(javaStringLiteral('C:\\temp\\a')).toBe('C:\\\\temp\\\\a');
    // 「反斜杠 + 引号」连写，最容易转错成三层的组合
    const tricky = javaString('\\"');
    expect(tricky).toBe('"\\\\\\""');
    expectWellFormedLiteral(tricky);
  });

  it('③ 中文：按原样保留（源码 UTF-8，不做 \\u 转义）', () => {
    expect(javaStringLiteral('登录成功')).toBe('登录成功');
    expect(javaString('状态：已覆盖')).toBe('"状态：已覆盖"');
  });

  it('④ ${}：转成 \\u0024{，避免被模板引擎当插值', () => {
    expect(javaStringLiteral('${name}')).toBe('\\u0024{name}');
    // 只有 $ 后面紧跟 { 才转；单独的 $ 原样
    expect(javaStringLiteral('价格 $5 与 ${x}')).toBe('价格 $5 与 \\u0024{x}');
    expectWellFormedLiteral(javaString('${a}${b}'));
  });

  it('⑤ 换行：\\n / \\r\\n / \\t 各转成对应转义序列，源码里不出现真换行', () => {
    expect(javaStringLiteral('a\nb')).toBe('a\\nb');
    expect(javaStringLiteral('a\r\nb')).toBe('a\\r\\nb');
    expect(javaStringLiteral('a\tb')).toBe('a\\tb');
    expect(javaStringLiteral('a\nb')).not.toContain('\n');
  });

  it('⑥ 超长输入（≥200 字符）原样输出，不截断', () => {
    const long = 'a'.repeat(200);
    expect(javaStringLiteral(long)).toBe(long);
    expect(javaStringLiteral(long).length).toBe(200);
    // 超长标识符：javaIdentifier 也不截断（截断会让两个不同字段撞名）
    expect(javaIdentifier('f'.repeat(220))).toBe('f'.repeat(220));
  });

  it('其余控制字符走 \\u 转义（源码里不出现不可见字节）', () => {
    expect(javaStringLiteral('\u0000')).toBe('\\u0000');
    expect(javaStringLiteral('\u000b')).toBe('\\u000b');
  });

  it('空串 → 空字面量体；javaString("") 是 ""（闭合）', () => {
    expect(javaStringLiteral('')).toBe('');
    expect(javaString('')).toBe('""');
    expectWellFormedLiteral(javaString(''));
  });
});

describe('javaIdentifier', () => {
  it('Java 关键字加后缀 _', () => {
    expect(javaIdentifier('class')).toBe('class_');
    expect(javaIdentifier('null')).toBe('null_');
    expect(javaIdentifier('var')).toBe('var_');
  });

  it('数字开头补 _', () => {
    expect(javaIdentifier('1st')).toBe('_1st');
    expect(javaIdentifier('2fa_code')).toBe('_2fa_code');
  });

  it('非法字符（含中文、空格、连字符）变下划线', () => {
    expect(javaIdentifier('user-name')).toBe('user_name');
    expect(javaIdentifier('user name')).toBe('user_name');
    expect(javaIdentifier('姓名')).toBe('__');
  });

  it('空串 / 全非法用 fallback', () => {
    expect(javaIdentifier('')).toBe('value');
    expect(javaIdentifier('', 'root')).toBe('root');
  });

  it('已经合法的不动（幂等）', () => {
    expect(javaIdentifier('userId')).toBe('userId');
    expect(javaIdentifier(javaIdentifier('user id'))).toBe('user_id');
  });
});

describe('命名转换', () => {
  it('pascalCase：下划线 / 连字符 / 空格 都能切词', () => {
    expect(pascalCase('user_info')).toBe('UserInfo');
    expect(pascalCase('user-info')).toBe('UserInfo');
    expect(pascalCase('user info')).toBe('UserInfo');
    expect(pascalCase('userInfo')).toBe('UserInfo');
    expect(pascalCase('1st_item')).toBe('_1stItem');
  });

  it('camelCase：首词小写、后续首字母大写', () => {
    expect(camelCase('user_info')).toBe('userInfo');
    expect(camelCase('user-id')).toBe('userId');
    expect(camelCase('userName')).toBe('userName');
    expect(camelCase('1st_item')).toBe('_1stItem');
  });

  it('javaPackageSegment：小写化 + 非法字符', () => {
    expect(javaPackageSegment('My-App')).toBe('my_app');
    expect(javaPackageSegment('V1')).toBe('v1');
    expect(javaPackageSegment('a.b')).toBe('a_b');
  });
});

describe('拼进 Java 源码后语法自检（不止看转义表）', () => {
  it('含引号 / 反斜杠 / ${ 的值放进字段注解后，引号配对仍是偶数', () => {
    const value = 'a"b\\c${d}\n';
    const literal = javaString(value);
    expectWellFormedLiteral(literal);
    // 生成的整行里，未转义的双引号必须成对（2 个：字面量首尾）
    const line = `@JsonProperty(${literal})`;
    let count = 0;
    let bs = 0;
    for (const ch of line) {
      if (ch === '\\') { bs += 1; continue; }
      if (ch === '"' && bs % 2 === 0) count += 1;
      bs = 0;
    }
    expect(count).toBe(2);
  });
});