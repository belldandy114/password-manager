/**
 * 声明文件：让渲染层单测可以 import electron/record-probe.js（契约 `[C-14]`）。
 *
 * 只声明**纯函数 + 常量 + `probeAbilities`**；`deps` 替身故意写成 `Record<string, unknown>`
 * ——单测可以注入任意外部能力（假 which / 假 exec / 假 readdir / 假时钟），
 * 主进程调用则完全不传第二个参数。
 */

export type ProbeState = 'green' | 'yellow' | 'red' | 'grey';

export interface ProbeEvidence {
  cmd: string;
  /** 已脱敏（本机绝对路径换成 `<用户目录>` / `<工程目录>`） */
  out: string;
}

export interface ProbeAbility {
  /** chrome / node / jdk-jar / playwright / workspace（固定 5 个） */
  id: string;
  state: ProbeState;
  label: string;
  detail: string;
  evidence: ProbeEvidence[];
  fixHint?: string;
}

export interface ProbeResult {
  probedAt: string;
  /** 探针注入口（PM_RECORD_PROBE_STUB）生效时才有；打包版永不为 true */
  stubbed?: true;
  abilities: ProbeAbility[];
}

export const ABILITY_IDS: string[];
/** 桩文件大小上限（>64 KB 一律失效，SEC-R2-07） */
export const MAX_STUB_BYTES: number;
/** detail / fixHint 的长度上限 */
export const MAX_ABILITY_TEXT: number;
/** evidence[].cmd / out 的长度上限 */
export const MAX_EVIDENCE_TEXT: number;
export const STATES: ProbeState[];
export const PROBE_TTL_MS: number;
export const PROBE_EXEC_TIMEOUT_MS: number;
export const STUB_ENV: string;
export const NODE_MIN_MAJOR: number;
export const HOME_PLACEHOLDER: string;
export const WORKSPACE_PLACEHOLDER: string;
export const CHROMIUM_EXECUTABLES: string[];

export declare function resetProbeCache(): void;
export declare function isChromiumExecutable(executable: string): boolean;
export declare function redactEvidenceText(text: string, ctx?: { homeDir?: string; workspaceDir?: string }): string;
export declare function probeAbilities(
  input?: { workspaceDir?: string; force?: boolean },
  overrides?: Record<string, unknown>,
): ProbeResult;
