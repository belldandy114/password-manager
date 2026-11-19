/**
 * ui-cases-test.js —— 用例库端到端回归（1.26.0）
 *
 * 覆盖：首次启动引导 → 系统树 → 进入系统看模块/文件 → 新建文件夹 →
 *       同名导入自动加 (2) → 导出到指定目录 → 更改库位置（迁移 + 旧目录清理）→ 迁移后仍可读。
 *
 * 跑法：npm run build:renderer && node scripts/ui-cases-test.js
 * 说明：原生目录对话框无法自动化，脚本直接写 <数据目录>/cases.json 模拟「已选目录」；
 *       迁移/导入/导出走真实 IPC 调用，不 mock 文件系统。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9788;
const PASSWORD = 'Round4#2026';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const OUT = path.join(ROOT, '_shots-audit');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cases-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cases-data-'));
  const casesRoot = path.join(os.tmpdir(), `pm-Test_Cases-${Date.now()}`);
  fs.mkdirSync(path.join(casesRoot, '支付系统', '登录模块'), { recursive: true });
  fs.mkdirSync(path.join(casesRoot, '会员系统'), { recursive: true });
  fs.writeFileSync(path.join(casesRoot, '支付系统', '支付-用例.csv'), 'a,b\n1,2\n');
  const srcFile = path.join(os.tmpdir(), `pm-src-case-${Date.now()}.xmind`);
  fs.writeFileSync(srcFile, 'xmind-bytes');
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cases-out-'));
  const nextRoot = path.join(os.tmpdir(), `pm-Test_Cases-new-${Date.now()}`);

  const env = { ...process.env, PM_USE_DIST: '1', PM_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`],
    { env, cwd: ROOT, windowsHide: true });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = l.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (target) break;
    } catch { /* starting */ }
    await sleep(400);
  }
  if (!target) { console.error('连不上应用'); app.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  const send = (m, p = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 160));
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(1400);

  const ev = async (expr) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }), new Promise(r2 => setTimeout(() => r2(null), 20000))]);
    if (!r || r.exceptionDetails) { if (r?.exceptionDetails) console.log('  [异常] ' + (r.exceptionDetails.exception?.description || '').slice(0, 200)); return undefined; }
    return r.result ? r.result.value : null;
  };
  const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); };
  const SETVAL = `(el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }`;
  const check = (name, ok, detail) => console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? '  → ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);

  // 登录（首次要设置主密码）
  await ev(`(() => { const set = ${SETVAL}; const ins = Array.from(document.querySelectorAll('input')); set(ins[0], ${JSON.stringify(PASSWORD)}); if (ins[1]) set(ins[1], ${JSON.stringify(PASSWORD)}); return true; })()`);
  await sleep(300);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('设置主密码')); if (b) b.click(); return true; })()`);
  await sleep(2400);
  check('已进入主界面', await ev(`!!document.querySelector('.sidebar')`));

  // 1) 首次启动引导
  await sleep(1200);
  const setupText = await ev(`document.querySelector('.modal')?.textContent || ''`);
  check('首次启动弹出用例库引导', !!setupText && setupText.includes('先设置用例库目录'), setupText.slice(0, 30));
  await shot('cases-setup.png');
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.includes('稍后')); if (b) b.click(); return true; })()`);
  await sleep(400);

  // 2) 直接写配置（原生目录对话框无法自动化），模拟用户已选目录
  fs.writeFileSync(path.join(dataDir, 'cases.json'), JSON.stringify({ root: casesRoot }), 'utf8');

  // 3) 进用例库
  await ev(`(() => { const n = Array.from(document.querySelectorAll('.nav-item')).find(e => e.textContent.includes('用例库')); if (n) n.click(); return true; })()`);
  for (let i = 0; i < 40; i++) { const t = await ev(`document.querySelector('.pg-title')?.textContent || ''`); if (t === '用例库') break; await sleep(100); }
  await sleep(900);
  const tree = await ev(`Array.from(document.querySelectorAll('.cases-tree-item')).map(e => e.textContent.trim())`);
  check('左侧系统树读到两个系统', Array.isArray(tree) && tree.some(t => t.includes('支付系统')) && tree.some(t => t.includes('会员系统')), tree);
  await shot('cases-list.png');

  // 4) 进入系统，看到模块与文件
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('支付系统')); if (b) b.click(); return true; })()`);
  await sleep(800);
  const rows = await ev(`Array.from(document.querySelectorAll('.cases-row .cases-name')).map(e => e.textContent)`);
  check('进入「支付系统」看到模块与用例文件', Array.isArray(rows) && rows.includes('登录模块') && rows.includes('支付-用例.csv'), rows);

  // 5) 新建文件夹（走 UI）
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.pnl-head button')).find(x => x.textContent.includes('新建文件夹')); if (b) b.click(); return true; })()`);
  await sleep(500);
  await ev(`(() => { const i = document.querySelector('.modal input'); if (!i) return false; (${SETVAL})(i, '冒烟模块'); return true; })()`);
  await sleep(200);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim() === '创建'); if (b) b.click(); return true; })()`);
  await sleep(900);
  const rows2 = await ev(`Array.from(document.querySelectorAll('.cases-row .cases-name')).map(e => e.textContent)`);
  check('新建文件夹后列表出现「冒烟模块」', Array.isArray(rows2) && rows2.includes('冒烟模块'), rows2);

  // 6) 导入两份同名文件 → 自动加 (2)
  const imp = await ev(`window.electronAPI.casesImport('支付系统', ${JSON.stringify([srcFile, srcFile])})`);
  const dirNow = fs.readdirSync(path.join(casesRoot, '支付系统'));
  check('上传同名文件自动加后缀', !!imp && imp.success && dirNow.some(n => /\(2\)\.xmind$/.test(n)), { imported: imp && imp.data, dirNow });
  await ev(`window.electronAPI.casesList('支付系统')`);
  await sleep(300);

  // 7) 导出
  const exp = await ev(`window.electronAPI.casesExport(['支付系统/支付-用例.csv'], ${JSON.stringify(exportDir)})`);
  const exported = fs.readdirSync(exportDir);
  check('导出复制到目标目录', exp && exp.success && exported.includes('支付-用例.csv'), exported);

  // 8) 迁移目录
  const mig = await ev(`window.electronAPI.casesChangeRoot(${JSON.stringify(nextRoot)})`);
  const oldGone = !fs.existsSync(casesRoot);
  const movedCount = fs.existsSync(path.join(nextRoot, '支付系统')) ? fs.readdirSync(path.join(nextRoot, '支付系统')).length : -1;
  check('迁移到新目录并清理旧目录', mig && mig.success && oldGone && movedCount >= 2, { ok: mig && mig.success, oldGone, movedCount });

  // 9) 刷新页面看迁移后的库
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.pg-tools button')).find(x => x.textContent.includes('刷新')); if (b) b.click(); return true; })()`);
  await sleep(900);
  const tree2 = await ev(`Array.from(document.querySelectorAll('.cases-tree-item')).map(e => e.textContent.trim())`);
  check('迁移后页面仍能读到系统', Array.isArray(tree2) && tree2.some(t => t.includes('支付系统')), tree2);
  await shot('cases-after-migrate.png');

  // 10) 右键系统节点 → 新建子文件夹（两级树）
  await ev(`(() => {
    const node = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('会员系统'));
    if (!node) return false;
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 300 }));
    return true;
  })()`);
  await sleep(400);
  const menuInfo = await ev(`(() => {
    const m = document.querySelector('.context-menu');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) };
  })()`);
  check('右键系统节点弹出菜单', !!menuInfo, menuInfo);
  await shot('cases-menu.png');
  await ev(`(() => {
    const item = Array.from(document.querySelectorAll('.context-menu-item')).find(e => e.textContent.includes('新建子文件夹'));
    if (!item) return false;
    item.click(); return true;
  })()`);
  await sleep(500);
  await ev(`(() => { const i = document.querySelector('.modal input'); (${SETVAL})(i, '冒烟模块A'); return true; })()`);
  await sleep(200);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim() === '创建'); if (b) b.click(); return true; })()`);
  await sleep(900);
  const treeItems = await ev(`Array.from(document.querySelectorAll('.cases-tree-item')).map(e => e.textContent.replace(/\\s+/g, ' ').trim())`);
  check('右键新建的子文件夹出现在树上（二级）', Array.isArray(treeItems) && treeItems.some(t => t.includes('冒烟模块A')), treeItems);

  // 11) 拖动移动（走真实 IPC）：文件可以进模块，文件夹不行
  const moved = await ev(`window.electronAPI.casesMove('支付系统/支付-用例.csv', '会员系统/冒烟模块A')`);
  check('文件可以移动到模块里', !!moved && moved.success, moved && moved.data);
  const badMove = await ev(`window.electronAPI.casesMove('支付系统/冒烟模块', '会员系统/冒烟模块A')`);
  check('文件夹不能移进模块（两级限制）', !!badMove && badMove.success === false && String(badMove.error).includes('两级'), badMove && badMove.error);
  await shot('cases-moved.png');

  // 12) 动效层生效（computed style）
  const motion = await ev(`(() => {
    const pg = document.querySelector('.pg');
    const btn = document.querySelector('.btn');
    return {
      pgAnim: pg ? getComputedStyle(pg).animationName : '',
      btnTransition: btn ? getComputedStyle(btn).transitionProperty : '',
    };
  })()`);
  check('页面进入动画生效', !!motion && motion.pgAnim === 'pg-enter', motion && motion.pgAnim);
  check('按钮过渡包含 transform', !!motion && String(motion.btnTransition).includes('transform'), motion && motion.btnTransition);

  // 13) 真实拖拽：把「支付系统」里的行拖到左侧「会员系统」
  await ev(`(() => {
    const node = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('支付系统'));
    if (node) node.click();
    return true;
  })()`);
  await sleep(800);
  const dragResult = await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.cases-row')).find(e => e.textContent.includes('.xmind'));
    const target = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('会员系统'));
    if (!row || !target) return { ok: false, reason: 'row-or-target-missing' };
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  await sleep(1000);
  const memberFiles = await ev(`window.electronAPI.casesList('会员系统')`);
  const names = memberFiles && memberFiles.data ? (memberFiles.data.files || []).map(f => f.name) : [];
  check('拖拽行到左侧目录真的完成移动', !!dragResult && dragResult.ok && names.some(n => n.endsWith('.xmind')), names);

  // 14) 拖到「列表里的文件夹行」+ 面包屑（用户报的问题：只能拖到左树才行）
  await ev(`(() => {
    const n = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('会员系统'));
    if (n) n.click();
    return true;
  })()`);
  await sleep(800);
  const rowDrop = await ev(`(() => {
    const fileRow = Array.from(document.querySelectorAll('.cases-row')).find(e => e.textContent.includes('.xmind'));
    const dirRow = Array.from(document.querySelectorAll('.cases-row.is-dir')).find(e => e.textContent.includes('冒烟模块A'));
    if (!fileRow || !dirRow) return { ok: false, reason: 'missing' };
    const dt = new DataTransfer();
    fileRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dirRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    dirRow.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  await sleep(1000);
  const inModule = await ev(`window.electronAPI.casesList('会员系统/冒烟模块A')`);
  const moduleFiles = inModule && inModule.data ? (inModule.data.files || []).map(f => f.name) : [];
  check('拖到列表里的文件夹行也能移动', !!rowDrop && rowDrop.ok && moduleFiles.some(n => n.endsWith('.xmind')), moduleFiles);

  // 15) 多选拖到面包屑 = 批量移回根目录
  await ev(`window.electronAPI.casesImport('会员系统', ${JSON.stringify([srcFile, srcFile])})`);
  await sleep(300);
  await ev(`(() => {
    const n = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('会员系统'));
    if (n) n.click();
    return true;
  })()`);
  await sleep(800);
  await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('.cases-row:not(.is-dir)')).slice(0, 2);
    rows.forEach(r => r.click());
    return rows.length;
  })()`);
  await sleep(300);
  const multi = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('.cases-row:not(.is-dir)')).slice(0, 2);
    const crumb = document.querySelector('.cases-crumb-link');
    if (rows.length < 2 || !crumb) return { ok: false };
    const dt = new DataTransfer();
    rows[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    crumb.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    crumb.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return { ok: true };
  })()`);
  await sleep(1200);
  const rootFiles = await ev(`window.electronAPI.casesList('')`);
  check('多选拖到面包屑可批量移动', !!multi && multi.ok && ((rootFiles && rootFiles.data && rootFiles.data.files) || []).length >= 2,
    ((rootFiles && rootFiles.data && rootFiles.data.files) || []).map(f => f.name));

  // 16) 应用内预览：导入 csv → 点「预览」出表格
  const csvSrc = path.join(os.tmpdir(), `pm-preview-${Date.now()}.csv`);
  fs.writeFileSync(csvSrc, 'name,qty\n苹果,3\n香蕉,5\n', 'utf8');
  await ev(`window.electronAPI.casesImport('', ${JSON.stringify([csvSrc])})`);
  await sleep(400);
  await ev(`(() => { const n = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('全部文件')); if (n) n.click(); return true; })()`);
  await sleep(900);
  const previewOpened = await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.cases-row')).find(e => e.textContent.includes('pm-preview'));
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button')).find(b => (b.title || '') === '预览');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1000);
  const previewInfo = await ev(`(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    return { title: (m.querySelector('.modal-header')?.textContent || '').trim(), rows: m.querySelectorAll('.cases-preview-tbl tr').length };
  })()`);
  check('csv 能在应用内预览（表格 3 行）', !!previewOpened && !!previewInfo && previewInfo.rows >= 3, previewInfo);
  await shot('cases-preview.png');
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return true; })()`);
  await sleep(400);

  // 16b) Excel 预览：用 xlsx 生成一个文件，验证主进程解析出表格
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['接口', '结果'], ['登录', '通过'], ['下单', '通过']]), 'Sheet1');
  const xlsxPath = path.join(os.tmpdir(), `pm-preview-${Date.now()}.xlsx`);
  XLSX.writeFile(wb, xlsxPath);
  await ev(`window.electronAPI.casesImport('', ${JSON.stringify([xlsxPath])})`);
  await sleep(400);
  await ev(`(() => { const n = Array.from(document.querySelectorAll('.cases-tree-item')).find(e => e.textContent.includes('全部文件')); if (n) n.click(); return true; })()`);
  await sleep(900);
  await ev(`(() => {
    const row = Array.from(document.querySelectorAll('.cases-row')).find(e => e.textContent.includes('pm-preview') && e.textContent.includes('.xlsx'));
    if (!row) return false;
    const btn = Array.from(row.querySelectorAll('button')).find(b => (b.title || '') === '预览');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  const xlsxInfo = await ev(`(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    return { rows: m.querySelectorAll('.cases-preview-tbl tr').length, sheets: m.querySelectorAll('.cases-sheet-tabs .tab2').length };
  })()`);
  check('xlsx 能在应用内预览（表格 3 行）', !!xlsxInfo && xlsxInfo.rows >= 3, xlsxInfo);
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim() === '关闭'); if (b) b.click(); return true; })()`);
  await sleep(400);

  // 17) 全库搜索
  await ev(`(() => { const b = Array.from(document.querySelectorAll('.cases-scope-btn')).find(x => x.textContent.includes('全库')); if (b) b.click(); return true; })()`);
  await sleep(200);
  await ev(`(() => {
    const i = document.querySelector('.pnl input');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, '支付');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1100);
  const hitInfo = await ev(`(() => ({ n: document.querySelectorAll('.cases-hit').length, text: Array.from(document.querySelectorAll('.cases-hit')).map(e => e.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 3) }))()`);
  check('全库搜索能跨系统找到文件', !!hitInfo && hitInfo.n > 0, hitInfo);
  // 恢复正常范围
  await ev(`(() => {
    const b = Array.from(document.querySelectorAll('.cases-scope-btn')).find(x => x.textContent.includes('当前目录'));
    if (b) b.click();
    const i = document.querySelector('.pnl input');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, '');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(400);

  // 18) 排序：名称 A→Z
  await ev(`(() => {
    const sel = document.querySelector('.cases-sort');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, 'name:asc');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const sortedNames = await ev(`Array.from(document.querySelectorAll('.cases-row:not(.is-dir) .cases-name')).map(e => e.textContent)`);
  const sortedCopy = [...(sortedNames || [])].sort((a, b) => a.localeCompare(b, 'zh'));
  check('按名称升序排序生效', JSON.stringify(sortedNames) === JSON.stringify(sortedCopy), sortedNames);

  // 19) 整文件夹导入（走 IPC，原生对话框无法自动化）
  const importSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-folder-import-'));
  fs.writeFileSync(path.join(importSrc, '流程.md'), '# 流程\n', 'utf8');
  fs.mkdirSync(path.join(importSrc, '子目录'));
  fs.writeFileSync(path.join(importSrc, '子目录', 'case.csv'), 'a,b\n1,2\n', 'utf8');
  const folderImport = await ev(`window.electronAPI.casesImportFolder('', ${JSON.stringify(importSrc)})`);
  check('整文件夹导入成功（含子目录）', !!folderImport && folderImport.success && folderImport.data.files === 2, folderImport && folderImport.data);

  // 20) 文件变更自动刷新（fs.watch → 渲染层自动重载）
  const liveFile = path.join(nextRoot, '外部新增.xmind');
  fs.writeFileSync(liveFile, 'watching', 'utf8');
  await sleep(1600);
  const listed = await ev(`Array.from(document.querySelectorAll('.cases-row .cases-name')).map(e => e.textContent)`);
  check('外部新增文件后自动刷新出来', Array.isArray(listed) && listed.some(n => n.includes('外部新增')), listed.slice(0, 5));

  // 21) 工作台「最近用例」卡片（预览时写入 localStorage）
  await ev(`(() => { const n = Array.from(document.querySelectorAll('.nav-item')).find(e => e.textContent.includes('工作台')); if (n) n.click(); return true; })()`);
  await sleep(1200);
  const homeCard = await ev(`(() => {
    const panels = Array.from(document.querySelectorAll('.home-panel, .pnl'));
    const card = panels.find(p => (p.textContent || '').includes('最近用例'));
    return card ? card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null;
  })()`);
  check('工作台出现「最近用例」卡片', !!homeCard, homeCard);
  await shot('home-recent-cases.png');

  // 22) 统计口径：一级系统节点显示「模块数」，不是顶层文件数
  const sysInfo = await ev(`window.electronAPI.casesList('')`);
  const paySys = sysInfo && sysInfo.data ? (sysInfo.data.dirs || []).find(d => d.name === '支付系统') : null;
  check('系统节点统计模块数（dirCount）而不是 0', !!paySys && paySys.dirCount >= 2 && typeof paySys.fileCount === 'number', paySys);

  // 23) 命令面板（Ctrl+K）能搜到用例库文件
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75 });
  await sleep(700);
  await ev(`(() => {
    const i = document.querySelector('.cmdk-search input');
    if (!i) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, 'pm-preview');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  const paletteHits = await ev(`Array.from(document.querySelectorAll('.cmdk-item')).map(e => e.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 5)`);
  check('Ctrl+K 能搜到用例文件', Array.isArray(paletteHits) && paletteHits.some(t => t.includes('pm-preview')), paletteHits);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(300);

  check('无页面异常', errors.length === 0, errors.slice(0, 2).join(' | '));
  try { app.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300);
})();






