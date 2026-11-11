'use strict';

/**
 * 「打开网址之后，把浏览器窗口叫到前台」。
 *
 * 为什么需要这一步（2026-11-11 实测）：
 * Windows 有前台锁（foreground lock）——**不是当前前台的进程，调 SetForegroundWindow 会被忽略**。
 * 我们的地址是交给 rundll32 / 一个临时的 chrome.exe 进程转交的，那个子进程不在前台，
 * 于是 Chrome 把标签页**开在后台**：请求确实发出去了（本地服务器收到了），但浏览器窗口不上浮，
 * 用户看到的就是「点了没反应」。用本地 HTTP 服务器 + 窗口枚举验证过：
 * 页面请求到达 Chrome，Chrome 窗口却始终留在 WorkBuddy/微信 后面。
 *
 * 纯 Node 没有 Win32 调用能力，这里用**最轻的一条系统命令**：hidden 的 powershell 里
 * 用 WScript.Shell.AppActivate(pid) 激活「最近启动且有主窗口」的浏览器进程。
 * - 不用 Add-Type：不会编译加载 .NET 代码（这也是安全策略最容易拦的一步）；
 * - 全程 windowsHide + detached，不闪黑框，也不阻塞打开动作；
 * - 任何失败都吞掉——它只是「顺手把窗口提到前面」，不能影响主流程。
 */

const { spawn } = require('child_process');

const PS_ACTIVATE = [
  "$ErrorActionPreference='SilentlyContinue'",
  // 优先找最近 8 秒内新启动、带主窗口的浏览器（就是刚才被叫起来那个）
  '$since = (Get-Date).AddSeconds(-8)',
  "$p = Get-Process chrome,msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -gt $since } | Sort-Object StartTime -Descending | Select-Object -First 1",
  // 没有新进程（交接给已有实例）就退而求其次：取最新启动的浏览器窗口
  "if (-not $p) { $p = Get-Process chrome,msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1 }",
  "if ($p) { $sh = New-Object -ComObject WScript.Shell; $null = $sh.AppActivate($p.Id) }",
].join('; ');

/**
 * 尽力把浏览器窗口提到前台。失败无所谓，不要 await（打开动作不该等它）。
 *
 * @param {{ spawn?: Function, platform?: string, delay?: number }} [deps]
 */
function focusBrowser(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return;
  const run = deps.spawn || spawn;
  const delay = typeof deps.delay === 'number' ? deps.delay : 450;

  const timer = setTimeout(() => {
    try {
      const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PS_ACTIVATE], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      if (child && typeof child.on === 'function') child.on('error', () => { /* 忽略 */ });
      if (child && typeof child.unref === 'function') child.unref();
    } catch {
      /* 忽略：只是锦上添花 */
    }
  }, delay);
  // 别让这个定时器拖住进程退出
  if (timer && typeof timer.unref === 'function') timer.unref();
}

module.exports = { focusBrowser, PS_ACTIVATE };
