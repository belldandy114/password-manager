/**
 * 声明文件：让渲染层单测可以 `import { registerEntriesIpc } from './ipc-entries.js'`（契约 `[C-14]` 的同名 `.d.ts` 约定）。
 *
 * 这里只声明**被测试用到的入口**：`registerEntriesIpc(deps)`。
 * deps 的形状以 `ipc-entries.js` 的 JSDoc 为准（几十个注入项，逐个重写一遍只会制造第二份会漂的真源），
 * 因此这里按「任意键 → 具体实现见 .js」声明；需要强类型时请去补 .js 的 JSDoc，而不是抄到 .d.ts。
 */

/** 会话/条目/回收站/剪贴板/设置的 IPC 注册入口（内部用 `deps.ipcMain` 或 `require('electron').ipcMain`） */
export declare function registerEntriesIpc(deps: Record<string, unknown>): void;
