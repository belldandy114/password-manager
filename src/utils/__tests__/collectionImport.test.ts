import { describe, it, expect } from 'vitest';
import {
  isPostmanCollection,
  parsePostmanCollection,
  urlOf,
  mergeRequests,
} from '../collectionImport';

/* 一个贴近真实导出的样本：两层文件夹、{{baseUrl}}、disabled 头、四种 body、认证 */
const sample = {
  info: {
    name: '订单中心',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'https://api.example.com' },
    { key: 'token', value: 'T-123' },
  ],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  item: [
    {
      name: '用户',
      item: [
        {
          name: '登录',
          request: {
            method: 'post',
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'X-Debug', value: '1', disabled: true },
              { key: 'Content-Length', value: '42' },
            ],
            body: { mode: 'raw', raw: '{"user":"a"}', options: { raw: { language: 'json' } } },
            url: { raw: '{{baseUrl}}/login', host: ['{{baseUrl}}'], path: ['login'] },
          },
        },
        {
          name: '上传头像',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'multipart/form-data' }],
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'avatar', type: 'file', src: ['C:\\tmp\\a.png'] },
                { key: 'desc', type: 'text', value: '头像' },
                { key: 'skip', type: 'text', value: 'x', disabled: true },
              ],
            },
            url: 'https://api.example.com/avatar',
          },
        },
      ],
    },
    {
      name: '订单',
      item: [
        {
          name: '查询',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'example', 'com'],
              port: '8443',
              path: ['v1', 'orders'],
              query: [
                { key: 'page', value: '1' },
                { key: 'bad', value: 'x', disabled: true },
              ],
            },
          },
        },
        {
          name: '提交',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'a', value: '1' },
                { key: 'b', value: '2', disabled: true },
              ],
            },
            url: '{{baseUrl}}/orders',
            auth: { type: 'apikey', apikey: [
              { key: 'key', value: 'X-Api-Key' },
              { key: 'value', value: 'k-1' },
              { key: 'in', value: 'header' },
            ] },
          },
        },
      ],
    },
  ],
};

describe('isPostmanCollection', () => {
  it('认得 v2.1 集合', () => {
    expect(isPostmanCollection(sample)).toBe(true);
  });
  it('不认普通 JSON', () => {
    expect(isPostmanCollection({ a: 1 })).toBe(false);
    expect(isPostmanCollection(null)).toBe(false);
  });
});

describe('urlOf', () => {
  it('字符串原样返回', () => {
    expect(urlOf('https://a.com/x')).toBe('https://a.com/x');
  });
  it('有 raw 用 raw（{{变量}} 保留）', () => {
    expect(urlOf({ raw: '{{baseUrl}}/x', host: ['{{baseUrl}}'] })).toBe('{{baseUrl}}/x');
  });
  it('没有 raw 时按 host/path/query 拼，disabled 查询参数丢掉', () => {
    expect(urlOf({
      protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['v1', 'orders'],
      query: [{ key: 'page', value: '1' }, { key: 'skip', value: 'x', disabled: true }],
    })).toBe('https://api.example.com:8443/v1/orders?page=1');
  });
  it('host 是 {{baseUrl}} 时不硬加 http://', () => {
    expect(urlOf({ host: ['{{baseUrl}}'], path: ['a'] })).toBe('{{baseUrl}}/a');
  });
});

