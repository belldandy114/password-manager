/**
 * 随机图片占位图链接生成器
 * 支持 picsum.photos 和 via.placeholder.com
 */
import type { ImagePlaceholderParams } from '../types/types'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function generatePlaceholderUrl(params: ImagePlaceholderParams): string {
  const { width, height, service } = params

  if (service === 'picsum') {
    const seed = randInt(1, 1000)
    return `https://picsum.photos/seed/${seed}/${width}/${height}`
  }

  // via.placeholder.com
  const bg = randInt(0, 0xFFFFFF).toString(16).padStart(6, '0')
  const fg = randInt(0, 0xFFFFFF).toString(16).padStart(6, '0')
  const text = `${width}×${height}`
  return `https://via.placeholder.com/${width}x${height}/${bg}/${fg}?text=${encodeURIComponent(text)}`
}

export function generatePlaceholderUrls(count: number, params: ImagePlaceholderParams): string[] {
  // 每个 URL 不同 seed，所以不用去重
  const results: string[] = []
  for (let i = 0; i < count; i++) {
    results.push(generatePlaceholderUrl(params))
  }
  return results
}
