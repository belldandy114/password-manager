/**
 * Python Target 的定位行 → `{ method, locatorArg, roleName }`（契约 [A1-8] (2)）。
 *
 * 只负责切参数：Python codegen 的选项是**关键字实参**（`name="登录", exact=True`），
 * 位置参数是**双引号**字符串（`get_by_role("button", name="登录")`）。
 * kind / 名字 / 置信度 / 文案一律交给 `mapChain`，本文件不判 kind。
 *
 * 纯函数：零 IPC、零 window、零 React。
 */

import type { ElementPasteCandidate } from './types';
import type { ParsedSegment } from './mapChain';
import { dedupeCandidates, mapChain } from './mapChain';
import { scanLine, splitArgs, normKey, unquoteLiteral } from './scan';

/** 顶层关键字实参（`name="登录"`）：返回 `{ kw, pos }` */
function readArgs(argsRaw: string): { kw: Record<string, string>; pos: string[] } {
  const kw: Record<string, string> = {};
  const pos: string[] = [];
  for (const part of splitArgs(argsRaw)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(part.trim());
    if (m) {
      kw[normKey(m[1])] = m[2].trim();
      continue;
    }
    pos.push(part.trim());
  }
  return { kw, pos };
}

/**
 * 一行 → 段落数组；`null` = 这行不是 `page*.` 定位行。
 *
 * 语义上"是定位行但参数不是字面量"（f-string / 变量）**不返回 null**：段落的 `locatorArg`
 * 留空，由 `mapChain` 判 null → 计入 `skippedLines`（[A1-8] (5) 的不静默口径）。
 */
export function pythonSegmentsOfLine(line: string): ParsedSegment[] | null {
  const scanned = scanLine(line);
  if (!scanned) return null;
  const segments: ParsedSegment[] = [];
  for (const call of scanned.calls) {
    const { kw, pos } = readArgs(call.argsRaw);
    const seg: ParsedSegment = { method: call.camel };
    const first = pos.length ? unquoteLiteral(pos[0]) : null;
    if (call.camel === 'filter') {
      const hasText = kw.hastext === undefined ? null : unquoteLiteral(kw.hastext);
      seg.locatorArg = hasText ?? undefined;
    } else if (call.camel === 'nth') {
      seg.locatorArg = pos.length ? String(unquoteLiteral(pos[0]) ?? pos[0]).trim() : undefined;
    } else if (call.camel === 'first' || call.camel === 'last') {
      seg.locatorArg = undefined;
    } else {
      seg.locatorArg = first ?? undefined;
      if (call.camel === 'getByRole' && kw.name !== undefined) {
        seg.roleName = unquoteLiteral(kw.name) ?? undefined;
      }
      if (kw.exact !== undefined) seg.exact = /^(true|True)$/.test(kw.exact.trim());
      const extra = Object.keys(kw).filter((k) => k !== 'name' && k !== 'exact' && k !== 'hastext');
      if (extra.length) seg.extraOptions = true;
    }
    segments.push(seg);
  }
  return segments;
}

/** 整段 Python 文本 → 候选（供三 Target 矩阵单测直接调用） */
export function parsePython(text: string): ElementPasteCandidate[] {
  const out: ElementPasteCandidate[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const segments = pythonSegmentsOfLine(line);
    if (!segments) continue;
    const candidate = mapChain({ target: 'python', segments }, { source: 'playwright-js' });
    if (candidate) out.push(candidate);
  }
  return dedupeCandidates(out);
}
