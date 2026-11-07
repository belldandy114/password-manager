/**
 * 从用户在快速搜索里敲的一串文字里猜出「要新建的网址」。
 *
 * 典型场景：在浏览器或别处复制了链接，Ctrl+空格 粘贴进搜索框，
 * 密码库里没有这条记录 → 回车直接新建，URL 不用再手打一遍。
 *
 * 支持：
 *   https://example.com/login?a=1
 *   example.com
 *   taobao.com/item  （自动补 https://）
 *   阿里云后台 https://ecs.console.aliyun.com   （前面的中文当名称）
 */

export interface UrlGuess {
  url: string;
  name: string;
}

/** 域名 + 可选端口/路径，允许没有协议头；也认内网 IPv4（测试环境后台很常见） */
const URL_RE = /(?:https?:\/\/)?(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{2,5})?(?:[/?#][^\s]*)?/i;

/** 明显不像网址的输入（纯搜索词）也允许新建：只当名称用，url 留空 */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function guessUrlFromInput(raw: string): UrlGuess | null {
  const text = String(raw || '').trim();
  if (!text) return null;

  const match = text.match(URL_RE);
  if (!match) return null;

  let url = match[0].trim().replace(/[)）】"'”’。，,；;]+$/, '');
  if (!url || !safeHost(/^https?:\/\//i.test(url) ? url : `https://${url}`)) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const host = safeHost(url);
  if (!host || !host.includes('.')) return null;

  // 网址前面还有文字 → 当作名称（"阿里云后台 https://..." → 阿里云后台）
  const before = text.slice(0, match.index ?? 0).replace(/[\s:：\-—|,，]+$/u, '').trim();
  return { url, name: before || host };
}

/** 名称是否就是域名的兜底（用于判断要不要提示用户补充名称） */
export function nameLooksLikeHost(name: string, url: string): boolean {
  const host = safeHost(url);
  if (!host) return false;
  return String(name || '').trim().toLowerCase() === host.toLowerCase();
}
