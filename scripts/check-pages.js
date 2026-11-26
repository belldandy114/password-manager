'use strict';

/**
 * check-pages.js —— 「五处 page key 同步」机械门（1.36.0 收敛配套）。
 *
 * 页面 key 以字符串字面量在 4 个文件里重复出现，**TypeScript 一条都管不到**
 * （`currentPage` 是 `useState('home')`，类型是 `string`），所以拼错 / 漏删的表现是
 * 「点开落到密码库」或「入口永不可达」且**不报错**。本脚本把它们抽成 5 张集合并做集合断言：
 *
 *   1. `src/components/Sidebar.tsx`  的 `GROUPS`            → S（侧栏入口）
 *   2. `src/pages/loaders.ts`        的 `PAGE_LOADERS`      → L（懒加载器）
 *   3. `src/pages/loaders.ts`        的 `PAGE_ALIAS`        → ALIAS（旧路由 → 真页，只作例外表）
 *   4. `src/App.tsx`                 `renderPage()` 的 case → A（可渲染）
 *   5. `src/components/CommandPalette.tsx` 的 `PAGES` / `PAGES_MORE` → P（命令面板）
 *
 * 判据来源：`docs/契约-收敛实施.md` §1.3（R1–R10）、§2.2（退出码）、§2.3（唯一的例外是旧路由别名）。
 *
 * ⚠️ 解析必须**先定位块、再在块内取**，不能对整文件跑 `case '` / `page:` 正则：
 * 这四个文件里本来就有 `KIND_LABEL` 的 `page: '页面'`、注释里的示例 `case '…'`，
 * 全文正则会多出条目并让门禁报假红（实施契约 §1.1 第 5 处的实测反例）。
 *
 * ⚠️ 本脚本自己不许变成「第 6 处」：**脚本正文里不出现任何页面 key 字面量**，
 * 唯一的字面量例外是 `--self-test` 的 fixture 常量块（§2.6）。
 *
 * 用法：
 *   node scripts/check-pages.js                      # R1–R10
 *   node scripts/check-pages.js --explain            # 另打印五张表与四组差集（仍按 R1–R10 判）
 *   node scripts/check-pages.js --expect-sidebar=15   # 追加 R7'：侧栏项数必须等于 15
 *   node scripts/check-pages.js --self-test          # 用内联 fixture 自证「该报的报、不该报的不报」
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FILES = {
  sidebar: 'src/components/Sidebar.tsx',
  loaders: 'src/pages/loaders.ts',
  app: 'src/App.tsx',
  palette: 'src/components/CommandPalette.tsx',
};

/* ================================================================
   块定位：先找到起点锚点，再找它后面的终点锚点
   ================================================================ */

/**
 * 从源码里切一个块。
 * @param {string} src 整份源码
 * @param {string[]} startAnchors 起点候选（按顺序试，命中即用；写成候选是为了容忍小重构）
 * @param {string} endAnchor 终点文本（从起点之后第一次出现处截断）
 * @returns {{ ok: true, text: string, anchor: string } | { ok: false, reason: string }}
 */
function cutBlock(src, startAnchors, endAnchor) {
  let start = -1;
  let anchor = '';
  for (const a of startAnchors) {
    const i = src.indexOf(a);
    if (i >= 0) { start = i; anchor = a; break; }
  }
  if (start < 0) {
    return { ok: false, reason: `找不到起点 ${startAnchors.map((a) => `「${a}」`).join(' / ')}` };
  }
  const end = src.indexOf(endAnchor, start);
  if (end < 0) {
    return { ok: false, reason: `从「${anchor}」往后找不到终点「${endAnchor}」` };
  }
  return { ok: true, text: src.slice(start, end), anchor };
}

/**
 * 去掉注释（保留字符串字面量）。
 *
 * 为什么需要：本工程的注释里就有**反面示例**——「原 `go('…')` 会落 default」这类说明
 * 长得和真代码一模一样。追加源（导航字面量）没有块可定位，不剥注释就会把示例当成真调用
 * 报一条假红（首次跑就撞上了：三处「已下线，原 `requestNavigate('…')`」的注释）。
 * 字符串字面量必须保留，否则 `go('…')` 里的参数会被当成注释吃掉。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i += 1; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 收集正则捕获组第 1 组（**保留重复**：R10 要判「同一张表里同名 key 出现两次」，
 * 去重后再判就永远判不出来 —— 去重放在 parseAll 里做，原始数组留在 raw 里）。
 */
