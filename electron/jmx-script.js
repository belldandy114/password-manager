/**
 * jmx-script.js —— JMX 脚本的静态检查（纯函数，无 fs / electron 依赖）
 *
 * 压力测试「脚本库」用它给出脚本摘要：线程组数量、默认线程/循环、可覆盖参数
 * （`${__P(name,default)}`）、引用的数据文件，以及 XML 结构是否像一份 JMeter 脚本。
 * 只做静态判断，不保证脚本能跑通（真正的校验只有 JMeter 自己知道）。
 */

const JMX_EXTS = new Set(['.jmx']);

/** 去掉 XML 注释，避免注释里的 `<ThreadGroup` 被算进去 */
function stripComments(xml) {
  return String(xml || '').replace(/<!--[\s\S]*?-->/g, '');
}

function attrOf(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : '';
}

/**
 * @param {string} xml
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   testName: string,
 *   threadGroups: number,
 *   threadsDefault: number|null,
 *   loopsDefault: number|null,
 *   params: {name: string, value: string}[],
 *   dataFiles: string[],
 * }}
 */
function inspectJmx(xml) {
  const src = stripComments(xml);
  const empty = {
    ok: false,
    error: '',
    testName: '',
    threadGroups: 0,
    threadsDefault: null,
    loopsDefault: null,
    params: [],
    dataFiles: [],
  };
  if (!src.trim()) return { ...empty, error: '脚本是空的' };
  if (!/<jmeterTestPlan\b/.test(src)) {
    return { ...empty, error: '不像 JMeter 脚本：找不到 <jmeterTestPlan> 根节点' };
  }

  // 测试计划名
  const planTag = /<TestPlan\b[^>]*>/.exec(src);
  const testName = planTag ? attrOf(planTag[0], 'testname') : '';

  // 线程组：普通 / setUp / tearDown / 插件版并发线程组都算
  const threadGroups = (src.match(/<(?:Setup|Post|Concurrency)?ThreadGroup\b/g) || []).length;

  const num = (name) => {
    const m = new RegExp(`<stringProp name="${name}">([^<]*)</stringProp>`).exec(src);
    if (!m) return null;
    const raw = String(m[1]).trim();
    const n = Number(raw);
    if (Number.isFinite(n) && raw !== '') return n;
    // 写成 ${__P(threads,200)} 时，取括号里的默认值当参考值
    const p = /__P\(\s*[^,)]+\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(raw);
    return p ? Number(p[1]) : null;
  };

  // `${__P(name,default)}`：脚本里声明可被 -J 覆盖的参数
  const params = [];
  const seen = new Set();
  const re = /\$\{__P\(([^,)}]+)(?:,([^)}]*))?\)\}/g;
  let hit;
  while ((hit = re.exec(src))) {
    const name = String(hit[1]).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    params.push({ name, value: String(hit[2] ?? '').trim() });
  }

  // 引用的外部数据文件（CSV Data Set Config 的 filename）
  const dataFiles = [];
  const fileRe = /<stringProp name="filename">([^<]*)<\/stringProp>/g;
  while ((hit = fileRe.exec(src))) {
    const f = String(hit[1]).trim();
    if (f && !dataFiles.includes(f)) dataFiles.push(f);
  }

  return {
    ok: true,
    error: '',
    testName: testName || '',
    threadGroups,
    threadsDefault: num('ThreadGroup.num_threads'),
    loopsDefault: num('LoopController.loops'),
    params,
    dataFiles,
  };
}

/** 文件名是否是 JMX（大小写不敏感） */
function isJmxName(name) {
  const s = String(name || '').toLowerCase();
  const i = s.lastIndexOf('.');
  return i >= 0 && JMX_EXTS.has(s.slice(i));
}

/** XML 文本转义（脚本名可能带 & < >） */
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 生成一个最小可跑的 HTTP 压测脚本。
 * 线程/循环写成 `${__P(threads,默认)}`，这样界面上临时覆盖才会生效。
 *
 * @param {{ name?: string, url: string, method?: string, threads?: number, loops?: number }} opts
 * @returns {{ ok: boolean, error?: string, xml?: string, domain?: string, path?: string }}
 */
