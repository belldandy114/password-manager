/**
 * 测试数据生成器目录（唯一的 17 类清单）。
 *
 * 页面左侧列表和全局搜索都读这里，避免「加一种数据类型只改了一边」。
 * 关键词 kw 只服务于搜索命中，不影响生成。
 */
import type { GeneratorId } from './types';

export interface GeneratorMeta {
  id: GeneratorId;
  label: string;
  hint: string;
  /** 搜索用关键词：中文别名 + 英文 / 缩写 */
  kw: string;
}

export const GENERATORS: GeneratorMeta[] = [
  { id: 'idCard', label: '身份证', hint: '大陆 18 位 / 香港 / 澳门', kw: 'shenfenzheng idcard id card 证件 身份证号' },
  { id: 'name', label: '姓名', hint: '常见中文姓名', kw: 'name 姓名 名字 中文名' },
  { id: 'phone', label: '手机号', hint: '中国大陆 11 位', kw: 'phone mobile 手机 手机号 电话 号码' },
  { id: 'email', label: '邮箱', hint: '多域名邮箱地址', kw: 'email mail 邮箱 邮件' },
  { id: 'bankCard', label: '银行卡号', hint: 'Visa / Master / 银联，Luhn 校验', kw: 'bank card 银行卡 卡号 luhn' },
  { id: 'licensePlate', label: '车牌号', hint: '蓝牌 / 绿牌 / 使馆 / 警用', kw: 'plate 车牌 车号 牌照' },
  { id: 'url', label: 'URL', hint: '随机网址', kw: 'url link 网址 链接' },
  { id: 'ip', label: 'IP 地址', hint: 'IPv4 / IPv6', kw: 'ip ipv4 ipv6 地址' },
  { id: 'macAddress', label: 'MAC 地址', hint: '随机 MAC', kw: 'mac 物理地址 网卡' },
  { id: 'uuid', label: 'UUID', hint: 'UUID v4', kw: 'uuid guid 唯一标识' },
  { id: 'date', label: '日期', hint: '日期 / 时间 / 时间戳', kw: 'date time 日期 时间 时间戳' },
  { id: 'longText', label: '超长文本', hint: '中 / 英 / 日文长文本', kw: 'long text 超长文本 长文本' },
  { id: 'loremIpsum', label: '段落文本', hint: '随机段落', kw: 'lorem 段落 文本 乱数假文' },
  { id: 'imagePlaceholder', label: '占位图', hint: '图片占位链接', kw: 'image picture 图片 占位图' },
  { id: 'sqlInjection', label: 'SQL / XSS', hint: '注入与 XSS 载荷', kw: 'sql xss 注入 载荷 安全测试' },
  { id: 'boundary', label: '边界值', hint: '空 / 超长 / Emoji / RTL', kw: 'boundary 边界值 空值 超长 emoji' },
  { id: 'regex', label: '正则生成', hint: '按正则生成匹配串', kw: 'regex regexp 正则 表达式' },
];

export const GROUPS: Array<{ title: string; ids: GeneratorId[] }> = [
  { title: '个人信息', ids: ['idCard', 'name', 'phone', 'email', 'bankCard', 'licensePlate'] },
  { title: '网络数据', ids: ['url', 'ip', 'macAddress', 'uuid'] },
  { title: '通用数据', ids: ['date', 'longText', 'loremIpsum', 'imagePlaceholder'] },
  { title: '测试专用', ids: ['sqlInjection', 'boundary', 'regex'] },
];

export const generatorLabel = (id: GeneratorId): string =>
  GENERATORS.find(g => g.id === id)?.label || String(id);
