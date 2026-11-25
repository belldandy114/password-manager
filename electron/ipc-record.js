'use strict';

/**
 * ipc-record.js —— 录制域的 IPC 面：**5 条 invoke + 1 条推送**（契约 `[C-114]`）。
 *
 * 这一层只做三件事，**不含业务**：
 *   1. `pw()` 前置检查（未解锁一律回 `未解锁`，与 `electron/ipc-api.js:187/195` 同串）；
 *   2. 把会话层的返回值包成 `[C-01]` envelope `{ success, data?, error? }`；
 *   3. 推送桥：会话层把事件交给 `recordEventSender(getWindow)`，这里只负责 `webContents.send`。
 *
 * 错误文案是**固定中文串**（`[C-02]`：错误码只许相等/含关键词匹配，本项目没有数字错误码），
 * 唯一真源是契约 §9.2 的通道表——改文案必须两处同改。
 *
 * 校验位置（`[C-114]` 校验真源条）：URL / flag 真源在 `electron/record-args.js`，
 * `selector` 形状真源在 `electron/record-session.js` 的 `checkValidateItems`；本层**不得扩规则**。
 *
 * @module electron/ipc-record
 */

// `ipcMain` 用**惰性 require**：单测可以注入替身（`registerRecordIpc({ ipcMain })`）而不用去 mock electron；
// 生产不传时行为不变（拿真的 `electron.ipcMain`）。
const resolveIpcMain = (deps) => (deps && deps.ipcMain) || require('electron').ipcMain;

/**
 * 不可预期错误的**场景化**文案（R3-03）。
 *
 * 旧实现有一句 `INTERNAL_ERROR = '操作失败'` 被 6 处 catch 复用 —— 既撞 `[C-04]:26` 的明文禁令
 * （「禁止『操作失败』这类笼统文案」），也让用户看不出该修什么。这里按**通道**给具体原因：
 * 每个 catch 都能单独定位，且都不会把底层异常吞掉（一律 `console.error` 落到 app.log）。
 *
 * ⚠️ 这 4 条串**不在契约 §9.2 的通道表里**，已报队长由 t37（契约 v23）补表；
 * `record:start` 的 catch 复用表里已有的 `启动失败`，语义完全对得上。
 */
const ERR_PROBE = '能力探测失败';
const ERR_STOP = '停止录制失败';
const ERR_VALIDATE = '校验请求失败';
const ERR_STATUS = '读取录制状态失败';
/** 推送通道名（与 preload 的 `onRecordEvent`、types.ts 的声明逐字一致） */
const EVENT_CHANNEL = 'record:event';

/**
 * 把会话层的一批事件推给渲染层。
 *
 * ⚠️ 载荷**只透传** `sessionId` / `seq` / `action` / `target` / `candidates` / `ms`（+ 契约 §9.1 允许的
 * `valueMeta` 两种形状），其余键一律丢弃——`[C-117]` 第 5 条「不再加任何自由字段」。
 *
 * @param {() => any} getWindow 返回 BrowserWindow 的 getter（传值会拿到建会话那一刻的 null）
 * @returns {(events: Array<Record<string, unknown>>) => void}
 */
function recordEventSender(getWindow) {
  const ALLOWED = ['sessionId', 'seq', 'action', 'target', 'candidates', 'ms', 'valueMeta'];
  return (events) => {
    let win = null;
    try { win = getWindow && getWindow(); } catch { win = null; }
    if (!win || !win.webContents) return;
    for (const event of Array.isArray(events) ? events : []) {
      if (!event || typeof event !== 'object') continue;
      const payload = {};
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(event, key)) payload[key] = event[key];
      }
      // 明文值永远不许出主进程（`[C-119]`：载荷出现 value 键即结构性违规）
      if (Object.prototype.hasOwnProperty.call(payload, 'value')) continue;
      try { win.webContents.send(EVENT_CHANNEL, payload); } catch { /* 窗口已关 */ }
    }
  };
}

/**
 * 注册录制域 IPC。
 *
 * @param {{
 *   recordSession: { start: Function, stop: Function, status: Function, validate: Function, probe: Function },
 *   getPassword: () => string|null,
 * }} deps 会话管理器与密码 getter（**getter**，不能传值）
 */
function registerRecordIpc(deps) {
  const { recordSession, getPassword } = deps;
  const ipcMain = resolveIpcMain(deps);
  const pw = () => getPassword();

  const ok = (data) => ({ success: true, data });
  const fail = (error, data) => (data === undefined ? { success: false, error } : { success: false, error, data });

  ipcMain.handle('record:probe', async (_event, input) => {
    if (!pw()) return fail('未解锁');
    try {
      const workspaceDir = input && typeof input.workspaceDir === 'string' ? input.workspaceDir : '';
      return ok(recordSession.probe({ workspaceDir, force: !!(input && input.force) }));
    } catch (e) {
      // 不吞异常：底层原因进 app.log（用户看的是场景化文案，排障看的是这一行）
      console.error('[record:probe] 能力探测抛错：', e);
      return fail(ERR_PROBE);
    }
  });

  ipcMain.handle('record:start', async (_event, input) => {
    if (!pw()) return fail('未解锁');
    try {
      const result = await recordSession.start({ url: input && input.url, pageId: input && input.pageId });
      // 会话层的可预期错误一律带 error；兜底文案与 catch 同串（`启动失败` 在契约表里）
      return result.ok ? ok(result.data) : fail(result.error || '启动失败', result.data);
    } catch (e) {
      console.error('[record:start] 启动抛错：', e);
      return fail('启动失败');
    }
  });

  ipcMain.handle('record:stop', async (_event, input) => {
    if (!pw()) return fail('未解锁');
    try {
      const result = await recordSession.stop({ sessionId: input && input.sessionId });
      return result.ok ? ok(result.data) : fail(result.error || ERR_STOP);
    } catch (e) {
      console.error('[record:stop] 停止抛错：', e);
      return fail(ERR_STOP);
    }
  });

  ipcMain.handle('record:validate', async (_event, input) => {
    if (!pw()) return fail('未解锁');
    try {
      const result = await recordSession.validate({ sessionId: input && input.sessionId, items: input && input.items });
      return result.ok ? ok(result.data) : fail(result.error || ERR_VALIDATE);
    } catch (e) {
      console.error('[record:validate] 校验抛错：', e);
      return fail(ERR_VALIDATE);
    }
  });

  // 只读、幂等、无副作用：无活会话时 data 为 null（渲染层刷新/重挂后的态复原）
  ipcMain.handle('record:status', async () => {
    if (!pw()) return fail('未解锁');
    try {
      return ok(recordSession.status());
    } catch (e) {
      console.error('[record:status] 读取状态抛错：', e);
      return fail(ERR_STATUS);
    }
  });
}

module.exports = { registerRecordIpc, recordEventSender, EVENT_CHANNEL, ERR_PROBE, ERR_STOP, ERR_VALIDATE, ERR_STATUS };
