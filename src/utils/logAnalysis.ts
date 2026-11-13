/**
 * 日志分析（纯函数，无 DOM / 无 IPC）。
 *
 * 解决的问题：一段几百上千行的日志里，真正有价值的是「哪几类异常、各出现多少次、
 * 什么时候开始出现、和别人的差异在哪」。肉眼翻找既慢又容易漏。
 *
 * 做三件事：
 *  1. 事件切分：把「头行（带级别或异常名）+ 后续堆栈行」切成一个事件；
 *  2. 聚类：把数字、地址、行号归一化后作为签名，同类事件合并计数；
 *  3. 输出：按出现次数排序，给出首次/末次时间与折叠后的堆栈。
 *
 * 归一化很重要：`at Foo.bar(Foo.java:42)` 和 `at Foo.bar(Foo.java:87)` 必须是同一类，
 * 否则同一个异常会被拆成几十条。
 */

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** 聚类结果 */
export interface LogCluster {
  /** 归一化签名，用于去重 */
  key: string;
  /** 展示标题：异常类名优先，没有就取消息前一段 */
  title: string;
  count: number;
  level: LogLevel;
  /** 首次出现时的原始头行 */
  message: string;
  /** 首次 / 末次出现时的日志内时间戳（原文，未解析成 Date） */
  firstAt?: string;
  lastAt?: string;
  /** 首次 / 末次所在行号（1 基） */
  firstLine: number;
  lastLine: number;
  /** 折叠后的堆栈（保留首次出现的那份，已去除纯行号差异） */
  stack: string[];
}

export interface LogAnalysis {
  totalLines: number;
  /** 非空行数 */
  filledLines: number;
  /** 各级别出现的行数 */
  levelCounts: Record<LogLevel, number>;
  clusters: LogCluster[];
  /** 整段日志的时间范围 */
  from?: string;
  to?: string;
  /** 既不是事件头、也不是堆栈行的行数（普通消息行） */
  plainLines: number;
  /** 识别到的事件总数（含重复） */
  events: number;
}

const LEVELS: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

/** 行首 80 字符内找级别：消息体里出现 "ERROR" 字样的不算 */
const HEAD_LEVEL = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|SEVERE)\b/;

/** 堆栈行：Java / JS / Python / .NET 常见的四种写法 */
const STACK_LINE = /^\s*(?:at\s|\.{3}\s*\d+\s+more|Caused by:|Suppressed:|File\s+")/;

/** 异常类名：java.lang.NullPointerException、TypeError、System.NullReferenceException 等 */
const EXC_NAME = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Exception|Error|Throwable))\b/;

/** 常见时间戳：2026-11-13 14:20:31 / 2026-11-13T14:20:31.123 / [14:20:31] */
const TS_FULL = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?/;
const TS_TIME = /\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?/;

/** 把随行变化的片段抹平，让同类事件落到同一个签名上 */
export function normalizeForSignature(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?/g, '<t>')
    .replace(/0x[0-9a-fA-F]+/g, '0x#')
    // 文件:行号 / (Foo.java:42) 这类，行号最不稳定
    .replace(/(:\d+)(?=[)\s,:]|$)/g, ':#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function levelOf(line: string): LogLevel | null {
  const head = line.slice(0, 80);
  const m = HEAD_LEVEL.exec(head);
  if (!m) return null;
  const raw = m[1].toUpperCase();
  if (raw === 'WARNING') return 'WARN';
  if (raw === 'SEVERE') return 'ERROR';
  return raw as LogLevel;
}

function stampOf(line: string): string | undefined {
  const full = TS_FULL.exec(line);
  if (full) return full[0];
  const only = TS_TIME.exec(line);
  if (only) return only[0];
  return undefined;
}

/** 头行：有级别，或者虽然没级别但直接抛了异常名 */
function isHeadLine(line: string, level: LogLevel | null): boolean {
  if (level) return true;
  return EXC_NAME.test(line.slice(0, 120));
}

function titleOf(line: string, level: LogLevel): string {
  const exc = EXC_NAME.exec(line.slice(0, 200));
  if (exc) return exc[1];
  // 去掉时间戳与级别，剩下的就是消息
  let rest = line
    .replace(TS_FULL, '')
    .replace(TS_TIME, '')
    .replace(HEAD_LEVEL, '')
    .replace(/^[\s[\]|:,-]+/, '')
    .trim();
  if (!rest) rest = level;
  return rest.length > 60 ? `${rest.slice(0, 60)}…` : rest;
}

interface RawEvent {
  level: LogLevel;
  message: string;
  stack: string[];
  at?: string;
  line: number;
}

