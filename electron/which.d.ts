/** 声明文件：让渲染层单测可以 import electron/which.js（契约 `[C-14]`）。 */

export declare function which(
  name: string,
  deps?: {
    platform?: string;
    /** 单测替身：签名同 child_process.execFileSync */
    execFileSync?: (cmd: string, args: string[], opts: object) => unknown;
  },
): string;
