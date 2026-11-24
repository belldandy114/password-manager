export interface DecodedText {
  text: string;
  encoding: string;
}

/** 按 BOM → UTF-8 → GB18030 的顺序嗅探并解码文本文件字节 */
export function decodeTextBuffer(buf: Buffer | Uint8Array): DecodedText;

/** 编码名转界面文案（gb18030 → GBK，utf-16* → UTF-16，其余 UTF-8） */
export function encodingLabel(encoding: string): string;

/**
 * `file:save-text` 的 BOM 前缀：**只有严格 `=== true`** 返回 `'\uFEFF'`，其余一律空串。
 * 参数用 `unknown` 是刻意的——调用方可能是字符串 `'true'`/`'false'`、数字、`null`，
 * 类型上就不给「随手传个真值」留口子。
 */
export function bomPrefix(bom?: unknown): string;
