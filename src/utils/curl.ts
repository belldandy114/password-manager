/**
 * cURL 互转：把别人给的 curl 命令解析成请求表单，或把当前请求复制成 curl。
 *
 * 设计约束：
 * - 纯函数、不依赖 electron/node，渲染层与单测都能直接用。
 * - 只做「常见写法」的解析：-X / -H / -d / --data-raw / --data-urlencode / -F / -b / -u / -G / --url。
 *   未知参数一律忽略（够用就行，不要试图复刻 curl 的全部语义）。
 * - `{{变量}}` 按普通文本处理，不做替换 —— 替换发生在发送前（applyVars）。
 */

export type BodyType = 'json' | 'form' | 'multipart' | 'raw' | 'none';

export interface CurlRequest {
  method: string;
  url: string;
  /** 每行一个 `K: V`，与 ApiRequest.headers 同格式 */
  headers: string;
  body: string;
  bodyType: BodyType;
  rawContentType: string;
}

export type ParseResult = { ok: true; request: CurlRequest } | { ok: false; error: string };

/** 去掉换行续行符：bash 的 `\` 与 Windows cmd 的 `^`，以及首尾空白 */
function unwrap(src: string): string {
  let s = String(src || '').replace(/\r\n/g, '\n');
  // Windows cmd 的续行：行尾 ^
  s = s.replace(/\^\n/g, ' ');
  // Chrome「Copy as cURL (cmd)」把每个参数写成 ^"..."^"，^ 在 cmd 里是转义符：
  // 去掉紧挨引号的 ^，否则解析出来每个值首尾都会多一个 ^（用户实测踩过）
  s = s.replace(/\^(["'])/g, '$1');
  // cmd 里 & | < > ( ) 前面都要加 ^ 转义，URL 查询串最常见：pageNo=1^&pageSize=30
  s = s.replace(/\^([&|<>()])/g, '$1');
  // 还有一种是 ^ 直接贴在参数尾部（cmd 里既当转义又当续行，粘贴时常留下），一并去掉
  s = s.replace(/\^(?=\s|$)/g, '');
  // bash 的续行：行尾 \
  s = s.replace(/\\\n/g, ' ');
  return s.replace(/\n/g, ' ').trim();
}

/**
 * 词法切分：把一行命令切成参数。
 *
 * 关键点是「一个参数可以由多段拼接而成」（shell 的真实语义）：
 *   单引号段 / 双引号段（含 \" \\ \n 转义）/ 反斜杠转义的单字符 / 裸字符
 * 所以必须按「读到空白才算一个参数」来扫描，不能每遇到一个引号段就 push。
 * bash 里表示一个单引号的写法是 'it'\''s'，也要能还原成 it's。
 */
export function tokenizeCurl(src: string): string[] {
  const s = unwrap(src);
  const out: string[] = [];
  const n = s.length;
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n';
  let i = 0;

  while (i < n) {
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) break;

    let buf = '';
    while (i < n && !isSpace(s[i])) {
      const c = s[i];

      if (c === "'") {
        i++;
        while (i < n) {
          if (s[i] === "'") {
            // '\'' 这个写法 = 闭合 + \' + 重新开启，中间产出一个 '
            // 所以要把 闭合'/\/重新开启' 这 4 个字符一起吃掉，继续留在「单引号内」状态，
            // 否则后面的空格会被当成参数分隔符（含空格的 body 会被截断）。
            if (s[i + 1] === '\\' && s[i + 2] === "'" && s[i + 3] === "'") {
              buf += "'";
              i += 4;
              continue;
            }
            if (s[i + 1] === '\\' && s[i + 2] === "'") {
              buf += "'";
              i += 3;
              continue;
            }
            i++;
            break;
          }
          buf += s[i++];
        }
        continue;
      }

      if (c === '"') {
        i++;
        while (i < n) {
          const d = s[i];
          if (d === '\\') {
            const nx = s[i + 1];
            if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { buf += nx; i += 2; continue; }
            if (nx === 'n') { buf += '\n'; i += 2; continue; }
            if (nx === 't') { buf += '\t'; i += 2; continue; }
            buf += d;
            i++;
            continue;
          }
          if (d === '"') { i++; break; }
          buf += d;
          i++;
        }
        continue;
      }

      if (c === '\\' && i + 1 < n) {
        buf += s[i + 1];
        i += 2;
        continue;
      }

      buf += c;
      i++;
    }
    out.push(buf);
  }
  return out;
}

const CT_RE = /^content-type\s*:\s*(.*)$/i;

function bodyTypeFromContentType(ct: string): BodyType {
  const v = ct.toLowerCase();
  if (v.includes('application/json') || v.includes('+json')) return 'json';
  if (v.includes('application/x-www-form-urlencoded')) return 'form';
  if (v.includes('multipart/form-data')) return 'multipart';
  return 'raw';
}

/** base64：渲染层没有 Buffer，用 TextEncoder 手工编码（值一般很短） */
function b64(text: string): string {
  try {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  } catch {
    return '';
  }
}

function appendQuery(url: string, query: string): string {
  const q = query.replace(/^\?/, '');
  if (!q) return url;
  if (!url) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const sep = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?';
  return `${base}${sep}${q}${hash}`;
}

/**
 * 解析 curl 命令。
 * 典型输入：`curl -X POST 'https://a/b' -H 'Content-Type: application/json' --data-raw '{"a":1}'`
 */
export function parseCurl(input: string): ParseResult {
  const tokens = tokenizeCurl(input);
  if (!tokens.length) return { ok: false, error: '内容为空，请粘贴一条 curl 命令' };

  let idx = 0;
  const first = (tokens[0] || '').toLowerCase();
  if (first === 'curl' || first === 'curl.exe' || first.endsWith('/curl') || first.endsWith('\\curl')) {
    idx = 1;
  } else if (first.startsWith('curl')) {
    idx = 1;
  } else if (!/^(https?:\/\/|--?[a-z])/i.test(tokens[0])) {
    return { ok: false, error: '看起来不是 curl 命令（应以 curl 开头）' };
  }

  let method = '';
  let url = '';
  const headers: string[] = [];
  const data: string[] = [];
  const urlencode: string[] = [];
  const forms: string[] = [];
  let cookie = '';
  let user = '';
  let asGet = false;

  const next = (): string | undefined => tokens[++idx];

  for (; idx < tokens.length; idx++) {
    const t = tokens[idx];
    switch (t) {
      case '-X':
      case '--request':
        method = (next() || '').toUpperCase();
        break;
      case '-H':
      case '--header': {
        const h = next();
        if (h) headers.push(h.trim());
        break;
      }
      case '--url':
        url = next() || url;
        break;
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-ascii':
      case '--data-binary': {
        const v = next();
        if (v !== undefined) data.push(v);
        break;
      }
      case '--data-urlencode': {
        const v = next();
        if (v !== undefined) urlencode.push(v);
        break;
      }
      case '-F':
      case '--form': {
        const v = next();
        if (v !== undefined) forms.push(v);
        break;
      }
      case '-b':
      case '--cookie': {
        const v = next();
        if (v !== undefined) cookie = v;
        break;
      }
      case '-u':
      case '--user': {
        const v = next();
        if (v !== undefined) user = v;
        break;
      }
      case '-G':
      case '--get':
        asGet = true;
        break;
      default:
        // 常见开关（-k -v -s -L --compressed 等）直接忽略；其它 -x / --xxx 也忽略
        if (!t.startsWith('-') && !url) url = t;
        break;
    }
  }

  if (!url) return { ok: false, error: '没找到 URL（curl 后面应跟地址，或用 --url 指定）' };

  // method：显式 -X 优先；有请求体默认 POST；-G 强制 GET
  if (!method) {
    if (asGet) method = 'GET';
    else if (data.length || urlencode.length || forms.length) method = 'POST';
    else method = 'GET';
  }

  // Cookie / Basic Auth 归入请求头（应用里统一写在 headers 里）
  if (cookie) {
    const has = headers.some((h) => /^cookie\s*:/i.test(h));
    if (!has) headers.push(`Cookie: ${cookie}`);
  }
  if (user) {
    const has = headers.some((h) => /^authorization\s*:/i.test(h));
    if (!has) headers.push(`Authorization: Basic ${b64(user)}`);
  }

  // 请求体
  let body = '';
  let bodyType: BodyType = 'none';
  if (forms.length) {
    body = forms.join('\n');
    bodyType = 'multipart';
  } else if (urlencode.length) {
    body = urlencode.join('&');
    bodyType = 'form';
  } else if (data.length) {
    body = data.join('&');
    bodyType = 'raw';
  }

  // 有 Content-Type 头时用它判断请求体类型，并把它记到 rawContentType
  const ctHeader = headers.map((h) => h.match(CT_RE)).find(Boolean);
  const ct = ctHeader ? ctHeader[1].trim() : '';
  let rawContentType = '';
  if (bodyType !== 'none') {
    if (ct) {
      bodyType = bodyTypeFromContentType(ct);
      if (bodyType === 'raw') rawContentType = ct;
    } else if (bodyType === 'raw' && !forms.length && !urlencode.length) {
      // 没写 Content-Type 的 -d 默认按 form 处理（curl 的默认值就是 application/x-www-form-urlencoded）
      bodyType = 'form';
    }
  }

  if (asGet && bodyType !== 'none') {
    url = appendQuery(url, body);
    body = '';
    bodyType = 'none';
  }

  return {
    ok: true,
    request: {
      method: method || 'GET',
      url,
      headers: headers.join('\n'),
      body,
      bodyType,
      rawContentType,
    },
  };
}

/** 单引号包裹；内部 ' 用 '\'' 拼接（bash / zsh / PowerShell 通用） */
function shq(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成可复制的 curl。`{{变量}}` 原样保留，方便贴给别人再替换。
 * 输出单行：粘到 Git Bash / PowerShell 都能直接跑。
 */
export function buildCurl(req: {
  method?: string;
  url?: string;
  headers?: string;
  body?: string;
  bodyType?: BodyType;
  rawContentType?: string;
}): string {
  const method = String(req.method || 'GET').toUpperCase();
  const url = String(req.url || '').trim();
  const parts: string[] = [];
  parts.push('curl');
  if (method !== 'GET') parts.push('-X', method);
  if (url) parts.push(shq(url));

  const headerLines = String(req.headers || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const bodyType = req.bodyType || 'json';
  const body = String(req.body || '');
  const hasBody = bodyType !== 'none' && body !== '' && method !== 'GET' && method !== 'HEAD';

  // 请求体类型对应但用户没写 Content-Type 时，补一个（否则服务端会按 form 解析 JSON）
  if (hasBody) {
    const hasCt = headerLines.some((l) => /^content-type\s*:/i.test(l));
    if (!hasCt) {
      if (bodyType === 'json') headerLines.push('Content-Type: application/json');
      else if (bodyType === 'form') headerLines.push('Content-Type: application/x-www-form-urlencoded');
      else if (bodyType === 'multipart') headerLines.push('Content-Type: multipart/form-data');
      else if (bodyType === 'raw' && req.rawContentType) headerLines.push(`Content-Type: ${req.rawContentType}`);
    }
  }

  for (const h of headerLines) parts.push('-H', shq(h));
  if (hasBody) parts.push('--data-raw', shq(body));

  return parts.join(' ');
}
