/**
 * 1.6.0 回归：数据安全（原子写 / 备份恢复 / 登录页恢复入口 / 数据目录）
 *            接口调试（Set-Cookie 会话 / 断言可加行 / 响应快照 / JSON→TS）
 *            禅道（多地址配置 / 附件下载 / 未读红点）、周报（周对比 / 群消息）
 *
 * 用法：node scripts/ui-round7-test.js            # 跑 dist（PM_USE_DIST=1）
 *      USE_PACKED=1 node scripts/ui-round7-test.js # 跑 release/win-unpacked
 * 环境变量 DEBUG7=1 打印 CDP 细节
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'release', 'win-unpacked');
const PACKED = path.join(APP_DIR, '测试工具.exe');
const usePacked = fs.existsSync(PACKED) && process.env.USE_PACKED === '1';
const EXE = usePacked ? PACKED : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9807;
const PW = 'Round7#2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? `  → ${extra}` : ''}`); }
  else { fail++; console.log(`✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r7-'));
  // 预置「上次还有 3 个新 Bug 没看」的状态，用来验证侧边栏红点
  fs.writeFileSync(path.join(ud, 'zentao-notify-state.json'), JSON.stringify({ ids: [], unread: 3 }), 'utf8');
  const env = { ...process.env, PM_USE_DIST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const cwd = usePacked ? APP_DIR : ROOT;
  const args = usePacked ? [] : ['.'];
  const app = spawn(EXE, [...args, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`], {
    env, cwd, windowsHide: true,
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
  if (!target) { console.log('FAIL 应用未启动'); app.kill(); return; }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (process.env.DEBUG7 && (msg.method === 'Runtime.exceptionThrown' || msg.method === 'Runtime.consoleAPICalled')) {
      const d = msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.args?.map(a => a.value).slice(0, 3));
      console.log('DBG-CDP', String(d).slice(0, 300));
    }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1800);

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('EX', r.exceptionDetails.exception?.description?.slice(0, 200));
    return r.result?.value;
  };
  const SETVAL = `(el, v) => {
    const isSel = el.tagName === 'SELECT';
    const isArea = el.tagName === 'TEXTAREA';
    const p = isSel ? HTMLSelectElement.prototype : isArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(p, 'value').set;
    d.call(el, v);
    el.dispatchEvent(new Event(isSel ? 'change' : 'input', { bubbles: true }));
  }`;
  const clickHas = async (t) => ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(t)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const navTo = async (label) => {
    await ev(`(() => { const n = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (n) n.click(); return !!n; })()`);
    await sleep(800);
  };
  const unlock = async () => {
    const locked = await ev(`(() => !!document.querySelector('input[type=password]'))()`);
    if (!locked) return;
    await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input[type=password]')]; if (ins[0]) s(ins[0], ${JSON.stringify(PW)}); return 1; })()`);
    await sleep(300);
    await clickHas('解锁');
    await sleep(2200);
  };
  // 直接调 IPC（比走 UI 稳，测的是主进程行为）
  const api = async (expr) => {
    const r = await ev(`(async () => { try { return JSON.stringify(await (${expr})); } catch (e) { return JSON.stringify({ __err: String(e && e.message) }); } })()`);
    try { return JSON.parse(r); } catch { return { __raw: r }; }
  };

  // 首次启动：设置主密码
  await ev(`(() => { const s = ${SETVAL}; const ins = [...document.querySelectorAll('input')]; s(ins[0], ${JSON.stringify(PW)}); if (ins[1]) s(ins[1], ${JSON.stringify(PW)}); return 1; })()`);
  await sleep(300);
  await clickHas('设置主密码');
  await sleep(2600);

  const vaultFile = path.join(ud, 'vault.enc');
  const bakFile = `${vaultFile}.bak`;
  const tmpFile = `${vaultFile}.tmp`;
  const backupDir = path.join(ud, 'backups');

  /* ================= A. 数据安全 ================= */
  // A1 原子写：写盘后不能留 .tmp，且要留一份 .bak
  const addA = await api(`window.electronAPI.entriesAdd({ id:'a1', name:'原子写A', url:'', username:'', password:'p', envType:'production', tags:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })`);
  await sleep(600);
  check('原子写：新增后落盘成功', addA && (addA.success === true || addA.data), JSON.stringify(addA).slice(0, 60));
  check('原子写：没有残留 .tmp 文件', !fs.existsSync(tmpFile), fs.existsSync(tmpFile) ? '发现 vault.enc.tmp' : '干净');
  check('原子写：生成了 .bak 备用副本', fs.existsSync(bakFile));

  // A2 备份恢复：造一份「已知状态」的备份，再改数据，看能不能回滚
  //   注意：自动备份是「当天第一次写盘前」的快照，新装机器第一次写盘前的库是空的，
  //   所以这里直接放一份带 A 的备份（用较早日期），避免依赖当天快照的时序。
  const known = path.join(backupDir, 'vault-2026-01-01.enc');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(vaultFile, known);
  check('备份：可放入指定日期的备份', fs.existsSync(known));

  const addB = await api(`window.electronAPI.entriesAdd({ id:'b1', name:'原子写B', url:'', username:'', password:'p', envType:'production', tags:[], createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() })`);
  await sleep(800);
  const day = new Date().toISOString().slice(0, 10);
  const dayBackup = path.join(backupDir, `vault-${day}.enc`);
  check('备份：写盘前自动生成当天备份', fs.existsSync(dayBackup), fs.existsSync(dayBackup) ? 'vault-' + day + '.enc' : '缺失');

  // A3 备份列表（未解锁也可读，登录页恢复要用）
  const bl = await api(`window.electronAPI.backupList()`);
  check('备份：列表可读', bl.success === true && Array.isArray(bl.data) && bl.data.length >= 1, `${bl.data ? bl.data.length : 0} 份`);

  // A4 恢复：回到只有 A 的状态
  const rs = await api(`window.electronAPI.backupRestore('vault-2026-01-01.enc')`);
  await sleep(1500);
  check('恢复：调用成功', rs.success === true, rs.error || rs.preRestore || '');
  check('恢复：恢复前留了 pre-restore 快照',
    fs.readdirSync(backupDir).some(f => /^vault-prerestore-/.test(f)),
    (fs.readdirSync(backupDir) || []).join(','));
  check('恢复：界面退回登录页', await ev(`(() => !!document.querySelector('input[type=password]'))()`));

  // 重新解锁，确认数据回到备份点
  await unlock();
  const all = await api(`window.electronAPI.entriesGetAll()`);
  const names = ((all.data && all.data.entries) || []).map(e => e.name);
  if (process.env.DEBUG7) console.log('DBG all=', JSON.stringify(all).slice(0, 300));
  check('恢复：数据回到备份时点（B 已消失）', names.includes('原子写A') && !names.includes('原子写B'), JSON.stringify(names));

  // A5 登录页的恢复入口：sessionLock() 只清主进程状态、不通知渲染层，
  //    所以锁完再 reload 一次，让界面确定回到登录页。
  await api(`window.electronAPI.sessionLock()`);
  await ev(`(() => { location.reload(); return 1; })()`).catch(() => {});
  await sleep(2800);
  const hasRestoreBtn = await ev(`(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('从备份恢复')))()`);
  check('登录页：有「从备份恢复」入口', hasRestoreBtn === true);
  await clickHas('从备份恢复');
  await sleep(900);
  const restoreRows = await ev(`(() => document.querySelectorAll('.modal .backup-item').length)()`);
  check('登录页：恢复面板列出备份', Number(restoreRows) >= 1, `${restoreRows} 行`);
  await clickHas('关闭');
  await sleep(400);

  // A6 数据目录可见
  await unlock();
  const info = await api(`window.electronAPI.dataInfo()`);
  const okInfo = info.success === true && info.data && info.data.dataDir;
  check('数据目录：能读到真实路径', okInfo && path.resolve(info.data.dataDir) === path.resolve(ud), okInfo ? info.data.dataDir : JSON.stringify(info).slice(0, 80));
  check('数据目录：识别为默认位置而非自定义', okInfo && info.data.isCustom === false);

  /* ================= B. 接口调试 ================= */
  // B5 会话保持：本地假服务返回 Set-Cookie，后续请求要自动带上
  const http = require('http');
  const srv = http.createServer((rq, rs) => {
    rs.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (rq.url === '/login') {
      rs.setHeader('Set-Cookie', ['sid=abc123; Path=/; HttpOnly; Max-Age=3600', 'uid=7; Path=/']);
      rs.end('{"ok":true,"msg":"login"}');
    } else if (rq.url === '/me') {
      const ck = rq.headers.cookie || '';
      rs.end(JSON.stringify({ cookie: ck, ok: ck.includes('sid=abc123') }));
    } else if (rq.url === '/obj1') {
      rs.end(JSON.stringify({ code: 0, data: { list: [{ id: 1, name: 'a' }] } }));
    } else if (rq.url === '/obj2') {
      // 契约变化：code 变字符串、元素多一个字段、根上多一个字段
      rs.end(JSON.stringify({ code: '0', data: { list: [{ id: 1, name: 'a', extra: true }] }, added: 1 }));
    } else {
      rs.statusCode = 404;
      rs.end('{"ok":false}');
    }
  });
  await new Promise((r) => srv.listen(9811, '127.0.0.1', r));
  const base = 'http://127.0.0.1:9811';
  const sendReq = (extra) => api(`window.electronAPI.apiSend({ method:'GET', url:'${base}/me', body:'', bodyType:'none', autoSession:true, ${extra} })`);

  const r1 = await api(`window.electronAPI.apiSend({ method:'GET', url:'${base}/login', body:'', bodyType:'none', autoSession:true })`);
  check('会话：响应带回 Set-Cookie', !!(r1.data && r1.data.setCookies && r1.data.setCookies.length === 2),
    r1.data && r1.data.setCookies ? r1.data.setCookies.length + ' 条' : JSON.stringify(r1).slice(0, 80));
  const jarRows = await api(`window.electronAPI.apiCookies()`);
  check('会话：Cookie 已进内存罐', jarRows.data && jarRows.data.length === 2, jarRows.data ? jarRows.data.map(c => c.name).join(',') : '');
  check('会话：只记名字不落盘（无 value 字段）', jarRows.data && jarRows.data.every(c => !('value' in c)));

  const r2 = await sendReq('');
  const body2 = r2.data ? JSON.parse(r2.data.body) : {};
  check('会话：后续请求自动带 Cookie', body2.ok === true, body2.cookie || '');

  const r3 = await api(`window.electronAPI.apiSend({ method:'GET', url:'${base}/me', body:'', bodyType:'none', autoSession:false })`);
  const body3 = r3.data ? JSON.parse(r3.data.body) : {};
  check('会话：关掉开关就不带 Cookie', body3.ok === false, body3.cookie || '(空)');

  // 手写 Cookie 时不被罐覆盖
  const r4 = await api(`window.electronAPI.apiSend({ method:'GET', url:'${base}/me', headers:'Cookie: sid=manual', body:'', bodyType:'none', autoSession:true })`);
  const body4 = r4.data ? JSON.parse(r4.data.body) : {};
  check('会话：手写 Cookie 优先于罐', body4.cookie === 'sid=manual', body4.cookie || '');

  const cleared = await api(`window.electronAPI.apiCookiesClear()`);
  check('会话：可一键清空', !cleared.data || cleared.data.length === 0);

  /* ================= B6. 断言改成可加行 ================= */
  await navTo('接口调试');
  await ev(`(() => { const el = document.querySelector('.url-bar input'); if (el) { const s = ${SETVAL}; s(el, ${JSON.stringify(base + '/me')}); return true; } return false; })()`);
  // GET /me 返回 {"cookie":"...","ok":false}
  await ev(`(() => { const b = [...document.querySelectorAll('.assert-toggle')][0]; if (b) { b.click(); return true; } return false; })()`);
  await sleep(400);
  const addRule = async () => {
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('添加断言')); if (b) { b.click(); return true; } return false; })()`);
    await sleep(220);
  };
  const setRule = async (i, op, target, value, negate) => {
    await ev(`(() => {
      const row = document.querySelectorAll('.assert-rule')[${i}];
      if (!row) return false;
      const s = ${SETVAL};
      s(row.querySelector('select'), ${JSON.stringify(op)});
      return true;
    })()`);
    await sleep(250);
    await ev(`(() => {
      const row = document.querySelectorAll('.assert-rule')[${i}];
      if (!row) return false;
      const s = ${SETVAL};
      const ins = [...row.querySelectorAll('input')].filter(x => x.type !== 'checkbox');
      if (ins[0] && !ins[0].disabled) s(ins[0], ${JSON.stringify(target)});
      if (ins[1] && !ins[1].disabled) s(ins[1], ${JSON.stringify(value)});
      const cb = row.querySelector('input[type=checkbox]');
      if (cb && cb.checked !== ${negate ? 'true' : 'false'}) cb.click();
      return true;
    })()`);
    await sleep(200);
  };

  // 状态码 200 / JSON 路径 cookie 存在 / 正文包含 ok / 响应头 content-type 含 json / 取反：状态码 ≠ 500
  await addRule(); await setRule(0, 'status', '', '200', false);
  await addRule(); await setRule(1, 'json', 'cookie', '', false);
  await addRule(); await setRule(2, 'body', '', '"ok"', false);
  await addRule(); await setRule(3, 'header', 'content-type', 'json', false);
  await addRule(); await setRule(4, 'status', '', '500', true);
  const ruleCount = await ev(`(() => document.querySelectorAll('.assert-rule').length)()`);
  check('断言：可以加成多行（5 行）', Number(ruleCount) === 5, `${ruleCount} 行`);

  await clickHas('发送');
  await sleep(1600);
  const barText = await ev(`(() => { const b = document.querySelector('.assert-bar'); return b ? b.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
  check('断言：5 行全部通过', /断言 5 \/ 5/.test(barText) && barText.includes('全部通过'), barText.slice(0, 90));

  // 改一行成必然失败（状态码 999），看是否只挂一条
  await setRule(0, 'status', '', '999', false);
  await clickHas('发送');
  await sleep(1600);
  const barText2 = await ev(`(() => { const b = document.querySelector('.assert-bar'); return b ? b.innerText.replace(/\\s+/g, ' ').trim() : ''; })()`);
  check('断言：失败行单独标红', /断言 4 \/ 5/.test(barText2) && barText2.includes('有失败项'), barText2.slice(0, 90));

  // 删掉一行
  await ev(`(() => { const row = document.querySelectorAll('.assert-rule')[0]; if (!row) return false; const b = [...row.querySelectorAll('button')].find(x => x.textContent.includes('删除')); if (b) { b.click(); return true; } return false; })()`);
  await sleep(300);
  const ruleCount2 = await ev(`(() => document.querySelectorAll('.assert-rule').length)()`);
  check('断言：可以删行', Number(ruleCount2) === 4, `${ruleCount2} 行`);

  /* ================= B7. 响应结构快照 ================= */
  const setUrl = async (u) => {
    await ev(`(() => {
      const el = document.querySelector('.url-bar input');
      if (!el) return false;
      const s = ${SETVAL};
      s(el, ${JSON.stringify(u)});
      return true;
    })()`);
  };
  const sendNow = async () => { await clickHas('发送'); await sleep(1500); };
  const schemaBar = async () => ev(`(() => {
    const b = [...document.querySelectorAll('.assert-bar')].find(x => x.innerText.includes('结构比对'));
    return b ? b.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`);

  await setUrl(`${base}/obj1`);
  await sendNow();
  await clickHas('存结构快照');
  await sleep(600);
  const snapBtn = await ev(`(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('重存快照')))()`);
  check('快照：可以存下响应结构', snapBtn === true);

  await sendNow();
  const same = await schemaBar();
  check('快照：同样的响应判为一致', same.includes('与快照一致'), same.slice(0, 80));

  await setUrl(`${base}/obj2`);
  await sendNow();
  const diffText = await schemaBar();
  check('快照：字段/类型变化能被检出',
    diffText.includes('新增 2') && diffText.includes('类型变化 1'),
    diffText.slice(0, 120));

  /* ================= B8. 响应 → TS / Markdown ================= */
  await clickHas('TS 类型');
  await sleep(500);
  const tsText = await ev(`(() => { const p = [...document.querySelectorAll('pre.code2')].pop(); return p ? p.innerText : ''; })()`);
  check('生成：TS 接口有 Root 与字段', tsText.includes('export interface Root') && tsText.includes('data'), tsText.split('\n')[0] || '');
  check('生成：嵌套数组元素单独成型', /\[\];/.test(tsText) && tsText.includes('interface RootDataListItem'), (tsText.match(/.*\[\];/) || [''])[0].trim());

  await clickHas('表格');
  await sleep(500);
  const mdText = await ev(`(() => { const p = [...document.querySelectorAll('pre.code2')].pop(); return p ? p.innerText : ''; })()`);
  check('生成：Markdown 表格有表头与分隔行', mdText.includes('| --- |') && mdText.includes('code'), mdText.split('\n')[0] || '');

  /* ================= C. 禅道 ================= */
  // C11 未读红点：启动前写入了 unread=3，还没进禅道页时应该亮着
  const dotBefore = await ev(`(() => { const d = document.querySelector('.nav-dot'); return d ? d.textContent.trim() : ''; })()`);
  check('侧边栏：未读红点显示上次没看的数量', dotBefore === '3', `红点=${dotBefore || '(无)'}`);

  // C9 多套配置：先塞两套进去，再切着看
  await api(`window.electronAPI.wsSet('integrations', ${JSON.stringify([
    { id: 'zentao', baseUrl: 'http://a.example.com/zentao', account: 'alice', password: 'pa', updatedAt: new Date().toISOString() },
    { id: 'cfg-b', baseUrl: 'http://b.example.com/zentao', account: 'bob', password: 'pb', updatedAt: new Date().toISOString() },
  ])})`);
  await navTo('禅道');
  await sleep(900);
  // 已配置时面板默认折叠（折叠即不渲染子节点），先展开标题栏
  await ev(`(() => {
    const h = [...document.querySelectorAll('.pnl-head')].find(x => x.textContent.includes('连接配置'));
    if (h) { h.click(); return true; }
    return false;
  })()`);
  await sleep(400);
  const chipCount = await ev(`(() => document.querySelectorAll('.zt-cfg-chip').length)()`);
  check('禅道：配置胶囊按套列出（2 套 + 新建）', Number(chipCount) === 3, `${chipCount} 个`);
  const urlVal = async () => ev(`(() => { const el = document.querySelector('.grid3 input'); return el ? el.value : ''; })()`);
  check('禅道：默认用第一套配置', (await urlVal()).includes('a.example.com'), await urlVal());
  await ev(`(() => { const c = [...document.querySelectorAll('.zt-cfg-chip')].find(x => x.textContent.includes('b.example.com')); if (c) { c.click(); return true; } return false; })()`);
  await sleep(600);
  check('禅道：点另一套就切过去', (await urlVal()).includes('b.example.com'), await urlVal());
  const st = await api(`window.electronAPI.settingsGet()`);
  check('禅道：当前用的那套写进设置（定时提醒跟着它）', st.zentaoActiveId === 'cfg-b', String(st.zentaoActiveId));

  // C10 附件：没有地址时要有明确报错（真实下载需连禅道，纯解析逻辑在单测里覆盖）
  const attErr = await api(`window.electronAPI.zentaoAttachment({ id:'zentao', baseUrl:'http://a.example.com/zentao', account:'alice', password:'pa' }, '', 'x.txt', 'open')`);
  check('禅道附件：缺地址时报错而不是静默', attErr.success === false && /附件地址/.test(attErr.error || ''), attErr.error || '');

  // 进了禅道页，红点应该被清掉
  await sleep(600);
  const dotAfter = await ev(`(() => { const d = document.querySelector('.nav-dot'); return d ? d.textContent.trim() : ''; })()`);
  const unreadNow = await api(`window.electronAPI.zentaoUnread()`);
  check('侧边栏：进禅道页后红点清零', !dotAfter && unreadNow.data === 0, `红点=${dotAfter || '(无)'} 计数=${unreadNow.data}`);

  /* ================= D. 周报 ================= */
  await navTo('周报');
  await sleep(900);
  const wkTitle = await ev(`(() => { const t = document.querySelector('.pg-title'); return t ? t.innerText.trim() : ''; })()`);
  const wkCmp = await ev(`(() => document.querySelectorAll('.wk-cmp').length)()`);
  check('周报：页面正常渲染（没禅道数据时不显示对比块）', wkTitle.includes('周报') && Number(wkCmp) === 0, `${wkTitle} / 对比块 ${wkCmp} 个`);

  /* ================= 结果 ================= */
  srv.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { ws.close(); } catch { /* ignore */ }
  app.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();