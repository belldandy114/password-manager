/**
 * 响应结构快照（契约回归）
 *
 * 只记录「结构」不记录值：哪个路径存在、是什么类型。接口改版时字段被删/改名/换类型
 * 会立刻显形，而业务数据（id、时间、金额）变化不会误报。
 */

import type { ApiSchemaNode, SchemaType, SchemaDiff } from '../types';

export type { ApiSchemaNode, SchemaType, SchemaDiff };

const typeOf = (v: any): SchemaType => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return 'object';
};

/** 合并两个节点（数组元素类型不统一时取 mixed，对象取字段并集） */
function mergeNode(a: ApiSchemaNode, b: ApiSchemaNode): ApiSchemaNode {
  if (a.t !== b.t) {
    // number / string 混着出现时按 mixed 处理，其余一律 mixed
    return { t: 'mixed' };
  }
  if (a.t === 'array' && a.item && b.item) return { t: 'array', item: mergeNode(a.item, b.item) };
  if (a.t === 'object') {
    const fields: Record<string, ApiSchemaNode> = { ...(a.fields || {}) };
    for (const [k, v] of Object.entries(b.fields || {})) {
      fields[k] = fields[k] ? mergeNode(fields[k], v) : v;
    }
    return { t: 'object', fields };
  }
  return { t: a.t };
}

/** 从任意 JSON 值生成结构描述 */
export function buildSchema(value: any): ApiSchemaNode {
  const t = typeOf(value);
  if (t === 'array') {
    const arr = value as any[];
    if (arr.length === 0) return { t: 'array', item: { t: 'mixed' } };
    let item = buildSchema(arr[0]);
    for (let i = 1; i < arr.length; i++) item = mergeNode(item, buildSchema(arr[i]));
    return { t: 'array', item };
  }
  if (t === 'object') {
    const fields: Record<string, ApiSchemaNode> = {};
    for (const [k, v] of Object.entries(value)) fields[k] = buildSchema(v);
    return { t: 'object', fields };
  }
  return { t };
}

/** 收集所有叶子路径（对象键 + 数组用 [] 表示，与人的直觉一致） */
function flatten(node: ApiSchemaNode | undefined, prefix: string, out: Record<string, SchemaType>) {
  if (!node) return;
  const path = prefix || '$';
  if (node.t === 'object') {
    out[path] = 'object';
    for (const [k, v] of Object.entries(node.fields || {})) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (node.t === 'array') {
    out[path] = 'array';
    flatten(node.item, `${path}[]`, out);
    return;
  }
  out[path] = node.t;
}

/** 比对：多了什么、少了什么、类型变了什么 */
export function diffSchema(oldSchema: ApiSchemaNode, nextSchema: ApiSchemaNode): SchemaDiff {
  const a: Record<string, SchemaType> = {};
  const b: Record<string, SchemaType> = {};
  flatten(oldSchema, '', a);
  flatten(nextSchema, '', b);

  const added = Object.keys(b).filter(k => !(k in a));
  const removed = Object.keys(a).filter(k => !(k in b));
  const changed = Object.keys(b)
    .filter(k => k in a && a[k] !== b[k])
    .map(k => ({ path: k, from: a[k], to: b[k] }));

  return { added, removed, changed, comparable: true };
}

/** 从响应体生成快照需要的结构；不是 JSON 返回 null */
export function schemaFromBody(body: string): ApiSchemaNode | null {
  try {
    return buildSchema(JSON.parse(body));
  } catch {
    return null;
  }
}

/** 差异是否「干净」（只看增删改，不看顺序） */
export function isSameStructure(d: SchemaDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}