function collect(text, re, group = 1) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const v = m[group];
    if (v) out.push(v);
  }
  return out;
}

const uniq = (arr) => [...new Set(arr)].sort();

/* ================================================================
   解析：4 个文件 → 5 张集合（外加导航字面量 N）
   ================================================================ */

/**
 * 解析一份「源码包」（真实仓库读盘，自测时用 fixture 文本）。
 * @param {Record<string, string>} sources key ∈ {sidebar, loaders, app, palette}
 * @returns {{
 *   ok: boolean, errors: string[],
 *   S: string[], L: string[], ALIAS: Record<string,string>, A: string[], P: string[],
 *   hasDefault: boolean, details: Record<string, string>
 * }}
 */
function parseAll(sources) {
  const errors = [];
  const details = {};

  // ① Sidebar.GROUPS
  const g = cutBlock(sources.sidebar || '', ['const GROUPS'], '];');
  let S = [];
  if (!g.ok) {
    errors.push(`Sidebar.tsx：${g.reason}（侧栏注册表解析不到 —— 被重构了就改本脚本的锚点，不许跳过）`);
  } else {
    S = collect(g.text, /\{\s*id:\s*'([^']+)'/g);
    details.sidebar = g.anchor;
  }

  // ② loaders.PAGE_LOADERS
  const l = cutBlock(sources.loaders || '', ['export const PAGE_LOADERS = {'], '} as const;');
  let L = [];
  if (!l.ok) {
    errors.push(`pages/loaders.ts：${l.reason}（PAGE_LOADERS 解析不到）`);
  } else {
    L = collect(l.text, /^\s+([A-Za-z_$][\w$]*):\s*\(\)\s*=>/gm);
    details.loaders = l.anchor;
  }

  // ③ loaders.PAGE_ALIAS（例外表：只参与 R4/R5，不要求与其它表相等）
  const al = cutBlock(sources.loaders || '', ['const PAGE_ALIAS'], '};');
  const ALIAS = {};
  if (!al.ok) {
    errors.push(`pages/loaders.ts：${al.reason}（PAGE_ALIAS 解析不到）`);
  } else {
    for (const m of al.text.matchAll(/^\s*([A-Za-z_$][\w$]*):\s*'([^']+)'/gm)) ALIAS[m[1]] = m[2];
    details.alias = al.anchor;
  }

  // ④ App.renderPage 的 case
  const a = cutBlock(sources.app || '', ['const renderPage = () => {'], 'default:');
  let A = [];
  if (!a.ok) {
    errors.push(`App.tsx：${a.reason}（renderPage 解析不到）`);
  } else {
    A = collect(a.text, /^\s*case\s+'([^']+)':/gm);
    details.app = a.anchor;
  }
  // R8：老用户持久化的 currentPage 落 default 兜底，兜底本身不许被删
  const hasDefault = /default:\s*return\s+<PasswordManagerPage\s*\/>/.test(sources.app || '');

  // ⑤ CommandPalette 的 PAGES + PAGES_MORE（两块必须分别定位）
  const pBlocks = [
    ['PAGES', ['export const PAGES:'], '];'],
    ['PAGES_MORE', ['export const PAGES_MORE:'], '];'],
  ];
  const P = [];
  for (const [name, anchors, end] of pBlocks) {
    const b = cutBlock(sources.palette || '', anchors, end);
    if (!b.ok) {
      errors.push(`CommandPalette.tsx：${b.reason}（${name} 解析不到）`);
      continue;
    }
    P.push(...collect(b.text, /\{\s*page:\s*'([^']+)'/g));
    details[`palette.${name}`] = b.anchor;
  }

  return {
    ok: errors.length === 0,
    errors,
    // 去重后的集合（判定用）
    S: uniq(S), L: uniq(L), A: uniq(A), P: uniq(P),
    ALIAS,
    // 原始数组（R10 查重复用；去重前）
    raw: { S, L, A, P },
    hasDefault,
    details,
  };
}

/* ================================================================
   判定：R1–R10（R7 只作提示，R7' 由 --expect-sidebar 触发）
   ================================================================ */

/**
 * @param {ReturnType<typeof parseAll>} p
 * @param {{ navLiterals?: string[], expectSidebar?: number|null }} [opts]
 * @returns {{ violations: { rule: string, message: string }[], navCount: number, navOutside: string[] }}
 */
