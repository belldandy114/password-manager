/**
 * Java Target 的定位行 → `{ method, locatorArg, roleName }`（契约 [A1-8] (1)(2)）。
 *
 * 只负责切参数：Java codegen 的角色是**枚举常量**（`AriaRole.BUTTON`），选项是**嵌套构造**
 * （`new Page.GetByRoleOptions().setName("登录").setExact(true)`），且那个类名有**三种**
 * （`Page` / `Locator` / `FrameLocator`，取决于链的位置）——所以绝不许写死 `new Page.`。
 *
 * ## 反归一是本文件最容易写错的一条
 * `AriaRole.MENUITEMCHECKBOX` → `locator = "menuitemcheckbox"`（**小写常量名**），
 * 因为元素库 `kind='role'` 的 `locator` 语义是「ARIA 角色名」（[A0-2] 第 4 行），
 * 不是 Java 常量名。它与 [A1-1] 的「大写 + 删分隔符」互逆：不加连字符、不加下划线。
 *
 * kind / 名字 / 置信度 / 文案一律交给 `mapChain`。纯函数：零 IPC、零 window、零 React。
 */

import type { ElementPasteCandidate } from './types';
import type { ParsedSegment } from './mapChain';
import { dedupeCandidates, mapChain } from './mapChain';
import { scanLine, splitArgs, unquoteLiteral } from './scan';

/** 从一段原文里取第一个字符串字面量并解引号（`new X.YOptions().setName("登录")` → `登录`） */
function firstStringLiteral(raw: string): string | null {
  const m = /("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/.exec(String(raw ?? ''));
  return m ? unquoteLiteral(m[1]) : null;
}

/** `.setName("登录")` 的值 */
function setterValue(raw: string, setter: string): string | null {
  const re = new RegExp(`\\.${setter}\\(\\s*("[^"]*"|'[^']*')\\s*\\)`);
  const m = re.exec(String(raw ?? ''));
  return m ? (unquoteLiteral(m[1]) ?? null) : null;
}

/**
 * `AriaRole.X` → 小写 ARIA 角色名。
 * `MENUITEMCHECKBOX` → `menuitemcheckbox`（删分隔符的逆运算：只小写，不插分隔符）。
 *
 * ⚠️ 只认**常量**写法：`AriaRole.valueOf("X")` 是 [A1-2]/`[Z-2]` 明令**不许生成**的形态
 * （Java 侧是必抛的运行期异常），这里也不给它开后门——真粘进来就按「认不出」计数。
 */
export function roleFromAria(raw: string): string | null {
  const constant = /AriaRole\.([A-Z][A-Z0-9_]*)/.exec(String(raw ?? ''));
  if (!constant) return null;
  const role = constant[1].toLowerCase().replace(/[^a-z0-9]/g, '');
  return role || null;
}

/**
 * 一行 → 段落数组；`null` = 这行不是 `page*.` 定位行。
 * 参数不是字面量（变量 / 拼接）→ 段落里 `locatorArg` 留空，由 `mapChain` 判 null 并计数。
 */
export function javaSegmentsOfLine(line: string): ParsedSegment[] | null {
  const scanned = scanLine(line);
  if (!scanned) return null;
  const segments: ParsedSegment[] = [];
  for (const call of scanned.calls) {
    const args = splitArgs(call.argsRaw);
    const seg: ParsedSegment = { method: call.camel };
    if (call.camel === 'getByRole') {
      // 第一个实参是枚举常量，不是字符串 → 只能从 AriaRole 反归一
      const role = roleFromAria(call.argsRaw);
      seg.locatorArg = role ?? undefined;
      const name = setterValue(call.argsRaw, 'setName');
      if (name !== null) seg.roleName = name;
      const extra = /\.set(?!(?:Exact|Name)\b)[A-Za-z0-9_]+\(/.test(call.argsRaw);
      if (extra) seg.extraOptions = true;
    } else if (call.camel === 'filter') {
      const hasText = setterValue(call.argsRaw, 'setHasText');
      seg.locatorArg = hasText ?? undefined;
    } else if (call.camel === 'nth') {
      seg.locatorArg = args.length ? args[0].trim() : undefined;
    } else if (call.camel === 'first' || call.camel === 'last') {
      seg.locatorArg = undefined;
    } else {
      seg.locatorArg = args.length ? (unquoteLiteral(args[0]) ?? undefined) : undefined;
      const extra = /\.set(?!(?:Exact|Name)\b)[A-Za-z0-9_]+\(/.test(call.argsRaw);
      if (extra) seg.extraOptions = true;
    }
    if (seg.method !== 'filter' && /\.setExact\(\s*true\s*\)/.test(call.argsRaw)) seg.exact = true;
    segments.push(seg);
  }
  return segments;
}

/** 整段 Java 文本 → 候选（供三 Target 矩阵单测直接调用） */
export function parseJava(text: string): ElementPasteCandidate[] {
  const out: ElementPasteCandidate[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const segments = javaSegmentsOfLine(line);
    if (!segments) continue;
    const candidate = mapChain({ target: 'java', segments }, { source: 'playwright-js' });
    if (candidate) out.push(candidate);
  }
  return dedupeCandidates(out);
}
