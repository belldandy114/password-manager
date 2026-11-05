import React from 'react';

/**
 * 极简 Markdown 渲染器
 *
 * 周报是手写的固定格式（**一、xxx** / 1. / （1） / 空行分段），
 * 引一个完整的 markdown 库不划算，这里只处理用到的语法：
 *   # ## ###            标题
 *   **加粗**            行内强调
 *   1. 2. 3.            有序列表
 *   - *                 无序列表
 *   （1） （2）         中文子编号（缩进一级）
 *   > 引用              引用块
 *   空行                分段
 */

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'li'; ordered: boolean; depth: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'quote'; text: string };

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** 行内：**加粗** 与 `代码` */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  let i = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<code key={`${keyPrefix}-c${i}`}>{token.slice(1, -1)}</code>);
    }
    last = m.index + token.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function parse(src: string): Block[] {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: 'h', level: Math.min(h[1].length, 4), text: h[2] });
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '') });
      continue;
    }
    const cn = line.match(/^[（(]\s*[0-9一二三四五六七八九十]+\s*[)）]\s*(.*)$/);
    if (cn) {
      blocks.push({ kind: 'li', ordered: false, depth: 1, text: cn[1] });
      continue;
    }
    const indent = line.match(/^[ \t　]+/);
    const depth = indent ? 1 : 0;
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
    if (ol) {
      blocks.push({ kind: 'li', ordered: true, depth, text: ol[1] });
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ul) {
      blocks.push({ kind: 'li', ordered: false, depth, text: ul[1] });
      continue;
    }
    // 整行都是加粗 → 当作小节标题
    const onlyBold = line.match(/^\s*\*\*(.+)\*\*\s*$/);
    if (onlyBold) {
      blocks.push({ kind: 'h', level: 4, text: onlyBold[1] });
      continue;
    }
    blocks.push({ kind: 'p', text: line.trim() });
  }
  return blocks;
}

export function renderMarkdown(src: string): React.ReactNode {
  const blocks = parse(src);
  const nodes: React.ReactNode[] = [];
  let listBuf: Block[] = [];
  let listKey = 0;

  const flushList = () => {
    if (listBuf.length === 0) return;
    const ordered = (listBuf[0] as { ordered?: boolean }).ordered !== false;
    const items = listBuf.map((b, i) => (
      <li key={i} className={b.kind === 'li' && b.depth > 0 ? 'md-li sub' : 'md-li'}>
        {inline(b.text, `l${listKey}-${i}`)}
      </li>
    ));
    nodes.push(
      ordered
        ? <ol className="md-list" key={`ol${listKey}`}>{items}</ol>
        : <ul className="md-list" key={`ul${listKey}`}>{items}</ul>,
    );
    listBuf = [];
    listKey++;
  };

  blocks.forEach((b, i) => {
    if (b.kind === 'li') { listBuf.push(b); return; }
    flushList();
    if (b.kind === 'h') {
      const Tag = (b.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4';
      nodes.push(<Tag className="md-h" key={`h${i}`}>{inline(b.text, `h${i}`)}</Tag>);
    } else if (b.kind === 'quote') {
      nodes.push(<blockquote className="md-quote" key={`q${i}`}>{inline(b.text, `q${i}`)}</blockquote>);
    } else {
      nodes.push(<p className="md-p" key={`p${i}`}>{inline(b.text, `p${i}`)}</p>);
    }
  });
  flushList();

  return nodes;
}

/** 从周报文件名里取日期：2026-06-18.md → 2026-06-18 */
export function dateFromName(name: string): string {
  const m = String(name).match(/(\d{4})[-_.年]?(\d{1,2})[-_.月]?(\d{1,2})/);
  if (!m) return '';
  const mm = m[2].padStart(2, '0');
  const dd = m[3].padStart(2, '0');
  return `${m[1]}-${mm}-${dd}`;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayOf(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return WEEK[d.getDay()];
}

/** 第几周（按 ISO 周一为一周之始，简单起见按当年第几个自然周） */
export function weekNoOf(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 0;
  const start = new Date(d.getFullYear(), 0, 1);
  const diff = (d.getTime() - start.getTime()) / 86400000;
  return Math.floor(diff / 7) + 1;
}
