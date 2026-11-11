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
  opts?: { attachmentExists?: (id: string) => boolean },
): AuditReport;
