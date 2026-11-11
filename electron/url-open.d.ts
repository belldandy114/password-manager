/**
 * electron/url-open.js 的类型声明（纯逻辑，渲染层单测可直接 import）。
 */

export declare function normalizeHttpUrl(raw: unknown): string;

/** 日志用的「协议 + 主机 + 路径」，会去掉查询串 */
export declare function safeForLog(url: string): string;

export interface FallbackCommand {
  exe: string;
  args: string[];
  /** 命中这条时回给界面的渠道名（rundll32 / explorer / chrome / msedge），便于诊断「到底是谁打开的」 */
  via: string;
}

export declare function fallbackCommands(url: string, platform?: string): FallbackCommand[];

/** 探测本机可用的浏览器 exe（Chrome / Edge），用于「直接拉 exe」这条通道 */
export declare function detectBrowserExes(): Array<{ exe: string; via: string }>;

export interface OpenHttpUrlDeps {
  shell?: { openExternal: (url: string) => Promise<unknown> };
  spawn?: (...args: any[]) => any;
  platform?: string;
  /** 覆盖候选浏览器列表（单测里传 [] 可关掉这条通道） */
  candidateBrowsers?: Array<{ exe: string; via: string }>;
  /** 覆盖日志出口（默认 console.log，主进程里会被 app-log 收进 app.log） */
  log?: (msg: string) => void;
}

export interface OpenHttpUrlResult {
  success: boolean;
  via?: string;
  error?: string;
}

export declare function openHttpUrl(raw: unknown, deps?: OpenHttpUrlDeps): Promise<OpenHttpUrlResult>;