describe('parsePostmanCollection', () => {
  const r = parsePostmanCollection(sample);
  if (!r.ok) throw new Error(r.error);

  it('集合名与请求数', () => {
    expect(r.collectionName).toBe('订单中心');
    expect(r.requests).toHaveLength(4);
  });

  it('文件夹路径进 group，并登记 groups', () => {
    expect(r.requests.map(x => x.group)).toEqual(['用户', '用户', '订单', '订单']);
    expect(r.groups).toEqual(['用户', '订单']);
    expect(r.requests[0].name).toBe('登录');
  });

  it('方法统一大写', () => {
    expect(r.requests[0].method).toBe('POST');
    expect(r.requests[2].method).toBe('GET');
  });

  it('集合级 auth 落到 Authorization 头', () => {
    expect(r.requests[2].headers).toContain('Authorization: Bearer {{token}}');
  });

  it('请求级 auth（apikey）覆盖集合级', () => {
    const req = r.requests[3];
    expect(req.headers).toContain('X-Api-Key: k-1');
    expect(req.headers).not.toContain('Authorization: Bearer');
  });

  it('disabled 头与自动生成头都不带过来', () => {
    const req = r.requests[0];
    expect(req.headers).not.toContain('X-Debug');
    expect(req.headers).not.toContain('Content-Length');
  });

  it('raw + language=json → json body', () => {
    const req = r.requests[0];
    expect(req.bodyType).toBe('json');
    expect(req.body).toBe('{"user":"a"}');
    expect(req.rawContentType).toBe('application/json');
  });

  it('formdata → multipart，文件字段写成 @路径，Content-Type 交给发送端', () => {
    const req = r.requests[1];
    expect(req.bodyType).toBe('multipart');
    expect(req.body.split('\n')).toEqual(['avatar=@C:\\tmp\\a.png', 'desc=头像']);
    expect(req.headers).not.toContain('Content-Type');
  });

  it('urlencoded → form，disabled 行丢掉，Content-Type 也去掉', () => {
    const req = r.requests[3];
    expect(req.bodyType).toBe('form');
    expect(req.body).toBe('a=1');
    expect(req.headers).not.toContain('Content-Type');
  });

  it('变量合并成 k=v 多行', () => {
    expect(r.variables.split('\n')).toEqual(['baseUrl=https://api.example.com', 'token=T-123']);
  });

  it('拼出来的地址正确（GET 请求）', () => {
    expect(r.requests[2].url).toBe('https://api.example.com:8443/v1/orders?page=1');
  });

  it('文件字段没有路径时给警告并留占位', () => {
    const res = parsePostmanCollection({
      info: { name: 'x', schema: 'postman' },
      item: [{
        name: '上传',
        request: {
          method: 'POST',
          header: [],
          body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file' }] },
          url: 'https://a.com/u',
        },
      }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.requests[0].body).toBe('f=@');
    expect(res.warnings.join('；')).toContain('文件字段「f」没有本地路径');
  });

  it('graphql 转成 JSON body', () => {
    const res = parsePostmanCollection({
      info: { name: 'gql', schema: 'postman' },
      item: [{
        name: 'q',
        request: {
          method: 'POST',
          url: 'https://a.com/graphql',
          body: { mode: 'graphql', graphql: { query: '{ a }', variables: '{"id":1}' } },
        },
      }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.requests[0].bodyType).toBe('json');
    expect(JSON.parse(res.requests[0].body)).toEqual({ query: '{ a }', variables: { id: 1 } });
  });

  it('raw + xml 走 raw 并带 Content-Type', () => {
    const res = parsePostmanCollection({
      info: { name: 'x', schema: 'postman' },
      item: [{
        name: 'x',
        request: {
          method: 'POST', url: 'https://a.com/x',
          body: { mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } },
        },
      }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.requests[0].bodyType).toBe('raw');
    expect(res.requests[0].rawContentType).toBe('application/xml');
  });

  it('Basic 认证编码成 Authorization: Basic', () => {
    const res = parsePostmanCollection({
      info: { name: 'b', schema: 'postman' },
      item: [{
        name: 'x',
        request: {
          method: 'GET', url: 'https://a.com/x',
          auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] },
        },
      }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.requests[0].headers).toBe('Authorization: Basic dTpw');
  });

  it('没有 name 的请求用方法 + 路径兜底', () => {
    const res = parsePostmanCollection({
      info: { name: 'n', schema: 'postman' },
      item: [{ request: { method: 'DELETE', url: 'https://a.com/users/9' } }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.requests[0].name).toBe('DELETE /users/9');
  });

  it('文件夹变量覆盖集合变量', () => {
    const res = parsePostmanCollection({
      info: { name: 'v', schema: 'postman' },
      variable: [{ key: 'env', value: 'dev' }, { key: 'keep', value: '1' }],
      item: [{
        name: 'f',
        variable: [{ key: 'env', value: 'prod' }],
        item: [{ name: 'r', request: { method: 'GET', url: 'https://a.com/r' } }],
      }],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.variables.split('\n')).toContain('env=prod');
    expect(res.variables.split('\n')).toContain('keep=1');
  });
});

describe('parsePostmanCollection 错误分支', () => {
  it('空字符串', () => {
    const r = parsePostmanCollection('   ');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('还没有内容');
  });
  it('坏 JSON', () => {
    const r = parsePostmanCollection('{oops');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('不是合法的 JSON');
  });
  it('不是集合', () => {
    const r = parsePostmanCollection({ openapi: '3.0.0', paths: {} });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('Postman Collection');
  });
  it('空集合', () => {
    const r = parsePostmanCollection({ info: { name: 'x', schema: 'postman' }, item: [] });
    expect(r.ok).toBe(false);
  });
});

describe('mergeRequests', () => {
  const existing = [
    { id: 'a', name: '登录', method: 'POST', url: 'https://x.com/login' },
    { id: 'b', name: '查询', method: 'GET', url: 'https://x.com/list' },
  ];
  const incoming = [
    { id: 'n1', name: '登录', method: 'POST', url: 'https://x.com/login' },
    { id: 'n2', name: '新接口', method: 'GET', url: 'https://x.com/new' },
  ];

  it('skip：冲突跳过，新接口追加', () => {
    const r = mergeRequests(existing, incoming, 'skip');
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.next.map(x => x.id)).toEqual(['a', 'b', 'n2']);
  });

  it('overwrite：保留原 id（界面勾选不失效）', () => {
    const r = mergeRequests(existing, incoming, 'overwrite');
    expect(r.replaced).toBe(1);
    expect(r.next[0].id).toBe('a');
    expect(r.next.map(x => x.id)).toEqual(['a', 'b', 'n2']);
  });

  it('duplicate：改名字再追加，名字不重复', () => {
    const r = mergeRequests(existing, incoming, 'duplicate');
    expect(r.added).toBe(2);
    expect(r.next).toHaveLength(4);
    const names = r.next.map(x => x.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[2]).toContain('导入');
  });

  it('空导入不改变原列表', () => {
    const r = mergeRequests(existing, [], 'skip');
    expect(r.next).toEqual(existing);
    expect([r.added, r.replaced, r.skipped]).toEqual([0, 0, 0]);
  });
});
