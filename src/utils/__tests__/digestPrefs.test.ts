import { describe, it, expect, beforeEach } from 'vitest';
import {
  DIGEST_PREFS_KEY, keepKnownProductIds, loadDigestPrefs, presetRange,
  resolveRange, sanitizePrefs, saveDigestPrefs, type DigestPrefs,
} from '../digestPrefs';

/** node 环境没有 localStorage，这里用最小实现顶上（测的是读写协议，不是浏览器实现） */
const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  } as Storage;
});

const NOW = new Date(2026, 10, 9); // 2026-11-09 周一

const full = (over: Partial<DigestPrefs> = {}): DigestPrefs => ({
  range: 'thisWeek',
  from: '',
  to: '',
  productIds: { instA: ['1', '2'] },
  openedBy: { instA: ['张三'] },
  opts: {
    layout: 'byProject',
    includeWeekly: true,
    mergeModulesOver: 12,
    includeSummary: true,
    includeNextWeek: true,
  },
  ...over,
});

describe('时间口径', () => {
  it('本周 = 周一至今', () => {
    expect(presetRange('thisWeek', NOW)).toEqual({ from: '2026-11-09', to: '2026-11-09' });
  });

  it('上周 = 上个周一至周日', () => {
    expect(presetRange('lastWeek', NOW)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('周一至周五：还没到周五就截到今天，避免写进未来日期', () => {
    expect(presetRange('thisWeekToFriday', NOW)).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    const fri = new Date(2026, 10, 13); // 周五
    expect(presetRange('thisWeekToFriday', fri)).toEqual({ from: '2026-11-09', to: '2026-11-13' });
  });

  it('没存过配置时默认本周', () => {
    expect(resolveRange(null, NOW)).toEqual({ from: '2026-11-09', to: '2026-11-09' });
  });

  it('预设口径每次都按「当天」重算，不会把上周的日期带过来', () => {
    // 存的是 lastWeek，一周后再打开应当是「那时」的上周，而不是固定的 11-02
    const later = new Date(2026, 10, 16);
    expect(resolveRange(full({ range: 'lastWeek' }), later))
      .toEqual({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('手改过的日期（custom）原样沿用', () => {
    const p = full({ range: 'custom', from: '2026-10-01', to: '2026-10-15' });
    expect(resolveRange(p, NOW)).toEqual({ from: '2026-10-01', to: '2026-10-15' });
  });

  it('custom 的日期坏了就退回本周，而不是拿空区间去请求', () => {
    expect(resolveRange(full({ range: 'custom', from: '', to: '' }), NOW))
      .toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(resolveRange(full({ range: 'custom', from: '2026-11-20', to: '2026-11-01' }), NOW))
      .toEqual({ from: '2026-11-09', to: '2026-11-09' });
  });
});

describe('读回来的东西要能信', () => {
  it('null / 空串 / 数组都当没存过', () => {
    expect(sanitizePrefs(null)).toBeNull();
    expect(sanitizePrefs('')).toBeNull();
    expect(sanitizePrefs([])).toBeNull();
  });

  it('空对象补成默认值，不会抛', () => {
    const p = sanitizePrefs({});
    expect(p).not.toBeNull();
    expect(p!.range).toBe('thisWeek');
    expect(p!.productIds).toEqual({});
    expect(p!.opts.layout).toBe('byProject');
  });

  it('非法 layout / 越界阈值被修正', () => {
    const p = sanitizePrefs({ opts: { layout: 'bySomething', mergeModulesOver: 9999 } })!;
    expect(p.opts.layout).toBe('byProject');
    expect(p.opts.mergeModulesOver).toBe(200);
  });

  it('productIds 里的非数组值被丢掉，空数组合并被去掉', () => {
    const p = sanitizePrefs({ productIds: { a: ['1', '1', '2'], b: 'x', c: [], d: null } })!;
    expect(p.productIds).toEqual({ a: ['1', '2'] });
  });

  it('手改过的坏日期不被当成 custom 使用', () => {
    const p = sanitizePrefs({ range: 'custom', from: '11/09/2026', to: '2026-11-09' })!;
    expect(p.from).toBe('');
    expect(resolveRange(p, NOW)).toEqual({ from: '2026-11-09', to: '2026-11-09' });
  });
});

describe('存取往返', () => {
  it('存进去再读出来，字段不丢', () => {
    saveDigestPrefs(full({ range: 'custom', from: '2026-11-02', to: '2026-11-06' }));
    const back = loadDigestPrefs()!;
    expect(back.range).toBe('custom');
    expect(back.productIds).toEqual({ instA: ['1', '2'] });
    expect(back.openedBy).toEqual({ instA: ['张三'] });
    expect(back.opts.includeNextWeek).toBe(true);
  });

  it('存储里的内容被手改成垃圾时不抛异常，当没存过', () => {
    mem.set(DIGEST_PREFS_KEY, '{这不是 json');
    expect(loadDigestPrefs()).toBeNull();
  });

  it('写失败（配额满）不抛，记不住选择不该拦住生成', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
    } as unknown as Storage;
    expect(() => saveDigestPrefs(full())).not.toThrow();
  });
});

describe('项目 id 的失效处理', () => {
  it('项目被删掉后，旧 id 不再参与请求', () => {
    const keep = keepKnownProductIds({ instA: ['1', '2', '99'] }, { instA: [{ id: 1 }, { id: '2' }] });
    expect(keep).toEqual({ instA: ['1', '2'] });
  });

  it('这家公司这次没拉到项目列表时不预勾（避免空请求）', () => {
    expect(keepKnownProductIds({ instB: ['1'] }, {})).toEqual({});
  });

  it('全都被删光时该公司整体消失，不留空数组', () => {
    expect(keepKnownProductIds({ instA: ['99'] }, { instA: [{ id: 1 }] })).toEqual({});
  });
});
