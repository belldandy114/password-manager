import { describe, it, expect } from 'vitest';

import {
  normalizePath,
  normalizeMethod,
  isStaticAsset,
  buildCoverage,
  assertCoverageConsistency,
  coveragePercent,
  trimCoverageItems,
  UNKNOWN_REASON_CODES,
  UNKNOWN_REASON_TEXT,
  type CoverageEndpoint,
  type CoverageRef,
} from '../coverage';

/**
 * 覆盖矩阵纯函数单测（契约 §1.4 / [C-30]–[C-33]）。
 *
 * 重点不是"跑通"，而是**归一化不能漏**：漏一种写法，覆盖率就假低一格；
 * 反过来，归一化太宽（把 `/api/user` 和 `/api/user/1` 当成不同接口）也一样。
 * 所以下面每类写法各一条用例，并且都给「应当 covered」的期望。
 */

const ep = (url: string, method = 'GET', extra: Partial<CoverageEndpoint> = {}): CoverageEndpoint => ({ url, method, ...extra });
const ref = (path: string, method = 'GET', extra: Partial<CoverageRef> = {}): CoverageRef => ({ path, method, file: 'src/Api.java', line: 10, ...extra });

describe('normalizePath：三种占位统一成 {id}', () => {
  it('{id} / :id / {{id}} 归一后完全相同', () => {
    const a = normalizePath('/api/user/{id}');
    const b = normalizePath('/api/user/:id');
    const c = normalizePath('/api/user/{{id}}');
    expect(a.path).toBe('/api/user/{id}');
    expect(b.path).toBe(a.path);
    expect(c.path).toBe(a.path);
    expect(a.ok && b.ok && c.ok).toBe(true);
  });

  it('多个占位、混合写法也能归一', () => {
    expect(normalizePath('/api/{{tenant}}/user/{userId}/order/:orderId').path)
      .toBe('/api/{id}/user/{id}/order/{id}');
  });

  it('String.format 的 %s / %d 也当占位', () => {
    expect(normalizePath('/api/user/%s').path).toBe('/api/user/{id}');
    expect(normalizePath('/api/user/%d').path).toBe('/api/user/{id}');
  });
});

describe('normalizePath：具体值收敛（否则代码里写死 id 就永远比不上）', () => {
  it('数字段 → {id}', () => {
    expect(normalizePath('/api/user/12345').path).toBe('/api/user/{id}');
  });

  it('UUID 段 → {id}', () => {
    expect(normalizePath('/api/user/3f2504e0-4f89-11d3-9a0c-0305e82c3301').path).toBe('/api/user/{id}');
  });

  it('长 hex 段 → {id}；短十六进制词不当 id', () => {
    expect(normalizePath('/api/token/deadbeefdeadbeef01').path).toBe('/api/token/{id}');
    expect(normalizePath('/api/feed').path).toBe('/api/feed');
  });
});

describe('normalizePath：尾斜杠 / 大小写 / 查询串 / 重复斜杠', () => {
  it('去尾斜杠，但根路径保留 /', () => {
    expect(normalizePath('/api/user/').path).toBe('/api/user');
    expect(normalizePath('/api/user///').path).toBe('/api/user');
    expect(normalizePath('/').path).toBe('/');
  });

  it('忽略大小写', () => {
    expect(normalizePath('/API/User').path).toBe('/api/user');
  });

  it('剥查询串与 hash', () => {
    expect(normalizePath('/api/user/1?page=2&size=10').path).toBe('/api/user/{id}');
    expect(normalizePath('/api/user/1#top').path).toBe('/api/user/{id}');
  });

  it('折叠重复斜杠', () => {
    expect(normalizePath('//api//user//1').path).toBe('/api/user/{id}');
  });

  it('相对路径补前导斜杠（两种写法能对上）', () => {
    expect(normalizePath('api/user/1').path).toBe('/api/user/{id}');
  });
});

