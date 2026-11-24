/**
 * 代码体检 / 覆盖矩阵的数据形状、三级严重度词表与**纯函数口径**
 *
 * 被 AuditTab / FindingsTable / AssetLedger 共用；不依赖 React，也不碰 IPC。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开。
 * 1.34.0 / W8 第 1 轮评审修复（t14）本文件改了四件事：
 *   ① 截断原因的中文口径（`truncatedReasonText`）成为**唯一真源** —— 内部枚举值
 *      （`suppressed` / `findings` / `file-size`…）一律不许直接显示给用户（评审 C2）；
 *   ② `scanCutState` 按**数值**判「明细没给全」，不再认单一 `truncatedReason`
 *      （`suppressed` 在优先级里高于 `findings`，会把 detailCut 整条盖掉 → 评审 C1 / R-01）；
 *   ③ 运行条件文案（体检 / 覆盖矩阵）下沉成纯函数，两个页面共用同一套六分流与舍入口径；
 *   ④ 删掉死代码 `summarizeSeverity`（全仓零调用，评审 C4）。
 */

import type { ScanFinding, ScanPack, ScanRuleMeta, ScanRunResult } from '../../types';

/**
 * 这里**不再本地复制 IPC 返回的接口**：`scan:run` / `scan:rules` 的 data 在 `src/types.ts` 里有唯一真源
 * （t62 落地 [C-46]）。本地副本的问题不是「多写几行」，而是它会和真源漂移——A1 就是漂移的结果：
 * 本地把 severity 写成 `'high' | 'medium' | 'low' | string`，那个 `| string` 把类型闸门彻底废掉
 * （`counts.mid` 因此也能编译通过），而真源 `ScanSeverity` 一直是三级联合。
 *
 * 历史数据里可能出现的非法 severity（如 v13 的 `mid`）**不靠放宽类型兼容**：
 * 读取边界窄化——`readHistoryCounts` 把老 `mid` 读成 medium。
 */
export type { ScanFinding, ScanPack };
/** `scan:run` 的 data（官方类型 `ScanRunResult`；保留旧名字给页面 import） */
export type ScanRunData = ScanRunResult;
/** `scan:rules` 的一条规则（官方类型 `ScanRuleMeta`） */
export type ScanRule = ScanRuleMeta;

/** `scanRuns` 集合的一条（契约 §1.3） */
export interface ScanRunRecord {
  id: string;
  at: string;
  root: string;
  pack: 'audit';
  files: number;
  bytes?: number;
  skippedSymlinks?: number;
  truncated: boolean;
  truncatedReason?: string;
  counts: { high: number; medium: number; low: number };
  /**
   * **v17 起不写入**（契约 C-29 v17，第 1 轮评审 S-01 裁定）：`sec-*` 规则命中的那一行
   * **本身就是明文口令 / token**，而历史页没有任何读明细的入口 → 存而不用，还随整库备份
   * （`backup:create` 的 copyFile 与异地镜像）一起外发。
   *
   * 因此新记录**不写**这个键；字段留在类型里只为两件事：旧记录里可能还有它（读取端一律忽略、
   * 不得因此崩），以及让「我们曾经存过明细」这件事在类型上留个痕。
   */
  findings?: ScanFinding[];
  /**
   * 当次**全仓命中总数**（契约 §1.3 v16 新增）。
   * 写入时必填（取自 `scan:run` 的 `ScanRunResult.totalFindings`）；读取时兼容缺失——
   * v16 之前的历史记录没有这个字段，**不得**拿 `findings.length` 冒充总数。
   * 旧主进程（降级 / 半更新）也可能不回传：那时**不写这个键**，绝不固化成 0（评审 R-07）。
   */
  totalFindings?: number;
  ruleIds?: string[];
  ms?: number;
}

