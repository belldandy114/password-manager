'use strict';

/**
 * 应用内更新（update:download / update:pick-file / update:install）。
 *
 * 从 main.js 的 setupIpcHandlers() 里搬出来，逐行保持原逻辑不变：
 *   - 下载走 Chromium 的 net（能跟随系统代理），单连接是默认行为，多线程必须用户显式点；
 *   - 安装包只执行「本次下载的」或「用户经对话框选中的」exe，其余一律拒绝；
 *   - allowedInstallFiles 是白名单，随模块搬进来（原来在 main.js 模块作用域）。
 *
 * ⚠️ 别把 updateDir() 改回 %TEMP%：杀软会把「非浏览器进程在临时目录生成 exe」判成木马。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, ipcMain, dialog, net, session } = require('electron');

const allowedInstallFiles = new Set();

function registerUpdateIpc(deps) {
  const { loadSettings, proxyLabel, getMainWindow } = deps;

  /** 拉取最新 Release 元数据（update:check 与启动时自动检查共用） */

  /** 应用内更新：下载安装包并重启安装 ---- */
  /**
   * ⚠️ 不再内置 ghfast.top / gh-proxy.com 这类公共免费代理：2026-11 实测
   * ghfast.top 走代理直接连不上、gh-proxy.com 只有 1.6 KB/s，直连也只有 50~173 KB/s，
   * 点「换镜像」只会更慢。改成「可选的自定义源」：用户/IT 可以在设置里填自己的
   * 国内直链前缀（updateMirrorUrl），或用 PM_UPDATE_MIRROR 环境变量指定；没配就只走 GitHub。
   */
  function updateMirrorBase() {
    try {
      const fromEnv = String(process.env.PM_UPDATE_MIRROR || '').trim();
      const s = loadSettings() || {};
      const raw = fromEnv || String(s.updateMirrorUrl || '').trim();
      // 只接受干净的 http(s) 前缀：拼在下载地址前面，不能带空格/引号/尖括号
      return /^https?:\/\/[^\s"'<>]+$/i.test(raw) ? raw.replace(/\/+$/, '') : '';
    } catch { return ''; }
  }

  /**
   * 用 Chromium 网络栈下载（Electron net）：
   * Node 的 fetch(undici) 不读系统代理，遇到代理/证书拦截就只报一句 "fetch failed"；
   * net 走 Chromium，能跟随系统代理设置，也能拿到更具体的错误。
   */
  /**
   * 单连接下载（默认行为，和 1.21.3 一致）。
   * ⚠️ 这里**永远不要**加「慢速 / 无数据就自动中止并切分片」：1.21.4 那么做过，
   * 结果把公司环境里只是中途停顿的正常下载误杀，分片目录又触发杀软导致 ENOENT。
   * 只有 30 分钟总超时；要并行必须由用户在界面上显式点「多线程加速」。
   * 默认行为由 scripts/ui-round9-test.js 的慢速用例锁住，别只改这里不改测试。
   */
  function netDownload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const fin = (fn, arg) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(arg);
      };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch (e) {
        reject(e);
        return;
      }
      timer = setTimeout(() => {
        try { request.abort(); } catch { /* 忽略 */ }
        fin(reject, new Error('下载超时（30 分钟无响应）'));
      }, 30 * 60 * 1000);

      request.setHeader('User-Agent', 'password-manager-app');
      request.on('response', (response) => {
        const status = response.statusCode;
        if (status >= 400) {
          try { response.resume(); } catch { /* 忽略 */ }
          fin(reject, new Error(`HTTP ${status}`));
          return;
        }
        const total = Number(response.headers['content-length'] || 0);
        const out = fs.createWriteStream(file);
        // 磁盘满 / 杀软锁文件 / 目录被删都会触发这里；不监听会变成未处理的 'error' 事件，
        // 把整次更新（甚至主进程）打挂。并行路径 netDownloadRange 早已有同样的保护。
        out.on('error', (e) => {
          try { request.abort(); } catch { /* 忽略 */ }
          fin(reject, e);
        });
        let received = 0;
        let lastEmit = 0;
        let windowBytes = 0;
        let windowAt = Date.now();
        let speed = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          windowBytes += chunk.length;
          if (!out.write(chunk)) {
            try {
              response.pause();
              out.once('drain', () => response.resume());
            } catch { /* 忽略 */ }
          }
          const now = Date.now();
          if (now - lastEmit >= 200) {
            const dt = (now - windowAt) / 1000;
            if (dt >= 0.5) { speed = windowBytes / dt; windowBytes = 0; windowAt = now; }
            lastEmit = now;
            onProgress(received, total, speed);
          }
        });
        response.on('end', () => {
          out.end(() => fin(resolve, { size: received, total, speed, threads: 1 }));
        });
        response.on('error', (e) => {
          out.destroy();
          fin(reject, e);
        });
      });
      request.on('error', (e) => fin(reject, e));
      request.end();
    });
  }

  /**
   * 单段 Range 下载（并行下载的一个分片）。
   * 返回实际写入的字节数；中途断线由调用方决定是否重试。
   */
  function netDownloadRange(url, start, end, dest, onChunk) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fin = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => {
        try { request.abort(); } catch { /* 忽略 */ }
        fin(reject, new Error(`分片 ${start}-${end} 超时`));
      }, 15 * 60 * 1000);

      request.setHeader('User-Agent', 'password-manager-app');
      request.setHeader('Range', `bytes=${start}-${end}`);
      request.on('response', (response) => {
        if (response.statusCode >= 400) {
          clearTimeout(timer);
          try { response.resume(); } catch { /* 忽略 */ }
          fin(reject, new Error(`HTTP ${response.statusCode}`));
          return;
        }
        // 分片目录可能被杀软整个隔离/删除，写之前重建一次；写流错误也要接住，
        // 否则 fs.createWriteStream 的 ENOENT 会变成未处理异常把整次下载打挂。
        try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* 忽略 */ }
        const out = fs.createWriteStream(dest);
        out.on('error', (e) => {
          clearTimeout(timer);
          fin(reject, e);
        });
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          onChunk(chunk.length);
          if (!out.write(chunk)) {
            try {
              response.pause();
              out.once('drain', () => response.resume());
            } catch { /* 忽略 */ }
          }
        });
        response.on('end', () => {
          clearTimeout(timer);
          out.end(() => fin(resolve, received));
        });
        response.on('error', (e) => {
          clearTimeout(timer);
          out.destroy();
          fin(reject, e);
        });
      });
      request.on('error', (e) => { clearTimeout(timer); fin(reject, e); });
      request.end();
    });
  }

  /** 探测文件大小与是否支持 Range（用 0-0 的 GET，比 HEAD 靠谱） */
  function netProbe(url) {
    return new Promise((resolve) => {
      let settled = false;
      const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
      let request;
      try {
        request = net.request({ url, redirect: 'follow' });
      } catch {
        fin({ ok: false });
        return;
      }
      const timer = setTimeout(() => { try { request.abort(); } catch { /* 忽略 */ } fin({ ok: false }); }, 20000);
      request.setHeader('User-Agent', 'password-manager-app');
      request.setHeader('Range', 'bytes=0-0');
      request.on('response', (response) => {
        clearTimeout(timer);
        const cr = String(response.headers['content-range'] || '');
        const m = cr.match(/bytes\s+\d+-\d+\/(\d+)/i);
        const total = m ? Number(m[1]) : 0;
        try { response.resume(); } catch { /* 忽略 */ }
        fin({ ok: response.statusCode === 206 && total > 0, total });
      });
      request.on('error', () => { clearTimeout(timer); fin({ ok: false }); });
      request.end();
    });
  }

  /** 顺序拼片 */
  function concatFiles(parts, dest) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let i = 0;
      const next = () => {
        if (i >= parts.length) {
          out.end(() => resolve());
          return;
        }
        const rs = fs.createReadStream(parts[i++]);
        rs.on('error', (e) => { out.destroy(); reject(e); });
        rs.on('end', next);
        rs.pipe(out, { end: false });
      };
      out.on('error', reject);
      next();
    });
  }

  /**
   * 多线程分段下载：GitHub 的 CDN 单连接常被限速（几十 KB/s），
   * 而它支持 Range —— 拆成 N 段并发，速度大致线性提升。
   * 任何一段失败都会重试该段（最多 2 次），整体不支持 Range 时由调用方回退单连接。
   */
  async function netDownloadParallel(url, file, onProgress, threads = 6, partsDir = '') {
    const probe = await netProbe(url);
    if (!probe.ok || probe.total < 4 * 1024 * 1024) {
      return { fallback: true };
    }
    const total = probe.total;
    const n = Math.max(2, Math.min(8, threads));
    const chunk = Math.ceil(total / n);
    const parts = [];
    const ranges = [];
    // 分片放独立目录、用 .bin 后缀：不要叫 xxx.exe.part0 —— 那等于在告诉杀软「这是 exe 的一段」
    const dir = partsDir || path.dirname(file);
    // 目录可能不存在（或已被杀软删掉），先重建，避免 chunk-0.bin ENOENT
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      if (start >= total) break;
      const end = Math.min(total - 1, start + chunk - 1);
      const part = path.join(dir, `chunk-${i}.bin`);
      ranges.push({ start, end, part });
      parts.push(part);
    }

    let received = 0;
    let lastEmit = 0;
    let windowBytes = 0;
    let windowAt = Date.now();
    let speed = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 150) return;
      const dt = (now - windowAt) / 1000;
      if (dt >= 0.5) {
        speed = windowBytes / dt;
        windowBytes = 0;
        windowAt = now;
      }
      lastEmit = now;
      onProgress(received, total, speed);
    };

    const results = await Promise.all(ranges.map(async (r) => {
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let written = 0;
        try {
          written = await netDownloadRange(url, r.start, r.end, r.part, (len) => {
            received += len;
            windowBytes += len;
            emit();
          });
        } catch (e) {
          lastErr = e;
          received -= written;
          windowBytes -= written;
          try { fs.unlinkSync(r.part); } catch { /* 忽略 */ }
          continue;
        }
        const expect = r.end - r.start + 1;
        if (written !== expect) {
          lastErr = new Error(`分片大小不符（${written}/${expect}）`);
          received -= written;
          windowBytes -= written;
          try { fs.unlinkSync(r.part); } catch { /* 忽略 */ }
          continue;
        }
        return true;
      }
      throw lastErr || new Error('分片下载失败');
    }));

    if (results.every(Boolean)) {
      await concatFiles(parts, file);
      parts.forEach(p => { try { fs.unlinkSync(p); } catch { /* 忽略 */ } });
      emit(true);
      return { size: total, total, threads: n, speed };
    }
    parts.forEach(p => { try { fs.unlinkSync(p); } catch { /* 忽略 */ } });
    return { fallback: true };
  }

  /**
   * 更新包落盘目录。
   * ⚠️ 不要用 %TEMP%：杀软对「非浏览器进程在临时目录里生成/改写 exe」的启发式很强，
   * 360/火绒会直接判 Trojan/Injector 并删文件（2026-10-29 实测）。
   * 放到应用自己的目录，并且用 GitHub 上的真实文件名，行为跟普通下载器一致。
   */
  function updateDir() {
    const dir = path.join(app.getPath('userData'), 'update');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
    return dir;
  }

  /** 从下载地址取官方资产名（取不到就用兜底名），只保留安全字符 */
  function assetFileName(url, fallback) {
    let name = '';
    try {
      name = decodeURIComponent(path.basename(new URL(url).pathname));
    } catch { /* 非法地址，用兜底名 */ }
    name = String(name || '').replace(/[^\w.\-]+/g, '_');
    if (!/\.exe$/i.test(name)) name = fallback;
    return name;
  }

  /** 文件的 SHA-256（流式，96MB 也不吃内存） */
  function sha256File(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(file);
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    });
  }

  ipcMain.handle('update:download', async (event, { url, useMirror, expectedSha256, threads } = {}) => {
    if (!url) return { success: false, error: '没有可用的下载地址' };

    const dir = updateDir();
    const name = assetFileName(url, `PasswordManager-Setup-${app.getVersion()}-new.exe`);
    const finalFile = path.join(dir, name);
    // 先写到 .partial 再改名：避免"边写边被扫"时留下半成品，也让最终文件出现在磁盘上是完整的
    const partial = `${finalFile}.partial`;
    // useMirror 现在表示「加速重试」；threads 是设置页里的多线程开关。两者才启用 6 分片并行。
    const accelerate = useMirror === true || threads === true;
    // parts-* 目录只在用户显式启用并行时才建：一堆分片文件是杀软最敏感的「释放器」特征，
    // 默认单连接也建空目录纯属多余的敏感行为（1.21.4 的 ENOENT 就是从这里开始的）。
    const partsDir = accelerate ? path.join(dir, `parts-${Date.now()}`) : '';
    const cleanup = () => {
      try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* 忽略 */ }
      if (partsDir) {
        try { fs.rmSync(partsDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      }
    };

    // 先诊断链路：这个下载地址在 Chromium 里到底是走代理还是直连。
    // 家里「开了 VPN 还是很慢」多半就是这里显示「直连」——分流规则没命中 githubusercontent。
    let proxy = '';
    try { proxy = String(await session.defaultSession.resolveProxy(url) || '').trim(); } catch { /* 忽略 */ }
    const link = proxyLabel(proxy);
    const sendProgress = (received, total, speed, th) => {
      try { event.sender.send('update:progress', { received, total, speed, threads: th, proxy, link }); }
      catch { /* 窗口已关 */ }
    };
    sendProgress(0, 0, 0, 0);

    // 默认只走 GitHub；只有配置了自定义国内源（设置 updateMirrorUrl / PM_UPDATE_MIRROR）才多一个候选。
    // ghfast.top / gh-proxy.com 已移除：实测 0 B/s 与 1.6 KB/s，点了只会更慢。
    const mirror = updateMirrorBase();
    const targets = mirror
      ? [{ label: '自定义源', url: `${mirror}/${url}` }, { label: 'GitHub', url }]
      : [{ label: 'GitHub', url }];

    const errors = [];
    // accelerate 已在上面算好（parts-* 目录是否创建依赖它）。

    for (const t of targets) {
      try {
        let r = null;
        if (accelerate) {
          // 只有用户显式点「加速重试」/ 勾多线程才并行；失败必须能回退单连接
          try {
            const p = await netDownloadParallel(t.url, partial, (received, total, speed) => sendProgress(received, total, speed, 6), 6, partsDir);
            if (!p.fallback) r = { size: p.total, threads: p.threads };
          } catch (e) {
            errors.push(`${t.label}：多线程失败（${e.message || '连接被中断'}），改用单连接`);
          }
        }
        if (!r) {
          try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* 忽略 */ }
          // 默认纯单连接（回到 1.21.3 的行为）：1.21.4 的「60 秒无数据自动切 6 分片」
          // 会把公司环境里只是中途停顿的正常下载误杀，分片目录又容易触发杀软导致 ENOENT。
          // 慢速时由用户在界面上点「太慢？多线程加速」自行决定，不自动切。
          r = await netDownload(t.url, partial, (received, total, speed) => sendProgress(received, total, speed, 1));
        }

        if (!r || r.size < 1024 * 1024) {
          cleanup();
          errors.push(`${t.label}：文件过小（${Math.round((r ? r.size : 0) / 1024)} KB）`);
          continue;
        }

        try { if (fs.existsSync(finalFile)) fs.unlinkSync(finalFile); } catch { /* 忽略 */ }
        fs.renameSync(partial, finalFile);

        // 官方 SHA-256 校验：镜像站/代理有可能改包，校验不过就不用
        const sha256 = await sha256File(finalFile);
        let verified = false;
        if (expectedSha256) {
          const want = String(expectedSha256).replace(/^sha256:/i, '').trim().toLowerCase();
          if (sha256 !== want) {
            try { fs.unlinkSync(finalFile); } catch { /* 忽略 */ }
            cleanup();
            errors.push(`${t.label}：SHA-256 校验不通过（下载 ${sha256.slice(0, 12)}…，预期 ${want.slice(0, 12)}…）`);
            continue;
          }
          verified = true;
        }

        cleanup();
        allowedInstallFiles.add(path.resolve(finalFile));
        return {
          success: true,
          data: { file: finalFile, name, size: r.size, via: t.label, threads: r.threads || 1, sha256, verified },
        };
      } catch (e) {
        errors.push(`${t.label}：${e.message || '连接被中断'}`);
        cleanup();
      }
    }

    cleanup();
    return {
      success: false,
      error: [
        '下载失败。',
        '可以：①点「浏览器下载」到发布页手动下；②已经下好了就点「选择安装包」；' + (accelerate ? '③换个网络再试。' : '③点「加速重试」（多线程并行）。'),
        `当前链路：${link}。若显示「直连」，请检查 VPN 分流规则是否放行 github.com 与 *.githubusercontent.com。`,
        '如果杀软弹了拦截（Trojan/Injector 之类），那是把「下载安装包」误判成释放器：添加信任或手动下载即可。',
        `（${errors.join('；')}）`,
      ].join(' '),
      canMirror: !accelerate,
      detail: errors.join('；'),
    };
  });

  /** 手动选已下载的安装包：网络实在下不动时的兜底 */
  ipcMain.handle('update:pick-file', async () => {
    try {
      const r = await dialog.showOpenDialog(getMainWindow(), {
        title: '选择下载好的安装包',
        properties: ['openFile'],
        filters: [{ name: '安装包', extensions: ['exe'] }],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { success: false, canceled: true };
      const f = r.filePaths[0];
      const st = fs.statSync(f);
      if (st.size < 10 * 1024 * 1024) {
        return { success: false, error: '这个文件不像是安装包（体积过小）' };
      }
      allowedInstallFiles.add(path.resolve(f));
      return { success: true, data: { file: f, size: st.size } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update:install', async (_event, { file, silent } = {}) => {
    try {
      if (!file || !fs.existsSync(file)) return { success: false, error: '安装包不存在，请重新下载' };
      // 只执行「本次下载的 / 用户经对话框选中的」exe，不接受渲染层传来的任意路径
      const resolved = path.resolve(String(file));
      const rel = path.relative(updateDir(), resolved);
      const inUpdateDir = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (!/\.exe$/i.test(resolved) || (!inUpdateDir && !allowedInstallFiles.has(resolved))) {
        return { success: false, error: '这个安装包不是本次下载或你选择的文件，已拒绝执行' };
      }
      // 自动化脚本用：只校验流程，不真的拉起安装程序、也不退出（否则截图跑一半应用就没了）
      if (process.env.PM_UPDATE_NO_INSTALL === '1') {
        return { success: true, data: { silent: false, skipped: true } };
      }
      // 默认走安装向导：能看清进度、能选目录。
      // ⚠️ 不要默认 /S 静默安装 —— 它会装到默认目录，跟用户自定义的安装路径变成两份。
      const args = silent ? ['/S', `/D=${path.dirname(app.getPath('exe'))}`] : [];
      spawn(resolved, args, { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 1200);
      return { success: true, data: { silent: !!silent } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerUpdateIpc, allowedInstallFiles };
