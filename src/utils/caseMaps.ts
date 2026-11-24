/**
 * 用例 ↔ 脚本映射的纯函数层（契约 §1.5 / [C-34]–[C-36]；模块 4.2）。
 *
 * 两件事：
 * 1. **CSV 解析**：渲染层不能 `import electron/csv.js`（那是 CommonJS 主进程模块，且带着
 *    一堆密码库字段别名）。所以这里实现一套**行为一致的最小解析器**，再用一条「对照测试」
 *    把两边结果逐字比一遍 —— 两套解析最容易悄悄分叉，唯一的办法就是让测试天天对着比。
 * 2. **CSV → 映射条目**：以 `caseNo` 为幂等键（[C-35]），重复的**合并/覆盖而不是新增**，
 *    并且必须回报 `{ added, updated, skipped, invalid }` 四个数（四者之和 == 数据行数）。
 *
 * 明确不支持 xmind / Excel 内容解析（[C-36]）—— 与 `Cases.tsx`「文件管家不解析」同一决策：
 * 一旦开始解析 xmind 版本差异与 Excel 合并单元格，就是个无底洞。固定文案见
 * `CASE_MAP_UNSUPPORTED_MSG`。
 *
 * 纯函数：不读文件、不碰 IPC、不吃系统时间（`now` 由调用方给，缺省才用当前时间）。
 */

/* ================================================================
   契约常量
   ================================================================ */

/** [C-34] 单集合上限（与 `collectionTrim.ts` 的 COLLECTION_CAPS.caseMaps 一致） */
export const CASE_MAP_LIMITS = {
  maxItems: 20000,
  caseNo: 64,
  caseTitle: 200,
  targetRef: 300,
  note: 200,
  /** CSV 里报错最多列多少条（避免 1 万行全错时把界面刷爆） */
  maxErrors: 20,
} as const;

/** [C-36] 固定文案：选到 xmind / Excel 时**只**说这一句，不做任何尝试性解析 */
export const CASE_MAP_UNSUPPORTED_MSG = '只支持规范化 CSV 导入，不支持 xmind/Excel 解析';

/* ================================================================
   CSV 解析（与 electron/csv.js 的 parseCsv 行为一致）
   ================================================================ */

/**
 * RFC 4180 的最小实现：引号内的逗号与换行、`""` 转义、`\r\n`、BOM、尾部空行过滤。
 *
 * **刻意与主进程那份保持同样的取舍**：
 * - 只有「整行全空白」才被丢掉（含一个空字段的行保留，否则用户看到的行数会和 Excel 对不上）；
 * - 引号状态跨行持续（多行字段能解析）；
 * - 末尾没有换行时也要收最后一格。
 */
