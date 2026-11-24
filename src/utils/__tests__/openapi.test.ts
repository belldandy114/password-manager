import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { parseOpenApi, type OpenApiParseOk } from '../openapi';
import type { ImportBodyType } from '../collectionImport';

/**
 * 1.1 OpenAPI / Swagger 解析的单测（契约 §3.3 / [C-87]–[C-89]）。
 *
 * 三份 fixture 都按`.yaml`/`.json` **读文件**进来（不是内联字符串）：
 * [C-100] 要求 `__fixtures__` 放"喂料"，1.1 的验收也明确要求"真选文件"这条路能走通 ——
 * 只测内联字符串会漏掉「YAML 走 JSON.parse 失败 → 落到 js-yaml」这条真实分支。
 *
 * 重点覆盖的三类，都是踩过才知道疼的：
 *   ① `$ref` 循环（A→B→A）必须**不炸**且给告警，否则用户看到的是「导入一个 spec 应用卡死」；
 *   ② 告警不许静默（callbacks/webhooks/discriminator/oneOf）——用户以为全导进来了；
 *   ③ 接口数 = `paths` × method 的真实组合数（少一个都说明筛选逻辑写错了）。
 */

const FIXTURE_DIR = path.join(process.cwd(), 'src', 'utils', '__tests__', '__fixtures__', 'openapi');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** 断言 ok 并收窄类型（避免每处都写 if (!r.ok) return） */
function okOf(r: ReturnType<typeof parseOpenApi>): OpenApiParseOk {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r;
}

