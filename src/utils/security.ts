import type { PasswordEntry } from '../types';

/** 常见弱密码（小写比较） */
const COMMON_WEAK = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', 'password', 'passw0rd',
  'admin', 'admin123', 'root', 'qwerty', 'qwerty123', 'abc123', '111111', '000000',
  '888888', '666666', '123123', '1qaz2wsx', 'qazwsx', 'iloveyou', 'letmein', 'welcome',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'master', 'shadow',
  'test', 'test123', 'guest', 'changeme', 'secret', 'a123456', 'zxcvbnm', 'asdfgh',
  'p@ssw0rd', 'password1', 'password123', 'admin888', 'woaini', '5201314',
]);

const SEQUENCES = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export interface PasswordIssue {
  type: 'weak' | 'duplicate';
  entryIds: string[];
  /** 给用户看的一句话结论 */
  message: string;
  detail?: string;
}

export interface SecurityReport {
  total: number;
  weak: PasswordIssue[];
  duplicates: PasswordIssue[];
  expired: PasswordIssue[];
  empty: number;
  /** 0-100，分数越高越安全 */
  score: number;
}

/** 密码超过这个天数没改过就算「过期」 */
export const PASSWORD_MAX_AGE_DAYS = 180;

/** 返回 0-4 分强度（附带原因），供 UI 展示 */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string; reasons: string[] } {
  const reasons: string[] = [];
  if (!pw) return { score: 0, label: '空', reasons: ['密码为空'] };

  const lower = pw.toLowerCase();
  if (COMMON_WEAK.has(lower)) return { score: 1, label: '极弱', reasons: ['常见弱密码'] };
  if (/^\d+$/.test(pw)) reasons.push('纯数字');
  if (/^[a-zA-Z]+$/.test(pw)) reasons.push('纯字母');
  if (pw.length < 8) reasons.push('长度不足 8 位');
  if (SEQUENCES.some(s => s.includes(lower) && lower.length >= 4)) reasons.push('包含键盘/字母序列');

  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^\w\s]/.test(pw)) score++;
  if (reasons.length > 0) score = Math.min(score, 1);

  const clamped = Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;
  const label = ['极弱', '弱', '一般', '强', '很强'][clamped];
  return { score: clamped, label, reasons };
}

export function isWeakPassword(pw: string): boolean {
  if (!pw) return false; // 空密码单独统计，不算"弱"
  return passwordStrength(pw).score <= 1;
}

export function buildSecurityReport(entries: PasswordEntry[]): SecurityReport {
  const withPw = entries.filter(e => !!e.password);
  const empty = entries.length - withPw.length;

  const weak: PasswordIssue[] = withPw
    .filter(e => isWeakPassword(e.password))
    .map(e => ({
      type: 'weak' as const,
      entryIds: [e.id],
      message: `「${e.name}」密码强度不足`,
      detail: `${passwordStrength(e.password).label}：${passwordStrength(e.password).reasons.join('、') || '过于简单'}`,
    }));

  // 同一密码被多条使用（忽略空密码）
  const byPw = new Map<string, PasswordEntry[]>();
  for (const e of withPw) {
    const list = byPw.get(e.password) || [];
    list.push(e);
    byPw.set(e.password, list);
  }
  const duplicates: PasswordIssue[] = [];
  for (const [, list] of byPw) {
    if (list.length < 2) continue;
    duplicates.push({
      type: 'duplicate',
      entryIds: list.map(e => e.id),
      message: `${list.length} 个网址共用同一个密码`,
      detail: list.map(e => e.name).join('、').slice(0, 80),
    });
  }

  // 长期未修改的密码
  const expired: PasswordIssue[] = [];
  const now = Date.now();
  for (const e of withPw) {
    const base = e.passwordUpdatedAt || e.updatedAt || e.createdAt;
    if (!base) continue;
    const days = Math.floor((now - new Date(base).getTime()) / 86400000);
    if (days >= PASSWORD_MAX_AGE_DAYS) {
      expired.push({
        type: 'weak',
        entryIds: [e.id],
        message: `「${e.name}」密码已 ${days} 天未修改`,
        detail: `建议定期更换（超过 ${PASSWORD_MAX_AGE_DAYS} 天）`,
      });
    }
  }

  const problemEntries = new Set<string>();
  weak.forEach(w => w.entryIds.forEach(id => problemEntries.add(id)));
  duplicates.forEach(d => d.entryIds.forEach(id => problemEntries.add(id)));
  expired.forEach(x => x.entryIds.forEach(id => problemEntries.add(id)));

  const ratio = entries.length === 0 ? 1 : 1 - problemEntries.size / entries.length;
  const score = Math.round(
    Math.max(0, Math.min(1, ratio)) * 80 +
    (empty === 0 ? 20 : Math.max(0, 20 - empty * 5)),
  );

  return { total: entries.length, weak, duplicates, expired, empty, score };
}

/** 供列表角标使用：条目是否存在问题 */
export function entrySecurityFlags(entries: PasswordEntry[]): Record<string, { weak: boolean; duplicate: boolean }> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!e.password) continue;
    counts.set(e.password, (counts.get(e.password) || 0) + 1);
  }
  const flags: Record<string, { weak: boolean; duplicate: boolean }> = {};
  for (const e of entries) {
    flags[e.id] = {
      weak: isWeakPassword(e.password),
      duplicate: !!e.password && (counts.get(e.password) || 0) > 1,
    };
  }
  return flags;
}
