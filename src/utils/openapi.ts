/**
 * OpenAPI / Swagger → 既有 `ImportedRequest[]`（契约 §3.3 / [C-87]–[C-89]；模块 1.1）。
 *
 * 【为什么不另立一套请求模型】[C-87] 说得很硬：输出必须复用 `src/utils/collectionImport.ts` 的
 * `ImportedRequest`。理由是下游全都在用那套形状 —— ApiClient 的预览/合并、`apiRequests` 集合、
 * 环境变量替换都是按 `headers`（`k: v` 多行）/ `bodyType` / `rawContentType` 写的。
 * 另造一套看起来更"贴合 OpenAPI"，但代价是页面要写第二条导入链路，两条迟早漂移。
 *
 * 【三个容易踩的地方，都在这里处理】
 * 1. **`$ref` 循环**：A→B→A 用朴素的「递归解析」就是栈溢出，用户看到的是「导入一个 spec 应用卡死」。
 *    这里的做法是带一个 `refStack`，重入即截断成 `{}` 并压一条 `$ref 循环：<name>，已截断为 Object`。
 * 2. **JSON 与 YAML 两种载体**：先试 `JSON.parse`，失败再走 `js-yaml`。顺序不能反 ——
 *    YAML 是 JSON 的超集，先拿 YAML 解析器跑会把很多坏 JSON 也"解析成功"，报错信息反而更难懂。
 * 3. **告警不许静默**：`oneOf/anyOf/discriminator/callbacks/webhooks` 这些本批没有完整支持，
 *    每条都进 `warnings[]`。理由很实际：用户以为 100 个接口都进来了，实际只有 60 个可用，
 *    而界面上看不出任何异常 —— [C-83] 因此要求 warnings 必须能在 UI 上看到。
 *
 * 本文件是纯函数：不读文件、不碰 IPC、不含时间戳/随机数（[C-85]，golden 才能逐字比对）。
 * 依赖方向：[C-107] 允许 `openapi.ts → collectionImport.ts`（只为拿类型），
 * **禁止** import 任何 `codegen/*` —— 它只产出请求模型，不生成代码。
 */

import { load as yamlLoad } from 'js-yaml';
import type { ImportedRequest, ImportBodyType } from './collectionImport';

/* ================================================================
   对外契约（[C-87]）
   ================================================================ */

export interface OpenApiParseOk {
  ok: true;
  spec: 'swagger2' | 'oas3';
  /**
   * 文档版本原文（`2.0` / `3.0.3` / `3.1.0`）。
   * [C-87] 的 `version` 指 `info.version`（业务版本，如 `1.0.0`），两者不是一回事：
   * 3.0 与 3.1 的差异（`webhooks`、`type: ['string','null']`）只能靠这个字段判断。
   */
  oasVersion: string;
  title: string;
  version: string;
  baseUrl: string;
  requests: ImportedRequest[];
  warnings: string[];
}

export type OpenApiParseResult = OpenApiParseOk | { ok: false; error: string };

/* ================================================================
   小工具
   ================================================================ */

type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** OpenAPI 允许出现的 HTTP 方法（`trace` 也列上：3.x 允许，别按「只用 GET/POST」漏掉） */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** `paths` 下不是方法名的键 */
const NON_METHOD_KEYS = new Set(['parameters', 'summary', 'description', 'servers', '$ref']);

/** 固定的告警文案（[C-89] 的 5 条 + 本批新增的 3 条，见文件头第 3 点） */
const W = {
  badVersion: (v: string) => `不支持 OpenAPI 版本：${v}`,
  refMissing: (ref: string) => `$ref 未找到：${ref}`,
  refLoop: (name: string) => `$ref 循环：${name}，已截断为 Object`,
  combine: (name: string) => `allOf 已按字段合并，oneOf/anyOf 取第一个分支：${name}`,
  noServer: '未提供 servers/baseUrl，已使用默认 http://localhost',
  discriminator: (name: string) => `discriminator 暂不支持：${name}，已按首个分支生成`,
  callbacks: (where: string) => `callbacks 暂不支持：${where}，已跳过`,
  webhooks: (n: number) => `webhooks 暂不支持：共 ${n} 个，已跳过`,
};

