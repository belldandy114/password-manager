/**
 * electron/nav-guard.js 的类型声明（纯逻辑，渲染层单测可直接 import）。
 */

export declare const DEV_RENDERER_ORIGIN: string;
export declare const DEV_TDG_ORIGIN: string;

export declare const HARDENED_WEBVIEW_PREFERENCES: Readonly<{
  nodeIntegration: boolean;
  nodeIntegrationInSubFrames: boolean;
  contextIsolation: boolean;
  sandbox: boolean;
  webSecurity: boolean;
  allowRunningInsecureContent: boolean;
  experimentalFeatures: boolean;
}>;

export interface GuardOptions {
  /** 开发态：主窗口是 localhost:5173、webview 是 localhost:5174 */
  dev?: boolean;
  /** 打包态主窗口允许停留的目录（dist） */
  distDir?: string;
  /** 打包态 webview 允许停留的目录（dist-tdg） */
  tdgDistDir?: string;
  /** 官方 webview preload 的绝对路径 */
  tdgPreloadPath?: string;
  devOrigin?: string;
}

export declare function toLocalPath(value: unknown): string;
export declare function isWithinDir(target: unknown, dir: unknown): boolean;
export declare function isAllowedMainNavigation(rawUrl: unknown, options?: GuardOptions): boolean;
export declare function isAllowedWebviewNavigation(rawUrl: unknown, options?: GuardOptions): boolean;

export interface WindowOpenDecision {
  action: 'deny';
  /** http(s) 目标会带这个字段，调用方应转交系统浏览器 */
  external?: string;
}

export declare function decideWindowOpen(rawUrl: unknown): WindowOpenDecision;

export interface WebviewAttachResult {
  allow: boolean;
  reason?: string;
  /** 通过校验时应写回 webPreferences.preload 的值；undefined 表示剥掉 */
  sanitizedPreload?: string;
  preloadRemoved?: boolean;
}

export declare function inspectWebviewAttach(
  params: { src?: string; preload?: string } | undefined,
  options?: GuardOptions,
): WebviewAttachResult;

export interface InstallGuardsDeps {
  app: { on: (event: string, listener: (...args: any[]) => void) => unknown };
  openExternalUrl: (url: string) => unknown;
  getOptions: () => GuardOptions;
  onBlocked?: (message: string) => void;
}

export declare function installNavigationGuards(deps: InstallGuardsDeps): void;

export declare function guardWebviews(
  hostContents: { on: (event: string, listener: (...args: any[]) => void) => unknown },
  getOptions: () => GuardOptions,
): void;