export function parseCsvLite(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = String(text ?? '').replace(/^\uFEFF/, '');

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* ================================================================
   类型与校验
   ================================================================ */

export type CaseMapSource = 'manual' | 'csv';
export type CaseMapTargetKind = 'file' | 'method';

export interface CaseMapTarget {
  kind: CaseMapTargetKind;
  /** `kind='file'` 是相对路径；`kind='method'` 是 `文件#方法` */
  ref: string;
}

export interface CaseMapEntry {
  id: string;
  caseNo: string;
  caseTitle?: string;
  target: CaseMapTarget;
  source: CaseMapSource;
  note?: string;
  updatedAt: string;
}

/** 导入结果里的四个计数（[C-35]：`added+updated+skipped+invalid === 行数`） */
export interface ImportReport {
  added: number;
  updated: number;
  skipped: number;
  invalid: number;
  /**
   * 命中**已有集合**（本次导入之前就存在）里的条目、因而被覆盖的行数——给用户看「其中合并 N 条」用。
   * 不含「本次导入自己新增」的条目（RC-07）：同一份 CSV 连导两次时，第二次全部命中已有集合，
   * 所以 `added 0 / merged == 行数`；而首次导入即使文件内有重复 caseNo，`merged` 仍是 0。
   */
  merged: number;
  /** 数据行数（不含表头） */
  rows: number;
  errors: string[];
}

export interface ImportResult {
  /** 合并后的完整集合（**新数组**，入参不被修改） */
  items: CaseMapEntry[];
  report: ImportReport;
}

/** 文件名是不是能导入的 CSV（[C-36]：只接 .csv） */
export function isCaseMapCsvFile(fileName: string): boolean {
  return /\.csv$/i.test(String(fileName ?? '').trim());
}

/** 把任意文件名转成「给用户看的提示」：非 CSV 一律那句固定文案 */
export function unsupportedFileMessage(fileName: string): string {
  if (isCaseMapCsvFile(fileName)) return '';
  return CASE_MAP_UNSUPPORTED_MSG;
}

/* ---------------- 表头别名（中英文都要认） ---------------- */

const HEADER_ALIASES: Record<'caseNo' | 'caseTitle' | 'target' | 'kind' | 'note', string[]> = {
  caseNo: ['caseno', 'case_no', 'caseid', 'case_id', '用例编号', '编号', '用例id', '用例编号/编号'],
  caseTitle: ['casetitle', 'case_title', 'casesummary', '用例标题', '用例名称', '标题', '名称', 'title'],
  target: ['target', '脚本', '脚本路径', '目标', '目标脚本', '归属', '映射目标'],
  kind: ['kind', '类型', '目标类型', 'targetkind'],
  note: ['note', '备注', '说明', 'remark', 'comment'],
};

export interface CaseMapHeader {
  /** 各列的列号；-1 表示这一列不存在 */
  caseNo: number;
  caseTitle: number;
  target: number;
  kind: number;
  note: number;
  /** 缺失的必需列名（目前只有 caseNo / target 是必需的） */
  missing: string[];
}

/** 识别表头：大小写/空白/全半角都不敏感 */
export function readHeader(headerCells: string[]): CaseMapHeader {
  const norm = (s: string) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-/]/g, '');
  const cells = (headerCells || []).map(norm);
  const find = (key: keyof typeof HEADER_ALIASES): number => {
    for (const alias of HEADER_ALIASES[key]) {
      const i = cells.indexOf(norm(alias));
      if (i >= 0) return i;
    }
    return -1;
  };
  const h: CaseMapHeader = {
    caseNo: find('caseNo'),
    caseTitle: find('caseTitle'),
    target: find('target'),
    kind: find('kind'),
    note: find('note'),
    missing: [],
  };
  if (h.caseNo < 0) h.missing.push('caseNo（用例编号）');
  if (h.target < 0) h.missing.push('target（脚本）');
  return h;
}

/** `文件#方法` → kind=method；其余 → kind=file（[C-35] 的 target 口径） */
export function parseTargetRef(raw: string, declaredKind?: string): CaseMapTarget | null {
  const ref = String(raw ?? '').trim();
  if (!ref) return null;
  if (ref.length > CASE_MAP_LIMITS.targetRef) return null;
  const kindHint = String(declaredKind ?? '').trim().toLowerCase();
  const hasHash = ref.includes('#');
  // 显式声明优先；没声明就按 # 推断。声明成 method 却没有 # 视为无效（不然生成器会拿到半个引用）
  if (kindHint === 'method') return hasHash ? { kind: 'method', ref } : null;
  if (kindHint === 'file') return hasHash ? null : { kind: 'file', ref };
  return hasHash ? { kind: 'method', ref } : { kind: 'file', ref };
}

/* ================================================================
   CSV → 映射条目（幂等键 = caseNo）
   ================================================================ */

export interface ImportOptions {
  /** 固定时间（测试用，保证可复现） */
  now?: string;
  /** id 生成器（测试用） */
  makeId?: (index: number) => string;
}

