'use strict';
/**
 * 禅道（缺陷管理）相关 IPC：登录 / 我的 Bug / 详情 / 附件 / 未读提醒 / 项目 / 汇总。
 *
 * 这块原来占了 setupIpcHandlers() 的三分之一（约 1290 行）。搬迁时保持逻辑逐行不变，
 * 只做两件事：把窗口与会话密码换成 getter（原先是闭包里直接读 main.js 的变量），
 * 把未读提醒的三个函数作为返回值交给 ipc-entries.js 使用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, ipcMain, dialog, shell, Notification } = require('electron');
const { ztStripTags, ztTableRows } = require('./zentao-parse');
const { filterMineBugs } = require('./zentao-filter');
const { buildProbeCandidates, probeByIds } = require('./zentao-probe');
const { ztPageAll } = require('./zentao-pager');
const { createTtlCache } = require('./ttl-cache');

/**
 * @param {object} deps
 * @param {string} deps.DATA_DIR
 * @param {(pw: string) => any} deps.loadVault
 * @param {() => any} deps.loadSettings
 * @param {() => any} deps.getMainWindow
 * @param {() => string|null} deps.getPassword
 */
function registerZentaoIpc(deps) {
  const { DATA_DIR, loadVault, loadSettings, getMainWindow, getPassword } = deps;

// ---- Zentao (禅道) ----
// 禅道 18+ / 20.x 的登录流程（与浏览器一致）：
//   1. GET  user-login.html          建立会话，取表单里的 referer
//   2. GET  user-refreshRandom.html  返回【纯文本】随机盐（不是 JSON）
//   3. POST user-login.html          password = md5(md5(明文) + rand)，并必须带上 verifyRand
// 注意：index.php?m=user&f=login 这种老式地址在本实例会 302 到 PATH_INFO 地址，
// 直接请求会拿到空 body —— 这是之前误报「登录失败（HTTP 302）」的原因。
// 禅道 20.6 的「我的地盘」里 my-bug 无权限，但 my-work-bug 可访问，优先用它。
// ⚠️ 按实例分桶：同一时刻可能有多家公司的禅道（跨实例汇总周报就是这么用的）。
// 以前是单个 Map + 单个 ztLoggedInBase，并发拉两套会互相覆盖 cookie，
// 表现为 A 公司的请求带着 B 公司的会话（401 / 读到别的项目）。
/** baseUrl → Map<name, value> */
const ztCookieJars = new Map();
/** 已确认登录成功的 baseUrl 集合 */
const ztLoggedInBases = new Set();

const ztJar = (base) => ztCookieJars.get(base);
const ztCookieHeader = (base) => {
  const jar = ztCookieJars.get(base);
  return jar ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
};
/** 丢掉某个实例的会话（重新登录、登录失败清理时用） */
const ztForgetSession = (base) => {
  ztCookieJars.delete(base);
  ztLoggedInBases.delete(base);
};

/** 允许用户只填 host:port/zentao，自动补协议、去掉尾部斜杠 */
function ztNormalizeCfg(cfg) {
  let base = String(cfg.baseUrl || '').trim();
  if (base && !/^https?:\/\//i.test(base)) base = `http://${base}`;
  return { ...cfg, baseUrl: base.replace(/\/+$/, '') };
}

function ztAbsorbCookies(res, base) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  const jar = ztCookieJars.get(base) || new Map();
  for (const c of list) {
    const kv = String(c).split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  ztCookieJars.set(base, jar);
}

/** 请求禅道；GET 自动跟随 302，POST 不跟随（重定向即代表失败） */
async function ztFetch(cfg, pathOrUrl, options = {}) {
  // 桶键固定用「本次请求所属实例」的 base，跳转后仍写回同一个桶
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${base}/${String(pathOrUrl).replace(/^\/+/, '')}`;
  const isPost = String(options.method || 'GET').toUpperCase() !== 'GET';
  for (let hop = 0; hop < 6; hop++) {
    const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/json,*/*', ...(options.headers || {}) };
    const cookie = ztCookieHeader(base);
    if (cookie) headers.Cookie = cookie;
    let res;
    try {
      res = await fetch(url, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    } catch (e) {
      const reason = e.name === 'TimeoutError' ? '请求超时（20 秒）'
        : e.name === 'AbortError' ? '请求超时'
          : '无法连接禅道（网络不通或地址填错了）';
      throw new Error(`${reason}${/^https?:\/\//i.test(base) ? '' : '：地址需以 http:// 或 https:// 开头'}`);
    }
    ztAbsorbCookies(res, base);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      if (isPost) return { status: res.status, loc, text: '', url };
      url = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString();
      continue;
    }
    const text = await res.text();
    return { status: res.status, loc: null, text, url };
  }
  return { status: 0, loc: null, text: '', url };
}

/** 抓二进制（Bug 重现步骤里的截图）：带登录 cookie，跟随跳转 */
async function ztFetchBinary(cfg, pathOrUrl, maxBytes = 8 * 1024 * 1024) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${base}/${String(pathOrUrl).replace(/^\/+/, '')}`;
  for (let hop = 0; hop < 6; hop++) {
    const headers = { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' };
    const cookie = ztCookieHeader(base);
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    ztAbsorbCookies(res, base);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) return { status: res.status, buffer: null, contentType: '' };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) return { status: 200, buffer: null, contentType: '', tooLarge: true };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, contentType: String(res.headers.get('content-type') || '') };
  }
  return { status: 0, buffer: null, contentType: '' };
}

/**
 * 把重现步骤里的图片取回来转成 dataURL：
 * 渲染层直接 <img src=".../file-read-x.png"> 带不上禅道登录 cookie，只会显示裂图。
 */
async function ztLoadDetailImages(cfg, images) {
  const list = Array.isArray(images) ? images.slice(0, 12) : [];
  const out = [];
  let failed = 0;
  await Promise.all(list.map(async (img) => {
    try {
      const r = await ztFetchBinary(cfg, img.src, 8 * 1024 * 1024);
      if (!r.buffer || r.buffer.length < 64) { failed++; return; }
      const ct = /^image\//i.test(r.contentType) ? r.contentType : 'image/png';
      out.push({ src: img.src, name: String(img.src.split('/').pop() || ''), dataUrl: `data:${ct};base64,${r.buffer.toString('base64')}` });
    } catch {
      failed++;
    }
  }));
  // 保持与正文 [图N] 一致的顺序
  const order = new Map(list.map((x, i) => [x.src, i]));
  out.sort((a, b) => (order.get(a.src) ?? 99) - (order.get(b.src) ?? 99));
  return { images: out, failed, total: list.length };
}

function ztParseJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch { /* 继续抠 */ }
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* ignore */ }
  }
  return null;
}

/** 富文本 HTML → 纯文本（保留换行，图片留占位） */
function ztHtmlToText(html, imgTag) {
  let t = String(html || '');
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n');
  t = t.replace(/<li[^>]*>/gi, '· ');
  t = t.replace(/<img[^>]*>/gi, (tag) => (typeof imgTag === 'function' ? imgTag(tag) : '[图片]'));
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

const ZT_ACTION_LABEL = {
  opened: '创建', edited: '编辑', assigned: '指派', resolved: '解决',
  closed: '关闭', activated: '激活', commented: '备注', confirmed: '确认',
  deleted: '删除', undeleted: '还原', moved: '移动', duplicated: '重复',
  postponed: '延期', restored: '还原',
};

/** 从 zui-create-historyPanel 属性里取流转记录（禅道把 JSON 塞在属性里） */
function ztParseBugHistory(html) {
  const m = html.match(/zui-create-historyPanel="([^"]*)"/);
  if (!m) return [];
  let json;
  try {
    const raw = m[1]
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const actions = Array.isArray(json.actions) ? json.actions : [];
  return actions.map(a => {
    const text = ztHtmlToText(a.content || '').replace(/\s+/g, ' ').trim();
    // 内容形如「2026-10-27 17:36:32, 由 张三 创建。」，把时间与「由 X」拆出来做结构化展示
    const tm = text.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)[,，]?\s*(.*)$/);
    const who = (text.match(/由\s*([^\s，,。]{1,20})/) || [])[1] || '';
    return {
      action: String(a.action || ''),
      label: ZT_ACTION_LABEL[String(a.action || '')] || String(a.action || '变更'),
      time: tm ? tm[1] : '',
      who,
      text: tm ? tm[2] : text,
    };
  });
}

/** 解析 bug-view 页面：标题、产品、重现步骤、附件；列表里没有的字段在这里补 */
function ztParseBugDetail(html, bugId, base) {
  const titleTag = ztStripTags((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  let title = titleTag;
  let productName = '';
  const m = titleTag.match(/^BUG\s*#\d+\s*([\s\S]*?)\s+-\s+(.+?)\s+-\s+禅道$/);
  if (m) { title = m[1].trim(); productName = m[2].trim(); }

  // 「重现步骤」区块：从标题到下一个 section 之间
  let steps = '';
  // 正文里内嵌的图片（禅道存在 file-read-*.png，需要带登录态才能取）
  const images = [];
  const abs = (raw) => {
    if (!raw) return '';
    if (/^data:/i.test(raw)) return '';
    try {
      return new URL(raw, `${String(base || '').replace(/\/+$/, '')}/`).toString();
    } catch {
      return '';
    }
  };
  const idx = html.indexOf('zui-key="重现步骤"');
  if (idx > 0) {
    const cls = html.indexOf('detail-section-content', idx);
    if (cls > 0) {
      // 从该标签的 > 之后开始，别把 class 属性当正文
      const gt = html.indexOf('>', cls);
      const from = gt > 0 ? gt + 1 : cls;
      const nextSec = html.indexOf('zui-key="historyWrapper"', from);
      const to = nextSec > from ? html.lastIndexOf('<', nextSec) : Math.min(html.length, from + 30000);
      const chunk = html.slice(from, to > from ? to : from + 30000);

      // 先按出现顺序收集图片（同一张只留一次），正文里用 [图N] 对应
      const imgRe = /<img[^>]*>/gi;
      let im;
      while ((im = imgRe.exec(chunk)) !== null) {
        const sm = im[0].match(/src=["']([^"']+)["']/i);
        const src = abs(sm && sm[1]);
        if (src && !images.some(x => x.src === src)) images.push({ src });
      }
      const numOf = (src) => {
        const i = images.findIndex(x => x.src === src);
        return i >= 0 ? i + 1 : 0;
      };
      steps = ztHtmlToText(chunk, (tag) => {
        const sm = tag.match(/src=["']([^"']+)["']/i);
        const n = numOf(abs(sm && sm[1]));
        return n ? `[图${n}]` : '[图片]';
      });
    }
  }

  // 附件（保存 href，渲染层才能点开下载；只留名字时没法取文件）
  const attachments = [];
  const re = /href="([^"]*file-(?:download|read)[^"]*)"[^>]*>([^<]{1,120})</g;
  let fm;
  while ((fm = re.exec(html)) !== null) {
    const name = ztStripTags(fm[2]);
    const url = abs(fm[1]);
    if (name && url && !attachments.some(a => a.url === url)) attachments.push({ name, url });
  }

  return {
    id: String(bugId),
    title: title || `BUG #${bugId}`,
    productName,
    steps: steps || '（该 Bug 没有填写重现步骤）',
    attachments,
    images,
    history: ztParseBugHistory(html),
    url: `${String(base || '').replace(/\/+$/, '')}/bug-view-${bugId}.html`,
  };
}

