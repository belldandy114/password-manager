import { describe, it, expect } from 'vitest';
import { analyzeLog, normalizeForSignature, onlyErrors, toSummaryText } from '../logAnalysis';

const LOG = [
  '2026-11-13 14:20:31 INFO  [main] 应用启动完成',
  '2026-11-13 14:20:32 ERROR [http-1] java.lang.NullPointerException: user is null',
  '	at com.foo.UserService.load(UserService.java:42)',
  '	at com.foo.Controller.index(Controller.java:18)',
  '2026-11-13 14:20:33 WARN  [http-2] 响应超过 2 秒',
  '2026-11-13 14:21:10 ERROR [http-3] java.lang.NullPointerException: user is null',
  '	at com.foo.UserService.load(UserService.java:87)',
  '	at com.foo.Controller.index(Controller.java:18)',
  '2026-11-13 14:22:00 ERROR [http-4] java.lang.IllegalStateException: closed',
  '	at com.foo.Pool.acquire(Pool.java:9)',
].join('\n');

describe('normalizeForSignature', () => {
  it('抹平时间、数字与行号', () => {
    const a = normalizeForSignature('2026-11-13 14:20:32 ERROR at Foo.bar(Foo.java:42)');
    const b = normalizeForSignature('2026-11-13 15:01:07 ERROR at Foo.bar(Foo.java:87)');
    expect(a).toBe(b);
  });

  it('不同的异常名不会被抹平', () => {
    expect(normalizeForSignature('NullPointerException')).not.toBe(normalizeForSignature('IllegalStateException'));
  });
});

describe('analyzeLog / 聚类', () => {
  const a = analyzeLog(LOG);

  it('同一异常不同行号合并成一类', () => {
    const npe = a.clusters.find((c) => c.title.includes('NullPointerException'));
    expect(npe).toBeTruthy();
    expect(npe!.count).toBe(2);
    expect(npe!.firstAt).toBe('2026-11-13 14:20:32');
    expect(npe!.lastAt).toBe('2026-11-13 14:21:10');
  });

  it('不同异常分开统计', () => {
    // 每条带级别的独立消息各成一条：INFO / NPE / WARN / IllegalState
    expect(a.clusters).toHaveLength(4);
    const titles = a.clusters.map((c) => c.title);
    expect(titles).toContain('java.lang.NullPointerException');
    expect(titles).toContain('java.lang.IllegalStateException');
  });

  it('按出现次数降序，次数相同时按首次行号', () => {
    expect(a.clusters[0].count).toBe(2);
    expect(a.clusters[0].title).toBe('java.lang.NullPointerException');
    expect(a.clusters[1].count).toBe(1);
    expect(a.clusters[1].firstLine).toBeLessThan(a.clusters[2].firstLine);
  });

  it('统计各级别行数', () => {
    expect(a.levelCounts.ERROR).toBe(3);
    expect(a.levelCounts.WARN).toBe(1);
    expect(a.levelCounts.INFO).toBe(1);
  });

  it('给出时间范围', () => {
    expect(a.from).toBe('2026-11-13 14:20:31');
    expect(a.to).toBe('2026-11-13 14:22:00');
  });

  it('保留首次出现的事件头与堆栈', () => {
    const npe = a.clusters[0];
    expect(npe.message).toContain('java.lang.NullPointerException');
    expect(npe.stack[0]).toContain('UserService.java:42');
  });

  it('不把堆栈行算成独立事件', () => {
    expect(a.events).toBe(5);
  });
});

describe('analyzeLog / 边界', () => {
  it('空输入不报错', () => {
    const a = analyzeLog('');
    expect(a.clusters).toEqual([]);
    expect(a.events).toBe(0);
  });

  it('只有普通消息时不产生聚类', () => {
    const a = analyzeLog('启动中\n加载配置完成');
    expect(a.clusters).toEqual([]);
    expect(a.plainLines).toBe(2);
  });

  it('无级别但直接抛异常名的行也能识别', () => {
    const a = analyzeLog('TypeError: x is not a function\n    at foo (a.js:1:1)');
    expect(a.clusters).toHaveLength(1);
    expect(a.clusters[0].title).toBe('TypeError');
    expect(a.clusters[0].level).toBe('ERROR');
  });

  it('Caused by 归到同一个事件的堆栈里', () => {
    const a = analyzeLog([
      '2026-11-13 10:00:00 ERROR java.lang.RuntimeException: boom',
      '\tat com.foo.A.b(A.java:1)',
      'Caused by: java.io.IOException: disk',
      '\tat com.foo.B.c(B.java:2)',
    ].join('\n'));
    expect(a.clusters).toHaveLength(1);
    expect(a.clusters[0].stack.join('\n')).toContain('Caused by');
  });
});

describe('toSummaryText / onlyErrors', () => {
  const a = analyzeLog(LOG);

  it('只保留错误级别', () => {
    expect(onlyErrors(a.clusters).every((c) => c.level === 'ERROR' || c.level === 'FATAL')).toBe(true);
  });

  it('摘要包含次数与时间', () => {
    const t = toSummaryText(a);
    expect(t).toContain('2 次');
    expect(t).toContain('首次 2026-11-13 14:20:32');
  });

  it('空分析返回空串', () => {
    expect(toSummaryText(analyzeLog(''))).toBe('');
  });
});
