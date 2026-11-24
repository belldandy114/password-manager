/**
 * 接口覆盖矩阵的纯函数层（契约 §1.4 / [C-30]–[C-33]；模块 4.1）。
 *
 * 这一层的**全部价值在把路径归一化做对**。真实代码里同一个接口有五种写法：
 *
 *   get("/api/user/{id}")          OpenAPI 风格占位
 *   .get("/api/user/:id")          Express 风格
 *   "/api/user/{{id}}"             本项目环境变量风格
 *   "/api/user/1"                  写死的具体值
 *   "https://host/v1/api/user/1?x" 完整 URL + 查询串 + baseURL 前缀
 *
 * 不归一就永远比不上 —— 覆盖率会**假低**，用户看到"未覆盖"去补，补了还是不匹配，
 * 于是这条能力就废了。所以归一规则写死在这一个文件里，并有单测逐条锁。
 *
 * **三态而不是两态**（[C-32]）：
 * - `covered`：代码里找到真实调用（带 `file:line`）
 * - `missing`：确认没有
 * - `unknown`：有引用但静态判不准（变量拼装 / 方法对不上 / 只在注释里）
 *   —— **必须给原因**。否则用户看到一个空格子，不知道该不该去补，也无从判断是不是工具漏了。
 *
 * 纯函数：不读文件、不碰 IPC、不含时间戳。扫描取数在 `electron/scan-rules.js`（t32），
 * 那里只抽「路径原文 + method 原文」，**归一化一律在这里做**（契约明文：路径归一在渲染层）。
 */

/* ================================================================
   三态与 unknown 的可枚举原因
   ================================================================ */

export type CoverageState = 'covered' | 'missing' | 'unknown';

/**
 * `unknown` 的原因码 → 用户可读文案（[C-32] 要求 `unknown` 必须带 reason）。
 * 用「码 + 文案」两层：码给测试断言与将来统计，文案直接上界面，避免页面各写一版。
 */
export const UNKNOWN_REASON_TEXT = {
  /** 路径里有变量/表达式拼接，静态拿不到确定值 */
  'dynamic-concat': '路径由变量拼装，静态无法判定',
  /** 只找到形似路径的字符串，但调用形态认不出来（不是 .get / requests.* / 注解） */
  'unrecognized-call': '未识别的调用形态，无法确认它就是这个接口',
  /** 只在注释里出现 —— 注释里的 URL 不能算"这个接口被测了" */
  'comment-only': '仅在注释中出现，不算真实调用',
  /** 路径命中，但代码里的 HTTP 方法与接口定义不一致 */
  'method-mismatch': '路径命中但 HTTP 方法不一致',
  /** 接口自己的路径就是空的 / 不是以 / 开头 */
  'invalid-path': '接口路径为空或格式无法识别',
} as const;

export type UnknownReasonCode = keyof typeof UNKNOWN_REASON_TEXT;

/** 原因码列表（给 UI 做筛选/图例用，也方便测试枚举完整性） */
export const UNKNOWN_REASON_CODES = Object.keys(UNKNOWN_REASON_TEXT) as UnknownReasonCode[];

/* ================================================================
   路径归一化
   ================================================================ */

/** 静态资源扩展名：这些不是"接口"，命中它们不代表覆盖 */
const STATIC_ASSET_EXT = /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|html?|txt|xml|pdf|zip)$/i;

/** 静态资源常见的目录前缀 */
const STATIC_ASSET_DIR = /^\/(?:static|assets?|public|dist|build|images?|img|fonts?|media|cdn|favicon\.ico)\b/i;

