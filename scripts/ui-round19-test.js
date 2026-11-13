/**
 * 1.23.0 回归：接口调试的 WebSocket / SSE 长连接
 *
 * 起两个本地服务：
 *   ws://127.0.0.1:9871   —— 最小 RFC 6455 回声服务（握手 + 文本帧回显）
 *   http://127.0.0.1:9872 —— SSE，连上先推一条 hello，之后每 300ms 推一条 tick
 *
 * 然后驱动打包版应用：切到 WS → 连接 → 发一条 → 断言日志里有回显；
 * 切到 SSE → 连接 → 断言收到 hello/tick；最后断开并断言状态回到「已断开」。
 *
 * 跑法：node scripts/ui-round19-test.js（加 USE_PACKED=1 跑 release/win-unpacked）
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickExe } = require('./pick-exe');
const { acceptKey, parseHandshakeResponse, encodeFrame, decodeFrames, OPCODE } = require('../electron/ws-frame');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const EXE = pickExe(APP_DIR);
const PORT = 9819;
const WS_PORT = 9871;
const SSE_PORT = 9872;
const PW = 'Probe#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

/** 最小 WebSocket 回声服务：握手 → 收到文本帧就原样回一条 */
function startWsServer() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const hs = parseHandshakeResponse(buf);
        if (!hs) return;
        const key = hs.headers['sec-websocket-key'] || '';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
        );
        upgraded = true;
        buf = hs.rest;
        // 连上先主动推一条，验证「服务端主动下发」也能进日志
        socket.write(encodeFrame({ opcode: OPCODE.TEXT, payload: 'welcome', mask: false }));
      }
      if (!upgraded) return;
      let out;
      try { out = decodeFrames(buf); } catch { socket.destroy(); return; }
      buf = out.rest;
      for (const f of out.frames) {
        if (f.opcode === OPCODE.TEXT) {
          socket.write(encodeFrame({ opcode: OPCODE.TEXT, payload: `echo:${f.payload}`, mask: false }));
        } else if (f.opcode === OPCODE.CLOSE) {
          socket.end(encodeFrame({ opcode: OPCODE.CLOSE, payload: Buffer.alloc(0), mask: false }));
        } else if (f.opcode === OPCODE.PING) {
          socket.write(encodeFrame({ opcode: OPCODE.PONG, payload: f.payload, mask: false }));
        }
      }
    });
    socket.on('error', () => { /* 客户端断开 */ });
  });
  return new Promise((res) => server.listen(WS_PORT, '127.0.0.1', () => res(server)));
}

