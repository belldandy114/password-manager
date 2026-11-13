'use strict';

/**
 * 导航守卫。
 *
 * 背景：主窗口此前开着 `webviewTag: true`（测试数据生成器子应用用），却没有
 * `will-navigate` / `setWindowOpenHandler` / `will-attach-webview`。意味着只要有一条
 * 内容能把 `<a href="http://...">` 或 `window.open(...)` 送到渲染层
 * （Markdown 笔记、周报、导入的 CSV、粘贴的富文本……），就能把整个应用窗口导航走，
 * 甚至开出一个没有 preload 的白页窗口继续跑。
 *
 * 1.24.2：测试数据生成器已并入主应用，主窗口 `webviewTag` 关闭、guardWebviews 不再挂载。
 * 下面第 2 条（webview 白名单）因此不会再被触发，但**故意保留**：万一将来又嵌入访客
 * 内容，这层判断还在，不会退回「裸奔」状态；对应单测也继续跑。
 *
 * 这里把「谁能去哪」收成一组纯函数，方便 `src/utils/__tests__/navGuard.test.ts` 直接
 * 单测；`installNavigationGuards()` 只做 Electron 事件挂载，不含判断逻辑。
 *
 * 三条规则：
 *   1. 主窗口只能在「应用自己的页面」里跳 —— 打包态是 dist 目录下的 file://，
 *      开发态是 localhost:5173。
 *   2. （历史/纵深防御）webview 只能加载测试数据生成器 —— 打包态是 dist-tdg 下的
 *      file://，开发态是 localhost:5174；preload 只认官方那一个。
 *   3. `window.open` / `target=_blank` 一律不开新窗口，http(s) 交给系统默认浏览器。
 */

const DEV_RENDERER_ORIGIN = 'http://localhost:5173';
const DEV_TDG_ORIGIN = 'http://localhost:5174';

/** file:// URL 或裸路径 → 本地路径；解析不了返回 '' */
function toLocalPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^file:/i.test(raw)) return raw;
  try {
    let p = decodeURIComponent(new URL(raw).pathname);
    // Windows 的 file:///C:/x 会解析成 /C:/x，再统一成反斜杠（URL 里只能是正斜杠）
    if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
    if (/^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\');
    return p;
  } catch {
    return '';
  }
}

function normalizeDir(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** target 是否在 dir 目录内（含 dir 自身） */
function isWithinDir(target, dir) {
  const t = normalizeDir(target);
  const d = normalizeDir(dir);
  if (!t || !d) return false;
  return t === d || t.startsWith(d + '/');
}

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

/**
 * 主窗口允许导航到的地址。
 * `about:blank` 放行（窗口初始化时就是这个）；devtools:// 放行（dev 下开着独立 devtools）。
 */
function isAllowedMainNavigation(rawUrl, options) {
  const u = parseUrl(rawUrl);
  if (!u) return false;
  const opts = options || {};
  if (u.protocol === 'about:') return true;
  if (u.protocol === 'devtools:') return !!opts.dev;
  if (opts.dev) {
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === (opts.devOrigin || DEV_RENDERER_ORIGIN);
  }
  if (u.protocol !== 'file:') return false;
  return isWithinDir(toLocalPath(rawUrl), opts.distDir);
}

/**
 * webview 允许加载的地址。
 * `about:blank` 放行（`src` 拿不到时的初值）；`tdg:` 放行 —— 该协议只服务 dist-tdg，
 * 构造上跑不出目录，和 file:// 白名单等价。
 */
function isAllowedWebviewNavigation(rawUrl, options) {
  const u = parseUrl(rawUrl);
  if (!u) return false;
  const opts = options || {};
  if (u.protocol === 'about:') return true;
  if (opts.dev) {
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === (opts.devOrigin || DEV_TDG_ORIGIN);
  }
  if (u.protocol === 'tdg:') return true;
  if (u.protocol !== 'file:') return false;
  return isWithinDir(toLocalPath(rawUrl), opts.tdgDistDir);
}

/**
 * `window.open` / `target=_blank` 的处置。
 * 返回 `{ action: 'deny' }`；若目标是 http(s)，额外带 `external` 让调用方转交系统浏览器。
 */
function decideWindowOpen(rawUrl) {
  const u = parseUrl(rawUrl);
  if (u && (u.protocol === 'http:' || u.protocol === 'https:')) {
    return { action: 'deny', external: String(rawUrl) };
  }
  return { action: 'deny' };
}

const HARDENED_WEBVIEW_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
});