function judge(p, opts = {}) {
  const violations = [];
  const add = (rule, message) => violations.push({ rule, message });

  const S = new Set(p.S);
  const L = new Set(p.L);
  const A = new Set(p.A);
  const P = new Set(p.P);
  const aliasKeys = new Set(Object.keys(p.ALIAS));

  // 解析失败本身就是违规（不许静默跳过）
  for (const e of p.errors) add('R0', `解析失败：${e}`);

  // R8：default 兜底必须在
  if (!p.hasDefault) add('R8', 'App.renderPage 缺 `default: return <PasswordManagerPage />`（老用户停在已删页会白屏）');

  // R1 / R2：侧栏 → loader / render
  for (const k of [...S].sort()) {
    if (!L.has(k)) add('R1', `sidebar→loader  侧栏有「${k}」，PAGE_LOADERS 无此条目（点进去没有预取，且通常页面确实不存在）`);
    if (!A.has(k)) add('R2', `sidebar→render  侧栏有「${k}」，App.renderPage 无 case（点开落 default → 停在密码库，不报错）`);
  }

  // R3：loader → case
  for (const k of [...L].sort()) {
    if (!A.has(k)) add('R3', `loader→render  PAGE_LOADERS 有「${k}」，App.renderPage 无 case（预取了 chunk，点开仍落 default）`);
  }

  // R4：case 多出来的必须正好是别名表（双向）
  for (const k of [...A].sort()) {
    if (!L.has(k) && !aliasKeys.has(k)) {
      add('R4', `case→loader  App.renderPage 有 case「${k}」，无 loader，且不在 PAGE_ALIAS（旧路由伪装成真页）`);
    }
  }
  for (const k of [...aliasKeys].sort()) {
    if (!A.has(k)) {
      add('R4', `case→loader  PAGE_ALIAS 有「${k}」，App.renderPage 无对应 case（老 localStorage 不走别名而落 default）`);
    }
  }

  // R5：别名目标必须是真页面
  for (const [k, target] of Object.entries(p.ALIAS)) {
    if (!L.has(target)) add('R5', `alias→loader  别名「${k} → ${target}」，但「${target}」不在 PAGE_LOADERS（预取白跑）`);
  }

  // R6：命令面板里的每一项都得是能渲染且有 loader 的页
  for (const k of [...P].sort()) {
    if (!A.has(k)) add('R6', `palette→render  命令面板有「${k}」，App.renderPage 无 case（搜到、点开是错页）`);
    if (!L.has(k)) add('R6', `palette→loader  命令面板有「${k}」，PAGE_LOADERS 无此条目`);
  }

  // R9：导航字面量必须落在 A ∪ aliasKeys
  const navLiterals = opts.navLiterals || [];
  const navOutside = [...new Set(navLiterals)].filter((k) => !A.has(k) && !aliasKeys.has(k)).sort();
  for (const k of navOutside) {
    add('R9', `nav→render  导航字面量「${k}」既不在 renderPage 的 case，也不在 PAGE_ALIAS（点开落 default）`);
  }

  // R10：每张表内部无重复（查 raw，**不是**去重后的集合）
  const dups = (name, arr) => {
    const seen = new Set();
    const hit = new Set();
    for (const k of arr) { if (seen.has(k)) hit.add(k); seen.add(k); }
    for (const k of [...hit].sort()) add('R10', `${name} 里「${k}」重复出现（同名 key 后写覆盖前者，前一条静默失效）`);
  };
  const raw = p.raw || { S: p.S, L: p.L, A: p.A, P: p.P };
  dups('Sidebar.GROUPS', raw.S);
  dups('PAGE_LOADERS', raw.L);
  dups('renderPage 的 case', raw.A);
  dups('命令面板', raw.P);

  // R7（弱断言，**只提示不判红**，实施契约 §1.3）：命令面板里允许侧栏没有的入口（home/settings/attachments），
  // 除此之外多出来的项只提示 —— 用来人工复核「面板里出现了侧栏没有的页面」。
  const WHITELIST = ['home', 'settings', 'attachments'];
  const r7hints = [...P].filter((k) => !S.has(k) && WHITELIST.indexOf(k) < 0).sort();

  // R7'：只有显式给了期望数才判（不设默认值，否则每批都要改脚本）
  if (typeof opts.expectSidebar === 'number') {
    if (p.S.length !== opts.expectSidebar) {
      add('R7\'', `侧栏项数 ${p.S.length} ≠ 期望 ${opts.expectSidebar}（--expect-sidebar；本批的侧栏数写进任务书验收）`);
    }
  }

  return { violations, navCount: navLiterals.length, navOutside, r7hints };
}

