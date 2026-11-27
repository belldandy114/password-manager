'use strict';

/**
 * 卸载入口 IPC（`app:uninstall-info` / `app:uninstall`）—— 契约 §3 / §6.1（S1）。
 *
 * 为什么单独一个模块：这是**唯一**会删用户数据、还会 spawn 外部进程的域，
 * 判定逻辑（mode 矩阵 / 卸载器发现 / 受管清单 / dataDirAck / 体积统计）全部下沉到
 * 纯函数 `electron/uninstall.js`（D7），这里只做「校验 → 调用 → 组装信封」。
 *
 * 信封唯一（§0.1.1）：一律 `{ success, data?, error?, code? }`；
 * 错误码只用附录 A 的枚举（locked / info-failed / invalid-argument / busy /
 * ack-mismatch / no-uninstaller / spawn-failed / delete-failed / internal），不自造。
 *
 * §3.6 的两条纪律在这里落地：
 *   - **不** `app.quit()` / `app.exit()`（抢先退出会让卸载器拿不到锁）；
 *   - 卸载流程**不写盘**：不调 settingsSave / saveVault / **appendAudit**，只写应用日志
 *     （`console.log` 在 main.js `installFileLogging()` 之后会落到 `<DATA_DIR>/logs/app.log`）。
 *     `appendAudit` 仍按契约 §6.2 注入，但**故意不调用** —— 写它等于在卸载中途制造新文件。
 */

const { spawn } = require('child_process');
const { app, ipcMain } = require('electron');
const uninstall = require('./uninstall');

/** 真实 io（单测/回归要换替身请直接测 `electron/uninstall.js` 的纯函数） */
const io = uninstall.defaultIo();

/**
 * 进程内并发守卫（§3.3）：`spawn` 无幂等，第二次调用直接 `busy`。
 * spawn 成功后**保持 true 直到应用退出**，防止卸载器已起来时被二次点击再 spawn 一个。
 */
let uninstallInFlight = false;

/**
 * @param {object} deps
 * @param {string} deps.DATA_DIR  已 `resolveDataDir()` 的数据目录（绝对路径）
 * @param {string} deps.USER_DATA_DIR 默认数据目录（`app.getPath('userData')`）；卸载**不**碰它 ——
 *   自定义数据目录场景下它可能仍有一份旧库，但那是 `data:migrate` / `data:reset-location` 的职责，
 *   卸载只按受管清单删当前 `DATA_DIR`（§3.6.5）
 * @param {string} deps.DEFAULT_ATTACH_DIR 默认附件目录（自定义附件目录不在删除范围，§3.6.5）
 * @param {() => boolean} deps.getUnlocked 主进程视角的解锁状态
 * @param {() => string|null} deps.getPassword 会话主密码（只为「双重确认已解锁」，不外传）
 * @param {(entry: object) => void} deps.appendAudit 按契约注入但卸载流程不调用（见文件头）
 */
