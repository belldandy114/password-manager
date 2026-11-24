/**
 * 1.1 请求模型 → Java RestAssured 测试类（契约 §3.3 / [C-90]–[C-91]）。
 *
 * 纯函数：`ImportedRequest[]` 进、Java 源码出；不读文件、不碰 IPC、不含时间戳/随机数（[C-85]）。
 *
 * 几条**写死**的口径（都是"生成物必须先能编译"倒推出来的）：
 *
 * 1. **每个接口一个 `@Test`**，方法名 `test` + `pascalCase(接口名)`；重名加数字后缀并压告警
 *    （[C-90]，重名不是异常但必须让用户知道哪个接口被改名了）。
 * 2. **每个方法恰好两条断言**：`statusCode(200)` 与 `body(not(emptyOrNullString()))`。
 *    只断言状态码会漏掉"200 但空响应体"这类最常见的问题；断言再多就不是骨架而是猜业务了。
 * 3. **URL 拆成 `baseUrl + "<path?query>"`**，而不是把绝对地址焊死：
 *    `BaseTest` 用 `System.getProperty("baseUrl", ...)` 读，跑测试时 `-DbaseUrl=http://127.0.0.1:8080`
 *    就能打到本机环境，不用改生成的代码。这正是不把绝对地址写死的原因。
 * 4. **请求体是 `String body = "...";` + `.body(body)`**，不是内联字符串拼接：
 *    JSON 里有引号/换行/大括号，塞进链式调用会变成"一屏看不懂的转义"，而且改起来要数引号。
 * 5. **import 只出真正用到的**（[C-90] 要求无未使用类型）：`baseTestClass` 为 true 时测试类不写
 *    `setUp()`，也就不能 import `RestAssured` / `BeforeAll`。
 *
 * 依赖方向：[C-107] 允许 `restassured.ts → escape.ts`，反向禁止；**不 import** openapi.ts。
 */

import {
  javaIdentifier, javaPackageSegment, javaString, pascalCase,
  type GenOk, type GenFail,
} from './escape';
import type { ImportedRequest } from '../collectionImport';

export interface RestAssuredInput {
  /** 必填，经 pascalCase + javaIdentifier 归一 */
  className: string;
  /** 缺省 `api`，逐段过 javaPackageSegment */
  packageName?: string;
  /** 必填，写进 `System.getProperty("baseUrl", ...)` 的默认值 */
  baseUrl: string;
  /** 必填，≥1 个接口 */
  requests: ImportedRequest[];
  /** 缺省 true：额外产出 `BaseTest.java`（[C-91] 的两个文件） */
  baseTestClass?: boolean;
  /** 缺省无：给每个方法加一条鉴权头（值一般是 `Bearer {{token}}`） */
  authHeader?: { name: string; value: string };
  lang?: 'java';
}

/* ================================================================
   小工具
   ================================================================ */

/** 归一化 package：`a.b` 逐段处理；空/非法段丢弃；全空回落到 default */
function normalizePackage(packageName: string | undefined, fallback: string): string {
  const raw = String(packageName ?? '').trim() || fallback;
  const segs = raw.split('.').map((seg) => javaPackageSegment(seg)).filter(Boolean);
  return segs.length ? segs.join('.') : fallback;
}

/** `api.test` → `api/test`（[C-91] 的 path 用 POSIX 分隔符） */
function packagePath(pkg: string): string {
  return pkg.split('.').join('/');
}

/** 已经用掉的标识符（方法名 / 类名都走它，重名加数字后缀） */
function uniqueName(used: Set<string>, base: string): { name: string; renamed: boolean } {
  if (!used.has(base)) {
    used.add(base);
    return { name: base, renamed: false };
  }
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  const name = `${base}${i}`;
  used.add(name);
  return { name, renamed: true };
}

