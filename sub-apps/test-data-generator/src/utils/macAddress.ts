/**
 * MAC 地址生成器
 */
import type { MacAddressParams } from '../types/types'

/** 常见厂商 OUI 前缀 */
const VENDOR_OUIS: Record<string, string[]> = {
  cisco: ['00:1A:2B', '00:1B:2C', '00:1C:2D'],
  intel: ['00:1B:21', '00:1C:BF', '00:1D:72'],
  apple: ['00:1E:52', '00:1F:5B', '00:1A:4D'],
  dell: ['00:1E:4F', '00:1F:1A', '00:14:22'],
  hp: ['00:1C:C4', '00:1D:72', '00:1A:4B'],
  random: [],
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomByte(): string {
  return randInt(0, 255).toString(16).padStart(2, '0').toUpperCase()
}

function randomOui(): string {
  return `${randomByte()}:${randomByte()}:${randomByte()}`
}

export function generateMacAddress(separator: MacAddressParams['separator'] = ':', oui?: string): string {
  const prefix = oui || randomOui()
  const suffix = `${randomByte()}:${randomByte()}:${randomByte()}`

  const raw = `${prefix}:${suffix}`

  if (separator === '-') return raw.replace(/:/g, '-')
  if (separator === 'none') return raw.replace(/:/g, '')
  return raw
}

export function generateMacAddresses(count: number, params: MacAddressParams): string[] {
  const results = new Set<string>()
  while (results.size < count) {
    results.add(generateMacAddress(params.separator, params.oui))
  }
  return Array.from(results)
}
