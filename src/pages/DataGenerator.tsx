import React, { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { Page, PageHead, Panel, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { copyPlain } from '../utils/clipboard';
import { generateData, deduplicate } from '../utils/tdg';
import { exportData } from '../utils/tdg/export';
import type {
  GenerateConfig, GenerateResultItem, GeneratorId, ExportFormat,
  IdCardType, LongTextParams, DateParams, IpParams, BoundaryParams,
  BankCardParams, MacAddressParams, ImagePlaceholderParams, LoremIpsumParams,
} from '../utils/tdg/types';
import type { PlateType } from '../utils/tdg/licensePlate';

/**
 * 测试数据生成器。
 *
 * 1.24.1 之前这是一个独立的 Vue 子应用（sub-apps/test-data-generator，2200 行 App.vue），
 * 主应用用 webview 加载 `file://…/dist-tdg/index.html`，还要同步主题令牌、走 IPC 回填接口调试。
 * 两套框架、两套构建、两套样式，改一条生成规则要动两边。
 *
 * 现在生成逻辑（utils/tdg/*）原样搬进主应用，界面用主应用的组件与令牌重写；
 * 「填入接口调试」也回到同一个 React 树里，直接写 store 再切页，不再绕主进程转发。
 * **数据规则一行没改** —— 那些是踩过坑的（身份证校验位、Luhn、车牌格式），重写只会引入回归。
 */

/** 一次最多带进请求体的条数：再多请求体也没法用，还容易卡住渲染进程 */
const MAX_API_VALUES = 500;

interface Group { title: string; ids: GeneratorId[] }

const GENERATORS: Array<{ id: GeneratorId; label: string; hint: string }> = [
  { id: 'idCard', label: '身份证', hint: '大陆 18 位 / 香港 / 澳门' },
  { id: 'name', label: '姓名', hint: '常见中文姓名' },
  { id: 'phone', label: '手机号', hint: '中国大陆 11 位' },
  { id: 'email', label: '邮箱', hint: '多域名邮箱地址' },
  { id: 'bankCard', label: '银行卡号', hint: 'Visa / Master / 银联，Luhn 校验' },
  { id: 'licensePlate', label: '车牌号', hint: '蓝牌 / 绿牌 / 使馆 / 警用' },
  { id: 'url', label: 'URL', hint: '随机网址' },
  { id: 'ip', label: 'IP 地址', hint: 'IPv4 / IPv6' },
  { id: 'macAddress', label: 'MAC 地址', hint: '随机 MAC' },
  { id: 'uuid', label: 'UUID', hint: 'UUID v4' },
  { id: 'date', label: '日期', hint: '日期 / 时间 / 时间戳' },
  { id: 'longText', label: '超长文本', hint: '中 / 英 / 日文长文本' },
  { id: 'loremIpsum', label: '段落文本', hint: '随机段落' },
  { id: 'imagePlaceholder', label: '占位图', hint: '图片占位链接' },
  { id: 'sqlInjection', label: 'SQL / XSS', hint: '注入与 XSS 载荷' },
  { id: 'boundary', label: '边界值', hint: '空 / 超长 / Emoji / RTL' },
  { id: 'regex', label: '正则生成', hint: '按正则生成匹配串' },
];

const GROUPS: Group[] = [
  { title: '个人信息', ids: ['idCard', 'name', 'phone', 'email', 'bankCard', 'licensePlate'] },
  { title: '网络数据', ids: ['url', 'ip', 'macAddress', 'uuid'] },
  { title: '通用数据', ids: ['date', 'longText', 'loremIpsum', 'imagePlaceholder'] },
  { title: '测试专用', ids: ['sqlInjection', 'boundary', 'regex'] },
];

const FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'txt', label: 'TXT' },
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'sql', label: 'SQL' },
  { value: 'md', label: 'Markdown' },
  { value: 'xlsx', label: 'Excel' },
];

const MAX_COUNT = 5000;

