/** 声明文件：让渲染层单测可以 import electron/json-paths.js */

export interface JsonLeaf {
  path: string;
  name: string;
  value: string;
  preview: string;
  type: string;
}

export declare const MAX_ARRAY_ITEMS: number;
export declare function flattenJsonPaths(root: unknown, opts?: { max?: number; maxStringShow?: number }): JsonLeaf[];
export declare function upsertVariable(varsText: string, name: string, value: string): string;
