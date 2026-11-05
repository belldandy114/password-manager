/**
 * URL / IP / 日期 生成器
 */

const URL_PREFIXES = ['https://', 'http://']
const URL_DOMAINS = [
  'example.com', 'test.cn', 'demo.org', 'api.service.com',
  'www.baidu.com', 'www.google.com', 'www.github.com',
  'internal-net.local', '192.168.1.1', '10.0.0.1',
]
const URL_PATHS = [
  '/api/v1/users', '/api/v1/orders', '/login', '/search',
  '/index.html', '/assets/js/main.js', '/upload',
  '/api/data?page=1&size=20', '/api/v2/products?category=electronics',
  '/download/file.zip', '/redirect?url=https://evil.com',
]

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)]
}

/** 生成 URL */
export function generateUrl(): string {
  return pick(URL_PREFIXES) + pick(URL_DOMAINS) + pick(URL_PATHS)
}

/** 生成 IPv4 */
export function generateIpv4(categories?: ('A' | 'B' | 'C' | 'private' | 'loopback')[]): string {
  const cats = categories && categories.length > 0 ? categories : ['A', 'B', 'C']

  if (categories?.includes('loopback')) return '127.0.0.1'
  if (categories?.includes('private')) {
    return `192.168.${randInt(0, 255)}.${randInt(1, 254)}`
  }

  const cat = pick(cats)
  switch (cat) {
    case 'A': return `${randInt(1, 126)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`
    case 'B': return `${randInt(128, 191)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`
    case 'C': return `${randInt(192, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`
    default: return `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`
  }
}

/** 生成 IPv6 */
export function generateIpv6(): string {
  const hextets: string[] = []
  for (let i = 0; i < 8; i++) {
    hextets.push(randInt(0, 65535).toString(16))
  }
  return hextets.join(':')
}

/** 生成日期字符串 */
export function generateDate(yearMin: number, yearMax: number, format: 'date' | 'datetime' | 'timestamp'): string {
  const year = randInt(yearMin, yearMax)
  const month = randInt(1, 12)
  const day = randInt(1, 28)
  const hour = randInt(0, 23)
  const min = randInt(0, 59)
  const sec = randInt(0, 59)

  const pad2 = (n: number) => n.toString().padStart(2, '0')

  switch (format) {
    case 'date':
      return `${year}-${pad2(month)}-${pad2(day)}`
    case 'datetime':
      return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(min)}:${pad2(sec)}`
    case 'timestamp':
      return `${year}${pad2(month)}${pad2(day)}${pad2(hour)}${pad2(min)}${pad2(sec)}`
  }
}

/** 批量生成 URL */
export function generateUrls(count: number): string[] {
  return Array.from({ length: count }, () => generateUrl())
}

/** 批量生成 IP */
export function generateIps(count: number, version: 4 | 6, categories?: ('A' | 'B' | 'C' | 'private' | 'loopback')[]): string[] {
  const set = new Set<string>()
  const gen = version === 4 ? () => generateIpv4(categories) : generateIpv6
  while (set.size < count) {
    set.add(gen())
  }
  return Array.from(set)
}

/** 批量生成日期 */
export function generateDates(count: number, yearMin: number, yearMax: number, format: 'date' | 'datetime' | 'timestamp'): string[] {
  return Array.from({ length: count }, () => generateDate(yearMin, yearMax, format))
}
