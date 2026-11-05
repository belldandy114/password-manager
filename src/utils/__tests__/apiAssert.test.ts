import { describe, it, expect } from 'vitest';
import { runAssertions, migrateAssertions, toAssertions, makeRule, hasAssertions } from '../apiAssert';
import type { ApiResponseData } from '../../types';

const resp = (over: Partial<ApiResponseData> = {}): ApiResponseData => ({
  status: 200,
  timeMs: 120,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ code: 0, data: { id: 7, list: [1, 2], ok: true } }),
  ...over,
} as ApiResponseData);

describe('apiAssert.runAssertions', () => {
  it('状态码支持精确匹配与 2xx 通配', () => {
    const ok = runAssertions({ rules: [
      { id: '1', op: 'status', target: '', value: '200' },
      { id: '2', op: 'status', target: '', value: '2xx' },
    ] }, resp());
    expect(ok.map(r => r.ok)).toEqual([true, true]);

    const bad = runAssertions({ rules: [{ id: '3', op: 'status', target: '', value: '201' }] }, resp());
    expect(bad[0].ok).toBe(false);
    expect(bad[0].detail).toContain('200');
  });

  it('耗时断言按「不超过」判定', () => {
    expect(runAssertions({ rules: [{ id: '1', op: 'time', target: '', value: '500' }] }, resp())[0].ok).toBe(true);
    expect(runAssertions({ rules: [{ id: '1', op: 'time', target: '', value: '100' }] }, resp())[0].ok).toBe(false);
    // 断言值不是数字时直接判失败，而不是静默通过
    expect(runAssertions({ rules: [{ id: '1', op: 'time', target: '', value: 'abc' }] }, resp())[0].ok).toBe(false);
  });

  it('JSON 路径：留空值只要求路径存在', () => {
    const ok = runAssertions({ rules: [{ id: '1', op: 'json', target: 'data.id', value: '' }] }, resp());
    expect(ok[0].ok).toBe(true);
    // 不存在的路径要判失败（曾把 undefined 当成存在的历史 bug）
    const missing = runAssertions({ rules: [{ id: '2', op: 'json', target: 'data.nope', value: '' }] }, resp());
    expect(missing[0].ok).toBe(false);
    const arrIdx = runAssertions({ rules: [{ id: '3', op: 'json', target: 'data.list[1]', value: '2' }] }, resp());
    expect(arrIdx[0].ok).toBe(true);
  });

  it('JSON 路径带值 → 按包含匹配', () => {
    const r = runAssertions({ rules: [{ id: '1', op: 'json', target: 'data.id', value: '7' }] }, resp());
    expect(r[0].ok).toBe(true);
    const bad = runAssertions({ rules: [{ id: '2', op: 'json', target: 'data.id', value: '8' }] }, resp());
    expect(bad[0].ok).toBe(false);
  });

  it('正文 / 响应头断言不区分大小写的地方别搞错', () => {
    const body = runAssertions({ rules: [{ id: '1', op: 'body', target: '', value: '"code"' }] }, resp());
    expect(body[0].ok).toBe(true);
    const headerHit = runAssertions({ rules: [{ id: '2', op: 'header', target: 'Content-Type', value: 'json' }] }, resp());
    expect(headerHit[0].ok).toBe(true);
    const headerMiss = runAssertions({ rules: [{ id: '3', op: 'header', target: 'x-trace', value: '' }] }, resp());
    expect(headerMiss[0].ok).toBe(false);
  });

  it('取反断言：命中即失败', () => {
    const r = runAssertions({ rules: [{ id: '1', op: 'status', target: '', value: '200', negate: true }] }, resp());
    expect(r[0].ok).toBe(false);
    const r2 = runAssertions({ rules: [{ id: '2', op: 'status', target: '', value: '500', negate: true }] }, resp());
    expect(r2[0].ok).toBe(true);
  });

  it('jsonValid：非 JSON 响应判失败', () => {
    const good = runAssertions({ rules: [{ id: '1', op: 'jsonValid', target: '', value: '' }] }, resp());
    expect(good[0].ok).toBe(true);
    const bad = runAssertions({ rules: [{ id: '2', op: 'jsonValid', target: '', value: '' }] }, resp({ body: '<html>' }));
    expect(bad[0].ok).toBe(false);
  });
});

describe('apiAssert.migrateAssertions', () => {
  it('把旧的槽位字段迁成规则行，全部留空则没有规则', () => {
    const empty = migrateAssertions({});
    expect(empty).toEqual([]);
    expect(migrateAssertions(undefined)).toEqual([]);

    const legacy = migrateAssertions({
      status: '200', maxMs: '800', jsonPath: 'data.id', jsonValue: '7', contains: 'ok',
    });
    const ops = legacy.map(r => r.op);
    expect(ops).toEqual(['status', 'time', 'json', 'body']);
    expect(legacy[2].target).toBe('data.id');
    expect(legacy[2].value).toBe('7');
  });

  it('新格式（rules）原样保留，不被旧槽位覆盖', () => {
    const rules = [makeRule('body')];
    rules[0].value = 'hello';
    const got = migrateAssertions({ rules, status: '404' });
    expect(got).toHaveLength(1);
    expect(got[0].op).toBe('body');
    expect(got[0].value).toBe('hello');
  });

  it('toAssertions / hasAssertions 保持契约', () => {
    expect(toAssertions([])).toEqual({ rules: [] });
    expect(hasAssertions({})).toBe(false);
    expect(hasAssertions({ rules: [makeRule()] })).toBe(true);
    expect(hasAssertions({ status: '200' })).toBe(true);
  });
});