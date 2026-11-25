'use strict';

/**
 * which.js —— 「找一个可用的命令行程序」的**共用实现**（唯一一份定义）。
 *
 * 来源：`electron/ipc-codelab.js:31-40` 的那段 `which()`，行为逐字保持不变
 * （`where` / `which` → 取第一行非空 → 失败回空串、绝不抛）。抽出来是因为录制域的
 * 能力探针也要用，而**探针绝不许拿 `process.execPath` 冒充**「用户 PATH 上的 node」
 * （`electron/ipc-codelab.js:43` 就是这么判绿的：Electron 自带 Node ⇒ 用户没装 Node 也绿）。
 *
 * deps 只用于单测：`{ platform, execFileSync }`，不传时用真实运行时，行为与 codelab 段一致。
 * `electron/ipc-codelab.js` 里那份副本**本批不动**（不在 S2 的 inScope），由 S3 接线时改成
 * `require('./which')`。
 *
 * @module electron/which
 */

/**
 * 找一个可用的命令行程序。
 * @param {string} name 程序名（如 `node` / `javac`）
 * @param {{platform?: string, execFileSync?: Function}} [deps] 仅单测注入
 * @returns {string} 绝对路径；找不到返回空串
 */
function which(name, deps = {}) {
  const execFileSync = deps.execFileSync || require('child_process').execFileSync;
  const platform = deps.platform || process.platform;
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || '';
  } catch {
    return '';
  }
}

module.exports = { which };
