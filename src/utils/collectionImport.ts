/**
 * Postman Collection v2.1 / v2.0 解析（Apifox 导出的「Postman 格式」就是 v2.1）。
 *
 * 为什么单独成模块：集合文件的结构嵌套很深（文件夹 → 文件夹 → 请求），
 * 而且「导入错了」的表现很隐蔽 —— 地址对、方法对，但 body 被当成 raw 或
 * 请求头把 Host/Content-Length 也带进去了，发送时直接报错或服务端拒收。
 * 所以这里只做纯解析，页面只负责「预览 → 确认 → 写库」。
 *
 * 约定（与 ApiClient 的请求模型对齐）：
 *   headers  —— 多行 `Key: Value`
 *   body     —— json/raw 是原文；form 是 `k=v` 每行一个；multipart 是 `k=v` / `k=@路径`
 *   variables—— 集合级 + 文件夹级变量合并成 `k=v` 多行，页面可选地存成环境
 */

export type ImportBodyType = 'json' | 'form' | 'multipart' | 'raw' | 'none';

/** 导入时丢弃的头：这些是客户端自动生成的，带过去只会和服务端校验打架 */
const BLOCKED_HEADERS = new Set([
  'content-length',
  'host',
  'connection',
  'accept-encoding',
  'transfer-encoding',
  'upgrade',
]);

export interface ImportedRequest {
  name: string;
  /** 文件夹路径，根目录为空串 */
  group: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  bodyType: ImportBodyType;
  rawContentType: string;
}

export interface PostmanImportOk {
  ok: true;
  collectionName: string;
  requests: ImportedRequest[];
  /** 集合 / 文件夹变量，`k=v` 每行一个 */
  variables: string;
  /** 出现过的分组（按首次出现顺序，不含空串） */
  groups: string[];
  warnings: string[];
}

export interface PostmanImportErr {
  ok: false;
  error: string;
}

export type PostmanImportResult = PostmanImportOk | PostmanImportErr;

type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** 判断这份 JSON 是不是 Postman 集合（Apifox 导出同样满足） */
export function isPostmanCollection(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (!Array.isArray(v.item)) return false;
  if (!isObj(v.info)) return false;
  const schema = String(v.info.schema || '');
  return schema === '' || /postman/i.test(schema) || typeof v.info.name === 'string';
}