/** Uint8Array → base64（分段，避免 apply 参数过多导致栈溢出） */
function toBase64(bytes: Uint8Array): string {
  let raw = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    raw += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(raw);
}

export function DataGenerator({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { toasts, addToast, removeToast } = useToast();
  const seedApiBody = useStore(s => s.seedApiBody);

  const [type, setType] = useState<GeneratorId>('name');
  const [count, setCount] = useState(50);
  const [dedupe, setDedupe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<GenerateResultItem[]>([]);
  const [format, setFormat] = useState<ExportFormat>('csv');

  // ---- 参数（各类型独立，切走再切回来还在） ----
  const [idCard, setIdCard] = useState({
    gender: 'random' as 'male' | 'female' | 'random',
    idType: 'mainland' as IdCardType,
    lastDigits: 6,
    birthYearMin: 1980,
    birthYearMax: 2005,
  });
  const [nameOpt, setNameOpt] = useState({ pinyin: false, ethnicity: 'random' as 'han' | 'xinjiang' | 'tibetan' | 'random' });
  const [email, setEmail] = useState({ domains: 'qq.com, 163.com, gmail.com', special: true });
  const [longText, setLongText] = useState<LongTextParams>({ language: 'zh', minLength: 200, maxLength: 500 });
  const [date, setDate] = useState<DateParams>({ yearMin: 2020, yearMax: 2026, format: 'date' });
  const [ip, setIp] = useState<IpParams>({ version: 4, categories: ['private', 'A'] });
  const [boundary, setBoundary] = useState<BoundaryParams>({ types: ['empty', 'oversize', 'unicode', 'emoji'], extraLength: 1000 });
  const [bank, setBank] = useState<BankCardParams>({ brand: 'random' });
  const [plate, setPlate] = useState<{ type: PlateType }>({ type: 'random' });
  const [mac, setMac] = useState<MacAddressParams>({ separator: '-' });
  const [img, setImg] = useState<ImagePlaceholderParams>({ width: 300, height: 200, service: 'picsum' });
  const [lorem, setLorem] = useState<LoremIpsumParams>({ language: 'zh', paragraphs: 3, sentencesPerParagraph: 4 });
  const [regex, setRegex] = useState({ pattern: '\\d{4}-\\d{4}-\\d{4}', flags: '' });

  const active = GENERATORS.find(g => g.id === type)!;

  /** 把各面板的当前值拼成 generateData 要的配置 */
  const buildConfig = (): GenerateConfig => {
    const cfg: GenerateConfig = { id: type, count };
    if (type === 'idCard') {
      cfg.idCard = { ...idCard, idType: idCard.idType };
      cfg.idCardLastDigits = idCard.lastDigits;
    }
    if (type === 'name') {
      cfg.nameWithPinyin = nameOpt.pinyin;
      cfg.nameEthnicity = nameOpt.ethnicity;
    }
    if (type === 'email') {
      cfg.email = {
        domains: email.domains.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
        allowSpecialChars: email.special,
      };
    }
    if (type === 'longText') cfg.longText = longText;
    if (type === 'date') cfg.date = date;
    if (type === 'ip') cfg.ip = ip;
    if (type === 'boundary') cfg.boundary = boundary;
    if (type === 'bankCard') cfg.bankCard = bank;
    if (type === 'licensePlate') cfg.licensePlate = plate;
    if (type === 'macAddress') cfg.macAddress = mac;
    if (type === 'imagePlaceholder') cfg.imagePlaceholder = img;
    if (type === 'loremIpsum') cfg.loremIpsum = lorem;
    if (type === 'regex') {
      cfg.regexPattern = regex.pattern;
      cfg.regexFlags = regex.flags;
    }
    return cfg;
  };

  const run = () => {
    setBusy(true);
    try {
      let list = generateData(buildConfig());
      if (dedupe) list = deduplicate(list);
      setItems(list);
      addToast(`生成 ${list.length} 条`, list.length > 0 ? 'success' : 'error');
    } catch (e) {
      addToast('生成失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyAll = async () => {
    if (items.length === 0) return;
    try {
      await copyPlain(items.map(i => i.value).join('\n'));
      addToast(`已复制 ${items.length} 行`, 'success');
    } catch {
      addToast('复制失败', 'error');
    }
  };

  const copyOne = async (value: string) => {
    try {
      await copyPlain(value);
      addToast('已复制', 'success');
    } catch {
      addToast('复制失败', 'error');
    }
  };

  const doExport = async () => {
    if (items.length === 0) return;
    try {
      const { content, extension } = await exportData(items, format);
      const pick = await window.electronAPI.dialogSaveFile({
        defaultName: `测试数据-${new Date().toISOString().slice(0, 10)}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (pick.canceled || !pick.filePath) return;
      const r = typeof content === 'string'
        ? await window.electronAPI.fileWrite({ filePath: pick.filePath, content })
        : await window.electronAPI.fileWrite({ filePath: pick.filePath, content: toBase64(content), encoding: 'base64' });
      addToast(r.success ? '已导出' : (r.error || '导出失败'), r.success ? 'success' : 'error');
    } catch (e) {
      addToast('导出失败：' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  };

  /**
   * 把生成值填进「接口调试」的请求体。
   * 旧子应用要绕 tdg:to-api → 主进程 → 主窗口；现在同一个 React 树，直接写 store 再切页即可。
   * ApiClient 消费 seed 时会统一序列化成 JSON 数组，并把 GET/HEAD 切成 POST。
   */
  const fillApiBody = () => {
    const values = items
      .map(it => String(it.value == null ? '' : it.value))
      .filter(Boolean)
      .slice(0, MAX_API_VALUES);
    if (!values.length) { addToast('先生成数据再填入', 'error'); return; }
    seedApiBody(values);
    onNavigate('apiClient');
  };

  const preview = useMemo(() => items.slice(0, 300), [items]);

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.db size={16} />}
          title="测试数据"
          desc="批量生成测试用数据：身份证、手机号、银行卡、车牌、边界值、注入载荷等，可直接复制或导出"
        />

        <div className="split tdg-split">
          <Panel title="数据类型" flush>
            <div className="tdg-types">
              {GROUPS.map((g) => (
                <div key={g.title} className="tdg-group">
                  <div className="tdg-group-title">{g.title}</div>
                  {g.ids.map((id) => {
                    const meta = GENERATORS.find(x => x.id === id)!;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`tdg-type${type === id ? ' is-on' : ''}`}
                        onClick={() => setType(id)}
                        title={meta.hint}
                      >
                        <span className="tdg-type-label">{meta.label}</span>
                        <span className="tdg-type-hint">{meta.hint}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </Panel>

          <div className="tdg-main">
            <Panel title={`${active.label} · 参数`} meta={active.hint}>
              <div className="tdg-form">
                <label className="tdg-row">
                  <span className="tdg-label">数量</span>
                  <input
                    type="number"
                    min={1}
                    max={MAX_COUNT}
                    value={count}
                    onChange={e => setCount(Math.max(1, Math.min(MAX_COUNT, Number(e.target.value) || 1)))}
                    aria-label="生成数量"
                  />
                  <span className="tdg-hint">最多 {MAX_COUNT}</span>
                </label>

                {type === 'idCard' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">证件类型</span>
                      <select value={idCard.idType} onChange={e => setIdCard({ ...idCard, idType: e.target.value as IdCardType })} aria-label="证件类型">
                        <option value="mainland">大陆 18 位</option>
                        <option value="hk">香港</option>
                        <option value="macau">澳门</option>
                        <option value="mixed">混合</option>
                      </select>
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">性别</span>
                      <select value={idCard.gender} onChange={e => setIdCard({ ...idCard, gender: e.target.value as 'male' | 'female' | 'random' })} aria-label="性别">
                        <option value="random">随机</option>
                        <option value="male">男</option>
                        <option value="female">女</option>
                      </select>
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">出生年份</span>
                      <input type="number" value={idCard.birthYearMin} onChange={e => setIdCard({ ...idCard, birthYearMin: Number(e.target.value) || 1980 })} aria-label="最早出生年" />
                      <span className="tdg-hint">到</span>
                      <input type="number" value={idCard.birthYearMax} onChange={e => setIdCard({ ...idCard, birthYearMax: Number(e.target.value) || 2005 })} aria-label="最晚出生年" />
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">后几位</span>
                      <input type="number" min={0} max={6} value={idCard.lastDigits} onChange={e => setIdCard({ ...idCard, lastDigits: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })} aria-label="身份证后几位" />
                      <span className="tdg-hint">额外算一列「后 N 位」，导出时带上</span>
                    </label>
                  </>
                )}

                {type === 'name' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">民族</span>
                      <select value={nameOpt.ethnicity} onChange={e => setNameOpt({ ...nameOpt, ethnicity: e.target.value as 'han' | 'xinjiang' | 'tibetan' | 'random' })} aria-label="姓名民族">
                        <option value="random">随机</option>
                        <option value="han">汉族</option>
                        <option value="xinjiang">新疆</option>
                        <option value="tibetan">藏族</option>
                      </select>
                    </label>
                    <label className="tdg-row tdg-row-check">
                      <input type="checkbox" checked={nameOpt.pinyin} onChange={e => setNameOpt({ ...nameOpt, pinyin: e.target.checked })} aria-label="附带拼音" />
                      <span>附带拼音</span>
                    </label>
                  </>
                )}

                {type === 'email' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">域名</span>
                      <input value={email.domains} onChange={e => setEmail({ ...email, domains: e.target.value })} aria-label="邮箱域名" placeholder="qq.com, 163.com" />
                    </label>
                    <label className="tdg-row tdg-row-check">
                      <input type="checkbox" checked={email.special} onChange={e => setEmail({ ...email, special: e.target.checked })} aria-label="允许特殊字符" />
                      <span>允许 + . _ 等特殊字符</span>
                    </label>
                  </>
                )}

                {type === 'longText' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">语言</span>
                      <select value={longText.language} onChange={e => setLongText({ ...longText, language: e.target.value as LongTextParams['language'] })} aria-label="文本语言">
                        <option value="zh">中文</option>
                        <option value="en">英文</option>
                        <option value="ja">日文</option>
                        <option value="mix">混合</option>
                      </select>
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">长度</span>
                      <input type="number" value={longText.minLength} onChange={e => setLongText({ ...longText, minLength: Number(e.target.value) || 1 })} aria-label="最短长度" />
                      <span className="tdg-hint">到</span>
                      <input type="number" value={longText.maxLength} onChange={e => setLongText({ ...longText, maxLength: Number(e.target.value) || 1 })} aria-label="最长长度" />
                    </label>
                  </>
                )}

                {type === 'date' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">年份范围</span>
                      <input type="number" value={date.yearMin} onChange={e => setDate({ ...date, yearMin: Number(e.target.value) || 2000 })} aria-label="最早年份" />
                      <span className="tdg-hint">到</span>
                      <input type="number" value={date.yearMax} onChange={e => setDate({ ...date, yearMax: Number(e.target.value) || 2026 })} aria-label="最晚年份" />
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">格式</span>
                      <select value={date.format} onChange={e => setDate({ ...date, format: e.target.value as DateParams['format'] })} aria-label="日期格式">
                        <option value="date">YYYY-MM-DD</option>
                        <option value="datetime">YYYY-MM-DD HH:mm:ss</option>
                        <option value="timestamp">时间戳</option>
                      </select>
                    </label>
                  </>
                )}

                {type === 'ip' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">版本</span>
                      <select value={ip.version} onChange={e => setIp({ ...ip, version: Number(e.target.value) as 4 | 6 })} aria-label="IP 版本">
                        <option value={4}>IPv4</option>
                        <option value={6}>IPv6</option>
                      </select>
                    </label>
                    {ip.version === 4 && (
                      <label className="tdg-row">
                        <span className="tdg-label">网段</span>
                        <select
                          multiple
                          className="tdg-multi"
                          value={ip.categories}
                          onChange={e => setIp({ ...ip, categories: Array.from(e.target.selectedOptions).map(o => o.value as IpParams['categories'][number]) })}
                          aria-label="IP 网段"
                        >
                          <option value="private">私有 10/172/192</option>
                          <option value="A">A 类</option>
                          <option value="B">B 类</option>
                          <option value="C">C 类</option>
                          <option value="loopback">回环</option>
                        </select>
                      </label>
                    )}
                  </>
                )}

                {type === 'boundary' && (
                  <>
                    <div className="tdg-row tdg-row-wrap">
                      <span className="tdg-label">类型</span>
                      {([
                        ['empty', '空值'], ['oversize', '超长'], ['unicode', 'Unicode'],
                        ['emoji', 'Emoji'], ['rtl', 'RTL'], ['zerowidth', '零宽字符'], ['newline', '换行'],
                      ] as const).map(([val, label]) => (
                        <label key={val} className="tdg-chip">
                          <input
                            type="checkbox"
                            checked={boundary.types.includes(val)}
                            onChange={e => setBoundary({
                              ...boundary,
                              types: e.target.checked
                                ? [...boundary.types, val]
                                : boundary.types.filter(t => t !== val),
                            })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <label className="tdg-row">
                      <span className="tdg-label">超长字符</span>
                      <input type="number" value={boundary.extraLength} onChange={e => setBoundary({ ...boundary, extraLength: Number(e.target.value) || 100 })} aria-label="超长字符数" />
                    </label>
                  </>
                )}

                {type === 'bankCard' && (
                  <label className="tdg-row">
                    <span className="tdg-label">卡组织</span>
                    <select value={bank.brand} onChange={e => setBank({ brand: e.target.value as BankCardParams['brand'] })} aria-label="卡组织">
                      <option value="random">随机</option>
                      <option value="visa">Visa</option>
                      <option value="mastercard">MasterCard</option>
                      <option value="unionpay">银联</option>
                    </select>
                  </label>
                )}

                {type === 'licensePlate' && (
                  <label className="tdg-row">
                    <span className="tdg-label">车牌类型</span>
                    <select value={plate.type} onChange={e => setPlate({ type: e.target.value as PlateType })} aria-label="车牌类型">
                      <option value="random">随机</option>
                      <option value="blue">蓝牌</option>
                      <option value="green">绿牌（新能源）</option>
                      <option value="embassy">使馆</option>
                      <option value="police">警用</option>
                    </select>
                  </label>
                )}

                {type === 'macAddress' && (
                  <label className="tdg-row">
                    <span className="tdg-label">分隔符</span>
                    <select value={mac.separator} onChange={e => setMac({ ...mac, separator: e.target.value as MacAddressParams['separator'] })} aria-label="MAC 分隔符">
                      <option value="-">短横线 00-1A-2B</option>
                      <option value=":">冒号 00:1A:2B</option>
                      <option value="none">无分隔 001A2B</option>
                    </select>
                  </label>
                )}

                {type === 'imagePlaceholder' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">尺寸</span>
                      <input type="number" value={img.width} onChange={e => setImg({ ...img, width: Number(e.target.value) || 300 })} aria-label="宽度" />
                      <span className="tdg-hint">×</span>
                      <input type="number" value={img.height} onChange={e => setImg({ ...img, height: Number(e.target.value) || 200 })} aria-label="高度" />
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">服务</span>
                      <select value={img.service} onChange={e => setImg({ ...img, service: e.target.value as ImagePlaceholderParams['service'] })} aria-label="占位图服务">
                        <option value="picsum">picsum.photos</option>
                        <option value="placeholder">placehold.co</option>
                      </select>
                    </label>
                  </>
                )}

                {type === 'loremIpsum' && (
                  <>
                    <label className="tdg-row">
                      <span className="tdg-label">语言</span>
                      <select value={lorem.language} onChange={e => setLorem({ ...lorem, language: e.target.value as LoremIpsumParams['language'] })} aria-label="段落语言">
                        <option value="zh">中文</option>
                        <option value="en">英文</option>
                      </select>
                    </label>
                    <label className="tdg-row">
                      <span className="tdg-label">段落 / 句</span>
                      <input type="number" value={lorem.paragraphs} onChange={e => setLorem({ ...lorem, paragraphs: Number(e.target.value) || 1 })} aria-label="段落数" />
                      <span className="tdg-hint">×</span>
                      <input type="number" value={lorem.sentencesPerParagraph} onChange={e => setLorem({ ...lorem, sentencesPerParagraph: Number(e.target.value) || 1 })} aria-label="每段句数" />
                    </label>
                  </>
                )}

                {type === 'regex' && (
                  <label className="tdg-row">
                    <span className="tdg-label">正则</span>
                    <input value={regex.pattern} onChange={e => setRegex({ ...regex, pattern: e.target.value })} aria-label="正则表达式" placeholder="\\d{4}-\\d{4}" />
                  </label>
                )}

                {type === 'sqlInjection' && (
                  <div className="tdg-note">
                    内置一组常见 SQL 注入 / XSS / 模板注入载荷，按顺序取用；数量超过载荷数会循环。
                  </div>
                )}

                {type === 'url' && <div className="tdg-note">随机网址，无参数。</div>}
                {type === 'uuid' && <div className="tdg-note">UUID v4，无参数。</div>}
                {type === 'phone' && <div className="tdg-note">常用号段随机组合，无参数。</div>}

                <div className="tdg-actions">
                  <label className="tdg-row-check">
                    <input type="checkbox" checked={dedupe} onChange={e => setDedupe(e.target.checked)} aria-label="去重" />
                    <span>去重</span>
                  </label>
                  <button className="btn btn-primary" onClick={run} disabled={busy}>
                    {busy ? '生成中…' : '生成'}
                  </button>
                </div>
              </div>
            </Panel>

            <Panel
              title="结果"
              meta={items.length ? `${items.length} 条` : '还没有生成'}
              tools={items.length > 0 ? (
                <div className="tdg-result-tools">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={fillApiBody}
                    title="把生成结果写进接口调试的请求体（最多 500 条）"
                  >填入接口调试</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void copyAll()}>复制全部</button>
                  <select value={format} onChange={e => setFormat(e.target.value as ExportFormat)} aria-label="导出格式">
                    {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  <button className="btn btn-secondary btn-sm" onClick={() => void doExport()}>导出</button>
                </div>
              ) : null}
            >
              {items.length === 0 ? (
                <div className="tdg-empty">选好类型、填好参数，点「生成」。</div>
              ) : (
                <div className="tdg-table-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 56 }}>#</th>
                        <th style={{ width: 130 }}>类型</th>
                        <th>值</th>
                        <th style={{ width: 88 }}>后 N 位</th>
                        <th style={{ width: 64 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((it) => (
                        <tr key={it.id}>
                          <td className="text-muted">{it.id}</td>
                          <td className="text-muted">{it.type}</td>
                          <td className="tdg-value" title={it.value}>{it.value}</td>
                          <td className="text-muted">{it.last6 || '—'}</td>
                          <td>
                            <button className="btn btn-ghost btn-sm" onClick={() => void copyOne(it.value)}>复制</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {items.length > preview.length && (
                    <div className="tdg-more">
                      只显示前 {preview.length} 条，导出/复制仍包含全部 {items.length} 条
                    </div>
                  )}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </Page>
    </div>
  );
}