/* ================================================================
   追加源：src 目录树里所有 .tsx（排除 __tests__）中的导航字面量（R9 的输入）
   ================================================================ */

function listTsx(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      listTsx(full, out);
    } else if (e.isFile() && e.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** 从整份源码里取导航字面量：go('x') / onNavigate('x') / requestNavigate('x') / setCurrentPage('x') */
function navLiteralsOf(src) {
  return collect(src, /(?:go|onNavigate|requestNavigate|setCurrentPage)\s*\(\s*'([^']+)'/g);
}

function readRepo() {
  const sources = {};
  for (const [k, rel] of Object.entries(FILES)) {
    // 先剥注释：注释里的示例 `go('…')` / `case '…'` 不是注册项（见 stripComments 注释）
    sources[k] = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  const nav = [];
  for (const f of listTsx(path.join(ROOT, 'src'))) {
    nav.push(...navLiteralsOf(stripComments(fs.readFileSync(f, 'utf8'))));
  }
  return { sources, navLiterals: [...new Set(nav)].sort() };
}

/* ================================================================
   自测：内联 fixture（**允许**在此块出现 key 字面量，见 §2.6）
   ================================================================ */

const FIXTURES = (() => {
  const sidebar = `
const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: 'G1', items: [
    { id: 'alpha', label: '甲', icon: i1 },
    { id: 'beta', label: '乙', icon: i2 },
  ] },
];

function Sidebar() { return <nav>{GROUPS.map(g => g.title)}</nav>; }
`;
  const loaders = `
export const PAGE_LOADERS = {
  alpha: () => import('./A').then(m => ({ default: m.A })),
  beta: () => import('./B').then(m => ({ default: m.B })),
  conf: () => import('./C').then(m => ({ default: m.C })),
} as const;

export type PageKey = keyof typeof PAGE_LOADERS;

/** 旧路由 → 真页 */
const PAGE_ALIAS: Record<string, string> = {
  legacyAlpha: 'alpha',
};
`;
  const app = `
export function App() {
  const renderPage = () => {
    switch (currentPage) {
      case 'alpha': return <A />;
      case 'beta': return <B />;
      case 'conf': return <C />;
      case 'legacyAlpha': return <A />;
      default: return <PasswordManagerPage />;
    }
  };
  return <div>{renderPage()}</div>;
}
`;
  const palette = `
export const KIND_LABEL: Record<string, string> = {
  page: '页面',
  action: '操作',
};

export const PAGES: { page: string; label: string }[] = [
  { page: 'alpha', label: '甲' },
  { page: 'beta', label: '乙' },
];

export const PAGES_MORE: { page: string; label: string }[] = [
  { page: 'conf', label: '设置（更多）' },
];
PAGES.push(...PAGES_MORE);
`;
  return { sidebar, loaders, app, palette };
})();

function selfTest() {
  const cases = [];
  const run = (name, patch = {}, opts = null) => {
    // 与真实路径同口径：先剥注释再解析（fixture 里也放了注释示例，见用例⑧）
    const base = {
      sidebar: stripComments(FIXTURES.sidebar),
      loaders: stripComments(FIXTURES.loaders),
      app: stripComments(FIXTURES.app),
      palette: stripComments(FIXTURES.palette),
    };
    const sources = { ...base };
    for (const [k, v] of Object.entries(patch)) sources[k] = stripComments(v);
    const p = parseAll(sources);
    const j = judge(p, opts || {});
    cases.push({ name, parsed: p, judged: j });
    return { p, j };
  };

  // ① 合规基线：S=L=A\alias=P，应 0 违规
  {
    const { j } = run('基线（合规）');
    cases[cases.length - 1].expectClean = true;
    cases[cases.length - 1].ok = j.violations.length === 0;
    if (!cases[cases.length - 1].ok) cases[cases.length - 1].why = j.violations.map((v) => v.message).join(' | ');
  }

  // ② 假 key：loaders 里多一个 zzzTest（只有 loader、没 case/侧栏）→ R3 必须红
  {
    const { j } = run('假 key（loader 多一个）', {
      loaders: FIXTURES.loaders.replace(
        "  beta: () => import('./B').then(m => ({ default: m.B })),",
        "  beta: () => import('./B').then(m => ({ default: m.B })),\n  zzzTest: () => import('./Z').then(m => ({ default: m.Z })),",
      ),
    });
    const hit = j.violations.some((v) => v.rule === 'R3' && /zzzTest/.test(v.message));
    cases[cases.length - 1].ok = hit;
    if (!hit) cases[cases.length - 1].why = `期望 R3 命中 zzzTest，实际 ${JSON.stringify(j.violations)}`;
  }

  // ③ 别名例外不算错：fixture 自带 legacyAlpha（case 有、loader 无、在 PAGE_ALIAS）→ 不许报 R4
  {
    const { j } = run('别名例外（case 多出但在别名表）');
    const bad = j.violations.filter((v) => v.rule === 'R4');
    cases[cases.length - 1].ok = bad.length === 0;
    if (!cases[cases.length - 1].ok) cases[cases.length - 1].why = bad.map((v) => v.message).join(' | ');
  }

  // ④ 别名表外的多余 case → R4 必须红（证明③不是因为整条规则失效才「绿」）
  {
    const { j } = run('假 case（不在别名表）', {
      app: FIXTURES.app.replace("      case 'beta': return <B />;", "      case 'beta': return <B />;\n      case 'ghost': return <B />;"),
    });
    const hit = j.violations.some((v) => v.rule === 'R4' && /ghost/.test(v.message));
    cases[cases.length - 1].ok = hit;
    if (!hit) cases[cases.length - 1].why = `期望 R4 命中 ghost，实际 ${JSON.stringify(j.violations)}`;
  }

  // ⑤ KIND_LABEL 不误计：block 定位后 P 必须只有块内的项，不含 '页面'
  {
    const { p } = run('KIND_LABEL 不误计');
    const okP = JSON.stringify(p.P) === JSON.stringify(['alpha', 'beta', 'conf']);
    cases[cases.length - 1].ok = okP;
    if (!okP) cases[cases.length - 1].why = `命令面板集合应为 [alpha,beta,conf]，实际 ${JSON.stringify(p.P)}`;
  }

  // ⑥ 侧栏少一项：去掉 beta 后用 --expect-sidebar=2 判 → R7' 必须红
  {
    const { j } = run('Sidebar 少一项（R7\'）', {
      sidebar: FIXTURES.sidebar.replace("    { id: 'beta', label: '乙', icon: i2 },\n", ''),
    }, { expectSidebar: 2 });
    const hit = j.violations.some((v) => v.rule === 'R7\'' && /侧栏项数 1/.test(v.message));
    cases[cases.length - 1].ok = hit;
    if (!hit) cases[cases.length - 1].why = `期望 R7' 命中「侧栏项数 1」，实际 ${JSON.stringify(j.violations)}`;
  }

  // ⑥b R10：同一张表里同名 key 出现两次必须红（PAGES 与 PAGES_MORE 合并后算一张表）
  {
    const { j } = run('重复 key（R10）', {
      palette: FIXTURES.palette.replace("{ page: 'conf', label: '设置（更多）' },", "{ page: 'alpha', label: '甲（重复）' },"),
    });
    const hit = j.violations.some((v) => v.rule === 'R10' && /alpha/.test(v.message));
    cases[cases.length - 1].ok = hit;
    if (!hit) cases[cases.length - 1].why = `期望 R10 命中 alpha 重复，实际 ${JSON.stringify(j.violations)}`;
  }

  // ⑦ 块定位失败也是一条违规（文件被重构不许静默通过）
  {
    const { j } = run('块定位失败', { sidebar: 'const NOT_GROUPS = [];' });
    const hit = j.violations.some((v) => v.rule === 'R0');
    cases[cases.length - 1].ok = hit;
    if (!hit) cases[cases.length - 1].why = '块找不到时应报 R0，实际无违规';
  }

  // ⑧ 注释里的示例不许被当成真调用（实施契约 §2.1：剥注释就必须补这条 fixture）
  {
    const snippet = [
      "// 旧版写法：go('notARealPage')",
      "/* setCurrentPage('alsoNotReal') */",
      "const x = () => go('alpha');",
      "const y = () => onNavigate('beta');",
    ].join('\n');
    const stripped = navLiteralsOf(stripComments(snippet));
    const raw = navLiteralsOf(snippet);
    const okStripped = JSON.stringify(stripped) === JSON.stringify(['alpha', 'beta']);
    // 同时证明「不剥会误计」——否则这条用例证明不了剥离是必要的
    const rawPolluted = raw.includes('notARealPage') && raw.includes('alsoNotReal');
    cases.push({
      name: '注释示例不误计（剥注释）',
      ok: okStripped && rawPolluted,
      why: `剥后应为 [alpha,beta]（实际 ${JSON.stringify(stripped)}），未剥应含两条假 key（实际 ${JSON.stringify(raw)}）`,
    });
  }

  let bad = 0;
  console.log('\n自测：内联 fixture（不读仓库文件）');
  for (const c of cases) {
    if (c.ok) console.log(`  \u2713 ${c.name}`);
    else { bad++; console.log(`  \u2717 ${c.name}  → ${c.why || '断言失败'}`); }
  }
  if (bad) {
    console.error(`\n\u2717 自测失败 ${bad}/${cases.length} 例`);
    process.exit(1);
  }
  console.log(`\u2713 自测 ${cases.length}/${cases.length} 例通过`);
  process.exit(0);
}

/* ================================================================
   主流程
   ================================================================ */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) selfTest();

  const explain = argv.includes('--explain');
  const expectArg = argv.find((a) => a.startsWith('--expect-sidebar='));
  const expectSidebar = expectArg ? Number(expectArg.split('=')[1]) : null;
  if (expectArg && !Number.isFinite(expectSidebar)) {
    console.error('\u2717 --expect-sidebar 需要一个数字，例如 --expect-sidebar=15');
    process.exit(1);
  }

  let repo;
  try {
    repo = readRepo();
  } catch (e) {
    // 读不到文件 = 违规（不许静默跳过）
    console.error(`\u2717 读取失败：${e.message}`);
    process.exit(1);
  }

  const parsed = parseAll(repo.sources);
  const { violations, navCount, navOutside, r7hints } = judge(parsed, {
    navLiterals: repo.navLiterals,
    expectSidebar: expectSidebar === null ? undefined : expectSidebar,
  });

  // 计数行必须由脚本自己算，不写死（§2.2）
  console.log(`page keys  sidebar=${parsed.S.length} loaders=${parsed.L.length} cases=${parsed.A.length} palette=${parsed.P.length} aliases=${Object.keys(parsed.ALIAS).length}`);

  if (explain) {
    const s = (arr) => JSON.stringify([...arr].sort());
    const S = new Set(parsed.S); const L = new Set(parsed.L); const A = new Set(parsed.A); const P = new Set(parsed.P);
    const diff = (a, b) => [...a].filter((k) => !b.has(k)).sort();
    console.log('\n--explain');
    console.log(`  S(侧栏)      ${s(S)}`);
    console.log(`  L(loaders)   ${s(L)}`);
    console.log(`  A(cases)     ${s(A)}`);
    console.log(`  P(命令面板)   ${s(P)}`);
    console.log(`  ALIAS        ${JSON.stringify(parsed.ALIAS)}`);
    console.log(`  S\\L ${JSON.stringify(diff(S, L))}   S\\A ${JSON.stringify(diff(S, A))}`);
    console.log(`  A\\L ${JSON.stringify(diff(A, L))}   P\\A ${JSON.stringify(diff(P, A))}`);
    console.log(`  导航字面量   ${navCount} 处（越界 ${navOutside.length}）`);
    console.log(`  解析锚点     ${JSON.stringify(parsed.details)}`);
  }

  if (violations.length) {
    // 按「规则 + 文件」分组，便于一眼看出该改哪
    for (const v of violations) console.error(`\u2717 ${v.rule}  ${v.message}`);
    console.error(`\n\u2717 共 ${violations.length} 处不一致（page key 在 4 个文件里是纯字符串，TS 管不到，只能靠这道门）`);
    process.exit(1);
  }

  // R7 是弱断言：只提示，不影响退出码（实施契约 §1.3）
  for (const k of r7hints || []) console.log(`! R7 提示  命令面板有「${k}」，侧栏没有（既有允许 home/settings/attachments；其余请人工确认是否故意）`);

  console.log(`\u2713 R1–R10 全通过（导航字面量 ${navCount} 处，越界 0，违规 0）`);
  if (explain) console.log('提示：--explain 已把五张表与四组差集打在上面');
  process.exit(0);
}

main();