/**
 * 严重度词表（契约 v14 / [C-30]：三级 **high / medium / low**）。
 *
 * 为什么只剩一套拼写：v13 之前契约写 `mid`、实现用 `medium`，本页当时两套都认（归一到 mid 桶）。
 * v14 契约裁「跟实现走」，所以现在**只认 medium**，落库也只写 medium。
 * 历史遗留的 `mid` 只在**读老记录**时兼容（见 `readHistoryCounts`）——那是读取容错，不是第二套词表。
 */
export const SEVERITY_TEXT: Record<string, string> = { high: '高', medium: '中', low: '低' };
export const SEVERITY_ORDER = ['high', 'medium', 'low'] as const;
export type SeverityKey = typeof SEVERITY_ORDER[number];

/**
 * **当次展示**的 findings 明细硬上限（`electron/scan-collect.js` 的 `FINDINGS_DETAIL_CAP` = 2000，
 * 契约 C-53 v16）。
 *
 * v16 起语义变了：到 2000 条后端**不再停止扫描**，而是继续遍历、只累加 `totalFindings` 与 `counts`。
 * 所以「全仓命中多少」是**算得出来的真数**（`ScanRunResult.totalFindings`），界面要说的不再是
 * 「实际可能更多」，而是「命中 {totalFindings} 条，明细展示前 {FINDINGS_CAP} 条」。
 */
export const FINDINGS_CAP = 2000;

/**
 * **落库**上限（契约 C-29）。
 *
 * v16 时它的语义是「历史每条只留前 300 条明细（与展示上限 2000 解耦）」；**v17 起明细完全不落库**，
 * 于是它只剩一个用途：**读旧记录时给用户一句准话**——v16 之前落的历史记录里明细最多 300 条，
 * 分布不等于全量，历史表的「运行条件」列据此标注「旧记录：明细仅 300 条、总数未知」。
 * 不要再拿它去裁剪任何要写入的数组（现在压根没有要写的明细）。
 */
export const SCAN_HISTORY_FINDINGS_CAP = 300;

/**
 * 同一规则在**同一个文件**里最多记几条命中（后端 `electron/scan-rules.js` 的 `MAX_HITS_PER_RULE`）。
 * 超出部分被折叠，数量由 `scan:run` 的 `suppressed` 如实返回（t63 之前的静默折叠是个 bug）。
 * 这里只能写字面量：渲染层不 import 主进程常量，改后端时必须同步这一处（数字写在文案里，用户能看见）。
 */
export const MAX_HITS_PER_RULE = 3;

/**
 * 扫描覆盖上限（与主进程同值，**改后端必须同步这一处**）。
 *
 * 为什么写死在渲染层：渲染层不 import 主进程常量；它们只出现在「本次运行条件」的文案里，
 * 用户能看见具体数字，所以必须与后端一致。`SCAN_TIMEOUT_MS` 只用于把它折算成秒写进文案。
 * （评审 C10 指出这是双源、无门禁——本批不扩大，登记为已知缺口。）
 */
export const SCAN_MAX_FILES = 2000;
export const SCAN_MAX_DEPTH = 12;
export const SCAN_TIMEOUT_MS = 60000;

/* ================================================================
   截断 / 折叠的三个判据（契约 §4.2、扫描口径 §2.4、[C-30] v16）
   ================================================================ */

/** `scanCutState` 的入参：全部取自 `scan:run` 的返回，`totalFindings` 缺失时传 `NaN` */
export interface ScanCutInput {
  truncated: boolean;
  reason?: string;
  /** 同文件同规则被折叠掉的命中数（`suppressed`） */
  suppressed: number;
  /** 当次返回的明细条数（`findings.length`） */
  findingsLength: number;
  /** 全仓命中总数；旧主进程没给时传 `NaN` */
  totalFindings: number;
}

export interface ScanCutState {
  /** 真有文件没扫全（timeout / max-files / depth / file-size…）→ 只有这里才能说「可能偏少」 */
  coverageCut: boolean;
  /** 明细没给全（`findings.length < totalFindings`）→ 说确切数字，不说「偏少」 */
  detailCut: boolean;
  /** 同文件同规则折叠 > 0 → 说「不是没扫到」 */
  folded: boolean;
}