/** 集合里已有的 caseNo（按 updatedAt 取最新一条，其余视为历史脏数据） */
export function dedupeByCaseNo(items: CaseMapEntry[]): CaseMapEntry[] {
  const byNo = new Map<string, CaseMapEntry>();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.caseNo !== 'string') continue;
    const key = it.caseNo.trim();
    if (!key) continue;
    const prev = byNo.get(key);
    if (!prev || String(it.updatedAt || '') >= String(prev.updatedAt || '')) byNo.set(key, it);
  }
  return [...byNo.values()];
}

/**
 * 把 CSV 文本合并进现有集合。
 *
 * 语义（[C-35]）：
 * - 以 `caseNo` 为幂等键：已存在 → **覆盖 target/source/note 并更新 updatedAt**，不新增；
 * - **同一个 CSV 内部**重复的 caseNo 也合并（后者补足前者为空的字段），但**不计入 `merged`**；
 * - `merged` 只统计「命中了本次导入之前就存在的条目」的行（RC-07），因此 `merged ≤ updated`；
 * - 行号为空的、注释行（首列以 `#` 开头）→ `skipped`；
 * - 缺 caseNo / 缺 target / 超长 → `invalid` 并记 errors。
 */
export function importCaseMapsCsv(text: string, existing: CaseMapEntry[], opts: ImportOptions = {}): ImportResult {
  const rows = parseCsvLite(text);
  const report: ImportReport = { added: 0, updated: 0, skipped: 0, invalid: 0, merged: 0, rows: 0, errors: [] };
  const base = dedupeByCaseNo(existing).map((it) => ({ ...it, target: { ...it.target } }));
  if (!rows.length) {
    report.errors.push('CSV 里没有任何行（连表头都没有）');
    return { items: base, report };
  }

  const header = readHeader(rows[0]);
  if (header.missing.length) {
    report.errors.push(`表头缺少必需列：${header.missing.join(' / ')}（支持中英文列名，如「用例编号」「脚本」）`);
    return { items: base, report };
  }

  const dataRows = rows.slice(1);
  report.rows = dataRows.length;
  const now = opts.now || new Date().toISOString();
  const makeId = opts.makeId || ((i: number) => `cm-${Date.now()}-${i}`);
  const byNo = new Map(base.map((it) => [it.caseNo.trim(), it] as [string, CaseMapEntry]));
  // RC-07：`merged` 只统计「命中了**已有集合**里的条目」。byNo 会随本文件的行不断长大，
  // 所以必须先拍一张快照——否则同文件内后出现的 caseNo 会把自己文件里刚新增的那条算成「合并」，
  // 表现为同一份 CSV 连导两次时「其中合并 N 条」虚高。
  const existingNos = new Set(byNo.keys());

  dataRows.forEach((cells, index) => {
    const cell = (i: number): string => (i >= 0 && i < cells.length ? String(cells[i] ?? '').trim() : '');
    const rowNo = index + 2; // 表里看到的行号（含表头）

    // 注释行（CSV 里用 # 开头写说明是常见约定）→ skipped，不算错
    if (cell(0).startsWith('#')) {
      report.skipped += 1;
      return;
    }

    const caseNo = cell(header.caseNo);
    const rawTarget = cell(header.target);
    const caseTitle = cell(header.caseTitle);
    const note = cell(header.note);

    if (!caseNo) {
      report.invalid += 1;
      if (report.errors.length < CASE_MAP_LIMITS.maxErrors) report.errors.push(`第 ${rowNo} 行：用例编号为空`);
      return;
    }
    if (caseNo.length > CASE_MAP_LIMITS.caseNo) {
      report.invalid += 1;
      if (report.errors.length < CASE_MAP_LIMITS.maxErrors) {
        report.errors.push(`第 ${rowNo} 行：用例编号超过 ${CASE_MAP_LIMITS.caseNo} 字符`);
      }
      return;
    }
    const target = parseTargetRef(rawTarget, header.kind >= 0 ? cell(header.kind) : '');
    if (!target) {
      report.invalid += 1;
      if (report.errors.length < CASE_MAP_LIMITS.maxErrors) {
        report.errors.push(`第 ${rowNo} 行：脚本为空、超长或与类型不符（method 需要「文件#方法」）`);
      }
      return;
    }
    if (caseTitle.length > CASE_MAP_LIMITS.caseTitle || note.length > CASE_MAP_LIMITS.note) {
      report.invalid += 1;
      if (report.errors.length < CASE_MAP_LIMITS.maxErrors) {
        report.errors.push(`第 ${rowNo} 行：标题最多 ${CASE_MAP_LIMITS.caseTitle} 字符、备注最多 ${CASE_MAP_LIMITS.note} 字符`);
      }
      return;
    }
    if (existingNos.has(caseNo)) report.merged += 1;

    const prev = byNo.get(caseNo);
    const entry: CaseMapEntry = {
      id: prev ? prev.id : makeId(index),
      caseNo,
      ...(caseTitle ? { caseTitle } : {}),
      target,
      source: 'csv',
      ...(note ? { note } : {}),
      updatedAt: now,
    };
    byNo.set(caseNo, entry);
    if (prev) report.updated += 1;
    else report.added += 1;
  });

  return { items: [...byNo.values()], report };
}

