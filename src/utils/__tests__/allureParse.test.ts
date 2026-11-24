import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseAllure, normalizeMessage, TRUNCATED_REASONS } from '../../../electron/allure-parse.js';

/**
 * 模块 5.1 Allure 结果解析（契约 C-38 flaky / C-39 聚类 / C-61〜C-64 结构）。
 *
 * **口径以 qa 在 t9 造的夹具为准**（`src/utils/__tests__/__fixtures__/allure/`，3 轮 28 条 result）：
 *   - run1：`ApiClientTest` 同一轮内 fail→pass（runs=2）→ **算 flaky**（本批唯一合法正例）
 *   - run2：`DiscountTest` 重试两次**全失败**（runs=2 pass=0 fail=2）→ **不算**（有重试 ≠ flaky）
 *   - run3：`SchemaTest` 只跑 1 次就失败（runs=1）→ **永不判 flaky**
 *   - run1/2/3：`ImportTest` 全 skipped、`CallbackTest` 全 broken → 都不算
 * 这些期望值不是我自己拟的，是夹具 README 钉死的。
 *
 * 注意两个**易混**字段（C-63 明文）：
 *   - `skippedFiles`：文件数（没参与统计的文件，含坏 JSON）
 *   - `skipped`：用例状态数（status='skipped'）
 * 二者不许合并、不许互相顶替。
 */

const FIXTURE_ROOT = join(__dirname, '__fixtures__', 'allure');

