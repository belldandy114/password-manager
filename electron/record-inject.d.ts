/**
 * 声明文件：让渲染层单测可以 import electron/record-inject.js（契约 `[C-14]`）。
 *
 * 三个 `*_FN_SRC` 是**常量函数声明字符串**，送进页面的方式只有一种：
 * `cdp.callWithArgs(INSTALL_FN_SRC, [nonce])` / `cdp.callWithArgs(VALIDATE_FN_SRC, [strategy, selector])`
 * ——参数走 `arguments`，绝不拼字符串。
 */

export const BINDING_PREFIX: string;
export const SESSION_KEY: string;
/** `target.text` 与 text 候选的文本上限（80） */
export const MAX_TEXT: number;
/** 单次事件的候选上限（20） */
export const MAX_CANDIDATES: number;
/** data-testid 候选值上限（SEC-R2-06） */
export const MAX_TESTID_LENGTH: number;
/** role 值上限 */
export const MAX_ROLE_LENGTH: number;
/** tagName 上限 */
export const MAX_TAG_LENGTH: number;
/** 页内源码模板（占位符由 LIMIT_PLACEHOLDERS 替换，上限唯一真源） */
export const PAGE_INSTALL_TEMPLATE: string;
export const LIMIT_PLACEHOLDERS: Record<string, number>;
/** 页内载荷允许的键：action / target / candidates / valueMeta / ms */
export const PAYLOAD_KEYS: string[];
/** 校验策略枚举：css / xpath / text / role */
export const VALIDATE_STRATEGIES: string[];
/** nonce 形状：12 位小写十六进制 */
export const NONCE_PATTERN: RegExp;

/** `function (nonce)`：挂监听、装 `window.__dshRecorder`，幂等 */
export const INSTALL_FN_SRC: string;
/** `function ()`：卸载监听，幂等 */
export const STOP_FN_SRC: string;
/** `function (strategy, selector)`：返回 `{ count, precise, invalid?, error? }` */
export const VALIDATE_FN_SRC: string;

/** 拼 `__dsh_<nonce>`；nonce 形状不对抛 TypeError */
export declare function bindingName(nonce: string): string;

/**
 * 页内异常载荷的**唯一形状**（SEC-R2-05）：只回名字与长度，**不回原文**。
 *
 * 页面里 `throw new Error('token=' + token)` 会把表单值带进 `exception.description`；
 * 一旦进 `errors[]` / `onException` / 审计 / 界面就等于落库。`name` 走白名单正则
 * （非白名单归一成 `'Error'`），`length` 是数字。
 *
 * ⚠️ `electron/cdp-client.js` 目前仍回 160 字原文（**t18 的 owner 面，本片不改**）；
 * t18 接线时把 `errors.push(text)` / `onException(text)` 换成 `sanitizePageException(details)` 即可，
 * 载荷形状以本函数为准：`{ name: string; length: number }`，**不含任何页面文本**。
 */
export declare function sanitizePageException(input: unknown): { name: string; length: number };