/** 逐行切事件：头行开一个新的，堆栈行并进当前，其他行结束当前 */
function splitEvents(lines: string[]): { events: RawEvent[]; plain: number } {
  const events: RawEvent[] = [];
  const plain: number[] = [];
  let cur: RawEvent | null = null;

  const flush = () => {
    if (cur) events.push(cur);
    cur = null;
  };

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return;
    const level = levelOf(line);

    if (STACK_LINE.test(line)) {
      if (cur) cur.stack.push(line);
      else plain.push(i + 1);
      return;
    }

    if (isHeadLine(line, level)) {
      flush();
      cur = {
        level: level || 'ERROR',
        message: line.trim(),
        stack: [],
        at: stampOf(line),
        line: i + 1,
      };
      return;
    }

    // 普通行：如果当前事件刚开且紧邻（堆栈里偶尔夹一行说明），算它的续行
    if (cur && cur.stack.length === 0 && cur.message.length < 400) {
      cur.message += `\n${line.trim()}`;
      if (!cur.at) cur.at = stampOf(line);
      return;
    }

    flush();
    plain.push(i + 1);
  });

  flush();
  return { events, plain: plain.length };
}

/** 分析一段日志 */
export function analyzeLog(text: string): LogAnalysis {
  const lines = String(text || '').split('\n');
  const filled = lines.filter((l) => l.trim()).length;
  const { events, plain } = splitEvents(lines);

  const levelCounts: Record<LogLevel, number> = {
    TRACE: 0, DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0,
  };
  lines.forEach((line) => {
    const lv = levelOf(line);
    if (lv) levelCounts[lv] += 1;
  });

  const byKey = new Map<string, LogCluster>();
  const order: string[] = [];

  events.forEach((ev) => {
    const stackSig = ev.stack.slice(0, 3).map(normalizeForSignature).join('|');
    const key = `${normalizeForSignature(ev.message)}##${stackSig}`;
    const hit = byKey.get(key);
    if (hit) {
      hit.count += 1;
      hit.lastLine = ev.line;
      if (ev.at) {
        hit.lastAt = ev.at;
        if (!hit.firstAt) hit.firstAt = ev.at;
      }
      return;
    }
    const cluster: LogCluster = {
      key,
      title: titleOf(ev.message, ev.level),
      count: 1,
      level: ev.level,
      message: ev.message,
      firstAt: ev.at,
      lastAt: ev.at,
      firstLine: ev.line,
      lastLine: ev.line,
      stack: ev.stack,
    };
    byKey.set(key, cluster);
    order.push(key);
  });

  const clusters = order.map((k) => byKey.get(k)!);
  // 次数多的在前；同次数按首次出现的行号，保持稳定
  clusters.sort((a, b) => (b.count - a.count) || (a.firstLine - b.firstLine));

  const stamps: string[] = [];
  lines.forEach((line) => {
    const s = stampOf(line);
    if (s) stamps.push(s);
  });

  return {
    totalLines: lines.length,
    filledLines: filled,
    levelCounts,
    clusters,
    from: stamps[0],
    to: stamps.length > 1 ? stamps[stamps.length - 1] : undefined,
    plainLines: plain,
    events: events.length,
  };
}

/** 只要错误级别（含 FATAL）的聚类 */
export function onlyErrors(clusters: LogCluster[]): LogCluster[] {
  return clusters.filter((c) => c.level === 'ERROR' || c.level === 'FATAL');
}

/** 生成可粘贴的摘要文本 */
export function toSummaryText(a: LogAnalysis, opts: { onlyError?: boolean; max?: number; withStack?: boolean } = {}): string {
  const list = (opts.onlyError ? onlyErrors(a.clusters) : a.clusters).slice(0, opts.max ?? 50);
  if (!list.length) return '';

  const head = [
    `${a.filledLines} 行有效`,
    `ERROR ${a.levelCounts.ERROR}`,
    `FATAL ${a.levelCounts.FATAL}`,
    `WARN ${a.levelCounts.WARN}`,
    `${a.clusters.length} 类事件`,
    a.from ? `${a.from} ~ ${a.to || a.from}` : '',
  ].filter(Boolean).join(' · ');

  const body = list.map((c, i) => {
    const when = c.firstAt
      ? ` · 首次 ${c.firstAt}${c.lastAt && c.lastAt !== c.firstAt ? ` · 末次 ${c.lastAt}` : ''}`
      : '';
    const lines = [`[${i + 1}] ${c.count} 次 · ${c.level} ${c.title}${when}`];
    if (opts.withStack !== false) {
      lines.push(`    ${c.message.split('\n')[0]}`);
      c.stack.forEach((s) => lines.push(`    ${s.trim()}`));
    }
    return lines.join('\n');
  });

  return [head, '─'.repeat(40), ...body].join('\n');
}
