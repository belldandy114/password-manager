/**
 * 手机号生成器（中国大陆号段）
 */

const ALL_PREFIXES = [
  '130', '131', '132', '133', '134', '135', '136', '137', '138', '139',
  '145', '146', '147', '148', '149',
  '150', '151', '152', '153', '155', '156', '157', '158', '159',
  '162', '165', '166', '167',
  '170', '171', '172', '173', '175', '176', '177', '178',
  '180', '181', '182', '183', '184', '185', '186', '187', '188', '189',
  '190', '191', '192', '193', '195', '196', '197', '198', '199',
]

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)]
}

function pad4(n: number): string {
  return n.toString().padStart(4, '0')
}

/** 生成单个手机号 */
export function generatePhone(prefixes?: string[]): string {
  const prefix = pick(prefixes || ALL_PREFIXES)
  const suffix = pad4(randInt(0, 9999)) + pad4(randInt(0, 9999))
  return prefix + suffix
}

/** 批量生成手机号 */
export function generatePhones(count: number, prefixes?: string[]): string[] {
  const set = new Set<string>()
  while (set.size < count) {
    set.add(generatePhone(prefixes))
  }
  return Array.from(set)
}
