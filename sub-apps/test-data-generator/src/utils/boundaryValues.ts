/**
 * 边界值 / 特殊字符生成器
 */

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 空字符串 */
function generateEmpty(): string {
  return ''
}

/** 超长字符串：中英文特殊字符混合 */
function generateOversize(extraLength: number): string {
  const zhStart = 0x4e00
  const zhRange = 0x9fa5 - 0x4e00
  const en = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const num = '0123456789'
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`\'" \\'
  const pools = [zhStart, en, num, special]  // zhStart as marker for Chinese

  let result = ''
  for (let i = 0; i < extraLength; i++) {
    const pool = pools[Math.floor(Math.random() * pools.length)]
    if (pool === zhStart) {
      result += String.fromCharCode(zhStart + Math.floor(Math.random() * zhRange))
    } else {
      result += (pool as string)[Math.floor(Math.random() * (pool as string).length)]
    }
  }
  return result
}

/** Unicode 边界 */
function generateUnicode(): string {
  const candidates = [
    '\u0000', '\u0001', '\u0008', '\u0009', '\u000A', '\u000D', '\u001B', '\u007F',
    '\u0080', '\u00FF', '\u0100', '\u2000', '\u200B', '\u200C', '\u200D', '\u2028',
    '\u2029', '\u202E', '\uFEFF', '\uFFFE', '\uFFFF',
    '\uD800\uDC00', // surrogate pair
    '\u{1F600}', '\u{1F601}', '\u{1F602}', // emoji via surrogate pairs
  ]
  // 随机选 3-8 个组合
  const count = randInt(3, 8)
  return Array.from({ length: count }, () => candidates[randInt(0, candidates.length - 1)]).join('')
}

/** Emoji 字符串 */
function generateEmoji(): string {
  const emojis = [
    '😀', '😂', '🤣', '❤️', '🔥', '👍', '🎉', '🚀', '💯', '✅',
    '❌', '⚠️', '🔴', '🟢', '🔵', '⭐', '🌈', '🌍', '🎸', '🏆',
    '📚', '💻', '🔐', '🛡️', '⚡', '❄️', '🌊', '🔥', '💀', '👻',
    '🤖', '👽', '💩', '👑', '💰', '🔪', '💣', '🧨', '📌', '🎯',
  ]
  const count = randInt(2, 10)
  return Array.from({ length: count }, () => emojis[randInt(0, emojis.length - 1)]).join('')
}

/** RTL 字符串（含 Unicode 双向覆盖字符） */
function generateRtl(): string {
  const rtlTexts = [
    '\u202ESystem failure\u202C',
    '\u202Estd::cout << "Hello" \u202C',
    'abc\u202Edef\u202Cghi',
    '\u202Bسلام\u202C',
    '\u202E3.25$ \u202C- 刚好等于价格',
  ]
  return rtlTexts[randInt(0, rtlTexts.length - 1)]
}

/** 零宽字符字符串 */
function generateZeroWidth(): string {
  const chars = '\u200B\u200C\u200D\uFEFF\u2060\u2061\u2062\u2063\u2064'
  const count = randInt(5, 20)
  return Array.from({ length: count }, () => chars[randInt(0, chars.length - 1)]).join('')
}

/** 换行符混合字符串 */
function generateNewline(): string {
  const parts = [
    'line1\nline2\r\nline3',
    'windows\r\nstyle\r\nbreaks',
    'unix\nstyle\nonly',
    'mixed\r\nstyles\nin\rone',
    '\n\n\nempty\nlines\n\n\n',
    'trailing newline\n',
    '\nleading newline',
    'tab\tseparated\tvalues',
  ]
  return parts[randInt(0, parts.length - 1)]
}

/** 生成边界值数据 */
export function generateBoundary(
  types: ('empty' | 'oversize' | 'unicode' | 'emoji' | 'rtl' | 'zerowidth' | 'newline')[],
  extraLength: number
): string[] {
  const result: string[] = []
  for (const type of types) {
    switch (type) {
      case 'empty':
        result.push(generateEmpty())
        break
      case 'oversize':
        result.push(generateOversize(extraLength))
        break
      case 'unicode':
        result.push(generateUnicode())
        break
      case 'emoji':
        result.push(generateEmoji())
        break
      case 'rtl':
        result.push(generateRtl())
        break
      case 'zerowidth':
        result.push(generateZeroWidth())
        break
      case 'newline':
        result.push(generateNewline())
        break
    }
  }
  return result
}
