import type { ApiSchemaNode } from '../types';
import { buildSchema } from './apiSchema';

/** 把 key 变成安全的 TS 字段名 / 类型名片段 */
const pascal = (s: string) =>
  String(s || '')
    .replace(/[^a-zA-Z0-9_$\u4e00-\u9fa5]+(.)?/g, (_m, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_m, c) => c.toUpperCase()) || 'Field';

const safeKey = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

/**
 * JSON → TypeScript 接口定义。
 * 从结构描述生成，所以数组里元素字段不一致时会合并成并集字段（缺的字段标 ?），
 * 类型冲突（string 与 number 混用）降级成 unknown，不会编出一个「看着对但跑不通」的类型。
 */
export function jsonToTsTypes(value: unknown, rootName = 'Root'): string {
  const schema = buildSchema(value);
  const decls: string[] = [];
  const emitted = new Set<string>();

  const tsType = (n: ApiSchemaNode, name: string): string => {
    switch (n.t) {
      case 'string': return 'string';
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'mixed': return 'unknown';
      case 'array': {
        const item = n.item;
        if (!item) return 'unknown[]';
        if (item.t === 'object') {
          const itemName = `${name}Item`;
          emitObject(item, itemName);
          return `${itemName}[]`;
        }
        if (item.t === 'mixed') return 'unknown[]';
        return `${tsType(item, `${name}Item`)}[]`;
      }
      case 'object': {
        emitObject(n, name);
        return name;
      }
      default: return 'unknown';
    }
  };

  function emitObject(n: ApiSchemaNode, name: string) {
    if (emitted.has(name)) return;
    emitted.add(name);
    const fields = n.fields || {};
    const lines = Object.entries(fields).map(([k, v]) => `  ${safeKey(k)}: ${tsType(v, name + pascal(k))};`);
    decls.push(`export interface ${name} {\n${lines.join('\n')}\n}`);
  }

  if (schema.t === 'array') {
    const item = schema.item;
    if (item && item.t === 'object') {
      emitObject(item, `${rootName}Item`);
      return `${decls.join('\n\n')}\n\nexport type ${rootName} = ${rootName}Item[];\n`;
    }
    return `export type ${rootName} = ${tsType(item || { t: 'mixed' }, rootName)}[];\n`;
  }
  if (schema.t === 'object') {
    emitObject(schema, rootName);
    return `${decls.join('\n\n')}\n`;
  }
  return `export type ${rootName} = ${tsType(schema, rootName)};\n`;
}

const cellText = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  if (typeof v === 'object') return JSON.stringify(v).replace(/\|/g, '\\|');
  return String(v);
};

/**
 * JSON → Markdown 表格。
 * 数组按行展开（最多 maxRows 行，超出提示），对象当一行「字段/值」表。
 * 单元格里的换行压成空格、竖线转义，保证粘进禅道/群消息不会把表拆散。
 */
export function jsonToMarkdownTable(value: unknown, maxRows = 50): string {
  if (Array.isArray(value)) {
    const rows = value.filter(r => r !== null && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[];
    if (value.length === 0) return '（空数组，没有可导出的行）';
    if (rows.length === 0) {
      // 纯标量数组：一列
      const shown = value.slice(0, maxRows);
      return ['| # | 值 |', '| --- | --- |', ...shown.map((v, i) => `| ${i + 1} | ${cellText(v)} |`)].join('\n');
    }
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const shown = rows.slice(0, maxRows);
    const head = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const body = shown.map(r => `| ${cols.map(c => cellText(r[c])).join(' | ')} |`);
    const note = rows.length > shown.length ? `\n\n> 共 ${rows.length} 行，只列出前 ${shown.length} 行。` : '';
    return [head, sep, ...body].join('\n') + note;
  }
  if (value !== null && typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>);
    return ['| 字段 | 值 |', '| --- | --- |', ...pairs.map(([k, v]) => `| ${k} | ${cellText(v)} |`)].join('\n');
  }
  return `| 值 |\n| --- |\n| ${cellText(value)} |`;
}

/** 响应体 → TS / Markdown；不是 JSON 返回 null */
export function codegenFromBody(body: string): { ts: string; md: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  return { ts: jsonToTsTypes(json), md: jsonToMarkdownTable(json) };
}