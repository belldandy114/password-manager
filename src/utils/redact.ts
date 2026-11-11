/**
 * 敏感信息脱敏（纯函数，无 DOM / 无 IPC）。
 *
 * 使用场景：把日志、请求报文、缺陷描述贴给同事或贴进禅道之前，先把手机号、
 * 身份证、银行卡、邮箱、内网 IP 打码。两种输出：
 *  - `star`：可读的打码（138****8000），适合直接贴出去；
 *  - `token`：占位符 + 映射表（[手机号#1]=13800138000），方便自己在本地还原，
 *    映射表默认不落盘、不加密，由调用方决定是否保留。
 *
 * 约定：一次扫描按固定顺序处理，先长后短（身份证 → 银行卡 → 手机号 → 邮箱 → IP → 自定义词），
 * 已被替换的片段不会再被后面的规则二次命中，所以同一段文本重复脱敏是幂等的。
 */

export type RedactKind = 'idcard' | 'phone' | 'bankcard' | 'email' | 'ip' | 'custom';
export type RedactStyle = 'star' | 'token';

export interface RedactOptions {
  /** 启用的规则；未列出的不处理 */
  kinds: RedactKind[];
  style?: RedactStyle;
  /** 自定义敏感词（项目名、客户名、内网域名等），按字面量匹配 */
  customWords?: string[];
  /**
   * 自定义打码区间（1 基、含端点）：从第 maskFrom 位打到第 maskTo 位。
   * 留空则按各类型的默认口径（手机号留前 3 后 4、身份证留前 4 后 4 …）。
   * 只传 maskFrom 时打到结尾；只传 maskTo 时从第 1 位开始。
   */
  maskFrom?: number;
  maskTo?: number;
}

export interface RedactHit {
  kind: RedactKind;
  raw: string;
  masked: string;
  /** token 风格下的占位符；star 风格为空串 */
  token: string;
}

export interface RedactResult {
  text: string;
  hits: RedactHit[];
  /** 可直接存成一行一条的映射表；star 风格为空串 */
  mapping: string;
}

export const REDACT_KIND_LABEL: Record<RedactKind, string> = {
  idcard: '身份证',
  phone: '手机号',
  bankcard: '银行卡',
  email: '邮箱',
  ip: 'IP',
  custom: '自定义',
};

/** 星号个数按被遮住的字符数走：长度可变，还原时才能按字面量对回去 */
const maskStars = (len: number) => '*'.repeat(Math.max(1, Math.min(256, Math.floor(len))));

/**
 * 自定义区间打码：从第 from 位打到第 to 位（1 基、含端点）。
 * 越界自动收敛到 [1, len]，from > to 时只打 from 这一位。
 */
export function maskRange(raw: string, from?: number, to?: number): string {
  const src = String(raw == null ? '' : raw);
  const len = src.length;
  if (!len) return '';
  const hasFrom = typeof from === 'number' && Number.isFinite(from) && from > 0;
  const hasTo = typeof to === 'number' && Number.isFinite(to) && to > 0;
  if (!hasFrom && !hasTo) return src;
  const a = Math.max(1, Math.min(len, Math.floor(hasFrom ? (from as number) : 1)));
  const b = Math.max(a, Math.min(len, Math.floor(hasTo ? (to as number) : len)));
  return `${src.slice(0, a - 1)}${maskStars(b - a + 1)}${src.slice(b)}`;
}

/** star 风格的具体打码方式（保留可辨识的头尾，便于人工核对） */
const STAR_MASK: Record<Exclude<RedactKind, 'custom'>, (raw: string) => string> = {
  idcard: (raw) => `${raw.slice(0, 4)}${maskStars(raw.length - 8)}${raw.slice(-4)}`,
  phone: (raw) => `${raw.slice(0, 3)}${maskStars(raw.length - 7)}${raw.slice(-4)}`,
  bankcard: (raw) => `${raw.slice(0, 4)}${maskStars(raw.length - 8)}${raw.slice(-4)}`,
  email: (raw) => {
    const at = raw.lastIndexOf('@');
    if (at <= 0) return maskStars(raw.length);
    const local = raw.slice(0, at);
    const head = local.slice(0, 1);
    return `${head}${maskStars(Math.max(3, local.length - 1))}${raw.slice(at)}`;
  },
  ip: (raw) => {
    const parts = raw.split('.');
    if (parts.length !== 4) return maskStars(raw.length);
    return `${parts[0]}.${parts[1]}.*.*`;
  },
};