function registerUninstallIpc(deps) {
  const {
    DATA_DIR,
    USER_DATA_DIR,
    DEFAULT_ATTACH_DIR,
    getUnlocked,
    getPassword,
    appendAudit,
  } = deps;

  /** 危险区不允许锁屏态被本地其它进程驱动：两个来源都要为真（§3.2 / §3.3 硬闸门） */
  const isUnlocked = () => {
    try {
      return !!getUnlocked() && !!getPassword();
    } catch {
      return false;
    }
  };

  /** 组装 `UninstallInfo`（§3.1）。正常降级都写进 data 字段，不抛。 */
  function buildInfo() {
    const mode = uninstall.uninstallMode(app.isPackaged);
    const found = uninstall.findUninstaller({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      productName: uninstall.UNINSTALL_PRODUCT_NAME,
      io,
    });
    const sizeInfo = uninstall.dataSizeOf(DATA_DIR, { io });
    const info = {
      supported: mode === 'installed' && !!found.path,
      mode,
      uninstaller: found.path,
      uninstallerSource: found.source,
      regKey: found.regKey,
      dataDir: DATA_DIR,
      dataSize: sizeInfo.size,
      dataBreakdown: sizeInfo.breakdown,
      productName: uninstall.UNINSTALL_PRODUCT_NAME,
      appVersion: app.getVersion(),
      exePath: process.execPath,
    };
    if (sizeInfo.error) info.dataSizeError = sizeInfo.error;
    return info;
  }

  // ---- 卸载信息（纯读）----
  ipcMain.handle('app:uninstall-info', () => {
    try {
      if (!isUnlocked()) return { success: false, code: 'locked', error: '请先解锁应用' };
      return { success: true, data: buildInfo() };
    } catch (e) {
      console.warn('[uninstall] 读取卸载信息失败：' + ((e && e.message) || e));
      return { success: false, code: 'info-failed', error: `读取卸载信息失败：${(e && e.message) || '未知错误'}` };
    }
  });

  // ---- 执行卸载（不幂等，有副作用）----
  ipcMain.handle('app:uninstall', (_event, payload) => {
    try {
      if (!isUnlocked()) return { success: false, code: 'locked', error: '请先解锁应用' };

      const data = payload && typeof payload === 'object' ? payload : {};
      // `'true'` 字符串一律视为非法：布尔强转会让 UI 的 bug 变成「真删了数据」
      if (typeof data.removeData !== 'boolean') {
        return { success: false, code: 'invalid-argument', error: '参数不合法：removeData 必须是布尔值' };
      }
      if (uninstallInFlight) return { success: false, code: 'busy', error: '卸载已在进行中' };

      // 删数据的硬闸门：渲染层必须把 app:uninstall-info 回显的那串绝对路径原样传回
      if (data.removeData && !uninstall.isDataDirAck(data.dataDirAck, DATA_DIR)) {
        return { success: false, code: 'ack-mismatch', error: '数据目录已变化，请重新确认' };
      }

      const mode = uninstall.uninstallMode(app.isPackaged);
      const dataSizeBefore = uninstall.dataSizeOf(DATA_DIR, { io }).size;

      let removedPaths = [];
      let removeError = null;
      if (data.removeData) {
        // §3.6.5：自定义附件目录在数据目录之外时**不在**删除范围，这里显式记一条日志
        try {
          if (DEFAULT_ATTACH_DIR && !uninstall.isInside(DATA_DIR, DEFAULT_ATTACH_DIR)) {
            console.log('[uninstall] 自定义附件目录不在数据目录内，不删除：' + DEFAULT_ATTACH_DIR);
          }
        } catch { /* 路径比较失败不影响删除 */ }
        const r = uninstall.removeManagedData({ dataDir: DATA_DIR, io, log: console.log });
        removedPaths = r.removedPaths;
        removeError = r.error;
      }

      const base = {
        mode,
        dataDir: DATA_DIR,
        dataSizeBefore,
        removedPaths,
      };

      if (removeError) {
        const res = Object.assign({}, base, {
          launched: false,
          removedData: false,
          code: 'delete-failed',
          error: `删除数据失败：${removeError}`,
        });
        return { success: false, code: 'delete-failed', error: res.error, data: res };
      }

      // 分支②③ 共用：没有可 spawn 的卸载器（dev 一律不 spawn，§3.4）
      if (mode === 'dev') {
        return {
          success: true,
          data: Object.assign({}, base, {
            launched: false,
            removedData: !!data.removeData,
            message: '当前为源码运行，未执行卸载；源码目录请自行删除',
          }),
        };
      }

      const found = uninstall.findUninstaller({
        isPackaged: true,
        execPath: process.execPath,
        productName: uninstall.UNINSTALL_PRODUCT_NAME,
        io,
      });

      if (!found.path) {
        return {
          success: true,
          data: Object.assign({}, base, {
            launched: false,
            removedData: !!data.removeData,
            code: 'no-uninstaller',
            message: data.removeData
              ? '未找到卸载程序，请到「设置 → 应用」里卸载；本地数据已按选择处理'
              : '未找到卸载程序，请到「设置 → 应用」里卸载',
          }),
        };
      }

      try {
        // 参数一律数组传参、**不带** shell:true（§3.4 / §3.6.3，防路径注入）
        const child = spawn(found.path, [], { detached: true, stdio: 'ignore' });
        child.on('error', (e) => console.warn('[uninstall] 卸载器进程错误：' + ((e && e.message) || e)));
        child.unref();
        // spawn 已成功 → 守卫保持 true 直到应用退出，二次点击直接走 busy
        uninstallInFlight = true;
        console.log(`[uninstall] 已启动卸载器（${found.source}）：${found.path}`);
        return {
          success: true,
          data: Object.assign({}, base, {
            launched: true,
            removedData: !!data.removeData,
            message: '卸载程序已启动，请按提示完成卸载',
          }),
        };
      } catch (e) {
        const msg = `启动卸载程序失败：${(e && e.message) || '未知错误'}`;
        console.warn('[uninstall] ' + msg);
        const res = Object.assign({}, base, { launched: false, removedData: !!data.removeData, code: 'spawn-failed', error: msg });
        return { success: false, code: 'spawn-failed', error: msg, data: res };
      }
    } catch (e) {
      console.warn('[uninstall] app:uninstall 未预期异常：' + ((e && e.stack) || e));
      return { success: false, code: 'internal', error: '操作失败，请重试' };
    }
  });
}

module.exports = { registerUninstallIpc };
