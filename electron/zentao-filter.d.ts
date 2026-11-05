/** 声明文件：让渲染层单测可以 import electron/zentao-filter.js */

export interface MineBugLike {
  openedBy?: { account?: string; realname?: string } | string | null;
  assignedTo?: { account?: string; realname?: string } | string | null;
  [k: string]: unknown;
}

export interface MineFilterResult<T = MineBugLike> {
  rows: T[];
  filtered: boolean;
  withAccount: number;
  dropped: number;
}

export declare function accountOf(who: unknown): string;
export declare function pickWho(bug: MineBugLike, scope: string): unknown;
export declare function filterMineBugs<T = MineBugLike>(rows: T[], account: string, scope: string): MineFilterResult<T>;