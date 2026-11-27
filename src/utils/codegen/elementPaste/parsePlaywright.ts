/**
 * Playwright codegen 脚本 → 候选元素（A₁：三 Target 全认，契约 [A1-8]）。
 *
 * ## 三种 Target 的差别只有三处（其余结构一致，所以只需要一套扫描）
 * | 差异 | JS | Python | Java |
 * |---|---|---|---|
 * | 方法名 | `getByRole` | `get_by_role` | `getByRole` |
 * | 选项承载 | **对象字面量** `{ name: '登录' }` | **关键字实参** `name="登录"` | **选项对象构造** `new Page.GetByRoleOptions().setName("登录")` |
 * | 角色 | 字符串 `'button'` | 字符串 `"button"` | 枚举 `AriaRole.BUTTON`（需反归一成小写角色名） |
 *
 * 本文件只做「JS 行的参数读取 + 三语法分派」；`parsePython.ts` / `parseJava.ts` 各管一种语法
 * 的参数读取；**kind / 名字 / 置信度 / 文案全部在 `mapChain.ts`**（唯一一份）。
 *
 * ## 动作行一律忽略，且切分在字符串字面量之外
 * `TAIL_ACTION` 那种"对整行跑正则"的写法会把 `getByText('行内有 .click( 字样')` 切在字符串
 * 中间，得到一个未闭合引号、整行静默丢弃。这里按 `scan.ts` 的括号/引号感知扫描切，
 * 字符串里的 `.click(` 不再有特权。
 *
 * ## 不静默（[A1-8] (5)）
 * 「像定位行但认不出」（f-string / 变量插值 / iframe 链 / 未知方法）→ 跳过并计入 `skippedLines`；
 * 纯动作行与非定位行是**预期忽略**，不计入。
 */

import type { ElementPasteCandidate, PasteReport, PasteTarget, SkippedLine } from './types';
import type { ParsedSegment } from './mapChain';
import { dedupeCandidates, hasLocatorSegment, isAction, mapChain, skipReasonOf } from './mapChain';
import { scanLine, splitArgs, normKey, targetOfText, unquoteLiteral } from './scan';
import { pythonSegmentsOfLine } from './parsePython';
import { javaSegmentsOfLine } from './parseJava';

/** JS 的行内实参：对象字面量当选项，其余当位置参数 */
function readJsArgs(argsRaw: string): { opts: Record<string, string>; pos: string[] } {
  const opts: Record<string, string> = {};
  const pos: string[] = [];
  for (const part of splitArgs(argsRaw)) {
    const obj = /^\{([\s\S]*)\}$/.exec(part.trim());
    if (obj) {
      for (const kv of splitArgs(obj[1])) {
        const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]+)$/.exec(kv.trim());
        if (m) opts[normKey(m[1])] = m[2].trim();
      }
      continue;
    }
    pos.push(part.trim());
  }
  return { opts, pos };
}

/** 一行 JS/TS 定位行 → 段落数组；`null` = 这行不是 `page*.` 调用 */
export function jsSegmentsOfLine(line: string): ParsedSegment[] | null {
  const scanned = scanLine(line);
  if (!scanned) return null;
  const segments: ParsedSegment[] = [];
  for (const call of scanned.calls) {
    const { opts, pos } = readJsArgs(call.argsRaw);
    const seg: ParsedSegment = { method: call.camel };
    const first = pos.length ? unquoteLiteral(pos[0]) : null;
    if (call.camel === 'filter') {
      seg.locatorArg = opts.hastext === undefined ? undefined : (unquoteLiteral(opts.hastext) ?? undefined);
    } else if (call.camel === 'nth') {
      seg.locatorArg = pos.length ? String(unquoteLiteral(pos[0]) ?? pos[0]).trim() : undefined;
    } else if (call.camel === 'first' || call.camel === 'last') {
      seg.locatorArg = undefined;
    } else {
      seg.locatorArg = first ?? undefined;
      if (call.camel === 'getByRole' && opts.name !== undefined) {
        seg.roleName = unquoteLiteral(opts.name) ?? undefined;
      }
      if (opts.exact !== undefined) seg.exact = /^(true)$/i.test(opts.exact.trim());
      const extra = Object.keys(opts).filter((k) => k !== 'name' && k !== 'exact' && k !== 'hastext');
      if (extra.length) seg.extraOptions = true;
    }
    segments.push(seg);
  }
  return segments;
}

/** 按 Target 取该行的段落读取器 */
function segmentsOfLine(line: string, target: PasteTarget): ParsedSegment[] | null {
  if (target === 'python') return pythonSegmentsOfLine(line);
  if (target === 'java') return javaSegmentsOfLine(line);
  return jsSegmentsOfLine(line);
}

/**
 * 整段文本 → `{ candidates, skippedLines }`。
 *
 * **逐行判 Target**（不是整段判）：JS + Python 混粘也能一次解析完；未指定时按整段特征兜底，
 * 但每行仍以本行特征为准。
 *
 * `skippedLines` 是**带行号与原因的数组**（review-code：不许静默消失）。两类会被计入：
 * ① 括号/引号到行尾都没闭合（`scan.ts` 的 `unclosed`）—— 整行丢弃，不拿半截实参造候选；
 * ② 含定位内容但 `mapChain` 转不成候选（f-string / iframe 链 / 多段链 / 未知方法）。
 */
export function parsePlaywrightReport(text: string, targetHint?: PasteTarget): PasteReport {
  const candidates: ElementPasteCandidate[] = [];
  const skippedLines: SkippedLine[] = [];
  const fallbackTarget = targetHint ?? targetOfText(text);
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // 没有 `page*.` 调用的行（import / class / 空行 / goto）直接不看
    const scanned = scanLine(line);
    if (!scanned) continue;
    // 首个调用就是动作 → 纯动作行，预期忽略
    const firstCall = scanned.calls[0];
    if (firstCall && isAction(firstCall.camel)) continue;

    // ① 未闭合：整行丢弃并记原因（有界、不会死循环，但这一段是半截的）
    if (scanned.calls.some((c) => c.unclosed)) {
      skippedLines.push({
        line: index + 1,
        text: line.trim().slice(0, 160),
        reason: '括号或引号没闭合，整行丢弃（实参是半截的，不能当定位器用）',
      });
      continue;
    }

    const target = targetOfText(line) ?? fallbackTarget;
    const segments = segmentsOfLine(line, target);
    if (!segments) continue;
    const candidate = mapChain({ target, segments }, { source: 'playwright-js' });
    if (candidate) {
      candidates.push(candidate);
      continue;
    }
    // ② 含定位内容却转不成候选 → 记「未识别」并带原因（[A1-8] (5)）
    if (hasLocatorSegment(segments)) {
      skippedLines.push({
        line: index + 1,
        text: line.trim().slice(0, 160),
        reason: skipReasonOf(segments),
      });
    }
  }
  return { candidates: dedupeCandidates(candidates), skippedLines };
}

/**
 * 解析 Playwright codegen 脚本（可多行，JS / Python / Java 任意混写）。
 * 认不出定位行 → 空数组（调用方显示「无法识别」并写 0 条）。
 */
export function parsePlaywright(text: string, targetHint?: PasteTarget): ElementPasteCandidate[] {
  return parsePlaywrightReport(text, targetHint).candidates;
}