/** 告警去重：同一条（比如同一个循环引用被多个接口命中）只报一次，否则 100 个接口就刷 100 行 */
function warn(warnings: string[], msg: string): void {
  if (!warnings.includes(msg)) warnings.push(msg);
}

/* ================================================================
   载入：JSON 优先，YAML 兜底
   ================================================================ */

function loadDocument(text: string): { doc: Json } | { error: string } {
  const raw = String(text ?? '').trim();
  if (!raw) return { error: '文档为空：请粘贴 JSON/YAML 内容，或选择一份 OpenAPI/Swagger 文件' };

  try {
    const parsed = JSON.parse(raw);
    if (isObj(parsed)) return { doc: parsed };
  } catch {
    // 不是 JSON —— 走 YAML。这里刻意不把 JSON 的错误抛出去：
    // 一份 .yaml 文件必然让 JSON.parse 失败，那是**正常路径**，不是错误。
  }

  try {
    const parsed = yamlLoad(raw);
    if (isObj(parsed as unknown)) return { doc: parsed as Json };
    return { error: '文件内容不是对象：OpenAPI 文档的顶层必须是 YAML/JSON 映射' };
  } catch (e) {
    return { error: `无法解析：既不是合法 JSON，也不是合法 YAML（${e instanceof Error ? e.message : String(e)}）` };
  }
}

/* ================================================================
   $ref 解析（含循环保护，[C-88]）
   ================================================================ */

/** 只解析文档内部的 `#/...` 指针；外部文件（`./common.yaml#/x`）本批不支持，按「未找到」处理 */
function refTarget(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return null;
  const segs = ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: any = doc;
  for (const seg of segs) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = cur[seg];
    if (cur === undefined) return null;
  }
  return cur ?? null;
}

/** `#/components/schemas/Pet` → `Pet`；`#/definitions/Error` → `Error`（告警里用人能读的名字） */
function refName(ref: string): string {
  const segs = ref.split('/');
  return segs[segs.length - 1] || ref;
}

/* ================================================================
   schema → 示例 JSON（[C-87]「生成的是可直接粘进接口调试的 JSON，不是 schema 原文」）
   ================================================================ */

interface ExCtx {
  doc: Json;
  warnings: string[];
}

/** 固定示例值：**不许用 new Date()**（[C-85]：含当前时间会让 golden 每天变红） */
const FORMAT_SAMPLES: Record<string, unknown> = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '00:00:00',
  email: 'user@example.com',
  uuid: '00000000-0000-4000-8000-000000000000',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  ipv6: '::1',
  byte: 'c3RyaW5n',
  binary: '<binary>',
  password: 'password',
};

/**
 * 用 schema 造一份**确定性**示例值。
 *
 * @param schema   可能含 `$ref` / `allOf` / `oneOf` 的 schema 片段
 * @param ctx      文档 + 告警收集器
 * @param refStack 已经展开过的 `$ref` 名（**循环保护就靠它**）
 * @param path     `Pet.tags[]` 这种人能读的位置，只用于告警文案
 */
