/**
 * 银行卡号生成器（支持 Luhn 算法校验）
 */
import type { BankCardParams } from '../types/types'

/** 各大卡品牌 IIN（发卡行识别码）前缀 */
const CARD_PREFIXES: Record<string, string[]> = {
  visa: ['4'],
  mastercard: ['51', '52', '53', '54', '55', '2221', '2222', '2223', '2224', '2225', '2226', '2227', '2228', '2229', '223', '224', '225', '226', '227', '228', '229', '23', '24', '25', '26', '27', '271', '272'],
  unionpay: ['62', '81'],
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 生成 N 位随机数字字符串（不含校验位） */
function randomDigits(length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) {
    s += randInt(0, 9).toString()
  }
  return s
}

/**
 * Luhn 算法计算校验位
 * 返回使完整卡号通过 Luhn 校验的末位数字
 */
function luhnCheckDigit(partial: string): number {
  let sum = 0
  let alternate = true
  for (let i = partial.length - 1; i >= 0; i--) {
    let digit = parseInt(partial[i], 10)
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return (sum * 9) % 10
}

/**
 * 验证完整卡号是否通过 Luhn 校验
 */
export function isValidLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10)
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return sum % 10 === 0
}

/**
 * 生成银行卡号
 * @param brand 卡品牌
 * @returns 格式化后的卡号（每4位空格分隔）
 */
export function generateBankCard(brand: BankCardParams['brand'] = 'random'): string {
  const resolvedBrand = brand === 'random'
    ? randomChoice(['visa', 'mastercard', 'unionpay'])
    : brand

  const prefixes = CARD_PREFIXES[resolvedBrand]
  const prefix = randomChoice(prefixes)

  // 卡号长度：Visa 16位，MasterCard 16位，银联 16-19位
  let totalLength = 16
  if (resolvedBrand === 'unionpay') {
    totalLength = randomChoice([16, 17, 18, 19])
  }

  // 生成前缀后的中间数字（总长度 - 前缀长度 - 1位校验位）
  const bodyLength = totalLength - prefix.length - 1
  const body = randomDigits(bodyLength)

  const partial = prefix + body
  const checkDigit = luhnCheckDigit(partial)

  const full = partial + checkDigit

  // 格式化：每4位空格分隔
  return full.replace(/(\d{4})(?=\d)/g, '$1 ')
}

/** 生成多条银行卡号 */
export function generateBankCards(count: number, params: BankCardParams): string[] {
  const results = new Set<string>()
  while (results.size < count) {
    results.add(generateBankCard(params.brand))
  }
  return Array.from(results)
}
