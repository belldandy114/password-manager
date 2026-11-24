import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { generatePojo, type PojoInput } from '../codegen/pojo';

/**
 * 1.3 JSON → POJO 的 golden 测试（契约 §3.5 / §3.7）。
 *
 * 5 个形态由 [C-105] 定：嵌套数组、类型冲突、全 null、lombok 开关、数字/布尔/日期字符串 + 空对象。
 * 比对口径按 [C-102]：`\r\n` 归一后 **`toBe` 逐字符相等**（不许 `toMatch` 之类的宽松断言）。
 *
 * 目录职责按契约 [C-100]：**输入**在 `__fixtures__/pojo/<case>.in.json`、
 * **期望输出**在 `__golden__/pojo/<case>.java`。（t36 把这 5 个 `.in.json` 从 `__golden__` 平移到
 * `__fixtures__`，字节零改动，git 记为 rename。）
 *
 * 更新 golden：`UPDATE_GOLDEN=1 npx vitest run src/utils/__tests__/codegenPojo.test.ts`（[C-104]）。
 * 更新后**必须人工逐份复核**，不能默认「生成的就是对的」——golden 写错时测试永远是绿的。
 */

const GOLDEN_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__golden__', 'pojo');
const FIXTURE_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__fixtures__', 'pojo');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** 读期望输出（.java，留在 __golden__/pojo） */
function readText(file: string): string {
  return fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
}

/** 读输入 fixture（<case>.in.json，[C-100] 规定放 __fixtures__/pojo） */
function readFixture(file: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
}