function exampleOf(schema: unknown, ctx: ExCtx, refStack: string[], path: string): unknown {
  if (!isObj(schema)) return {};

  /* ---- 1) $ref：先判循环再解析 ---- */
  if (typeof schema.$ref === 'string' && schema.$ref) {
    const ref = schema.$ref;
    const name = refName(ref);
    if (refStack.includes(name)) {
      // 循环：**不要**继续递归，也不要报错 —— 截断成空对象，接口照样能生成
      warn(ctx.warnings, W.refLoop(name));
      return {};
    }
    const target = refTarget(ctx.doc, ref);
    if (!isObj(target)) {
      warn(ctx.warnings, W.refMissing(ref));
      return {};
    }
    return exampleOf(target, ctx, [...refStack, name], path || name);
  }

  /* ---- 2) 组合关键字 ---- */
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    // allOf = 交集：把各分支的 properties 合并成一份对象（[C-89] 的模板只给了一条文案，
    // 所以合并与 oneOf 取首分支共用同一句告警，靠 `<name>` 区分是哪个 schema）
    warn(ctx.warnings, W.combine(refStack[refStack.length - 1] || path || 'schema'));
    const merged: Json = { type: 'object', properties: {}, required: [] as string[] };
    for (const branch of schema.allOf) {
      const part = isObj(branch) && typeof branch.$ref === 'string'
        ? refTarget(ctx.doc, branch.$ref)
        : branch;
      if (!isObj(part)) continue;
      if (isObj(part.properties)) Object.assign(merged.properties, part.properties);
      if (Array.isArray(part.required)) merged.required.push(...part.required);
    }
    // 自身还带 properties 的 allOf 也要算进来（常见写法：allOf 里套一个本地对象）
    if (isObj(schema.properties)) Object.assign(merged.properties, schema.properties);
    return exampleOf(merged, ctx, refStack, path);
  }

  const firstOf: unknown = Array.isArray(schema.oneOf) && schema.oneOf.length
    ? schema.oneOf[0]
    : Array.isArray(schema.anyOf) && schema.anyOf.length
      ? schema.anyOf[0]
      : undefined;
  if (firstOf !== undefined) {
    // 取首分支是「明确的能力边界」，不是 bug —— 但必须让用户知道只有一支被生成了
    warn(ctx.warnings, W.combine(refStack[refStack.length - 1] || path || 'schema'));
    if (schema.discriminator) {
      warn(ctx.warnings, W.discriminator(refStack[refStack.length - 1] || path || 'schema'));
    }
    return exampleOf(firstOf, ctx, refStack, path);
  }
  if (schema.discriminator) warn(ctx.warnings, W.discriminator(refStack[refStack.length - 1] || path || 'schema'));

  /* ---- 3) 显式示例优先（作者已经给了值，就别自己猜） ---- */
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  /* ---- 4) 按 type 造值（3.1 的 type 可以是数组，形如 ['string','null']） ---- */
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? 'string';
  const ts = str(type);

  if (ts === 'object' || (!ts && (isObj(schema.properties) || isObj(schema.additionalProperties)))) {
    const out: Json = {};
    if (isObj(schema.properties)) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        out[key] = exampleOf(sub, ctx, refStack, path ? `${path}.${key}` : key);
      }
    } else if (isObj(schema.additionalProperties)) {
      out.key = exampleOf(schema.additionalProperties, ctx, refStack, path ? `${path}.*` : '*');
    }
    return out;
  }

  if (ts === 'array') {
    // 数组只给 1 个元素：够表达结构，又不会让 10 万行数据把界面撑爆
    if (!schema.items) return [];
    return [exampleOf(schema.items, ctx, refStack, `${path}[]`)];
  }

  if (ts === 'integer') return 1;
  if (ts === 'number') return 1.5;
  if (ts === 'boolean') return true;
  if (ts === 'string') {
    const fmt = str(schema.format);
    if (fmt && FORMAT_SAMPLES[fmt] !== undefined) return FORMAT_SAMPLES[fmt];
    if (schema.pattern) return 'string';
    return 'string';
  }
  if (ts === 'null') return null;
  return {};
}

/* ================================================================
   baseUrl（[C-87]：2.0 用 host + basePath + schemes，3.x 用 servers[0].url）
   ================================================================ */

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function serverUrl(raw: string, variables: unknown): string {
  // 3.x 允许 `https://{host}/v1` + variables.host.default —— 有默认值就用默认值，
  // 没有就原样留着：留一个 `{host}` 至少用户还能看出来该填什么
  return raw.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    const v = isObj(variables) ? variables[name] : undefined;
    return isObj(v) && v.default !== undefined ? str(v.default) : whole;
  });
}

function resolveBaseUrl(doc: Json, spec: 'swagger2' | 'oas3', override?: string): { baseUrl: string; warning?: string } {
  const forced = str(override).trim();
  if (forced) return { baseUrl: trimSlash(forced) };

  if (spec === 'swagger2') {
    const host = str(doc.host).trim();
    const basePath = str(doc.basePath).trim();
    if (!host) return { baseUrl: 'http://localhost', warning: W.noServer };
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? str(doc.schemes[0]) : 'http';
    return { baseUrl: trimSlash(`${scheme}://${host}${basePath}`) };
  }

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const first = servers.find((s) => isObj(s) && str(s.url).trim());
  if (!first) return { baseUrl: 'http://localhost', warning: W.noServer };
  let url = serverUrl(str((first as Json).url).trim(), (first as Json).variables);
  // `servers[0].url` 允许写成相对路径（`/v1`）——那是"同源"的意思，本机导入时补一个默认域名
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://localhost${url.startsWith('/') ? '' : '/'}${url}`;
  return { baseUrl: trimSlash(url) };
}

