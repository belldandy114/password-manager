'use strict';

/**
 * app.js —— 启动被测 Electron 应用 + 过首次引导 + 登录 + 预置数据（scripts/ui-*.js 公共库）
 *
 * 抽取动机：ui-*.js 里「spawn 应用 → 等 CDP 端口 → 连窗口 → 首次设置主密码 → 解锁 → 关掉引导弹窗
 * → 预置一张背景图」每份 40~70 行几乎一致，两条启动路径（开发目录 / 打包版）也各写各的。
 * 这里维护一份：
 *   - launch()          启动应用（开发目录用 node_modules/electron + `.`；USE_PACKED=1 用 release/win-unpacked）
 *   - waitForWindow()   等窗口出现并连上 CDP（返回 lib/cdp.js 的会话）
 *   - ensureUnlocked()  首次引导设主密码 / 已有库解锁，二选一自动判
 *   - dismissOnboarding()  关掉「稍后再说」这类引导弹窗
 *   - prepareDataDir()  建隔离数据目录（可顺便放背景图、写 cases.json）
 *   - applyBackground() 通过 settingsSave 把背景图写进设置（走真实的 bg:get 读取链路）
 *   - navTo() / clickText() / setTheme() / waitApp()  页面操作小工具
 *   - stop()            杀进程树
 *
 * 口令一律不写死：默认每次运行随机生成一个满足强度规则（≥8 位、含大小写数字符号）的主密码，
 * 只作用于临时数据目录，跑完即废；需要固定时用环境变量 PM_TEST_PASSWORD。
 * 禅道等**真实账号**不走这里（见 scripts/zt-config.js：ZT_BASEURL / ZT_ACCOUNT / ZT_PASSWORD）。
 *
 * @module scripts/lib/app
 */

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cdp = require('./cdp');
const { pickExe } = require('../pick-exe');

/** 仓库根目录 */
const ROOT = path.resolve(__dirname, '..', '..');
/** 默认超时（毫秒） */
const DEFAULT_TIMEOUT = 20000;

/**
 * 测试用主密码：仓库里不留任何口令字面量。
 * 默认每次运行随机生成（Pm# + 16 位 hex + 大写和数字，满足「大小写+数字+符号」强度规则）；
 * 需要跨进程复用同一口令时设 PM_TEST_PASSWORD。
 */
