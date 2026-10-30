'use strict';

/**
 * IPC 契约检查（D1）。
 *
 * 为什么需要：这个项目 98+ 个 IPC handler 全靠手写 preload 映射，
 * 三个地方（main 里 registerX / preload 的 electronAPI / types.ts 的 ElectronAPI）
 * 任何一处漏改，表现都是「点了没反应」或「调用不存在的方法」，而单测完全覆盖不到。
 *
 * 检查三件事：
 * 1. main 里出现过的 `ipcMain.handle('x:y')` → 必须有 renderer 侧用它（preload 里有 invoke('x:y')），
 *    否则就是「注册了没人调用」的死 handler；
 * 2. preload 里 invoke('x:y') → main 必须注册过，否则调用会 reject；
 * 3. preload 暴露的方法名 → types.ts 里必须有同名声明（否则 TS 用不了/用错）。
 *
 * 只做静态文本扫描（不起 Electron），所以能放进质量门禁里。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'electron');

/** 读取 electron 目录下所有 js（含子域模块） */
function readElectronSources() {
  const out = [];
  for (const f of fs.readdirSync(ELECTRON_DIR)) {
    if (!f.endsWith('.js')) continue;
    out.push({ file: f, text: fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8') });
  }
  return out;
}

/** main 侧：所有 ipcMain.handle('name') 与 ipcMain.on('name') */
function collectHandlers(sources) {
  const names = new Map();
  const re = /ipcMain\.(?:handle|on)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const { file, text } of sources) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!names.has(m[1])) names.set(m[1], file);
    }
  }
  return names;
}

/** preload 侧：ipcRenderer.invoke('name') / send('name') 与暴露的方法名 */
function collectPreload() {
  const text = fs.readFileSync(path.join(ELECTRON_DIR, 'preload.js'), 'utf8');
  const invokes = new Map();
  const re = /ipcRenderer\.(?:invoke|send)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(text)) !== null) invokes.set(m[1], true);

  // 暴露的方法名：形如 `  fooBar: (…` 或 `  fooBar: fooBar,`
  const methods = new Set();
  const mre = /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm;
  while ((m = mre.exec(text)) !== null) methods.add(m[1]);
  return { invokes, methods, text };
}

/** types.ts 里 ElectronAPI 的方法名 */
function collectTypedMethods() {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'types.ts'), 'utf8');
  const start = text.indexOf('export interface ElectronAPI');
  if (start < 0) return new Set();
  const body = text.slice(start);
  const end = body.indexOf('\n}');
  const block = end < 0 ? body : body.slice(0, end);
  const names = new Set();
  const re = /^\s{2}([A-Za-z_$][\w$]*)\s*[?(]?:?\s*\(/gm;
  let m;
  while ((m = re.exec(block)) !== null) names.add(m[1]);
  return names;
}

/**
 * 拆分守卫：electron/ipc-*.js 是独立模块，**看不到 main.js 的模块级状态**。
 * 1.9.2 就踩过：ipc-files.js 里用了 mainWindow，运行时报 ReferenceError，
 * 表现为「点按钮没反应」（错误被 handler 的 try/catch 吞掉，界面无感知）。
 */
const MAIN_ONLY_STATE = [
  'mainWindow', 'DATA_DIR', 'DATA_FILE', 'USER_DATA_DIR', 'LOCATION_FILE',
  'loadVault', 'saveVault', 'loadTrash', 'saveTrash', 'clearCaches',
  'currentPassword', 'appendAudit', 'apiJar', 'ztTokenCache', 'ztCfgFromVault',
  'loadSettings', 'saveSettings', 'writeFileAtomic', 'TDG_DIST_PATH', 'TDG_PRELOAD_PATH',
];

function checkSplitModules() {
  const problems = [];
  for (const f of fs.readdirSync(ELECTRON_DIR)) {
    if (!/^ipc-.*\.js$/.test(f)) continue;
    const raw = fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8');
    // 去掉注释与字符串字面量：注释里提到 mainWindow 不该算违规
    const text = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const name of MAIN_ONLY_STATE) {
      const re = new RegExp(`(?<![.\\w$])${name}\\b`, "g");
      const hits = text.match(re);
      if (!hits) continue;
      // 声明/传参（const name、name:、name =、解构、deps.name）不算违规
      const ok = new RegExp(`(?:const|let|var|function)\\s+${name}\\b|\\b${name}\\s*[:=](?!=)|\\{[^}]*\\b${name}\\b[^}]*\\}|deps\\.${name}`).test(text);
      if (!ok) problems.push(`${f}: 引用了 main.js 的 ${name}（拆分模块看不到，运行时会 ReferenceError）`);
    }
  }
  return problems;
}

function check() {
  const sources = readElectronSources();
  const handlers = collectHandlers(sources);
  const { invokes, methods } = collectPreload();
  const typed = collectTypedMethods();

  const problems = [];
  const splitProblems = checkSplitModules();

  // 1) handler 注册了但 renderer 从没调用（可能改名后忘了，也可能本来就只在主进程内部用）
  const unused = [...handlers.keys()].filter((n) => !invokes.has(n));

  // 2) renderer 调用了但 main 没注册（会直接 reject）
  const missing = [...invokes.keys()].filter((n) => !handlers.has(n));

  // 3) preload 暴露了但类型没声明（TS 侧看不到）
  const untyped = [...methods].filter((n) => !typed.has(n));

  // 4) 类型声明了但 preload 没暴露（调用会 undefined）
  const unimplemented = [...typed].filter((n) => !methods.has(n));

  if (splitProblems.length) problems.push({ level: 'error', title: '拆分模块引用了 main.js 的模块级状态（运行时会 ReferenceError）', items: splitProblems });
  if (missing.length) problems.push({ level: 'error', title: '调用了未注册的 IPC（会直接失败）', items: missing });
  if (unimplemented.length) problems.push({ level: 'error', title: 'types 声明了但 preload 没暴露（运行时会 undefined）', items: unimplemented });
  if (unused.length) problems.push({ level: 'warn', title: '注册了但没人调用（可能是死代码或忘记接线）', items: unused });
  if (untyped.length) problems.push({ level: 'warn', title: 'preload 暴露了但 types 没声明（TS 用不了）', items: untyped });

  return { handlers, invokes, methods, typed, problems };
}

if (require.main === module) {
  const { handlers, invokes, methods, typed, problems } = check();
  const errors = problems.filter((p) => p.level === 'error');
  console.log(`IPC 契约检查：handler ${handlers.size} 个 / preload 调用 ${invokes.size} 个 / 暴露方法 ${methods.size} 个 / 类型声明 ${typed.size} 个`);
  for (const p of problems) {
    const mark = p.level === 'error' ? '✗' : '!';
    console.log(`${mark} ${p.title}（${p.items.length}）`);
    for (const it of p.items.slice(0, 20)) console.log(`    ${it}`);
    if (p.items.length > 20) console.log(`    …还有 ${p.items.length - 20} 个`);
  }
  if (errors.length) {
    console.log('\n结果：失败（有 error 级问题）');
    process.exit(1);
  }
  console.log('\n结果：通过（无 error 级问题）');
}

module.exports = { check };
