/** Git 影响面（模块 6）：只读命令白名单 + `-z` 解析（契约 C-57〜C-60）。纯函数，只 require `path`。 */

export type GitScope = 'unstaged' | 'staged' | 'head';

export interface GitStatusEntry {
  /** 已暂存侧状态字母（`?` 表示未跟踪） */
  x: string;
  /** 工作区侧状态字母 */
  y: string;
  /** 新路径（rename 时是改名后的路径） */
  path: string;
  /** rename/copy 的旧路径；其它为空串 */
  origPath: string;
}

export interface GitNumstatEntry {
  path: string;
  origPath: string;
  additions: number;
  deletions: number;
  /** numstat 的行数字段是 `-`（二进制文件） */
  binary: boolean;
}

export interface GitDiffFile {
  path: string;
  origPath?: string;
  /** untracked | added | deleted | modified | staged-modified | renamed（二进制再加 `-binary`） */
  status: string;
  additions: number;
  deletions: number;
}

export declare const GIT_SCOPES: readonly GitScope[];
export declare const DIFF_SUFFIX: Readonly<Record<GitScope, readonly string[]>>;
export declare const MAX_FILES: number;
/** 白名单里明确不允许出现的写命令 */
export declare const WRITE_COMMANDS: readonly string[];

export declare function buildProbeArgs(): { branch: string[]; head: string[]; status: string[] };
export declare function buildDiffArgs(scope: GitScope | string): { ok: true; args: string[] } | { ok: false; error: string };

/** `status --porcelain -z`：rename 是两段，**新路径在前、旧路径在后**（实测 git 2.39.1） */
export declare function parseStatusZ(text: string): { ok: true; entries: GitStatusEntry[] };

/** `diff --numstat -z`：rename 是两段，**旧路径在前、新路径在后** */
export declare function parseNumstatZ(text: string): { ok: true; entries: GitNumstatEntry[] };

export declare function statusOf(x: string, y: string, binary: boolean): string;

/** 按 scope 过滤 status 条目：staged 只留索引侧改动、unstaged 留工作区侧与未跟踪、head 全留 */
export declare function filterByScope(entries: GitStatusEntry[], scope: GitScope | string): GitStatusEntry[];

export declare function mergeDiff(input: {
  statusEntries?: GitStatusEntry[];
  numstatEntries?: GitNumstatEntry[];
  maxFiles?: number;
}): { files: GitDiffFile[]; truncated: boolean };

export declare function normalizeRoot(root: string): string;