/**
 * 三个判据的**唯一实现**。
 *
 * ⚠️ `detailCut` **必须按数值判**，不能只看 `truncatedReason === 'findings'`：
 * 收集器的原因优先级是 `timeout > max-files > depth > file-size > suppressed > findings`，
 * 所以「明细到顶（2000）+ 同文件同规则折叠」同时发生时 `reason` 只能是 `'suppressed'`，
 * 于是旧写法会让面板写「命中 2500 条」、分页条写「共 2000 条」，两个数互斥却**没有一句话解释**
 * （第 1 轮评审 C1 / R-01）。
 *
 * 判据口径：`detailCut = findingsLength < totalFindings`；`totalFindings` 不是有限数（旧后端）
 * 时一律 `false` —— 不知道就别断言，更别拿 `NaN` 去比（评审 C3 / R-08）。
 */
export function scanCutState(i: ScanCutInput): ScanCutState {
  const reason = i.reason ?? '';
  return {
    coverageCut: !!i.truncated && !['findings', 'suppressed'].includes(reason),
    detailCut: Number.isFinite(i.totalFindings) && i.findingsLength < i.totalFindings,
    folded: i.suppressed > 0,
  };
}

/**
 * 截断原因 → **中文口径**（唯一真源）。
 *
 * 为什么必须有这一层：`truncatedReason` 是内部枚举（`suppressed` / `findings` / `file-size`…），
 * 直接拼进界面就是把实现细节当用户话术（第 1 轮评审 C2）；未知原因也不回显原值，统一说「其它原因」。
 */
export function truncatedReasonText(reason?: string): string {
  switch (reason) {
    case 'findings': return '明细到顶';
    case 'suppressed': return '同类已折叠';
    case 'timeout': return '扫描超时';
    case 'max-files': return '文件数触顶';
    case 'files': return '文件数触顶'; // scan 不受理 'files'，但历史记录/其它包可能出现，别显示原文
    case 'depth': return '目录过深';
    case 'file-size': return '单文件超限';
    case 'cases': return '用例数触顶';
    case 'flaky': return 'flaky 记录超限';
    case 'rows': return '行数触顶';
    case 'labels': return '接口维度触顶';
    default: return '其它原因';
  }
}

/** 非有限数（NaN / Infinity / undefined / null / 字符串）⇒ `'—'`；用于面板 meta、toast、历史「总数」列 */
export function numOrDash(n: unknown): number | '—' {
  return typeof n === 'number' && Number.isFinite(n) ? n : '—';
}

/**
 * `[C-30]` 两条不变量的校验入口：`counts` 合计 === `totalFindings`，且 `findings.length <= totalFindings`。
 *
 * **只在两边都是有限数时才算**（评审 R-08）：旧主进程没回传 `totalFindings` 时它是 `NaN`，
 * `countsSum === NaN` 恒 false —— 旧写法会把「字段缺失」报成「后端计数与总数对不上」，
 * 把用户引向一个根本不存在的问题。缺失就降级为**不校验**（返回 false），由提示条说明「总数未知」。
 */
export function scanCountsMismatch(
  counts: { high: number; medium: number; low: number } | undefined,
  totalFindings: number,
  findingsLength: number,
): boolean {
  if (!counts) return false;
  const sum = counts.high + counts.medium + counts.low;
  if (!Number.isFinite(sum) || !Number.isFinite(totalFindings)) return false;
  return sum !== totalFindings || findingsLength > totalFindings;
}

/**
 * 「扫描覆盖被砍」四种情形的核心句（契约 §4.2 #3–#6）。`tail` 由调用方给：
 * 体检页是「命中数可能偏少」，覆盖矩阵是「覆盖统计可能偏低」——两页的分子不同，但原因句一致。
 *
 * `file-size` **不许写「{n} 个文件」**：`ScanRunResult` 里没有这个字段，写数字就是编的。
 * 其它原因（如 `files`）也属覆盖被砍，但不复用这四种固定句，且**不显示内部枚举名**。
 */