/** [C-102]：比对前只做换行归一，别的任何「顺手美化」都不许有 */
function norm(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

interface Case {
  name: string;
  /** 除 json 之外的入参 */
  input: Omit<PojoInput, 'json'>;
  /** 期望的文件名（= 根类名），顺带证明 PascalCase 归一 */
  className: string;
}

const CASES: Case[] = [
  {
    name: 'json-nested-array',
    className: 'ApiResponse',
    input: { rootName: 'ApiResponse', lombok: true },
  },
  {
    name: 'json-type-conflict',
    className: 'RecordList',
    input: { rootName: 'record list', lombok: true, packageName: 'com.example.model' },
  },
  {
    name: 'json-all-null',
    className: 'UserProfile',
    input: { rootName: 'user_profile', lombok: true },
  },
  {
    name: 'json-lombok-off',
    className: 'User',
    input: { rootName: 'User', lombok: false },
  },
  {
    name: 'json-scalar-mix',
    className: 'ScalarMix',
    input: { rootName: 'scalar mix', lombok: true, useBigDecimal: false },
  },
];

describe('generatePojo：5 种 JSON 形态的 golden 逐字比对', () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.className}.java 零差异`, () => {
      const json = readFixture(`${c.name}.in.json`);
      const result = generatePojo({ ...c.input, json });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe(`${c.className}.java`);

      const actual = norm(result.files[0].content);
      if (UPDATE) fs.writeFileSync(path.join(GOLDEN_DIR, `${c.name}.java`), actual, 'utf8');
      expect(actual).toBe(norm(readText(`${c.name}.java`)));
    });
  }
});

describe('generatePojo：文件规范（[C-102]/[C-85]）', () => {
  it('LF 换行、恰好一个末尾换行、无行尾空格、无时间戳', () => {
    const result = generatePojo({ rootName: 'ApiResponse', json: readFixture('json-nested-array.in.json'), lombok: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = result.files[0].content;

    expect(content).not.toContain('\r');
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
    expect(content.split('\n').every(l => l === l.replace(/[ \t]+$/, ''))).toBe(true);
    // [C-85]：生成物不得含时间戳/日期，否则 golden 每天都会变红
    expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(content).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('lombok:true → 类上 @Data；lombok:false → 生成 getter/setter', () => {
    const on = generatePojo({ rootName: 'User', json: readFixture('json-lombok-off.in.json'), lombok: true });
    const off = generatePojo({ rootName: 'User', json: readFixture('json-lombok-off.in.json'), lombok: false });
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;

    expect(on.files[0].content).toContain('@Data');
    expect(on.files[0].content).not.toContain('public Long getUserId()');

    expect(off.files[0].content).not.toContain('@Data');
    expect(off.files[0].content).toContain('public Long getUserId() {');
    expect(off.files[0].content).toContain('public void setUserId(Long userId) {');
  });

  it('snake_case 键 → camelCase 字段 + @JsonProperty(原名)（[C-96]）', () => {
    const r = generatePojo({ rootName: 'User', json: readFixture('json-lombok-off.in.json'), lombok: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('@JsonProperty("user_id")');
    expect(r.files[0].content).toContain('private Long userId;');
    expect(r.files[0].content).toContain('import com.fasterxml.jackson.annotation.JsonProperty;');
  });

  it('类名 PascalCase、字段 camelCase、嵌套类名不与外层重名', () => {
    const r = generatePojo({ rootName: 'api response', json: readFixture('json-nested-array.in.json'), lombok: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const content = r.files[0].content;

    expect(content).toContain('public class ApiResponse {');
    expect(content).toContain('private Long code;');
    expect(content).toContain('private String message;');
    // 嵌套类 = 父类名 + PascalCase(字段名)
    const classNames = [...content.matchAll(/(?:public |public static )class (\w+)/g)].map(m => m[1]);
    expect(new Set(classNames).size).toBe(classNames.length); // 无重名
    expect(classNames).toContain('ApiResponse');
    expect(classNames.length).toBeGreaterThan(1);
    for (const n of classNames) expect(n).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });
});

describe('generatePojo：类型推断与合并的告警（[C-94]/[C-95]）', () => {
  it('同名字段多类型：code（Long/String）合并为 String，amount（Long/BigDecimal）合并为 BigDecimal', () => {
    const r = generatePojo({ rootName: 'RecordList', json: readFixture('json-type-conflict.in.json'), lombok: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.warnings.join('\n');
    expect(joined).toContain('出现多种类型（Long/String），已合并为 String');
    expect(joined).toContain('出现多种类型（Long/BigDecimal），已合并为 BigDecimal');
    // 合并结果要落到字段类型上，不只是告警
    expect(r.files[0].content).toContain('private String code;');
    expect(r.files[0].content).toContain('private BigDecimal amount;');
  });

  it('全 null 字段 → Object，并逐条告警', () => {
    const r = generatePojo({ rootName: 'UserProfile', json: readFixture('json-all-null.in.json'), lombok: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.warnings.join('\n');
    // 路径带父级：告警要能直接告诉用户是哪个嵌套字段
    expect(joined).toContain('字段 profile.nickname 全为 null，推断为 Object');
    expect(joined).toContain('字段 profile.avatar 全为 null，推断为 Object');
    expect(joined).toContain('字段 meta 全为 null，推断为 Object');
    expect(r.files[0].content).toContain('private Object meta;');
  });

  it('useBigDecimal:false 时小数用 Double；缺省用 BigDecimal', () => {
    const dbl = generatePojo({ rootName: 'ScalarMix', json: readFixture('json-scalar-mix.in.json'), lombok: true, useBigDecimal: false });
    const dec = generatePojo({ rootName: 'ScalarMix', json: readFixture('json-scalar-mix.in.json'), lombok: true });
    expect(dbl.ok && dec.ok).toBe(true);
    if (!dbl.ok || !dec.ok) return;
    expect(dbl.files[0].content).toContain('private Double ratio;');
    expect(dec.files[0].content).toContain('private BigDecimal ratio;');
    expect(dec.files[0].content).toContain('import java.math.BigDecimal;');
  });

  it('空数组 → List<Object>；空对象 → 空嵌套类', () => {
    const r = generatePojo({
      rootName: 'EmptyCases',
      json: '{"tags":[], "detail":{}}',
      lombok: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('private List<Object> tags;');
    expect(r.files[0].content).toContain('import java.util.List;');
    expect(r.files[0].content).toMatch(/public static class EmptyCasesDetail \{\n {4}\}/);
  });

  it('日期字符串保持 String（[C-94] 没有 LocalDate）', () => {
    const r = generatePojo({ rootName: 'User', json: readFixture('json-lombok-off.in.json'), lombok: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('private String createdAt;');
    expect(r.files[0].content).not.toContain('LocalDate');
  });
});

describe('generatePojo：失败路径（不产出半成品，[C-84]）', () => {
  it('空 JSON → 可读错误', () => {
    const r = generatePojo({ rootName: 'X', json: '   ', lombok: true });
    expect(r).toEqual({ ok: false, error: 'JSON 为空：粘贴一段响应体再生成' });
  });

  it('JSON 语法错误 → 带原因的 error，不抛异常', () => {
    const r = generatePojo({ rootName: 'X', json: '{"a":', lombok: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith('JSON 解析失败：')).toBe(true);
  });

  it('根节点是标量 → 明确拒绝', () => {
    const r = generatePojo({ rootName: 'X', json: '"just a string"', lombok: true });
    expect(r).toEqual({ ok: false, error: '根节点必须是对象或数组：标量（数字 / 字符串 / 布尔）无法生成 POJO' });
  });

  it('根节点是空数组 → 明确拒绝', () => {
    const r = generatePojo({ rootName: 'X', json: '[]', lombok: true });
    expect(r).toEqual({ ok: false, error: '根节点是空数组：无法推断元素结构' });
  });

  it('lang 只接受 java（[C-82]）', () => {
    const r = generatePojo({ rootName: 'X', json: '{"a":1}', lombok: true, lang: 'java' });
    expect(r.ok).toBe(true);
    expect(generatePojo({ rootName: 'X', json: '{"a":1}', lombok: true, lang: 'python' as unknown as 'java' }))
      .toEqual({ ok: false, error: '暂只支持 Java（lang=java）' });
  });

  it('根节点是对象数组时按元素合并结构', () => {
    const r = generatePojo({ rootName: 'Item', json: '[{"a":1},{"a":2,"b":"x"}]', lombok: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('private Long a;');
    expect(r.files[0].content).toContain('private String b;');
    expect(r.warnings.join('\n')).toContain('根节点是数组');
  });
});