/**
 * Cron 解析与反向生成（工具箱「Cron」）
 *
 * 正向：表达式 → 中文描述 + 接下来几次执行时间
 * 反向：常见中文说法 → 表达式（只为高频场景，不做 NLP）
 */

export interface CronSpec {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  dows: number[];
}

function cronValues(seg: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  const pushRange = (from: number, to: number, step: number) => {
    if (step <= 0) return false;
    for (let v = from; v <= to; v += step) {
      if (v < min || v > max) return false;
      out.add(v);
    }
    return true;
  };

  for (const part of seg.split(',')) {
    const p = part.trim();
    if (!p) return null;
    let body = p;
    let step = 1;
    const slash = p.indexOf('/');
    if (slash >= 0) {
      body = p.slice(0, slash);
      step = Number(p.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    if (body === '*') {
      if (!pushRange(min, max, step)) return null;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (!pushRange(a, b, step)) return null;
    } else {
      const v = Number(body);
      if (!Number.isInteger(v) || v < min || v > max) return null;
      out.add(v);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** @ 别名（常见 cron 实现都支持） */
export const CRON_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** 展开别名并去掉多余空白 */
export function normalizeCron(expr: string): string {
  const t = String(expr || '').trim();
  const lower = t.toLowerCase();
  if (CRON_ALIASES[lower]) return CRON_ALIASES[lower];
  return t.replace(/\s+/g, ' ');
}

export function parseCron(expr: string): CronSpec | null {
  const parts = normalizeCron(expr).split(' ');
  if (parts.length !== 5) return null;
  const [mi, ho, da, mo, dw] = parts;
  const minutes = cronValues(mi, 0, 59);
  const hours = cronValues(ho, 0, 23);
  const days = cronValues(da, 1, 31);
  const months = cronValues(mo, 1, 12);
  const dows = cronValues(dw.replace(/7/g, '0'), 0, 6);
  if (!minutes || !hours || !days || !months || !dows) return null;
  return { minutes, hours, days, months, dows };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  return spec.minutes.includes(d.getMinutes())
    && spec.hours.includes(d.getHours())
    && spec.months.includes(d.getMonth() + 1)
    && spec.days.includes(d.getDate())
    && spec.dows.includes(d.getDay());
}

/** 接下来 n 次执行时间（从 from 之后开始，按分钟推进，最多找 2 年） */
export function nextRuns(expr: string, n = 5, from: Date = new Date()): string[] {
  const spec = parseCron(expr);
  if (!spec) return [];
  const cur = new Date(from.getTime());
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  const runs: string[] = [];
  const limit = 60 * 24 * 366 * 2;
  for (let i = 0; i < limit && runs.length < n; i += 1) {
    if (cronMatches(spec, cur)) runs.push(cur.toLocaleString('zh-CN', { hour12: false }));
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return runs;
}

const DOW_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 表达式 → 中文描述 */
export function describeCron(expr: string): string {
  const spec = parseCron(expr);
  if (!spec) return '表达式应为 5 段：分 时 日 月 周（例如 0 9 * * 1-5）';
  const p = normalizeCron(expr).split(' ');
  const seg: string[] = [];

  if (p[0].startsWith('*/')) seg.push(`每 ${p[0].slice(2)} 分钟`);
  else if (p[0] === '*') seg.push('每分钟');
  else if (p[0] === '0') { /* 整点，不重复描述 */ }
  else seg.push(`第 ${spec.minutes.join('、')} 分`);

  if (p[1] !== '*') seg.push(`${spec.hours.join('、')} 点`);

  if (p[4] !== '*') {
    const names = spec.dows.map((d) => DOW_NAMES[d] || `周${d}`);
    seg.push(names.join('、'));
  } else if (p[2] !== '*') {
    seg.push(`${spec.days.join('、')} 号`);
  }

  if (p[3] !== '*') seg.push(`${spec.months.join('、')} 月`);

  return seg.length ? seg.join(' · ') : '每分钟';
}

export interface CronPreset {
  label: string;
  expr: string;
}

/** 反向：常用中文说法 → 表达式 */
export const CRON_PRESETS: CronPreset[] = [
  { label: '每分钟', expr: '* * * * *' },
  { label: '每 5 分钟', expr: '*/5 * * * *' },
  { label: '每 30 分钟', expr: '*/30 * * * *' },
  { label: '每小时整点', expr: '0 * * * *' },
  { label: '每天 0 点', expr: '0 0 * * *' },
  { label: '每天 9 点', expr: '0 9 * * *' },
  { label: '每天 9 点和 18 点', expr: '0 9,18 * * *' },
  { label: '工作日 9 点', expr: '0 9 * * 1-5' },
  { label: '每周一 9 点', expr: '0 9 * * 1' },
  { label: '每月 1 号 0 点', expr: '0 0 1 * *' },
  { label: '每月最后一天 23 点', expr: '0 23 L * *' },
  { label: '每年 1 月 1 日 0 点', expr: '0 0 1 1 *' },
];

/**
 * 反向生成：把自然语言说法匹配到预设（支持包含关系，忽略空格与「的」）。
 * 找不到就返回 null，由界面提示「请从预设里选或直接写表达式」。
 */
export function cronFromText(text: string): string | null {
  const t = String(text || '').replace(/\s+/g, '').replace(/的/g, '').toLowerCase();
  if (!t) return null;
  const exact = CRON_PRESETS.find((x) => x.label.replace(/\s+/g, '').replace(/的/g, '').toLowerCase() === t);
  if (exact) return exact.expr;
  const partial = CRON_PRESETS.find((x) => x.label.replace(/\s+/g, '').toLowerCase().includes(t));
  return partial ? partial.expr : null;
}