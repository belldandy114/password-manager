/**
 * 身份证生成器
 * - 大陆：18 位 GB 11643-1999 标准
 * - 香港：AB123456(7) 格式
 * - 澳门：8 位数字格式
 */

// 大陆地址码（省市区前 6 位，使用常见代码）
const AREA_CODES = [
  '110101', '110102', '110105', '110106', '110107', '110108', '110109', '110111',
  '120101', '120102', '120103', '120104', '120105', '120106',
  '310101', '310104', '310105', '310106', '310107', '310109', '310110',
  '440101', '440102', '440103', '440104', '440105', '440106', '440107',
  '440301', '440302', '440303', '440304',
  '440401', '440402', '440403', '440404',
  '510101', '510102', '510103', '510104', '510105', '510106', '510107',
  '330101', '330102', '330103', '330104', '330105', '330106',
  '320101', '320102', '320103', '320104', '320105', '320106',
]

// 加权因子
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
// 校验码对应表
const CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function pad4(n: number): string {
  return n.toString().padStart(4, '0')
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}

/** 生成大陆身份证 */
export function generateMainlandIdCard(params: { gender: 'male' | 'female' | 'random'; birthYearMin: number; birthYearMax: number }): string {
  const areaCode = AREA_CODES[randInt(0, AREA_CODES.length - 1)]

  const year = randInt(params.birthYearMin, params.birthYearMax)
  const month = randInt(1, 12)
  const day = randInt(1, 28)
  const birth = `${year}${pad2(month)}${pad2(day)}`

  // 顺序码：3 位，奇数男偶数女
  let seq = randInt(1, 999)
  if (params.gender === 'male' && seq % 2 === 0) seq++
  if (params.gender === 'female' && seq % 2 === 1) seq++
  if (seq > 999) seq = params.gender === 'male' ? 1 : 2

  const base = `${areaCode}${birth}${pad3(seq)}` // 3 位顺序码

  // 计算校验码
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += parseInt(base[i]) * WEIGHTS[i]
  }
  const checkIndex = sum % 11
  const checkCode = CHECK_CODES[checkIndex]

  return `${base}${checkCode}`
}

/** 生成香港身份证（格式：AB123456(7)） */
export function generateHkIdCard(): string {
  const letters = String.fromCharCode(65 + randInt(0, 25), 65 + randInt(0, 25))
  const digits = pad4(randInt(0, 9999)) + pad2(randInt(0, 99))
  // 简单校验码：字母值和 + 数字和 mod 11
  const checkVal = (letters.charCodeAt(0) - 64) + (letters.charCodeAt(1) - 64) +
    digits.split('').reduce((s, c) => s + parseInt(c), 0)
  const checkCode = checkVal % 11
  return `${letters}${digits}(${checkCode === 10 ? 'A' : checkCode})`
}

/** 生成澳门身份证（8 位数字 + 括号校验码） */
export function generateMacauIdCard(): string {
  const digits = pad4(randInt(0, 9999)) + pad4(randInt(0, 9999))
  // 简单校验
  const sum = digits.split('').reduce((s, c) => s + parseInt(c), 0)
  const checkCode = sum % 10
  return `${digits}(${checkCode})`
}

/** 生成身份证（根据 idType 直接生成对应类型，不再按比例混合） */
export function generateIdCard(params: {
  gender: 'male' | 'female' | 'random'
  birthYearMin: number
  birthYearMax: number
  idType: 'mainland' | 'hk' | 'macau'
}): string {
  if (params.idType === 'hk') return generateHkIdCard()
  if (params.idType === 'macau') return generateMacauIdCard()
  return generateMainlandIdCard(params)
}

/**
 * 提取身份证后 N 位（含港澳括号）
 * 大陆 18 位：取最后 N 位
 * 香港 AB123456(7)：取最后 N 字符
 * 澳门 12345678(9)：取最后 N 字符
 */
export function getIdCardLast6(value: string, digits = 6): string {
  return value.slice(-digits)
}
