import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { inspectJmx, isJmxName, buildJmxTemplate } = require('../../../electron/jmx-script');

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
