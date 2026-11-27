/**
 * 声明文件：让渲染层单测可以 import electron/autologin.js
 *
 * 该 .js 是**纯函数模块**（不 `require('electron')`，见契约 D7），所以这里只写签名，
 * 不引 `@types/node`（`tsconfig.json` 是 `types: []`）。导出的 12 个值逐个对应
 * `Object.keys(require('./autologin.js'))`，不多不少。
 */

/** reasonCode 全集（= `REASON_TEXT` 的 8 个键，契约 §2.2 / §2.5 / 附录 A 的 9~14） */
export type AutoUnlockReasonCode =
  | 'safe-storage-unavailable'
  | 'autologin-corrupt'
  | 'autologin-version-unsupported'
  | 'not-setup'
  | 'no-credential'
  | 'session-locked'
  | 'decrypt-failed'
  | 'vault-corrupt';

/** `parseAutologin()` 成功分支：可解出 blob（**仍未解密**） */
export interface AutologinParseOk {
  ok: true;
  enabled: true;
  /** `safeStorage` 密文的 base64（明文永不在此出现） */
  blob: string;
  /** 文件里的 `updatedAt`；缺失时为空串 */
  updatedAt: string;
  /** 恒为 `AUTOLOGIN_VERSION` */
  version: number;
}

/** `parseAutologin()` 失败分支（区分「损坏」与「版本不认识」两种处置） */
export interface AutologinParseFail {
  ok: false;
  enabled: false;
  reasonCode: AutoUnlockReasonCode;
  reason: string;
}

export type AutologinParseResult = AutologinParseOk | AutologinParseFail;

/** `buildAutoUnlockStatus()` 的返回（契约 §2.2 的 `AutoUnlockStatus`，键全可选） */
export interface AutoUnlockStatusResult {
  enabled: boolean;
  available: boolean;
  reasonCode?: AutoUnlockReasonCode;
  reason?: string;
  updatedAt?: string;
}

/** `isAutoUnlockUsable()` 入参 */
export interface AutoUnlockUsableInput {
  available?: boolean;
  suppressed?: boolean;
}

/** `buildAutoUnlockStatus()` 入参（调用方注入，便于单测） */
export interface AutoUnlockStatusInput {
  exists?: boolean;
  raw?: string | null;
  available?: boolean;
}

/** 落盘格式版本号；读到其它值 → `autologin-version-unsupported`（不删） */
export declare const AUTOLOGIN_VERSION: number;
/** 落盘文件名（与 `vault.enc` 同目录） */
export declare const AUTOLOGIN_FILE_NAME: string;
/** 本文件负责的 4 个 reasonCode（其余由 handler 侧的会话状态决定） */
export declare const AUTOLOGIN_REASON_CODES: string[];
/** `blob` 体积上限 64 KB */
export declare const MAX_BLOB_BYTES: number;
/** reasonCode → 中文人话 */
export declare const REASON_TEXT: Record<string, string>;

/** reasonCode → 中文人话；未知 code 返回空串 */
export declare function reasonText(code: string): string;
/** `<dataDir>/autologin.json` 的绝对路径 */
export declare function autologinPath(dataDir: string): string;
/** 是否「像一个 base64 密文」（不真正解码） */
export declare function isBlobLike(s: unknown): boolean;
/** 解析 autologin.json 的**文本内容**（纯字符串处理，不读盘） */
export declare function parseAutologin(raw: unknown): AutologinParseResult;
/** 生成落盘文本；blob 非法/超限时 **throw** */
export declare function serializeAutologin(blobBase64: string, nowISO?: string): string;
/** 本次进程内能否尝试自动解锁：`available && !suppressed` */
export declare function isAutoUnlockUsable(state?: AutoUnlockUsableInput): boolean;
/** 状态查询的组装逻辑（**不解密**，任何异常都归成 enabled:false + reasonCode） */
export declare function buildAutoUnlockStatus(input?: AutoUnlockStatusInput): AutoUnlockStatusResult;
