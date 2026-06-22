/** 生成器标识符 */
export type GeneratorId =
  | 'sqlInjection'
  | 'idCard'
  | 'name'
  | 'email'
  | 'longText'
  | 'phone'
  | 'url'
  | 'ip'
  | 'date'
  | 'boundary'
  | 'bankCard'
  | 'licensePlate'
  | 'macAddress'
  | 'uuid'
  | 'imagePlaceholder'
  | 'loremIpsum'
  | 'regex'

/** 生成器元信息 */
export interface GeneratorMeta {
  id: GeneratorId
  label: string
  icon: string
  description: string
  hasParams: boolean
}

/** 大陆身份证参数 */
export interface IdCardParams {
  gender: 'male' | 'female' | 'random'
  birthYearMin: number
  birthYearMax: number
}

/** 身份证类型 */
export type IdCardType = 'mainland' | 'hk' | 'macau'

/** 港澳身份证参数 */
export interface HkMacauIdParams {
  idType: IdCardType
  /** 大陆 vs 港澳数量比，如 80 表示 80% 大陆 */
  mainlandRatio: number
}

/** 超长文本参数 */
export interface LongTextParams {
  language: 'zh' | 'en' | 'ja' | 'mix'
  minLength: number
  maxLength: number
}

/** 邮箱参数 */
export interface EmailParams {
  domains: string[]
  allowSpecialChars: boolean
}

/** 手机号参数 */
export interface PhoneParams {
  prefixes: string[]
}

/** 日期参数 */
export interface DateParams {
  yearMin: number
  yearMax: number
  format: 'date' | 'datetime' | 'timestamp'
}

/** IP 参数 */
export interface IpParams {
  version: 4 | 6
  categories: ('A' | 'B' | 'C' | 'private' | 'loopback')[]
}

/** 边界值参数 */
export interface BoundaryParams {
  types: ('empty' | 'oversize' | 'unicode' | 'emoji' | 'rtl' | 'zerowidth' | 'newline')[]
  extraLength: number // 超长时的额外字符数
}

/** 银行卡号参数 */
export interface BankCardParams {
  /** 卡品牌: visa/master/unionpay/random */
  brand: 'visa' | 'mastercard' | 'unionpay' | 'random'
}

/** 车牌号参数 */
export interface LicensePlateParams {
  type: 'blue' | 'green' | 'embassy' | 'police' | 'random'
}

/** MAC 地址参数 */
export interface MacAddressParams {
  /** 分隔符 */
  separator: ':' | '-' | 'none'
  /** 是否使用特定厂商 OUI 前缀 */
  oui?: string
}

/** 占位图参数 */
export interface ImagePlaceholderParams {
  width: number
  height: number
  /** 服务商: picsum / placeholder */
  service: 'picsum' | 'placeholder'
}

/** Lorem Ipsum 参数 */
export interface LoremIpsumParams {
  language: 'zh' | 'en'
  /** 段落数 */
  paragraphs: number
  /** 每段句子数 */
  sentencesPerParagraph: number
}

/** 统一生成配置 */
export interface GenerateConfig {
  id: GeneratorId
  count: number
  idCard?: IdCardParams & { idType: IdCardType }
  longText?: LongTextParams
  email?: EmailParams
  phone?: PhoneParams
  date?: DateParams
  ip?: IpParams
  boundary?: BoundaryParams
  bankCard?: BankCardParams
  licensePlate?: LicensePlateParams
  macAddress?: MacAddressParams
  imagePlaceholder?: ImagePlaceholderParams
  loremIpsum?: LoremIpsumParams
  /** 身份证显示后几位 */
  idCardLastDigits?: number
  /** 姓名生成时是否附带拼音 */
  nameWithPinyin?: boolean
  /** 姓名民族 */
  nameEthnicity?: 'han' | 'xinjiang' | 'tibetan' | 'random'
  /** 自定义正则：模式字符串 */
  regexPattern?: string
  regexFlags?: string
  /** 排除项列表：生成结果中排除包含这些值的条目 */
  excludeValues?: string[]
}

/** 生成结果条目 */
export interface GenerateResultItem {
  id: number
  type: string
  value: string
  /** 身份证后六位（含港澳括号），仅 idCard 类型有效 */
  last6?: string
}

/** 导出格式 */
export type ExportFormat = 'txt' | 'csv' | 'md' | 'xlsx' | 'json' | 'sql'