/* ================================================================
   参数 / 请求头 / 请求体
   ================================================================ */

interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema?: unknown;
  example?: unknown;
  default?: unknown;
  /** 2.0 的 body 参数没有 schema 时可能只给 type */
  type?: string;
}

/** path 级参数 + operation 级参数合并：**operation 覆盖 path**（[C-87]） */
function mergeParams(pathLevel: unknown, opLevel: unknown): Param[] {
  const base = Array.isArray(pathLevel) ? pathLevel.filter(isObj) : [];
  const over = Array.isArray(opLevel) ? opLevel.filter(isObj) : [];
  const byKey = new Map<string, Param>();
  for (const p of base) byKey.set(`${str(p.in)}:${str(p.name)}`, p as Param);
  for (const p of over) byKey.set(`${str(p.in)}:${str(p.name)}`, p as Param); // 后写覆盖前写
  return [...byKey.values()];
}

/** `k: v` 多行（与 ImportedRequest.headers 的既有约定一致） */
function headersText(lines: string[]): string {
  return lines.join('\n');
}

const CONTENT_TYPE_TO_BODY_TYPE = (ct: string): ImportBodyType => {
  const t = ct.toLowerCase();
  if (!t) return 'none';
  if (t.includes('json')) return 'json';
  if (t.includes('x-www-form-urlencoded')) return 'form';
  if (t.includes('multipart/form-data')) return 'multipart';
  return 'raw';
};

/** 从 3.x `content` 里挑一份：优先 JSON，其次表单，最后取第一个（顺序固定 = 可复现） */
function pickContent(content: Json): { contentType: string; media: Json } | null {
  const entries = Object.entries(content).filter(([, v]) => isObj(v));
  if (!entries.length) return null;
  const prefer = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'];
  for (const want of prefer) {
    const hit = entries.find(([ct]) => ct.toLowerCase().startsWith(want));
    if (hit) return { contentType: hit[0], media: hit[1] as Json };
  }
  const jsonLike = entries.find(([ct]) => ct.toLowerCase().includes('json'));
  if (jsonLike) return { contentType: jsonLike[0], media: jsonLike[1] as Json };
  const [ct, media] = entries[0];
  return { contentType: ct, media: media as Json };
}

/** 表单族（form / multipart）的 body 文本：`k=值` 每行一个，与 Postman 导入的约定一致 */
function formBody(schema: unknown, ctx: ExCtx, refStack: string[]): string {
  const example = exampleOf(schema, ctx, refStack, 'body');
  if (!isObj(example)) return '';
  return Object.entries(example)
    .map(([k, v]) => `${k}=${v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : str(v)}`)
    .join('\n');
}

/** schema → 可粘贴的字符串（json 用 2 空格缩进，别的格式按上文约定） */
function bodyTextFor(
  contentType: string,
  schema: unknown,
  ctx: ExCtx,
  refStack: string[],
): { body: string; bodyType: ImportBodyType } {
  const bodyType = CONTENT_TYPE_TO_BODY_TYPE(contentType);
  if (!schema) return { body: '', bodyType };
  if (bodyType === 'json') return { body: JSON.stringify(exampleOf(schema, ctx, refStack, 'body'), null, 2), bodyType };
  if (bodyType === 'form' || bodyType === 'multipart') return { body: formBody(schema, ctx, refStack), bodyType };
  const example = exampleOf(schema, ctx, refStack, 'body');
  return { body: typeof example === 'string' ? example : JSON.stringify(example, null, 2), bodyType };
}

/* ================================================================
   security → 占位请求头（[C-87]：Bearer 用 {{token}}，不写字面 token）
   ================================================================ */

interface AuthHint {
  headers: string[];
  /** in=query 的 apiKey 要拼到 URL 上 */
  query: string[];
}