const TEST_PASSWORD = (() => {
  const fromEnv = String(process.env.PM_TEST_PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  return 'Pm#' + crypto.randomBytes(8).toString('hex') + 'A1';
})();

/**
 * 取测试主密码（本次运行内恒定）
 * @returns {string} 主密码
 */
function testPassword() {
  return TEST_PASSWORD;
}

/**
 * 建一个临时目录（进程退出后由系统清理；脚本自己也可以 rmSync）
 * @param {string} prefix 目录前缀
 * @returns {string} 绝对路径
 */
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 准备一个隔离的数据目录：可选放背景图、可选写 cases.json（避免回归去碰使用者真实的用例库）。
 * @param {{prefix?: string, casesRoot?: boolean, background?: {srcFile: string, name?: string}}} [opts]
 *   casesRoot: true 时建一个空的用例库目录并写进 cases.json；background: 复制背景图到 <数据目录>/background/
 * @returns {{dataDir: string, backgroundName: string, casesRoot: string}} 数据目录与写入的文件名
 */
function prepareDataDir(opts = {}) {
  const dataDir = mkTempDir(opts.prefix || 'pm-ui-data-');
  let casesRoot = '';
  if (opts.casesRoot) {
    casesRoot = mkTempDir('pm-ui-cases-');
    fs.writeFileSync(path.join(dataDir, 'cases.json'), JSON.stringify({ root: casesRoot }), 'utf8');
  }
  let backgroundName = '';
  if (opts.background && opts.background.srcFile) {
    backgroundName = opts.background.name || 'bg-test.png';
    const dir = path.join(dataDir, 'background');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(opts.background.srcFile, path.join(dir, backgroundName));
  }
  return { dataDir, backgroundName, casesRoot };
}

/**
 * 启动被测应用。
 * @param {{usePacked?: boolean, port?: number, userDataDir?: string, dataDir?: string,
 *          exe?: string, cwd?: string, args?: string[], env?: Record<string, string>, drainOutput?: boolean}} [opts]
 *   usePacked: 默认读环境变量 USE_PACKED=1；true 走 release/win-unpacked，false 走开发目录 + PM_USE_DIST
 *   port: 远程调试端口（默认 9811，多个脚本并行时要各给一个）
 *   dataDir: 隔离数据目录（写成 PM_DATA_DIR）；userDataDir 不传则新建临时目录
 * @returns {Promise<{proc: import('child_process').ChildProcess, port: number, exe: string, cwd: string,
 *          args: string[], userDataDir: string, dataDir: string, usePacked: boolean}>} 应用句柄
 * @throws {Error} exe 不存在时给出「该跑哪条构建命令」的明确提示
 */
async function launch(opts = {}) {
  const usePacked = opts.usePacked === undefined ? process.env.USE_PACKED === '1' : !!opts.usePacked;
  const port = Number(opts.port || 9811);
  const userDataDir = opts.userDataDir || mkTempDir('pm-ui-ud-');
  const dataDir = opts.dataDir || '';
  const appDir = path.join(ROOT, 'release', 'win-unpacked');
  const exe = opts.exe || (usePacked ? pickExe(appDir) : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'));
  const cwd = opts.cwd || (usePacked ? appDir : ROOT);
  const args = opts.args || (usePacked ? [] : ['.']);

  if (!fs.existsSync(exe)) {
    throw new Error(usePacked
      ? `找不到打包版主程序：${exe}（先跑 npm run pack 或 npm run dist）`
      : `找不到 Electron 运行时：${exe}（先跑 npm ci）`);
  }

  const env = { ...process.env, ...(opts.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  // 开发目录路径默认直接加载 dist（不启 vite）；需要跑源码 dev 时显式传 env.PM_USE_DIST='0'
  if (!usePacked && env.PM_USE_DIST === undefined) env.PM_USE_DIST = '1';
  if (dataDir) env.PM_DATA_DIR = dataDir;

  const argv = [...args, '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`];
  const proc = spawn(exe, argv, { env, cwd, windowsHide: true });
  // 不排空管道的话，日志多的脚本会把子进程的 stdout 缓冲塞满卡住（Windows 上 spawn 默认 pipe）
  if (opts.drainOutput !== false) {
    proc.stdout.on('data', () => { /* 丢弃，避免缓冲塞满 */ });
    proc.stderr.on('data', () => { /* 丢弃 GPU/线程噪声 */ });
  }
  return { proc, port, exe, cwd, args: argv, userDataDir, dataDir, usePacked };
}

/**
 * 等窗口出现并连上 CDP。
 * @param {Awaited<ReturnType<typeof launch>>} handle launch() 返回的句柄
 * @param {{match?: (target: object) => boolean, timeout?: number, shotDir?: string}} [opts]
 *   match: 目标过滤（默认第一个非 devtools 的 page；搜索小窗可传 url 含 window=palette）
 * @returns {Promise<object>} lib/cdp.js 的会话对象（ev / waitFor / shot / close）
 * @throws {Error} 超时未出现窗口时抛错，消息里带端口与排查提示
 */
async function waitForWindow(handle, opts = {}) {
  const timeout = opts.timeout || 30000;
  const target = await cdp.waitForTarget(handle.port, opts.match, { timeout });
  if (!target) {
    throw new Error(`等不到应用窗口（port=${handle.port}, ${timeout}ms）：进程可能没起来（再跑一次看退出码），`
      + '或端口被另一个实例占用（换 port）');
  }
  return cdp.attach(target, { shotDir: opts.shotDir });
}

/**
 * 等主界面（.app-layout）出现，即「已解锁」。
 * @param {object} session cdp 会话
 * @param {{timeout?: number}} [opts] 超时（默认 20s；解锁要跑一次 PBKDF2，别设太短）
 * @returns {Promise<boolean>} 成功返回 true，超时抛 CdpTimeoutError
 */
async function waitApp(session, opts = {}) {
  return session.waitFor({ selector: '.app-layout' }, { timeout: opts.timeout || DEFAULT_TIMEOUT });
}

/**
 * 关掉「稍后再说 / 稍后」这类引导弹窗（首次设置后、每次解锁后都可能出现）。
 * @param {object} session cdp 会话
 * @returns {Promise<boolean>} 点到了返回 true；没有弹窗返回 false
 */
async function dismissOnboarding(session) {
  return session.ev(`(() => {
    const m = document.querySelector('.modal');
    if (!m) return false;
    const b = [...m.querySelectorAll('button')].find(x => /稍后/.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  })()`);
}

/**
 * 过登录闸门：首次启动设置主密码、已有密码库则解锁；可选自动关掉引导弹窗。
 * @param {object} session cdp 会话
 * @param {{password?: string, timeout?: number, dismissOnboarding?: boolean}} [opts]
 *   password 默认 testPassword()（随机，或 PM_TEST_PASSWORD）；dismissOnboarding=false 可保留弹窗以便断言
 * @returns {Promise<{isSetup: boolean}>} 本次是「首次设置」还是「解锁已有库」
 */
async function ensureUnlocked(session, opts = {}) {
  const password = opts.password || TEST_PASSWORD;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  await session.waitFor({ expr: `!!document.querySelector('input[type=password], .app-layout')` }, { timeout });

  const isSetup = await session.ev(
    `[...document.querySelectorAll('button')].some(b => /设置主密码/.test(b.textContent || ''))`,
  );
  if (isSetup) {
    await session.ev(`(() => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const ins = [...document.querySelectorAll('input[type=password]')];
      ins.forEach((el) => { d.call(el, ${JSON.stringify(password)}); el.dispatchEvent(new Event('input', { bubbles: true })); });
      const b = [...document.querySelectorAll('button')].find(x => /设置主密码/.test(x.textContent || ''));
      if (b) b.click();
      return ins.length;
    })()`);
  } else {
    await session.ev(`(() => {
      const el = document.querySelector('input[placeholder="输入主密码解锁"]') || document.querySelector('input[type=password]');
      if (!el) return false;
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      d.call(el, ${JSON.stringify(password)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await clickText(session, /解锁|登录/);
  }

  await waitApp(session, { timeout });
  if (opts.dismissOnboarding !== false) await dismissOnboarding(session);
  return { isSetup };
}

/**
 * 把背景图写进设置（图片文件由 prepareDataDir 放到 <数据目录>/background/，这里只落「文件名 + 效果参数」）。
 * @param {object} session cdp 会话
 * @param {{name: string, settings?: object}} opts name: 背景文件名；settings: 其余设置字段（不透明度/模糊/压暗/取色…）
 * @returns {Promise<{success?: boolean, error?: string}>} settingsSave 的返回值
 */
async function applyBackground(session, opts) {
  const payload = { backgroundImage: opts.name, ...(opts.settings || {}) };
  return session.ev(`window.electronAPI.settingsSave(${JSON.stringify(payload)})`);
}

/**
 * 重新加载页面（走 Page.reload，之后调用方自己 waitFor 登录页/主界面）。
 * @param {object} session cdp 会话
 * @param {{timeout?: number, settleMs?: number}} [opts] settleMs: reload 后额外等待的毫秒数（默认 800）
 * @returns {Promise<void>}
 */
async function reloadPage(session, opts = {}) {
  await session.send('Page.reload', {}, { timeout: opts.timeout || DEFAULT_TIMEOUT });
  await cdp.sleep(opts.settleMs === undefined ? 800 : opts.settleMs);
}

/**
 * 点第一个文本匹配的按钮。
 * @param {object} session cdp 会话
 * @param {RegExp|string} text 文本匹配（RegExp 用 .test，字符串用 includes）
 * @param {{root?: string}} [opts] root: 限定搜索范围的选择器（默认全文档 button）
 * @returns {Promise<boolean>} 点到了返回 true
 */
async function clickText(session, text, opts = {}) {
  const matcher = text instanceof RegExp
    ? `(t) => ${text.toString()}.test(t)`
    : `(t) => t.includes(${JSON.stringify(String(text))})`;
  return session.ev(`(() => {
    const root = document.querySelector(${JSON.stringify(opts.root || 'body')}) || document.body;
    const b = [...root.querySelectorAll('button')].find(x => (${matcher})(x.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

/**
 * 点侧栏导航项并等页面渲染完（.page-loading 消失且 .pg 出现）。
 * @param {object} session cdp 会话
 * @param {string} label 导航文字（包含匹配，例如 '设置'）
 * @param {{timeout?: number}} [opts] 超时（默认 15s）
 * @returns {Promise<boolean>} 找到了导航项返回 true
 */
async function navTo(session, label, opts = {}) {
  const clicked = await session.ev(`(() => {
    const n = [...document.querySelectorAll('.nav-item')].find(x => (x.textContent || '').includes(${JSON.stringify(label)}));
    if (!n) return false;
    n.click();
    return true;
  })()`);
  if (!clicked) return false;
  await session.waitFor({ expr: `!document.querySelector('.page-loading') && !!document.querySelector('.pg')` },
    { timeout: opts.timeout || 15000, throwOnTimeout: false });
  await cdp.sleep(300);
  return true;
}

/**
 * 切主题（data-theme 只有 'dark' | 'light' 两个值，见 src/utils/theme.ts）。
 * @param {object} session cdp 会话
 * @param {'dark'|'light'} theme 目标主题
 * @returns {Promise<string>} 切换后页面上的 data-theme
 */
async function setTheme(session, theme) {
  await session.ev(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await cdp.sleep(150);
  return session.ev(`document.documentElement.dataset.theme`);
}

/**
 * 杀掉应用进程树（Windows 上必须 /T，否则 electron 的子进程会残留占端口）。
 * @param {Awaited<ReturnType<typeof launch>>|null} handle launch() 的返回值
 * @returns {void}
 */
function stop(handle) {
  if (!handle || !handle.proc || handle.proc.killed) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(handle.proc.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
  } catch { /* 进程可能已经退出，退化成 kill */ }
  try { handle.proc.kill(); } catch { /* 忽略 */ }
}

module.exports = {
  ROOT,
  DEFAULT_TIMEOUT,
  testPassword,
  mkTempDir,
  prepareDataDir,
  launch,
  waitForWindow,
  waitApp,
  ensureUnlocked,
  dismissOnboarding,
  applyBackground,
  reloadPage,
  clickText,
  navTo,
  setTheme,
  stop,
};
