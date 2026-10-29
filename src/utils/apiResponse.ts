import type { ApiRequest, ApiResponseData } from '../types';

/**
 * 响应体另存为：文件名生成逻辑（纯函数，可单测）。
 *
 * 文件名里不能出现 `\ / : * ? " < > |` 和空白（Windows 直接拒绝），
 * 也不能太长（部分路径限长）。这些规则写错就表现为「点保存没反应」。
 */

const ILLEGAL = /[\\/:*?"<>|\s]+/g;

/** 从 `req` 推一个可读前缀；优先用户起的名字 */
export function responseNamePrefix(req: Pick<ApiRequest, 'name' | 'url'>): string {
  const raw = String(req.name || '').trim() || String(req.url || '').replace(/^https?:\/\/[^/]+/i, '');
  const cleaned = raw.replace(ILLEGAL, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 40) || 'response';
}

/** 响应体是否 JSON（解析成功才算，避免把 HTML 错误页存成 .json） */
export function isJsonBody(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

export interface ResponseSaveTarget {
  fileName: string;
  ext: 'json' | 'txt';
}

/** 生成「前缀-状态码.扩展名」 */
export function responseSaveTarget(req: Pick<ApiRequest, 'name' | 'url'>, res: Pick<ApiResponseData, 'status' | 'body'>): ResponseSaveTarget {
  const ext: 'json' | 'txt' = isJsonBody(res.body) ? 'json' : 'txt';
  return { fileName: `${responseNamePrefix(req)}-${res.status}.${ext}`, ext };
}