function buildJmxTemplate(opts) {
  const url = String((opts && opts.url) || '').trim();
  if (!url) return { ok: false, error: '请填写请求地址' };
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
  } catch {
    return { ok: false, error: '地址格式不对，例如 https://example.com/api/login' };
  }
  if (!u.hostname) return { ok: false, error: '地址里没有主机名' };
  const method = String((opts && opts.method) || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const threads = Math.max(1, Math.min(Number(opts && opts.threads) || 10, 100000));
  const loops = Math.max(1, Math.min(Number(opts && opts.loops) || 1, 100000));
  const name = xmlEscape((opts && opts.name) || `${u.hostname}${u.pathname}`);

  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const pathWithQuery = `${u.pathname || '/'}${u.search || ''}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${name}" enabled="true">
      <stringProp name="TestPlan.comments">由测试中台脚本库生成：改地址/线程后可直接运行</stringProp>
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
      <stringProp name="TestPlan.user_define_classpath"></stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="线程组" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">\${__P(loops,${loops})}</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">\${__P(threads,${threads})}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">false</boolProp>
        <stringProp name="ThreadGroup.duration"></stringProp>
        <stringProp name="ThreadGroup.delay"></stringProp>
      </ThreadGroup>
      <hashTree>
        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xmlEscape(`${method} ${u.pathname || '/'}`)}" enabled="true">
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="用户参数" enabled="true">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
          <stringProp name="HTTPSampler.domain">${xmlEscape(u.hostname)}</stringProp>
          <stringProp name="HTTPSampler.port">${xmlEscape(port)}</stringProp>
          <stringProp name="HTTPSampler.protocol">${u.protocol === 'https:' ? 'https' : 'http'}</stringProp>
          <stringProp name="HTTPSampler.path">${xmlEscape(pathWithQuery)}</stringProp>
          <stringProp name="HTTPSampler.method">${method}</stringProp>
          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
          <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>
          <stringProp name="HTTPSampler.embedded_url_re"></stringProp>
          <stringProp name="HTTPSampler.connect_timeout"></stringProp>
          <stringProp name="HTTPSampler.response_timeout"></stringProp>
        </HTTPSamplerProxy>
        <hashTree>
          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP 信息头管理器" enabled="true">
            <collectionProp name="HeaderManager.headers">
              <elementProp name="" elementType="Header">
                <stringProp name="Header.name">User-Agent</stringProp>
                <stringProp name="Header.value">test-center-jmeter/1.0</stringProp>
              </elementProp>
            </collectionProp>
          </HeaderManager>
          <hashTree/>
        </hashTree>
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
  return { ok: true, xml, domain: u.hostname, path: pathWithQuery };
}

module.exports = { inspectJmx, isJmxName, JMX_EXTS, buildJmxTemplate };

// ---------------------------------------------------------------------------
// 2.1 接口集合 → 批量 .jmx（契约 C-75〜C-77）
// ---------------------------------------------------------------------------

const MAX_INTERFACES = 50;
const THREADS_RANGE = [1, 100000];
const THINK_TIME_RANGE = [0, 60000];
const CSV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const intInRange = (v, [lo, hi]) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** HeaderManager 的 xml（headers 形如 "K: V" 每行一个） */
function headerManagerXml(headers, indent) {
  const lines = String(headers || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pairs = lines.map((l) => {
    const i = l.indexOf(':');
    return i > 0 ? { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : { name: 'X-Custom', value: l };
  });
  if (!pairs.length) pairs.push({ name: 'User-Agent', value: 'test-center-jmeter/1.0' });
  const items = pairs.map((p) => `${indent}  <elementProp name="" elementType="Header">
${indent}    <stringProp name="Header.name">${xmlEscape(p.name)}</stringProp>
${indent}    <stringProp name="Header.value">${xmlEscape(p.value)}</stringProp>
${indent}  </elementProp>`).join('\n');
  return `${indent}<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP 信息头管理器" enabled="true">
${indent}  <collectionProp name="HeaderManager.headers">
${items}
${indent}  </collectionProp>
${indent}</HeaderManager>`;
}

/** 单个 HTTPSamplerProxy + 它的响应码断言（+ 可选思考时间） */
function samplerXml(iface, index, plan, indent = '        ') {
  const raw = String(iface.url || '').trim();
  const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  const method = String(iface.method || 'GET').toUpperCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const pathWithQuery = `${u.pathname || '/'}${u.search || ''}`;
  const body = String(iface.body == null ? '' : iface.body);
  const hasBody = !!body && method !== 'GET';

  const args = hasBody
    ? `${indent}  <collectionProp name="Arguments.arguments">
${indent}    <elementProp name="" elementType="HTTPArgument">
${indent}      <boolProp name="HTTPArgument.always_encode">false</boolProp>
${indent}      <stringProp name="Argument.value">${xmlEscape(body)}</stringProp>
${indent}      <stringProp name="Argument.metadata">=</stringProp>
${indent}    </elementProp>
${indent}  </collectionProp>`
    : `${indent}  <collectionProp name="Arguments.arguments"/>`;

  const assertCode = String(plan.assertCode || '200');
  return `${indent}<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="${xmlEscape(`${method} ${iface.name || pathWithQuery} #${index + 1}`)}" enabled="true">
${indent}  <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="用户参数" enabled="true">
${args}
${indent}  </elementProp>
${indent}  <stringProp name="HTTPSampler.domain">${xmlEscape(u.hostname)}</stringProp>
${indent}  <stringProp name="HTTPSampler.port">${xmlEscape(port)}</stringProp>
${indent}  <stringProp name="HTTPSampler.protocol">${u.protocol === 'https:' ? 'https' : 'http'}</stringProp>
${indent}  <stringProp name="HTTPSampler.path">${xmlEscape(pathWithQuery)}</stringProp>
${indent}  <stringProp name="HTTPSampler.method">${method}</stringProp>
${indent}  <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
${indent}  <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
${indent}  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
${indent}  <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>${hasBody ? `\n${indent}  <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>` : ''}
${indent}  <stringProp name="HTTPSampler.embedded_url_re"></stringProp>
${indent}  <stringProp name="HTTPSampler.connect_timeout"></stringProp>
${indent}  <stringProp name="HTTPSampler.response_timeout"></stringProp>
${indent}</HTTPSamplerProxy>
${indent}<hashTree>
${indent}  <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="响应码断言" enabled="true">
${indent}    <collectionProp name="Asserion.test_strings">
${indent}      <stringProp name="0">${xmlEscape(assertCode)}</stringProp>
${indent}    </collectionProp>
${indent}    <stringProp name="Assertion.custom_message"></stringProp>
${indent}    <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
${indent}    <boolProp name="Assertion.assume_success">false</boolProp>
${indent}    <intProp name="Assertion.test_type">8</intProp>
${indent}  </ResponseAssertion>
${indent}  <hashTree/>
${headerManagerXml(iface.headers, `${indent}  `)}
${indent}  <hashTree/>
${plan.thinkTimeMs > 0 ? `${indent}  <ConstantTimer guiclass="ConstantTimerGui" testclass="ConstantTimer" testname="思考时间" enabled="true">
${indent}    <stringProp name="ConstantTimer.delay">${plan.thinkTimeMs}</stringProp>
${indent}  </ConstantTimer>
${indent}  <hashTree/>
` : ''}${indent}</hashTree>`;
}

/**
 * N 个接口 → 一份 .jmx：**一个 ThreadGroup + N 个 HTTPSamplerProxy**（不是 N 个线程组），
 * 线程/循环写成 `${__P(threads,默认)}`（否则 `-J` 覆盖不生效），每个 sampler 带响应码断言。
 *
 * @param {{ name?: string, interfaces: {name?: string, method?: string, url: string, headers?: string, body?: string}[],
 *           threads?: number, loops?: number, thinkTimeMs?: number, csvFile?: string,
 *           csvVars?: {name: string, column: string}[], assertCode?: string }} plan
 * @returns {{ ok: true, xml: string, name: string, interfaces: number, csvFileName: string }
 *          | { ok: false, reason: 'no-interface'|'too-many-interfaces'|'threads-out-of-range'|'think-time-out-of-range'|'bad-url'|'bad-csv-var'|'bad-assert-code', detail?: string }}
 */
function buildJmxFromPlan(plan) {
  const p = plan && typeof plan === 'object' ? plan : {};
  const interfaces = Array.isArray(p.interfaces) ? p.interfaces.filter(Boolean) : [];
  if (!interfaces.length) return { ok: false, reason: 'no-interface' };
  if (interfaces.length > MAX_INTERFACES) return { ok: false, reason: 'too-many-interfaces' };

  const threads = intInRange(p.threads, THREADS_RANGE);
  const loops = intInRange(p.loops, THREADS_RANGE);
  if (threads === null || loops === null) return { ok: false, reason: 'threads-out-of-range' };

  const thinkTimeMs = intInRange(p.thinkTimeMs == null ? 0 : p.thinkTimeMs, THINK_TIME_RANGE);
  if (thinkTimeMs === null) return { ok: false, reason: 'think-time-out-of-range' };

  const assertCode = p.assertCode == null || p.assertCode === '' ? '200' : String(p.assertCode);
  if (!/^\d{3}$/.test(assertCode)) return { ok: false, reason: 'bad-assert-code' };

  // URL 先全部校验一遍：任何一个不可解析就整体失败（不能生成半份脚本）
  for (const it of interfaces) {
    const raw = String((it && it.url) || '').trim();
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
      if (!u.hostname) throw new Error('no host');
    } catch {
      return { ok: false, reason: 'bad-url', detail: String((it && it.name) || raw) };
    }
  }

  // CSV：只取文件名（不写绝对路径、不写 ..）；变量名必须能当 JMeter 变量用
  const csvVars = Array.isArray(p.csvVars) ? p.csvVars.filter((v) => v && v.name) : [];
  const csvSource = String(p.csvFile || '').trim();
  for (const v of csvVars) {
    if (!CSV_VAR_RE.test(String(v.name))) return { ok: false, reason: 'bad-csv-var', detail: String(v.name) };
  }
  const csvFileName = csvSource ? String(csvSource).split(/[\\/]/).pop() : '';
  const useCsv = !!csvFileName && csvVars.length > 0;

  const name = xmlEscape(String(p.name || '批量压测'));
  const planForSamplers = { thinkTimeMs, assertCode };

  const csvXml = useCsv
    ? `        <CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="CSV 数据文件" enabled="true">
          <stringProp name="delimiter">,</stringProp>
          <stringProp name="fileEncoding">UTF-8</stringProp>
          <stringProp name="filename">${xmlEscape(csvFileName)}</stringProp>
          <boolProp name="ignoreFirstLine">true</boolProp>
          <boolProp name="quotedData">false</boolProp>
          <boolProp name="recycle">true</boolProp>
          <stringProp name="shareMode">shareMode.all</stringProp>
          <boolProp name="stopThread">false</boolProp>
          <stringProp name="variableNames">${xmlEscape(csvVars.map((v) => String(v.name)).join(','))}</stringProp>
        </CSVDataSet>
        <hashTree/>
`
    : '';

  const samplers = interfaces.map((it, i) => samplerXml(it, i, planForSamplers)).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="${name}" enabled="true">
      <stringProp name="TestPlan.comments">由测试中台「接口集合 → 批量脚本」生成；线程/循环可用 -Jthreads / -Jloops 覆盖</stringProp>
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="用户定义的变量" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
      <stringProp name="TestPlan.user_define_classpath"></stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="批量线程组" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="循环控制器" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">\${__P(loops,${loops})}</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">\${__P(threads,${threads})}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">1</stringProp>
        <boolProp name="ThreadGroup.scheduler">false</boolProp>
        <stringProp name="ThreadGroup.duration"></stringProp>
        <stringProp name="ThreadGroup.delay"></stringProp>
      </ThreadGroup>
      <hashTree>
${csvXml}${samplers}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>
`;
  return { ok: true, xml, name, interfaces: interfaces.length, csvFileName: useCsv ? csvFileName : '' };
}

/**
 * 落盘前校验 CSV 表（parseCsv 的结果，纯数据入参）：
 * 首行表头必须含 csvVars 的每一列，且至少 1 行数据（契约 C-75 第 2 条）。
 * @param {string[][]} table parseCsv 的输出（含表头行）
 * @param {{name: string, column: string}[]} csvVars
 * @returns {{ ok: true, rows: number } | { ok: false, reason: 'no-rows'|'missing-column', detail?: string }}
 */
function validateCsvTable(table, csvVars) {
  const rows = Array.isArray(table) ? table : [];
  const header = Array.isArray(rows[0]) ? rows[0].map((h) => String(h).trim()) : [];
  if (rows.length < 2) return { ok: false, reason: 'no-rows' };
  for (const v of Array.isArray(csvVars) ? csvVars : []) {
    const col = String((v && v.column) || '').trim();
    if (!col) continue;
    if (!header.includes(col)) return { ok: false, reason: 'missing-column', detail: col };
  }
  return { ok: true, rows: rows.length - 1 };
}

module.exports = {
  inspectJmx, isJmxName, JMX_EXTS, buildJmxTemplate,
  buildJmxFromPlan, validateCsvTable, MAX_INTERFACES,
};


