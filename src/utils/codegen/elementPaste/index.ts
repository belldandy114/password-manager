/**
 * 粘贴导入的入口（1.36.0 / B6）—— 只做 re-export，让 UI 一处 import 就够
 * （渲染层契约 §6.2：`ElementLibTab` / `PasteImportDialog` 都从 `elementPaste` 取名）。
 */

export type { PasteSource, PasteConfidence, ElementPasteCandidate } from './types';
export { PASTE_UNKNOWN_REASON, NAME_HINT_MAX, nameHint } from './types';
export { detectElementPaste, parseBySource, type DetectResult } from './detect';
export { parseRecorder } from './parseRecorder';
export { parsePlaywright } from './parsePlaywright';
export { parseHtml } from './parseHtml';
