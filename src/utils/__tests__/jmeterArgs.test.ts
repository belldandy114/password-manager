import { describe, it, expect } from 'vitest';
import {
  buildJmeterArgs, pickPaths, scriptBase, stamp,
  validateJmxPath, validateOutDir, validateJmeterPath,
  parseSummary, parseJtl, splitCsvLine,
} from '../../../electron/jmeter-args.js';

const JMX = 'C:\\scripts\\广科华贸.jmx';
const OUT = 'C:\\out';
const ST = '2026-10-29_16-03-05';

describe('jmeter-args.pickPaths 输出路径规划', () => {
  it('log 模式：jtl 放输出目录，文件名带脚本名与时间戳', () => {
    const p = pickPaths({ jmxPath: JMX, outDir: OUT, mode: 'log', stampStr: ST });
    expect(p.reportDir).toBe('');
    expect(p.jtlPath).toContain('广科华贸-2026-10-29_16-03-05.jtl');
    expect(p.jtlPath.startsWith(OUT)).toBe(true);
  });

  it('report 模式：报告进独立子目录（JMeter 要求 -o 目录为空），jtl 在它旁边', () => {
    const p = pickPaths({ jmxPath: JMX, outDir: OUT, mode: 'report', stampStr: ST });
    expect(p.reportDir).toContain('report-2026-10-29_16-03-05');
    expect(p.jtlPath).not.toBe(p.reportDir);
    // jtl 不能落在 reportDir 里，否则 -o 目录非空会直接报错
    expect(p.jtlPath.startsWith(p.reportDir)).toBe(false);
  });

  it('脚本名里的非法字符会被替换，空名兜底 jmeter', () => {
    // 先取 basename（Windows 风格路径的分隔符也算），再把非法字符换成下划线
    expect(scriptBase('a/b:c*.jmx')).toBe('b_c_');
    expect(scriptBase('C:\\\\s\\\\广科 华贸.jmx')).toBe('广科_华贸');
    expect(scriptBase('')).toBe('jmeter');
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02_03-04-05');
  });
});

describe('jmeter-args.buildJmeterArgs 参数拼装', () => {
  it('log 模式基础参数', () => {
    expect(buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl', mode: 'log' }))
      .toEqual(['-n', '-t', JMX, '-l', 'o\\r.jtl']);
  });

  it('report 模式追加 -e -o', () => {
    const args = buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl', mode: 'report', reportDir: 'o\\report-1' });
    expect(args).toEqual(['-n', '-t', JMX, '-l', 'o\\r.jtl', '-e', '-o', 'o\\report-1']);
  });

  it('线程数/循环数作为 -J 属性覆盖，非法值忽略', () => {
    const args = buildJmeterArgs({ jmxPath: JMX, jtlPath: 'r.jtl', threads: 50, loops: 10 });
    expect(args).toContain('-Jthreads=50');
    expect(args).toContain('-Jloops=10');

    const bad = buildJmeterArgs({ jmxPath: JMX, jtlPath: 'r.jtl', threads: 0, loops: -3 });
    expect(bad.join(' ')).not.toContain('-J');
    expect(buildJmeterArgs({ jmxPath: JMX, jtlPath: 'r.jtl', threads: 'abc' as unknown as number }).join(' ')).not.toContain('-J');
  });

  it('额外参数按顺序附在末尾，空值丢弃', () => {
    const args = buildJmeterArgs({
      jmxPath: JMX, jtlPath: 'r.jtl', extraArgs: ['-Jenv=test', '', '  ', '-Xmx1g'],
    });
    expect(args.slice(-2)).toEqual(['-Jenv=test', '-Xmx1g']);
  });

  it('缺关键参数 / 未知模式直接抛错（不要静默生成一条错命令）', () => {
    expect(() => buildJmeterArgs({ jmxPath: '', jtlPath: 'r.jtl' })).toThrow();
    expect(() => buildJmeterArgs({ jmxPath: JMX, jtlPath: '' })).toThrow();
    expect(() => buildJmeterArgs({ jmxPath: JMX, jtlPath: 'r.jtl', mode: 'gui' as unknown as 'log' })).toThrow();
    expect(() => buildJmeterArgs({ jmxPath: JMX, jtlPath: 'r.jtl', mode: 'report' })).toThrow();
  });
});

describe('jmeter-args 校验函数', () => {
  it('不存在的路径给出可读错误，而不是抛异常', () => {
    expect(validateJmxPath('').ok).toBe(false);
    expect(validateJmxPath('C:\\nope\\a.txt').error).toContain('.jmx');
    expect(validateJmxPath('C:\\nope\\a.jmx').error).toContain('不存在');
    expect(validateOutDir('').ok).toBe(false);
    expect(validateOutDir('C:\\nope\\dir').error).toContain('不存在');
    expect(validateJmeterPath('').error).toContain('JMeter');
  });
});

describe('jmeter-args.parseSummary 控制台汇总', () => {
  const line = 'summary =    200 in 00:00:12 =   16.7/s Avg:   145 Min:    88 Max:   402 Err: 0 (0.00%)';

  it('解析出样本数/耗时/TPS/响应时间/错误数', () => {
    expect(parseSummary(line)).toEqual({
      samples: 200, duration: '00:00:12', tps: 16.7, avg: 145, min: 88, max: 402, errors: 0, errorPct: 0,
    });
  });

  it('多行时取最后一行（多线程汇总）', () => {
    const text = [
      'summary =    100 in 00:00:05 =   20.0/s Avg:   100 Min:    80 Max:   200 Err: 1 (1.00%)',
      line,
    ].join('\n');
    expect(parseSummary(text)!.samples).toBe(200);
  });

  it('没有汇总行 / 空输入 → null', () => {
    expect(parseSummary('')).toBeNull();
    expect(parseSummary('creating summariser\nStarted the test')).toBeNull();
  });
});

describe('jmeter-args.parseJtl 结果文件', () => {
  const header = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';
  const row = (ts: number, elapsed: number, code: string, ok: boolean, label = '登录') =>
    `${ts},${elapsed},${label},${code},OK,TG 1-1,text,${ok},,,100,0,1,1,http://h/api,${elapsed - 5},0,2`;

  it('算样本数/错误率/分位/墙钟 TPS', () => {
    const csv = [
      header,
      row(1000, 100, '200', true),
      row(1200, 120, '200', true),
      row(1400, 300, '500', false),
      row(1600, 200, '200', true),
    ].join('\n');
    const s = parseJtl(csv)!;
    expect(s.samples).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.errorPct).toBe(25);
    expect(s.min).toBe(100);
    expect(s.max).toBe(300);
    expect(s.avg).toBe(180);
    expect(s.wallMs).toBe(600);
    expect(s.tps).toBeCloseTo(6.67, 1);
    expect(s.topErrorCode).toEqual({ code: '500', count: 1 });
  });

  it('label 里带逗号也能正确拆列', () => {
    const csv = [header, `1000,50,"查询,列表",200,OK,TG,text,true,,,1,0,1,1,http://h,45,0,1`].join('\n');
    const s = parseJtl(csv)!;
    expect(s.samples).toBe(1);
    expect(s.errors).toBe(0);
  });

  it('空文件 / 只有表头 / 缺关键列 → null', () => {
    expect(parseJtl('')).toBeNull();
    expect(parseJtl(header)).toBeNull();
    expect(parseJtl('a,b\n1,2')).toBeNull();
  });

  it('splitCsvLine 处理引号与转义', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('"he said ""hi""",x')).toEqual(['he said "hi"', 'x']);
  });
});