function authOf(doc: Json, requirements: unknown): AuthHint {
  const out: AuthHint = { headers: [], query: [] };
  const list = Array.isArray(requirements) ? requirements.filter(isObj) : [];
  if (!list.length) return out;

  const schemes: Json = isObj(doc.components) && isObj(doc.components.securitySchemes)
    ? doc.components.securitySchemes
    : isObj(doc.securityDefinitions)
      ? doc.securityDefinitions
      : {};

  // 同一接口可以声明多个可选方案（OR 关系）——取第一个能识别出来的，
  // 全都识别不出来就默认按 Bearer 处理（几乎所有开放平台都是这个）
  for (const req of list) {
    const names = Object.keys(req);
    if (!names.length) continue;
    const name = names[0];
    const scheme = isObj(schemes[name]) ? schemes[name] : null;
    const type = str(scheme ? scheme.type : '').toLowerCase();
    const inWhere = str(scheme ? scheme.in : '').toLowerCase();
    const headerName = str(scheme ? scheme.name : '');

    if (type === 'apikey' && headerName) {
      if (inWhere === 'query') out.query.push(`${headerName}={{token}}`);
      else if (inWhere === 'cookie') out.headers.push(`Cookie: ${headerName}={{token}}`);
      else out.headers.push(`${headerName}: {{token}}`);
    } else if (type === 'http' && str(scheme?.scheme).toLowerCase() === 'basic') {
      out.headers.push('Authorization: Basic {{basicAuth}}');
    } else {
      // http bearer / oauth2 / openIdConnect / 未识别的 scheme：统一 Bearer 占位
      out.headers.push('Authorization: Bearer {{token}}');
    }
    return out; // 第一个方案就够：多方案是 OR，生成多个头反而会互相打架
  }
  return out;
}

/* ================================================================
   主入口
   ================================================================ */

