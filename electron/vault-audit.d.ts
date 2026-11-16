/** 声明文件：让渲染层单测可以 `import { auditVault } from '../../../electron/vault-audit.js'` */

export declare const REQUIRED_ENTRY_FIELDS: string[];

/** 网址是否「写了协议头但不是 http(s)」—— 只有这种才点不开 */
export declare function badUrl(url: string): boolean;

export interface AuditIssue {
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  count: number;
  samples: string[];
}

export interface AuditReport {
  ok: boolean;
  checkedAt: string;
  schemaVersion: number;
  stats: Record<string, number>;
  counts: { error: number; warn: number; info: number };
  issues: AuditIssue[];
}

export declare function auditVault(
  vault: unknown,
  opts?: {
    /** 附件文件是否存在；不传就跳过「文件丢失」检查 */
    attachmentExists?: (id: string) => boolean;
    /**
     * 附件能否用**当前主密码**解开；不传就跳过「可解密性」检查。
     * 需要与 attachmentExists 一起传，否则分不清「文件丢了」和「文件在但解不开」。
     */
    attachmentDecryptable?: (id: string) => boolean;
    /** 最多抽样解密几个附件（默认 20）；0 = 不抽样 */
    attachmentDecryptSample?: number;
  },
): AuditReport;
