import { describe, it, expect, vi } from 'vitest';
import { runRequests, withCookies, type RunnerPayload, type RunnerResult } from '../apiRunner';
import type { ApiRequest, ApiResponseData } from '../../types';

const mkReq = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  id: 'r1', name: '请求', method: 'GET', url: 'http://x/api', headers: '', body: '',
  variables: '', cookies: '', assertions: {}, bodyType: 'json', rawContentType: '',
  updatedAt: '2026-11-13T00:00:00.000Z', ...over,
});

const res = (body: string, status = 200, timeMs = 10): RunnerResult => ({
  success: true,
  data: { status, statusText: 'OK', headers: {}, body, size: body.length, timeMs } as ApiResponseData,
});

describe('withCookies', () => {
  it('把每行 key=value 拼成 Cookie 头', () => {
    expect(withCookies('A: 1', 'a=1\nb=2')).toBe('A: 1\nCookie: a=1; b=2');
  });

  it('已有 Cookie 头时不覆盖', () => {
    expect(withCookies('Cookie: x=1', 'a=1')).toBe('Cookie: x=1');
  });

  it('没有 cookies 时原样返回', () => {
    expect(withCookies('A: 1')).toBe('A: 1');
  });
});

describe('runRequests', () => {
  it('顺序执行，并把上一步提取的变量替换进下一步 URL', async () => {
    const seen: RunnerPayload[] = [];
    const list = [
      mkReq({ id: 'a', url: 'http://x/login', extract: [{ name: 'token', path: 'data.token' }] }),
      mkReq({ id: 'b', url: 'http://x/list?t={{token}}' }),
    ];
    const rows = await runRequests(list, {
      send: async (p) => {
        seen.push(p);
        return seen.length === 1 ? res('{"data":{"token":"abc"}}') : res('{}');
      },
    });
    expect(seen.map(p => p.url)).toEqual(['http://x/login', 'http://x/list?t=abc']);
    expect(rows[0].extracted).toEqual({ token: 'abc' });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.ok)).toBe(true);
  });

  it('请求自身变量做底，上游提取值覆盖同名键', async () => {
    const seen: RunnerPayload[] = [];
    const list = [
      mkReq({ id: 'a', url: 'http://x/{{id}}', variables: 'id=1', extract: [{ name: 'id', path: 'id' }] }),
      mkReq({ id: 'b', url: 'http://x/{{id}}', variables: 'id=9' }),
    ];
    await runRequests(list, {
      send: async (p) => { seen.push(p); return seen.length === 1 ? res('{"id":42}') : res('{}'); },
    });
    expect(seen[0].url).toBe('http://x/1');
    expect(seen[1].url).toBe('http://x/42');
  });

  it('断言不通过时这一步 ok=false', async () => {
    const rows = await runRequests([mkReq({ assertions: { rules: [{ path: 'code', op: 'eq', value: '0' }] } as any })], {
      send: async () => res('{"code":1}'),
    });
    expect(rows[0].ok).toBe(false);
  });

  it('请求失败时记录 error，不抛错', async () => {
    const rows = await runRequests([mkReq()], {
      send: async () => ({ success: false, error: 'ECONNREFUSED' }),
    });
    expect(rows[0].ok).toBe(false);
    expect(rows[0].error).toBe('ECONNREFUSED');
  });

  it('提取规则取不到值时记进 extractMissing', async () => {
    const rows = await runRequests([mkReq({ extract: [{ name: 'token', path: 'data.token' }] })], {
      send: async () => res('{"data":{}}'),
    });
    expect(rows[0].extractMissing).toEqual(['token']);
    expect(rows[0].extracted).toBeUndefined();
  });

  it('响应不是 JSON 时不抛错，只是没有提取结果', async () => {
    const rows = await runRequests([mkReq({ extract: [{ name: 'x', path: 'a' }] })], {
      send: async () => res('<html>500</html>'),
    });
    expect(rows[0].ok).toBe(true);
    expect(rows[0].extracted).toBeUndefined();
    expect(rows[0].extractMissing).toEqual(['x']);
  });

  it('shouldStop 为 true 时中断剩余请求', async () => {
    const send = vi.fn(async () => res('{}'));
    const rows = await runRequests([mkReq({ id: 'a' }), mkReq({ id: 'b' }), mkReq({ id: 'c' })], {
      send,
      shouldStop: () => send.mock.calls.length >= 2,
    });
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('每跑完一条回调一次，便于界面流式渲染', async () => {
    const shots: number[] = [];
    await runRequests([mkReq({ id: 'a' }), mkReq({ id: 'b' })], {
      send: async () => res('{}'),
      onStep: (rows) => shots.push(rows.length),
    });
    expect(shots).toEqual([1, 2]);
  });
});