function ztMapBug(b) {
  return {
    id: String(b.id || ''),
    title: ztStripTags(b.title || b.name || ''),
    status: String(b.status || ''),
    severity: String(b.severity || ''),
    pri: String(b.pri || ''),
    type: String(b.type || ''),
    product: String(b.product || ''),
    productName: ztStripTags(b.productName || ''),
    assignedTo: String(b.assignedTo || ''),
    openedBy: String(b.openedBy || ''),
    date: String(b.openedDate || '').slice(0, 10),
    deadline: /^0{4}-0{2}-0{2}/.test(String(b.deadline || '')) ? '' : String(b.deadline || ''),
    resolution: String(b.resolution || ''),
    resolvedDate: /^0{4}-0{2}-0{2}/.test(String(b.resolvedDate || '')) ? '' : String(b.resolvedDate || '').slice(0, 10),
    closedDate: /^0{4}-0{2}-0{2}/.test(String(b.closedDate || '')) ? '' : String(b.closedDate || '').slice(0, 10),
  };
}

/** 执行一次登录；style: 'path' = 20.x 的 user-login.html，'query' = 老版本 index.php?m= */
async function ztLoginAttempt(cfg, style) {
  const ztBase = String(cfg.baseUrl).replace(/\/+$/, '');
  // 只清这个实例的会话，别把其它公司的登录态一起丢掉
  ztForgetSession(ztBase);
  const urls = style === 'path'
    ? { login: 'user-login.html', rand: 'user-refreshRandom.html' }
    : { login: 'index.php?m=user&f=login', rand: 'index.php?m=user&f=refreshRandom' };

  const page = await ztFetch(cfg, urls.login);
  if (!page.text) return { ok: false, error: `无法打开登录页（HTTP ${page.status}）` };
  if (page.status !== 200) return { ok: false, error: `登录页返回 HTTP ${page.status}` };

  const referer = (page.text.match(/name="referer"\s+value="([^"]*)"/) || [])[1] || '/';

  // 随机盐：20.x 返回纯文本；个别版本返回 JSON
  const rr = await ztFetch(cfg, urls.rand);
  let rand = String(rr.text || '').trim();
  if (!/^\d+$/.test(rand)) {
    const j = ztParseJson(rand);
    rand = j ? String(j.rand || j.data || '') : '';
  }
  if (!rand) return { ok: false, error: '没能从禅道取到登录随机盐（user-refreshRandom），请确认地址指向禅道根目录' };

  const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: style === 'path' ? `${ztBase}/user-login.html` : `${ztBase}/${urls.login}`,
  };

  const rc = await ztFetch(cfg, urls.login, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      account: cfg.account,
      password: md5(md5(cfg.password) + rand),
      passwordStrength: '1',
      referer,
      verifyRand: rand,
      keepLogin: '1',
      captcha: '',
    }).toString(),
  });

  const json = ztParseJson(rc.text);
  if (json) {
    const ok = json.result === 'success' || json.status === 'success' || (!json.result && !json.status && json.locate);
    if (ok) return { ok: true };
    const msg = String(json.message || json.reason || '').trim();
    return { ok: false, error: msg || '账号或密码不正确' };
  }
  if (rc.status >= 300 && rc.status < 400) {
    // POST 被重定向 = 登录没通过
    return { ok: false, error: `登录未通过（HTTP ${rc.status} → ${rc.loc}）` };
  }
  if (/退出|logout|我的地盘|my-work/i.test(rc.text)) return { ok: true };
  return { ok: false, error: `登录失败（HTTP ${rc.status}），未返回预期的响应` };
}

async function ztEnsureLogin(cfg) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  // 每个实例独立判断：A 公司已登录不影响 B 公司
  if (ztJar(base) && ztJar(base).size > 0 && ztLoggedInBases.has(base)) {
    return { ok: true };
  }
  let last = { ok: false, error: '登录失败' };
  for (const style of ['path', 'query']) {
    try {
      const r = await ztLoginAttempt(cfg, style);
      if (r.ok) {
        ztLoggedInBases.add(base);
        return { ok: true };
      }
      last = r;
      // 账号密码错误就没必要再试另一种地址风格
      if (/密码|用户名|账号/.test(r.error || '')) break;
    } catch (e) {
      last = { ok: false, error: e.message };
    }
  }
  return last;
}

