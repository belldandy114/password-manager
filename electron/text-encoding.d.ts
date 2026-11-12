export interface DecodedText {
  text: string;
  encoding: string;
}

/** 按 BOM → UTF-8 → GB18030 的顺序嗅探并解码文本文件字节 */
export function decodeTextBuffer(buf: Buffer | Uint8Array): DecodedText;

/** 编码名转界面文案（gb18030 → GBK，utf-16* → UTF-16，其余 UTF-8） */
export function encodingLabel(encoding: string): string;