describe('normalizePath：baseURL 前缀不一致', () => {
  it('接口是绝对 URL、代码是相对路径 → 同一路径', () => {
    const withBase = normalizePath('https://api.example.com/v1/user/1', { baseUrl: 'https://api.example.com/v1' });
    const plain = normalizePath('/user/1', { baseUrl: 'https://api.example.com/v1' });
    expect(withBase.path).toBe('/user/{id}');
    expect(plain.path).toBe(withBase.path);
  });

  it('没给 baseUrl 时绝对 URL 只留 path（域名不参与比对）', () => {
    expect(normalizePath('https://other.example.com/api/user/1').path).toBe('/api/user/{id}');
  });

  it('baseUrl 只给 path 段时也剥（/v1）', () => {
    expect(normalizePath('/v1/user/2', { baseUrl: '/v1' }).path).toBe('/user/{id}');
  });

  it('前缀真的不同 → 归一结果不同（不硬凑，靠告警解释）', () => {
    const a = normalizePath('/api/v1/user/1', { baseUrl: '/v1' });
    const b = normalizePath('/v1/user/{id}', { baseUrl: '/v1' });
    expect(a.path).not.toBe(b.path);
  });
});

describe('normalizePath：动态拼接与无效输入', () => {
  it('模板串插值 → ok:false + dynamic-concat，并留静态前缀', () => {
    const r = normalizePath('/api/user/${id}/detail');
    expect(r.ok).toBe(false);
    expect(r.reasonCode).toBe('dynamic-concat');
    expect(r.path).toBe('/api/user');
  });

  it('字符串加号拼接 → dynamic-concat', () => {
    const r = normalizePath('/api/user/' + 'x'); // 这里的 + 是 JS 拼接，产物是常量串
    expect(r.ok).toBe(true); // 编译期就拼好了，属于静态
    const r2 = normalizePath('/api/user/ + id');
    expect(r2.ok).toBe(false);
    expect(r2.reasonCode).toBe('dynamic-concat');
  });

  it('空路径 → invalid-path', () => {
    expect(normalizePath('').reasonCode).toBe('invalid-path');
    expect(normalizePath('   ').reasonCode).toBe('invalid-path');
  });
});

describe('normalizeMethod / isStaticAsset', () => {
  it('method 大写；缺失或 ANY 一律 ANY', () => {
    expect(normalizeMethod('get')).toBe('GET');
    expect(normalizeMethod(undefined)).toBe('ANY');
    expect(normalizeMethod('*')).toBe('ANY');
  });

  it('静态资源：扩展名与目录前缀都认', () => {
    expect(isStaticAsset('/static/app.js')).toBe(true);
    expect(isStaticAsset('/assets/logo.png?v=1')).toBe(true);
    expect(isStaticAsset('/favicon.ico')).toBe(true);
    expect(isStaticAsset('/api/user/1')).toBe(false);
    expect(isStaticAsset('/public/health')).toBe(true);
  });
});