export function parseOpenApi(text: string, opts?: { baseUrl?: string }): OpenApiParseResult {
  const loaded = loadDocument(text);
  if ('error' in loaded) return { ok: false, error: loaded.error };
  const doc = loaded.doc;

  const warnings: string[] = [];

  /* ---- 版本识别 ---- */
  const swagger = str(doc.swagger).trim();
  const openapi = str(doc.openapi).trim();
  let spec: 'swagger2' | 'oas3';
  let oasVersion: string;
  if (swagger) {
    spec = 'swagger2';
    oasVersion = swagger;
    if (!/^2(\.|$)/.test(swagger)) warn(warnings, W.badVersion(swagger));
  } else if (openapi) {
    spec = 'oas3';
    oasVersion = openapi;
    if (!/^3(\.|$)/.test(openapi)) warn(warnings, W.badVersion(openapi));
  } else {
    return { ok: false, error: '无法识别：既没有 swagger 字段，也没有 openapi 字段（不是 OpenAPI/Swagger 文档）' };
  }

  const info: Json = isObj(doc.info) ? doc.info : {};
  const title = str(info.title).trim() || '未命名接口文档';
  const version = str(info.version).trim();

  const base = resolveBaseUrl(doc, spec, opts?.baseUrl);
  if (base.warning) warn(warnings, base.warning);
  const baseUrl = base.baseUrl;

  /* ---- 3.1 的 webhooks ---- */
  if (isObj(doc.webhooks)) {
    const n = Object.keys(doc.webhooks).length;
    if (n) warn(warnings, W.webhooks(n));
  }

  const paths: Json = isObj(doc.paths) ? doc.paths : {};
  const requests: ImportedRequest[] = [];
  const ctx: ExCtx = { doc, warnings };

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (rawPath.startsWith('x-') || !isObj(pathItem)) continue;
    const pathLevelParams = pathItem.parameters;
    const pathLevelAuth = pathItem.security;

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!isObj(op)) continue;

      const where = `${method.toUpperCase()} ${rawPath}`;

      /* 参数：path 级 + operation 级，operation 覆盖 path */
      const params = mergeParams(pathLevelParams, op.parameters);

      /* URL：`/pets/{petId}` → `/pets/{{petId}}`。
         这不是"改写原文"，而是把它接到本项目已有的环境变量语法上 ——
         ApiClient 发送前会把 `{{petId}}` 换成环境里的值；留 `{petId}` 会被原样发出去。 */
      let pathPart = rawPath;
      for (const p of params) {
        if (p.in !== 'path') continue;
        pathPart = pathPart.split(`{${p.name}}`).join(`{{${p.name}}}`);
      }

      const query: string[] = [];
      for (const p of params) {
        if (p.in !== 'query') continue;
        const value = p.example !== undefined
          ? str(p.example)
          : p.default !== undefined
            ? str(p.default)
            : `{{${p.name}}}`;
        query.push(`${encodeURIComponent(p.name)}=${value}`);
      }

      /* security：operation 覆盖全局；`security: []` 表示显式关闭 */
      const security = op.security !== undefined ? op.security : (pathLevelAuth !== undefined ? pathLevelAuth : doc.security);
      const auth = authOf(doc, security);
      query.push(...auth.query);

      const url = trimSlash(`${baseUrl}${pathPart}`) + (query.length ? `?${query.join('&')}` : '');

      /* 请求头：参数头 → security 头 → 请求体 content-type */
      const headerLines: string[] = [];
      for (const p of params) {
        if (p.in !== 'header') continue;
        const value = p.example !== undefined
          ? str(p.example)
          : p.default !== undefined
            ? str(p.default)
            : `{{${p.name}}}`;
        headerLines.push(`${p.name}: ${value}`);
      }
      headerLines.push(...auth.headers);

      /* 请求体 */
      let body = '';
      let bodyType: ImportBodyType = 'none';
      let rawContentType = '';

      if (spec === 'oas3') {
        const rb = isObj(op.requestBody) ? op.requestBody : null;
        const content = rb && isObj(rb.content) ? pickContent(rb.content) : null;
        if (content) {
          const schema = isObj(content.media.schema) ? content.media.schema : null;
          const built = bodyTextFor(content.contentType, schema, ctx, []);
          body = built.body;
          bodyType = built.bodyType;
          rawContentType = content.contentType;
        }
      } else {
        // 2.0：body 参数挂在 parameters 里（`in: body`）
        const bodyParam = params.find((p) => p.in === 'body');
        if (bodyParam) {
          const schema = isObj(bodyParam.schema) ? bodyParam.schema : null;
          const ct = str((bodyParam as Json).consumes) || firstOf(doc.consumes, op.consumes) || 'application/json';
          const built = bodyTextFor(ct, schema, ctx, []);
          body = built.body;
          bodyType = built.bodyType;
          rawContentType = ct;
        } else {
          const formData = params.filter((p) => p.in === 'formData');
          if (formData.length) {
            const ct = firstOf(doc.consumes, op.consumes) || 'application/x-www-form-urlencoded';
            rawContentType = ct;
            bodyType = CONTENT_TYPE_TO_BODY_TYPE(ct);
            body = formData.map((p) => {
              const value = p.example !== undefined
                ? str(p.example)
                : p.default !== undefined
                  ? str(p.default)
                  : (str(p.type) === 'file' ? '@file' : `{{${p.name}}}`);
              return `${p.name}=${value}`;
            }).join('\n');
          }
        }
      }

      if (body && rawContentType) headerLines.push(`Content-Type: ${rawContentType}`);

      /* 本批不支持的字段：逐条告警，不许静默 */
      if (isObj(op.callbacks) && Object.keys(op.callbacks).length) warn(warnings, W.callbacks(where));

      const name = str(op.operationId).trim() || str(op.summary).trim() || where;
      const tags = Array.isArray(op.tags) ? op.tags.map(str).filter(Boolean) : [];

      requests.push({
        name,
        group: tags[0] || 'default',
        method: method.toUpperCase(),
        url,
        headers: headersText(headerLines),
        body,
        bodyType,
        rawContentType,
      });
    }
  }

  return { ok: true, spec, oasVersion, title, version, baseUrl, requests, warnings };
}

/** `consumes` 既可能在根上也可能是数组，op 级优先 */
function firstOf(root: unknown, op: unknown): string {
  const pick = (v: unknown): string => (Array.isArray(v) && v.length ? str(v[0]) : '');
  return pick(op) || pick(root);
}