export function coverageCutText(reason: string | undefined, files: number, tail: string): string {
  switch (reason) {
    case 'timeout': return `扫描超时（${SCAN_TIMEOUT_MS / 1000} s），只扫了 ${files} 个文件，${tail}`;
    case 'max-files': return `只扫了前 ${SCAN_MAX_FILES} 个文件，${tail}`;
    case 'depth': return `目录超过 ${SCAN_MAX_DEPTH} 层未深入，${tail}`;
    case 'file-size': return `有文件只读了前 1 MB，${tail}`;
    default: return `扫描未覆盖全部文件（${truncatedReasonText(reason)}）：下面的结果只代表已扫到的部分`;
  }
}

/** 运行条件文案的入参：`ScanCutInput` + 几个只用于措辞的计数 */
export interface ConditionInput extends ScanCutInput {
  files: number;
  skippedSymlinks: number;
  /**
   * 被目录/产物守卫（`coverage` 目录、`*.min.js`、`app.asar.unpacked`）跳过的**条目**数。
   * **逐字用后端的字段名** `skippedByGuard`（评审 S-03；后端 t13 已交付，契约 C-54 定字）。
   *
   * ⚠️ **计数单位是「条目」不是文件数**：跳过一个目录记 1（不递归数内部文件）、跳过一个压缩
   * 产物文件记 1；本仓库实测是 1 个目录 + 6 个产物 = 7。所以文案**不许**写「跳过 N 个文件」，
   * 只能写「N 处目录/产物被跳过」——按文件数写就是错数。
   *
   * 缺失（旧主进程）时按 0 处理 = 不显示这一段，不得崩、不得编数。
   */
  skippedByGuard?: number;
}

/**
 * 运行条件条的**语气档**（队长 t14 追加要求，写死在这里而不是散在 JSX 里）。
 *
 * 只有 `coverageCut`（真有文件没扫全）才升级成 `.dev-banner.is-warn`；
 * 明细到顶 / 同类折叠 / 跳过符号链接 / 守卫跳过条目这四类都在说「这次扫的范围」，
 * **不是**「漏扫导致偏少」，所以一律 `.is-info` —— 别把「说清范围」混进「承认漏扫」那一档。
 */
export function conditionTone(st: ScanCutState): 'is-warn' | 'is-info' {
  return st.coverageCut ? 'is-warn' : 'is-info';
}

/**
 * 体检页「本次运行条件」一条（同档 ≥2 条用「；」连接、数字一个不少；视觉口径 §4.3）。
 *
 * 顺序固定：覆盖被砍 → 明细到顶 → 折叠 → 符号链接 → 守卫跳过。
 * 只有 `coverageCut` 那一句会出现「命中数可能偏少」——明细到顶与折叠**都不许**说偏少
 * （`[C-30]` v16:217）。
 */
export function auditConditionText(i: ConditionInput): string {
  const st = scanCutState(i);
  const lines: string[] = [];
  if (st.coverageCut) lines.push(coverageCutText(i.reason, i.files, '命中数可能偏少'));
  if (st.detailCut) {
    lines.push(`命中 ${i.totalFindings} 条，明细展示前 ${FINDINGS_CAP} 条（同一文件同一规则最多 ${MAX_HITS_PER_RULE} 条）`);
  }
  if (st.folded) lines.push(`另有 ${i.suppressed} 条同类命中已折叠，不是没扫到`);
  // [C-54]：符号链接被跳过时**不折叠**；「已扫 N 个文件，跳过 M 个」在页面的 .dev-tag 里，
  // 这里补的是「它对结论意味着什么」，且不许出现「命中数可能偏少」（那不是 truncatedReason 的语义）
  if (i.skippedSymlinks > 0) lines.push(`跳过 ${i.skippedSymlinks} 个符号链接：其下就算有命中也不会出现在明细里`);
  const guard = Math.max(0, Math.floor(Number(i.skippedByGuard ?? 0) || 0));
  if (guard > 0) {
    // 单位是「条目」（目录记 1、产物文件记 1），**不许**写成「N 个文件」——本仓库实测 1 目录 + 6 产物 = 7
    lines.push(`另有 ${guard} 处目录/产物被跳过（coverage、构建产物等）：它们的命中不计入本次结果`);
  }
  return lines.join('；');
}

