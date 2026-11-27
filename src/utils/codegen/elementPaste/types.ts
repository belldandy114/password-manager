/**
 * 粘贴导入的公共类型（1.36.0 / B6，渲染层契约 §6.2）。
 *
 * 纯类型 + 纯函数模块：**零 IPC、零 window、零 React**。解析器只做「文本 → 候选行」，
 * 写库由调用方走既有的 `cleanPageForWrite` + `trimPagesForWrite` + `ws:set`（§6.2 的唯一写入路径）。
 */

import type { PomLocatorKind } from '../pageobject';

/** 三种可识别的输入格式 */
export type PasteSource = 'recorder-json' | 'playwright-js' | 'html';

/**
 * Playwright codegen 的 Target（契约 [A1-8]，`[Z-3]` 裁定）：**输入侧**三语法兼容。
 *
 * - 这是**只读回显**字段：只用来在预览表里标「这行是 Python 写法」，**不进 `pomPages`**；
 * - 界面**不得**因为它在任何地方长出语种选择控件（`[N-4]` 的判据）；
 * - `PasteSource` 的取值**零改动**（`'playwright-js'` 现在语义是「Playwright codegen 脚本，
 *   任意 Target」）；改字面量要动 3 个测试 + 弹窗，收益为零。
 */
export type PasteTarget = 'js' | 'python' | 'java';

/** Target 的展示名（只读文本，不是选项） */
export const PASTE_TARGET_LABEL: Record<PasteTarget, string> = {
  js: 'JS',
  python: 'Python',
  java: 'Java',
};

/** 每行的把握程度：
 * - `exact`：定位器唯一或语义明确（`#id` / `[aria-label]` / `getByRole(name)` / `getByText`）；
 * - `guess`：能生成但可能失配（结构性 css、`filter()` / `nth()` 链、只有 class 的 HTML）；
 * - `unknown`：连标签都没解析出来（`locator: ''`，默认不勾选）。
 */
export type PasteConfidence = 'exact' | 'guess' | 'unknown';

/** 一条可导入的候选元素（与 `PomElementRow` 的字段一一对应，外加「凭哪条特征认出来的」） */
export interface ElementPasteCandidate {
  /** 建议的元素名（用户可在预览表里改） */
  name: string;
  locator: string;
  kind: PomLocatorKind;
  /** `kind='role'` 时的可访问名 */
  role?: string;
  confidence: PasteConfidence;
  /** 一句人话：为什么判成这个把握度（预览表里单独一列，不折叠） */
  reason: string;
  source: PasteSource;
  /** 这行是哪种 codegen Target 的写法（只读回显；非 codegen 格式时没有该字段） */
  target?: PasteTarget;
}

/** 整段输入认不出来时的固定文案（逐字定稿，见渲染层契约 §6.2） */
export const PASTE_UNKNOWN_REASON = '无法识别：支持 DevTools Recorder 导出的 JSON / Playwright codegen 脚本 / Elements 复制的 HTML';

/** 元素名建议的统一截断（预览表里一行能放下） */
export const NAME_HINT_MAX = 30;

/**
 * 一条「认不出」的行（review-code：不许静默消失，必须能对用户说清楚为什么）。
 *
 * `reason` 一律非空，由 `mapChain.skipReasonOf()` 统一产出；`text` 截断到 160 字只为回显。
 */
export interface SkippedLine {
  /** 1-based 行号（多行文本里的位置，便于用户在粘贴框里找） */
  line: number;
  /** 该行原文（≤160 字） */
  text: string;
  /** 为什么认不出（逐字给用户看） */
  reason: string;
}

/**
 * 一次解析的结果（契约 [A1-8] (5)「不静默」）。
 *
 * `skippedLines` = **看起来是定位行、但这一行认不出**的行（f-string / 变量插值 / 未知方法 /
 * 括号或引号没闭合 / 三语法都不匹配），每条带行号、原文与原因。
 * 纯动作行与非定位行**不计入**——它们是「预期忽略」，不是「没认出来」。
 * 界面上必须显示「N 行未识别」并能展开看原因，不许把「N 行没认出来」演成「成功导入 0 条」。
 */
export interface PasteReport {
  candidates: ElementPasteCandidate[];
  /** 认不出被跳过的行（只读回显，不进库）；`.length` 就是界面上的「N 行未识别」 */
  skippedLines: SkippedLine[];
}

/** 取一段人话作名字：合并空白 + 截断 */
export function nameHint(raw: string, fallback = '未命名元素'): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  return s.length > NAME_HINT_MAX ? `${s.slice(0, NAME_HINT_MAX)}…` : s;
}
