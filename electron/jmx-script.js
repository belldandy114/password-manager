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


