import { describe, it, expect } from 'vitest';
import {
  buildJmeterArgs, pickPaths, scriptBase, stamp,
  validateJmxPath, validateOutDir, validateJmeterPath,
  parseSummary, parseJtl, splitCsvLine,
  parseJtlHeader, parseJtlRow, parseJtlRows, computeMetrics,
  pickJmeterLogPath, canWriteDir,
} from '../../../electron/jmeter-args.js';

const JMX = 'C:\\scripts\\示例科技.jmx';
const OUT = 'C:\\out';
const ST = '2026-10-29_16-03-05';

describe('jmeter-args.pickPaths 输出路径规划', () => {
  it('log 模式：jtl 放输出目录，文件名带脚本名与时间戳', () => {
    const p = pickPaths({ jmxPath: JMX, outDir: OUT, mode: 'log', stampStr: ST });
    expect(p.reportDir).toBe('');
    expect(p.jtlPath).toContain('示例科技-2026-10-29_16-03-05.jtl');
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
    expect(scriptBase('C:\\\\s\\\\示例 科技.jmx')).toBe('示例_科技');
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

  // JMeter 自己的 jmeter.log 默认落在 **进程 cwd**；cwd 为了让 CSV 相对路径可解析已改成 JMX 所在目录，
  // 所以必须用 -j 把引擎日志钉到 jtl 同目录，否则用户的脚本库里会莫名多出 jmeter.log（每次运行都可能覆盖）
  it('传了 logPath 时追加 -j <日志路径>（紧跟 -l，参数顺序稳定）', () => {
    const log = 'C:\\out\\jmeter-2026-01-02_03-04-05-engine.log';
    expect(buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl', logPath: log }))
      .toEqual(['-n', '-t', JMX, '-l', 'o\\r.jtl', '-j', log]);
    const withAll = buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl', logPath: log, threads: 2, loops: 3 });
    expect(withAll).toEqual(['-n', '-t', JMX, '-l', 'o\\r.jtl', '-j', log, '-Jthreads=2', '-Jloops=3']);
  });

  it('不传 / 传空串 / 传空白时**不加** -j（保持旧行为，向后兼容）', () => {
    expect(buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl' }))
      .toEqual(['-n', '-t', JMX, '-l', 'o\\r.jtl']);
    expect(buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl', logPath: '' })).not.toContain('-j');
    expect(buildJmeterArgs({ jmxPath: JMX, jtlPath: 'o\\r.jtl', logPath: '   ' })).not.toContain('-j');
  });

  it('pickJmeterLogPath 是纯函数：空目录 → ok:false；正常目录 → 给出带时间戳的 engine 日志名（不碰磁盘）', () => {
    expect(pickJmeterLogPath('')).toMatchObject({ ok: false, reason: 'no-dir' });
    expect(pickJmeterLogPath('   ')).toMatchObject({ ok: false, reason: 'no-dir' });
    expect(pickJmeterLogPath('C:\\out', '2026-01-02_03-04-05'))
      .toEqual({ ok: true, path: 'C:\\out\\jmeter-2026-01-02_03-04-05-engine.log' });
    // 目录不存在也照样算出一个路径——「能不能写」由调用方用 canWriteDir 探，纯函数不碰盘
    expect(pickJmeterLogPath('C:\\不存在\\out', 'S')).toMatchObject({ ok: true });
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

// ---------------------------------------------------------------------------
// 5.2 .jtl 指标扩展（契约 C-70 / C-71）：行级解析 + computeMetrics
// 期望值全部手算写死，不让测试自己再算一遍（否则测试与实现同一个错就都错）
// ---------------------------------------------------------------------------

const H = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';
const line = (ts: number, elapsed: number, label: string, code: string, ok: boolean) =>
  `${ts},${elapsed},${label},${code},OK,TG 1-1,text,${ok},,,100,0,1,1,http://h/api,${elapsed - 5},0,2`;

describe('jmeter-args.parseJtlHeader / parseJtlRow / parseJtlRows 行级解析', () => {
  it('parseJtlHeader 按表头名取列下标（不靠列序）', () => {
    expect(parseJtlHeader(H)).toEqual({ elapsed: 1, success: 7, code: 3, label: 2, ts: 0 });
    // 列序换了仍然按名字取
    const swapped = 'success,elapsed,label,responseCode,timeStamp';
    expect(parseJtlHeader(swapped)).toEqual({ elapsed: 1, success: 0, code: 3, label: 2, ts: 4 });
  });

  it('parseJtlHeader 缺 elapsed / 缺 success → null', () => {
    expect(parseJtlHeader('timeStamp,label,success')).toBeNull();
    expect(parseJtlHeader('timeStamp,elapsed,label')).toBeNull();
    // 两者都在就正常（这条防「一律返回 null」的假实现）
    expect(parseJtlHeader('timeStamp,elapsed,label,success')).not.toBeNull();
  });

  it('parseJtlHeader 空串 / 非字符串 → null', () => {
    expect(parseJtlHeader('')).toBeNull();
    expect(parseJtlHeader(undefined as unknown as string)).toBeNull();
  });

  it('parseJtlHeader 缺 ts / code / label 时给 -1（不报错）', () => {
    const idx = parseJtlHeader('elapsed,success');
    expect(idx).toEqual({ elapsed: 0, success: 1, code: -1, label: -1, ts: -1 });
  });

  it('parseJtlRow 正常：逐字段给出 row（ok 由 success 列转布尔）', () => {
    const header = parseJtlHeader(H)!;
    expect(parseJtlRow(line(1000, 100, '登录', '200', true), header))
      .toEqual({ elapsed: 100, ok: true, code: '200', label: '登录', ts: 1000 });
    expect(parseJtlRow(line(1200, 300, '列表', '500', false), header)!.ok).toBe(false);
  });

  it('parseJtlRow 缺列/空行/elapsed 非数字 → null', () => {
    const header = parseJtlHeader(H)!;
    expect(parseJtlRow('', header)).toBeNull();
    expect(parseJtlRow('1000,', header)).toBeNull();
    expect(parseJtlRow('1000,abc,登录,200,OK,TG,text,true', header)).toBeNull();
    // 二进制/异常行（elapsed 为 -）按坏行丢弃
    expect(parseJtlRow('1000,-,登录,200,OK,TG,text,true', header)).toBeNull();
  });

  it('parseJtlRow 缺 ts 列时 ts 记 0；缺 label 时 label 记空串', () => {
    const noTs = parseJtlHeader('elapsed,success,responseCode,label')!;
    expect(parseJtlRow('100,true,200,登录', noTs)).toEqual({ elapsed: 100, ok: true, code: '200', label: '登录', ts: 0 });
    const noLabel = parseJtlHeader('elapsed,success')!;
    expect(parseJtlRow('100,false', noLabel)).toEqual({ elapsed: 100, ok: false, code: '', label: '', ts: 0 });
  });

  it('parseJtlRows 正常：返回 { header, rows }，引号内逗号不断列，CRLF 与空行被跳过', () => {
    const csv = [
      H,
      '1000,50,"查询,列表",200,OK,TG,text,true,,,1,0,1,1,http://h,45,0,1',
      '',
      '1200,70,登录,200,OK,TG,text,false,,,1,0,1,1,http://h,65,0,1',
    ].join('\r\n');
    const parsed = parseJtlRows(csv)!;
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].label).toBe('查询,列表');
    expect(parsed.rows[1].ok).toBe(false);
    expect(parsed.header.elapsed).toBe(1);
  });

  it('parseJtlRows 空文本 / 只有表头 / 表头不合格 → null', () => {
    expect(parseJtlRows('')).toBeNull();
    expect(parseJtlRows('   ')).toBeNull();
    expect(parseJtlRows(H)).toBeNull();
    expect(parseJtlRows('a,b\n1,2')).toBeNull();
    expect(parseJtlRows(undefined as unknown as string)).toBeNull();
  });

  it('parseJtlRows 所有行都是坏行 → null（不返回空数组冒充成功）', () => {
    expect(parseJtlRows(`${H}\n\n\n`)).toBeNull();
    expect(parseJtlRows(`${H}\nx,y,z`)).toBeNull();
  });
});

describe('jmeter-args.computeMetrics 指标计算', () => {
  // 手算基准：elapsed 升序 [100,120,200,300]，n=4，span=1600-1000=600
  const rows = [
    { elapsed: 100, ok: true, code: '200', label: '登录', ts: 1000 },
    { elapsed: 120, ok: true, code: '200', label: '登录', ts: 1200 },
    { elapsed: 300, ok: false, code: '500', label: '列表', ts: 1400 },
    { elapsed: 200, ok: true, code: '200', label: '列表', ts: 1600 },
  ];

  it('样本数/错误数/错误率/均值/最值', () => {
    const m = computeMetrics(rows);
    expect(m.samples).toBe(4);
    expect(m.errors).toBe(1);
    expect(m.errorPct).toBe(25);
    expect(m.min).toBe(100);
    expect(m.max).toBe(300);
    expect(m.avg).toBe(180); // (100+120+300+200)/4
  });

  it('P50/P90/P95/P99 用最近秩法，期望值手算写死', () => {
    const m = computeMetrics(rows);
    expect(m.p50).toBe(120); // ceil(0.5*4)-1 = 1 → 升序第 2 个
    expect(m.p90).toBe(300); // ceil(3.6)-1 = 3 → 第 4 个
    expect(m.p95).toBe(300);
    expect(m.p99).toBe(300);
  });

  it('单样本：四个分位都等于该值', () => {
    const m = computeMetrics([{ elapsed: 42, ok: true, code: '200', label: 'a', ts: 5 }]);
    expect([m.p50, m.p90, m.p95, m.p99]).toEqual([42, 42, 42, 42]);
    expect(m.samples).toBe(1);
  });

  it('spanMs 用时间戳极差，tps = samples / (spanMs/1000)', () => {
    const m = computeMetrics(rows);
    expect(m.spanMs).toBe(600);
    expect(m.tps).toBeCloseTo(6.67, 2); // 4 / 0.6
  });

  it('时间戳全缺失：spanMs=0 且 tps=0（不是 Infinity/NaN）', () => {
    const m = computeMetrics(rows.map((r) => ({ ...r, ts: 0 })));
    expect(m.spanMs).toBe(0);
    expect(m.tps).toBe(0);
    expect(Number.isFinite(m.tps)).toBe(true);
  });

  it('只有一行有时间戳：spanMs=0、tps=0', () => {
    const m = computeMetrics([
      { elapsed: 10, ok: true, code: '200', label: 'a', ts: 999 },
      { elapsed: 20, ok: true, code: '200', label: 'a', ts: 0 },
    ]);
    expect(m.spanMs).toBe(0);
    expect(m.tps).toBe(0);
  });

  it('时间戳逆序（ts 乱序）spanMs 仍为正', () => {
    const m = computeMetrics([
      { elapsed: 10, ok: true, code: '200', label: 'a', ts: 5000 },
      { elapsed: 20, ok: true, code: '200', label: 'a', ts: 1000 },
    ]);
    expect(m.spanMs).toBe(4000);
    expect(m.tps).toBeCloseTo(0.5, 3);
  });

  it('byLabel 按接口分组给 samples/errors/errorPct/p90', () => {
    const m = computeMetrics(rows);
    expect(m.byLabel).toEqual([
      { label: '列表', samples: 2, errors: 1, errorPct: 50, p90: 300 },
      { label: '登录', samples: 2, errors: 0, errorPct: 0, p90: 120 },
    ]);
  });

  it('byLabel 排序：errors 降序 → samples 降序 → label 升序', () => {
    const m = computeMetrics([
      { elapsed: 1, ok: true, code: '200', label: 'b少量', ts: 1 },
      { elapsed: 2, ok: true, code: '200', label: 'a少量', ts: 2 },
      { elapsed: 3, ok: true, code: '200', label: 'c多量', ts: 3 },
      { elapsed: 4, ok: true, code: '200', label: 'c多量', ts: 4 },
      { elapsed: 5, ok: false, code: '500', label: 'z错', ts: 5 },
    ]);
    // errors：z错(1) 先；其余 errors 相同 → samples 降序（c多量 2）→ 最后两个按 label 升序（a少量 < b少量）
    expect(m.byLabel.map((x) => x.label)).toEqual(['z错', 'c多量', 'a少量', 'b少量']);
  });

  it('byLabel 超出 maxLabels 截断并置 truncated/labels', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      elapsed: 10 + i, ok: true, code: '200', label: `L${i}`, ts: i,
    }));
    const m = computeMetrics(many, { maxLabels: 2 });
    expect(m.byLabel).toHaveLength(2);
    expect(m.truncated).toBe(true);
    expect(m.truncatedReason).toBe('labels');
  });

  it('maxLabels 被 clamp 到 [1,100]', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      elapsed: 10, ok: true, code: '200', label: `L${i}`, ts: i,
    }));
    expect(computeMetrics(many, { maxLabels: 0 }).byLabel).toHaveLength(1);
    expect(computeMetrics(many, { maxLabels: 5000 }).byLabel.length).toBeLessThanOrEqual(100);
    expect(computeMetrics(many, { maxLabels: 5000 }).byLabel).toHaveLength(3);
  });

  it('空数组：全 0 指标且不抛，byLabel 为空、truncated=false', () => {
    const m = computeMetrics([]);
    expect(m).toMatchObject({
      samples: 0, errors: 0, errorPct: 0, avg: 0, min: 0, max: 0,
      p50: 0, p90: 0, p95: 0, p99: 0, tps: 0, spanMs: 0, byLabel: [], truncated: false,
    });
    expect(Number.isFinite(m.tps)).toBe(true);
  });

  it('全错：errorPct=100、errors=samples，topErrorCode 不返回（本批只给 byLabel）', () => {
    const m = computeMetrics([
      { elapsed: 5, ok: false, code: '500', label: 'a', ts: 1 },
      { elapsed: 6, ok: false, code: '404', label: 'a', ts: 2 },
    ]);
    expect(m.errors).toBe(2);
    expect(m.errorPct).toBe(100);
    expect('topErrorCode' in m).toBe(false);
  });

  it('不修改传入的行数组（纯函数）', () => {
    const input = rows.map((r) => ({ ...r }));
    computeMetrics(input);
    expect(input).toEqual(rows);
  });
});