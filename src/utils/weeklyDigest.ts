/**
 * 周报草稿生成：把跨实例汇总回来的 Bug 数据，排成「现有周报」那套 Markdown 格式。
 *
 * 格式来源：E:\测试数据\09_工作记录\日常工作\周报\2026-10-30.md / 2026-11-06.md
 *   **一、资产管理系统V2.0**
 *
 *   累计缺陷 879 个，已关闭 754 个、已修复 663 个、待修复 104 个，另有 21 个已解决待验证，修复率 75.4%。模块分布如下：
 *
 *   （1）添置资产：共 255 个，待修复 35 个、待验证 10 个、已关闭 210 个
 *
 * 口径与 bugSummary.ts 保持一致：
 *   已修复 = resolution==='fixed' / 待修复 = status==='active'
 *   待验证 = status==='resolved' / 已关闭 = status==='closed'
 *   修复率 = 已修复 / 总数
 *
 * 注意这是「草稿」：报表测试、会议这类只有人知道的工作写不进去，要留给人补。
 */
import type { ZentaoBug, ZentaoDigestGroup } from '../types';
import { bugIsClosed, bugIsFixed } from './bugSummary';

export interface DigestOptions {
  /** 统计窗口（含首尾），YYYY-MM-DD */
  from: string;
  to: string;
  /** 按项目平铺（贴近现有周报） / 先公司后项目 */
  layout: 'byProject' | 'byCompany';
  /** 每个项目后面补一句「本周新增/解决/关闭」 */
  includeWeekly: boolean;
  /** 模块数超过这个值时，尾巴合并成「其他（A、B、C 等）」；0 = 不合并 */
  mergeModulesOver: number;
  /** 生成结尾的总结段 */
  includeSummary: boolean;
  /** 留一段「下周工作计划」骨架 */
  includeNextWeek: boolean;
  /**
   * 只统计这些创建人，**按实例分开**：`{ instanceId: ['张三', 'lisi'] }`。
   * 空对象 = 不筛。不同公司的同名/同账号不能互相影响，所以不能用一个全局数组。
   */
  openedBy: Record<string, string[]>;
}

export const DEFAULT_DIGEST_OPTIONS: DigestOptions = {
  from: '',
  to: '',
  layout: 'byProject',
  includeWeekly: true,
  mergeModulesOver: 12,
  includeSummary: true,
  includeNextWeek: true,
  openedBy: {},
};

/* ---------------- 日期 ---------------- */

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 本周一（周一为一周开始） */
export function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay(); // 0=周日
  x.setDate(x.getDate() - (dow === 0 ? 6 : dow - 1));
  return x;
}

/** 「本周」默认窗口：本周一 ~ 今天 */
export function defaultRange(now = new Date()): { from: string; to: string } {
  return { from: ymd(mondayOf(now)), to: ymd(now) };
}

const dayOf = (v?: string) => String(v || '').trim().slice(0, 10);
const inRange = (day: string, from: string, to: string) => !!day && day >= from && day <= to;

