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
 *
 * 用法：
 *   node scripts/check-ipc-contract.js              # 真实检查
 *   node scripts/check-ipc-contract.js --self-test  # 只跑拆分守卫的自测（不读仓库文件）
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

/**
 * 把源码里的「非代码」部分抹成空格，只留下真正的标识符引用。
 *
 * 为什么不能只删注释 + 字符串：正则字面量里也会出现这些名字
 * （例如 `/\$\{__threads\b/`），而且 `'mainWindow'` 这种字符串不该算违规。
 * 这里做一个够用的词法扫描：注释 / 字符串 / 模板串 / 正则字面量 → 空格（保留换行）。
 */
const REGEX_PRECEDERS = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do',
  'yield', 'await', 'instanceof',
]);

function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = '';   // 上一个非空白字符（判断 `/` 是除号还是正则开头）
  let word = '';   // 上一个标识符（`return /re/` 里的 `/` 是正则）

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // 字符串 / 模板串
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === q) { out += ' '; i += 1; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      prev = q;
      word = '';
      continue;
    }
    // 正则字面量
    if (c === '/' && (REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.has(word))) {
      out += ' ';
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { out += '  '; i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { out += ' '; i += 1; break; }
        else if (d === '\n') break; // 不是正则，别把整行吃掉
        out += ' ';
        i += 1;
      }
      while (i < n && /[a-z]/i.test(src[i])) { out += ' '; i += 1; } // flags
      prev = '/';
      word = '';
      continue;
    }

    out += c;
    if (/[A-Za-z_$]/.test(c)) word += c;
    else if (!/\s/.test(c)) word = '';
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/**
 * 收集「本文件自己合法拥有」的名字集合。
 *
 * 只认这几种来源（其余一律视为「偷用 main.js 的模块级状态」）：
 *   1. `const { a, b: c, ...rest } = deps` 的解构（含 `= deps.xxx`）
 *   2. `function registerX({ a, b })` 的形参解构
 *   3. `deps.name` 直接取
 *   4. 本文件自己声明 `const/let/var/function name`
 *
 * ⚠️ 这里**故意不认**「名字出现在任意一对花括号之间」——旧实现就是栽在这条上：
 * `\{[^}]*\bNAME\b[^}]*\}` 会匹配任意函数体，于是只要名字在函数里出现过一次就全豁免，
 * 守卫等于没有（2026-11-16 实测：注入裸用 mainWindow 仍报「通过」）。
 */
function collectOwnedNames(code) {
  const owned = new Set();
  let m;

  /** 把解构列表拆成名字：`a`、`b: c`、`...rest`、`d = 默认值` 都要能认 */
  const addDestructured = (body) => {
    for (let part of body.split(',')) {
      part = part.trim();
      if (!part) continue;
      part = part.replace(/^\.\.\./, '');
      const eq = part.indexOf('=');
      if (eq >= 0) part = part.slice(0, eq).trim();
      const colon = part.indexOf(':');
      if (colon >= 0) {
        // `key: local` —— deps 上的 key 和本地别名都算合法来源
        const key = part.slice(0, colon).trim();
        const local = part.slice(colon + 1).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(key)) owned.add(key);
        if (/^[A-Za-z_$][\w$]*$/.test(local)) owned.add(local);
      } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        owned.add(part);
      }
    }
  };

  // 1) const { ... } = deps   /   = deps.xxx
  let re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*deps\b/g;
  while ((m = re.exec(code)) !== null) addDestructured(m[1]);

  // 2) function registerX({ ... })
  re = /function\s+[A-Za-z_$][\w$]*\s*\(\s*\{([^}]*)\}/g;
  while ((m = re.exec(code)) !== null) addDestructured(m[1]);

  // 3) deps.name
  re = /\bdeps\.([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(code)) !== null) owned.add(m[1]);

  // 4) 本地声明
  re = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re.exec(code)) !== null) owned.add(m[1]);

  return owned;
}

/**
 * 判断某个名字在代码里是否被「当作值读取」。
 *
 * 排除两类不算读取的写法：
 *   - 属性访问 `x.mainWindow`（前面是 `.`）
 *   - 对象字面量 / 解构里的键 `{ mainWindow: ... }`（前面是 `{` 或 `,`，后面是 `:`）
 */
function isValueReference(code, name) {
  const re = new RegExp(`(?<![.\\w$])${name}\\b`, 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    const before = code.slice(0, m.index).replace(/\s+$/, '');
    const after = code.slice(m.index + name.length);
    const prevCh = before.slice(-1);
    const isKey = /^\s*:/.test(after) && (prevCh === '{' || prevCh === ',');
    if (!isKey) return true;
  }
  return false;
}

/**
 * 纯函数：给定文件名与源码，返回该文件的违规列表。
 * 真实扫描与 --self-test 共用这一份，保证自测测的就是线上逻辑。
 */
function findSplitViolations(fileName, rawText) {
  const code = stripNonCode(rawText);
  const owned = collectOwnedNames(code);
  const problems = [];
  for (const name of MAIN_ONLY_STATE) {
    if (owned.has(name)) continue;
    if (!isValueReference(code, name)) continue;
    problems.push(`${fileName}: 引用了 main.js 的 ${name}（拆分模块看不到，运行时会 ReferenceError）`);
  }
  return problems;
}

