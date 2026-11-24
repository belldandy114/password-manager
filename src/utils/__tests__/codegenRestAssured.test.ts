import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { generateRestAssured, type RestAssuredInput } from '../codegen/restassured';
import { parseOpenApi } from '../openapi';
import type { ImportedRequest } from '../collectionImport';

/**
 * 1.1 RestAssured 生成器的 golden 测试（契约 §3.3 / §3.7 / [C-90]–[C-91]、[C-100]–[C-105]）。
 *
 * 4 组 golden，覆盖 [C-105] 要求的「1 个多文件 + 1 个含 $ref 循环」：
 *   ① restassured-oas3-petstore  多文件（baseTestClass）——从真实 .yaml 走一遍 openapi → 生成
 *   ② restassured-swagger2-ref-loop  单文件 + 循环引用的 body（`{}` 截断要能编译）
 *   ③ restassured-escape-quotes  引号 / 反斜杠 / 换行全塞进 body 与 header（[C-105] 的转义 golden）
 *   ④ restassured-auth-header  显式 authHeader + 接口重名（方法名去重与告警）
 *
 * 比对口径 [C-102]：`\r\n` 归一后 `toBe` 逐字符相等（不许 toMatch）。
 * 多文件比对 [C-103]：`path` 与 `content` 两样都要比，靠 `__manifest.json` 描述对应关系。
 *
 * 更新 golden：`UPDATE_GOLDEN=1 npx vitest run src/utils/__tests__/codegenRestAssured.test.ts`；
 * 更新后**必须人工逐份读过**再提交（golden 写错时测试永远绿）。
 *
 * 编译取证：`EMIT_JAVA_DIR=<临时目录> npx vitest run ...` 会把生成物按 path 落盘，
 * 供 javac 实编译（[C-106]：golden 通过 ≠ 能编译，两道门分开）。
 */

const GOLDEN_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__golden__', 'restassured');
const FIXTURE_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__fixtures__', 'openapi');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const EMIT = process.env.EMIT_JAVA_DIR || '';