/* ---------------- 字段映射 ---------------- */

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Postman 的 url 既可能是字符串，也可能是 {raw, host, path, query} 对象 */
export function urlOf(u: unknown): string {
  if (typeof u === 'string') return u.trim();
  if (!isObj(u)) return '';
  const raw = str(u.raw).trim();
  if (raw) return raw;
  const host = Array.isArray(u.host) ? u.host.map(str).join('.') : str(u.host);
  const pathArr = Array.isArray(u.path) ? u.path.map(str).join('/') : str(u.path);
  const query = Array.isArray(u.query)
    ? u.query.filter((q: unknown) => isObj(q) && !q.disabled && str((q as Json).key))
    : [];
  const qs = query.map((q: any) => `${str(q.key)}=${str(q.value)}`).join('&');
  const proto = str(u.protocol) ? `${str(u.protocol)}://` : (/^\{\{/.test(host) ? '' : 'http://');
  const port = str(u.port) ? `:${str(u.port)}` : '';
  const p = pathArr ? `/${pathArr.replace(/^\//, '')}` : '';
  return `${proto}${host}${port}${p}${qs ? `?${qs}` : ''}`;
}

/** 请求头数组 → 多行文本；顺带返回小写键的 map（判断 Content-Type 用） */
function headersOf(h: unknown): { lines: string[]; map: Map<string, string>; dropped: number } {
  const rows: { key: string; value: string }[] = [];
  if (Array.isArray(h)) {
    for (const row of h) {
      if (!isObj(row) || row.disabled) continue;
      const key = str(row.key).trim();
      if (!key) continue;
      rows.push({ key, value: str(row.value) });
    }
  } else if (typeof h === 'string' && h.trim()) {
    for (const line of h.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      rows.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  const map = new Map<string, string>();
  const lines: string[] = [];
  let dropped = 0;
  for (const r of rows) {
    const lower = r.key.toLowerCase();
    if (BLOCKED_HEADERS.has(lower)) { dropped += 1; continue; }
    if (!map.has(lower)) map.set(lower, r.value);
    lines.push(`${r.key}: ${r.value}`);
  }
  return { lines, map, dropped };
}

/** 最小 base64（避免依赖 Buffer / btoa 的可用性），只处理 UTF-8 */
function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : NaN;
    const c = i + 2 < bytes.length ? bytes[i + 2] : NaN;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4)];
    out += isNaN(b) ? '=' : chars[((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6)];
    out += isNaN(c) ? '=' : chars[c & 63];
  }
  return out;
}

/** 认证配置 → 请求头（Bearer / API Key 走头，Basic 直接编码） */
function authLines(auth: unknown, warnings: string[], where: string): string[] {
  if (!isObj(auth)) return [];
  const type = str(auth.type);
  const params = (name: string): Record<string, string> => {
    const arr = Array.isArray(auth[name]) ? auth[name] : [];
    const out: Record<string, string> = {};
    for (const p of arr) if (isObj(p) && p.key) out[str(p.key)] = str(p.value);
    return out;
  };
  if (type === 'bearer') {
    const p = params('bearer');
    if (p.token) return [`Authorization: Bearer ${p.token}`];
    return [];
  }
  if (type === 'apikey') {
    const p = params('apikey');
    const where2 = (p.in || 'header').toLowerCase();
    if (where2 !== 'header') {
      warnings.push(`${where}：API Key 放在 ${where2}，已跳过（只支持请求头）`);
      return [];
    }
    if (p.key && p.value) return [`${p.key}: ${p.value}`];
    return [];
  }
  if (type === 'basic') {
    const p = params('basic');
    if (p.username || p.password) {
      return [`Authorization: Basic ${base64(`${p.username}:${p.password}`)}`];
    }
    return [];
  }
  if (type) warnings.push(`${where}：认证方式「${type}」不会自动转换，需要手填`);
  return [];
}

/** 请求体 → 我们的 bodyType / body / rawContentType */
function bodyOf(
  body: unknown,
  ct: string,
  warnings: string[],
  where: string,
): { bodyType: ImportBodyType; body: string; rawContentType: string } {
  if (!isObj(body)) return { bodyType: 'none', body: '', rawContentType: '' };
  const mode = str(body.mode);

  if (mode === 'raw') {
    const raw = str(body.raw);
    if (!raw.trim()) return { bodyType: 'none', body: '', rawContentType: '' };
    const lang = str(body.options?.raw?.language).toLowerCase();
    const isJson = lang === 'json' || /json/i.test(ct);
    if (isJson) return { bodyType: 'json', body: raw, rawContentType: 'application/json' };
    const guessed =
      lang === 'xml' ? 'application/xml'
        : lang === 'html' ? 'text/html'
          : lang === 'javascript' ? 'application/javascript'
            : ct || 'text/plain';
    return { bodyType: 'raw', body: raw, rawContentType: guessed };
  }

  if (mode === 'urlencoded') {
    const rows = Array.isArray(body.urlencoded) ? body.urlencoded : [];
    const lines = rows
      .filter((r: unknown) => isObj(r) && !r.disabled && str((r as Json).key))
      .map((r: any) => `${str(r.key)}=${str(r.value)}`);
    if (!lines.length) return { bodyType: 'none', body: '', rawContentType: '' };
    return { bodyType: 'form', body: lines.join('\n'), rawContentType: '' };
  }

  if (mode === 'formdata') {
    const rows = Array.isArray(body.formdata) ? body.formdata : [];
    const lines: string[] = [];
    for (const r of rows) {
      if (!isObj(r) || r.disabled || !str(r.key)) continue;
      const key = str(r.key);
      if (str(r.type) === 'file') {
        const src = Array.isArray(r.src) ? r.src : r.src ? [r.src] : [];
        const p = src.length ? str(src[0]) : '';
        if (!p) {
          warnings.push(`${where}：文件字段「${key}」没有本地路径，导入后需要重新选择文件`);
          lines.push(`${key}=@`);
        } else {
          lines.push(`${key}=@${p}`);
        }
      } else {
        lines.push(`${key}=${str(r.value)}`);
      }
    }
    if (!lines.length) return { bodyType: 'none', body: '', rawContentType: '' };
    return { bodyType: 'multipart', body: lines.join('\n'), rawContentType: '' };
  }

  if (mode === 'graphql') {
    const g = isObj(body.graphql) ? body.graphql : {};
    const query = str(g.query);
    if (!query) return { bodyType: 'none', body: '', rawContentType: '' };
    let variables: unknown = {};
    const rawVars = g.variables;
    if (isObj(rawVars)) variables = rawVars;
    else if (typeof rawVars === 'string' && rawVars.trim()) {
      try { variables = JSON.parse(rawVars); } catch { variables = {}; }
    }
    return {
      bodyType: 'json',
      body: JSON.stringify({ query, variables }),
      rawContentType: 'application/json',
    };
  }

  if (mode === 'file') {
    warnings.push(`${where}：整个请求体是一个文件（mode=file），已跳过请求体`);
    return { bodyType: 'none', body: '', rawContentType: '' };
  }

  if (mode) warnings.push(`${where}：不支持的请求体类型「${mode}」，已跳过请求体`);
  return { bodyType: 'none', body: '', rawContentType: '' };
}

/* ---------------- 主解析 ---------------- */

interface VarRow { key: string; value: string }

function varsOf(v: unknown): VarRow[] {
  if (!Array.isArray(v)) return [];
  const out: VarRow[] = [];
  for (const row of v) {
    if (!isObj(row) || row.disabled) continue;
    const key = str(row.key).trim();
    if (key) out.push({ key, value: str(row.value) });
  }
  return out;
}

/**
 * 解析 Postman v2.1 / v2.0 集合。
 * 传入字符串时自行 JSON.parse（错误信息里带行列，方便定位复制不全）。
 */
export function parsePostmanCollection(input: unknown): PostmanImportResult {
  let root: unknown = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { ok: false, error: '还没有内容：请粘贴集合 JSON，或先选择文件' };
    try {
      root = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `不是合法的 JSON：${(e as Error).message}` };
    }
  }
  if (!isObj(root)) return { ok: false, error: '内容不是一个 JSON 对象' };
  if (!isPostmanCollection(root)) {
    return {
      ok: false,
      error: '这不是 Postman Collection（v2.1/v2.0）。Apifox 请选「导出 → Postman 格式」，' +
        'OpenAPI/Swagger 文件暂不支持。',
    };
  }

  const warnings: string[] = [];
  const collectionName = str(root.info?.name).trim() || '导入的接口集合';
  const requests: ImportedRequest[] = [];
  const groups: string[] = [];

  // 变量：集合级先铺底，文件夹级后覆盖（近的优先）
  const vars = new Map<string, string>();
  for (const v of varsOf(root.variable)) vars.set(v.key, v.value);

  const collectionAuth = root.auth;

  const walk = (items: unknown, folder: string[], inheritedAuth: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isObj(item)) continue;
      const name = str(item.name).trim();
      if (Array.isArray(item.item)) {
        // 文件夹：收集它的变量与 auth，再往下走
        for (const v of varsOf(item.variable)) vars.set(v.key, v.value);
        const groupPath = name ? [...folder, name] : folder;
        if (name && !groups.includes(groupPath.join(' / '))) groups.push(groupPath.join(' / '));
        walk(item.item, groupPath, isObj(item.auth) ? item.auth : inheritedAuth);
        continue;
      }
      if (!item.request && !item.requestUrl) continue;

      const req = typeof item.request === 'string' ? { url: item.request } : item.request;
      if (!isObj(req)) continue;

      const group = folder.join(' / ');
      const where = group ? `${group} / ${name || '(未命名)'}` : (name || '(未命名)');
      const method = (str(req.method) || 'GET').toUpperCase();
      const url = urlOf(req.url ?? item.requestUrl);
      if (!url) {
        warnings.push(`${where}：没有地址，已跳过`);
        continue;
      }

      const { lines, map, dropped } = headersOf(req.header);
      if (dropped) warnings.push(`${where}：已忽略 ${dropped} 个自动生成的头（Host/Content-Length 等）`);

      const ct = map.get('content-type') || '';
      const body = bodyOf(req.body, ct, warnings, where);

      // multipart / form 的 Content-Type 由发送端自己拼（要带 boundary / charset）
      const kept = lines.filter(line => {
        if (body.bodyType !== 'multipart' && body.bodyType !== 'form') return true;
        return line.slice(0, line.indexOf(':')).trim().toLowerCase() !== 'content-type';
      });

      // 认证：请求级 > 文件夹级 > 集合级
      const auth = isObj(req.auth) ? req.auth : inheritedAuth ?? collectionAuth;
      const authHs = authLines(auth, warnings, where);

      requests.push({
        name: name || `${method} ${url.replace(/^https?:\/\/[^/]+/i, '') || '/'}`,
        group,
        method,
        url,
        headers: [...kept, ...authHs].join('\n'),
        body: body.body,
        bodyType: body.bodyType,
        rawContentType: body.rawContentType,
      });
    }
  };

  walk(root.item, [], undefined);

  if (!requests.length) {
    return { ok: false, error: '集合里没有找到任何请求（item 下的 request 都是空的）' };
  }

  const variables = [...vars.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
  return { ok: true, collectionName, requests, variables, groups, warnings };
}

