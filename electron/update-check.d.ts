/** 声明文件：让渲染层单测可以 import electron/update-check.js */

export declare function cmpVersion(a: string, b: string): number;

export declare function shouldNotifyUpdate(args: {
  current?: string;
  latest?: string;
  lastNotified?: string;
}): boolean;
