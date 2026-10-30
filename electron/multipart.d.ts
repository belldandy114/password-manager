/** 声明文件：让渲染层单测可以 import electron/multipart.js */

export interface MultipartLine {
  ok: boolean;
  key: string;
  value: string;
  isFile: boolean;
  filePath: string;
  filename: string;
  mime: string;
}

export declare const MIME_BY_EXT: Record<string, string>;
export declare function guessMime(filePath: string): string;
export declare function parseMultipartLine(line: string): MultipartLine;