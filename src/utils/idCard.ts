/**
 * 身份证校验（工具箱「数据校验」）
 *
 * 之前只校验「18 位 + 数字」，会把随便编的号码判成合法——
 * 实际身份证最后一位是按前 17 位算出来的校验码（ISO 7064:1983 MOD 11-2）。
 */

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

export interface IdCardInfo {
  valid: boolean;
  /** 校验位是否符合规则 */
  checksumOk?: boolean;
  /** 格式是否合格（18 位） */
  formatOk?: boolean;
  birthday?: string;
  gender?: '男' | '女' | '';
  region?: string;
  /** 年龄（粗略，按今天算） */
  age?: number;
  error?: string;
}

/** 计算 18 位身份证的校验位（前 17 位） */
export function idCardCheckCode(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(first17[i]) * WEIGHTS[i];
  return CHECK_CODES[sum % 11];
}

/** 校验 18 位身份证（含校验位、生日合法性） */
export function validateIdCard(raw: string): IdCardInfo {
  const id = String(raw || '').trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) {
    return { valid: false, formatOk: false, error: '应为 18 位（前 17 位数字，最后一位数字或 X）' };
  }

  const expect = idCardCheckCode(id.slice(0, 17));
  const checksumOk = expect === id[17];

  const y = Number(id.slice(6, 10));
  const m = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const date = new Date(y, m - 1, d);
  const birthdayOk = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d && y >= 1900 && y <= new Date().getFullYear();

  if (!checksumOk) return { valid: false, formatOk: true, checksumOk: false, error: `校验位应为 ${expect}` };
  if (!birthdayOk) return { valid: false, formatOk: true, checksumOk: true, error: `出生日期不合法：${y}-${m}-${d}` };

  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1;

  return {
    valid: true,
    formatOk: true,
    checksumOk: true,
    birthday: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    gender: Number(id[16]) % 2 === 1 ? '男' : '女',
    region: id.slice(0, 6),
    age,
  };
}