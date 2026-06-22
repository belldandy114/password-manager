/**
 * Lorem Ipsum 段落文本生成器
 * 支持中文和英文伪段落
 */
import type { LoremIpsumParams } from '../types/types'

// ── 英文 Lorem Ipsum 词库 ──
const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'dolor', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur',
  'sint', 'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui',
  'officia', 'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
]

// ── 中文常用词 ──
const ZH_WORDS = [
  '测试', '数据', '生成', '系统', '工具', '用户', '信息', '管理', '服务', '应用',
  '开发', '设计', '实现', '功能', '模块', '接口', '平台', '架构', '性能', '安全',
  '质量', '流程', '配置', '部署', '监控', '报警', '日志', '分析', '优化', '迭代',
  '版本', '上线', '验证', '检查', '审核', '发布', '集成', '交付', '持续', '自动',
  '计算', '存储', '网络', '资源', '调度', '策略', '规则', '标准', '规范', '模型',
]

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** 生成一个英文句子 */
function generateEnSentence(): string {
  const wordCount = randInt(5, 15)
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(randomChoice(LOREM_WORDS))
  }
  // 首字母大写 + 句号
  return capitalize(words.join(' ')) + '.'
}

/** 生成一个中文句子 */
function generateZhSentence(): string {
  const wordCount = randInt(5, 15)
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(randomChoice(ZH_WORDS))
  }
  return words.join('') + '。'
}

/** 生成英文段落 */
function generateEnParagraph(sentenceCount: number): string {
  const sentences: string[] = []
  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(generateEnSentence())
  }
  return sentences.join(' ')
}

/** 生成中文段落 */
function generateZhParagraph(sentenceCount: number): string {
  const sentences: string[] = []
  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(generateZhSentence())
  }
  return sentences.join('')
}

/** 生成段落文本 */
export function generateLoremIpsum(params: LoremIpsumParams): string {
  const { language, paragraphs, sentencesPerParagraph } = params
  const result: string[] = []

  for (let i = 0; i < paragraphs; i++) {
    const para = language === 'en'
      ? generateEnParagraph(sentencesPerParagraph)
      : generateZhParagraph(sentencesPerParagraph)
    result.push(para)
  }

  // 段落间用双换行
  return result.join('\n\n')
}

/** 生成 N 段段落文本 */
export function generateLoremIpsumItems(count: number, params: LoremIpsumParams): string[] {
  const results: string[] = []
  for (let i = 0; i < count; i++) {
    results.push(generateLoremIpsum(params))
  }
  return results
}
