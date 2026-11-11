/** 声明文件：让渲染层单测可以直接 import electron/attach-image.js */

export declare const MAX_IMAGE_BYTES: number;
export declare const IMAGE_EXT: Record<string, string>;

export interface ParsedImage {
  ok: boolean;
  mime?: string;
  ext?: string;
  base64?: string;
  size?: number;
  error?: string;
}

export declare function base64Size(b64: string): number;
export declare function parseImageDataUrl(dataUrl: string): ParsedImage;
export declare function stampedImageName(ext: string, date?: Date): string;
export declare function sniffImageMime(base64: string): string;
export declare function buildImageDataUrl(mime: string, base64: string): string;