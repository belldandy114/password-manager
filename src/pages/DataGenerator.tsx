import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { Page, PageHead, Panel, Icons, BusyProgress } from '../components/ui';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { copyPlain } from '../utils/clipboard';
import { callIpc } from '../utils/ipc';
import { newId } from '../utils/id';
import { formatRecent, localDay } from '../utils/time';
import { generateData, deduplicate } from '../utils/tdg';
import { exportData } from '../utils/tdg/export';
import { GENERATORS, GROUPS } from '../utils/tdg/catalog';
import { REGEX_PRESETS } from '../utils/tdg/regexGenerator';
import {
  BATCH_MAX_ROWS,
  FORMAT_CAPABILITIES,
  batchSizes,
  capabilityOf,
  decidePath,
  progressPercent,
  clampStreamRows,
} from '../utils/tdg/batch';
import type {
  GenerateConfig, GenerateResultItem, GeneratorId, ExportFormat,
  IdCardType, LongTextParams, DateParams, IpParams, BoundaryParams,
  BankCardParams, MacAddressParams, ImagePlaceholderParams, LoremIpsumParams,
} from '../utils/tdg/types';
import type { PlateType } from '../utils/tdg/licensePlate';
import type { TdgDataset } from '../types';

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

/* ================================================================
   十万级流式导出（2.2 / W3-C）—— 主体循环
   ----------------------------------------------------------------
   放在模块级、不依赖 React 状态：
     · 组件里点「开始导出」只是「选路径 → 调它 → 把结果翻译成界面文案」；
     · 真机验收可以直接 `import` 它跑 10 万行（只绕过原生保存框，其余全是生产代码路径）；
     · 批次之间 `await` 让出主线程 —— 不同步等的话「取消」按钮点不动、窗口也卡。
   取消 / 失败 / 卸载都必须 abort：`tdg:write-abort` 删掉 `.part`，
   正式文件只在 `tdg:write-finish` 的 rename 那一刻出现（契约 C-65）。
   ================================================================ */

export interface StreamExportOptions {
  /** 已选好的目标路径（原生保存框在调用方弹，本函数不弹） */
  savePath: string;
  /** 目标行数（> 5000；上限 1,000,000 由 decidePath 保证） */
  total: number;
  format: ExportFormat;
  /** 生成参数（`count` 由本函数按批覆盖，调用方给的那份不会被改） */
  baseConfig: GenerateConfig;
  /** 跨批去重（开启时用同一个 Set 贯穿全程，避免批与批之间出现重复值） */
  dedupe: boolean;
  /** 是否写「后 N 位」列（决定 csv/json 的 columns） */
  hasLastN: boolean;
  /** 取消标志：调用方持有，本函数在批次之间检查 */
  signal: { canceled: boolean };
  onProgress?: (done: number, total: number) => void;
  /** writer 建立/结束时交给调用方（组件用它做卸载清理） */
  onWriter?: (writerId: string | null) => void;
}

export type StreamExportResult =
  | { ok: true; rows: number; path: string; ms: number; short: boolean }
  | { ok: false; canceled: true; rows: number }
  | { ok: false; error: string; rows: number };

/** 一批结果 → 主进程要的行：CSV/JSON 传数组行（多列），TXT 传字符串行 */
function streamRowsFor(
  items: GenerateResultItem[],
  format: ExportFormat,
  hasLastN: boolean,
): (string | string[])[] {
  return items.map((it) => {
    if (format === 'txt') return hasLastN && it.last6 ? `${it.value}\t${it.last6}` : it.value;
    return hasLastN
      ? [String(it.id), it.type, it.value, it.last6 || '']
      : [String(it.id), it.type, it.value];
  });
}

