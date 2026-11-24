import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { inspectJmx, isJmxName, buildJmxTemplate, buildJmxFromPlan, validateCsvTable, ALLOWED_HTTP_METHODS } = require('../../../electron/jmx-script');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.5">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="登录压测">
      <stringProp name="TestPlan.comments">先登录再下单</stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="用户">
        <stringProp name="ThreadGroup.num_threads">200</stringProp>
        <stringProp name="ThreadGroup.ramp_time">10</stringProp>
      </ThreadGroup>
      <hashTree>
        <LoopController guiclass="LoopControlPanel" testclass="LoopController" testname="循环">
          <stringProp name="LoopController.loops">30</stringProp>
        </LoopController>
        <hashTree>
          <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="账号">
            <stringProp name="filename">D:/cases/users.csv</stringProp>
          </CSVDataSet>
          <hashTree/>
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>`;

describe('inspectJmx', () => {
  it('识别测试计划名、线程组、默认线程/循环', () => {
    const r = inspectJmx(SAMPLE);
    expect(r.ok).toBe(true);
    expect(r.testName).toBe('登录压测');
    expect(r.threadGroups).toBe(1);
    expect(r.threadsDefault).toBe(200);
    expect(r.loopsDefault).toBe(30);
  });

  it('抽出外部数据文件和 __P 参数', () => {
    const xml = SAMPLE.replace(
      '<hashTree/>',
      '<hashTree><stringProp name="ThreadGroup.num_threads">${__P(threads,10)}</stringProp></hashTree>',
    );
    const r = inspectJmx(xml);
    expect(r.dataFiles).toContain('D:/cases/users.csv');
    expect(r.params).toEqual([{ name: 'threads', value: '10' }]);
  });

  it('__P 参数去重，缺省值可空', () => {
    const xml = `<jmeterTestPlan><hashTree>
      <stringProp>${'${'}__P(a,1)}</stringProp>
      <stringProp>${'${'}__P(b)}</stringProp>
      <stringProp>${'${'}__P(a,2)}</stringProp>
    </hashTree></jmeterTestPlan>`;
    const r = inspectJmx(xml);
    expect(r.params.map((p: { name: string }) => p.name)).toEqual(['a', 'b']);
    expect(r.params[0].value).toBe('1');
    expect(r.params[1].value).toBe('');
  });

  it('注释里的线程组不算数', () => {
    const xml = SAMPLE.replace('<hashTree>', '<!-- <ThreadGroup testname="假"> -->\n<hashTree>');
    expect(inspectJmx(xml).threadGroups).toBe(1);
  });

  it('setUp / 并发线程组也计入', () => {
    const xml = '<jmeterTestPlan><hashTree><SetupThreadGroup/><ConcurrencyThreadGroup/><ThreadGroup/></hashTree></jmeterTestPlan>';
    expect(inspectJmx(xml).threadGroups).toBe(3);
  });

  it('不是 JMX 或空内容给出错误', () => {
    expect(inspectJmx('').ok).toBe(false);
    expect(inspectJmx('<html></html>').error).toContain('jmeterTestPlan');
  });

  it('isJmxName 大小写不敏感', () => {
    expect(isJmxName('a.JMX')).toBe(true);
    expect(isJmxName('a.jmx.bak')).toBe(false);
    expect(isJmxName('a.csv')).toBe(false);
  });
});


describe('buildJmxTemplate', () => {
  it('生成的脚本能被 inspectJmx 解析回来（1 个线程组 + threads/loops 参数）', () => {
    const r = buildJmxTemplate({ name: '登录', url: 'https://example.com:8443/api/login?x=1', method: 'POST', threads: 200, loops: 5 });
    expect(r.ok).toBe(true);
    expect(r.domain).toBe('example.com');
    expect(r.path).toBe('/api/login?x=1');
    const info = inspectJmx(r.xml);
    expect(info.ok).toBe(true);
    expect(info.threadGroups).toBe(1);
    expect(info.threadsDefault).toBe(200);
    expect(info.loopsDefault).toBe(5);
    expect(info.params.map((p: { name: string }) => p.name).sort()).toEqual(['loops', 'threads']);
  });

  it('POST / GET 落到 sampler 上', () => {
    expect(buildJmxTemplate({ url: 'http://a.com', method: 'POST' }).xml).toContain('<stringProp name="HTTPSampler.method">POST</stringProp>');
    expect(buildJmxTemplate({ url: 'http://a.com' }).xml).toContain('<stringProp name="HTTPSampler.method">GET</stringProp>');
  });

  it('没写协议时按 http 处理，缺地址报错', () => {
    expect(buildJmxTemplate({ url: 'a.com:8080/x' }).xml).toContain('<stringProp name="HTTPSampler.protocol">http</stringProp>');
    expect(buildJmxTemplate({ url: '' }).ok).toBe(false);
    expect(buildJmxTemplate({ url: 'http://' }).ok).toBe(false);
  });

  it('脚本名里的 & < > 会被转义，不会破坏 XML', () => {
    const r = buildJmxTemplate({ name: '登录&注册<压测>', url: 'http://a.com' });
    expect(r.xml).toContain('登录&amp;注册&lt;压测&gt;');
    expect(inspectJmx(r.xml).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2.1 接口集合 → 批量 .jmx（契约 C-75〜C-77）
// 结构判据一律数 XML 里的节点数，不看「有没有生成」这种虚的
// ---------------------------------------------------------------------------

const IF = (name: string, url: string, method = 'GET') => ({ name, url, method });

describe('buildJmxFromPlan 结构：N 个接口合成一个线程组', () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    name: '批量压测',
    interfaces: [
      IF('登录', 'https://example.com/api/login', 'POST'),
      IF('列表', 'https://example.com/api/list'),
      IF('详情', 'https://example.com/api/detail?id=1'),
    ],
    threads: 2,
    loops: 3,
    ...over,
  });

  it('3 个接口 → 3 个 HTTPSamplerProxy，但只有 1 个线程组', () => {
    const r = buildJmxFromPlan(plan());
    expect(r.ok).toBe(true);
    expect((r.xml.match(/<HTTPSamplerProxy\b/g) || []).length).toBe(3);
    expect((r.xml.match(/<ThreadGroup\b/g) || []).length).toBe(1);
    const info = inspectJmx(r.xml);
    expect(info.ok).toBe(true);
    expect(info.threadGroups).toBe(1);
    expect(r.interfaces).toBe(3);
  });

  it('2 个接口与 5 个接口的节点数都对得上（不是写死 3 个）', () => {
    const two = buildJmxFromPlan(plan({ interfaces: [IF('a', 'http://h/a'), IF('b', 'http://h/b')] }));
    expect((two.xml.match(/<HTTPSamplerProxy\b/g) || []).length).toBe(2);
    const five = buildJmxFromPlan(plan({
      interfaces: [1, 2, 3, 4, 5].map((i) => IF(`i${i}`, `http://h/p${i}`)),
    }));
    expect((five.xml.match(/<HTTPSamplerProxy\b/g) || []).length).toBe(5);
    expect(inspectJmx(five.xml).threadGroups).toBe(1);
  });

  it('线程/循环写成 ${__P(threads,..)} / ${__P(loops,..)}，inspectJmx 能读回默认值', () => {
    const r = buildJmxFromPlan(plan({ threads: 2, loops: 3 }));
    expect(r.xml).toContain('${__P(threads,2)}');
    expect(r.xml).toContain('${__P(loops,3)}');
    const info = inspectJmx(r.xml);
    expect(info.threadsDefault).toBe(2);
    expect(info.loopsDefault).toBe(3);
    expect(info.params.map((p: { name: string }) => p.name).sort()).toEqual(['loops', 'threads']);
  });

  it('每个 sampler 都带响应码断言（默认 200），个数与接口数一致', () => {
    const r = buildJmxFromPlan(plan());
    expect((r.xml.match(/<ResponseAssertion\b/g) || []).length).toBe(3);
    expect((r.xml.match(/Assertion\.response_code/g) || []).length).toBe(3);
    expect((r.xml.match(/>200</g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('assertCode 可覆盖默认 200', () => {
    const r = buildJmxFromPlan(plan({ assertCode: '201' }));
    expect(r.xml).toContain('>201<');
    expect(r.xml).not.toContain('>200<');
  });

  it('接口名与方法带特殊字符时按 XML 转义，脚本仍然合法', () => {
    const r = buildJmxFromPlan(plan({
      interfaces: [IF('登录&注册<压测>', 'http://h/a?x=1&y=2')],
    }));
    expect(r.xml).toContain('登录&amp;注册&lt;压测&gt;');
    expect(inspectJmx(r.xml).ok).toBe(true);
  });

  it('URL 的 query 保留在 path 里；POST 落到 sampler 上', () => {
    const r = buildJmxFromPlan(plan({ interfaces: [IF('详情', 'https://example.com/api/detail?id=1&x=2', 'POST')] }));
    expect(r.xml).toContain('<stringProp name="HTTPSampler.path">/api/detail?id=1&amp;x=2</stringProp>');
    expect(r.xml).toContain('<stringProp name="HTTPSampler.method">POST</stringProp>');
    expect(r.xml).toContain('<stringProp name="HTTPSampler.domain">example.com</stringProp>');
  });

  it('headers 落到 HeaderManager（每行一个 k: v）', () => {
    const r = buildJmxFromPlan(plan({
      interfaces: [{ ...IF('登录', 'http://h/a'), headers: 'Content-Type: application/json\nX-Token: abc' }],
    }));
    expect(r.xml).toContain('<stringProp name="Header.name">Content-Type</stringProp>');
    expect(r.xml).toContain('<stringProp name="Header.value">application/json</stringProp>');
    expect(r.xml).toContain('<stringProp name="Header.name">X-Token</stringProp>');
  });
});

describe('buildJmxFromPlan CSV 与思考时间', () => {
  const base = {
    name: 'CSV 压测',
    interfaces: [IF('登录', 'http://h/login')],
    threads: 2,
    loops: 3,
  };

  it('无 CSV 模式：不产出 CSVDataSet，dataFiles 为空', () => {
    const r = buildJmxFromPlan(base);
    expect(r.xml).not.toContain('<CSVDataSet');
    expect(r.csvFileName).toBe('');
    expect(inspectJmx(r.xml).dataFiles).toEqual([]);
  });

  it('CSV 模式：JMX 内只写文件名，绝不写盘符/绝对路径（C-75 第 1 条）', () => {
    const r = buildJmxFromPlan({
      ...base,
      csvFile: 'D:\\cases\\账号.csv',
      csvVars: [{ name: 'user', column: '账号' }, { name: 'pass', column: '密码' }],
    });
    expect(r.csvFileName).toBe('账号.csv');
    expect(r.xml).toContain('<stringProp name="filename">账号.csv</stringProp>');
    expect(r.xml).not.toContain('D:\\cases');
    expect(r.xml).not.toContain('..');
    expect(inspectJmx(r.xml).dataFiles).toEqual(['账号.csv']);
  });

  it('CSV 变量名按声明顺序逗号拼接，ignoreFirstLine=true 与 recycle=true', () => {
    const r = buildJmxFromPlan({
      ...base, csvFile: '/tmp/u.csv', csvVars: [{ name: 'user', column: '账号' }, { name: 'pass', column: '密码' }],
    });
    expect(r.xml).toContain('<stringProp name="variableNames">user,pass</stringProp>');
    expect(r.xml).toContain('<boolProp name="ignoreFirstLine">true</boolProp>');
    expect(r.xml).toContain('<boolProp name="recycle">true</boolProp>');
  });

  it('思考时间 0 不产出 ConstantTimer；500 产出且延迟写对', () => {
    expect(buildJmxFromPlan({ ...base, thinkTimeMs: 0 }).xml).not.toContain('<ConstantTimer');
    const r = buildJmxFromPlan({ ...base, thinkTimeMs: 500 });
    expect(r.xml).toContain('<ConstantTimer');
    expect(r.xml).toContain('<stringProp name="ConstantTimer.delay">500</stringProp>');
  });
});

describe('buildJmxFromPlan 参数校验（失败不抛异常，只给 reason）', () => {
  const ok = { name: 'x', interfaces: [IF('a', 'http://h/a')], threads: 1, loops: 1 };

  it('接口为空 / 超 50 个', () => {
    expect(buildJmxFromPlan({ ...ok, interfaces: [] })).toMatchObject({ ok: false, reason: 'no-interface' });
    expect(buildJmxFromPlan({ ...ok, interfaces: Array.from({ length: 51 }, (_, i) => IF(`i${i}`, 'http://h/a')) }))
      .toMatchObject({ ok: false, reason: 'too-many-interfaces' });
    // 正好 50 个是允许的（上限含等于）
    expect(buildJmxFromPlan({ ...ok, interfaces: Array.from({ length: 50 }, (_, i) => IF(`i${i}`, 'http://h/a')) }).ok).toBe(true);
  });

  it('线程/循环越界（1–100000）', () => {
    expect(buildJmxFromPlan({ ...ok, threads: 0 })).toMatchObject({ ok: false, reason: 'threads-out-of-range' });
    expect(buildJmxFromPlan({ ...ok, loops: 100001 })).toMatchObject({ ok: false, reason: 'threads-out-of-range' });
    expect(buildJmxFromPlan({ ...ok, threads: 100000, loops: 1 }).ok).toBe(true);
  });

  it('思考时间越界（0–60000）', () => {
    expect(buildJmxFromPlan({ ...ok, thinkTimeMs: -1 })).toMatchObject({ ok: false, reason: 'think-time-out-of-range' });
    expect(buildJmxFromPlan({ ...ok, thinkTimeMs: 60001 })).toMatchObject({ ok: false, reason: 'think-time-out-of-range' });
    expect(buildJmxFromPlan({ ...ok, thinkTimeMs: 60000 }).ok).toBe(true);
  });

  it('地址不可解析 / CSV 变量名非法 / 断言码非 3 位', () => {
    expect(buildJmxFromPlan({ ...ok, interfaces: [IF('坏', 'http://')] })).toMatchObject({ ok: false, reason: 'bad-url' });
    expect(buildJmxFromPlan({ ...ok, csvFile: 'a.csv', csvVars: [{ name: '1bad', column: 'c' }] }))
      .toMatchObject({ ok: false, reason: 'bad-csv-var' });
    expect(buildJmxFromPlan({ ...ok, assertCode: 'ab' })).toMatchObject({ ok: false, reason: 'bad-assert-code' });
    expect(buildJmxFromPlan({ ...ok, assertCode: '2000' })).toMatchObject({ ok: false, reason: 'bad-assert-code' });
  });
});

describe('validateCsvTable：落盘前用 parseCsv 的结果做列校验', () => {
  const table = [['账号', '密码'], ['u1', 'p1'], ['u2', 'p2']];

  it('列全在且数据行 ≥ 1 → ok', () => {
    expect(validateCsvTable(table, [{ name: 'user', column: '账号' }, { name: 'pass', column: '密码' }]))
      .toEqual({ ok: true, rows: 2 });
  });

  it('缺列 → missing-column，并把列名带出来', () => {
    expect(validateCsvTable(table, [{ name: 'user', column: '账号' }, { name: 'x', column: '不存在' }]))
      .toMatchObject({ ok: false, reason: 'missing-column', detail: '不存在' });
  });

  it('只有表头没有数据行 → no-rows；空表 → no-rows', () => {
    expect(validateCsvTable([['账号']], [{ name: 'user', column: '账号' }])).toMatchObject({ ok: false, reason: 'no-rows' });
    expect(validateCsvTable([], [{ name: 'user', column: '账号' }])).toMatchObject({ ok: false, reason: 'no-rows' });
  });
});

/**
 * 安全评审 **S-02**：`HTTPSampler.method` 来自 OpenAPI spec（**外部材料**），
 * 原样拼进 XML 就能塞 `<JSR223Sampler>` → JMeter 跑一次即执行任意代码，
 * 而生成物还会进仓库、交接给别人。所以这里必须白名单 + 转义，不按「本机单用户」减轻。
 */
describe('S-02：method 白名单（防 JSR223 注入）', () => {
  const mk = (method: string) => ({ threads: 10, loops: 1, interfaces: [{ name: '登录', url: 'https://example.com/api/login', method }] });
  const INJECT = 'GET</stringProp><JSR223Sampler guiclass="TestBeanGUI" testclass="JSR223Sampler"><stringProp name="script">Runtime.getRuntime().exec("calc")</stringProp></JSR223Sampler><stringProp name="x">';

  it('注入串被整体拒绝（reason=bad-method），输出里不含 JSR223Sampler', () => {
    const r = buildJmxFromPlan(mk(INJECT));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-method');
    expect(String(r.detail)).toContain('JSR223Sampler');
    // 拒绝就是拒绝：**没有生成任何 XML**（xml 字段不存在），注入片段不可能进到脚本里
    expect(r.xml).toBeUndefined();
    // detail 只是给报错文案用的回显，且有长度上限——它不会流向 XML
    expect(String(r.detail).length).toBeLessThanOrEqual(120);
    expect(String(r.detail)).toContain('JSR223Sampler');
  });

  it('白名单 7 个方法都能生成，且 XML 里是原值（GET/POST/… 不需要转义也不许变形）', () => {
    expect(Array.from(ALLOWED_HTTP_METHODS)).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
    for (const m of Array.from(ALLOWED_HTTP_METHODS) as string[]) {
      const r = buildJmxFromPlan({ threads: 10, loops: 1, interfaces: [{ url: 'https://example.com/api/x', method: m }] });
      expect(r.ok).toBe(true);
      expect(r.xml).toContain(`<stringProp name="HTTPSampler.method">${m}</stringProp>`);
    }
  });

  it('小写/带空白按归一放行（get → GET），缺省仍是 GET', () => {
    const lower = buildJmxFromPlan({ threads: 10, loops: 1, interfaces: [{ url: 'https://example.com/api/x', method: ' get ' }] });
    expect(lower.ok).toBe(true);
    expect(lower.xml).toContain('<stringProp name="HTTPSampler.method">GET</stringProp>');
    const none = buildJmxFromPlan({ threads: 10, loops: 1, interfaces: [{ url: 'https://example.com/api/x' }] });
    expect(none.ok).toBe(true);
    expect(none.xml).toContain('<stringProp name="HTTPSampler.method">GET</stringProp>');
  });

  it('多接口里只要有一个方法非法 → 整体拒绝（绝不生成半份脚本）', () => {
    const r = buildJmxFromPlan({
      threads: 10,
      loops: 1,
      interfaces: [
        { url: 'https://example.com/api/ok', method: 'POST' },
        { url: 'https://example.com/api/bad', method: 'TRACE' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-method');
    expect(r.detail).toBe('TRACE');
  });

  it('大小写混淆与非 ASCII 变体同样拒绝（LOOKALIKE 不许绕过）', () => {
    for (const bad of ['GEТ', 'ＧＥＴ', 'GET ', 'GET\n', 'TRACE', 'CONNECT']) {
      const r = buildJmxFromPlan({ threads: 10, loops: 1, interfaces: [{ url: 'https://example.com/a', method: bad }] });
      if (bad === 'GET ' || bad === 'GET\n') {
        // 首尾空白归一后是合法 GET —— 这是允许的（trim 后才比较，不会带入 XML）
        expect(r.ok).toBe(true);
        expect(r.xml).toContain('<stringProp name="HTTPSampler.method">GET</stringProp>');
      } else {
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('bad-method');
      }
    }
  });
});