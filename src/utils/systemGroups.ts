/**
 * 系统档案：把「同一个系统」散在四处的东西按系统名聚合。
 *
 * 数据本来就在库里，只是分散：
 * - 网址管理（PasswordEntry）有自己的条目名；
 * - 测试账号（TestAccount）有 `system` 字段；
 * - 环境矩阵（EnvEntry）有 `system` 字段；
 * - 禅道项目与系统名没有稳定对应关系，所以这里只做前三处的聚合。
 *
 * 归一口径：`trim` 后忽略大小写与全半角括号差异。**不做模糊匹配** ——
 * 「资产管理系统」和「资产管理系统V2.0」是不是同一个，只有使用者知道；
 * 猜错比不猜更糟，所以页面上会直接提示「名字不一致就统一一下」。
 */

export interface SystemGroupInput {
  entries: Array<{ id: string; name?: string; url?: string; envType?: string; username?: string }>;
  accounts: Array<{ id: string; system?: string; role?: string; username?: string; envType?: string }>;
  envs: Array<{ id: string; system?: string; url?: string; envType?: string }>;
}

/** 网址条目自带的账号（绝大多数条目都有），单独一栏标出来 */
export interface InlineAccount {
  id: string;
  /** 来源条目名，用来显示「来自：XX-测试」 */
  from: string;
  username: string;
  envType?: string;
}

export interface SystemGroup {
  key: string;
  name: string;
  entries: SystemGroupInput['entries'];
  accounts: SystemGroupInput['accounts'];
  envs: SystemGroupInput['envs'];
  /** 从网址条目里带出来的账号：系统档案以前只认「测试账号」集合，导致账号数全是 0 */
  inlineAccounts: InlineAccount[];
}

/** 归一化：去空白、转小写、把全角括号与空格统一 */
export function systemKey(name: string): string {
  return String(name || '')
    .trim()
    .replace(/\u3000/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const EMPTY = '未指定系统';

/**
 * 从网址条目名里猜系统名：很多条目的名字就是「系统名」或「系统名-环境」。
 *
 * 只剥「环境」后缀，**不碰版本号** —— `资产管理系统V2.0` 和 `资产管理系统` 可能是两套并行系统，
 * 猜错比不猜更糟；版本号是不是同一个系统，只有使用者知道。
 */
export function systemOfEntryName(name: string): string {
  const n = String(name || '').trim();
  if (!n) return '';
  return n
    // （正式）/（测试环境）/（生产环境）这类全角或半角括号后缀
    .replace(/[-_—\s]*[（(]\s*(正式|测试|开发|预发|生产|验收)(环境|版)?\s*[）)]\s*$/i, '')
    // -测试 / _开发环境 / 生产版
    .replace(/[-_—\s]+(正式|测试|开发|预发|生产|验收)(环境|版)?\s*$/i, '')
    // -uat / -sit / -dev / -prod / -test / -staging 这类英文环境缩写
    .replace(/[-_—\s]+(uat|sit|fat|dev|prod|test|staging|pre|stage)\s*$/i, '')
    .trim();
}

/** 聚合。返回按「条目总数」降序的系统列表 */
export function buildSystems(input: SystemGroupInput): SystemGroup[] {
  const map = new Map<string, SystemGroup>();

  const ensure = (rawName: string): SystemGroup => {
    const name = String(rawName || '').trim() || EMPTY;
    const key = name === EMPTY ? '__none__' : systemKey(name);
    let g = map.get(key);
    if (!g) {
      g = { key, name, entries: [], accounts: [], envs: [], inlineAccounts: [] };
      map.set(key, g);
    }
    return g;
  };

  (input.entries || []).forEach((e) => {
    const sys = systemOfEntryName(e.name || '');
    const g = ensure(sys);
    g.entries.push(e);
    // 网址条目自带账号：以前完全没算，导致只有网址的系统账号数全是 0
    const user = String(e.username || '').trim();
    if (user) {
      g.inlineAccounts.push({
        id: `inline-${e.id}`,
        from: String(e.name || e.url || ''),
        username: user,
        envType: e.envType,
      });
    }
  });
  (input.accounts || []).forEach((a) => {
    ensure(a.system || '').accounts.push(a);
  });
  (input.envs || []).forEach((v) => {
    ensure(v.system || '').envs.push(v);
  });

  const weight = (g: SystemGroup) => g.entries.length + g.accounts.length + g.envs.length + g.inlineAccounts.length;
  return Array.from(map.values()).sort((a, b) => {
    // 「未指定系统」永远排最后，不占前排位置
    if (a.key === '__none__') return 1;
    if (b.key === '__none__') return -1;
    return (weight(b) - weight(a)) || a.name.localeCompare(b.name, 'zh-CN');
  });
}

/** 搜系统名或其下任意账号 / 地址 */
export function matchesSystem(g: SystemGroup, q: string): boolean {
  const key = String(q || '').trim().toLowerCase();
  if (!key) return true;
  if (g.name.toLowerCase().includes(key)) return true;
  return g.accounts.some(a => String(a.username || '').toLowerCase().includes(key)
    || String(a.role || '').toLowerCase().includes(key))
    || g.envs.some(v => String(v.url || '').toLowerCase().includes(key))
    || g.entries.some(e => String(e.name || '').toLowerCase().includes(key)
      || String(e.url || '').toLowerCase().includes(key));
}

/** 合并后的网址条目：同名不同环境算一条 */
export interface MergedEntry {
  name: string;
  /** 涉及的环境（测试 / 正式 / …），去重保序 */
  envs: string[];
  urls: string[];
  ids: string[];
}

/**
 * 同一系统下经常有「合同管理系统-测试」「合同管理系统-正式」两条同名条目。
 * 展开展示时按名字合并成一行，环境标在右侧 —— 否则卡片里看着就是重复的两条。
 */
export function mergeEntries(list: SystemGroupInput['entries']): MergedEntry[] {
  const map = new Map<string, MergedEntry>();
  (list || []).forEach((e) => {
    const name = String(e.name || e.url || '未命名').trim();
    const key = name.toLowerCase();
    let m = map.get(key);
    if (!m) {
      m = { name, envs: [], urls: [], ids: [] };
      map.set(key, m);
    }
    m.ids.push(e.id);
    if (e.envType && !m.envs.includes(e.envType)) m.envs.push(e.envType);
    if (e.url && !m.urls.includes(e.url)) m.urls.push(e.url);
  });
  return Array.from(map.values());
}

export interface SystemStats {
  systems: number;
  accounts: number;
  envs: number;
  entries: number;
  /** 没填「系统」字段的账号数：这堆会在最后一组里，需要提示用户去补 */
  orphanAccounts: number;
}

export function systemStats(groups: SystemGroup[]): SystemStats {
  const nonEmpty = groups.filter(g => g.key !== '__none__');
  const inline = (g: SystemGroup) => g.inlineAccounts.length;
  return {
    systems: nonEmpty.length,
    accounts: nonEmpty.reduce((s, g) => s + g.accounts.length + inline(g), 0),
    envs: nonEmpty.reduce((s, g) => s + g.envs.length, 0),
    entries: nonEmpty.reduce((s, g) => s + g.entries.length, 0),
    orphanAccounts: (groups.find(g => g.key === '__none__')?.accounts || []).length,
  };
}
