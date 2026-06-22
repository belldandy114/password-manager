/**
 * 邮箱生成器
 * 多域名 + 用户名模式（含特殊字符）
 */

const COMMON_DOMAINS = [
  'qq.com', '163.com', '126.com', 'gmail.com', 'outlook.com',
  'hotmail.com', 'yahoo.com', 'icloud.com', 'foxmail.com',
  'sina.com', 'sohu.com', 'aliyun.com', 'live.com',
]

const USERNAME_PREFIXES = [
  'test', 'user', 'admin', 'hello', 'mail', 'service',
  'contact', 'info', 'support', 'dev', 'web', 'app',
]

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)]
}

function randomString(len: number, chars: string): string {
  let result = ''
  for (let i = 0; i < len; i++) {
    result += chars[randInt(0, chars.length - 1)]
  }
  return result
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyz'
const ALPHA_NUM = ALPHA + '0123456789'
const SPECIAL_DOT = ALPHA_NUM + '.-_'

/** 生成单个邮箱 */
export function generateEmail(domains?: string[], allowSpecialChars = true): string {
  const domain = pick(domains || COMMON_DOMAINS)

  const pattern = randInt(0, 2)
  let local = ''

  switch (pattern) {
    case 0: // test.xxx@domain
      local = pick(USERNAME_PREFIXES) + '.' + randomString(randInt(4, 8), ALPHA)
      break
    case 1: // name_year@domain
      local = randomString(randInt(4, 6), ALPHA) + randInt(10, 99)
      break
    case 2: // name+tag@domain
      local = randomString(randInt(5, 10), ALPHA_NUM)
      if (allowSpecialChars) {
        local += '+' + randomString(randInt(2, 4), ALPHA)
      }
      break
  }

  // 随机加点号或横线
  if (allowSpecialChars && Math.random() < 0.3) {
    const idx = randInt(2, local.length - 2)
    const sep = Math.random() < 0.5 ? '.' : '-'
    local = local.slice(0, idx) + sep + local.slice(idx)
  }

  return `${local}@${domain}`
}

/** 批量生成邮箱 */
export function generateEmails(count: number, domains?: string[], allowSpecialChars = true): string[] {
  const set = new Set<string>()
  while (set.size < count) {
    set.add(generateEmail(domains, allowSpecialChars))
  }
  return Array.from(set)
}
