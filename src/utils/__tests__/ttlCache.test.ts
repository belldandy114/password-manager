import { describe, it, expect, vi } from 'vitest';
// @ts-ignore - 纯 JS 模块，无 .d.ts
import { createTtlCache } from '../../../electron/ttl-cache.js';

/** 手动时钟：TTL 相关的断言不能靠真实时间（跑得快的机器会偶发失败） */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    tick: (ms: number) => { t += ms; },
  };
}

describe('ttl-cache 短时缓存', () => {
  it('TTL 内重复调用只跑一次 fn', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });
    const fn = vi.fn(async () => 'v1');

    const a = await c.wrap('k', fn);
    clock.tick(30_000);
    const b = await c.wrap('k', fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ value: 'v1', cached: false, shared: false });
    expect(b).toMatchObject({ value: 'v1', cached: true });
    expect(b.age).toBe(30_000);
  });

  it('过期（>= ttl）后重新请求', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });
    let n = 0;
    const fn = async () => `v${++n}`;

    expect((await c.wrap('k', fn)).value).toBe('v1');
    clock.tick(59_999);
    expect((await c.wrap('k', fn)).cached).toBe(true);
    clock.tick(1); // 刚好 60 秒 = 边界，算过期
    const r = await c.wrap('k', fn);
    expect(r.cached).toBe(false);
    expect(r.value).toBe('v2');
  });

  it('fresh=true 绕过缓存但仍会写入新值', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });
    let n = 0;
    const fn = async () => `v${++n}`;

    await c.wrap('k', fn);
    clock.tick(1_000);
    const r = await c.wrap('k', fn, { fresh: true });
    expect(r).toMatchObject({ value: 'v2', cached: false });
    // 刷新完，后面的普通调用应该用刷新后的值
    expect((await c.wrap('k', fn)).value).toBe('v2');
  });

  it('★并发同名调用合并成一次（single-flight）：1.24.14 日志里两次相隔 1.3 秒都全量扫描', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });
    let calls = 0;
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((res) => { release = res; });
    const slow = () => { calls++; return gate; };

    const p1 = c.wrap('k', slow);
    const p2 = c.wrap('k', slow);
    const p3 = c.wrap('k', slow, { fresh: true }); // 刷新也不能绕过「正在跑」的那次
    release('done');

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
    expect(r1).toMatchObject({ value: 'done', shared: false });
    expect(r2).toMatchObject({ value: 'done', shared: true });
    expect(r3).toMatchObject({ value: 'done', shared: true });
  });

  it('fn 抛错不写缓存，且在跑状态被清掉（可以重试）', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });
    let n = 0;
    const flaky = async () => { n++; if (n === 1) throw new Error('boom'); return 'ok'; };

    await expect(c.wrap('k', flaky)).rejects.toThrow('boom');
    expect(c.isRunning('k')).toBe(false);
    expect(c.peek('k')).toBeUndefined();
    // 失败没被缓存，立刻重试能成功
    expect((await c.wrap('k', flaky)).value).toBe('ok');
  });

  it('不同 key 互不影响（换地址/换账号不会串数据）', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });

    await c.wrap('a|x', async () => 'ax');
    await c.wrap('b|x', async () => 'bx');
    expect(c.peek('a|x')).toBe('ax');
    expect(c.peek('b|x')).toBe('bx');
  });

  it('超过 max 时淘汰最旧的 key', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, max: 2, now: clock.now });

    await c.wrap('k1', async () => 1);
    await c.wrap('k2', async () => 2);
    await c.wrap('k3', async () => 3);

    expect(c.size()).toBe(2);
    expect(c.peek('k1')).toBeUndefined();
    expect(c.peek('k2')).toBe(2);
    expect(c.peek('k3')).toBe(3);
  });

  it('delete / clear 能强制下次重拉', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });
    const fn = vi.fn(async () => 'v');

    await c.wrap('k', fn);
    c.delete('k');
    await c.wrap('k', fn);
    expect(fn).toHaveBeenCalledTimes(2);

    c.clear();
    expect(c.size()).toBe(0);
    expect(c.isRunning('k')).toBe(false);
  });

  it('ttl 省略 = 不按时间过期（只靠 max/delete）', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ now: clock.now });
    await c.wrap('k', async () => 'v');
    clock.tick(365 * 24 * 3600_000);
    expect(c.peek('k')).toBe('v');
  });

  it('stats 能反映命中/未命中/合并次数（日志里要能看到缓存真的生效了）', async () => {
    const clock = fakeClock();
    const c = createTtlCache({ ttl: 60_000, now: clock.now });

    await c.wrap('k', async () => 'v');
    await c.wrap('k', async () => 'v');
    expect(c.stats()).toMatchObject({ hit: 1, miss: 1, coalesced: 0 });

    const p1 = c.wrap('k2', async () => { await Promise.resolve(); return 1; });
    const p2 = c.wrap('k2', async () => 2);
    await Promise.all([p1, p2]);
    expect(c.stats().coalesced).toBe(1);
  });
});
