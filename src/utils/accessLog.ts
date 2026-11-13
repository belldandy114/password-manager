/**
 * Web 访问日志解析（Nginx / Apache 的 combined / common 格式）。
 *
 * 和「应用日志」不是一类东西：
 * - 应用日志靠**堆栈聚类**，一条异常跨多行；
 * - 访问日志**一行一条请求**，没有级别、没有堆栈，靠**路径 / 状态码 / IP** 聚合才有意义。
 *
 * 所以单独一套解析，不要塞进 analyzeLog（那边会把每行当成事件头，几千行就是几千条聚类）。
 *
 * 兼容的格式：
 *   combined:  $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"
 *   common:    同上，但没有 referer / ua
 *   带耗时:    末尾追加 $request_time（0.123）或 $upstream_response_time（0.123 / -）
 */

export interface AccessRow {
  ip: string;
  time: string;
  method: string;
  /** 原始路径（含查询串） */
  path: string;
  /** 归一化后的路径：数字段换成 :id，用于聚合 */
  key: string;
  status: number;
  /** 响应字节数；'-' 记 0 */
  bytes: number;
  referer?: string;
  ua?: string;
  /** 请求耗时（秒），只有日志里带了才解析 */
  seconds?: number;
  /** 原始行，展开时看 */
  raw: string;
}

export interface AccessBucket {
  label: string;
  count: number;
}

export interface AccessSummary {
  total: number;
  matched: number;
  /** 2xx / 3xx / 4xx / 5xx */
  statusBuckets: AccessBucket[];
  /** 出现次数最多的路径（key 归一后），同时给出失败数 */
  topPaths: Array<{ key: string; sample: string; count: number; fail: number; ms: number }>;
  /** 请求最多的 IP */
  topIps: AccessBucket[];
  /** 最慢的若干条（只有日志带耗时才有） */
  slowest: AccessRow[];
  /** 时间范围（原样文本） */
  from?: string;
  to?: string;
  /** 耗时合计（秒），用于算平均值 */
  totalSeconds: number;
  withTime: number;
}

const ACCESS_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+"([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?"\s+(\d{3})\s+(\d+|-)\s*(.*)$/;

/** 解析一行，匹配不上返回 null */
export function parseAccessLine(line: string): AccessRow | null {
  const m = ACCESS_RE.exec(String(line || '').trim());
  if (!m) return null;
  const [, ip, , , time, method, path, statusRaw, bytesRaw, rest] = m;

  // 请求后可能还有 referer / ua / 耗时，按引号切
  let referer: string | undefined;
  let ua: string | undefined;
  let seconds: number | undefined;
  if (rest) {
    const quoted = rest.match(/"([^"]*)"/g) || [];
    if (quoted[0]) referer = quoted[0].slice(1, -1);
    if (quoted[1]) ua = quoted[1].slice(1, -1);
    // 末尾的裸数字当作耗时（0.123 这种）
    const tail = rest.replace(/"[^"]*"/g, '').trim();
    const num = tail.split(/\s+/).filter(Boolean).pop();
    if (num && /^\d+(?:\.\d+)?$/.test(num)) seconds = Number(num);
  }

  const status = Number(statusRaw) || 0;
  const bytes = bytesRaw === '-' ? 0 : Number(bytesRaw) || 0;

  return {
    ip,
    time,
    method,
    path,
    key: normalizePath(path),
    status,
    bytes,
    referer,
    ua,
    seconds,
    raw: line.trim(),
  };
}

/**
 * 路径归一：数字段与 UUID 段换成占位符，不然 `/users/1` 和 `/users/2` 会被算成两条。
 * 只替换「整段是数字」的情况，不动 `v2`、`api-1.0` 这类版本号。
 */
export function normalizePath(path: string): string {
  const noQuery = String(path || '').split('?')[0];
  return noQuery
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      return seg;
    })
    .join('/');
}

/** 一行就够判断：不在日志里的内容不会命中这个格式 */
export function looksLikeAccessLog(text: string): boolean {
  const first = String(text || '').trim().split('\n').find(l => l.trim());
  return !!first && ACCESS_RE.test(first.trim());
}

/** 解析整段，返回行与命中率 */
export function parseAccessLog(text: string): { rows: AccessRow[]; matched: number; total: number } {
  const lines = String(text || '').split('\n');
  const rows: AccessRow[] = [];
  let total = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    total += 1;
    const row = parseAccessLine(line);
    if (row) rows.push(row);
  }
  return { rows, matched: rows.length, total };
}

/** 聚合：状态分布 / Top 路径 / Top IP / 最慢 */
export function summarizeAccess(rows: AccessRow[]): AccessSummary {
  const statusMap = new Map<string, number>();
  const pathMap = new Map<string, { sample: string; count: number; fail: number; ms: number }>();
  const ipMap = new Map<string, number>();
  let totalSeconds = 0;
  let withTime = 0;
  let from: string | undefined;
  let to: string | undefined;

  rows.forEach((r) => {
    // 状态码为 '-' 或脏数据时 status 会是 0，别把它算进 "0xx" 里
    if (r.status > 0) {
      const bucket = `${Math.floor(r.status / 100)}xx`;
      statusMap.set(bucket, (statusMap.get(bucket) || 0) + 1);
    }

    const p = pathMap.get(r.key) || { sample: r.path, count: 0, fail: 0, ms: 0 };
    p.count += 1;
    if (r.status >= 400) p.fail += 1;
    if (typeof r.seconds === 'number') {
      p.ms += r.seconds * 1000;
      totalSeconds += r.seconds;
      withTime += 1;
    }
    pathMap.set(r.key, p);

    ipMap.set(r.ip, (ipMap.get(r.ip) || 0) + 1);
    if (!from) from = r.time;
    to = r.time;
  });

  const statusBuckets = ['2xx', '3xx', '4xx', '5xx']
    .map(label => ({ label, count: statusMap.get(label) || 0 }))
    .filter(b => b.count > 0);

  const topPaths = Array.from(pathMap.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count || b.fail - a.fail)
    .slice(0, 12);

  const topIps = Array.from(ipMap.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const slowest = rows
    .filter(r => typeof r.seconds === 'number')
    .sort((a, b) => (b.seconds || 0) - (a.seconds || 0))
    .slice(0, 8);

  return {
    total: rows.length,
    matched: rows.length,
    statusBuckets,
    topPaths,
    topIps,
    slowest,
    from,
    to,
    totalSeconds,
    withTime,
  };
}

/** 生成可粘贴的摘要 */
export function accessSummaryText(rows: AccessRow[]): string {
  const s = summarizeAccess(rows);
  if (!s.total) return '';
  const avg = s.withTime ? ` · 平均 ${Math.round((s.totalSeconds / s.withTime) * 1000)} ms` : '';
  const head = `${s.total} 条请求${s.from ? ` · ${s.from} ~ ${s.to}` : ''}${avg}`;
  const status = s.statusBuckets.map(b => `${b.label} ${b.count}`).join(' · ');
  const paths = s.topPaths.slice(0, 8).map((p, i) => {
    const avgMs = p.count && p.ms ? ` · 平均 ${Math.round(p.ms / p.count)} ms` : '';
    return `${i + 1}. ${p.key} × ${p.count}${p.fail ? `（失败 ${p.fail}）` : ''}${avgMs}`;
  });
  const ips = s.topIps.slice(0, 5).map(x => `${x.label} × ${x.count}`);
  return [
    head,
    `状态：${status}`,
    '─'.repeat(36),
    'Top 路径：',
    ...paths,
    '',
    `Top IP：${ips.join(' · ')}`,
  ].join('\n');
}