/** RestAssured 的链式方法里存在的方法名（`trace` 没有对应的便捷方法，走 `.request(...)`） */
const CHAIN_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** `k: v` 多行 → `[k, v]`，同名校验时用（后出现的覆盖先出现的，避免两条 Content-Type） */
function parseHeaders(text: string): Array<[string, string]> {
  const map = new Map<string, string>();
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) map.set(k, v);
  }
  return [...map.entries()];
}

interface MethodPlan {
  /** 每个接口一段方法源码 */
  testBlocks: string[];
}

/* ================================================================
   入口
   ================================================================ */

export function generateRestAssured(input: RestAssuredInput): GenOk | GenFail {
  if (input.lang && input.lang !== 'java') {
    return { ok: false, error: '暂只支持 Java（lang=java）' };
  }

  const list = Array.isArray(input.requests) ? input.requests : [];
  if (!list.length) return { ok: false, error: '没有可生成的接口：先导入或选择一个接口文档' };

  const className = javaIdentifier(pascalCase(input.className) || 'ApiTest', 'ApiTest');
  const pkg = normalizePackage(input.packageName, 'api');
  const pkgPath = packagePath(pkg);
  const baseUrl = String(input.baseUrl ?? '').trim() || 'http://localhost';
  const useBase = input.baseTestClass !== false;
  const warnings: string[] = [];

  const usedMethods = new Set<string>();
  const plan: MethodPlan = { testBlocks: [] };

  for (const req of list) {
    const rawName = String(req.name || `${req.method} ${req.url}`);
    const wanted = `test${pascalCase(rawName)}`;
    const { name: methodName, renamed } = uniqueName(usedMethods, javaIdentifier(wanted, 'testApi'));
    if (renamed) warnings.push(`方法名重复：${wanted}，已改为 ${methodName}`);

    const method = String(req.method || 'GET').toUpperCase().toLowerCase();

    /* URL：剥掉 baseUrl 前缀，剩下的拼在 `baseUrl + ` 后面，方便 -DbaseUrl 覆盖 */
    const fullUrl = String(req.url ?? '');
    let pathPart = fullUrl;
    if (baseUrl && fullUrl.startsWith(baseUrl)) {
      pathPart = fullUrl.slice(baseUrl.length) || '/';
    } else if (/^https?:\/\//i.test(fullUrl)) {
      warnings.push(`接口 ${rawName} 的地址不在 baseUrl（${baseUrl}）下，已按绝对地址生成`);
    }
    if (!pathPart) pathPart = '/';

    const lines: string[] = [];
    lines.push('        given()');

    /* 请求头：authHeader 优先（放最前，读代码时一眼看到鉴权），然后文档里的头 */
    const headerPairs: Array<[string, string]> = [];
    const seen = new Set<string>();
    if (input.authHeader && input.authHeader.name) {
      headerPairs.push([input.authHeader.name, input.authHeader.value]);
      seen.add(input.authHeader.name.toLowerCase());
    }
    for (const [k, v] of parseHeaders(req.headers)) {
      if (seen.has(k.toLowerCase())) continue; // 同名头只保留一条，写两条会互相覆盖
      seen.add(k.toLowerCase());
      headerPairs.push([k, v]);
    }
    // 有请求体但没写 Content-Type 时补一条：否则 RestAssured 发出去的类型可能不是 JSON，
    // 服务端要么 415 要么按字符串收 —— 这是"生成的用例跑起来莫名 400"的常见源头
    if (req.body && req.rawContentType && !seen.has('content-type')) {
      seen.add('content-type');
      headerPairs.push(['Content-Type', req.rawContentType]);
    }
    for (const [k, v] of headerPairs) lines.push(`            .header(${javaString(k)}, ${javaString(v)})`);

    /* 请求体：先赋给局部变量，链上只放变量名 */
    if (req.body) {
      lines.push(`            .body(body)`);
    }

    if (method === 'trace') {
      // RestAssured 没有 .trace(...) 便捷方法，用通用入口
      lines.push('        .when()');
      lines.push(`            .request(${javaString('TRACE')}, baseUrl + ${javaString(pathPart)})`);
    } else if (CHAIN_METHODS.has(method)) {
      lines.push('        .when()');
      lines.push(`            .${method}(baseUrl + ${javaString(pathPart)})`);
    } else {
      lines.push('        .when()');
      lines.push(`            .request(${javaString(method.toUpperCase())}, baseUrl + ${javaString(pathPart)})`);
    }

    lines.push('        .then()');
    lines.push('            .statusCode(200)');
    lines.push('            .body(not(emptyOrNullString()));');

    const bodyLines = req.body ? [`        String body = ${javaString(req.body)};`, ''] : [];

    plan.testBlocks.push(
      [
        `    /** ${String(req.method || 'GET').toUpperCase()} ${pathPart}${req.group ? `（分组：${req.group}）` : ''} */`,
        '    @Test',
        `    public void ${methodName}() {`,
        ...bodyLines,
        ...lines,
        '    }',
      ].join('\n'),
    );
  }

  /* ---- 类文件 ---- */
  const classLines: string[] = [
    `package ${pkg};`,
    '',
    ...(useBase ? [] : ['import io.restassured.RestAssured;', 'import org.junit.jupiter.api.BeforeAll;']),
    'import org.junit.jupiter.api.Test;',
    '',
    'import static io.restassured.RestAssured.given;',
    'import static org.hamcrest.Matchers.emptyOrNullString;',
    'import static org.hamcrest.Matchers.not;',
    '',
    '/**',
    ` * ${className}：由「测试中台」从接口文档生成的 RestAssured 骨架。`,
    ' *',
    ' * <p>占位符（形如 {{token}} / {{petId}}）需要替换成真实值，或用系统属性覆盖 baseUrl：',
    ' * <pre>mvn test -DbaseUrl=http://127.0.0.1:8080</pre>',
    ' */',
    `public class ${className}${useBase ? ' extends BaseTest' : ''} {`,
    '',
  ];

  if (!useBase) {
    classLines.push(
      '    private static String baseUrl;',
      '',
      '    @BeforeAll',
      '    public static void setUp() {',
      `        baseUrl = System.getProperty("baseUrl", ${javaString(baseUrl)});`,
      '        RestAssured.baseURI = baseUrl;',
      '    }',
      '',
    );
  }

  classLines.push(plan.testBlocks.join('\n\n'));
  classLines.push('}', '');

  const files: Array<{ path: string; content: string }> = [];

  if (useBase) {
    const baseLines = [
      `package ${pkg};`,
      '',
      'import io.restassured.RestAssured;',
      'import org.junit.jupiter.api.BeforeAll;',
      '',
      '/**',
      ' * 生成物共用的基类：把 baseUrl 收敛到一处（-DbaseUrl=... 可覆盖）。',
      ' */',
      'public abstract class BaseTest {',
      '',
      '    protected static String baseUrl;',
      '',
      '    @BeforeAll',
      '    public static void setUp() {',
      `        baseUrl = System.getProperty("baseUrl", ${javaString(baseUrl)});`,
      '        RestAssured.baseURI = baseUrl;',
      '    }',
      '}',
      '',
    ];
    files.push({
      path: `src/test/java/${pkgPath}/BaseTest.java`,
      content: normalizeJava(baseLines.join('\n')),
    });
  }

  files.push({
    path: `src/test/java/${pkgPath}/${className}.java`,
    content: normalizeJava(classLines.join('\n')),
  });

  return { ok: true, files, warnings };
}

/**
 * 生成物的文件规范（[C-102]）：UTF-8 无 BOM、LF、末尾恰好一个换行、行尾无空格。
 * 统一在这里收口，免得每个拼接点各写一遍。
 */
export function normalizeJava(text: string): string {
  const body = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
  return `${body}\n`;
}