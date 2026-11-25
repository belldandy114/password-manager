/**
 * 声明文件：让渲染层单测可以 import `electron/ipc-record.js`（契约 `[C-14]` 的同名 `.d.ts` 约定）。
 *
 * 这一层只做三件事：`pw()` 前置检查、把会话层返回值包成 `[C-01]` envelope、推送桥。
 * **不含业务**，也不扩校验规则（URL / flag 真源在 `record-args.js`，selector 真源在
 * `record-session.js` 的 `validateSelectorItems`）。
 */

/** `record:probe` 的不可预期错误文案（R3-03：场景化，不再用「操作失败」兜底） */
export const ERR_PROBE: string;
/** `record:stop` 的不可预期错误文案 */
export const ERR_STOP: string;
/** `record:validate` 的不可预期错误文案 */
export const ERR_VALIDATE: string;
/** `record:status` 的不可预期错误文案 */
export const ERR_STATUS: string;

/** 推送通道名（与 `preload.js` 的 `onRecordEvent`、`types.ts` 的声明逐字一致） */
export const EVENT_CHANNEL: string;

export type RecordIpcAnswer = { success: true; data?: unknown } | { success: false; error: string; data?: unknown };

/** 会话层最小接口（只用到这 5 个方法） */
export interface RecordSessionLike {
  probe(input: { workspaceDir: string; force: boolean }): unknown;
  start(input: { url?: unknown; pageId?: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  stop(input: { sessionId?: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  validate(input: { sessionId?: unknown; items?: unknown }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  status(): unknown;
}

export interface RecordIpcDeps {
  recordSession: RecordSessionLike;
  /** 会话密码 getter（**getter**：传值会拿到注册那一刻的 null） */
  getPassword: () => string | null;
  /** 单测注入的 `ipcMain` 替身；生产不传时用 `require('electron').ipcMain` */
  ipcMain?: { handle(channel: string, listener: (event: unknown, input?: unknown) => Promise<unknown>): void };
}

/** 注册 5 条 `record:*` invoke（`[C-114]`） */
export declare function registerRecordIpc(deps: RecordIpcDeps): void;

/**
 * 事件推送桥：只透传 `sessionId / seq / action / target / candidates / ms / valueMeta`，
 * 其余键一律丢弃（`[C-117]` 第 5 条）。
 */
export declare function recordEventSender(
  getWindow: () => { webContents?: { send(channel: string, payload: unknown): void } } | null,
): (events: Array<Record<string, unknown>>) => void;