/** 这一条路径看起来是不是静态资源（不是接口） */
export function isStaticAsset(pathLike: string): boolean {
  const p = String(pathLike ?? '').split(/[?#]/)[0];
  if (!p) return false;
  return STATIC_ASSET_EXT.test(p) || STATIC_ASSET_DIR.test(p);
}

/** 动态拼接的信号：模板串插值、字符串加号拼接、占位符带对象属性 */
const DYNAMIC_SIGNAL = /\$\{|#\{|\+\s*[A-Za-z_$]|\{[A-Za-z_$][\w$]*\.[\w$.]+\}|%[sdv]\s*\)|String\.format|\.format\(/;

/** UUID / 长 hex：当作"具体值"，归一成占位符 */
const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_SEG = /^[0-9a-f]{16,}$/i;
const NUMERIC_SEG = /^\d+(?:\.\d+)?$/;

export interface NormalizedPath {
  /**
   * 归一后的路径（小写、无查询串、无尾斜杠、占位统一成 `{id}`）。
   * `ok:false` 时这里是**尽力得到的静态前缀**（可能为空串），用于按前缀归因。
   */
  path: string;
  /** 是否拿到了可用于精确比对的路径 */
  ok: boolean;
  /** `ok:false` 时的原因码 */
  reasonCode?: UnknownReasonCode;
  /** 原始输入（便于界面显示、也便于排查） */
  raw: string;
}

export interface NormalizeOptions {
  /** 接口集合的 baseURL；给定时会从绝对 URL 里剥掉它（这是「前缀不一致」的主要来源） */
  baseUrl?: string;
}

/**
 * 归一化一条路径。规则（顺序不能换，单测逐条锁）：
 * 1. 先判动态拼接（`${}`/`+变量`/`{obj.prop}`）—— 这类**不能**再往下猜，只留静态前缀；
 * 2. 剥查询串与 hash；
 * 3. 绝对 URL → 有 baseUrl 就剥 baseUrl，否则剥 scheme+host 只留 path；
 * 4. 占位符统一：`{{id}}` / `{id}` / `:id` / `%s` / `%d` → `{id}`；
 * 5. 具体值收敛：数字段 / UUID / 长 hex → `{id}`（代码里写死 id 是常态，不收敛会假低）；
 * 6. 小写、折叠重复斜杠、去尾斜杠（根路径 `/` 保留）。
 */
export function normalizePath(raw: string, opts: NormalizeOptions = {}): NormalizedPath {
  const text = String(raw ?? '').trim();
  if (!text) return { path: '', ok: false, reasonCode: 'invalid-path', raw };

  // 1) 动态拼接：先截出静态前缀，再按原因码返回
  if (DYNAMIC_SIGNAL.test(text)) {
    const prefixRaw = text.split(/\$\{|#\{|\+\s*[A-Za-z_$]|\{[A-Za-z_$][\w$]*\./)[0];
    const prefix = normalizePathStatic(prefixRaw, opts);
    return {
      path: prefix.path,
      ok: false,
      reasonCode: 'dynamic-concat',
      raw,
    };
  }

  const result = normalizePathStatic(text, opts);
  return { ...result, raw };
}

/** 只看静态部分时的归一（不含动态拼接判定，避免递归） */
function normalizePathStatic(text: string, opts: NormalizeOptions): { path: string; ok: boolean } {
  let s = text;

  // 2) 查询串 / hash
  s = s.split('#')[0].split('?')[0].trim();

  // 3) 绝对 URL：优先剥 baseUrl，避免 https://host/v1 与 /v1 两种写法对不上
  const abs = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (abs) {
    const base = String(opts.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (base && s.toLowerCase().startsWith(base.toLowerCase())) {
      s = s.slice(base.length);
    } else {
      // 没 baseUrl（或对不上）：只留 path 部分，域名不参与比对
      s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    }
  } else {
    const base = String(opts.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (base) {
      // baseUrl 可能只给了 path 部分（`/v1`），同样剥
      const basePath = base.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
      if (basePath && basePath !== '/' && s.toLowerCase().startsWith(basePath.toLowerCase())) {
        s = s.slice(basePath.length);
      }
    }
  }

  // 4) 占位符统一
  s = s
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, '{id}')   // {{id}}（本项目环境变量风格）
    .replace(/\{([^{}]+)\}/g, '{id}')               // {id}（OpenAPI / Spring）
    .replace(/%[sdv]/g, '{id}');                    // String.format 占位

  // 5) 段级处理：`:id` / 数字 / UUID / 长 hex → {id}
  const segs = s.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^:[A-Za-z_$][\w$]*$/.test(seg)) return '{id}';
    if (NUMERIC_SEG.test(seg) || UUID_SEG.test(seg) || LONG_HEX_SEG.test(seg)) return '{id}';
    return seg;
  });
  s = segs.join('/');

  // 6) 小写 / 折叠斜杠 / 去尾斜杠
  s = s.toLowerCase().replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (!s.startsWith('/')) {
    // 相对路径（`api/user`）也算可用，补一个前导斜杠再比对
    if (s) s = `/${s}`;
  }

  return { path: s, ok: !!s };
}

/**
 * method 归一：大写；未知/缺失 → `ANY`。
 *
 * `ANY` 是「代码里拿不到方法」的标记（`.url("/x")`、纯路径字面量、`@RequestMapping`），
 * 匹配时 `ANY` 与任何方法都算命中 —— 但反过来（接口是 ANY、代码是 GET）也算命中。
 */
export function normalizeMethod(method: string | undefined | null): string {
  const m = String(method ?? '').trim().toUpperCase();
  if (!m || m === 'ANY' || m === '*') return 'ANY';
  return m;
}

/* ================================================================
   覆盖矩阵
   ================================================================ */

/** 接口集合里参与矩阵的一项（页面从 `apiRequests` 集合映射过来） */
export interface CoverageEndpoint {
  method?: string;
  url: string;
  /** 接口名（界面显示用） */
  name?: string;
  /** 分组（界面显示/筛选用） */
  group?: string;
  /** 接口 id（保存运行记录时回溯用） */
  id?: string;
}

/** `scan:run`（pack='coverage'）返回的一条 finding，映射成本类型 */
export interface CoverageRef {
  method?: string;
  path?: string;
  file?: string;
  line?: number;
  /** 命中行原文；用来识别「只在注释里出现」 */
  snippet?: string;
  ruleId?: string;
}

export interface CoverageItem {
  id?: string;
  name?: string;
  group?: string;
  method: string;
  /** 归一后的路径（契约 CoverageItem.path） */
  path: string;
  state: CoverageState;
  /** `covered` 时必填：`文件:行号` */
  ref?: string;
  /** `unknown` 时必填：用户可读原因 */
  reason?: string;
  /** `unknown` 时必填：原因码 */
  reasonCode?: UnknownReasonCode;
}

export interface CoverageSummary {
  /** 参与矩阵的接口数（静态资源接口已排除，见 `skippedStatic`） */
  total: number;
  covered: number;
  missing: number;
  /** 无法判定（契约字段名叫 undetermined） */
  undetermined: number;
}

export interface CoverageResult {
  items: CoverageItem[];
  summary: CoverageSummary;
  /** 被排除的静态资源接口数（不参与三态合计） */
  skippedStatic: number;
  /** 解释性告警：前缀对不上、注释里的命中被忽略、静态资源引用被忽略等 */
  warnings: string[];
  /** 三态合计是否等于 total（[C-31] 恒等式；调用方保存前必须校验） */
  consistent: boolean;
}

/** 一段命中原文看起来是不是注释行 */
function isCommentSnippet(snippet: string | undefined): boolean {
  const s = String(snippet ?? '').trimStart();
  if (!s) return false;
  return s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s.startsWith('#') || s.startsWith('<!--');
}

/**
 * 生成覆盖矩阵。
 *
 * @param input.endpoints 接口集合（来自 `apiRequests`）
 * @param input.refs      `scan:run` 的 findings（只关心带 path 的）
 * @param input.baseUrl   可选：接口集合的 baseURL，用于剥前缀
 */
export function buildCoverage(input: {
  endpoints: CoverageEndpoint[];
  refs: CoverageRef[];
  baseUrl?: string;
}): CoverageResult {
  const endpoints = Array.isArray(input.endpoints) ? input.endpoints : [];
  const refs = Array.isArray(input.refs) ? input.refs : [];
  const opts: NormalizeOptions = { baseUrl: input.baseUrl };

  const warnings: string[] = [];

  /* ---- 引用侧：先归一，分成「可用」「动态」「静态资源」「无路径」几堆 ---- */
  const usable: Array<{ path: string; method: string; ref: string; comment: boolean }> = [];
  const dynamicRefs: Array<{ prefix: string; file: string; line: number }> = [];
  let staticRefs = 0;
  let commentOnly = 0;

  for (const r of refs) {
    const rawPath = String(r.path ?? '').trim();
    if (!rawPath) continue;
    const file = String(r.file ?? '');
    const line = Number(r.line) || 0;
    const where = file ? `${file}:${line}` : '';
    const norm = normalizePath(rawPath, opts);

    if (isStaticAsset(norm.path || rawPath)) {
      staticRefs += 1;
      continue;
    }
    if (!norm.ok) {
      dynamicRefs.push({ prefix: norm.path, file, line });
      continue;
    }
    if (isCommentSnippet(r.snippet)) {
      commentOnly += 1;
      // 注释里的命中不参与「已覆盖」，但要留着给 unknown 归因
      usable.push({ path: norm.path, method: normalizeMethod(r.method), ref: where, comment: true });
      continue;
    }
    usable.push({ path: norm.path, method: normalizeMethod(r.method), ref: where, comment: false });
  }

  /* ---- 接口侧 ---- */
  const items: CoverageItem[] = [];
  let skippedStatic = 0;
  let prefixMismatch = 0;
  const matchedRefPaths = new Set<string>();

  // 所有接口的归一化路径（前缀归因时要排除「前缀本身就是另一个接口」）
  const endpointPaths = new Set<string>();
  for (const epx of endpoints) {
    const n = normalizePath(String(epx.url ?? ''), opts);
    if (n.ok) endpointPaths.add(n.path);
  }

  const index = new Map<string, Array<{ path: string; method: string; ref: string; comment: boolean }>>();
  for (const u of usable) {
    const list = index.get(u.path) || [];
    list.push(u);
    index.set(u.path, list);
  }

  for (const ep of endpoints) {
    const method = normalizeMethod(ep.method);
    const norm = normalizePath(String(ep.url ?? ''), opts);
    const base: Omit<CoverageItem, 'state'> = {
      ...(ep.id ? { id: ep.id } : {}),
      ...(ep.name ? { name: ep.name } : {}),
      ...(ep.group ? { group: ep.group } : {}),
      method,
      path: norm.path,
    };

    if (isStaticAsset(norm.path || String(ep.url ?? ''))) {
      skippedStatic += 1;
      continue;
    }

    if (!norm.ok) {
      items.push({
        ...base,
        state: 'unknown',
        reasonCode: norm.reasonCode || 'invalid-path',
        reason: UNKNOWN_REASON_TEXT[norm.reasonCode || 'invalid-path'],
      });
      continue;
    }

    const hits = index.get(norm.path) || [];
    if (hits.length) matchedRefPaths.add(norm.path);

    // 1) 真实调用 + 方法匹配（或任一方是 ANY）→ covered
    const real = hits.filter((h) => !h.comment);
    const exact = real.find((h) => h.method === method || h.method === 'ANY' || method === 'ANY');
    if (exact) {
      items.push({ ...base, state: 'covered', ...(exact.ref ? { ref: exact.ref } : {}) });
      continue;
    }

    // 2) 路径命中但方法对不上 → unknown（不能算 covered，也不能算 missing）
    if (real.length) {
      const other = real[0].method;
      items.push({
        ...base,
        state: 'unknown',
        reasonCode: 'method-mismatch',
        reason: `${UNKNOWN_REASON_TEXT['method-mismatch']}（代码里是 ${other}，接口是 ${method}）`,
      });
      continue;
    }

    // 3) 只在注释里出现 → unknown（注释里的 URL 不能算"这个接口被测了"）
    if (hits.length) {
      items.push({
        ...base,
        state: 'unknown',
        reasonCode: 'comment-only',
        reason: UNKNOWN_REASON_TEXT['comment-only'],
      });
      continue;
    }

    // 4) 动态拼接的引用：静态前缀能对上就算 unknown（而不是 missing）
    const dyn = dynamicRefs.find((d) => d.prefix && d.prefix.length >= 4 && norm.path.startsWith(d.prefix));
    if (dyn) {
      items.push({
        ...base,
        state: 'unknown',
        reasonCode: 'dynamic-concat',
        reason: UNKNOWN_REASON_TEXT['dynamic-concat'],
      });
      continue;
    }

    // 4b) 另一种动态拼接：扫描器只抽到了字符串字面量（`"/api/order/" + id` 里的前半段），
    //     于是引用路径是接口路径的**严格前缀**，且断点正好在一个占位符之前。
    //     为什么只认「断在占位符前」：`/api/user` 是 `/api/user/{id}` 的合法前缀，
    //     那种情况是"另一个接口"，不能当成动态拼接。
    const prefixHit = usable.find((u) => {
      if (u.comment) return false;
      if (norm.path === u.path) return false;
      // 前缀自己就是一个接口 → 这条引用属于它，不能算「被截断的拼接」
      if (endpointPaths.has(u.path)) return false;
      if (!norm.path.startsWith(`${u.path}/`)) return false;
      const rest = norm.path.slice(u.path.length + 1);
      return rest.startsWith('{id}');
    });
    if (prefixHit) {
      items.push({
        ...base,
        state: 'unknown',
        reasonCode: 'dynamic-concat',
        reason: `${UNKNOWN_REASON_TEXT['dynamic-concat']}（代码里只看到静态前缀 ${prefixHit.path}）`,
      });
      continue;
    }

    // 5) 确实没有 → missing
    items.push({ ...base, state: 'missing' });
  }

  const summary: CoverageSummary = {
    total: items.length,
    covered: items.filter((i) => i.state === 'covered').length,
    missing: items.filter((i) => i.state === 'missing').length,
    undetermined: items.filter((i) => i.state === 'unknown').length,
  };
  const consistent = summary.covered + summary.missing + summary.undetermined === summary.total;

  /* ---- 解释性告警（都有用：说明"为什么覆盖率看起来低/高"） ---- */
  if (skippedStatic) {
    warnings.push(`接口集合里有 ${skippedStatic} 条静态资源（js/css/图片等），已排除在矩阵外`);
  }
  if (staticRefs) {
    warnings.push(`代码里有 ${staticRefs} 处静态资源引用，已忽略（不是接口调用）`);
  }
  if (commentOnly) {
    warnings.push(`代码里有 ${commentOnly} 处命中只在注释里，已按下「无法判定」处理`);
  }
  for (const u of usable) {
    if (u.comment) continue;
    if (!matchedRefPaths.has(u.path)) {
      // 代码里有路径但接口集合里没有：可能是没导入接口、也可能是前缀不同
      prefixMismatch += 1;
    }
  }
  if (prefixMismatch) {
    warnings.push(`有 ${prefixMismatch} 处代码引用没对上任一接口（常见原因：接口集合没导入全，或代码里带了不同的 baseURL 前缀）`);
  }
  if (!consistent) {
    warnings.push(`统计自洽性校验失败：covered+missing+undetermined ≠ total（${summary.covered}+${summary.missing}+${summary.undetermined} ≠ ${summary.total}）`);
  }

  return { items, summary, skippedStatic, warnings, consistent };
}

/**
 * [C-31] 的恒等式校验：`covered + missing + undetermined === total`。
 * 返回错误文案（null = 通过）。页面在保存 `coverageRuns` 之前必须调它。
 */
export function assertCoverageConsistency(summary: CoverageSummary): string | null {
  const sum = (Number(summary.covered) || 0) + (Number(summary.missing) || 0) + (Number(summary.undetermined) || 0);
  const total = Number(summary.total) || 0;
  if (sum !== total) return `覆盖统计自洽性校验失败：covered+missing+undetermined ≠ total`;
  return null;
}

/** 覆盖率百分比（**只用于排序/进度条**；界面必须同时给分子分母，[C-32] 禁止只给百分比） */
export function coveragePercent(summary: CoverageSummary): number {
  if (!summary.total) return 0;
  return Math.round((summary.covered / summary.total) * 100);
}

/**
 * [C-33] 单条 `items ≤ 5000`：截断时**优先保留 covered 与 unknown**，missing 溢出先丢。
 * 返回 `{ items, truncated }`；调用方必须把 `truncated` 显示出来（「只展示了前 N 条未覆盖项」）。
 */
export function trimCoverageItems(items: CoverageItem[], max = 5000): { items: CoverageItem[]; truncated: boolean } {
  if (!Array.isArray(items) || items.length <= max) {
    return { items: Array.isArray(items) ? items : [], truncated: false };
  }
  const keepFirst = items.filter((i) => i.state !== 'missing');
  const missing = items.filter((i) => i.state === 'missing');
  const room = Math.max(0, max - keepFirst.length);
  return { items: [...keepFirst, ...missing.slice(0, room)], truncated: true };
}