ipcMain.handle('zentao:login', async (_event, cfg) => {
  if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
    return { success: false, error: '请先填写地址、账号和密码' };
  }
  cfg = ztNormalizeCfg(cfg);
  try {
    // 手动点「登录」时强制走一次完整校验，避免复用已建立的会话导致错误密码也显示成功
    ztForgetSession(String(cfg.baseUrl || '').replace(/\/+$/, ''));
    const r = await ztEnsureLogin(cfg);
    if (!r.ok) return { success: false, error: r.error };
    // 用「我的地盘」探一次会话，顺便验证权限
    const probe = await ztFetch(cfg, 'my-work.html');
    if (probe.status >= 300 && probe.status < 400 && /user-login/i.test(probe.loc || '')) {
      ztForgetSession(String(cfg.baseUrl || '').replace(/\/+$/, ''));
      return { success: false, error: '登录成功但会话未建立，请重试' };
    }
    return { success: true, data: { cookie: true } };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/** 拉「我的 Bug」：页面抓取（定时提醒也复用这个） */
async function ztLoadMyBugs(cfg) {
  if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
  cfg = ztNormalizeCfg(cfg);
  try {
    const login = await ztEnsureLogin(cfg);
    if (!login.ok) return { success: false, error: login.error };

    let rows = [];
    let total = 0;

    // 1) 我的地盘 → 我的 Bug（禅道 20.x 可用，my-bug 可能无权限）
    const first = await ztFetch(cfg, 'my-work-bug.html');
    if (first.status === 200) {
      rows = ztTableRows(first.text);
      const tpl = first.text.match(/my-work-bug-assignedTo-0-id_desc-(\d+)-\{recPerPage\}-\{page\}\.html/);
      if (tpl) total = Number(tpl[1]) || rows.length;
      // 一次拉满：复用页面里的分页链接模板，每页 100 条
      if (total > rows.length) {
        const perPage = 100;
        const collected = [];
        // 以 total 为终止条件翻页（原来写死 5 页 = 500 条，Bug 多的人会被静默截断）；
        // 50 页 = 5000 条只是防死循环的保险
        for (let p = 1; p <= 50 && collected.length < total; p++) {
          const r = await ztFetch(cfg, `my-work-bug-assignedTo-0-id_desc-${total}-${perPage}-${p}.html`);
          const pageRows = ztTableRows(r.text);
          if (pageRows.length === 0) break;
          collected.push(...pageRows);
        }
        if (collected.length > rows.length) rows = collected;
      }
    }

    // 2) 老版本：my-bug.html
    if (rows.length === 0) {
      const legacy = await ztFetch(cfg, 'my-bug.html');
      if (legacy.status === 200) rows = ztTableRows(legacy.text);
    }

    // 3) 再退一步：解析 HTML 表格里的 data-id 行
    if (rows.length === 0) {
      const html = await ztFetch(cfg, 'my-work-bug.html');
      const trs = (html.text.match(/<tr[^>]*data-id="\d+"[\s\S]*?<\/tr>/g) || []);
      for (const tr of trs) {
        const id = (tr.match(/data-id="(\d+)"/) || [])[1];
        const title = ztStripTags((tr.match(/class="[^"]*text-left[^"]*"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
        if (id) rows.push({ id, title });
      }
    }

    if (rows.length === 0) {
      const probe = await ztFetch(cfg, 'my-work-bug.html');
      if (probe.status >= 300 && probe.status < 400) {
        return {
          success: false,
          error: `没有访问「我的地盘」的权限（HTTP ${probe.status} → ${probe.loc}）。请用上方快捷入口在浏览器中查看。`,
        };
      }
      return { success: false, error: '未取到 Bug 数据，可能是该禅道版本页面结构不同，可先用快捷入口查看' };
    }

    const list = rows.map(ztMapBug).filter(b => b.id);
    return { success: true, data: list.slice(0, 500), total: total || list.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * 「我提交的 / 待我验证」走 REST（api.php/v1）。
 *
 * ⚠️ 禅道 20.x 的 `GET /bugs` 强制要求 `product`，不带就返回
 * `{"result":"fail","message":"Need product id."}`（用户实测报过）。
 * 所以先取项目列表，再按项目逐个查、按 id 去重合并；
 * 并发 4 个 worker，既压住耗时，也不至于把禅道打满。
 */
async function ztLoadMyBugsScoped(cfg, scope, productIds) {
  cfg = ztNormalizeCfg(cfg);
  if (!cfg.account || !cfg.password) return { success: false, error: '请先填写账号和密码' };
  try {
    const products = await ztApiProducts(cfg).catch(() => []);
    if (!products.length) {
      return { success: false, error: '没有取到项目列表（禅道 REST 要求按项目查询），请先点一次「登录并保存」再试' };
    }
    const nameMap = {};
    for (const p of products) nameMap[String(p.id)] = p.name;

    // 1.24.8：以前这里写死 page=1，单产品超过一页的 Bug 直接丢。
    // 现在 limit/page 交给 ztPageAll 按 total 翻页，filter 只负责筛选条件。
    const filter = () => {
      const params = new URLSearchParams();
      // 服务端对 openedBy / assignedTo / status 都可能静默忽略，所以这里只当「缩小范围」用，
      // 真正的过滤在 filterMineBugs 里按账号 + 状态做（status 统一取 all，避免漏数据）。
      params.set('status', 'all');
      if (scope === 'opened') params.set('openedBy', cfg.account);
      else params.set('assignedTo', cfg.account);
      return params;
    };

    // 只查用户选中的项目：31 个项目全量遍历要好几秒，而且大多数项目跟当前测试无关。
    const wanted = Array.isArray(productIds) ? productIds.map(String).filter(Boolean) : [];
    const queue = wanted.length ? products.filter(p => wanted.includes(String(p.id))) : products.slice();
    if (!queue.length) {
      return { success: false, error: `所选项目不在项目列表里（选了 ${wanted.join(", ")}），请重新载入项目后再试` };
    }
    const queueSize = queue.length;
    const seen = new Set();
    const all = [];
    let okCount = 0;
    let lastError = '';

    const worker = async () => {
      for (;;) {
        const p = queue.shift();
        if (!p) return;
        const result = await ztApiPaged(
          cfg,
          (page, n) => {
            const params = filter();
            params.set('product', String(p.id));
            params.set('limit', String(n));
            params.set('page', String(page));
            return `api.php/v1/bugs?${params.toString()}`;
          },
          'bugs',
        ).catch(e => { lastError = e.message || String(e); return null; });
        if (!result) continue;
        okCount++;
        for (const b of result.items) {
          // ⚠️ 这里必须留原始行：ztMapApiBug 之后 openedBy/assignedTo 变成了**显示名**，
          // 拿去跟账号比较会把所有人的数据都滤掉（1.7.4 就是这么错的）。
          const rawId = String((b && b.id) || '');
          if (!rawId || seen.has(rawId)) continue;
          seen.add(rawId);
          all.push(b);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, queueSize) }, () => worker()));

    if (!okCount) {
      return { success: false, error: `按项目查询失败：${lastError || '全部请求都未成功'}` };
    }
    // 服务端对 openedBy / assignedTo 可能直接忽略（实测会返回整个项目的 Bug），
    // 所以这里再按账号本地过滤一次；若返回里没有账号字段则不过滤，避免误杀成 0 条。
    const mine = filterMineBugs(all, cfg.account, scope);
    const rows = mine.rows.map(b => ztMapApiBug(b, nameMap)).filter(b => b.id);
    return {
      success: true,
      data: rows,
      total: rows.length,
      scope,
      account: cfg.account,
      filteredByAccount: mine.filtered,
      dropped: mine.dropped,
      // 诊断用：服务端到底返回了几条、其中几条带账号字段
      scanned: all.length,
      withAccount: mine.withAccount,
      products: products.length,
      queried: wanted.length ? wanted : products.map(p => String(p.id)),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

ipcMain.handle('zentao:my-bugs', async (_event, cfg, scope = 'assigned', productIds) => {
  if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
  // 三个视图统一走 REST + 本地按账号过滤：旧的 HTML 抓取分支拿不到账号字段，
  // 界面会一直显示「未按账号复核」，而且和另外两个视图的口径不一致。
  return ztLoadMyBugsScoped(cfg, scope, productIds);
});

ipcMain.handle('zentao:bug-detail', async (_event, { cfg, bugId } = {}) => {
  if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
  if (!bugId) return { success: false, error: '缺少 Bug ID' };
  cfg = ztNormalizeCfg(cfg);
  try {
    const login = await ztEnsureLogin(cfg);
    if (!login.ok) return { success: false, error: login.error };
    const res = await ztFetch(cfg, `bug-view-${bugId}.html`);
    if (res.status >= 300 && res.status < 400) {
      return { success: false, error: `打开 Bug #${bugId} 失败（HTTP ${res.status}），可能没有查看权限` };
    }
    if (!res.text || res.text.length < 500) {
      return { success: false, error: `Bug #${bugId} 页面内容异常` };
    }
    const detail = ztParseBugDetail(res.text, bugId, cfg.baseUrl);
    if (detail.images && detail.images.length > 0) {
      const loaded = await ztLoadDetailImages(cfg, detail.images);
      detail.images = loaded.images;
      detail.imageTotal = loaded.total;
      detail.imageFailed = loaded.failed;
    } else {
      detail.images = [];
      detail.imageTotal = 0;
      detail.imageFailed = 0;
    }
    return { success: true, data: detail };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/**
 * 下载 Bug 附件：禅道的 file-download 与 file-read 链接必须带登录 Cookie，
 * 渲染层的 <a href> 点了只会 302 到登录页，所以由主进程带 Cookie 取二进制。
 * mode=open → 存临时文件并直接打开；mode=save → 让用户选保存路径。
 */
ipcMain.handle('zentao:attachment', async (_event, { cfg, url, name, mode = 'open' } = {}) => {
  if (!cfg || !cfg.baseUrl) return { success: false, error: '请先填写禅道地址' };
  if (!url) return { success: false, error: '缺少附件地址' };
  cfg = ztNormalizeCfg(cfg);
  try {
    const login = await ztEnsureLogin(cfg);
    if (!login.ok) return { success: false, error: login.error };
    const res = await ztFetchBinary(cfg, url, 100 * 1024 * 1024);
    if (!res.buffer) {
      return { success: false, error: res.tooLarge ? '附件超过 100MB，请到浏览器里下载' : `附件取回失败（HTTP ${res.status}）` };
    }
    const safeName = String(name || path.basename(String(url).split('?')[0]) || 'attachment')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 120);
    let target = '';
    if (mode === 'save') {
      const r = await dialog.showSaveDialog(getMainWindow(), { title: '保存附件', defaultPath: safeName });
      if (r.canceled || !r.filePath) return { success: false, canceled: true };
      target = r.filePath;
    } else {
      const dir = path.join(app.getPath('temp'), 'pm-zt-attach');
      fs.mkdirSync(dir, { recursive: true });
      target = path.join(dir, safeName);
      // 同名文件加序号，别互相覆盖
      if (fs.existsSync(target)) {
        const dot = safeName.lastIndexOf('.');
        const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
        const ext = dot > 0 ? safeName.slice(dot) : '';
        let i = 2;
        while (fs.existsSync(target)) target = path.join(dir, `${stem}-${i++}${ext}`);
      }
    }
    fs.writeFileSync(target, res.buffer);
    if (mode === 'save') {
      shell.showItemInFolder(target);
    } else {
      const err = await shell.openPath(target);
      if (err) return { success: false, error: `文件已保存到 ${target}，但打开失败：${err}`, data: { path: target } };
    }
    return { success: true, data: { path: target, size: res.buffer.length, name: safeName } };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ---- 新 Bug 提醒（后台定时检查「我的 Bug」） ----
let ztNotifyTimer = null;
let ztNotifyBusy = false;
let ztSeenIds = null;
/** 未读数（侧边栏红点）：新 Bug 累加，打开禅道页清零 */
let ztUnread = 0;
/**
 * 每条 Bug 的状态快照：`{ [id]: { status, resolution, since, firstSeen } }`。
 * `since` = 进入当前状态的时间。禅道 REST 不给「最后修改时间」，
 * 所以「挂了多久没动」只能靠本地这份快照推算 —— 这是超期提醒的基础。
 */
let ztMeta = null;
/** 已经提醒过的超期：`{ [id]: { status, at } }`，同一状态只提醒一次，状态变了自然重置 */
let ztAlerted = null;

const ztNotifyStateFile = () => path.join(DATA_DIR, 'zentao-notify-state.json');

function ztLoadSeen() {
  if (ztSeenIds) return ztSeenIds;
  try {
    const j = JSON.parse(fs.readFileSync(ztNotifyStateFile(), 'utf8'));
    ztSeenIds = new Set(Array.isArray(j.ids) ? j.ids.map(String) : []);
    ztUnread = Number(j.unread) || 0;
    ztMeta = (j.meta && typeof j.meta === 'object') ? j.meta : {};
    ztAlerted = (j.alerted && typeof j.alerted === 'object') ? j.alerted : {};
  } catch {
    ztSeenIds = new Set();
    ztMeta = {};
    ztAlerted = {};
  }
  return ztSeenIds;
}

function ztSaveSeen() {
  try {
    fs.writeFileSync(ztNotifyStateFile(), JSON.stringify({
      ids: [...(ztSeenIds || [])],
      unread: ztUnread,
      at: new Date().toISOString(),
      meta: ztMeta || {},
      alerted: ztAlerted || {},
    }), 'utf8');
  } catch { /* 忽略 */ }
}

/** 把未读数推给渲染层（侧边栏红点） */
function ztPushUnread() {
  if (getMainWindow() && !getMainWindow().isDestroyed()) getMainWindow().webContents.send('zentao:unread', ztUnread);
}

ipcMain.handle('zentao:unread', () => ({ success: true, data: ztUnread }));

ipcMain.handle('zentao:unread-clear', () => {
  ztUnread = 0;
  ztSaveSeen();
  ztPushUnread();
  return { success: true, data: 0 };
});

// 启动就读一次：上次退出时还没看的未读数要能在侧边栏立刻显示
try { ztLoadSeen(); } catch { /* 忽略 */ }

/** 从 vault 里取禅道配置（只有解锁后才有） */
function ztCfgFromVault() {
  if (!getPassword()) return null;
  const vault = loadVault(getPassword());
  const list = vault && Array.isArray(vault.integrations) ? vault.integrations : [];
  const settings = loadSettings() || {};
  const activeId = String(settings.zentaoActiveId || 'zentao');
  const complete = (c) => c && c.baseUrl && c.account && c.password;
  // 优先用「当前选中的那套」；它被删了就退回老的单配置，最后退回任意一套填全的
  const active = list.find(i => i && i.id === activeId);
  if (complete(active)) return active;
  const legacy = list.find(i => i && i.id === 'zentao');
  if (complete(legacy)) return legacy;
  const any = list.find(complete);
  return any || null;
}

/** 最近一次提醒检查的结果（设置页展示，避免「开了但不知道有没有跑」） */
let ztLastCheck = null;

/**
 * 更新状态快照并算出超期清单。
 *
 * 关键是 `since`：进入当前状态的时间。首次见到某条 Bug 时直接设为现在，
 * 不给它算超期 —— 否则打开功能的第一天满屏都是「超期 30 天」的旧账。
 */
function ztUpdateMetaAndStale(list, staleDays) {
  ztLoadSeen();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const meta = ztMeta || {};
  const keep = new Set();
  const stale = { verify: [], handle: [] };

  (list || []).forEach((b) => {
    const key = String(b.id);
    keep.add(key);
    const status = String(b.status || '');
    const resolution = String(b.resolution || '');
    const prev = meta[key];
    if (!prev) {
      meta[key] = { status, resolution, since: nowIso, firstSeen: nowIso };
      return;
    }
    if (prev.status !== status || prev.resolution !== resolution) {
      meta[key] = { ...prev, status, resolution, since: nowIso };
      return;
    }
    if (status === 'closed' || !prev.since) return;
    const days = Math.floor((nowMs - Date.parse(prev.since)) / 86400000);
    if (!Number.isFinite(days) || days < staleDays) return;
    const row = { id: key, title: String(b.title || ''), days, status };
    if (status === 'resolved' || resolution) stale.verify.push(row);
    else if (status === 'active') stale.handle.push(row);
  });

  // 只保留当前还在列表里的条目，避免状态文件无限增长
  Object.keys(meta).forEach((k) => { if (!keep.has(k)) delete meta[k]; });
  const alerted = ztAlerted || {};
  Object.keys(alerted).forEach((k) => { if (!keep.has(k)) delete alerted[k]; });

  ztMeta = meta;
  return stale;
}

/** 挑出「这次值得弹通知」的：同一状态只提醒一次，状态变了自然重置 */
function ztPickFreshStale(stale) {
  ztLoadSeen();
  const alerted = ztAlerted || {};
  const pick = (arr) => (arr || []).filter((row) => {
    const a = alerted[row.id];
    if (a && a.status === row.status) return false;
    alerted[row.id] = { status: row.status, at: new Date().toISOString() };
    return true;
  });
  const verify = pick(stale.verify);
  const handle = pick(stale.handle);
  ztAlerted = alerted;
  return { verify, handle };
}

async function ztCheckNewBugs() {
  if (ztNotifyBusy || !getPassword()) return;
  const settings = loadSettings() || {};
  // 超期提醒也挂在这条检查上：只开「超期提醒」、没开「新 Bug 提醒」时同样要跑，
  // 否则用户勾了超期却永远收不到（早期版本就是这个坑）。
  if (!settings.zentaoNotify && !settings.zentaoStaleOn) return;
  const cfg = ztCfgFromVault();
  if (!cfg) {
    ztLastCheck = { at: new Date().toISOString(), ok: false, error: '还没在禅道页保存账号密码' };
    return;
  }
  ztNotifyBusy = true;
  try {
    const r = await ztLoadMyBugs(cfg);
    if (!r || !r.success || !Array.isArray(r.data)) {
      ztLastCheck = { at: new Date().toISOString(), ok: false, error: (r && r.error) || '拉取失败' };
      return;
    }
    const ids = new Set(r.data.map(b => String(b.id)));
    const seen = ztLoadSeen();
    const isFirstRun = seen.size === 0;
    const fresh = r.data.filter(b => !seen.has(String(b.id)));

    // 状态快照始终更新（不然刚打开开关那天没有基线），但不一定提醒
    const staleDays = Math.max(1, Number(settings.zentaoStaleDays) || 3);
    const stale = ztUpdateMetaAndStale(r.data, staleDays);
    const staleAlert = settings.zentaoStaleOn ? ztPickFreshStale(stale) : { verify: [], handle: [] };
    if (settings.zentaoStaleOn && (staleAlert.verify.length || staleAlert.handle.length)) {
      const parts = [];
      if (staleAlert.verify.length) parts.push(`待验证超 ${staleDays} 天 ${staleAlert.verify.length} 个`);
      if (staleAlert.handle.length) parts.push(`待处理超 ${staleDays} 天 ${staleAlert.handle.length} 个`);
      const first = [...staleAlert.verify, ...staleAlert.handle][0];
      const body = `${parts.join(' · ')}\n举例：#${first.id} ${first.title}（已 ${first.days} 天）`;
      try {
        const n = new Notification({ title: '禅道：有缺陷超期未动', body });
        n.on('click', () => {
          if (getMainWindow() && !getMainWindow().isDestroyed()) {
            getMainWindow().show();
            getMainWindow().focus();
            getMainWindow().webContents.send('zentao:open');
          }
        });
        n.show();
      } catch { /* 系统不支持通知时忽略 */ }
    }

    // 首次只记录基线，不弹一堆通知
    if (!isFirstRun && fresh.length > 0) {
      const body = fresh.slice(0, 3).map(b => `#${b.id} ${b.title}`).join('\n')
        + (fresh.length > 3 ? `\n…还有 ${fresh.length - 3} 条` : '');
      try {
        const n = new Notification({ title: `禅道：${fresh.length} 个新 Bug`, body });
        n.on('click', () => {
          if (getMainWindow() && !getMainWindow().isDestroyed()) {
            getMainWindow().show();
            getMainWindow().focus();
            getMainWindow().webContents.send('zentao:open');
          }
        });
        n.show();
      } catch { /* 系统不支持通知时忽略 */ }
      if (getMainWindow() && !getMainWindow().isDestroyed()) getMainWindow().flashFrame(true);
      // 侧边栏红点：未读数累加并推给渲染层
      ztUnread += fresh.length;
      ztSaveSeen();
      ztPushUnread();
    }
    ztLastCheck = {
      at: new Date().toISOString(), ok: true, total: r.data.length, fresh: fresh.length,
      staleDays,
      stale: { verify: stale.verify.length, handle: stale.handle.length },
      // 明细给「通知中心」用：截断到 20 条，避免状态对象无限大
      staleRows: {
        verify: stale.verify.slice(0, 20),
        handle: stale.handle.slice(0, 20),
      },
      staleOn: !!settings.zentaoStaleOn,
    };
    ztSeenIds = ids;
    ztSaveSeen();
  } catch { /* 提醒失败不打扰用户 */ } finally {
    ztNotifyBusy = false;
  }
}

/** 按设置启停定时器；锁定后 getPassword() 为空自然不再拉取 */
function ztRestartNotify() {
  if (ztNotifyTimer) {
    clearInterval(ztNotifyTimer);
    ztNotifyTimer = null;
  }
  const settings = loadSettings() || {};
  if ((!settings.zentaoNotify && !settings.zentaoStaleOn) || !getPassword()) return;
  const min = Math.max(2, Number(settings.zentaoNotifyInterval) || 10);
  ztNotifyTimer = setInterval(ztCheckNewBugs, min * 60 * 1000);
  setTimeout(ztCheckNewBugs, 8000);
}

ipcMain.handle('zentao:notify-now', async () => {
  await ztCheckNewBugs();
  return { success: true, data: ztLastCheck };
});

ipcMain.handle('zentao:notify-status', () => {
  const settings = loadSettings() || {};
  const cfg = ztCfgFromVault();
  return {
    success: true,
    data: {
      enabled: !!settings.zentaoNotify,
      interval: Number(settings.zentaoNotifyInterval) || 10,
      configured: !!cfg,
      unlocked: !!getPassword(),
      lastCheck: ztLastCheck,
      staleOn: !!settings.zentaoStaleOn,
      staleDays: Math.max(1, Number(settings.zentaoStaleDays) || 3),
    },
  };
});

// ---- 禅道 REST API（api.php/v1）----
// 用来取「整个项目（产品）」的全部 Bug —— 网页版只给「我的 Bug」，REST 能按产品拉全量。
// 认证：POST api.php/v1/tokens {account,password} → {token}，之后每个请求带 Token 头。
// 每个实例（baseUrl|account）一份 token：跨公司汇总时逐家切换，
// 用单例的话每换一家都要重新认证一次，白白多几秒。
const ztApiTokens = new Map();
const ztProductCache = new Map();   // base|account → { [productId]: name }

/**
 * 产品清单（用户口中的「项目」）短时缓存。
 *
 * 一次「拉取项目」其实很贵：programs + products 列表 1~2 次请求，**再加上补漏扫描**
 * （首次 56 个 id 单查，约 2~4 秒）。而自动触发点很多：进页面、登录成功、切回窗口、
 * 「我的 Bug」兜底重试、快捷键刷新 —— 用户连点两下就是双倍开销，日志里 10:09:51 与
 * 10:09:53 两次全量扫描就是这么来的（第一次要 2 秒才结束，第二次来不及命中结果缓存）。
 *
 * 所以两层：① 60 秒内复用上次结果（只对自动调用生效）；② 并发同名请求合并成一次
 * （见 ttl-cache.js 的 single-flight）。显式点「拉取项目」/快捷键刷新走 fresh=true 绕过缓存。
 */
const ztProductsCache = createTtlCache({ ttl: 60 * 1000, max: 8 });

const ztApiCacheKey = (cfg) => `${String(cfg.baseUrl || '').replace(/\/+$/, '')}|${cfg.account || ''}`;

async function ztApiTokenGet(cfg, force = false) {
  const key = ztApiCacheKey(cfg);
  if (!force && ztApiTokens.has(key)) return ztApiTokens.get(key);
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/api.php/v1/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: cfg.account, password: cfg.password }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? '连接禅道 API 超时（20 秒）' : '无法连接禅道 API，请检查地址');
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  if (!json || !json.token) {
    const msg = (json && (json.error || json.message)) || '';
    if (/unauthor|denied|password|account/i.test(msg) || res.status === 401 || res.status === 400) {
      throw new Error('禅道 API 认证失败，请检查账号密码');
    }
    throw new Error(msg || `获取禅道 API Token 失败（HTTP ${res.status}）`);
  }
  ztApiTokens.set(key, json.token);
  return json.token;
}

async function ztApiGet(cfg, apiPath) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ztApiTokenGet(cfg, attempt > 0);
    let res;
    try {
      res = await fetch(`${base}/${String(apiPath).replace(/^\/+/, '')}`, {
        headers: { Token: token, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? '禅道 API 请求超时（30 秒）' : '无法连接禅道 API');
    }
    // token 过期：换一个再试一次
    if (res.status === 401 && attempt === 0) continue;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    if (!json) throw new Error(`禅道 API 返回异常（HTTP ${res.status}）`);
    if (res.status >= 400) throw new Error(json.error || `禅道 API 返回 HTTP ${res.status}`);
    return json;
  }
  throw new Error('禅道 API 认证失败，请重试');
}

/** REST 里 assignedTo / openedBy 是对象 {account, realname}：显示名与登录账号分别保留 */
const ztUserName = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v.realname || v.account || '');
};
const ztUserAccount = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v.account || '');
};

/** 拉产品清单（禅道里「产品」就是大家口中的项目，如「某业务系统-管理后台 V2.0」） */
/**
 * 按 total 翻页拉取 REST 列表。禅道服务端可能把 limit 压到很小（同源框架默认 20），
 * 单发一次 products?limit=1000 只拿第一页 → 后面的项目永久丢失（1.24.8 修的「拉取不全」）。
 * 统一走 ztPageAll：以 total 驱动翻页、按 id 去重、服务端忽略 page 时不会死循环。
 */
function ztApiPaged(cfg, pathOf, listKey, opts = {}) {
  const run = (withStatusAll) => ztPageAll(
    (page, perPage) => ztApiGet(cfg, pathOf(page, perPage, withStatusAll)).then(json => ({
      list: Array.isArray(json && json[listKey]) ? json[listKey] : [],
      total: Number(json && json.total) || 0,
    })),
    { getId: (row) => row && row.id },
  );
  if (!opts.statusAll) return run(false);
  // ⚠️ 与 bugs 接口同源的坑：products 不带 status=all 时 REST 只返回「未关闭」的产品，
  // 已关闭的产品（如产品 69）整条消失，界面看起来就是「项目拉不全」。1.24.9 修复。
  // 旧版禅道不认这个参数会返回 4xx，此时退回原请求，不能因为加了参数反而全拉不到。
  return run(true).catch(() => run(false));
}

/** 项目集（programs）：产品只给 program id，重名项目靠项目集名区分 */
async function ztApiPrograms(cfg) {
  const key = 'programs|' + ztApiCacheKey(cfg);
  const hit = ztProductCache.get(key);
  if (hit && hit.map && Date.now() - hit.at < 10 * 60 * 1000) return hit.map;
  const map = {};
  try {
    const { items } = await ztApiPaged(cfg, (page, n) => `api.php/v1/programs?limit=${n}&page=${page}`, 'programs');
    for (const pr of items) map[String(pr.id)] = ztStripTags(pr.name || '');
  } catch { /* 旧版禅道/无项目集权限：降级为只显示项目名 */ }
  ztProductCache.set(key, { at: Date.now(), map });
  return map;
}

/**
 * 网页「全部产品」兜底（1.24.10）。
 *
 * 实测（2026-11-17）：REST `/products` 返回 total=31 且实到 31，但用户能通过
 * `bug-browse-69-*.html` 打开的产品 69 不在响应里 —— 说明接口按 status/acl/program
 * 过滤了，而 `status=all` 被这个版本**静默忽略**（total 一点没变）。
 * 网页列表是登录用户的完整视图，用它补齐；解析失败一律返回空，绝不能影响主流程。
 */
async function ztHtmlProducts(cfg) {
  const found = new Map();
  const trace = [];
  try {
    const login = await ztEnsureLogin(cfg);
    if (!login.ok) {
      console.log(`[zentao] html products: login failed (${login.error || ''})`);
      return found;
    }
    for (const p of ['product-all.html', 'product-browse.html', 'product-index.html']) {
      const page = await ztFetch(cfg, p).catch(() => null);
      if (!page) { trace.push(`${p}:null`); continue; }
      if (page.status !== 200) { trace.push(`${p}:${page.status}`); continue; }
      const rows = ztTableRows(page.text);
      trace.push(`${p}:len=${page.text.length}/rows=${rows.length}`);
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const id = r.id != null ? r.id : r.product;
        const name = r.name || r.title || r.productName;
        if (id != null && name) found.set(String(id), { id: String(id), name: ztStripTags(name) });
      }
      if (found.size) {
        console.log(`[zentao] html products via ${p}: ${found.size}`);
        break;
      }
    }
  } catch (e) {
    console.log(`[zentao] html products failed: ${e.message}`);
  }
  // 一个都没拿到时把探测过程写下来：是 404 / 登录失败 / 还是解析不出行，一看便知
  if (!found.size) console.log(`[zentao] html products none (${trace.join(' | ')})`);
  return found;
}

/**
 * 补漏扫描结果缓存：同一实例 10 分钟内只扫一遍，避免一次「拉取项目」里重复扫。
 * 用 ttl-cache 而不是裸 Map，是为了带上 single-flight —— 并发两次调用时第二次直接等第一次，
 * 不会出现两份扫描同时跑（2026-11-17 日志里相隔 1.3 秒的两次 requested=56）。
 */
const ztMissingCache = createTtlCache({ ttl: 10 * 60 * 1000, max: 8 });
/** 按 id 的探测结论缓存 6 小时（存在/不存在都记），新 id 不在缓存里所以永远会被重新请求 */
const ZT_PROBE_TTL = 6 * 60 * 60 * 1000;
/** 探测并发：实测内网单个 404 约 300~500ms，10 并发扫 67 个约 2~3 秒，12 更快且不至于被限流 */
const ZT_PROBE_CONC = 12;
let ztMissingDisk = null;

function ztMissingCacheFile() {
  return path.join(app.getPath('userData'), 'zentao-probe-cache.json');
}

function ztMissingDiskLoad() {
  if (ztMissingDisk) return ztMissingDisk;
  ztMissingDisk = {};
  try {
    const json = JSON.parse(fs.readFileSync(ztMissingCacheFile(), 'utf8'));
    if (json && typeof json === 'object' && !Array.isArray(json)) ztMissingDisk = json;
  } catch { /* 首次运行 / 文件损坏：当空缓存，不影响功能 */ }
  return ztMissingDisk;
}

function ztMissingDiskSave(key, entry) {
  const all = ztMissingDiskLoad();
  all[key] = entry;
  try {
    fs.writeFileSync(ztMissingCacheFile(), JSON.stringify(all), 'utf8');
  } catch { /* 写失败不影响本次返回 */ }
}

/**
 * 探测缓存改成「按 id 记账」：`{ at, ids: { "<产品id>": {at, p} } }`，`p: null` 表示确定不存在。
 *
 * 为什么不整体缓存一份结果：整体缓存会把「后来新建的产品」一起挡住（6 小时内看不见新项目）。
 * 按 id 记账后，新 id 天然不在缓存里 → 必被请求；老 id 的结论（存在/不存在）可放心复用。
 *
 * 兼容 1.24.13 的旧格式 `{at, list}`：读到时自动迁移成按 id 的形式。
 */
function ztProbeBucket(key) {
  const all = ztMissingDiskLoad();
  const cur = all[key];
  if (cur && cur.ids && typeof cur.ids === 'object' && !Array.isArray(cur.ids)) return cur;
  const ids = {};
  if (cur && Array.isArray(cur.list)) {
    for (const p of cur.list) {
      if (p && p.id != null) ids[String(p.id)] = { at: cur.at || 0, p };
    }
  }
  const next = { at: Date.now(), ids };
  all[key] = next;
  return next;
}

/**
 * 把列表接口漏掉的产品按 id 找回来。
 *
 * 为什么需要（2026-11-17 实测结论）：该实例 `products` 列表只回 31 个，
 * 而 `GET products/{id}` 单查能拿到另外 11 个 —— **列表接口在过滤，单查不过滤**。
 * 找回来的 11 个里 9 个 `status=closed`、2 个 `status=normal`（54、69），
 * 且分散在 71/72/73 三个项目集 —— 所以**不是状态过滤、也不是项目集过滤**，
 * 更像「列表只返回我参与的产品」。`status=all` / `browseType=all` 都被静默忽略，换参数没戏。
 *
 * 扫描顺序有讲究：**先扫 maxId 之后的新 id**（新产品总是最大 id；69 就在 maxId+1），
 * 再扫中间断档。总量封顶 120、并发 12；已探测过的 id 结论（存在/不存在）按 id 缓存 6 小时，
 * 所以第一次约 2~3 秒，之后基本 0 请求（新产品的 id 不在缓存里，仍会被立刻发现）。
 */
async function ztProbeMissingProducts(cfg, items, opts = {}) {
  const key = ztApiCacheKey(cfg);
  const { candidates, maxId, gaps, capped } = buildProbeCandidates(items.map(p => p.id));
  if (!candidates.length) return { list: [], requested: 0, reused: 0 };

  // 10 分钟结果缓存 + 并发合并：同一次「拉取项目」里多次调用（列表/统计/汇总）只扫一遍；
  // 显式刷新（fresh）绕过结果缓存，但仍和正在跑的那次合并。
  const r = await ztMissingCache.wrap(
    key,
    () => ztProbeScan(cfg, key, candidates, { maxId, gaps, capped }),
    { fresh: !!opts.fresh },
  );
  if (r.cached) {
    console.log(`[zentao] probe cache hit age=${Math.round(r.age / 1000)}s`
      + `（10 分钟内不重复扫描，共 ${candidates.length} 个候选）`);
    return { list: r.value.list, requested: 0, reused: candidates.length };
  }
  if (r.shared) {
    console.log('[zentao] probe cache: 合并并发请求（未重复扫描）');
    return { list: r.value.list, requested: 0, reused: candidates.length };
  }
  return r.value;
}

/** 真正的扫描体：按 id 记账 + 并发单查。结果由 ztProbeMissingProducts 缓存 */
async function ztProbeScan(cfg, key, candidates, meta) {
  const { maxId, gaps, capped } = meta;
  const bucket = ztProbeBucket(key);
  const now = Date.now();
  const found = [];
  const pending = [];
  for (const id of candidates) {
    const c = bucket.ids[id];
    // 只复用「结论明确」的缓存：存在 → 直接收；不存在 → 跳过。网络错误的 id 不会被写进来。
    if (c && now - (c.at || 0) < ZT_PROBE_TTL) { if (c.p) found.push(c.p); }
    else pending.push(id);
  }

  let denied = 0;
  if (pending.length) {
    const r = await probeByIds(pending, async (id) => {
      try {
        const json = await ztApiGet(cfg, `api.php/v1/products/${id}`);
        if (!json || json.id == null) return null;
        // 已删除的产品不要（有些版本 deleted 是 '1' 或时间戳字符串）
        const del = String(json.deleted || '');
        if (del && del !== '0') return null;
        return {
          id: String(json.id),
          name: ztStripTags(json.name || '') || `产品 ${json.id}`,
          status: String(json.status || ''),
          program: String(json.program || ''),
          // manual 标记让 loadProjects 每次都保留它，不会被下一次接口结果冲掉
          manual: true,
        };
      } catch (e) {
        // 404 = 确定不存在，可以缓存；其它错误（超时/403）不能当成「不存在」，否则会被长期误判
        if (/\b404\b/.test(String((e && e.message) || ''))) return null;
        throw e;
      }
    }, { concurrency: ZT_PROBE_CONC });

    denied = r.denied;
    for (const p of r.found) {
      found.push(p);
      bucket.ids[p.id] = { at: now, p };
    }
    for (const id of r.misses || []) bucket.ids[id] = { at: now, p: null };

    // 上限保护：只留最近的 1200 条，避免缓存文件随实例变大而无限膨胀
    const keys = Object.keys(bucket.ids);
    if (keys.length > 1200) {
      keys.sort((a, b) => (bucket.ids[a].at || 0) - (bucket.ids[b].at || 0));
      for (const k of keys.slice(0, keys.length - 1200)) delete bucket.ids[k];
    }
    bucket.at = now;
    ztMissingDiskSave(key, bucket);
  }

  found.sort((a, b) => Number(a.id) - Number(b.id));
  // 这行日志一次性回答「漏掉的产品到底是什么状态」：status / program 直接写出来
  console.log(`[zentao] probe missing: candidates=${candidates.length}`
    + ` (tail ${maxId + 1}..${maxId + 30}, gaps=${gaps}${capped ? ' 已超限跳过' : ''})`
    + ` requested=${pending.length} reused=${candidates.length - pending.length}`
    + ` found=${found.length}${denied ? ` denied=${denied}` : ''}`
    + found.map(p => ` #${p.id}[status=${p.status},program=${p.program}]`).join(''));
  return { list: found, requested: pending.length, reused: candidates.length - pending.length };
}

/**
 * 产品清单 = 大家口中的「项目」。返回带 total/truncated，供 handler 提示是否拉全。
 *
 * 外层加了 60 秒短时缓存 + 并发合并（见 ztProductsCache）。`fresh: true` 给「拉取项目」按钮
 * 和快捷键用：绕过缓存（也绕过补漏的 10 分钟结果缓存），确保能看到禅道刚建的产品。
 */
async function ztApiProductsDetailed(cfg, opts = {}) {
  const key = ztApiCacheKey(cfg);
  const r = await ztProductsCache.wrap(
    key,
    () => ztApiProductsFetch(cfg, opts),
    { fresh: !!opts.fresh },
  );
  if (r.cached) {
    console.log(`[zentao] products cache hit age=${Math.round(r.age / 1000)}s（60 秒内复用，不发请求）`);
  } else if (r.shared) {
    console.log('[zentao] products cache: 合并并发请求（未重复拉取）');
  }
  // cached/ageMs 要传回渲染层：界面得能显示「这是缓存 / 刚拉的」，
  // 否则用户点了刷新看不出区别，只能去翻日志（1.24.16 加的）
  return { ...r.value, cached: !!r.cached, ageMs: r.age || 0 };
}

async function ztApiProductsFetch(cfg, opts = {}) {
  const programs = await ztApiPrograms(cfg).catch(() => ({}));
  const byId = new Map();
  const fetchList = (qs) => ztApiPaged(
    cfg,
    (page, n) => `api.php/v1/products?limit=${n}&page=${page}${qs}`,
    'products',
  );

  // 只发一种参数。
  // 1.24.13 实测：status=all / browseType=all / 不传 三者返回完全一致（31/31），
  // 说明这个版本对不认识的参数是**静默忽略** —— 逐个跑只是白打 3 倍请求、多等两轮往返。
  // 保留 `status=all` 是因为它语义最全（认它的版本能多拿已关闭产品）；
  // 旧版禅道若对未知参数回 4xx，退回不带参数的请求。
  let total = 0;
  let truncated = false;
  const take = (r) => {
    total = Math.max(total, r.total || 0);
    if (r.truncated) truncated = true;
    for (const p of r.items) {
      if (p && p.id != null && !byId.has(String(p.id))) byId.set(String(p.id), p);
    }
  };
  try {
    take(await fetchList('&status=all'));
  } catch {
    take(await fetchList(''));
  }

  // 网页兜底：只在 REST **一条都没返回**时才用（权限异常/接口改版的极端情况）。
  // 1.24.13 实测它只解析出 20 条（列表默认每页 20）且全是 REST 的子集，补不进任何东西；
  // 每次拉取都跑一遍等于白等一次往返，所以降级为「REST 空手而归」时的最后手段。
  let htmlAdded = 0;
  if (byId.size === 0) {
    for (const [id, p] of await ztHtmlProducts(cfg)) {
      if (!byId.has(id)) { byId.set(id, p); htmlAdded++; }
    }
  }

  // 真正的补全手段：按 id 单查。
  // 实测该实例列表只回 31 个、单查能拿到另外 11 个（含 69）；按项目集拉（program=N）
  // 也试过 16 个项目集、0 个新增，说明列表接口的过滤与项目集无关 —— 单查是唯一可靠来源。
  // 已试点 id 的结论缓存 6 小时，第二次拉取几乎不发请求。
  let probedAdded = 0;
  const probe = await ztProbeMissingProducts(cfg, [...byId.values()], { fresh: !!opts.fresh })
    .catch(() => ({ list: [] }));
  for (const p of probe.list) {
    if (!byId.has(p.id)) { byId.set(p.id, p); probedAdded++; }
  }
  console.log(`[zentao] products: total=${total} got=${byId.size}`
    + ` | probe+${probedAdded}${htmlAdded ? ` html+${htmlAdded}` : ''}`
    + ` (requested=${probe.requested || 0} reused=${probe.reused || 0})`);

  const items = [...byId.values()];
  const map = {};
  for (const p of items) map[String(p.id)] = ztStripTags(p.name || '');
  ztProductCache.set(ztApiCacheKey(cfg), { at: Date.now(), map });

  const data = items.map(p => ({
    id: String(p.id),
    // 名称被清洗为空也保留条目（以前 .filter(p => p.name) 会静默丢项目）
    name: ztStripTags(p.name || '') || `产品 ${p.id}`,
    status: String(p.status || ''),
    program: String(p.program || ''),
    programName: programs[String(p.program || '')] || '',
    // 必须透传：前端靠它决定「下次拉取时要不要保留这一条」（漏传的话 69 补了也会被冲掉）
    ...(p.manual ? { manual: true } : {}),
  }));
  console.log(`[zentao] products merged total=${total} got=${data.length}`
    + ` ids=${data.map(p => p.id).join(',').slice(0, 400)}`);
  // 若 program 全是 0，说明接口只给「不属于任何项目集」的产品——那样挂在项目集下的
  // 产品（如 69）会整批消失，需要改成按项目集逐个拉。
  const progDist = {};
  for (const p of data) { const k = p.program || '0'; progDist[k] = (progDist[k] || 0) + 1; }
  console.log(`[zentao] products programs=${JSON.stringify(progDist)}`);
  return {
    data,
    total: Math.max(total, data.length),
    truncated: truncated || data.length < total,
    // 界面提示用：这次补回几个、接口报的总数和实际拿到多少
    probedAdded,
    reportedTotal: total,
  };
}

/** 兼容原有调用点（my-bugs / all-bugs / project-bugs 都要数组） */
async function ztApiProducts(cfg, opts = {}) {
  return (await ztApiProductsDetailed(cfg, opts)).data;
}

/**
 * REST 的 bug → 渲染层结构。
 * moduleMap 是「模块 id → 模块路径」，只有汇总统计需要（禅道 REST 不返回模块名，
 * 得另外从 tree-ajaxGetOptionMenu 拿），普通列表不传就是空字符串。
 */
function ztMapApiBug(b, nameMap, moduleMap) {
  const mid = String(b.module == null ? '' : b.module);
  return {
    id: String(b.id || ''),
    title: ztStripTags(b.title || ''),
    status: String(b.status || ''),
    severity: String(b.severity || ''),
    pri: String(b.pri || ''),
    type: String(b.type || ''),
    product: String(b.product || ''),
    productName: nameMap[String(b.product)] || '',
    assignedTo: ztUserName(b.assignedTo),
    openedBy: ztUserName(b.openedBy),
    assignedToAccount: ztUserAccount(b.assignedTo),
    openedByAccount: ztUserAccount(b.openedBy),
    date: ztApiLocalTime(b.openedDate).slice(0, 10),
    deadline: b.deadline ? String(b.deadline).slice(0, 10) : '',
    resolution: String(b.resolution || ''),
    module: mid,
    moduleName: (moduleMap && moduleMap[mid]) || '',
    // 汇总里的「近 7 天新增 / 修复」要用到（REST 给的是 UTC，这里统一转本地时间）
    openedDate: ztApiLocalTime(b.openedDate),
    resolvedDate: ztApiLocalTime(b.resolvedDate),
    closedDate: ztApiLocalTime(b.closedDate),
  };
}

/** 禅道 REST 的时间是 ISO（带 Z），转成本地 YYYY-MM-DD HH:mm；空值返回空串 */
function ztApiLocalTime(v) {
  if (!v) return '';
  const s = String(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 19).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}


/** 模块 id → 模块路径（取项目下 bug 模块树；需要 HTML 会话，失败只返回空表） */
async function ztFetchModuleNames(cfg, productId) {
  const out = {};
  try {
    const login = await ztEnsureLogin(cfg);
    if (!login.ok) return out;
    const page = await ztFetch(cfg, `tree-ajaxGetOptionMenu-${encodeURIComponent(productId)}-bug.html`);
    if (page.status !== 200 || !page.text) return out;
    const json = ztParseJson(page.text);
    const items = (json && Array.isArray(json.items)) ? json.items : [];
    for (const it of items) {
      const id = String(it.value == null ? '' : it.value);
      const text = String(it.text || '').replace(/^\//, '').trim();
      if (id && text && text !== '/') out[id] = text;
    }
  } catch { /* 模块名拿不到不影响统计主流程 */ }
  return out;
}

ipcMain.handle('zentao:projects', async (_event, payload) => {
  // 兼容两种调用：直接传 cfg（老脚本/渲染层），或 { ...cfg, fresh } —— fresh 表示用户主动刷新
  const { fresh, ...cfgIn } = payload || {};
  let cfg = cfgIn;
  if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
    return { success: false, error: '请先填写地址、账号和密码' };
  }
  cfg = ztNormalizeCfg(cfg);
  try {
    const { data, total, truncated, cached, ageMs, probedAdded, reportedTotal } =
      await ztApiProductsDetailed(cfg, { fresh: !!fresh });
    return {
      success: true,
      data,
      total,
      // 界面据此显示「来自缓存（N 秒前）」还是「刚更新」，不然点了刷新看不出任何区别
      cached: !!cached,
      ageMs: Number(ageMs) || 0,
      probedAdded: Number(probedAdded) || 0,
      reportedTotal: Number(reportedTotal) || 0,
      // 翻到上限仍没拉满时显式告警，避免像以前那样静默少项目还以为是全部
      warning: truncated ? `项目列表可能不完整：禅道报告共 ${total} 个，已拉取 ${data.length} 个` : undefined,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/**
 * 单查一个产品（「手动补项目」用）。
 * 有的禅道版本 products 列表接口不返回已关闭/私有产品，但单查详情能拿到真名；
 * 单查也失败时返回仅带 id 的占位条目 —— 用户既然手动填了编号，说明他确认这个项目存在，
 * 至少要能拿它的 Bug。
 */
ipcMain.handle('zentao:product-probe', async (_event, payload = {}) => {
  let { cfg, productId } = payload || {};
  const id = String(productId || '').trim();
  if (!id) return { success: false, error: '请填写产品编号' };
  if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
    return { success: false, error: '请先填写地址、账号和密码' };
  }
  cfg = ztNormalizeCfg(cfg);
  // 手动补进来的项目一律标 manual=true：优先展示、且下次「拉取项目」时不被列表覆盖掉。
  try {
    const json = await ztApiGet(cfg, `api.php/v1/products/${encodeURIComponent(id)}`);
    // 这段日志是定位「list 接口为什么不返回它」的唯一线索：
    // 单查能拿到说明 REST 层有权限，那 list 少它只可能是状态/项目集/删除标记在过滤。
    console.log(`[zentao] product probe ${id} ok: status=${json.status || ''}`
      + ` acl=${json.acl || ''} program=${json.program || ''} deleted=${json.deleted || ''}`);
    return {
      success: true,
      data: {
        id: String(json.id || id),
        name: ztStripTags(json.name || '') || `产品 ${id}`,
        status: String(json.status || ''),
        program: String(json.program || ''),
        programName: '',
        manual: true,
      },
    };
  } catch (e) {
    console.log(`[zentao] product probe ${id} failed: ${e.message}`);
    return {
      success: true,
      data: { id, name: `产品 ${id}`, status: '', program: '', programName: '', manual: true },
    };
  }
});

/**
 * 某个产品（项目）下的全部 Bug，不分指派人。
 * 与 zentao:all-bugs 保持同一套缓存策略（10 分钟 + force 绕过），
 * 否则「单项目」每次实时拉、「全部项目」命中缓存，两个视图的数字会不一致。
 */
const ztProjectBugsCache = new Map();
const ZT_PROJ_TTL = 10 * 60 * 1000;

ipcMain.handle('zentao:project-bugs', async (_event, payload = {}) => {
  let { cfg, productId, force } = payload || {};
  if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
    return { success: false, error: '请先填写地址、账号和密码' };
  }
  if (!productId) return { success: false, error: '请选择项目' };
  cfg = ztNormalizeCfg(cfg);

  const cacheKey = `${cfg.baseUrl}|${cfg.account}|${productId}`;
  const hit = ztProjectBugsCache.get(cacheKey);
  if (!force && hit && Date.now() - hit.at < ZT_PROJ_TTL) {
    return { success: true, ...hit.value, cached: true, ageMs: Date.now() - hit.at };
  }

  try {
    const key = ztApiCacheKey(cfg);
    let nameMap = ztProductCache.get(key);
    if (!nameMap) {
      await ztApiProducts(cfg);
      nameMap = ztProductCache.get(key) || {};
    }
    // 模块名与 Bug 并行取：模块接口要 HTML 会话，失败只影响「模块」列显示
    const modPromise = ztFetchModuleNames(cfg, productId);
    // ⚠️ 不带 status=all 时 REST 只返回「未关闭」的，含已关闭必须显式传 all
    // 分页走通用聚合器（1.24.14）：以前是 `ceil(total/1000)` 算页数 + 写死 5 页上限，
    // 一旦服务端把 limit 压到 20，44 条 Bug 只会请求 1 页、拿到 20 条还「看起来正常」。
    const paged = await ztApiPaged(
      cfg,
      (page, n) => `api.php/v1/bugs?product=${encodeURIComponent(productId)}&status=all&limit=${n}&page=${page}`,
      'bugs',
    );
    const bugs = paged.items;
    const total = paged.total;
    const modules = await modPromise;
    const data = bugs.map(b => ztMapApiBug(b, nameMap, modules)).filter(b => b.id);
    const value = {
      data, total, fetchedAt: new Date().toISOString(),
      ...(paged.truncated ? { truncated: true, got: data.length } : {}),
    };
    ztProjectBugsCache.set(cacheKey, { at: Date.now(), value });
    // 项目多时缓存会攒不少，只留最近 6 份
    if (ztProjectBugsCache.size > 6) {
      const oldest = [...ztProjectBugsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) ztProjectBugsCache.delete(oldest[0]);
    }
    return { success: true, ...value, cached: false, ageMs: 0 };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/** 所有项目（产品）的全部 Bug —— 用于「全部」视图看总数与跨项目统计 */
// 全量 Bug 缓存：切项目/切页回来不必重新拉 31 个产品（TTL 10 分钟，force 可绕过）
const ztAllBugsCache = new Map();
const ZT_ALL_TTL = 10 * 60 * 1000;

ipcMain.handle('zentao:all-bugs', async (_event, cfg, opts = {}) => {
  if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
    return { success: false, error: '请先填写地址、账号和密码' };
  }
  cfg = ztNormalizeCfg(cfg);
  const cacheKey = `${cfg.baseUrl}|${cfg.account}`;
  const hit = ztAllBugsCache.get(cacheKey);
  if (!(opts && opts.force) && hit && Date.now() - hit.at < ZT_ALL_TTL) {
    return { success: true, ...hit.value, cached: true, ageMs: Date.now() - hit.at };
  }
  try {
    const key = ztApiCacheKey(cfg);
    // 强制刷新时连产品清单也重拉：否则 60 秒缓存里没有的新产品会漏掉其 Bug
    const products = await ztApiProducts(cfg, { fresh: !!opts.force });
    const nameMap = ztProductCache.get(key) || {};
    const queue = products.slice();
    const collected = [];
    let reported = 0;
    const failed = [];

    const worker = async () => {
      for (;;) {
        const p = queue.shift();
        if (!p) return;
        try {
          // 分页交给通用聚合器：按 total 翻页，不受服务端压低 limit 影响（原来写死 5 页）
          const r = await ztApiPaged(
            cfg,
            (page, n) => `api.php/v1/bugs?product=${encodeURIComponent(p.id)}&status=all&limit=${n}&page=${page}`,
            'bugs',
          );
          reported += r.total;
          for (const b of r.items) collected.push(b);
        } catch (e) {
          // 单个项目失败不该让整个「全部」视图挂掉，但要留下痕迹供排查
          failed.push(`${p.id}: ${e.message}`);
        }
      }
    };
    // 8 个并发：42 个项目（含 9 个已关闭）大约 3~5 秒
    await Promise.all(Array.from({ length: 8 }, worker));

    const seen = new Map();
    for (const b of collected) {
      const id = String(b.id || '');
      if (id && !seen.has(id)) seen.set(id, b);
    }
    const data = [...seen.values()]
      .map(b => ztMapApiBug(b, nameMap))
      .filter(b => b.id)
      .sort((a, b) => Number(b.id) - Number(a.id));
    // total 用去重后的实际条数，避免和表格行数不一致（reported 仅作参考）
    const value = {
      data, total: data.length, reported, products: products.length,
      ...(failed.length ? { failed } : {}),
      fetchedAt: new Date().toISOString(),
    };
    if (failed.length) {
      console.log(`[zentao] all-bugs: ${failed.length}/${products.length} 个项目拉取失败 → ${failed.slice(0, 5).join(' | ')}`);
    }
    ztAllBugsCache.set(cacheKey, { at: Date.now(), value });
    return { success: true, ...value, cached: false, ageMs: 0 };
  } catch (e) {
    return { success: false, error: e.message };
  }
});



/**
 * 多项目缺陷汇总：一次拉取选中项目的全部 Bug（含已关闭）+ 每个项目的模块名。
 * 统计口径放在渲染层做（排除人员可随时改，不用重新拉数据）。
 */
const ztSummaryCache = new Map();
const ZT_SUM_TTL = 10 * 60 * 1000;
// 一次汇总可能几百 KB～几 MB（全量 Bug 数组），条目不能无限堆：
// 只留最近 4 份，顺手清掉过期项（用户反复换项目组合时 Map 会一直长）。
const ZT_SUM_MAX = 4;
function ztSummaryPrune() {
  const now = Date.now();
  for (const [k, v] of ztSummaryCache) {
    if (now - v.at >= ZT_SUM_TTL) ztSummaryCache.delete(k);
  }
  while (ztSummaryCache.size > ZT_SUM_MAX) {
    const oldest = [...ztSummaryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    ztSummaryCache.delete(oldest[0]);
  }
}

/**
 * 拉一个实例下选中项目的全量 Bug（含已关闭）+ 模块名。
 * 抽成普通函数，是为了让「跨实例汇总」能复用同一套分页/重试/缓存逻辑，
 * 而不是复制一份出来两边各自演化（1.21.4 那次回归就是这么来的）。
 */
async function ztSummaryOf(cfg, productIds, opts = {}) {
  if (!cfg || !cfg.baseUrl || !cfg.account || !cfg.password) {
    return { success: false, error: '请先填写地址、账号和密码' };
  }
  cfg = ztNormalizeCfg(cfg);
  const ids = (Array.isArray(productIds) ? productIds : []).map(x => String(x)).filter(Boolean);
  if (ids.length === 0) return { success: false, error: '请先选择要汇总的项目' };

  const cacheKey = `${cfg.baseUrl}|${cfg.account}|${ids.slice().sort().join(',')}`;
  const hit = ztSummaryCache.get(cacheKey);
  if (!(opts && opts.force) && hit && Date.now() - hit.at < ZT_SUM_TTL) {
    return { success: true, ...hit.value, cached: true, ageMs: Date.now() - hit.at };
  }

  try {
    const key = ztApiCacheKey(cfg);
    let nameMap = ztProductCache.get(key);
    if (!nameMap) {
      await ztApiProducts(cfg);
      nameMap = ztProductCache.get(key) || {};
    }

    const queue = ids.slice();
    const collected = [];
    const modules = {};
    const errors = [];

    const worker = async () => {
      for (;;) {
        const pid = queue.shift();
        if (!pid) return;
        // 单个产品失败重试一次：偶发超时不该让整个汇总缺一个项目
        for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 模块名与 Bug 并行取：模块接口失败不影响 Bug
          const modPromise = ztFetchModuleNames(cfg, pid);
          // 按 total 翻页（原来写死 5 页 = 5000 条）；服务端压 limit 时也不会少拿
          const r = await ztApiPaged(
            cfg,
            (page, n) => `api.php/v1/bugs?product=${encodeURIComponent(pid)}&status=all&limit=${n}&page=${page}`,
            'bugs',
          );
          modules[pid] = await modPromise;
          for (const b of r.items) collected.push(b);
          if (r.truncated) errors.push(`${pid}: 只拉到 ${r.items.length}/${r.total} 条`);
          break;
        } catch (e) {
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          errors.push(`${pid}: ${e.message}`);
        }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));

    // 同一个 Bug 可能因为跨项目关联被重复返回，按 id 去重
    const seen = new Map();
    for (const b of collected) {
      const id = String(b.id || '');
      if (id && !seen.has(id)) seen.set(id, b);
    }
    const data = [...seen.values()]
      .map(b => ztMapApiBug(b, nameMap, modules[String(b.product)] || {}))
      .filter(b => b.id)
      .sort((a, b) => Number(b.id) - Number(a.id));

    const value = {
      data,
      total: data.length,
      modules,
      productIds: ids,
      fetchedAt: new Date().toISOString(),
      errors,
    };
    ztSummaryCache.set(cacheKey, { at: Date.now(), value });
    ztSummaryPrune();
    return { success: true, ...value, cached: false, ageMs: 0 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

ipcMain.handle('zentao:summary', (_event, cfg, productIds = [], opts = {}) =>
  ztSummaryOf(cfg, productIds, opts));

/**
 * 跨实例汇总：一次拉多家公司的禅道，返回带实例标签的合并数据。
 * 统计口径仍放渲染层（周报模板、时间窗、排除人员都要能随时改而不重拉）。
 *
 * @param {{id:string,name:string,cfg:object,productIds:string[]}[]} targets
 * @param {{force?:boolean}} opts
 */
ipcMain.handle('zentao:summary-multi', async (_event, targets, opts = {}) => {
  const list = (Array.isArray(targets) ? targets : []).filter(t => t && t.cfg);
  if (!list.length) return { success: false, error: '没有可用的禅道实例' };

  const groups = [];
  const failed = [];
  // 实例之间串行：单个实例内部已经有 4 个并发 worker，再按实例叠加会把对端打满；
  // 不同公司网络差异也大，串行才能给出稳定的进度。
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const name = String(t.name || t.cfg.account || t.cfg.baseUrl || '未命名');
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
      getMainWindow().webContents.send('zentao:digest-progress', {
        phase: 'fetch', index: i + 1, total: list.length, name,
      });
    }
    const r = await ztSummaryOf(t.cfg, t.productIds, opts);
    if (!r || !r.success) {
      failed.push({ instanceId: String(t.id || ''), name, error: (r && r.error) || '拉取失败' });
      groups.push({
        instanceId: String(t.id || ''), name,
        baseUrl: String(t.cfg.baseUrl || ''),
        ok: false, error: (r && r.error) || '拉取失败',
        bugs: [], modules: {}, productIds: [],
      });
      continue;
    }
    // 每条打上来源实例，渲染层才能按公司分组。产品 id 在不同禅道里会重名
    // （都是 1、2、3…），所以对外用 `实例id::产品id` 复合键。
    const bugs = (Array.isArray(r.data) ? r.data : []).map(b => ({
      ...b,
      instanceId: String(t.id || ''),
      instanceName: name,
      key: `${String(t.id || '')}::${String(b.product || '')}`,
    }));
    groups.push({
      instanceId: String(t.id || ''), name,
      baseUrl: String(t.cfg.baseUrl || ''),
      ok: true, error: '',
      bugs,
      modules: r.modules || {},
      productIds: r.productIds || [],
      errors: r.errors || [],
    });
  }

  return {
    success: true,
    groups,
    failed,
    fetchedAt: new Date().toISOString(),
    total: groups.reduce((n, g) => n + g.bugs.length, 0),
  };
});
  return {
    loadSeen: ztLoadSeen,
    pushUnread: ztPushUnread,
    restartNotify: ztRestartNotify,
    getUnread: () => ztUnread,
  };
}

module.exports = { registerZentaoIpc };