/**
 * 覆盖矩阵页「本次运行条件」一条。
 *
 * 与体检页的差异（评审 C2）：这里的分子是「接口覆盖」，所以覆盖被砍时说「覆盖统计可能偏低」是对的；
 * 但 **`suppressed` 只是折叠、不是截断**，绝不能说「偏低」，也不许把枚举名拼给用户看。
 */
export function coverageConditionText(i: ConditionInput): string {
  const st = scanCutState(i);
  const lines: string[] = [];
  if (st.coverageCut) lines.push(coverageCutText(i.reason, i.files, '覆盖统计可能偏低'));
  // 明细到顶对覆盖矩阵的影响方向相反：能抽到的代码引用变少 → 未覆盖数会被**高估**
  if (st.detailCut) lines.push(`明细到顶：只展开前 ${FINDINGS_CAP} 条代码引用，未覆盖数可能偏多`);
  if (st.folded) lines.push(`另有 ${i.suppressed} 条同类命中已折叠，不是没扫到`);
  if (i.skippedSymlinks > 0) lines.push(`跳过 ${i.skippedSymlinks} 个符号链接：其下若有接口调用不会被计入`);
  const guard = Math.max(0, Math.floor(Number(i.skippedByGuard ?? 0) || 0));
  if (guard > 0) {
    // 同上：单位是「条目」，不是文件数（契约 C-54 定字）
    lines.push(`另有 ${guard} 处目录/产物被跳过（coverage、构建产物等）`);
  }
  return lines.join('；');
}

/**
 * 历史记录表的「运行条件」列（中文，永不外露枚举名）。
 *
 * 三件事：① 该次是否被截断（原因转中文）；② **旧记录**（无 `totalFindings`）必须并列注明
 * 「明细仅 300 条、总数未知」——否则「命中三档」会被当成全量读，正面撞 `[C-09]` 的「禁止静默截断」
 * （评审 R-04）；③ 跳过符号链接数。
 */
export function historyConditionText(r: ScanRunRecord): string {
  const parts: string[] = [];
  if (r.truncated) parts.push(r.truncatedReason ? truncatedReasonText(r.truncatedReason) : '已截断（未给原因）');
  if (typeof r.totalFindings !== 'number') {
    parts.push(`旧记录：明细仅 ${SCAN_HISTORY_FINDINGS_CAP} 条、总数未知`);
  }
  if (typeof r.skippedSymlinks === 'number' && r.skippedSymlinks > 0) {
    parts.push(`跳过 ${r.skippedSymlinks} 个符号链接`);
  }
  return parts.length ? parts.join('；') : '—';
}

/**
 * 历史记录容错：早期落库的 `scanRuns[].counts` 可能用 `mid`（当时代码跟着契约写 mid）。
 * 读取时按 **medium** 处理；**键缺失返回 null**，界面显示 `—`。
 * 不用 `|| 0` 兜底：把「没有这个数」显示成 0，会让用户以为那次扫描真的没有中危。
 */
export function readHistoryCounts(raw: unknown): Record<SeverityKey, number | null> {
  // 读取边界：vault 里的老记录形状不可信，先收成普通对象，再逐键窄化（缺失 → null，不兜 0）
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const medium = num(c?.medium);
  const legacyMid = num(c?.mid);
  return {
    high: num(c?.high),
    // 两者同时出现就相加；老记录只有 mid、新记录只有 medium
    medium: medium === null && legacyMid === null ? null : (medium ?? 0) + (legacyMid ?? 0),
    low: num(c?.low),
  };
}