/** 规则顺序即优先级：长格式先吃，避免身份证被当成银行卡 */
const RULES: Array<{ kind: Exclude<RedactKind, 'custom'>; re: RegExp }> = [
  { kind: 'idcard', re: /(?<!\d)\d{17}[\dXx](?![\dXx])/g },
  { kind: 'bankcard', re: /(?<!\d)\d{16,19}(?!\d)/g },
  { kind: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'ip', re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g },
];

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 指定状态下调用方应使用的分隔符：映射表一行一条 `token=raw`。
 * raw 里可能有 `=`（一般不会），还原时按第一个 `=` 切。
 */
export function redactText(text: string, opts: RedactOptions): RedactResult {
  const src = String(text == null ? '' : text);
  if (!src) return { text: '', hits: [], mapping: '' };

  const kindSet = new Set(opts.kinds || []);
  const style: RedactStyle = opts.style === 'token' ? 'token' : 'star';
  const rangeMode = !!(opts.maskFrom || opts.maskTo);
  const hits: RedactHit[] = [];
  const counters: Partial<Record<RedactKind, number>> = {};
  let out = src;

  /** 星号风格的具体打码：给了区间就按区间，否则按类型的默认口径 */
  const maskOf = (kind: RedactKind, raw: string): string => {
    if (rangeMode) return maskRange(raw, opts.maskFrom, opts.maskTo);
    const fn = kind === 'custom' ? undefined : STAR_MASK[kind];
    return fn ? fn(raw) : maskStars(raw.length);
  };

  /**
   * 对单条规则做一次全局替换。回调里生成 masked / token，
   * 换掉的文本不会再被后续规则看到（顺序即优先级）。
   */
  const applyRule = (kind: RedactKind, re: RegExp) => {
    out = out.replace(re, (raw: string) => {
      counters[kind] = (counters[kind] || 0) + 1;
      const token = style === 'token' ? `[${REDACT_KIND_LABEL[kind]}#${counters[kind]!}]` : '';
      const masked = style === 'token' ? token : maskOf(kind, raw);
      hits.push({ kind, raw, masked, token });
      return masked;
    });
  };

  for (const rule of RULES) {
    if (!kindSet.has(rule.kind)) continue;
    applyRule(rule.kind, rule.re);
  }

  if (kindSet.has('custom')) {
    const words = (opts.customWords || [])
      .map((w) => String(w || '').trim())
      .filter(Boolean)
      // 长的先替换，避免「示例」把「示例科技」切碎
      .sort((a, b) => b.length - a.length);
    // 同一规则里词多，逐词替换（每个词都是字面量，不会互相干扰优先级）
    for (const word of words) {
      applyRule('custom', new RegExp(escapeReg(word), 'g'));
    }
  }

  /**
   * 映射表：token 风格存 `[手机号#1]=原文`，星号风格存 `138****8000=原文`。
   *
   * 星号原本是不可逆的，但只要打码后的字面量唯一，就能按字面量换回去——
   * 这也是「还原」页对星号脱敏同样有效的原因。两处不同的值打出同一串星号时
   * （例如同样前 3 后 4 的两个号码）只能还原成先遇到的那一个，这一点在 UI 里写明。
   */
  const seen = new Set<string>();
  const mapping = hits
    .filter((h) => {
      const key = h.token || h.masked;
      if (!key || key === h.raw || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((h) => `${h.token || h.masked}=${h.raw}`)
    .join('\n');

  return { text: out, hits, mapping };
}

/** 按映射把占位符 / 打码串换回原文；未知项原样保留。长的先换，避免前缀撞车 */
export function restoreText(text: string, mapping: string): string {
  let out = String(text == null ? '' : text);
  const pairs: Array<{ token: string; raw: string }> = [];
  for (const line of String(mapping || '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const token = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1);
    if (!token) continue;
    pairs.push({ token, raw });
  }
  pairs.sort((a, b) => b.token.length - a.token.length);
  for (const { token, raw } of pairs) out = out.split(token).join(raw);
  return out;
}

/** 按类型汇总命中数（UI 的数据条） */
export function countHits(hits: RedactHit[]): Array<{ kind: RedactKind; label: string; count: number }> {
  const map = new Map<RedactKind, number>();
  for (const h of hits) map.set(h.kind, (map.get(h.kind) || 0) + 1);
  return Array.from(map.entries()).map(([kind, count]) => ({
    kind,
    label: REDACT_KIND_LABEL[kind],
    count,
  }));
}