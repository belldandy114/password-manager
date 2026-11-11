'use strict';

/**
 * 代码调试的 HTML 预览：把用户写的 HTML 放进一个**独立来源**的 iframe 里渲染。
 *
 * 为什么不能直接用 `srcdoc`：srcdoc 文档会继承主窗口的 CSP（`script-src 'self'`），
 * 于是预览里的 `<script>` 一律不执行——页面看着渲染出来了，但所有交互和 console
 * 都是死的。这个坑很隐蔽：DOM 在、样式在，只有脚本静默失效。
 *
 * 做法：注册一个特权自定义协议 `codelab://`，HTML 存在主进程内存里，iframe 用
 * `src="codelab://preview/<id>"` 加载。它是独立文档、独立来源，不继承主窗口 CSP，
 * 脚本正常执行；同时因为来源不同，预览页也拿不到主窗口的 DOM 与 preload 能力。
 *
 * 安全边界：
 * - 只服务内存里登记过的 id，不碰文件系统；
 * - 单份 HTML 上限 2 MB，最多同时留 20 份（旧的先丢）；
 * - 预览页没有 preload、没有 nodeIntegration，只能通过 postMessage 回传 console。
 */

const { protocol, ipcMain } = require('electron');

const SCHEME = 'codelab';
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_KEPT = 20;

/** @type {Map<string, string>} id → html */
const store = new Map();

/**
 * 必须在 app ready 之前调用一次。
 * bypassCSP 让预览文档不受主窗口 CSP 约束；standard/secure 让它有正常的来源语义。
 */
function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
      },
    },
  ]);
}

/** app ready 之后调用：把内存里的 HTML 按 id 发出去 */
function registerPreviewProtocol() {
  protocol.handle(SCHEME, (request) => {
    let id = '';
    try {
      const u = new URL(request.url);
      id = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    } catch {
      id = '';
    }
    const html = store.get(id);
    if (html === undefined) {
      return new Response('<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;color:#888">预览已失效，请重新点「预览」。</p>', {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // 预览页不需要联网取资源时被缓存，避免改了代码还看到旧页面
        'cache-control': 'no-store',
      },
    });
  });
}

/**
 * 登记一份预览 HTML，返回可给 iframe 用的地址。
 * @param {string} html
 * @returns {{ ok: true, url: string, id: string } | { ok: false, error: string }}
 */
function putPreview(html) {
  const text = String(html == null ? '' : html);
  if (!text.trim()) return { ok: false, error: '预览内容是空的' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PREVIEW_BYTES) {
    return { ok: false, error: `预览内容超过 ${Math.round(MAX_PREVIEW_BYTES / 1024 / 1024)} MB` };
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  store.set(id, text);
  // 只留最近若干份：每次点「预览」都会新增一份，不清会一直涨
  while (store.size > MAX_KEPT) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  return { ok: true, url: `${SCHEME}://preview/${id}`, id };
}

/** 注册 IPC：渲染层把 HTML 交上来，换回一个 iframe 地址 */
function registerPreviewIpc() {
  ipcMain.handle('codelab:preview', (_event, html) => {
    const r = putPreview(html);
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, data: { url: r.url, id: r.id } };
  });
}

module.exports = {
  SCHEME,
  MAX_PREVIEW_BYTES,
  MAX_KEPT,
  registerPreviewScheme,
  registerPreviewProtocol,
  registerPreviewIpc,
  putPreview,
  _store: store,
};
