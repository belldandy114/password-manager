'use strict';

/**
 * ipc-hit.js —— 元素库 A₂「CDP 点验」IPC 域（**1 条通道** el:hit-test，3 个 op；契约 [A2-1]）。
 *
 * 设计参考：1148872017/test-tool（main @ v0.65.0，package.json 声明 MIT，作者已授权，2026-11-27 留痕）
 *   **只借鉴「一个域一个会话 + 函数式依赖注入」的接线形态**（electron/ipc/ipc-sniff.js 的 register(deps) 骨架）；
 *   通道面、录制器启动器、preload 兼容垫片一律未采用（原因见移植清单 §2.5）。
 * 本项目改造点：
 *   1. 只有 1 条通道 + 3 个 op，四元组 +1（[A2-1]/[A2-15]）；
 *   2. **不**在本域内挂 `before-quit` 自接线（[A2-12] 的退出收尾由注入的 app 触发一次，见下）；
 *   3. 不留 preload 兼容垫片：preload / types / handler / 门 四处同步（[A2-15]）；
 *   4. 本模块不 require main.js 的任何模块级状态（`loadVault` / `appendAudit` / `currentPassword` 全注入）。
 *
 * ⚠️ 只注册通道，不实现业务：会话状态机在 `electron/hit-session.js`，
 * 纯函数与页内脚本在 `electron/hit-args.js`，CDP 连接在 `electron/cdp.js`（[A2-16] 依赖方向）。
 */

const { ipcMain } = require('electron');
const { spawn, spawnSync } = require('child_process');
const hitSession = require('./hit-session');

/**
 * 从 vault 明文里按 pageId + elementId 取元素（[A2-2] 来源一）。
 *
 * 结构真源：`vault.pomPages[]` → `.elements[]`（`src/components/codegen/pomModel.ts` 的 PomPage/PomElementRow）。
 * 取不到回 null —— 由 `validateHitTestArgs` 第 8 步转成固定文案，不在这里编文案。
 */
function findElementInVault(vaultData, pageId, elementId) {
  const pages = vaultData && Array.isArray(vaultData.pomPages) ? vaultData.pomPages : [];
  const page = pages.find((p) => p && p.id === pageId);
  const els = page && Array.isArray(page.elements) ? page.elements : [];
  return els.find((el) => el && el.id === elementId) || null;
}

/**
 * 注册 `el:hit-test`。
 *
 * @param {object} deps 全部由 main.js 注入（本模块不碰 main.js 的模块级变量）
 * @param {object} [deps.app] Electron app（只用来挂 will-quit，[A2-12]）
 * @param {string} deps.dataDir 数据目录（点验 profile 落在 `<dataDir>/el-hit-profile`）
 * @param {(id: string) => string|null} deps.findBrowser 'chrome'|'msedge' → exe 绝对路径（复用 ipc-browser 的路径表）
 * @param {() => boolean} deps.isUnlocked 密码库是否解锁
 * @param {() => string|null} deps.getPassword 当前会话密码（未解锁为 null）
 * @param {(password: string) => object} deps.readVault 读 vault 明文（只读，不写盘）
 * @param {(entry: object) => void} deps.audit 审计写入（[A2-13]：恰好 8 个键）
 * @param {(msg: string) => void} [deps.log] 日志（只打结构化键，不打页面文本）
 */
function registerHitIpc(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  hitSession.configure({
    dataDir: String(d.dataDir || ''),
    findBrowser: typeof d.findBrowser === 'function' ? d.findBrowser : () => '',
    // B-1（QA t15 blocker）：这里原来没注入 spawn / spawnSync，而 hit-session 的默认值是 null，
    // 于是生产路径 `startSession` 立刻回「浏览器没能启动」、`verifyProcess` 回「没有可用的进程查询能力」——
    // 点验通道**恒失败**，单测却全绿（单测自己注入了假 spawn）。两个都必须在这里给真实现。
    // 不放在 hit-session 顶层 require：那一层要被 vitest 直接引用，注入面越窄越好测。
    spawn,
    spawnSync,
    log: typeof d.log === 'function' ? d.log : (msg) => console.log(msg),
    audit: typeof d.audit === 'function' ? d.audit : () => {},
    isUnlocked: () => (typeof d.isUnlocked === 'function' ? d.isUnlocked() === true : false),
    findElement: (pageId, elementId) => {
      if (typeof d.readVault !== 'function' || typeof d.getPassword !== 'function') return null;
      const password = d.getPassword();
      if (password === null || password === undefined) return null;
      return findElementInVault(d.readVault(password), pageId, elementId);
    },
  });

  // ---------------- el:hit-test（唯一通道；op 缺省 verify） ----------------
  ipcMain.handle('el:hit-test', async (_event, input) => {
    try {
      return await hitSession.handle(input);
    } catch (e) {
      // 可预期错误已经在 hit-session 里转成 { success:false, error, code }；
      // 走到这里是**不可预期**的异常：转成固定文案 + 留可排查日志（不吞、不把栈丢给界面）
      try {
        d.log('[hit] 未捕获异常：' + String((e && e.stack) || e));
      } catch {
        /* 日志自己失败不影响回执 */
      }
      return { success: false, error: '点验通道内部错误（详情见应用日志）', code: 'internal' };
    }
  });

  // ---------------- 退出即关（[A2-12]：不许留无人值守的 CDP 端口） ----------------
  if (d.app && typeof d.app.on === 'function') {
    d.app.on('will-quit', () => {
      try {
        hitSession.stopSessionSync('quit');
      } catch (e) {
        // 退出路径上不能再抛
        try {
          d.log('[hit] 退出收尾异常：' + String((e && e.message) || e));
        } catch {
          /* ignore */
        }
      }
    });
  }
}

/**
 * 密码库锁定时的收尾（[A2-12]：`clearCaches()` 之前调用）。
 *
 * 为什么锁定也要关：`clearCaches()` 之后主进程已经拿不到 vault 明文，
 * 那个还活着的浏览器只剩「一个带页面登录态、对本机开放的调试端口」—— 收益 0、风险不为 0。
 * 异步 best-effort（带 2s 上限，不阻塞锁定）。
 */
function stopHitSessionForLock() {
  try {
    const p = hitSession.stopSession('lock');
    const timer = setTimeout(() => {
      /* 超时不阻塞锁定流程，会话已从单例摘除 */
    }, 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 锁定路径不许抛 */
  }
}

module.exports = { registerHitIpc, stopHitSessionForLock, findElementInVault };