/* ---------------- 与已有请求合并 ---------------- */

export type MergeStrategy = 'skip' | 'overwrite' | 'duplicate';

export interface MergeResult<T> {
  next: T[];
  added: number;
  replaced: number;
  skipped: number;
}

const reqKey = (r: { method: string; url: string }) => `${r.method.toUpperCase()} ${r.url}`;

/**
 * 把导入的请求并进「已保存」列表。
 * 冲突判定用「方法 + 地址」而不是名字：同一个接口改过名字再导入，也应该认得出是同一个。
 */
export function mergeRequests<T extends { id: string; method: string; url: string; name?: string }>(
  existing: T[],
  incoming: T[],
  strategy: MergeStrategy,
): MergeResult<T> {
  const next = [...existing];
  const index = new Map<string, number>();
  next.forEach((r, i) => { if (!index.has(reqKey(r))) index.set(reqKey(r), i); });

  let added = 0;
  let replaced = 0;
  let skipped = 0;

  for (const req of incoming) {
    const key = reqKey(req);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, next.length);
      next.push(req);
      added += 1;
      continue;
    }
    if (strategy === 'skip') {
      skipped += 1;
      continue;
    }
    if (strategy === 'overwrite') {
      // 保留原 id：界面上的勾选 / 打开状态不会因为覆盖而失效
      next[at] = { ...req, id: next[at].id };
      replaced += 1;
      continue;
    }
    // duplicate：换一个名字并追加，避免列表里出现两条一模一样的
    const base = req.name || req.method;
    let name = `${base}（导入）`;
    let n = 2;
    const names = new Set(next.map(r => r.name));
    while (names.has(name)) { name = `${base}（导入 ${n}）`; n += 1; }
    index.set(key, next.length);
    next.push({ ...req, id: (req as { id: string }).id, name });
    added += 1;
  }

  return { next, added, replaced, skipped };
}
