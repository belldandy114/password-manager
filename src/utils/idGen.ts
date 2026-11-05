/**
 * 造号工具（工具箱「ID / 流水号」）
 *
 * 纯函数式，随机源可注入：单元测试用固定随机源保证可重复。
 */

export type IdKind = 'uuid' | 'trace' | 'order' | 'snowflake' | 'seq' | 'hex';

export interface IdOptions {
  kind: IdKind;
  /** hex 长度 / 序号补零宽度 */
  length?: number;
  /** 前缀（订单号常用） */
  prefix?: string;
  /** 序号起始值 */
  start?: number;
  /** 生成条数 */
  count?: number;
  /** 注入随机源，返回 [0,1) */
  random?: () => number;
  /** 注入时间（毫秒），便于测试 */
  now?: number;
}

function randHex(len: number, random: () => number): string {
  let s = '';
  while (s.length < len) s += Math.floor(random() * 16).toString(16);
  return s.slice(0, len);
}

function uuidv4(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  const variant = '89ab'[Math.floor(random() * 4)];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 雪花 ID：41 位时间戳 + 10 位机器 + 12 位序列（和常见实现一致，返回十进制字符串）
 * 这里用简化版：时间戳从 2020-01-01 起算，机器号取注入值（默认 1）。
 */
function snowflake(now: number, seq: number, machine = 1): string {
  const epoch = 1577808000000; // 2020-01-01T00:00:00Z
  const ts = BigInt(now - epoch) << BigInt(22);
  const mid = BigInt(machine & 0x3ff) << BigInt(12);
  return (ts + mid + BigInt(seq & 0xfff)).toString();
}

export interface IdResult {
  value: string;
  /** 序号类工具用来提示当前进度 */
  index?: number;
}

/** 生成一组 ID */
export function generateIds(opts: IdOptions): IdResult[] {
  const count = Math.max(1, Math.min(500, opts.count ?? 10));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now();
  const prefix = opts.prefix ?? '';
  const out: IdResult[] = [];

  for (let i = 0; i < count; i += 1) {
    const seq = (opts.start ?? 1) + i;
    switch (opts.kind) {
      case 'uuid':
        out.push({ value: prefix + uuidv4(random), index: i + 1 });
        break;
      case 'trace':
        out.push({ value: prefix + randHex(opts.length ?? 32, random), index: i + 1 });
        break;
      case 'hex':
        out.push({ value: prefix + randHex(opts.length ?? 8, random), index: i + 1 });
        break;
      case 'order': {
        // 时间戳 + 4 位随机，形如 202611021407591234
        const d = new Date(now);
        const p = (n: number, w = 2) => String(n).padStart(w, '0');
        const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        out.push({ value: `${prefix}${stamp}${randHex(4, random).replace(/[a-f]/g, (c) => String(c.charCodeAt(0) % 10))}`, index: i + 1 });
        break;
      }
      case 'snowflake':
        out.push({ value: prefix + snowflake(now + i, seq), index: i + 1 });
        break;
      case 'seq': {
        const width = Math.max(1, opts.length ?? 4);
        out.push({ value: `${prefix}${String(seq).padStart(width, '0')}`, index: seq });
        break;
      }
      default:
        out.push({ value: '', index: i + 1 });
    }
  }
  return out;
}

/** 当有多条时，复制用的文本 */
export function idsToText(rows: IdResult[]): string {
  return rows.map((r) => r.value).join('\n');
}