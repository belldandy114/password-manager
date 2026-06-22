/**
 * UUID/GUID v4 生成器
 */

function randHex(length: number): string {
  let s = ''
  const chars = '0123456789abcdef'
  for (let i = 0; i < length; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]
  }
  return s
}

/** 生成一个 UUID v4 */
export function generateUuid(): string {
  // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const part1 = randHex(8)
  const part2 = randHex(4)
  const part3 = `4${randHex(3)}`
  const part4 = `89ab`[Math.floor(Math.random() * 4)] + randHex(3)
  const part5 = randHex(12)
  return `${part1}-${part2}-${part3}-${part4}-${part5}`
}

/** 生成 N 个 UUID */
export function generateUuids(count: number): string[] {
  const results = new Set<string>()
  while (results.size < count) {
    results.add(generateUuid())
  }
  return Array.from(results)
}
