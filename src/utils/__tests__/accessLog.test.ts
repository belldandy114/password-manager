import { describe, it, expect } from 'vitest';
import {
  parseAccessLine, parseAccessLog, normalizePath, looksLikeAccessLog,
  summarizeAccess, accessSummaryText,
} from '../accessLog';

const L1 = '203.0.113.47 - - [13/Nov/2026:09:14:02 +0800] "GET /api/v2/users/me HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (Windows NT 10.0)"';
const L2 = '203.0.113.47 - - [13/Nov/2026:09:15:10 +0800] "GET /api/v2/users/123/orders HTTP/1.1" 500 64 "https://example.com/" "Mozilla/5.0"';
const L3 = '198.51.100.9 - - [13/Nov/2026:09:16:00 +0800] "GET /api/v2/users/456/orders HTTP/1.1" 500 64 "-" "curl/8.0"';

describe('parseAccessLine', () => {
  it('解析 combined 格式', () => {
    const r = parseAccessLine(L1)!;
    expect(r.ip).toBe('203.0.113.47');
    expect(r.method).toBe('GET');
    expect(r.path).toBe('/api/v2/users/me');
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(1234);
    expect(r.ua).toContain('Mozilla');
    expect(r.time).toBe('13/Nov/2026:09:14:02 +0800');
  });

  it('解析 referer', () => {
    const r = parseAccessLine(L2)!;
    expect(r.referer).toBe('https://example.com/');
  });

  it('末尾带耗时能被识别', () => {
    const line = '203.0.113.47 - - [13/Nov/2026:09:14:02 +0800] "GET /a HTTP/1.1" 200 10 "-" "ua" 0.321';
    expect(parseAccessLine(line)!.seconds).toBe(0.321);
  });

  it('字节数为 - 时记 0', () => {
    const line = '203.0.113.47 - - [13/Nov/2026:09:14:02 +0800] "GET /a HTTP/1.1" 304 - "-" "ua"';
    expect(parseAccessLine(line)!.bytes).toBe(0);
  });

  it('不是访问日志的行返回 null', () => {
    expect(parseAccessLine('2026-11-13 14:20:31 ERROR java.lang.NullPointerException')).toBeNull();
    expect(parseAccessLine('')).toBeNull();
  });
});

describe('normalizePath', () => {
  it('数字段换成 :id', () => {
    expect(normalizePath('/api/v2/users/123/orders/456')).toBe('/api/v2/users/:id/orders/:id');
  });

  it('UUID 段换成 :uuid', () => {
    expect(normalizePath('/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/u/:uuid');
  });

  it('保留版本号这类非纯数字段', () => {
    expect(normalizePath('/api/v2/items')).toBe('/api/v2/items');
  });

  it('丢掉查询串', () => {
    expect(normalizePath('/search?q=1')).toBe('/search');
  });
});

describe('looksLikeAccessLog', () => {
  it('单行也能判定', () => {
    expect(looksLikeAccessLog(L1)).toBe(true);
  });

  it('应用日志不算', () => {
    expect(looksLikeAccessLog('2026-11-13 14:20:31 ERROR boom')).toBe(false);
  });

  it('空串不算', () => {
    expect(looksLikeAccessLog('  ')).toBe(false);
  });
});

describe('parseAccessLog + summarizeAccess', () => {
  const text = [L1, L2, L3, '不是访问日志的一行'].join('\n');
  const { rows, matched, total } = parseAccessLog(text);

  it('命中行与总行数分开统计', () => {
    expect(matched).toBe(3);
    expect(total).toBe(4);
  });

  it('状态按 2xx/5xx 分组', () => {
    const s = summarizeAccess(rows);
    expect(s.statusBuckets).toEqual([
      { label: '2xx', count: 1 },
      { label: '5xx', count: 2 },
    ]);
  });

  it('不同 id 的同一路径合并计数并累计失败', () => {
    const s = summarizeAccess(rows);
    const orders = s.topPaths.find(p => p.key === '/api/v2/users/:id/orders')!;
    expect(orders.count).toBe(2);
    expect(orders.fail).toBe(2);
  });

  it('Top IP 按次数排序', () => {
    const s = summarizeAccess(rows);
    expect(s.topIps[0].label).toBe('203.0.113.47');
    expect(s.topIps[0].count).toBe(2);
  });

  it('没有耗时字段时不计算平均值', () => {
    const s = summarizeAccess(rows);
    expect(s.withTime).toBe(0);
    expect(s.slowest).toEqual([]);
  });

  it('带耗时行能算出最慢', () => {
    const withTime = [
      '1.1.1.1 - - [13/Nov/2026:09:00:00 +0800] "GET /a HTTP/1.1" 200 1 "-" "ua" 0.05',
      '1.1.1.1 - - [13/Nov/2026:09:00:01 +0800] "GET /b HTTP/1.1" 200 1 "-" "ua" 2.5',
    ].join('\n');
    const s = summarizeAccess(parseAccessLog(withTime).rows);
    expect(s.withTime).toBe(2);
    expect(s.slowest[0].path).toBe('/b');
  });

  it('时间范围取首末行', () => {
    const s = summarizeAccess(rows);
    expect(s.from).toContain('13/Nov/2026:09:14:02');
    expect(s.to).toContain('13/Nov/2026:09:16:00');
  });
});

describe('accessSummaryText', () => {
  it('包含条数与状态分布', () => {
    const t = accessSummaryText(parseAccessLog([L1, L2].join('\n')).rows);
    expect(t).toContain('2 条请求');
    expect(t).toContain('5xx 1');
  });

  it('空输入返回空串', () => {
    expect(accessSummaryText([])).toBe('');
  });
});