describe('buildCoverage：三态判定', () => {
  it('路径命中且方法一致 → covered，并带 file:line', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/user/{id}', 'GET')],
      refs: [ref('/api/user/1', 'get', { file: 'src/UserApi.java', line: 42 })],
    });
    expect(r.items[0].state).toBe('covered');
    expect(r.items[0].ref).toBe('src/UserApi.java:42');
    expect(r.summary).toEqual({ total: 1, covered: 1, missing: 0, undetermined: 0 });
    expect(r.consistent).toBe(true);
  });

  it('方法 ANY 与具体方法互相命中（.url("/x") 这类拿不到方法）', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/pets', 'POST')],
      refs: [ref('/api/pets', 'ANY')],
    });
    expect(r.items[0].state).toBe('covered');
  });

  it('路径命中但方法不一致 → unknown(method-mismatch)，不是 covered 也不是 missing', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/user/{id}', 'POST')],
      refs: [ref('/api/user/7', 'GET')],
    });
    expect(r.items[0].state).toBe('unknown');
    expect(r.items[0].reasonCode).toBe('method-mismatch');
    expect(r.items[0].reason).toContain('GET');
    expect(r.items[0].reason).toContain('POST');
  });

  it('完全没有引用 → missing', () => {
    const r = buildCoverage({ endpoints: [ep('/api/none')], refs: [] });
    expect(r.items[0].state).toBe('missing');
    expect(r.items[0].reason).toBeUndefined();
  });

  it('只在注释里出现 → unknown(comment-only)，不算已覆盖', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/user/{id}')],
      refs: [ref('/api/user/1', 'GET', { snippet: '// TODO 调 /api/user/1 补一下' })],
    });
    expect(r.items[0].state).toBe('unknown');
    expect(r.items[0].reasonCode).toBe('comment-only');
  });

  it('变量拼装但静态前缀能对上 → unknown(dynamic-concat)', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/order/{id}/detail')],
      refs: [ref('/api/order/${orderId}/detail', 'ANY')],
    });
    expect(r.items[0].state).toBe('unknown');
    expect(r.items[0].reasonCode).toBe('dynamic-concat');
    expect(r.items[0].reason).toBe(UNKNOWN_REASON_TEXT['dynamic-concat']);
  });

  it('扫描器只抽到字面量前缀（"/api/order/" + id）→ unknown(dynamic-concat)，并点出前缀', () => {
    // 真实 scan:run 的取数规则只抽引号里的内容，所以拼接的引用往往只剩前半段
    const r = buildCoverage({
      endpoints: [ep('/api/order/{id}/detail')],
      refs: [ref('/api/order/', 'ANY')],
    });
    expect(r.items[0].state).toBe('unknown');
    expect(r.items[0].reasonCode).toBe('dynamic-concat');
    expect(r.items[0].reason).toContain('/api/order');
  });

  it('前缀是另一个接口时不算动态拼接（不把 missing 抬成 unknown）', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/user', 'POST'), ep('/api/user/{id}', 'GET')],
      refs: [ref('/api/user', 'POST')],
    });
    const detail = r.items.find((i) => i.path === '/api/user/{id}')!;
    expect(detail.state).toBe('missing');
    expect(r.items.find((i) => i.path === '/api/user')!.state).toBe('covered');
  });

  it('接口自己路径无效 → unknown(invalid-path) 并给理由', () => {
    const r = buildCoverage({ endpoints: [ep(''), ep('   ')], refs: [] });
    expect(r.items.every((i) => i.state === 'unknown' && i.reasonCode === 'invalid-path')).toBe(true);
    expect(r.items[0].reason).toBeTruthy();
  });
});

describe('buildCoverage：unknown 原因必须可枚举、不许一个 unknown 打包全部', () => {
  it('四种 unknown 场景拿到四种不同原因码，且都有可读文案', () => {
    const r = buildCoverage({
      endpoints: [
        ep('/api/a/{id}', 'POST'),          // method-mismatch
        ep('/api/b/{id}'),                  // comment-only
        ep('/api/c/{id}/x'),                // dynamic-concat
        ep(''),                             // invalid-path
      ],
      refs: [
        ref('/api/a/1', 'GET'),
        ref('/api/b/1', 'GET', { snippet: '# 老的 /api/b/1' }),
        ref('/api/c/${id}/x', 'ANY'),
      ],
    });
    const codes = r.items.map((i) => i.reasonCode);
    expect(new Set(codes).size).toBe(4);
    for (const c of codes) expect(UNKNOWN_REASON_CODES).toContain(c as string);
    for (const i of r.items) {
      expect(i.reason && i.reason.length).toBeGreaterThan(0);
      // 文案以原因码对应的模板打头（method-mismatch 会再带一段「代码里是 X，接口是 Y」的细节）
      expect(i.reason?.startsWith(UNKNOWN_REASON_TEXT[i.reasonCode as keyof typeof UNKNOWN_REASON_TEXT])).toBe(true);
    }
  });

  it('原因码清单稳定（页面图例/统计按它遍历）', () => {
    expect(UNKNOWN_REASON_CODES).toEqual([
      'dynamic-concat', 'unrecognized-call', 'comment-only', 'method-mismatch', 'invalid-path',
    ]);
  });
});

describe('buildCoverage：静态资源路径', () => {
  it('静态资源接口被排除在矩阵外，三态合计仍等于 total', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/user/{id}'), ep('/static/app.js'), ep('/favicon.ico')],
      refs: [ref('/api/user/1', 'GET')],
    });
    expect(r.skippedStatic).toBe(2);
    expect(r.summary.total).toBe(1);
    expect(r.summary.covered + r.summary.missing + r.summary.undetermined).toBe(r.summary.total);
    expect(r.warnings.join('\n')).toContain('静态资源');
  });

  it('代码里的静态资源引用不参与匹配（不会把接口判成 covered）', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/logo.png')],   // 接口集合里误放了一张图
      refs: [ref('/api/logo.png', 'GET')],
    });
    expect(r.skippedStatic).toBe(1);
    expect(r.summary.total).toBe(0);
  });
});

