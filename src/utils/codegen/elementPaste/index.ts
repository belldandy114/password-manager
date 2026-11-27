/**
 * 粘贴导入的入口（1.36.0 / B6；A₁ 扩三语法）—— 只做 re-export，让 UI 一处 import 就够
 * （渲染层契约 §6.2：`ElementLibTab` / `PasteImportDialog` 都从 `elementPaste` 取名）。
 */

export type {
  PasteSource, PasteConfidence, PasteTarget, PasteReport, SkippedLine, ElementPasteCandidate,
} from './types';
export {
  PASTE_UNKNOWN_REASON, PASTE_TARGET_LABEL, NAME_HINT_MAX, nameHint,
} from './types';
export {
  detectElementPaste, parseBySource, detectTarget, looksLikePlaywrightScript, type DetectResult,
} from './detect';
export { parseRecorder } from './parseRecorder';
export { parsePlaywright, parsePlaywrightReport } from './parsePlaywright';
export { parsePython } from './parsePython';
export { parseJava } from './parseJava';
export { parseHtml } from './parseHtml';
export { scanLine, splitArgs, camelOf, normKey, unquoteLiteral, targetOfText, type ScannedCall, type ScannedLine } from './scan';
export {
  mapChain, mapCall, parseRoleSpec, cssOrXpath, renderPlaywrightJs,
  isAction, isLocatorMethod, hasLocatorSegment, skipReasonOf, dedupeCandidates, dedupeKey,
  LOCATOR_METHODS, INDEX_METHODS, ACTION_METHODS,
  type ParsedSegment, type ParsedLine, type MapContext,
} from './mapChain';