function readText(file: string): string {
  return fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
}

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** [C-102]：只做换行归一 */
function norm(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** 从 fixture 解析出请求（端到端：openapi.ts → restassured.ts） */
function requestsFrom(spec: string): { requests: ImportedRequest[]; baseUrl: string } {
  const r = parseOpenApi(spec);
  if (!r.ok) throw new Error(`fixture 解析失败：${r.error}`);
  return { requests: r.requests, baseUrl: r.baseUrl };
}

const petstore = requestsFrom(readFixture('oas3-petstore.yaml'));
const orderApi = requestsFrom(readFixture('swagger2-ref-loop.json'));

const inlineEscape: ImportedRequest[] = [
  {
    name: 'send "quoted" payload',
    group: 'escape',
    method: 'POST',
    url: 'https://escape.example.com/api/quote',
    headers: 'X-Note: he said "hi"\nX-Path: C:\\temp\\logs',
    body: '{"text":"他说：\\"引号\\" 与反斜杠 \\\\ 都要转义","multiline":true}',
    bodyType: 'json',
    rawContentType: 'application/json',
  },
];

const inlineAuth: ImportedRequest[] = [
  {
    name: 'get user',
    group: 'users',
    method: 'GET',
    url: 'https://users.example.com/users/1',
    headers: 'Accept: application/json',
    body: '',
    bodyType: 'none',
    rawContentType: '',
  },
  {
    name: 'get user',
    group: 'users',
    method: 'DELETE',
    url: 'https://users.example.com/users/1',
    headers: '',
    body: '',
    bodyType: 'none',
    rawContentType: '',
  },
];

interface Case {
  name: string;
  input: RestAssuredInput;
  /** true = 多文件 golden（目录 + __manifest.json） */
  multi: boolean;
}

const CASES: Case[] = [
  {
    name: 'restassured-oas3-petstore',
    multi: true,
    input: {
      className: 'Pet Store Api Test',
      packageName: 'api.petstore',
      baseUrl: petstore.baseUrl,
      requests: petstore.requests,
      // baseTestClass 缺省 true → 两个文件（[C-91]）
    },
  },
  {
    name: 'restassured-swagger2-ref-loop',
    multi: false,
    input: {
      className: 'orderApiTest',
      packageName: 'api',
      baseUrl: orderApi.baseUrl,
      requests: orderApi.requests,
      baseTestClass: false,
    },
  },
  {
    name: 'restassured-escape-quotes',
    multi: false,
    input: {
      className: 'EscapeQuotesTest',
      baseUrl: 'https://escape.example.com',
      requests: inlineEscape,
      baseTestClass: false,
    },
  },
  {
    name: 'restassured-auth-header',
    multi: false,
    input: {
      className: 'UserApiTest',
      baseUrl: 'https://users.example.com',
      requests: inlineAuth,
      baseTestClass: false,
      authHeader: { name: 'Authorization', value: 'Bearer {{token}}' },
    },
  },
];

/** 把生成物落到 EMIT 目录（path 是 POSIX 相对路径，按它建目录，javac 才找得到包） */
function emit(emitRoot: string, files: Array<{ path: string; content: string }>): void {
  if (!emitRoot) return;
  for (const f of files) {
    const abs = path.join(emitRoot, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
  }
}

describe('generateRestAssured：4 组 golden 逐字比对（[C-90]–[C-93]/[C-102]）', () => {
  for (const c of CASES) {
    it(`${c.name} 零差异${c.multi ? '（多文件，比对 path + content）' : ''}`, () => {
      const r = generateRestAssured(c.input);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);

      emit(EMIT, r.files);

      if (!c.multi) {
        expect(r.files).toHaveLength(1);
        const file = r.files[0];
        const actual = norm(file.content);
        if (UPDATE) {
          fs.mkdirSync(GOLDEN_DIR, { recursive: true });
          fs.writeFileSync(path.join(GOLDEN_DIR, `${c.name}.java`), actual, 'utf8');
        }
        expect(actual).toBe(norm(readText(`${c.name}.java`)));
        return;
      }

      // 多文件：manifest 描述 golden 目录里的文件名 ↔ 生成物 path
      const caseDir = path.join(GOLDEN_DIR, c.name);
      const manifestPath = path.join(caseDir, '__manifest.json');
      const manifest = r.files.map((f) => ({ path: f.path, file: f.path.split('/').pop() as string }));

      if (UPDATE) {
        fs.mkdirSync(caseDir, { recursive: true });
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        for (const [i, f] of r.files.entries()) {
          fs.writeFileSync(path.join(caseDir, manifest[i].file), norm(f.content), 'utf8');
        }
      }

      const saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Array<{ path: string; file: string }>;
      expect(saved).toEqual(manifest); // path 也要一致：[C-103] 只比内容会让包名写错也全绿
      for (const [i, f] of r.files.entries()) {
        expect(norm(f.content)).toBe(norm(fs.readFileSync(path.join(caseDir, saved[i].file), 'utf8')));
      }
    });
  }
});

describe('generateRestAssured：结构与断言口径（[C-90]）', () => {
  it('每个接口一个 @Test，方法名 test + PascalCase(接口名)', () => {
    const r = generateRestAssured(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files.find((f) => f.path.endsWith('PetStoreApiTest.java'))!.content;

    expect(src.match(/@Test/g)).toHaveLength(4);
    for (const name of ['testListPets', 'testCreatePet', 'testGetPet', 'testDeletePet']) {
      expect(src).toContain(`public void ${name}() {`);
    }
    // 类名被归一成合法标识符（'Pet Store Api Test' → PetStoreApiTest）
    expect(src).toContain('public class PetStoreApiTest extends BaseTest {');
  });

  it('每个方法恰好两条断言：statusCode(200) + body(not(emptyOrNullString()))', () => {
    const r = generateRestAssured(CASES[1].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    const tests = src.match(/@Test/g) || [];
    expect(src.match(/\.statusCode\(200\)/g)).toHaveLength(tests.length);
    expect(src.match(/\.body\(not\(emptyOrNullString\(\)\)\)/g)).toHaveLength(tests.length);
    expect(src).toContain('import static org.hamcrest.Matchers.not;');
    expect(src).toContain('import static org.hamcrest.Matchers.emptyOrNullString;');
  });

  it('多文件路径按 [C-91]：src/test/java/<packagePath>/BaseTest.java 与 <ClassName>.java', () => {
    const r = generateRestAssured(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.path)).toEqual([
      'src/test/java/api/petstore/BaseTest.java',
      'src/test/java/api/petstore/PetStoreApiTest.java',
    ]);
  });

  it('baseTestClass:false 只出一个文件，且自己带 @BeforeAll + baseUrl 系统属性', () => {
    const r = generateRestAssured(CASES[1].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files).toHaveLength(1);
    const src = r.files[0].content;
    expect(src).toContain('@BeforeAll');
    expect(src).toContain('System.getProperty("baseUrl", "https://api.example.com/shop")');
    expect(src).toContain('import io.restassured.RestAssured;');
    expect(src).not.toContain('extends BaseTest');
  });

  it('baseTestClass:true 时测试类不重复写 setUp（否则 baseURI 被设两遍、import 也会多余）', () => {
    const r = generateRestAssured(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files.find((f) => f.path.endsWith('PetStoreApiTest.java'))!.content;
    expect(src).not.toContain('@BeforeAll');
    expect(src).not.toContain('import io.restassured.RestAssured;');
    expect(src).not.toContain('setUp()');
  });

  it('URL 用 baseUrl + "<path?query>"，便于 -DbaseUrl 覆盖（不焊死绝对地址）', () => {
    const r = generateRestAssured(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files.find((f) => f.path.endsWith('PetStoreApiTest.java'))!.content;
    expect(src).toContain('.get(baseUrl + "/pets?limit=20")');
    expect(src).toContain('.get(baseUrl + "/pets/{{petId}}?verbose={{verbose}}")');
    expect(src).not.toContain('"https://petstore.example.com/v1/pets');
  });

  it('body 先赋给 String 变量再 .body(body)（不把 JSON 内联进链式调用）', () => {
    const r = generateRestAssured(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files.find((f) => f.path.endsWith('PetStoreApiTest.java'))!.content;
    expect(src).toContain('String body = "');
    expect(src).toContain('.body(body)');
  });
});

describe('generateRestAssured：重名 / 告警 / 边界', () => {
  it('接口重名 → 方法名加数字后缀并压告警（不静默改名）', () => {
    const r = generateRestAssured(CASES[3].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    expect(src).toContain('public void testGetUser() {');
    expect(src).toContain('public void testGetUser2() {');
    expect(r.warnings.join('\n')).toContain('方法名重复：testGetUser，已改为 testGetUser2');
  });

  it('authHeader 落在每个方法的第一条 header（读代码时一眼看到鉴权）', () => {
    const r = generateRestAssured(CASES[3].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const src = r.files[0].content;
    const blocks = src.split('@Test').slice(1);
    for (const b of blocks) {
      expect(b.indexOf('.header("Authorization", "Bearer {{token}}")')).toBeGreaterThan(-1);
      // 在 Accept 之前
      const authAt = b.indexOf('Authorization');
      const acceptAt = b.indexOf('Accept');
      if (acceptAt > -1) expect(authAt).toBeLessThan(acceptAt);
    }
  });

  it('地址不在 baseUrl 下 → 按绝对地址生成并告警（不悄悄拼出坏 URL）', () => {
    const r = generateRestAssured({
      className: 'MixedTest',
      baseUrl: 'https://a.example.com',
      requests: [{
        name: 'external', group: 'g', method: 'GET',
        url: 'https://b.example.com/x', headers: '', body: '', bodyType: 'none', rawContentType: '',
      }],
      baseTestClass: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('.get(baseUrl + "https://b.example.com/x")');
    expect(r.warnings.join('\n')).toContain('不在 baseUrl');
  });

  it('lang 非 java / 空接口列表 → ok:false（[C-82]/[C-84]：不产出半成品）', () => {
    const wrongLang = generateRestAssured({ ...CASES[1].input, lang: 'python' as unknown as 'java' });
    expect(wrongLang.ok).toBe(false);
    if (!wrongLang.ok) expect(wrongLang.error).toContain('暂只支持 Java');

    const empty = generateRestAssured({ className: 'X', baseUrl: 'http://x', requests: [] });
    expect(empty.ok).toBe(false);
  });

  it('生成物文件规范：LF、末尾恰好一个换行、无行尾空格、可复现（[C-102]/[C-85]）', () => {
    const r = generateRestAssured(CASES[0].input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.files) {
      expect(f.content).not.toContain('\r');
      expect(f.content.endsWith('\n')).toBe(true);
      expect(f.content.endsWith('\n\n')).toBe(false);
      expect(f.content.split('\n').every((l) => l === l.replace(/[ \t]+$/, ''))).toBe(true);
    }
    // [C-85] 的可复现口径：不是"不许出现日期字面量"（body 里的 date-time 示例是固定值），
    // 而是"两次生成必须一模一样" —— 时间戳/随机数会让这条立刻挂
    const again = generateRestAssured(CASES[0].input);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.files.map((f) => f.content)).toEqual(r.files.map((f) => f.content));
    for (const f of r.files) expect(f.content).not.toMatch(/currentTimeMillis|new Date\(|Instant\.now/);
  });
});