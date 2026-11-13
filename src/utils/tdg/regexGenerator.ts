/**
 * 正则表达式数据生成器
 * 使用 randexp 库根据正则表达式生成随机匹配数据
 */
import RandExp from 'randexp'

export interface RegexGeneratorParams {
  pattern: string
  flags?: string
}

/** 根据正则生成单条数据 */
export function generateFromRegex(pattern: string, flags?: string): string {
  try {
    const regex = flags ? new RegExp(pattern, flags) : new RegExp(pattern)
    const randexp = new (RandExp as any)(regex)
    return randexp.gen()
  } catch (e) {
    return `[正则错误: ${(e as Error).message}]`
  }
}

/** 批量生成 */
export function generateFromRegexBatch(count: number, pattern: string, flags?: string): string[] {
  const results = new Set<string>()
  while (results.size < count) {
    results.add(generateFromRegex(pattern, flags))
  }
  return Array.from(results)
}

/** 内置常用正则预设 */
export const REGEX_PRESETS: { label: string; pattern: string; desc: string }[] = [
  { label: '手机号', pattern: '1[3-9]\\d{9}', desc: '中国大陆 11 位手机号' },
  { label: '身份证', pattern: '[1-9]\\d{5}(19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]', desc: '18 位身份证（校验位不保证）' },
  { label: '邮箱', pattern: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', desc: '邮箱地址' },
  { label: 'IPv4', pattern: '(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)', desc: '四段 IP 地址' },
  { label: '日期', pattern: '(?:19|20)\\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])', desc: 'yyyy-MM-dd' },
  { label: '时间', pattern: '(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d', desc: 'HH:mm:ss' },
  { label: '邮政编码', pattern: '[1-9]\\d{5}', desc: '6 位邮编' },
  { label: '验证码', pattern: '\\d{6}', desc: '6 位纯数字验证码' },
  { label: '订单号', pattern: '[A-Z]{2}\\d{12}', desc: '两位大写字母 + 12 位数字' },
  { label: 'UUID', pattern: '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', desc: 'UUID v4 格式' },
  { label: '银联卡号', pattern: '62\\d{14}', desc: '62 开头 16 位（不校验 Luhn）' },
  { label: '用户名', pattern: '[a-zA-Z][a-zA-Z0-9_]{3,11}', desc: '字母开头，4–12 位' },
  { label: '版本号', pattern: '\\d+\\.\\d+\\.\\d+', desc: '形如 1.24.3' },
  { label: '16进制色值', pattern: '#[0-9a-fA-F]{6}', desc: '#RRGGBB' },
  { label: '数字区间', pattern: '[1-9]\\d{2}', desc: '100–999 三位数字' },
  { label: '字母数字混合', pattern: '[a-zA-Z0-9]{8}', desc: '8 位随机串' },
]
