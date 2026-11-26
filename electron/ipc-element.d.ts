/** 声明文件：`el:*` 四条通道的主进程实现（元素库 · 定位/试跑，1.36.0 / B8）。 */

export interface ElementIpcDeps {
  getMainWindow: () => any;
}

export declare function registerElementIpc(deps: ElementIpcDeps): void;

/** 探测 playwright 包（子进程 `require.resolve`，主进程不引浏览器库；只回 ok/固定文案） */
export declare function probePlaywright(
  nodeExe: string | null,
  workDir: string
): { ok: boolean; detail?: string };