/* ================================================================
   手工维护（增/改）的校验
   ================================================================ */

export interface ManualDraft {
  id?: string;
  caseNo: string;
  caseTitle?: string;
  /** 界面上的单个输入框：`文件` 或 `文件#方法` */
  targetRef: string;
  kind?: CaseMapTargetKind;
  note?: string;
}

export interface ManualResult {
  entry?: CaseMapEntry;
  error?: string;
}

/**
 * 手工新增/编辑一条映射。校验口径与 CSV 导入一致，**重名直接报错而不是覆盖**
 * （手工编辑时静默覆盖最容易让人以为"我明明新建了一条"）。
 */
export function buildManualEntry(
  draft: ManualDraft,
  existing: CaseMapEntry[],
  opts: ImportOptions = {},
): ManualResult {
  const caseNo = String(draft.caseNo ?? '').trim();
  if (!caseNo) return { error: '用例编号不能为空' };
  if (caseNo.length > CASE_MAP_LIMITS.caseNo) return { error: `用例编号最多 ${CASE_MAP_LIMITS.caseNo} 个字符` };

  const dup = dedupeByCaseNo(existing).find((it) => it.caseNo.trim() === caseNo && it.id !== draft.id);
  if (dup) return { error: `用例编号已存在：${caseNo}` };

  const target = parseTargetRef(draft.targetRef, draft.kind);
  if (!target) return { error: '脚本不能为空、不能超过 300 字符；类型为 method 时要写「文件#方法」' };

  const caseTitle = String(draft.caseTitle ?? '').trim();
  const note = String(draft.note ?? '').trim();
  if (caseTitle.length > CASE_MAP_LIMITS.caseTitle) return { error: `用例标题最多 ${CASE_MAP_LIMITS.caseTitle} 个字符` };
  if (note.length > CASE_MAP_LIMITS.note) return { error: `备注最多 ${CASE_MAP_LIMITS.note} 个字符` };

  const now = opts.now || new Date().toISOString();
  const id = draft.id || (opts.makeId ? opts.makeId(0) : `cm-${Date.now()}`);
  return {
    entry: {
      id,
      caseNo,
      ...(caseTitle ? { caseTitle } : {}),
      target,
      source: 'manual',
      ...(note ? { note } : {}),
      updatedAt: now,
    },
  };
}

/** 界面上「覆盖状态」用的汇总：有多少条用例映射到了文件、多少条映射到方法 */
export function caseMapSummary(items: CaseMapEntry[]): { total: number; file: number; method: number; csv: number; manual: number } {
  const list = Array.isArray(items) ? items : [];
  return {
    total: list.length,
    file: list.filter((i) => i.target?.kind === 'file').length,
    method: list.filter((i) => i.target?.kind === 'method').length,
    csv: list.filter((i) => i.source === 'csv').length,
    manual: list.filter((i) => i.source === 'manual').length,
  };
}