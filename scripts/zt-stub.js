/**
 * 没配置真实禅道时的本地桩服务：让回归不依赖内网地址、也不需要账号密码。
 *
 * 提供：
 *   - GET  /zentao/user-login.html            → 200（round5 的断言用「可访问页面」）
 *   - POST /zentao/api.php/v1/tokens          → { token }
 *   - GET  /zentao/api.php/v1/products        → 两个产品
 *   - GET  /zentao/api.php/v1/bugs?openedBy=|assignedTo=|status= → 过滤后的 Bug 列表
 *
 * 请求日志放在返回值的 log 里，测试可以直接断言「应用到底带了哪些查询参数」。
 */
const http = require('http');
const ZT = require('./zt-config');

const PRODUCTS = [
  { id: 1, name: '桩项目A', status: 'normal' },
  { id: 2, name: '桩项目B', status: 'normal' },
];

const BUGS = [
  { id: 101, title: '我提交的-1', status: 'active', severity: '3', pri: '3', type: 'codeerror', product: 1, assignedTo: { account: 'other', realname: '别人' }, openedBy: { account: 'stub-user', realname: '桩用户' }, openedDate: '2026-10-20', resolution: '' },
  { id: 102, title: '我提交的-2', status: 'closed', severity: '4', pri: '4', type: 'codeerror', product: 2, assignedTo: { account: 'other', realname: '别人' }, openedBy: { account: 'stub-user', realname: '桩用户' }, openedDate: '2026-10-21', resolution: 'fixed' },
  { id: 103, title: '待我验证-1', status: 'resolved', severity: '2', pri: '2', type: 'codeerror', product: 1, assignedTo: { account: 'stub-user', realname: '桩用户' }, openedBy: { account: 'other', realname: '别人' }, openedDate: '2026-10-22', resolution: 'fixed' },
  { id: 104, title: '待我验证-2', status: 'resolved', severity: '1', pri: '1', type: 'codeerror', product: 2, assignedTo: { account: 'stub-user', realname: '桩用户' }, openedBy: { account: 'other', realname: '别人' }, openedDate: '2026-10-23', resolution: 'fixed' },
  { id: 105, title: '别人处理中的', status: 'active', severity: '3', pri: '3', type: 'codeerror', product: 1, assignedTo: { account: 'stub-user', realname: '桩用户' }, openedBy: { account: 'other', realname: '别人' }, openedDate: '2026-10-24', resolution: '' },
];

async function ensureZt(port = 9840) {
  const log = [];
  if (ZT.ready) return { ZT, stub: false, log, stop: () => {} };

  const srv = http.createServer((req, res) => {
    const url = req.url || '/';
    log.push({ method: req.method || 'GET', url });
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (/\/user-login\.html$/.test(url)) return send(200, '<html><body><form></form></body></html>', 'text/html; charset=utf-8');
    if (/\/api\.php\/v1\/tokens$/.test(url) && (req.method || 'GET').toUpperCase() === 'POST') return send(201, { token: 'stub-token' });
    if (/\/api\.php\/v1\/products/.test(url)) return send(200, { total: PRODUCTS.length, products: PRODUCTS });
    if (/\/api\.php\/v1\/bugs/.test(url)) {
      const q = new URL(url, 'http://x').searchParams;
      // 禅道 20.x 真实行为：不带 product 直接报 "Need product id."
      const product = q.get('product');
      if (!product) return send(400, { result: 'fail', message: 'Need product id.' });
      const openedBy = q.get('openedBy');
      const assignedTo = q.get('assignedTo');
      const status = q.get('status');
      let rows = BUGS.filter(b => String(b.product) === String(product));
      if (openedBy) rows = rows.filter(b => b.openedBy.account === openedBy);
      if (assignedTo) rows = rows.filter(b => b.assignedTo.account === assignedTo);
      if (status && status !== 'all') rows = rows.filter(b => b.status === status);
      const limit = Number(q.get('limit')) || 1000;
      const page = Number(q.get('page')) || 1;
      const slice = rows.slice((page - 1) * limit, page * limit);
      return send(200, { total: rows.length, limit, page, bugs: slice });
    }
    return send(404, 'not found', 'text/plain; charset=utf-8');
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));

  ZT.baseUrl = `http://127.0.0.1:${port}/zentao`;
  ZT.base = ZT.baseUrl;
  ZT.account = 'stub-user';
  ZT.password = 'stub-pass';

  return { ZT, stub: true, log, stop: () => srv.close() };
}

module.exports = { ensureZt };
