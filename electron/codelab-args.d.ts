/** 声明文件：让渲染层单测可以 import electron/codelab-args.js */

export type CodelabLang = 'javascript' | 'python' | 'java';

export interface CodelabStep {
  cmd: string;
  args: string[];
}

export interface CodelabPlan {
  lang: string;
  files: { name: string; content: string }[];
  steps: CodelabStep[];
}

export declare const SUPPORTED: string[];
export declare const FILE_NAMES: Record<string, string>;
export declare function javaClassName(code: string): string;
export declare function buildRunPlan(input: {
  lang: string;
  code: string;
  dir: string;
  runtime: { nodePath?: string; pythonPath?: string; javaExe?: string; javacExe?: string };
}): CodelabPlan;
export declare function splitSteps(plan: CodelabPlan): { compile: CodelabStep[]; run: CodelabStep[] };
export declare function tempDirName(stamp: string, rand: string): string;