function checkSplitModules() {
  const problems = [];
  for (const f of fs.readdirSync(ELECTRON_DIR)) {
    if (!/^ipc-.*\.js$/.test(f)) continue;
    const raw = fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8');
    problems.push(...findSplitViolations(f, raw));
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

/**
 * 拆分守卫自测。
 *
 * 存在的理由：这个守卫曾经「看起来在检查、实际全豁免」，而且没有任何测试能发现
 * （真实文件恰好都合规，所以跑真实检查永远是绿的）。这里用内联代码锁住行为：
 * 注入裸用必须报，正确解构必须不报。
 */
function selfTest() {
  const cases = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ① 只解构了 loadVault，却裸用 mainWindow / DATA_DIR / appendAudit → 必须报 3 个
  const bad = `'use strict';
const { ipcMain } = require('electron');
function registerX(deps) {
  const { loadVault } = deps;
  ipcMain.handle('x:y', () => {
    try { mainWindow.webContents.send('x'); } catch {}
    appendAudit('a');
    return { success: true, data: DATA_DIR };
  });
}
module.exports = { registerX };`;
  cases.push({
    name: '① 只注入 loadVault 却裸用 mainWindow/DATA_DIR/appendAudit → 必须报 3 个违规',
    got: findSplitViolations('fixture-bad.js', bad).map((s) => s.replace(/^fixture-bad\.js: 引用了 main\.js 的 /, '').replace(/（.*$/, '')),
    want: ['mainWindow', 'DATA_DIR', 'appendAudit'],
  });

  // ② 正确解构 mainWindow / DATA_DIR / appendAudit → 必须 0 违规
  const good = `'use strict';
const { ipcMain } = require('electron');
function registerX(deps) {
  const { mainWindow, DATA_DIR, appendAudit } = deps;
  ipcMain.handle('x:y', () => {
    try { mainWindow.webContents.send('x'); } catch {}
    appendAudit('a');
    return { success: true, data: DATA_DIR };
  });
}
module.exports = { registerX };`;
  cases.push({
    name: '② 正确解构 mainWindow/DATA_DIR/appendAudit → 必须 0 违规',
    got: findSplitViolations('fixture-good.js', good),
    want: [],
  });

  // ③ 注释 / 字符串 / 正则里提到名字 → 不算违规（旧实现靠删注释，正则字面量会漏）
  const noise = `// mainWindow 在这里不可用
/* DATA_DIR 也不能用 */
const s = "mainWindow";
const re = /\\bappendAudit\\b/;
function registerX(deps) { return s + re.source; }`;
  cases.push({
    name: '③ 注释/字符串/正则里提到名字 → 不算违规',
    got: findSplitViolations('fixture-noise.js', noise),
    want: [],
  });

  // ④ 另外三种合法来源：deps.name、本地声明、形参解构
  const alt = `function registerY({ loadVault, saveVault }) {
  const DATA_DIR = '/tmp';
  const audit = deps.appendAudit;
  return [loadVault, saveVault, DATA_DIR, audit];
}`;
  cases.push({
    name: '④ deps.name / 本地声明 / 形参解构 → 都算合法来源',
    got: findSplitViolations('fixture-alt.js', alt),
    want: [],
  });

  // ⑤ 对象字面量的键不是「读取」（`{ mainWindow: getMainWindow() }` 是定义，不是偷用）
  const keyOnly = `function registerZ(deps) {
  const { getMainWindow } = deps;
  return { mainWindow: getMainWindow() };
}`;
  cases.push({
    name: '⑤ 对象字面量的键不算读取 → 0 违规',
    got: findSplitViolations('fixture-key.js', keyOnly),
    want: [],
  });

  // ⑥ 回归锁：旧实现的正则必须被证明是坏的（防止有人把 `\{[^}]*\bNAME\b[^}]*\}` 加回来）
  const oldRegexWouldPass = /\{[^}]*\bmainWindow\b[^}]*\}/.test(bad);
  cases.push({
    name: '⑥ 旧正则 `\\{[^}]*\\bNAME\\b[^}]*\\}` 对注入代码会误判为「已注入」（证明旧实现失效）',
    got: oldRegexWouldPass,
    want: true,
  });

  let failed = 0;
  console.log('IPC 拆分守卫自测（--self-test）');
  console.log('─'.repeat(60));
  for (const c of cases) {
    const ok = eq(c.got, c.want);
    if (!ok) failed += 1;
    console.log(`${ok ? '\u2713' : '\u2717'} ${c.name}`);
    if (!ok) {
      console.log(`    期望：${JSON.stringify(c.want)}`);
      console.log(`    实际：${JSON.stringify(c.got)}`);
    }
  }
  console.log('─'.repeat(60));
  if (failed) {
    console.log(`结果：失败（${failed}/${cases.length} 个用例不通过）`);
    process.exit(1);
  }
  console.log(`结果：通过（${cases.length}/${cases.length} 个用例）`);
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    selfTest();
  } else {
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
}

module.exports = { check, checkSplitModules, findSplitViolations, stripNonCode, collectOwnedNames, MAIN_ONLY_STATE };