export async function streamExport(opts: StreamExportOptions): Promise<StreamExportResult> {
  const { savePath, total, format, baseConfig, dedupe, hasLastN, signal } = opts;
  const sizes = batchSizes(total);
  const seen = dedupe ? new Set<string>() : null;
  const columns = format === 'txt'
    ? undefined
    : (hasLastN ? ['序号', '数据类型', '内容', '后N位'] : ['序号', '数据类型', '内容']);

  let writerId = '';
  let done = 0;
  let stalls = 0;
  const t0 = Date.now();
  const abort = async () => {
    if (!writerId) return;
    const id = writerId;
    writerId = '';
    opts.onWriter?.(null);
    try { await window.electronAPI.tdgWriteAbort(id); } catch { /* 已结束就忽略 */ }
  };

  try {
    for (let i = 0; i < sizes.length; i++) {
      // 1) 造数（同步）→ 序列化；去重跨批共用一个 Set
      let items = generateData({ ...baseConfig, count: sizes[i] });
      if (seen) {
        items = items.filter((it) => {
          const key = String(it.value);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      const rows = streamRowsFor(items, format, hasLastN);

      // 2) 首批：建 writer（表头在前缀里写，所以 columns 必须在 append 之前定下来）
      if (i === 0) {
        const start = await window.electronAPI.tdgWriteStart({
          savePath,
          format: format as 'csv' | 'json' | 'txt',
          columns,
          // CSV 带 BOM：Excel 打开中文不乱码（契约 [C-68] 明确允许 bom:true）
          bom: format === 'csv',
        });
        if (!start.success) {
          return start.canceled
            ? { ok: false, canceled: true, rows: 0 }
            : { ok: false, error: start.error || '无法开始写入', rows: 0 };
        }
        writerId = String((start.data as { writerId?: string } | undefined)?.writerId || '');
        if (!writerId) return { ok: false, error: '无法开始写入：主进程没有返回 writerId', rows: 0 };
        opts.onWriter?.(writerId);
      }

      // 3) 追加这一批
      if (rows.length) {
        // rows 是 (string | string[])[]：数组行给多列（CSV/JSON），字符串行给单列（TXT）。
        // 这个形状现在在 types.ts 里就是对的（原先那里只写了 string[]，调用处只能靠一步
        // unknown 双重强转骗过编译器 —— 那种强转一出现，类型检查就再也帮不上忙了）。
        const appended = await window.electronAPI.tdgWriteAppend(writerId, rows);
        if (!appended.success) {
          await abort();
          return { ok: false, error: appended.error || '写入失败', rows: done };
        }
        done += rows.length;
        stalls = 0;
        opts.onProgress?.(done, total);
      } else {
        // 整批都被去重掉了：该类型可用值已耗尽，别死循环
        stalls += 1;
        if (stalls >= 3) break;
      }

      if (signal.canceled) {
        await abort();
        return { ok: false, canceled: true, rows: done };
      }
      // 让出主线程：不同步等的话「取消」按钮点不动，窗口会卡
      await new Promise((r) => setTimeout(r, 0));
    }

    if (signal.canceled) {
      await abort();
      return { ok: false, canceled: true, rows: done };
    }
    if (!done) {
      await abort();
      return { ok: false, error: '没有可写入的行：该类型的可用值不足（开了去重时更明显），请关掉去重或换类型', rows: 0 };
    }

    // 4) 收尾：fsync + rename（正式文件在这一刻才出现）
    const fin = await window.electronAPI.tdgWriteFinish(writerId);
    writerId = '';
    opts.onWriter?.(null);
    if (!fin.success) return { ok: false, error: fin.error || '收尾失败', rows: done };
    const data = fin.data as { path?: string; rows?: number; ms?: number } | undefined;
    const rows = data?.rows ?? done;
    return {
      ok: true,
      rows,
      path: data?.path || savePath,
      ms: data?.ms ?? (Date.now() - t0),
      short: rows < total,
    };
  } catch (e) {
    await abort();
    return { ok: false, error: '导出失败：' + (e instanceof Error ? e.message : String(e)), rows: done };
  }
}

export function DataGenerator({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { toasts, addToast, removeToast } = useToast();
  const seedApiBody = useStore(s => s.seedApiBody);
  const dataSeed = useStore(s => s.dataGeneratorSeed);
  const consumeDataSeed = useStore(s => s.consumeDataGeneratorSeed);

  const [type, setType] = useState<GeneratorId>('name');
  const [count, setCount] = useState(50);
  const [dedupe, setDedupe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<GenerateResultItem[]>([]);
  const [format, setFormat] = useState<ExportFormat>('csv');

  /* ---- 十万级流式导出（2.2 / W3-C）：与上面的单次导出走两套状态，互不影响 ---- */
  /** 目标行数（默认 10 万；clamp 到 1..1,000,000，超出在按钮上就禁用） */
  const [streamRows, setStreamRows] = useState(100000);
  /** 流式格式：只有 csv/json/txt 可选（能力矩阵见 utils/tdg/batch.ts） */
  const [streamFormat, setStreamFormat] = useState<ExportFormat>('csv');
  const [streaming, setStreaming] = useState(false);
  const [streamDone, setStreamDone] = useState(0);
  const [streamMsg, setStreamMsg] = useState('');
  /** 取消标志（可变对象，交给 streamExport 在批次之间检查）；真正的收尾（删 .part）在 streamExport 里做 */
  const cancelSignalRef = useRef<{ canceled: boolean }>({ canceled: false });
  /** 当前 writer：页面卸载/切走时必须 abort，否则半成品会留在磁盘上 */
  const writerRef = useRef<string | null>(null);

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
  /** 手机号后 N 位（身份证的放在 idCard.lastDigits，两个类型共用一个结果列） */
  const [phoneLastDigits, setPhoneLastDigits] = useState(4);

  /* ---- 1.25.0：SQL 导出的表名 / 列名（只对 SQL 格式生效） ---- */
  const [sqlTable, setSqlTable] = useState('test_data');
  const [sqlColumn, setSqlColumn] = useState('value');

  /* ---- 1.25.0：数据集（存的是配置，不是生成结果） ---- */
  const [datasets, setDatasets] = useState<TdgDataset[]>([]);
  const [dsOpen, setDsOpen] = useState(false);
  const [dsName, setDsName] = useState('');
  const [dsBusy, setDsBusy] = useState(false);
  const { ask, confirmNode } = useConfirm();

  /** 读数据集：未解锁 / 读失败就当空列表，页面不因此报错 */
  const loadDatasets = useCallback(async () => {
    try {
      const r = await window.electronAPI.wsGet('tdgDatasets');
      setDatasets(r && r.success && Array.isArray(r.data) ? (r.data as TdgDataset[]) : []);
    } catch {
      setDatasets([]);
    }
  }, []);

  useEffect(() => { void loadDatasets(); }, [loadDatasets]);

  /**
   * 离开页面时收掉还在写的 writer：不 abort 的话 `.part` 会留在用户目录里，
   * 而主进程只在 `will-quit` 与「显式 abort」时清理（[C-65]）。
   */
  useEffect(() => () => {
    const id = writerRef.current;
    if (!id) return;
    writerRef.current = null;
    void window.electronAPI.tdgWriteAbort(id).catch(() => { /* 已结束就忽略 */ });
  }, []);

  const active = GENERATORS.find(g => g.id === type)!;

  /** Ctrl+K / Ctrl+空格 里选中某个数据类型 → 打开页面时直接预选它 */
  useEffect(() => {
    if (!dataSeed) return;
    if (GENERATORS.some(g => g.id === dataSeed.type)) setType(dataSeed.type as GeneratorId);
    consumeDataSeed();
  }, [dataSeed, consumeDataSeed]);

  /** 这一批结果里是否真的有「后 N 位」：没有就不渲染那一列 */
  const showLastN = useMemo(() => items.some(i => !!i.last6), [items]);

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
    if (type === 'phone') {
      cfg.phone = { prefixes: [] };   // 空数组 = 使用内置全部号段
      cfg.lastDigits = phoneLastDigits;
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

  /* ---------------- 数据集（1.25.0） ----------------
   * 存的是 GenerateConfig，不是生成结果：结果可能上万条，存进 vault 会让每次保存都变慢，
   * 而且下次要的往往是「同样的参数再来一批」而不是「上次那批一模一样的数据」。
   */

  /** 把一份配置回填到所有参数控件上（载入数据集时用） */
  const applyConfig = (cfg: GenerateConfig) => {
    if (!cfg || !GENERATORS.some(g => g.id === cfg.id)) return false;
    setType(cfg.id);
    setCount(Math.max(1, Math.min(MAX_COUNT, Number(cfg.count) || 50)));
    if (cfg.idCard) {
      setIdCard({
        gender: cfg.idCard.gender || 'random',
        idType: cfg.idCard.idType || 'mainland',
        // 0 是合法值（表示不要「后 N 位」这一列），所以用 ?? 而不是 ||
        lastDigits: cfg.idCardLastDigits ?? 6,
        birthYearMin: cfg.idCard.birthYearMin ?? 1980,
        birthYearMax: cfg.idCard.birthYearMax ?? 2005,
      });
    }
    if (cfg.nameWithPinyin !== undefined || cfg.nameEthnicity) {
      setNameOpt(prev => ({
        pinyin: cfg.nameWithPinyin ?? prev.pinyin,
        ethnicity: cfg.nameEthnicity || prev.ethnicity,
      }));
    }
    if (cfg.email) {
      setEmail({
        domains: (cfg.email.domains || []).join(', '),
        special: cfg.email.allowSpecialChars !== false,
      });
    }
    if (cfg.longText) setLongText(cfg.longText);
    if (cfg.date) setDate(cfg.date);
    if (cfg.ip) setIp(cfg.ip);
    if (cfg.boundary) setBoundary(cfg.boundary);
    if (cfg.bankCard) setBank(cfg.bankCard);
    if (cfg.licensePlate) setPlate(cfg.licensePlate);
    if (cfg.macAddress) setMac(cfg.macAddress);
    if (cfg.imagePlaceholder) setImg(cfg.imagePlaceholder);
    if (cfg.loremIpsum) setLorem(cfg.loremIpsum);
    if (cfg.regexPattern !== undefined) {
      setRegex({ pattern: cfg.regexPattern, flags: cfg.regexFlags || '' });
    }
    if (cfg.lastDigits !== undefined) setPhoneLastDigits(cfg.lastDigits);
    return true;
  };

  /** 存为数据集：同名覆盖（用户改完参数再存一次，不该出现两条同名数据集） */
  const saveDataset = async () => {
    const name = dsName.trim();
    if (!name) { addToast('给数据集起个名字', 'error'); return; }
    setDsBusy(true);
    const now = new Date().toISOString();
    const cfg = buildConfig();
    const exist = datasets.find(d => d.name === name);
    const next: TdgDataset[] = exist
      ? datasets.map(d => (d.id === exist.id ? { ...d, config: cfg, updatedAt: now } : d))
      : [...datasets, { id: newId('ds-'), name, config: cfg, createdAt: now, updatedAt: now }];
    const r = await callIpc(() => window.electronAPI.wsSet('tdgDatasets', next));
    setDsBusy(false);
    if (!r.ok) { addToast(`保存数据集失败：${r.error}`, 'error'); return; }
    setDatasets(next);
    setDsOpen(false);
    setDsName('');
    addToast(exist ? `已更新数据集「${name}」` : `已存为数据集「${name}」`, 'success');
  };

  /** 载入数据集：回填所有参数控件 */
  const loadDataset = (d: TdgDataset) => {
    const ok = applyConfig(d.config as GenerateConfig);
    if (!ok) { addToast('这份数据集里的类型已不存在，无法载入', 'error'); return; }
    setDsOpen(false);
    addToast(`已载入数据集「${d.name}」`, 'success');
  };

  const removeDataset = async (d: TdgDataset) => {
    const next = datasets.filter(x => x.id !== d.id);
    const r = await callIpc(() => window.electronAPI.wsSet('tdgDatasets', next));
    if (!r.ok) { addToast(`删除数据集失败：${r.error}`, 'error'); return; }
    setDatasets(next);
    addToast(`已删除数据集「${d.name}」`, 'success');
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

  /** 1.24.4：纯文本之外再给一个 JSON 数组出口。
   * 用户反馈「填进接口调试的不是 JSON」——实测按钮直填是 JSON 数组且模式会切过去，
   * 真实场景是走「复制全部」（每行一个值的纯文本）再手动粘贴进请求体。
   * 这里补一个一键复制 JSON 数组的按钮，粘进 JSON 模式请求体直接可用。 */
  const copyAsJson = async () => {
    if (items.length === 0) return;
    try {
      await copyPlain(JSON.stringify(items.map(i => i.value)));
      addToast(`已复制 ${items.length} 条（JSON 数组）`, 'success');
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
      // 表名 / 列名只对 SQL 生效，其它格式传了也会被忽略
      const { content, extension } = await exportData(items, format, { table: sqlTable, column: sqlColumn });
      const pick = await window.electronAPI.dialogSaveFile({
        defaultName: `测试数据-${localDay()}.${extension}`,
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

  /* ================================================================
     十万级流式导出（2.2 / W3-C）
     ----------------------------------------------------------------
     边界写死（与 src/utils/tdg/batch.ts 的单测互相看住）：
       · ≤ 5000 行 → 只走上面的 `doExport`（原路径，6 种格式行为一字不改）；
       · > 5000 行 → 只有 csv/json/txt 能流式；xlsx/md/sql 在**点之前**就禁用并给原因；
       · 每批 ≤ 5000 行、单文件 ≤ 1,000,000 行；每批之间 `await` 一次让出主线程，
         否则用户点「取消」时主线程被同步造数占着，取消请求根本进不来。
     取消语义（[C-03]）：取消**不是错误**，调 `tdgWriteAbort` 删掉 `.part`，
     正式文件自始至终没出现过（主进程 write-finish 才 rename）。
     ================================================================ */
  const streamPlan = useMemo(
    () => decidePath(clampStreamRows(streamRows), streamFormat),
    [streamRows, streamFormat],
  );

  /** 这一批结果里会不会有「后 N 位」列：按配置判定（不看首批数据，避免首批为空时表头抖一下） */
  const streamHasLastN = type === 'idCard'
    ? idCard.lastDigits > 0
    : type === 'phone'
      ? phoneLastDigits > 0
      : false;

  /**
   * 点「开始导出」：先选路径（原生保存框只能在这里弹），再把重活交给 `streamExport`。
   *
   * 为什么把循环抽到模块级函数里：这段逻辑（切批 / 去重 / 进度 / 取消 / 收尾）是最容易错的部分，
   * 而它**必须在真机上跑十万行**才能证明不卡、不留残留。抽成不依赖 React 状态的函数后，
   * 真机探针可以直接 `import('/src/pages/DataGenerator.tsx')` 调它跑 10 万行，
   * 只把「原生保存框」这一步让过去（CDP 驱动不了系统模态框），其余全是生产代码路径。
   */
  const runStream = async () => {
    if (streaming) return;
    if (streamPlan.path !== 'stream') { setStreamMsg(streamPlan.reason); return; }

    // 1) 先让用户选路径：取消 = 什么都不做（不建 .part、不弹错）
    const pick = await window.electronAPI.dialogSaveFile({
      defaultName: `测试数据-${localDay()}-${streamPlan.total}.${streamFormat}`,
      filters: [{ name: streamFormat.toUpperCase(), extensions: [streamFormat] }],
    });
    if (pick.canceled || !pick.filePath) return;

    cancelSignalRef.current.canceled = false;
    setStreaming(true);
    setStreamMsg('');
    setStreamDone(0);

    const res = await streamExport({
      savePath: pick.filePath,
      total: streamPlan.total,
      format: streamFormat,
      baseConfig: buildConfig(),
      dedupe,
      hasLastN: streamHasLastN,
      signal: cancelSignalRef.current,
      onProgress: (done) => setStreamDone(done),
      onWriter: (id) => { writerRef.current = id; },
    });

    setStreaming(false);
    if (res.ok) {
      setStreamDone(res.rows);
      setStreamMsg(
        `${res.short
          ? `值域不足，实际写入 ${res.rows.toLocaleString('en-US')} 行（目标 ${streamPlan.total.toLocaleString('en-US')}）`
          : `已导出 ${res.rows.toLocaleString('en-US')} 行`}`
        + ` · ${Math.max(1, Math.round(res.ms / 1000))} 秒 · ${res.path}`,
      );
      addToast(res.short ? `已导出 ${res.rows} 行（不足目标）` : `已导出 ${res.rows} 行`, 'success');
      return;
    }
    if ('canceled' in res) {
      // 取消不是错误（[C-03]）：只给中性提示，不弹红
      setStreamMsg(`已取消：已删掉半成品，目录里没有留下文件（已写 ${res.rows.toLocaleString('en-US')} 行后取消）`);
      return;
    }
    setStreamMsg(res.error || '导出失败');
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
          tools={
            <>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { setDsName(''); setDsOpen(true); }}
                title="把当前类型与全部参数存成一份数据集，下次一键载入"
              >
                <Icons.db size={13} /> 数据集{datasets.length ? ` (${datasets.length})` : ''}
              </button>
            </>
          }
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

                {/* 「后 N 位」只对身份证 / 手机号有意义：别的类型没有尾号这一说 */}
                {(type === 'idCard' || type === 'phone') && (
                  <label className="tdg-row">
                    <span className="tdg-label">后 N 位</span>
                    <input
                      type="number"
                      min={0}
                      max={type === 'idCard' ? 6 : 11}
                      value={type === 'idCard' ? idCard.lastDigits : phoneLastDigits}
                      onChange={e => {
                        const max = type === 'idCard' ? 6 : 11;
                        const v = Math.max(0, Math.min(max, Number(e.target.value) || 0));
                        if (type === 'idCard') setIdCard({ ...idCard, lastDigits: v });
                        else setPhoneLastDigits(v);
                      }}
                      aria-label="后 N 位"
                    />
                    <span className="tdg-hint">填 0 隐藏该列；结果和导出都会带上尾号</span>
                  </label>
                )}

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
                  <>
                    <div className="tdg-row tdg-row-wrap">
                      <span className="tdg-label">快捷模板</span>
                      <div className="tdg-presets">
                        {REGEX_PRESETS.map(p => (
                          <button
                            key={p.label}
                            type="button"
                            className={`tdg-preset${regex.pattern === p.pattern ? ' is-on' : ''}`}
                            title={`${p.desc} · ${p.pattern}`}
                            onClick={() => setRegex({ ...regex, pattern: p.pattern })}
                          >{p.label}</button>
                        ))}
                      </div>
                    </div>
                    <label className="tdg-row">
                      <span className="tdg-label">正则</span>
                      <input
                        value={regex.pattern}
                        onChange={e => setRegex({ ...regex, pattern: e.target.value })}
                        aria-label="正则表达式"
                        placeholder={'\\d{4}-\\d{4}-\\d{4}'}
                      />
                    </label>
                    <div className="tdg-note">点快捷模板会回填到上面的输入框，之后仍可手动修改。</div>
                  </>
                )}

                {type === 'sqlInjection' && (
                  <div className="tdg-note">
                    内置一组常见 SQL 注入 / XSS / 模板注入载荷，按顺序取用；数量超过载荷数会循环。
                  </div>
                )}

                {type === 'url' && <div className="tdg-note">随机网址，无参数。</div>}
                {type === 'uuid' && <div className="tdg-note">UUID v4，无参数。</div>}
                {type === 'phone' && <div className="tdg-note">常用号段随机组合；「后 N 位」常用于短信验证码、脱敏核对。</div>}

                <div className="tdg-actions">
                  <label className="tdg-row-check">
                    <input type="checkbox" checked={dedupe} onChange={e => setDedupe(e.target.checked)} aria-label="去重" />
                    <span>去重</span>
                  </label>
                  <button className="btn btn-secondary" onClick={() => { setDsName(''); setDsOpen(true); }} title="把当前参数存成数据集">
                    存为数据集
                  </button>
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
                  <button className="btn btn-ghost btn-sm" onClick={() => void copyAsJson()} title="复制成 JSON 数组，粘进接口调试的 JSON 请求体直接可用">复制为 JSON</button>
                  <select value={format} onChange={e => setFormat(e.target.value as ExportFormat)} aria-label="导出格式">
                    {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                  {/* 表名 / 列名只对 SQL 有意义：别的格式显示出来只会让人以为填了有用 */}
                  {format === 'sql' && (
                    <>
                      <input
                        className="tdg-sql-ident"
                        value={sqlTable}
                        onChange={e => setSqlTable(e.target.value)}
                        placeholder="表名"
                        title="SQL 导出的表名（只允许字母、数字、下划线）"
                        aria-label="SQL 表名"
                        spellCheck={false}
                      />
                      <input
                        className="tdg-sql-ident"
                        value={sqlColumn}
                        onChange={e => setSqlColumn(e.target.value)}
                        placeholder="值列名"
                        title="SQL 导出的值列列名（只允许字母、数字、下划线）"
                        aria-label="SQL 值列名"
                        spellCheck={false}
                      />
                    </>
                  )}
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
                        <th style={{ width: 52 }}>#</th>
                        <th>值</th>
                        {showLastN && <th style={{ width: 96 }}>后 N 位</th>}
                        <th style={{ width: 64 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((it) => (
                        <tr key={it.id}>
                          <td className="text-muted">{it.id}</td>
                          <td className="tdg-value" title={it.value}>{it.value}</td>
                          {showLastN && <td className="text-muted tdg-last-n">{it.last6 || '—'}</td>}
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

            {/* 十万级流式导出（2.2）：> 5000 行改走主进程分批写盘。
                放在「结果」面板下面，和上面的单次「导出」明确分开——
                两套路径的能力不同，混在一个下拉里用户会以为 XLSX 也能导 10 万行。 */}
            <Panel
              title="大批量导出（> 5,000 行）"
              meta={streaming ? `${progressPercent(streamDone, streamPlan.path === 'stream' ? streamPlan.total : streamRows)}%` : undefined}
            >
              <div className="tool-inline" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <div className="tool-field" style={{ minWidth: 140 }}>
                  <label htmlFor="tdg-stream-rows">目标行数</label>
                  <input
                    id="tdg-stream-rows"
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={1000}
                    value={streamRows}
                    disabled={streaming}
                    onChange={(e) => setStreamRows(clampStreamRows(Number(e.target.value)))}
                    aria-label="大批量导出的目标行数"
                  />
                </div>
                <div className="tool-field">
                  <label htmlFor="tdg-stream-format">格式</label>
                  <select
                    id="tdg-stream-format"
                    value={streamFormat}
                    disabled={streaming}
                    onChange={(e) => setStreamFormat(e.target.value as ExportFormat)}
                    aria-label="大批量导出格式"
                  >
                    {/* 能流式的三种可直接选；其余三种渲染成 disabled 并带原因（不静默隐藏，
                        否则用户会以为「这里没有 XLSX」而不是「XLSX 不支持大批量」） */}
                    {FORMAT_CAPABILITIES.map((cap) => (
                      <option
                        key={cap.format}
                        value={cap.format}
                        disabled={!cap.stream}
                        title={cap.stream ? undefined : cap.reason}
                      >
                        {cap.format.toUpperCase()}
                        {cap.stream ? '（至 100 万行）' : '（仅单次 ≤5000 行）'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="tool-field" style={{ justifyContent: 'flex-end' }}>
                  <label aria-hidden="true">&nbsp;</label>
                  {streaming ? (
                    <button className="btn btn-danger btn-sm" onClick={() => { cancelSignalRef.current.canceled = true; }}>
                      取消导出
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void runStream()}
                      disabled={streamPlan.path !== 'stream'}
                      title={streamPlan.path === 'stream' ? undefined : streamPlan.reason}
                    >
                      开始导出
                    </button>
                  )}
                </div>
              </div>

              {/* 进度：按批推进的真实计数（不是假进度条），同时给屏读一个 aria-live */}
              {streaming && (
                <div className="text-sm" style={{ marginBottom: 6 }} role="status" aria-live="polite">
                  已完成 {streamDone.toLocaleString('en-US')} / {streamPlan.path === 'stream' ? streamPlan.total.toLocaleString('en-US') : '-'}
                  {streamPlan.path === 'stream' ? `（${streamPlan.batches} 批，每批 ≤ ${BATCH_MAX_ROWS.toLocaleString('en-US')} 行）` : ''}
                </div>
              )}
              <BusyProgress active={streaming} label={streaming ? '正在分批写盘…' : undefined} />

              {/* 能力矩阵：写进 UI，别让用户点了才失败 */}
              <div className="dev-banner is-info" style={{ marginTop: 8 }}>
                <Icons.list size={14} />
                <div className="text-sm">
                  支持大批量：<b>CSV / JSON / TXT</b>（至 1,000,000 行，每批 ≤ 5,000 行，可中途取消）。
                  XLSX / MD / SQL 只走上面的单次导出（≤ 5,000 行）——{capabilityOf('xlsx').reason}
                </div>
              </div>

              {streamPlan.path !== 'stream' && (
                <div className="dev-banner is-warn" style={{ marginTop: 8 }} role="status">
                  <Icons.bug size={14} />
                  <div className="text-sm">{streamPlan.reason}</div>
                </div>
              )}

              {streamMsg && (
                <div className="dev-banner is-info" style={{ marginTop: 8 }} role="status">
                  <Icons.check size={14} />
                  <div className="text-sm">{streamMsg}</div>
                </div>
              )}
            </Panel>
          </div>
        </div>
      </Page>

      {/* 数据集：存 / 载入 / 删除。用 Modal（内置 Esc + 焦点陷阱 + 叠放栈） */}
      <Modal
        open={dsOpen}
        onClose={() => setDsOpen(false)}
        title="测试数据集"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDsOpen(false)}>关闭</button>
            <button className="btn btn-primary" onClick={() => void saveDataset()} disabled={dsBusy || !dsName.trim()}>
              {dsBusy ? '保存中…' : '存为数据集'}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label>数据集名称 *</label>
          <input
            value={dsName}
            onChange={e => setDsName(e.target.value)}
            placeholder={`例如：${active.label} · ${count} 条`}
            data-autofocus="1"
            aria-label="数据集名称"
          />
          <div className="input-hint">
            存的是「类型 + 数量 + 各类型参数」，不含生成结果 —— 载入后点「生成」即可再来一批。
            同名会覆盖。
          </div>
        </div>

        <div className="form-group">
          <label>已保存的数据集（{datasets.length}）</label>
          {datasets.length === 0 ? (
            <div className="input-hint">还没有数据集。调好参数后在上面起个名字，点「存为数据集」。</div>
          ) : (
            <div className="tdg-ds-list">
              {[...datasets]
                .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
                .map(d => {
                  const cfg = d.config as GenerateConfig | undefined;
                  const meta = GENERATORS.find(g => g.id === cfg?.id);
                  return (
                    <div className="tdg-ds-row" key={d.id}>
                      <div className="tdg-ds-main">
                        <div className="tdg-ds-name" title={d.name}>{d.name}</div>
                        <div className="tdg-ds-meta">
                          {meta ? meta.label : '（未知类型）'}
                          {cfg?.count ? ` · ${cfg.count} 条` : ''}
                          {d.updatedAt ? ` · ${formatRecent(d.updatedAt)}` : ''}
                        </div>
                      </div>
                      <button className="btn btn-secondary btn-sm" onClick={() => loadDataset(d)}>载入</button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => ask({
                          title: '删除数据集',
                          message: `确定删除数据集「${d.name}」？只删这份配置，不影响已生成的数据。`,
                          confirmText: '删除',
                          onOk: () => removeDataset(d),
                        })}
                      >删除</button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </Modal>

      {confirmNode}
    </div>
  );
}
