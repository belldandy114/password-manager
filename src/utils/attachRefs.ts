/**
 * 图片附件在正文里的引用语法（纯字符串，无 React / 无 DOM）。
 *
 * 附件是加密存的：正文只写 `![说明](pm-att:<id>)`，真正的字节在 attachments 目录里，
 * 由主进程按会话密钥解密。所以这里只做「生成 / 识别 / 抽取」，不碰数据。
 */

/** 附件引用协议前缀：图片地址写成 pm-att:<id> */
export const ATT_PREFIX = 'pm-att:';

/** 生成一条图片附件的 Markdown */
export function attImageMarkdown(id: string, alt = '截图'): string {
  return `![${String(alt || '截图').replace(/[[\]]/g, '')}](${ATT_PREFIX}${id})`;
}

/** 抽出一段 Markdown 里引用到的附件 id（去重，保持出现顺序） */
export function extractAttIds(md: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${ATT_PREFIX}([a-zA-Z0-9-]+)\\)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(md || ''))) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 一行是否是图片附件（返回 id 与说明） */
export function matchAttImage(line: string): { id: string; alt: string } | null {
  const m = new RegExp(`^\\s*!\\[([^\\]]*)\\]\\(${ATT_PREFIX}([a-zA-Z0-9-]+)\\)\\s*$`).exec(String(line || ''));
  if (!m) return null;
  return { alt: m[1], id: m[2] };
}