/* ---------------- 中文序号 ---------------- */

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 1 → 一、11 → 十一、23 → 二十三 */
export function cnIndex(n: number): string {
  if (n <= 0) return String(n);
  if (n < 10) return CN[n];
  if (n === 10) return '十';
  if (n < 20) return `十${CN[n - 10]}`;
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${CN[t]}十${o ? CN[o] : ''}`;
}

/* ---------------- 统计 ---------------- */

export interface ModuleStat {
  name: string;
  total: number;
  active: number;   // 待修复
  resolved: number; // 待验证
  closed: number;
  fixed: number;
}

export interface ProjectStat {
  /** 复合键 实例id::产品id —— 不同禅道的产品 id 会重名 */
  key: string;
  instanceId: string;
  instanceName: string;
  productId: string;
  productName: string;
  total: number;
  fixed: number;
  active: number;
  resolved: number;
  closed: number;
  rate: number;
  /** 本周（from~to）新增 / 解决 / 关闭 */
  weekNew: number;
  weekResolved: number;
  weekClosed: number;
  modules: ModuleStat[];
}

const rateOf = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/** 模块名取路径第一段：现有周报里写的是「添置资产」这种顶层模块，不是「添置资产/列表」 */
const topModule = (b: ZentaoBug) => {
  const raw = String(b.moduleName || '').trim();
  if (!raw) return '未指定模块';
  return raw.split('/')[0].trim() || '未指定模块';
};

function buildProject(
  key: string, instanceId: string, instanceName: string,
  productId: string, productName: string,
  bugs: ZentaoBug[], opt: DigestOptions,
): ProjectStat {
  const stat: ProjectStat = {
    key, instanceId, instanceName, productId, productName,
    total: 0, fixed: 0, active: 0, resolved: 0, closed: 0, rate: 0,
    weekNew: 0, weekResolved: 0, weekClosed: 0,
    modules: [],
  };
  const mods = new Map<string, ModuleStat>();

  for (const b of bugs) {
    const st = String(b.status || '');
    stat.total += 1;
    if (bugIsFixed(b)) stat.fixed += 1;
    if (st === 'closed') stat.closed += 1;
    else if (st === 'active') stat.active += 1;
    else if (st === 'resolved') stat.resolved += 1;

    if (opt.includeWeekly) {
      if (inRange(dayOf(b.openedDate || b.date), opt.from, opt.to)) stat.weekNew += 1;
      if (inRange(dayOf(b.resolvedDate), opt.from, opt.to)) stat.weekResolved += 1;
      if (inRange(dayOf(b.closedDate), opt.from, opt.to)) stat.weekClosed += 1;
    }

    const name = topModule(b);
    const m = mods.get(name) || { name, total: 0, active: 0, resolved: 0, closed: 0, fixed: 0 };
    m.total += 1;
    if (bugIsClosed(b)) m.closed += 1;
    else if (st === 'active') m.active += 1;
    else if (st === 'resolved') m.resolved += 1;
    if (bugIsFixed(b)) m.fixed += 1;
    mods.set(name, m);
  }

  stat.rate = rateOf(stat.fixed, stat.total);
  // 数量降序，同数量按名称稳定排序（每次生成结果一致，方便 diff）
  stat.modules = [...mods.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
  return stat;
}

export interface DigestResult {
  markdown: string;
  projects: ProjectStat[];
}

export function buildDigest(groups: ZentaoDigestGroup[], opt: DigestOptions): DigestResult {
  const projects: ProjectStat[] = [];
  // 按创建人筛选：真名和账号都认（禅道里两者可能不同），并且按实例分开比
  const keepByInstance = new Map<string, Set<string>>();
  for (const [iid, names] of Object.entries(opt.openedBy || {})) {
    const set = new Set((names || []).map(n => String(n).trim()).filter(Boolean));
    if (set.size) keepByInstance.set(String(iid), set);
  }
  const openedMatches = (keep: Set<string>, b: ZentaoBug) =>
    keep.has(String(b.openedBy || '').trim()) || keep.has(String(b.openedByAccount || '').trim());

  for (const g of groups) {
    if (!g || !g.ok) continue;
    const keep = keepByInstance.get(String(g.instanceId));
    const byProduct = new Map<string, ZentaoBug[]>();
    for (const b of g.bugs || []) {
      if (keep && !openedMatches(keep, b)) continue;
      const pid = String(b.product || '');
      const arr = byProduct.get(pid) || [];
      arr.push(b);
      byProduct.set(pid, arr);
    }
    for (const [pid, list] of byProduct) {
      const name = list.find(b => b.productName)?.productName || `产品 ${pid}`;
      projects.push(buildProject(
        `${g.instanceId}::${pid}`, g.instanceId, g.name, pid, name, list, opt,
      ));
    }
  }

  // 总量降序：现有周报里大系统排在前面
  projects.sort((a, b) => b.total - a.total || a.productName.localeCompare(b.productName, 'zh'));

  // 同名项目跨公司时补公司名，否则「一、资产管理系统」「二、资产管理系统」分不清
  const nameCount = new Map<string, number>();
  for (const p of projects) nameCount.set(p.productName, (nameCount.get(p.productName) || 0) + 1);
  const titleOf = (p: ProjectStat) =>
    (nameCount.get(p.productName) || 0) > 1 ? `${p.productName}（${p.instanceName}）` : p.productName;

  const blocks: string[] = [];
  let idx = 0;

  const projectBlock = (p: ProjectStat) => {
    idx += 1;
    const lines: string[] = [];
    lines.push(`**${cnIndex(idx)}、${titleOf(p)}**`);
    lines.push('');
    lines.push(
      `累计缺陷 ${p.total} 个，已关闭 ${p.closed} 个、已修复 ${p.fixed} 个、待修复 ${p.active} 个` +
      `${p.resolved ? `，另有 ${p.resolved} 个已解决待验证` : ''}，修复率 ${p.rate}%。模块分布如下：`,
    );
    if (opt.includeWeekly && (p.weekNew || p.weekResolved || p.weekClosed)) {
      lines.push('');
      lines.push(`本周新增 ${p.weekNew} 个、解决 ${p.weekResolved} 个、关闭 ${p.weekClosed} 个。`);
    }
    lines.push('');

    const shown = opt.mergeModulesOver > 0 && p.modules.length > opt.mergeModulesOver
      ? p.modules.slice(0, opt.mergeModulesOver - 1)
      : p.modules;
    const rest = p.modules.length - shown.length;

    shown.forEach((m, i) => {
      const parts: string[] = [];
      if (m.active) parts.push(`待修复 ${m.active} 个`);
      if (m.resolved) parts.push(`待验证 ${m.resolved} 个`);
      if (m.closed) parts.push(`已关闭 ${m.closed} 个`);
      lines.push(`（${i + 1}）${m.name}：共 ${m.total} 个${parts.length ? `，${parts.join('、')}` : ''}`);
    });

    if (rest > 0) {
      const tail = p.modules.slice(shown.length);
      // 长尾不逐个列名字，只挑前三个示意（现有周报的「其他（角色管理、用户管理、系统管理等）」）
      const names = tail.slice(0, 3).map(m => m.name).join('、');
      const sum = tail.reduce((acc, m) => {
        acc.total += m.total; acc.active += m.active; acc.resolved += m.resolved; acc.closed += m.closed;
        return acc;
      }, { total: 0, active: 0, resolved: 0, closed: 0 });
      const parts: string[] = [];
      if (sum.active) parts.push(`待修复 ${sum.active} 个`);
      if (sum.resolved) parts.push(`待验证 ${sum.resolved} 个`);
      if (sum.closed) parts.push(`已关闭 ${sum.closed} 个`);
      lines.push(
        `（${shown.length + 1}）其他（${names}${tail.length > 3 ? '等' : ''}）：共 ${sum.total} 个` +
        `${parts.length ? `，${parts.join('、')}` : ''}`,
      );
    }
    return lines.join('\n');
  };

  if (opt.layout === 'byCompany') {
    const byInstance = new Map<string, ProjectStat[]>();
    for (const p of projects) {
      const arr = byInstance.get(p.instanceName) || [];
      arr.push(p);
      byInstance.set(p.instanceName, arr);
    }
    for (const [name, list] of byInstance) {
      idx += 1;
      blocks.push(`**${cnIndex(idx)}、${name}**`);
      for (const p of list) {
        // 公司段里的项目降一级：用「1.」而不是新章节
        const lines = projectBlock(p).split('\n');
        lines[0] = `1、${p.productName}`;
        blocks.push(lines.join('\n'));
      }
    }
  } else {
    for (const p of projects) blocks.push(projectBlock(p));
  }

  const parts: string[] = [blocks.join('\n\n')];
  if (opt.includeSummary && projects.length) {
    const segs = projects.map(p => {
      const top = p.modules.slice(0, 3).map(m => m.name).filter(Boolean);
      // 0 值不写：「已解决待验证 0 个」读起来像凑字
      return `${titleOf(p)}累计发现缺陷 ${p.total} 个，已关闭 ${p.closed} 个、已修复 ${p.fixed} 个、` +
        `待修复 ${p.active} 个${p.resolved ? `、已解决待验证 ${p.resolved} 个` : ''}，修复率 ${p.rate}%` +
        `${top.length ? `，主要集中在${top.join('、')}等模块` : ''}`;
    });
    // 同名项目要用带公司名的标题，否则「本周完成资产管理系统、资产管理系统…」
    const names = projects.map(p => titleOf(p));
    parts.push(
      `本周完成${names.join('、')}的测试与缺陷跟踪。${segs.join('；')}。` +
      `整体测试与修复工作按计划推进。`,
    );
  }

  if (opt.includeNextWeek && projects.length) {
    const lines = ['下周工作计划'];
    projects.slice(0, 4).forEach((p, i) => {
      lines.push(`${cnIndex(i + 1)}、${titleOf(p)}`);
      lines.push('1、回归测试开发已修复的缺陷');
      lines.push('2、继续对已完成的功能进行测试');
      lines.push('');
    });
    parts.push(lines.join('\n').trimEnd());
  }

  // 按创建人统计时把范围写在最前面，并标明是哪家公司的谁
  const scopeParts: string[] = [];
  for (const g of groups) {
    const keep = keepByInstance.get(String(g.instanceId));
    if (keep && keep.size) scopeParts.push(`${g.name}：${[...keep].join('、')}`);
  }
  const scope = scopeParts.length && projects.length
    ? `统计范围：创建人 ${scopeParts.join('；')}（${opt.from} 至 ${opt.to}）`
    : '';
  const body = parts.join('\n\n').trimEnd();
  return { markdown: `${scope ? `${scope}\n\n` : ''}${body}\n`, projects };
}

/* ---------------- 合并进已有草稿 ---------------- */

/**
 * 把新生成的内容合并进已有草稿。
 *
 * 使用场景：草稿已经生成过一次、也手工补过「测试了哪些报表」这类内容，
 * 后面又拉了一次禅道（换了时间窗、加了项目）。这时候不能整篇覆盖，
 * 否则手写的内容全没了。
 *
 * 规则：
 *   - 同名项目章节（`**一、xxx**` 的标题相同）→ 整段换成新数字
 *   - 新项目 → 追加到已有章节末尾
 *   - 你自己的结尾总结 / 下周计划 / 额外段落 → **原样保留**
 *   - 项目序号统一重排
 */
export interface DigestMergeStats {
  /** 原地更新了几个项目章节 */
  updated: number;
  /** 新追加了几个项目章节 */
  added: number;
}

interface DigestBlock {
  title: string;
  /** 标题行之后的正文（不含标题） */
  body: string[];
  /** 完整块（标题 + 正文），追加新项目时用 */
  lines: string[];
}

interface ParsedDoc {
  /** 第一个项目标题之前的内容（一般是「统计范围：…」） */
  head: string[];
  blocks: DigestBlock[];
  byTitle: Map<string, DigestBlock>;
  /** 从结尾总结段 / 下周计划开始的内容，原样保留 */
  tail: string[];
}

const TITLE_LINE = /^\*\*[一二三四五六七八九十百]+、(.+?)\*\*\s*$/;
/** 这些行开始就不再属于「项目章节」，而是结尾段落 */
const TAIL_BEGIN = /^(统计范围：|本周完成|下周工作计划|\*\*下周工作计划\*\*)/;

function parseDoc(text: string): ParsedDoc {
  const lines = text.split('\n');
  const heads: { idx: number; title: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(TITLE_LINE);
    if (m) heads.push({ idx: i, title: m[1].trim() });
  });

  // 结尾段落的起点：最后一个项目标题之后，第一行「本周完成 / 下周工作计划」
  let tailStart = lines.length;
  if (heads.length) {
    for (let i = heads[0].idx + 1; i < lines.length; i++) {
      if (TAIL_BEGIN.test(lines[i].trim())) { tailStart = i; break; }
    }
  }

  const blocks: DigestBlock[] = heads.map((h, i) => {
    const next = i + 1 < heads.length ? heads[i + 1].idx : tailStart;
    const end = Math.max(next, h.idx + 1);
    const body = lines.slice(h.idx + 1, end);
    const trimmed = trimBlank(body);
    return {
      title: h.title,
      body: trimmed,
      lines: [lines[h.idx], ...trimmed],
    };
  });

  const byTitle = new Map<string, DigestBlock>();
  for (const b of blocks) byTitle.set(b.title, b);

  return {
    head: trimBlank(lines.slice(0, heads.length ? heads[0].idx : tailStart)),
    blocks,
    byTitle,
    tail: trimBlank(lines.slice(tailStart)),
  };
}

function trimBlank(lines: string[]): string[] {
  let a = 0; let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

export function mergeDigest(existing: string, generated: string): { markdown: string; stats: DigestMergeStats } {
  const oldText = String(existing || '').replace(/\r\n/g, '\n').trim();
  const newText = String(generated || '').replace(/\r\n/g, '\n').trim();
  if (!oldText) return { markdown: newText ? `${newText}\n` : '', stats: { updated: 0, added: 0 } };
  if (!newText) return { markdown: `${oldText}\n`, stats: { updated: 0, added: 0 } };

  const oldDoc = parseDoc(oldText);
  const newDoc = parseDoc(newText);

  // 老草稿里一个项目章节都没有（比如整篇是你手写的）：新章节放最前，原文整段留着，不删任何东西
  if (oldDoc.blocks.length === 0) {
    const body = newDoc.blocks.map(b => b.lines.join('\n')).join('\n\n');
    if (!body) return { markdown: `${oldText}\n`, stats: { updated: 0, added: 0 } };
    return {
      markdown: `${body}\n\n${oldText}\n`,
      stats: { updated: 0, added: newDoc.blocks.length },
    };
  }

  // 顺序沿用老草稿（用户已经排好的先后别动），再追加新项目
  let updated = 0;
  let added = 0;
  const merged: DigestBlock[] = [];
  for (const b of oldDoc.blocks) {
    const fresh = newDoc.byTitle.get(b.title);
    if (fresh) {
      updated += 1;
      merged.push({ title: b.title, body: fresh.body, lines: [] });
    } else {
      merged.push({ title: b.title, body: b.body, lines: [] });
    }
  }
  for (const b of newDoc.blocks) {
    if (!oldDoc.byTitle.has(b.title)) {
      added += 1;
      merged.push({ title: b.title, body: b.body, lines: [] });
    }
  }

  // 前置区：「统计范围：…」以新的为准，其余老内容保留
  const headLines = newDoc.head.length
    ? newDoc.head
    : oldDoc.head.filter(l => !/^统计范围：/.test(l.trim()));

  // 结尾段落：老草稿有就用老的（你改过的措辞不能被覆盖），没有才补新的
  const tailLines = oldDoc.tail.length ? oldDoc.tail : newDoc.tail;

  const body = merged
    .map((b, i) => `**${cnIndex(i + 1)}、${b.title}**\n\n${b.body.join('\n')}`)
    .join('\n\n');

  const out = [headLines.join('\n'), body, tailLines.join('\n')].filter(s => s.trim()).join('\n\n');
  return { markdown: `${out}\n`, stats: { updated, added } };
}
