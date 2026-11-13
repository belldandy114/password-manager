/**
 * 粘贴内容识别（纯函数，无 DOM / 无 IPC）。
 *
 * 场景：在命令面板里 Ctrl+V，与其把内容塞进搜索框当关键词，不如先判断这是什么，
 * 直接给出「用它做什么」的动作（存网址 / 存片段 / 发请求 / 分析日志）。
 *
 * 判定顺序按「误判代价」排：URL 与 JWT 最严格（必须整段匹配），
 * JSON 要求能真正 parse 成功，SQL 要求首个关键字，日志要求多行 + 时间戳/异常特征。
 * 都不满足就返回 unknown，交回原来的文本搜索行为。
 */

import { looksLikeAccessLog, parseAccessLog } from './accessLog';

export type PasteKind = 'url' | 'sql' | 'json' | 'log' | 'accesslog' | 'jwt' | 'unknown';
export interface PasteIntent {
  kind: PasteKind;
  /** 判定依据的一句话说明，展示在动作项下方 */
  hint: string;
  /** 展示用摘要（最多两行） */
  preview: string;
  lines: number;
  chars: number;
}

const MAX_JSON_CHARS = 1024 * 1024;

const URL_FULL = /^(?:https?|wss?):\/\/\S+$/i;
const URL_BARE = /^[\w-]+(?:\.[\w-]+)+(?::\d{1,5})?(?:\/\S*)?$/;
const JWT_FULL = /^ey[\w-]+\.[\w-]+\.[\w-]+$/;
const SQL_HEAD = /^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*\s*(select|insert|update|delete|with|create|alter|drop|truncate|merge)\b/i;
const TS_ANY = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}/;
/** 异常类名：TypeError / NullPointerException / Traceback 等，不要求 Exception 前有词边界 */
const EXC_ANY = /\b[A-Za-z_$][\w$]*(?:Error|Exception)\b|Traceback/;
const LV_ANY = new RegExp(`\\b(ERROR|FATAL|SEVERE|WARN(?:ING)?)\\b|${EXC_ANY.source}`);
const STACK_ANY = /^\s*(?:at\s|File\s+")/m;

/** 摘要优先取「带异常名的那一行」——比取第一行（往往是启动日志）有用 */
function previewOf(text: string): string {
  const all = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const keep = all.find((l) => EXC_ANY.test(l)) || all.slice(0, 2).join(' / ');
  return keep.length > 100 ? `${keep.slice(0, 100)}…` : keep;
}

function isJson(text: string): boolean {
  const t = text.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
  if (t.length > MAX_JSON_CHARS) return false;
  try {
    const v = JSON.parse(t);
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
}

/** 识别一段粘贴内容 */
export function detectPaste(input: string): PasteIntent {
  const text = String(input || '').trim();
  const lines = text ? text.split('\n').length : 0;
  const chars = text.length;
  const base = { preview: previewOf(text), lines, chars };

  if (!text) return { kind: 'unknown', hint: '', ...base };

  // 1. JWT 必须排在 URL 之前：三段 base64url 用点分隔，会被裸域名规则误当成域名
  if (lines === 1 && JWT_FULL.test(text)) {
    return { kind: 'jwt', hint: '看起来是一个 JWT（三段 base64url）', ...base };
  }

  // 2. 整段就是一个 URL（含协议，或裸域名带可选端口/路径）
  if (lines === 1 && !/\s/.test(text)) {
    if (URL_FULL.test(text)) return { kind: 'url', hint: '整段是一个带协议的地址', ...base };
    if (URL_BARE.test(text)) return { kind: 'url', hint: '整段是一个域名 / 局域网地址', ...base };
  }

  // 3. 合法 JSON 对象 / 数组
  if (isJson(text)) {
    const first = text.trim()[0];
    return { kind: 'json', hint: first === '[' ? '是合法的 JSON 数组' : '是合法的 JSON 对象', ...base };
  }

  // 4. SQL：首个关键字决定（跳过前导注释）
  if (SQL_HEAD.test(text) && chars >= 10) {
    const kw = SQL_HEAD.exec(text)![1].toUpperCase();
    return { kind: 'sql', hint: `以 ${kw} 开头，像一条 SQL 语句`, ...base };
  }

  // 5. 访问日志：Nginx / Apache 一行一条请求，单行也能认出来
  if (looksLikeAccessLog(text)) {
    const parsed = parseAccessLog(text);
    return {
      kind: 'accesslog',
      hint: `像 Web 访问日志（${parsed.matched} 条${parsed.total > parsed.matched ? ` / 共 ${parsed.total} 行` : ''}）`,
      ...base,
    };
  }

  // 6. 日志：多行 + 时间戳/异常特征
  if (lines >= 3) {
    const hasTs = TS_ANY.test(text);
    const hasLv = LV_ANY.test(text);
    const hasStack = STACK_ANY.test(text);
    if (hasTs && (hasLv || hasStack)) {
      return { kind: 'log', hint: '多行且带时间戳与级别 / 堆栈，像一段运行日志', ...base };
    }
    if (hasLv && hasStack) {
      return { kind: 'log', hint: '多行且带异常与堆栈，像一段报错日志', ...base };
    }
  }

  return { kind: 'unknown', hint: '', ...base };
}

/** 动作项标题（统一文案，避免各处写得不一致） */
export const PASTE_ACTION: Record<Exclude<PasteKind, 'unknown'>, string> = {
  url: '存进网址管理',
  sql: '存成 SQL 片段',
  json: '用这段 JSON 发请求',
  log: '用日志分析打开',
  accesslog: '用访问日志分析打开',
  jwt: '用 JWT 工具解析',
};

/** 识别结果的中文名（面板顶部「已识别为 XX」用） */
export const PASTE_KIND_LABEL: Record<PasteKind, string> = {
  url: '网址',
  sql: 'SQL 语句',
  json: 'JSON',
  log: '运行日志',
  accesslog: '访问日志',
  jwt: 'JWT',
  unknown: '文本',
};
