/**
 * 车牌号生成器
 * 支持：蓝牌(普通)、绿牌(新能源)、使馆牌、警用车牌
 */
import type { GeneratorId } from '../types/types'

/** 省级行政区简称 */
const PROVINCES = [
  '京', '津', '沪', '渝', '冀', '豫', '云', '辽', '黑', '湘',
  '皖', '鲁', '新', '苏', '浙', '赣', '鄂', '桂', '甘', '晋',
  '蒙', '陕', '吉', '闽', '贵', '粤', '川', '青', '藏', '琼',
  '宁',
]

/** 发牌机关字母（城市代码） */
const CITY_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 蓝牌字符集：字母+数字（不含 I/O 避免混淆） */
const BLUE_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** 新能源车牌第1位只能是字母 D/F */
const NEW_ENERGY_FIRST = 'DF'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomStr(chars: string, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) {
    s += chars[randInt(0, chars.length - 1)]
  }
  return s
}

/** 蓝牌: 省份+城市+5位（字母+数字） */
function generateBluePlate(): string {
  const province = randomChoice(PROVINCES)
  const city = randomChoice(CITY_LETTERS)
  // 第1位可为字母或数字，但通常第1位是字母
  const chars = randomChoice(BLUE_CHARS) + randomStr(BLUE_CHARS, 4)
  return `${province}${city}·${chars}`
}

/** 绿牌（新能源）: 6位 省份+城市+D/F+5位数字 */
function generateGreenPlate(): string {
  const province = randomChoice(PROVINCES)
  const city = randomChoice(CITY_LETTERS)
  const first = randomChoice(NEW_ENERGY_FIRST)
  const digits = randomStr('0123456789', 5)
  return `${province}${city}·${first}${digits}`
}

/** 使馆牌: 使+3位数字+·+3位数字 */
function generateEmbassyPlate(): string {
  const num1 = String(randInt(100, 999))
  const num2 = String(randInt(100, 999))
  return `使·${num1}${num2}`
}

/** 警用车牌 */
function generatePolicePlate(): string {
  const province = randomChoice(PROVINCES)
  const city = randomChoice(CITY_LETTERS)
  const digits = randomStr('0123456789', 5)
  return `${province}${city}·${digits}警`
}

export type PlateType = 'blue' | 'green' | 'embassy' | 'police' | 'random'

const PLATE_TYPES: PlateType[] = ['blue', 'green', 'embassy', 'police']

export function generateLicensePlate(type: PlateType = 'random'): string {
  const resolved = type === 'random' ? randomChoice(PLATE_TYPES) : type
  switch (resolved) {
    case 'blue': return generateBluePlate()
    case 'green': return generateGreenPlate()
    case 'embassy': return generateEmbassyPlate()
    case 'police': return generatePolicePlate()
  }
}

export function generateLicensePlates(count: number, type: PlateType): string[] {
  const results = new Set<string>()
  while (results.size < count) {
    results.add(generateLicensePlate(type))
  }
  return Array.from(results)
}
