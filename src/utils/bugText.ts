import type { ZentaoBug } from '../types';

const SEVERITY_LABEL: Record<string, string> = {
  '1': '致命', '2': '严重', '3': '一般', '4': '轻微',
};
const STATUS_LABEL: Record<string, string> = {
  active: '激活', resolved: '已解决', closed: '已关闭', postponed: '已延期',
};

const sev = (b: ZentaoBug) => SEVERITY_LABEL[String(b.severity)] || b.severity || '—';
const stat = (b: ZentaoBug) => STATUS_LABEL[String(b.status)] || b.status || '—';

/** 单条 Bug → 可直接贴到群里的汇报文本 */
export function bugToText(b: ZentaoBug, baseUrl: string): string {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const lines = [
    `【${b.productName || '未分类'}】#${b.id} ${b.title}`,
    `状态：${stat(b)}${b.resolution === 'fixed' ? '（已修复）' : ''} ｜ 严重：${sev(b)} ｜ 优先级：${b.pri || '—'} ｜ 指派：${b.assignedTo || '—'} ｜ 创建：${b.date || '—'}`,
  ];
  if (b.deadline) lines.push(`截止：${b.deadline}`);
  if (base) lines.push(`${base}/bug-view-${b.id}.html`);
  return lines.join('\n');
}

/** 多条 Bug → 列表文本（默认）或 Markdown 表格 */
export function bugsToText(bugs: ZentaoBug[], baseUrl: string, format: 'list' | 'table' = 'list'): string {
  if (bugs.length === 0) return '';
  if (format === 'table') {
    const head = ['| ID | 标题 | 状态 | 严重 | 指派 | 项目 |', '| --- | --- | --- | --- | --- | --- |'];
    const rows = bugs.map(b => `| #${b.id} | ${b.title.replace(/\|/g, '｜')} | ${stat(b)} | ${sev(b)} | ${b.assignedTo || '—'} | ${b.productName || '—'} |`);
    return [...head, ...rows].join('\n');
  }
  return bugs.map(b => bugToText(b, baseUrl)).join('\n\n');
}

/** 导出 CSV（Excel 友好：字段带引号、内部双引号转义） */
export function bugsToCsv(bugs: ZentaoBug[], baseUrl: string): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['ID', '项目', '标题', '状态', '严重程度', '优先级', '指派给', '创建者', '创建日期', '解决日期', '截止日期', '链接'];
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const rows = bugs.map(b => [
    b.id,
    b.productName || '',
    b.title,
    stat(b),
    sev(b),
    b.pri || '',
    b.assignedTo || '',
    b.openedBy || '',
    b.date || '',
    b.resolvedDate || '',
    b.deadline || '',
    base ? `${base}/bug-view-${b.id}.html` : '',
  ].map(esc).join(','));
  return [head.map(esc).join(','), ...rows].join('\r\n');
}