/** 读一轮夹具里的全部文件（name + text），模拟 ipc 层交给纯函数的入参 */
function loadRun(run: string): { name: string; text: string }[] {
  const dir = join(FIXTURE_ROOT, run);
  return readdirSync(dir).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

const run1 = loadRun('run1');
const run2 = loadRun('run2');
const run3 = loadRun('run3');
const all = [...run1, ...run2, ...run3];

const resultsOf = (files: { name: string; text: string }[]) => files.filter((f) => f.name.endsWith('-result.json'));
type Case = { name: string; fullName: string; status: string; durationMs: number; retries: number; runs: number; pass: number; fail: number; flaky: boolean; message?: string };
const caseOf = (r: { cases: Case[] }, cls: string): Case => {
  const c = r.cases.find((x) => x.fullName.includes(cls));
  if (!c) throw new Error(`夹具里找不到 ${cls}`);
  return c;
};

describe('夹具规模自检（防止夹具被人改动后期望值悄悄失效）', () => {
  it('3 轮共 28 条 result（run1=8 / run2=10 / run3=10）', () => {
    expect(resultsOf(run1)).toHaveLength(8);
    expect(resultsOf(run2)).toHaveLength(10);
    expect(resultsOf(run3)).toHaveLength(10);
    expect(resultsOf(all)).toHaveLength(28);
  });
});

describe('run1：唯一合法 flaky 正例（同一轮内 fail→pass）', () => {
  const r = parseAllure(run1);

  it('计数：total=8 / passed=5 / failed=1 / broken=1 / skipped=1', () => {
    expect(r.ok).toBe(true);
    expect({ total: r.total, passed: r.passed, failed: r.failed, broken: r.broken, skipped: r.skipped })
      .toEqual({ total: 8, passed: 5, failed: 1, broken: 1, skipped: 1 });
  });

  it('flaky 恰 1 条，且是 ApiClientTest（runs=2 pass=1 fail=1）', () => {
    expect(r.flaky).toHaveLength(1);
    expect(r.flaky[0]).toMatchObject({ runs: 2, pass: 1, fail: 1 });
    expect(r.flaky[0].fullName).toContain('ApiClientTest');
    // 分母能显示成 fail/runs
    expect(`${r.flaky[0].fail}/${r.flaky[0].runs}`).toBe('1/2');
  });

  it('retries = 1（同一用例多出来的那条 result）', () => {
    expect(r.retries).toBe(1);
    expect(caseOf(r, 'ApiClientTest').retries).toBe(1);
  });

  it('反例：ImportTest 全 skipped、CallbackTest 全 broken 都不算 flaky', () => {
    expect(caseOf(r, 'ImportTest').flaky).toBe(false);
    expect(caseOf(r, 'CallbackTest').flaky).toBe(false);
    expect(caseOf(r, 'CallbackTest').pass).toBe(0); // 一次都没通过过
  });

  it('environment.properties 被解析成对象', () => {
    expect(r.environment['base.url']).toBe('https://api.example.com');
    expect(r.environment['test.env']).toBe('fixture-local');
  });

  it('skippedFiles=0（本轮所有文件都被识别），skipped=1 只数用例状态', () => {
    expect(r.skippedFiles).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('cases 按状态降序（failed→broken→skipped→passed）、同状态按 fullName 升序（C-64）', () => {
    const order = { failed: 0, broken: 1, skipped: 2, passed: 3 } as Record<string, number>;
    for (let i = 1; i < r.cases.length; i += 1) {
      const a = r.cases[i - 1];
      const b = r.cases[i];
      expect(order[a.status] < order[b.status] || (order[a.status] === order[b.status] && a.fullName <= b.fullName)).toBe(true);
    }
  });
});

describe('run2：重试两次全失败 ≠ flaky', () => {
  const r = parseAllure(run2);

  it('计数：total=10，flaky=0', () => {
    expect(r.total).toBe(10);
    expect(r.flaky).toHaveLength(0);
  });

  it('DiscountTest runs=2 pass=0 fail=2，flaky=false（分母 2/2）', () => {
    const d = caseOf(r, 'DiscountTest');
    expect(d).toMatchObject({ runs: 2, pass: 0, fail: 2, flaky: false });
    expect(`${d.fail}/${d.runs}`).toBe('2/2');
  });

  it('environment.xml 被解析成对象（不引 XML 解析器，只取 key/value）', () => {
    expect(r.environment['base.url']).toBe('https://api.example.com');
    expect(r.environment['allure.report.name']).toContain('run2');
  });
});

describe('run3：runs=1 永不判 flaky', () => {
  const r = parseAllure(run3);

  it('计数：total=10，flaky=0', () => {
    expect(r.total).toBe(10);
    expect(r.flaky).toHaveLength(0);
  });

  it('SchemaTest 只跑 1 次就失败 → runs=1 且 flaky=false', () => {
    expect(caseOf(r, 'SchemaTest')).toMatchObject({ runs: 1, fail: 1, flaky: false });
  });
});

describe('聚类（C-39 v12）：key 只表达模式，诊断信息交给 sample / samples', () => {
  const merged = parseAllure(all);
  /** 造一条 result 文件（聚类用例只需要 statusDetails.message） */
  const mk = (uuid: string, status: string, message: string) => ({
    name: `${uuid}-result.json`,
    text: JSON.stringify({ uuid, name: uuid, fullName: `com.example.qa.api.${uuid}`, status, statusDetails: { message }, start: 1, stop: 2 }),
  });

  it('合并 3 轮 28 条：Connection refused 仍是 count=3（改口径不改数量）', () => {
    expect(merged.total).toBe(28);
    const c = merged.clusters.find((x: { key: string }) => /connection refused/i.test(x.key));
    expect(c).toBeTruthy();
    expect(c?.count).toBe(3);
  });

  it('key 抹掉业务数值；sample / samples 里逐字保留原文（15.00 找得到）', () => {
    const c = merged.clusters.find((x: { key: string }) => x.key.includes('expected discount # but was #'));
    expect(c).toBeTruthy();
    expect(c?.count).toBe(2);
    expect(c?.sample).toContain('15.00'); // 诊断信息在 sample 里，不在 key 里
    expect(c?.samples.length).toBe(1); // 夹具里两条原文完全一样
    expect(c?.samples[0]).toContain('expected discount 15.00');
    expect(c?.key).not.toContain('15.00');
  });

  it('成对①【必须同 key】：不同业务值的同一类错误合成一簇（15.00 / 20.00 → count=2）', () => {
    const r = parseAllure([
      mk('a1', 'failed', 'java.lang.AssertionError: expected discount 15.00 but was 10'),
      mk('a2', 'failed', 'java.lang.AssertionError: expected discount 20.00 but was 12'),
    ]);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].count).toBe(2);
    expect(r.clusters[0].key).toContain('expected discount # but was #');
    // samples 既证明「同一类不同值」，也能反向发现「抹过头」
    expect(r.clusters[0].samples).toHaveLength(2);
    expect(r.clusters[0].samples.join(' | ')).toContain('15.00');
    expect(r.clusters[0].samples.join(' | ')).toContain('20.00');
  });

  it('成对②【必须不同 key】：8080（支付）与 9090（风控）不能被合并', () => {
    const msgs = [
      'java.net.ConnectException: 连接 api.pay.example.com:8080 失败',
      'java.net.ConnectException: 连接 api.pay.example.com:9090 失败',
    ];
    expect(normalizeMessage(msgs[0])).not.toBe(normalizeMessage(msgs[1]));
    expect(normalizeMessage(msgs[0])).toBe(msgs[0]); // 主机名 + 端口逐字保留
    expect(normalizeMessage(msgs[1])).toBe(msgs[1]);
    const r = parseAllure([
      mk('p1', 'broken', msgs[0]), mk('p2', 'broken', msgs[0]),
      mk('q1', 'broken', msgs[1]), mk('q2', 'broken', msgs[1]),
    ]);
    expect(r.clusters).toHaveLength(2); // 各成一簇，绝不合并
    expect(r.clusters.map((c: { count: number }) => c.count).sort()).toEqual([2, 2]);
  });

  it('成对③【必须不同 key】：401 Unauthorized 与 500 Internal Server Error', () => {
    expect(normalizeMessage('401 Unauthorized')).not.toBe(normalizeMessage('500 Internal Server Error'));
    expect(normalizeMessage('401 Unauthorized')).toBe('401 Unauthorized'); // 状态码保留
    const r = parseAllure([
      mk('s1', 'failed', 'GET /api/x 返回 401 Unauthorized'),
      mk('s2', 'failed', 'GET /api/x 返回 401 Unauthorized'),
      mk('t1', 'failed', 'GET /api/x 返回 500 Internal Server Error'),
      mk('t2', 'failed', 'GET /api/x 返回 500 Internal Server Error'),
    ]);
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters.some((c: { key: string }) => c.key.includes('401'))).toBe(true);
    expect(r.clusters.some((c: { key: string }) => c.key.includes('500'))).toBe(true);
  });

  it('单条出现的错误不进 clusters（count<2）', () => {
    expect(merged.clusters.some((x: { key: string }) => /missing required property/i.test(x.key))).toBe(false);
  });

  it('sample 取出现次数最多的原文；samples 最多 3 条且都是不同原文', () => {
    const r = parseAllure([
      mk('m1', 'failed', 'timeout after 100 ms'),
      mk('m2', 'failed', 'timeout after 3000 ms'),
      mk('m3', 'failed', 'timeout after 3000 ms'),
      mk('m4', 'failed', 'timeout after 200 ms'),
      mk('m5', 'failed', 'timeout after 400 ms'),
    ]);
    expect(r.clusters).toHaveLength(1);
    const c = r.clusters[0];
    expect(c.count).toBe(5);
    expect(c.key).toBe('timeout after # ms');
    expect(c.sample).toBe('timeout after 3000 ms'); // 出现 2 次，最多
    expect(c.samples).toHaveLength(3); // 4 种原文 → 只留 3 条
    expect(new Set(c.samples).size).toBe(c.samples.length); // 不重复
    expect(c.samples[0]).toBe('timeout after 3000 ms'); // 次数多的排前面（确定性，C-10）
    for (const s of c.samples) expect(s.length).toBeLessThanOrEqual(500);
  });

  it('clusters 按 count 降序、同 count 按 key 升序（确定性排序，C-10）', () => {
    const list = merged.clusters as { key: string; count: number; sample: string; samples: string[] }[];
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      expect(prev.count > cur.count || (prev.count === cur.count && prev.key <= cur.key)).toBe(true);
    }
    for (const c of list) {
      expect(typeof c.sample).toBe('string');
      expect(Array.isArray(c.samples)).toBe(true);
      expect(c.key.length).toBeLessThanOrEqual(200);
      expect(c.sample.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('normalizeMessage（C-39 v12）：抹掉所有数字，只留三类语义记号', () => {
  it('耗时：数字抹掉、单位保留（维持句式可比）', () => {
    expect(normalizeMessage('Timeout after 3000 ms')).toBe('Timeout after # ms');
    expect(normalizeMessage('took 312ms')).toBe('took # ms');
  });

  it('行号/序号：抹成 #，但文件扩展名逐字保留', () => {
    expect(normalizeMessage('Error at line 42 of report.csv')).toBe('Error at line # of report.csv');
    expect(normalizeMessage('第 3 个用例第 12 行失败')).toBe('第 # 个用例第 # 行失败');
  });

  it('UUID / 长哈希：整段抹成 #', () => {
    expect(normalizeMessage('requestId=9f8e1234-5678-9abc-def0-1234567890ab failed')).toBe('requestId=# failed');
    expect(normalizeMessage('hash d41d8cd98f00b204e9800998ecf8427e mismatch')).toBe('hash # mismatch');
  });

  it('端口（反例）：主机名与端口必须逐字保留', () => {
    expect(normalizeMessage('连接 api.pay.example.com:8080 失败')).toBe('连接 api.pay.example.com:8080 失败');
    expect(normalizeMessage('http://api.pay.example.com:8080/v1/charge 500')).toBe('http://api.pay.example.com:8080/v#/charge 500');
  });

  it('业务数值（正例）：金额/期望值一律抹掉（同一根因不能被拆成多个簇）', () => {
    expect(normalizeMessage('expected discount 15.00 but was 10')).toBe('expected discount # but was #');
    expect(normalizeMessage('expected 200.50 CNY got 199.99 CNY')).toBe('expected # CNY got # CNY');
  });

  it('状态码（反例）：401 / 500 这类 HTTP 状态码逐字保留', () => {
    expect(normalizeMessage('401 Unauthorized')).toBe('401 Unauthorized');
    expect(normalizeMessage('server returned 503 Service Unavailable')).toBe('server returned 503 Service Unavailable');
    expect(normalizeMessage('status=502')).toBe('status=502');
  });

  it('混合场景：堆栈丢掉、耗时/UUID/路径里的数字抹掉、主机端口与状态码保留', () => {
    const msg = [
      'POST https://api.pay.example.com:8443/v2/orders/12345 failed after 312ms (id=9f8e1234-5678-9abc-def0-1234567890ab) status 503 Service Unavailable',
      '\tat com.example.qa.A.run(A.java:42)',
      '\t... 23 more',
    ].join('\n');
    expect(normalizeMessage(msg))
      .toBe('POST https://api.pay.example.com:8443/v#/orders/# failed after # ms (id=#) status 503 Service Unavailable');
  });

  it('空消息 / 纯空白 → 空串（不产生空 key 的簇）', () => {
    expect(normalizeMessage('')).toBe('');
    expect(normalizeMessage('   \n\t ')).toBe('');
    expect(normalizeMessage(null as unknown as string)).toBe('');
  });
});

describe('truncatedReason（C-09 v12）：5 个取值 + 多值同时触顶的优先级', () => {
  it('枚举正好 5 个，且优先级顺序是 timeout > files > file-size > cases > flaky', () => {
    expect(TRUNCATED_REASONS).toEqual(['timeout', 'files', 'file-size', 'cases', 'flaky']);
  });

  it('同时触发 file-size 与 cases → 只报一个，按优先级报 file-size', () => {
    const big = { name: 'huge-result.json', text: 'x'.repeat(2 * 1024 * 1024 + 10) };
    const r = parseAllure([...resultsOf(all), big], { maxCases: 1 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe('file-size'); // 优先于 cases
  });

  it('同时触发 files 与 file-size → 报 files（files 优先级更高）', () => {
    const big = { name: 'huge-result.json', text: 'x'.repeat(2 * 1024 * 1024 + 10) };
    const r = parseAllure([...resultsOf(all), big], { maxFiles: 3 });
    expect(r.truncatedReason).toBe('files');
  });
});

describe('skippedFiles（C-63）：与 skipped（用例状态）是两个概念', () => {
  it('非 result/container/environment 的文件计入 skippedFiles，不进 skipped', () => {
    const r = parseAllure([
      ...resultsOf(run1),
      { name: 'screenshot.png', text: '' },
      { name: 'attachment-1.txt', text: '' },
      { name: 'index.html', text: '<html></html>' },
    ]);
    expect(r.skippedFiles).toBe(3);
    expect(r.skipped).toBe(1); // 仍是 ImportTest 那一条用例状态
  });

  it('ipc 层没传进来的文件数也能加上（opts.skippedFiles）', () => {
    expect(parseAllure(resultsOf(run1), { skippedFiles: 7 }).skippedFiles).toBe(7);
  });
});

describe('畸形输入：不抛异常，也不把「解析失败」静默变成 0 条', () => {
  it('非法 JSON：计入 skippedFiles 并继续解析其余（单文件坏不整体失败，C-63）', () => {
    const r = parseAllure([...resultsOf(run1).slice(0, 3), { name: 'broken-result.json', text: '{not json' }]);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(3);
    expect(r.skippedFiles).toBe(1);
  });

  it('缺 fullName/status 的 result 同样计入 skippedFiles，且不产生空名用例', () => {
    const r = parseAllure([
      ...resultsOf(run1).slice(0, 2),
      { name: 'no-name-result.json', text: JSON.stringify({ uuid: 'x', status: 'passed' }) },
      { name: 'no-status-result.json', text: JSON.stringify({ uuid: 'y', fullName: 'a.B.c' }) },
    ]);
    expect(r.total).toBe(2);
    expect(r.skippedFiles).toBe(2);
    for (const c of r.cases) expect(String(c.fullName).length).toBeGreaterThan(0);
  });

  it('空目录 → ok:false + 明确错误（不是静默 0 条）', () => {
    const r = parseAllure([]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到');
    expect(r.total).toBe(0);
  });

  it('只有 container、没有 result → 明确报错（不是 0 条用例的成功）', () => {
    const containers = run1.filter((f) => f.name.endsWith('-container.json'));
    const r = parseAllure(containers);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到');
    expect(r.total).toBe(0);
  });
});

describe('上限与截断（C-62）', () => {
  it('result 条数超上限 → truncated + truncatedReason', () => {
    const r = parseAllure(all, { maxFiles: 5 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe('files');
    expect(r.total).toBeLessThan(28);
  });

  it('cases 超上限 → truncated（truncatedReason=cases）', () => {
    const r = parseAllure(all, { maxCases: 3 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe('cases');
    expect(r.cases.length).toBeLessThanOrEqual(3);
  });

  it('clusters 最多 50 条', () => {
    expect(parseAllure(all).clusters.length).toBeLessThanOrEqual(50);
  });

  it('单文件超 2 MB 直接跳过并计入 truncated（file-size）', () => {
    const r = parseAllure([...resultsOf(run1), { name: 'huge-result.json', text: 'x'.repeat(2 * 1024 * 1024 + 10) }]);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe('file-size');
  });

  it('name ≤300 / message ≤500（C-64 截断，防止把整段堆栈塞进 UI）', () => {
    const longMsg = 'E'.repeat(900);
    const r = parseAllure([{
      name: 'long-result.json',
      text: JSON.stringify({
        uuid: 'z', name: 'n'.repeat(400), fullName: 'a.B.' + 'c'.repeat(400), status: 'failed',
        statusDetails: { message: longMsg }, start: 1, stop: 2,
      }),
    }]);
    const c = r.cases[0];
    expect(c.name.length).toBeLessThanOrEqual(300);
    expect((c.message || '').length).toBeLessThanOrEqual(500);
  });
});