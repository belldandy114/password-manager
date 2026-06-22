/**
 * 生成器主编排模块
 * 统一入口，将所有生成器整合在一起
 */

import { generateIdCard, getIdCardLast6 } from './idCard'
import { generateName, generateNames, generateNamesWithPinyin } from './nameGenerator'
import { generateEmail } from './emailGenerator'
import { generateLongText } from './longText'
import { generatePhone } from './phoneGenerator'
import { generateUrl, generateIpv4, generateIpv6, generateDate } from './urlIpDate'
import { generateBoundary } from './boundaryValues'
import { getPayloadValues, PAYLOADS } from './sqlInjection'
import { generateBankCards } from './bankCard'
import { generateLicensePlates } from './licensePlate'
import { generateMacAddresses } from './macAddress'
import { generateUuids } from './uuidGenerator'
import { generatePlaceholderUrls } from './imagePlaceholder'
import { generateLoremIpsumItems } from './loremIpsum'
import { generateFromRegexBatch } from './regexGenerator'
import type { GenerateConfig, GenerateResultItem } from '../types/types'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 对数组去重（保持顺序） */
export function deduplicate(items: GenerateResultItem[]): GenerateResultItem[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.value)) return false
    seen.add(item.value)
    return true
  })
}

/** 根据配置生成数据 */
export function generateData(config: GenerateConfig): GenerateResultItem[] {
  const results: GenerateResultItem[] = []

  switch (config.id) {
    case 'sqlInjection': {
      const values = getPayloadValues()
      for (let i = 0; i < config.count; i++) {
        results.push({
          id: results.length + 1,
          type: 'SQL注入/XSS',
          value: values[i % values.length],
        })
      }
      break
    }

    case 'idCard': {
      const p = config.idCard!
      for (let i = 0; i < config.count; i++) {
        const value = generateIdCard({
          gender: p.gender,
          birthYearMin: p.birthYearMin,
          birthYearMax: p.birthYearMax,
          idType: p.idType,
        })
        results.push({
          id: results.length + 1,
          type: p.idType === 'hk' ? '香港身份证' : p.idType === 'macau' ? '澳门身份证' : '身份证',
          value,
          last6: getIdCardLast6(value, config.idCardLastDigits),
        })
      }
      break
    }

    case 'name': {
      const ethnicity = config.nameEthnicity || 'random'
      if (config.nameWithPinyin) {
        const items = generateNamesWithPinyin(config.count, undefined, ethnicity)
        for (const item of items) {
          results.push({
            id: results.length + 1,
            type: '姓名',
            value: `${item.name} (${item.pinyin})`,
          })
        }
      } else {
        const items = generateNames(config.count, undefined, ethnicity)
        for (const item of items) {
          results.push({
            id: results.length + 1,
            type: '姓名',
            value: item,
          })
        }
      }
      break
    }

    case 'email': {
      const p = config.email!
      for (let i = 0; i < config.count; i++) {
        results.push({
          id: results.length + 1,
          type: '邮箱',
          value: generateEmail(p.domains, p.allowSpecialChars),
        })
      }
      break
    }

    case 'longText': {
      const p = config.longText!
      const len = randInt(p.minLength, p.maxLength)
      for (let i = 0; i < config.count; i++) {
        results.push({
          id: results.length + 1,
          type: `超长文本(${p.language})`,
          value: generateLongText(p.language, len, len + 50),
        })
      }
      break
    }

    case 'phone': {
      const p = config.phone!
      const phones = new Set<string>()
      while (phones.size < config.count) {
        phones.add(generatePhone(p.prefixes))
      }
      for (const phone of phones) {
        results.push({
          id: results.length + 1,
          type: '手机号',
          value: phone,
        })
      }
      break
    }

    case 'url': {
      for (let i = 0; i < config.count; i++) {
        results.push({
          id: results.length + 1,
          type: 'URL',
          value: generateUrl(),
        })
      }
      break
    }

    case 'ip': {
      const p = config.ip!
      const ips = new Set<string>()
      const gen = p.version === 4
        ? () => generateIpv4(p.categories)
        : generateIpv6
      while (ips.size < config.count) {
        ips.add(gen())
      }
      for (const ip of ips) {
        results.push({
          id: results.length + 1,
          type: `IP${p.version === 4 ? 'v4' : 'v6'}`,
          value: ip,
        })
      }
      break
    }

    case 'date': {
      const p = config.date!
      for (let i = 0; i < config.count; i++) {
        results.push({
          id: results.length + 1,
          type: '日期',
          value: generateDate(p.yearMin, p.yearMax, p.format),
        })
      }
      break
    }

    case 'boundary': {
      const p = config.boundary!
      const values = generateBoundary(p.types, p.extraLength)
      for (const val of values) {
        results.push({
          id: results.length + 1,
          type: '边界值',
          value: val,
        })
      }
      // 如果数量不够，循环补齐
      let i = 0
      while (results.length < config.count) {
        const val = values[i % values.length]
        results.push({
          id: results.length + 1,
          type: '边界值',
          value: val,
        })
        i++
      }
      break
    }

    case 'bankCard': {
      const p = config.bankCard!
      const cards = generateBankCards(config.count, p)
      for (const card of cards) {
        results.push({
          id: results.length + 1,
          type: '银行卡号',
          value: card,
        })
      }
      break
    }

    case 'licensePlate': {
      const p = config.licensePlate!
      const plates = generateLicensePlates(config.count, p.type)
      for (const plate of plates) {
        results.push({
          id: results.length + 1,
          type: '车牌号',
          value: plate,
        })
      }
      break
    }

    case 'macAddress': {
      const p = config.macAddress!
      const addrs = generateMacAddresses(config.count, p)
      for (const addr of addrs) {
        results.push({
          id: results.length + 1,
          type: 'MAC地址',
          value: addr,
        })
      }
      break
    }

    case 'uuid': {
      const uuids = generateUuids(config.count)
      for (const uuid of uuids) {
        results.push({
          id: results.length + 1,
          type: 'UUID',
          value: uuid,
        })
      }
      break
    }

    case 'imagePlaceholder': {
      const p = config.imagePlaceholder!
      const urls = generatePlaceholderUrls(config.count, p)
      for (const url of urls) {
        results.push({
          id: results.length + 1,
          type: '占位图链接',
          value: url,
        })
      }
      break
    }

    case 'loremIpsum': {
      const p = config.loremIpsum!
      const items = generateLoremIpsumItems(config.count, p)
      for (const item of items) {
        results.push({
          id: results.length + 1,
          type: `段落文本(${p.language === 'en' ? 'EN' : '中文'})`,
          value: item,
        })
      }
      break
    }

    case 'regex': {
      const pattern = config.regexPattern || '\\d{4}-\\d{4}-\\d{4}'
      const flags = config.regexFlags
      const items = generateFromRegexBatch(config.count, pattern, flags)
      for (const item of items) {
        results.push({
          id: results.length + 1,
          type: '正则匹配',
          value: item,
        })
      }
      break
    }
  }

  // 排除项过滤
  if (config.excludeValues && config.excludeValues.length > 0) {
    const excludeSet = new Set(config.excludeValues.map(v => v.trim()).filter(Boolean))
    if (excludeSet.size > 0) {
      return results.filter(item => !excludeSet.has(item.value))
    }
  }

  return results
}