describe('buildCoverage：合计等于接口总数（[C-31]）', () => {
  const endpoints = [
    ep('/api/user/{id}', 'GET'),
    ep('/api/user', 'POST'),
    ep('/api/pets', 'GET'),
    ep('/api/pets/{id}', 'DELETE'),
    ep('/api/orders/{id}', 'GET'),
  ];
  const refs = [
    ref('/api/user/1', 'GET'),
    ref('/api/user', 'POST'),
    ref('/api/pets', 'ANY'),
    ref('/api/pets/xxx', 'PUT', { snippet: '// 注释里的' }),
  ];

  it('多接口混合场景：三态之和严格等于 total', () => {
    const r = buildCoverage({ endpoints, refs });
    const { covered, missing, undetermined, total } = r.summary;
    expect(total).toBe(5);
    expect(covered).toBe(3);
    expect(missing + undetermined + covered).toBe(total);
    expect(r.consistent).toBe(true);
    expect(assertCoverageConsistency(r.summary)).toBeNull();
  });

  it('空接口集合 → total=0、百分比 0（不出现 NaN）', () => {
    const r = buildCoverage({ endpoints: [], refs: [ref('/api/x')] });
    expect(r.summary).toEqual({ total: 0, covered: 0, missing: 0, undetermined: 0 });
    expect(coveragePercent(r.summary)).toBe(0);
    expect(r.warnings.join('\n')).toContain('没对上任一接口');
  });

  it('assertCoverageConsistency 能抓住自相矛盾的统计', () => {
    expect(assertCoverageConsistency({ total: 5, covered: 2, missing: 2, undetermined: 0 }))
      .toContain('自洽性校验失败');
  });

  it('coveragePercent 只是辅助值（界面必须同时给分子/分母）', () => {
    expect(coveragePercent({ total: 5, covered: 3, missing: 2, undetermined: 0 })).toBe(60);
  });
});

describe('buildCoverage：前缀不一致要解释，而不是静默', () => {
  it('代码里带了不同的前缀 → 接口算 missing，同时给一条告警说明原因', () => {
    const r = buildCoverage({
      endpoints: [ep('/api/user/{id}')],
      refs: [ref('/other/v2/api/user/1', 'GET')],
    });
    expect(r.items[0].state).toBe('missing');
    expect(r.warnings.join('\n')).toContain('没对上任一接口');
  });

  it('给了 baseUrl 就能对上（前缀差异被消除）', () => {
    const r = buildCoverage({
      endpoints: [ep('https://api.example.com/v1/user/{id}')],
      refs: [ref('/user/1', 'GET')],
      baseUrl: 'https://api.example.com/v1',
    });
    expect(r.items[0].state).toBe('covered');
  });
});

describe('trimCoverageItems：≤5000 且优先保留 covered/unknown（[C-33]）', () => {
  it('未超限原样返回', () => {
    const items = [{ method: 'GET', path: '/a', state: 'missing' as const }];
    expect(trimCoverageItems(items, 10)).toEqual({ items, truncated: false });
  });

  it('超限时 missing 先丢，covered/unknown 全留', () => {
    const covered = Array.from({ length: 3 }, (_, i) => ({ method: 'GET', path: `/c${i}`, state: 'covered' as const }));
    const unknown = Array.from({ length: 2 }, (_, i) => ({ method: 'GET', path: `/u${i}`, state: 'unknown' as const }));
    const missing = Array.from({ length: 10 }, (_, i) => ({ method: 'GET', path: `/m${i}`, state: 'missing' as const }));
    const r = trimCoverageItems([...covered, ...missing, ...unknown], 6);
    expect(r.truncated).toBe(true);
    expect(r.items).toHaveLength(6);
    expect(r.items.filter((i) => i.state === 'covered')).toHaveLength(3);
    expect(r.items.filter((i) => i.state === 'unknown')).toHaveLength(2);
    expect(r.items.filter((i) => i.state === 'missing')).toHaveLength(1);
  });
});