/** SSE 服务：连上推 hello，之后每 300ms 推一条 tick */
function startSseServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {"msg":"hi"}\n\n');
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: {"n":${n}}\n\n`);
      if (n >= 3) { clearInterval(timer); }
    }, 300);
    req.on('close', () => clearInterval(timer));
  });
  return new Promise((res) => server.listen(SSE_PORT, '127.0.0.1', () => res(server)));
}

(async () => {
  const wsServer = await startWsServer();
  const sseServer = await startSseServer();
  console.log(`桩服务已起：ws://127.0.0.1:${WS_PORT}  http://127.0.0.1:${SSE_PORT}`);

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ws-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd: APP_DIR, windowsHide: true,
  });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
      if (target) break;
    } catch { /* 等待 */ }
    await sleep(400);
  }
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); wsServer.close(); sseServer.close(); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', String(r.exceptionDetails.exception?.description || '').slice(0, 300));
    return r.result?.value;
  };
  const waitFor = async (expr, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(expr)) return true;
      await sleep(200);
    }
    return false;
  };

  // 首次启动是「建库」界面
  const setup = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].map(x => x.textContent.trim());
    return b.some(t => /设置主密码并开始使用|开始使用/.test(t));
  })()`);
  if (setup) {
    await ev(`(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const ins = [...document.querySelectorAll('input[type=password]')];
      ins.forEach(i => set(i, ${JSON.stringify(PW)}));
      const btn = [...document.querySelectorAll('button')].find(b => /设置主密码并开始使用|开始使用/.test(b.textContent));
      if (btn) btn.click();
      return ins.length;
    })()`);
    await sleep(2500);
  }

  // 进接口调试
  await ev(`(() => {
    const n = [...document.querySelectorAll('.nav-item')].find(x => /接口调试/.test(x.textContent));
    if (n) n.click();
    return !!n;
  })()`);
  await waitFor(`!!document.querySelector('.url-bar')`, 10000);
  await sleep(600);

  // 协议切换按钮存在
  const protos = await ev(`[...document.querySelectorAll('.proto-btn')].map(b => b.textContent.trim())`);
  check('地址栏有 HTTP / WS / SSE 三段切换', JSON.stringify(protos) === '["HTTP","WS","SSE"]', JSON.stringify(protos));

  // 切到 WS
  await ev(`(() => { const b = [...document.querySelectorAll('.proto-btn')].find(x => x.textContent.trim() === 'WS'); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  const wsUi = await ev(`(() => {
    const bar = document.querySelector('.url-bar');
    return {
      tag: bar ? (bar.querySelector('.proto-tag') || {}).textContent : '',
      hasPanel: !!document.querySelector('.ws-panel'),
      btn: bar ? [...bar.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      placeholder: bar ? (bar.querySelector('input') || {}).placeholder : '',
    };
  })()`);
  check('切到 WS 后方法下拉换成 WS 标签', wsUi.tag === 'WS', JSON.stringify(wsUi.tag));
  check('切到 WS 后出现事件日志面板', wsUi.hasPanel === true);
  check('切到 WS 后按钮变成「连接」', (wsUi.btn || []).includes('连接'), JSON.stringify(wsUi.btn));
  check('WS 占位符提示 wss://', String(wsUi.placeholder || '').startsWith('wss://'), String(wsUi.placeholder));

  // 填地址并连接
  await ev(`(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inp = document.querySelector('.url-bar input');
    if (inp) set(inp, 'ws://127.0.0.1:${WS_PORT}/echo');
    return !!inp;
  })()`);
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.trim() === '连接'); if (b) b.click(); return !!b; })()`);
  const gotWelcome = await waitFor(`[...document.querySelectorAll('.ws-log-body')].some(x => x.textContent.includes('welcome'))`, 10000);
  check('WS 连接成功并收到服务端主动推送', gotWelcome, await ev(`[...document.querySelectorAll('.ws-log-body')].map(x => x.textContent.slice(0,40)).join(' | ')`));
  check('WS 状态显示「已连接」', (await ev(`(document.querySelector('.ws-state') || {}).textContent`)) === '已连接');

  // 发一条
  await ev(`(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inp = document.querySelector('.ws-send input');
    if (inp) set(inp, 'ping-1');
    return !!inp;
  })()`);
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('.ws-send button')].find(x => x.textContent.trim() === '发送'); if (b) b.click(); return !!b; })()`);
  const gotEcho = await waitFor(`[...document.querySelectorAll('.ws-log-body')].some(x => x.textContent.includes('echo:ping-1'))`, 8000);
  check('WS 发送后收到回声', gotEcho, await ev(`[...document.querySelectorAll('.ws-log-body')].map(x => x.textContent.slice(0,40)).join(' | ')`));

  // 断开
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.trim() === '断开'); if (b) b.click(); return !!b; })()`);
  const disconnected = await waitFor(`(document.querySelector('.ws-state') || {}).textContent === '已断开'`, 6000);
  check('WS 断开后状态回到「已断开」', disconnected, await ev(`(document.querySelector('.ws-state') || {}).textContent`));

  // 切到 SSE
  await ev(`(() => { const b = [...document.querySelectorAll('.proto-btn')].find(x => x.textContent.trim() === 'SSE'); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  const sseUi = await ev(`(() => {
    const bar = document.querySelector('.url-bar');
    return {
      tag: bar ? (bar.querySelector('.proto-tag') || {}).textContent : '',
      hasSend: !!document.querySelector('.ws-send'),
      placeholder: bar ? (bar.querySelector('input') || {}).placeholder : '',
    };
  })()`);
  check('切到 SSE 后标签是 SSE', sseUi.tag === 'SSE', JSON.stringify(sseUi.tag));
  check('SSE 模式没有发送框（只能收）', sseUi.hasSend === false);
  check('SSE 占位符提示 https://', String(sseUi.placeholder || '').startsWith('https://'), String(sseUi.placeholder));

  await ev(`(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inp = document.querySelector('.url-bar input');
    if (inp) set(inp, 'http://127.0.0.1:${SSE_PORT}/events');
    return !!inp;
  })()`);
  await sleep(200);
  await ev(`(() => { const b = [...document.querySelectorAll('.url-bar button')].find(x => x.textContent.trim() === '连接'); if (b) b.click(); return !!b; })()`);
  const gotHello = await waitFor(`[...document.querySelectorAll('.ws-log-body')].some(x => x.textContent.includes('"msg": "hi"'))`, 10000);
  check('SSE 连接成功并收到 hello 事件', gotHello, await ev(`[...document.querySelectorAll('.ws-log-body')].map(x => x.textContent.slice(0,40)).join(' | ')`));
  const gotTick = await waitFor(`[...document.querySelectorAll('.ws-log-body')].some(x => x.textContent.includes('"n": 1'))`, 8000);
  check('SSE 持续收到 tick 事件', gotTick);
  const dirs = await ev(`[...document.querySelectorAll('.ws-log-dir')].map(x => x.textContent.trim())`);
  check('SSE 事件名显示在方向列', (dirs || []).some(d => d.includes('hello')), JSON.stringify(dirs));

  // 几何量：日志面板不溢出、发送框高度正常
  const geo = await ev(`(() => {
    const log = document.querySelector('.ws-log');
    const panel = document.querySelector('.ws-panel');
    const bar = document.querySelector('.url-bar');
    const r = (el) => el ? el.getBoundingClientRect() : null;
    const lb = r(log), pb = r(panel), bb = r(bar);
    return {
      logH: lb ? Math.round(lb.height) : 0,
      logScroll: log ? log.scrollHeight : 0,
      logClient: log ? log.clientHeight : 0,
      panelW: pb ? Math.round(pb.width) : 0,
      barW: bb ? Math.round(bb.width) : 0,
      overflowX: log ? log.scrollWidth > log.clientWidth + 1 : false,
    };
  })()`);
  check('日志面板有高度且不横向溢出', geo.logH > 40 && geo.overflowX === false, JSON.stringify(geo));
  check('日志面板与地址栏同宽', Math.abs(geo.panelW - geo.barW) <= 2, JSON.stringify({ panelW: geo.panelW, barW: geo.barW }));

  // 切回 HTTP：长连接应被断开、日志清空
  await ev(`(() => { const b = [...document.querySelectorAll('.proto-btn')].find(x => x.textContent.trim() === 'HTTP'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
  const backHttp = await ev(`(() => ({
    hasPanel: !!document.querySelector('.ws-panel'),
    hasMethod: !!document.querySelector('.url-bar select'),
    btn: [...document.querySelectorAll('.url-bar button')].map(b => b.textContent.trim()),
  }))()`);
  check('切回 HTTP 后日志面板消失、方法下拉回来', backHttp.hasPanel === false && backHttp.hasMethod === true, JSON.stringify(backHttp));
  check('切回 HTTP 后按钮回到「发送」', (backHttp.btn || []).includes('发送'), JSON.stringify(backHttp.btn));

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  try { app.kill(); } catch { /* ignore */ }
  wsServer.close();
  sseServer.close();
  await sleep(500);
  process.exit(fail === 0 ? 0 : 1);
})();