function headersOf(req: { headers: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of req.headers.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/* ================================================================
   ① 3.0 + YAML 载体
   ================================================================ */

describe('parseOpenApi：3.0 + YAML（.yaml 走文件路径，不是内联字符串）', () => {
  const text = readFixture('oas3-petstore.yaml');
  const doc = okOf(parseOpenApi(text));

  it('识别为 oas3 / 3.0.3，标题与业务版本分开取', () => {
    expect(doc.spec).toBe('oas3');
    expect(doc.oasVersion).toBe('3.0.3');
    expect(doc.title).toBe('Pet Store API');
    expect(doc.version).toBe('1.4.2');
  });

  it('baseUrl 取 servers[0].url（3.x 不用 host/basePath）', () => {
    expect(doc.baseUrl).toBe('https://petstore.example.com/v1');
  });

  it('接口数 = paths × method 的真实组合数（这里是 4）', () => {
    // /pets: get + post；/pets/{petId}: get + delete（parameters/summary 这类键不算方法）
    expect(doc.requests).toHaveLength(4);
    expect(doc.requests.map((r) => `${r.method} ${r.name}`).sort()).toEqual([
      'DELETE deletePet',
      'GET getPet',
      'GET listPets',
      'POST createPet',
    ]);
  });

  it('输出复用 ImportedRequest 模型：group=tags[0]、method 大写、bodyType 映射', () => {
    const list = doc.requests.find((r) => r.name === 'listPets')!;
    expect(list.group).toBe('pets');
    expect(list.method).toBe('GET');
    expect(list.bodyType).toBe<ImportBodyType>('none');

    const create = doc.requests.find((r) => r.name === 'createPet')!;
    expect(create.bodyType).toBe<ImportBodyType>('json');
    expect(create.rawContentType).toBe('application/json');
  });

  it('path 级参数被继承：/pets 下两个方法都带 X-Tenant（用 example 值）', () => {
    for (const name of ['listPets', 'createPet']) {
      const req = doc.requests.find((r) => r.name === name)!;
      expect(headersOf(req)['X-Tenant']).toBe('demo');
    }
    // 继承是按 pathItem 的：/pets/{petId} 没有声明这条参数，就不该凭空出现
    const get = doc.requests.find((r) => r.name === 'getPet')!;
    expect(headersOf(get)['X-Tenant']).toBeUndefined();
  });

  it('query 参数进 URL（有 example 用 example，没有就用变量占位）', () => {
    const list = doc.requests.find((r) => r.name === 'listPets')!;
    expect(list.url).toBe('https://petstore.example.com/v1/pets?limit=20');

    const get = doc.requests.find((r) => r.name === 'getPet')!;
    // path 参数换成 {{petId}}：ApiClient 发送前按环境变量替换，留 {petId} 会被原样发出去
    expect(get.url).toBe('https://petstore.example.com/v1/pets/{{petId}}?verbose={{verbose}}');
  });

  it('security → Bearer {{token}} 占位（不写字面 token）', () => {
    const list = doc.requests.find((r) => r.name === 'listPets')!;
    expect(headersOf(list)['Authorization']).toBe('Bearer {{token}}');
  });

  it('operation 级 security: [] 覆盖全局 → 该接口没有 Authorization', () => {
    const del = doc.requests.find((r) => r.name === 'deletePet')!;
    expect(headersOf(del)['Authorization']).toBeUndefined();
    expect(del.headers).not.toContain('Authorization');
  });

  it('allOf 合并 + 数组给 1 个元素 + enum 取首值 + date-time 给固定 ISO 串', () => {
    const create = doc.requests.find((r) => r.name === 'createPet')!;
    const body = JSON.parse(create.body) as Record<string, unknown>;

    // allOf: PetBase(id,name) + Pet(tags,status,createdAt)
    expect(body).toEqual({
      id: 1,
      name: 'string',
      tags: ['string'],
      status: 'available',
      createdAt: '2024-01-01T00:00:00Z',
    });
    // [C-85]：不得出现"当前时间"这类不确定值
    expect(create.body).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d+/);
  });

  it('内容协商头由 rawContentType 推出来（有 body 才加）', () => {
    const create = doc.requests.find((r) => r.name === 'createPet')!;
    expect(headersOf(create)['Content-Type']).toBe('application/json');
    const list = doc.requests.find((r) => r.name === 'listPets')!;
    expect(headersOf(list)['Content-Type']).toBeUndefined();
  });
});

/* ================================================================
   ② Swagger 2.0 + $ref 循环（C-88 的核心用例）
   ================================================================ */

describe('parseOpenApi：2.0 + #/definitions 的 $ref 循环保护', () => {
  const doc = okOf(parseOpenApi(readFixture('swagger2-ref-loop.json')));

  it('识别为 swagger2，baseUrl = schemes[0] + host + basePath', () => {
    expect(doc.spec).toBe('swagger2');
    expect(doc.oasVersion).toBe('2.0');
    expect(doc.baseUrl).toBe('https://api.example.com/shop');
  });

  it('接口数 = 3，group 取 tags[0]', () => {
    expect(doc.requests).toHaveLength(3);
    for (const r of doc.requests) expect(r.group).toBe('orders');
  });

  it('A→B→A 循环不炸栈：数组里的回指被截断成 {}，并压一条固定文案的告警', () => {
    const create = doc.requests.find((r) => r.name === 'createOrder')!;
    const body = JSON.parse(create.body) as any;
    // Order → Customer → orders[] → Order（循环）：最内层退化成空对象
    expect(body).toEqual({
      id: 'string',
      customer: { name: 'string', orders: [{}] },
    });
    expect(doc.warnings).toContain('$ref 循环：Order，已截断为 Object');
  });

  it('#/definitions 二级 ref 能被解析（不是只支持 #/components/schemas）', () => {
    const put = doc.requests.find((r) => r.name === 'replaceOrder')!;
    const body = JSON.parse(put.body) as any;
    expect(body.customer.name).toBe('string');
  });

  it('2.0 的 in=body 参数 → JSON body，consumes 决定 Content-Type', () => {
    const create = doc.requests.find((r) => r.name === 'createOrder')!;
    expect(create.bodyType).toBe<ImportBodyType>('json');
    expect(create.rawContentType).toBe('application/json');
    expect(headersOf(create)['Content-Type']).toBe('application/json');
  });

  it('header 参数用 default 值；securityDefinitions 的 apiKey → {{token}}', () => {
    const create = doc.requests.find((r) => r.name === 'createOrder')!;
    const h = headersOf(create);
    expect(h['X-Trace']).toBe('trace-1');
    expect(h['X-API-Key']).toBe('{{token}}');
  });

  it('path 级与 operation 级参数合并：orderId 来自 path 级，expand 来自 op 级', () => {
    const get = doc.requests.find((r) => r.name === 'getOrder')!;
    expect(get.url).toBe('https://api.example.com/shop/orders/{{orderId}}?expand={{expand}}');
  });

  it('循环告警只报一次（同名循环不随接口数刷屏）', () => {
    const hits = doc.warnings.filter((w) => w.includes('$ref 循环'));
    expect(hits).toHaveLength(1);
  });
});

/* ================================================================
   ③ 3.1 + webhooks / callbacks / oneOf / discriminator
   ================================================================ */

describe('parseOpenApi：3.1（webhooks / callbacks / oneOf / discriminator 都要有告警）', () => {
  const doc = okOf(parseOpenApi(readFixture('oas31-webhooks.json')));

  it('识别为 oas3 / 3.1.0', () => {
    expect(doc.spec).toBe('oas3');
    expect(doc.oasVersion).toBe('3.1.0');
  });

  it('servers[0].url 的变量用 default 替换（{env} → sandbox）', () => {
    expect(doc.baseUrl).toBe('https://sandbox.example.com');
  });

  it('webhooks 不进 requests，但必须进 warnings', () => {
    // webhooks 不是 paths 下的接口：生成 RestAssured 时无处安放，只能告警
    expect(doc.requests).toHaveLength(2);
    expect(doc.warnings).toContain('webhooks 暂不支持：共 1 个，已跳过');
  });

  it('callbacks 逐接口告警（带方法与路径，用户能定位是哪个接口）', () => {
    expect(doc.warnings).toContain('callbacks 暂不支持：GET /events/{id}，已跳过');
  });

  it('oneOf 取首个分支 + discriminator 各一条告警，body 是首分支的对象', () => {
    const create = doc.requests.find((r) => r.name === 'createEvent')!;
    expect(JSON.parse(create.body)).toEqual({ kind: 'user', userId: 1 });
    const joined = doc.warnings.join('\n');
    expect(joined).toContain('oneOf/anyOf 取第一个分支');
    expect(joined).toContain('discriminator 暂不支持');
  });

  it('3.1 的 type: [string, null] 不影响 path 参数占位', () => {
    const get = doc.requests.find((r) => r.name === 'getEvent')!;
    expect(get.url).toBe('https://sandbox.example.com/events/{{id}}');
  });
});

/* ================================================================
   ④ 边界与错误（不是"顺手测"，是导入真实会遇到的）
   ================================================================ */

describe('parseOpenApi：边界与错误路径', () => {
  it('空输入 → ok:false + 明确文案（不是抛异常）', () => {
    const r = parseOpenApi('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('文档为空');
  });

  it('既不是 JSON 也不是 YAML → ok:false', () => {
    const r = parseOpenApi('{ this is: not valid json ][ ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(4);
  });

  it('缺 swagger / openapi 字段 → ok:false（别把普通 JSON 当文档导进去）', () => {
    const r = parseOpenApi('{"info":{"title":"x"},"paths":{}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('swagger');
  });

  it('不支持的版本号只告警、仍尽力解析（[C-89] 的固定文案）', () => {
    const r = okOf(parseOpenApi(JSON.stringify({
      openapi: '4.0.0',
      info: { title: 'Future', version: '1' },
      servers: [{ url: 'https://future.example.com' }],
      paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } },
    })));
    expect(r.warnings).toContain('不支持 OpenAPI 版本：4.0.0');
    expect(r.requests).toHaveLength(1);
  });

  it('缺 servers/baseUrl → 默认 http://localhost 并告警（[C-89]）', () => {
    const r = okOf(parseOpenApi(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'NoServer', version: '1' },
      paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } },
    })));
    expect(r.baseUrl).toBe('http://localhost');
    expect(r.warnings).toContain('未提供 servers/baseUrl，已使用默认 http://localhost');
    expect(r.requests[0].url).toBe('http://localhost/ping');
  });

  it('$ref 指向不存在的定义 → 告警 + 空对象（不抛错）', () => {
    const r = okOf(parseOpenApi(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Broken', version: '1' },
      servers: [{ url: 'https://b.example.com' }],
      paths: {
        '/x': {
          post: {
            operationId: 'postX',
            requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    })));
    expect(r.warnings).toContain('$ref 未找到：#/components/schemas/Missing');
    expect(JSON.parse(r.requests[0].body)).toEqual({});
  });

  it('opts.baseUrl 覆盖文档里的 servers（页面"我就要打到测试环境"）', () => {
    const r = okOf(parseOpenApi(readFixture('oas31-webhooks.json'), { baseUrl: 'http://127.0.0.1:8080/' }));
    expect(r.baseUrl).toBe('http://127.0.0.1:8080');
    expect(r.requests[0].url.startsWith('http://127.0.0.1:8080/')).toBe(true);
  });

  it('form 表单（3.x）→ bodyType=form、body 是 k=v 每行一个', () => {
    const r = okOf(parseOpenApi(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Form', version: '1' },
      servers: [{ url: 'https://f.example.com' }],
      paths: {
        '/login': {
          post: {
            operationId: 'login',
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: { user: { type: 'string' }, age: { type: 'integer' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    })));
    const req = r.requests[0];
    expect(req.bodyType).toBe<ImportBodyType>('form');
    expect(req.body).toBe('user=string\nage=1');
    expect(req.headers).toContain('Content-Type: application/x-www-form-urlencoded');
  });

  it('方法名兜底顺序：operationId → summary → "METHOD /path"', () => {
    const r = okOf(parseOpenApi(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Names', version: '1' },
      servers: [{ url: 'https://n.example.com' }],
      paths: {
        '/a': { get: { summary: '按摘要命名', responses: { '200': { description: 'ok' } } } },
        '/b': { get: { responses: { '200': { description: 'ok' } } } },
      },
    })));
    expect(r.requests.map((x) => x.name)).toEqual(['按摘要命名', 'GET /b']);
  });
});