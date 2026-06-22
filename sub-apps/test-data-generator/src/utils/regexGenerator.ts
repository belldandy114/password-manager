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
  { label: '手机号', pattern: '1[3-9]\\d{9}', desc: '中国大陆手机号' },
  { label: '邮箱', pattern: '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', desc: '邮箱地址' },
  { label: 'IPv4', pattern: '(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)', desc: 'IP 地址' },
  { label: '日期(yyyy-MM-dd)', pattern: '(?:19|20)\\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])', desc: '日期格式' },
  { label: '邮政编码', pattern: '[1-9]\\d{5}', desc: '6位邮编' },
  { label: '16进制色值', pattern: '#[0-9a-fA-F]{6}', desc: '#RRGGBB' },
  { label: '数字区间(100-999)', pattern: '[1-9]\\d{2}', desc: '3位数字' },
  { label: '字母数字混合', pattern: '[a-zA-Z0-9]{8}', desc: '8位随机' },
]
