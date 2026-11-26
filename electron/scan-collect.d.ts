/**
 * 扫描收集与截断原因分流（契约 C-09 / C-29 / C-30 / C-53 / C-54 的 v17 口径）。
 * 纯函数：本模块不 require fs / electron。
 *
 * **`ScanTruncatedReason` 的真源是 `src/types.ts`**（第 1 轮评审 R-03：以前这里与 types.ts
 * 各写一份，renderer 那份多了 `'files'`，两份成员不一致）。这里改成 **import 那一个联合类型**，
 * 于是「scan 侧不含 `files`」由编译器保证；运行时的数组一致性由
 * `src/utils/__tests__/scanConstants.test.ts` 再比一次（防止改了 JS 数组忘了改类型）。
 */

import type { ScanTruncatedReason } from '../src/types';

/** 真源＝`src/types.ts`；此处只做再导出，供既有 import 方继续使用 */
export type { ScanTruncatedReason };

export type ScanSeverity = 'high' | 'medium' | 'low';

/** `electron/scan-rules.js` 的一条命中（结构兼容 `scan-rules.d.ts` 的 `ScanHit`） */
export interface ScanHitLike {
  ruleId: string;
  /** 运行时窄化：规则表只产三档，认不出的按 `low` 计 */
  severity: string;
  title: string;
  line: number;
  snippet: string;
  /** 历史字段：`coverage` 包下线后无产出方，仅为兼容旧记录的形状 */
  method?: string;
  /** 同上（历史字段） */
  path?: string;
}

/** 收集器产出的一条明细（就是 IPC 里的 `Finding`） */
export interface ScanFindingOut {
  ruleId: string;
  severity: ScanSeverity;
  title: string;
  file: string;
  line: number;
  snippet: string;
  /** 历史字段（coverage 包已下线，无产出方；仅为兼容旧 scanRuns 记录的形状） */
  method?: string;
  path?: string;
}

/** 一次收集的最终状态（对应 `scan:run` 的 counts / findings / totalFindings / suppressed / truncated*） */
export interface ScanCollectSnapshot {
  findings: ScanFindingOut[];
  counts: { high: number; medium: number; low: number };
  totalFindings: number;
  suppressed: number;
  truncated: boolean;
  truncatedReason?: ScanTruncatedReason;
}

export interface FindingCollectorOptions {
  /** 明细上限，缺省 {@link FINDINGS_DETAIL_CAP}（2000）；非法值回落缺省 */
  maxFindings?: number;
}

export interface FindingCollector {
  /** 实际生效的明细上限（clamp 之后） */
  readonly cap: number;
  /** 收一条命中；返回是否进了明细（false = 明细已满，只计了数） */
  addHit(hit: ScanHitLike, file: string): boolean;
  /** 收一个文件的全部命中；返回真正进明细的条数 */
  addHits(hits: ScanHitLike[], file: string): number;
  /** 记一个文件的折叠条数（只置 `suppressed` 原因）；返回实际计入的条数 */
  addSuppressed(n: number): number;
  /** 记一个截断原因（按优先级取，不是先到先得） */
  markTruncated(reason: string): void;
  /** 取当前状态（副本） */
  snapshot(): ScanCollectSnapshot;
}

/** 守卫计数器（S-03：跳过也必须可见） */
export interface ScanGuards {
  /** 目录被跳过返回 true 并计数；顺带说一句：目录内部的文件**不递归统计** */
  skipDir(name: string): boolean;
  /** 压缩/打包产物被挡掉返回 true 并计数 */
  skipFile(relPath: string): boolean;
  count(): number;
  /** 直接摊进 `scan:run` 的 data：`{ skippedByGuard }` */
  snapshot(): { skippedByGuard: number };
}

export interface ScanGuardsOptions {
  /** 覆盖目录清单（缺省用 {@link SKIP_DIRS}） */
  skipDirs?: Set<string>;
}

/** 允许的截断原因，**数组顺序就是优先级**：timeout > max-files > depth > file-size > suppressed > findings */
export declare const TRUNCATED_REASONS: readonly ScanTruncatedReason[];
/** 单次扫描明细上限（2000）；落库上限另算（渲染层 SCAN_HISTORY_FINDINGS_CAP = 300） */
export declare const FINDINGS_DETAIL_CAP: number;
/** 合法 severity 三档 */
export declare const SEVERITIES: readonly ScanSeverity[];
/** 压缩/打包产物路径（`.min.` / `.bundle.` / `app.asar.unpacked`） */
export declare const ARTIFACT_PATH_RE: RegExp;
/** 遍历时跳过的目录（C-54 v16：含 `coverage`） */
export declare const SKIP_DIRS: ReadonlySet<string>;
/** 单次扫描固定上限（C-53）：文件数 / 目录深度 / 整体超时（ms） */
export declare const SCAN_MAX_FILES: number;
export declare const SCAN_MAX_DEPTH: number;
export declare const SCAN_TIMEOUT_MS: number;

/** 该路径是不是压缩/打包产物（命中则不进统计，C-54 v16） */
export declare function isArtifactPath(filePath: string): boolean;
/** 建一个守卫计数器（目录跳过 + 产物 negative 都计入 `skippedByGuard`） */
export declare function createScanGuards(opts?: ScanGuardsOptions): ScanGuards;
/** 原因优先级：index 越小越优先，未知取值返回 Infinity（排最后） */
export declare function rankOfReason(reason: string): number;
/** 在两个候选原因里取优先级更高的一个；都空返回空串 */
export declare function pickReason(a: string, b: string): string;
/** severity 窄化：只认三档，认不出的按 `low` */
export declare function normalizeSeverity(severity: unknown): ScanSeverity;
/** 明细上限 clamp：缺省 2000，非法值回落缺省 */
export declare function clampMaxFindings(v: unknown): number;

export declare function createFindingCollector(opts?: FindingCollectorOptions): FindingCollector;