/**
 * 校验一次 webview 挂载。
 *
 * 返回 `{ allow, reason? }`。`allow: true` 时调用方应把 `params.preload` 换成
 * `sanitizedPreload`（undefined 表示剥掉），并套用 `webPreferences`。
 *
 * 只认官方 preload：即使 src 在 dist-tdg 里，也不允许挂自定义 preload ——
 * 否则等于给了任意 Node 能力。
 */
function inspectWebviewAttach(params, options) {
  const p = params || {};
  const opts = options || {};
  const src = String(p.src || '');
  if (!isAllowedWebviewNavigation(src, opts)) {
    return { allow: false, reason: 'webview 目标不在白名单：' + src };
  }
  const wanted = toLocalPath(opts.tdgPreloadPath);
  const given = toLocalPath(p.preload);
  const sanitizedPreload = wanted && given && normalizeDir(given) === normalizeDir(wanted) ? p.preload : undefined;
  return { allow: true, sanitizedPreload, preloadRemoved: !!given && sanitizedPreload === undefined };
}

/**
 * 挂载守卫。在 `app.whenReady()` 里、`createWindow()` 之前调用一次即可。
 *
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {(url: string) => Promise<{success?: boolean}>} deps.openExternalUrl 转交系统浏览器
 * @param {() => object} deps.getOptions 返回 navigator 需要的最新路径/开发态开关
 * @param {() => void} [deps.onBlocked] 被拦时的回调（仅用于日志）
 */
function installNavigationGuards(deps) {
  const { app, openExternalUrl, getOptions, onBlocked } = deps;
  const log = (message) => {
    if (typeof onBlocked === 'function') {
      try {
        onBlocked(message);
      } catch {
        /* 日志失败不影响守卫 */
      }
    }
  };

  const handOff = (url) => {
    try {
      const ret = openExternalUrl(url);
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch {
      /* 系统浏览器打不开就算了，至少不要把窗口导航走 */
    }
  };

  app.on('web-contents-created', (_event, contents) => {
    let type = 'window';
    try {
      type = contents.getType();
    } catch {
      type = 'window';
    }
    const isEmbedded = type === 'webview';

    contents.on('will-navigate', (event, url) => {
      const opts = getOptions() || {};
      const allowed = isEmbedded ? isAllowedWebviewNavigation(url, opts) : isAllowedMainNavigation(url, opts);
      if (allowed) return;
      event.preventDefault();
      log('拦下导航（' + (isEmbedded ? 'webview' : 'main') + '）：' + url);
      const decision = decideWindowOpen(url);
      if (decision.external) handOff(decision.external);
    });

    // 站内 iframe（codelab:// 预览）不弹新窗口；一律拒绝，别把预览跳到外部浏览器。
    contents.on('will-frame-navigate', (event) => {
      const opts = getOptions() || {};
      const url = event.url;
      const ok = isEmbedded ? isAllowedWebviewNavigation(url, opts) : isAllowedMainNavigation(url, opts);
      const isPreview = /^codelab:/i.test(String(url || ''));
      if (ok || isPreview) return;
      // 主框架由 will-navigate 处理，这里只拦子框架，避免重复触发两遍
      if (event.isMainFrame) return;
      event.preventDefault();
      log('拦下子框架导航：' + url);
    });

    contents.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details && details.url);
      log('拦下新窗口：' + ((details && details.url) || ''));
      if (decision.external) handOff(decision.external);
      return { action: 'deny' };
    });
  });
}

/**
 * 给主窗口挂 `will-attach-webview`。必须在主窗口 webContents 存在后调用。
 */
function guardWebviews(hostContents, getOptions) {
  hostContents.on('will-attach-webview', (event, webPreferences, params) => {
    const result = inspectWebviewAttach(params, getOptions() || {});
    if (!result.allow) {
      event.preventDefault();
      return;
    }
    Object.assign(webPreferences, HARDENED_WEBVIEW_PREFERENCES);
    // webPreferences.preload 要的是**文件系统路径**，不是 file:// URL。
    // 直接把 params.preload（URL）赋回去，Electron 解析不到文件、preload 静默不执行，
    // 子应用就拿不到 window.electronAPI（表现为「填入接口调试」按钮点了没反应）。
    if (result.sanitizedPreload) webPreferences.preload = toLocalPath(result.sanitizedPreload);
    else delete webPreferences.preload;
  });
}

module.exports = {
  DEV_RENDERER_ORIGIN,
  DEV_TDG_ORIGIN,
  HARDENED_WEBVIEW_PREFERENCES,
  isWithinDir,
  toLocalPath,
  isAllowedMainNavigation,
  isAllowedWebviewNavigation,
  decideWindowOpen,
  inspectWebviewAttach,
  installNavigationGuards,
  guardWebviews,
};
