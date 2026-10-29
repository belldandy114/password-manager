/**
 * 没配置真实禅道时，起一个本地桩服务，让「断言 / 批量运行」这类纯 UI 回归
 * 依然能跑（不依赖内网地址，也不需要账号密码）。
 *
 * - `/zentao/user-login.html` → 200（模拟可访问的登录页）
 * - 其它路径 → 404（用来验证「断言失败」的分支）
 */
const http = require('http');
const ZT = require('./zt-config');

async function ensureZt(port = 9840) {
  if (ZT.ready) return { ZT, stub: false, stop: () => {} };

  const srv = http.createServer((req, res) => {
    const ok = /\/user-login\.html/.test(req.url || '');
    res.writeHead(ok ? 200 : 404, { 'Content-Type': ok ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
    res.end(ok ? '<html><body><form></form></body></html>' : 'not found');
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));

  ZT.baseUrl = `http://127.0.0.1:${port}/zentao`;
  ZT.base = ZT.baseUrl;
  ZT.account = 'stub-user';
  ZT.password = 'stub-pass';

  return { ZT, stub: true, stop: () => srv.close() };
}

module.exports = { ensureZt };
