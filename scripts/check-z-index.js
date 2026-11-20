'use strict';

/**
 * check-z-index.js —— z-index 字面量门禁（层叠体系第 1 条保险）
 *
 * 为什么需要：2026-11 之前 src/styles 下攒了 **40 处 z-index 字面量、17 种取值**
 * （0/1/2/5/10/20/40/50/60/90/91/100/110/120/130/131/200）。同一个「工具栏下拉」
 * 在三份样式表里分别写成 40、50、60，谁压谁只能靠读全部 1.4 万行去推。
 * 本轮三个 bug（skip-link 挤侧栏、工具栏把菜单关进上下文、工具栏 5 低于表头 10）
 * 全部出自这套无名的数字。现在取值收敛到 tokens.css 的层级表，本脚本负责
 * **不让字面量长回来**。
 *
 * 判定（任一命中即失败）：
 *   1. z-index 的值是数字字面量（含小数、负数）→ 必须换成 var(--z-*)；
 *   2. z-index 用了 var() 但变量名不是 --z-*（例如 var(--layer-3)）→ 层级表之外的新体系；
 *   3. 用了 var(--z-xx) 但 tokens.css 没定义它（拼错 / 删了没改）→ 该层等于 auto，
 *      是比字面量更隐蔽的坑：不报错、不生效，元素静默掉到最底层。
 *
 * 放行机制（两道，都要写理由）：
 *   - 就地注释：规则前一行写 `/* z-index-allow: <理由> *\/`；
 *   - 脚本白名单：下面的 ALLOW 数组加 { file, selector, reason } ——
 *     reason 不能空，否则脚本自己先报错（白名单不许「无理由裸放行」）。
 *   - 临时 `--allow <子串>` 只给调试用，输出里会写明它是临时放行。
 *
 * 用法：
 *   node scripts/check-z-index.js                  # 门禁用
 *   node scripts/check-z-index.js --self-test      # 自证能抓到问题（CI 也跑）
 *   node scripts/check-z-index.js --file a.css     # 单文件体检（失败样例验证退出码）
 */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const DIR = path.join(__dirname, '..', 'src', 'styles');
const TOKENS_FILE = 'tokens.css';

/** z-index 的合法「非令牌」取值（这些不表达层级，不该管） */
const KEYWORDS = new Set(['auto', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
/** 令牌引用必须长这样 */
const TOKEN_REF = /^var\(\s*(--z-[a-z0-9-]+)\s*\)$/;
/** 任意 var() 引用（用来区分「引用了别的体系」） */
const ANY_VAR_REF = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i;
const LITERAL = /^-?\d+(?:\.\d+)?$/;

/**
 * 白名单：历史遗留、确实无法令牌化的写法。
 * ⚠️ reason 必填（脚本会校验）—— 没有理由的白名单 = 把门禁关掉。
 */
const ALLOW = [
  // 例：
  // { file: 'global.css', selector: '.some-legacy-thing', reason: '第三方 DOM 注入，样式表管不到' },
];

function readCss(dir = DIR) {
  if (!fs.existsSync(dir)) throw new Error(`找不到样式目录：${dir}`);
  const files = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.toLowerCase().endsWith('.css')) files.push(p);
    }
  };
  walk(dir);
  // tokens.css 放最前：它是层级表的真源，报错时先看到「定义在哪」更省事
  files.sort((a, b) => {
    const an = path.basename(a) === TOKENS_FILE ? 0 : 1;
    const bn = path.basename(b) === TOKENS_FILE ? 0 : 1;
    return an - bn || a.localeCompare(b);
  });
  return files.map((p) => ({
    file: path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/'),
    text: fs.readFileSync(p, 'utf8'),
  }));
}

/** 最近的上一条注释里有没有 `z-index-allow: 理由` */
function inlineAllow(rule) {
  let node = rule.prev();
  let hops = 0;
  while (node && hops < 3) {
    if (node.type === 'comment') {
      const m = /z-index-allow\s*[:：]\s*([^\n*]*)/.exec(node.text);
      if (m) return m[1].trim();
    } else if (node.type === 'rule' || node.type === 'decl') {
      break;
    }
    node = node.prev();
    hops += 1;
  }
  return null;
}

/** 收集所有 --z-* 定义（tokens.css 与其他文件里的兜底定义都算） */
function collectTokens(entries) {
  const defined = new Map();
  for (const { file, text } of entries) {
    const root = postcss.parse(text, { from: file });
    root.walkDecls((d) => {
      if (!/^--z-[a-z0-9-]+$/.test(d.prop)) return;
      if (!LITERAL.test(d.value.trim())) return;
      defined.set(d.prop, { file, line: d.source.start.line, value: d.value.trim() });
    });
  }
  return defined;
}

function analyze(entries, opts = {}) {
  const allowPatterns = opts.allowPatterns || [];
  const defined = collectTokens(entries);
  const violations = [];
  const allowed = [];
  const usedTokens = new Set();
  let scanned = 0;
  let tokenized = 0;

  if (!opts.skipAllowValidation) validateAllowList();

  for (const { file, text } of entries) {
    const root = postcss.parse(text, { from: file });
    root.walkRules((rule) => {
      const selector = rule.selector.replace(/\s+/g, ' ').trim();
      rule.walkDecls(/^z-index$/i, (decl) => {
        scanned += 1;
        const value = decl.value.trim();
        const at = { file, line: decl.source.start.line, selector, value };

        const m = TOKEN_REF.exec(value);
        if (m) {
          usedTokens.add(m[1]);
          if (!defined.has(m[1])) {
            violations.push({ ...at, kind: 'undefined-token', detail: `--z-* 未在 ${TOKENS_FILE} 定义` });
            return;
          }
          tokenized += 1;
          return;
        }
        if (KEYWORDS.has(value.toLowerCase())) {
          tokenized += 1;
          return;
        }
        const other = ANY_VAR_REF.exec(value);
        if (other) {
          violations.push({ ...at, kind: 'not-a-layer-token', detail: `引用了 ${other[1]}，不是层级表的 --z-*` });
          return;
        }
        violations.push({
          ...at,
          kind: 'literal',
          detail: LITERAL.test(value) ? '数字字面量' : '既不是 --z-* 也不是合法关键字',
        });
      });

      // 命中就地注解 / 白名单的，从违规里摘出来单独汇报（不静默）
      const reasons = [];
      const inline = inlineAllow(rule);
      // ⚠️ 理由太短 = 没写理由 = 不放行（白名单不许「裸放行」）
      if (inline !== null && inline.length >= 4) reasons.push(`就地注解：${inline}`);
      const hit = ALLOW.find((a) => sameFile(a.file, file) && selector.includes(a.selector));
      if (hit) reasons.push(`脚本白名单：${hit.reason}`);
      if (reasons.length) {
        for (const v of violations.filter((x) => x.file === file && x.selector === selector)) {
          v.allowedBy = reasons.join(' / ');
        }
      }
    });
  }

  for (const v of violations) {
    if (v.allowedBy) allowed.push(v);
    const p = allowPatterns.find((pat) => `${v.file}:${v.selector}`.includes(pat));
    if (p) {
      v.allowedBy = `--allow 临时放行：${p}（不落盘、无理由，仅供调试）`;
      allowed.push(v);
    }
  }
  const blocking = violations.filter((v) => !v.allowedBy);

  return { violations, blocking, allowed, defined, usedTokens, scanned, tokenized };
}

function sameFile(a, b) {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/') || b.endsWith('/' + a) || a.endsWith('/' + b.split('/').pop());
}

function validateAllowList() {
  const bad = ALLOW.filter((a) => !a || !a.file || !a.selector || !a.reason || String(a.reason).trim().length < 4);
  if (bad.length) {
    throw new Error(
      `白名单条目不合格（${bad.length} 条）：file / selector / reason 三项都要有，` +
        'reason 至少 4 个字符 —— 没有理由的白名单等于把门禁关掉。'
    );
  }
}

function report(r, opts = {}) {
  console.log(`扫描 ${opts.fileCount} 份样式表，z-index 声明 ${r.scanned} 条`);
  console.log(`其中走令牌 / 合法关键字 ${r.tokenized} 条，违规 ${r.violations.length} 条`);
  const missing = [...r.usedTokens].filter((t) => !r.defined.has(t));

  if (r.allowed.length) {
    console.log(`\n  放行 ${r.allowed.length} 条（白名单必须带理由，逐条可见）：`);
    for (const v of r.allowed) console.log(`    ${v.file}:${v.line}  ${v.selector}  →  ${v.allowedBy}`);
  }
  if (missing.length) {
    console.log(`\n  令牌表里没有：${missing.join(', ')}`);
  }
  const unused = [...r.defined.entries()]
    .filter(([name, info]) => /tokens\.css$/.test(info.file) && !r.usedTokens.has(name))
    .map(([name]) => name);
  if (unused.length) {
    console.log(`\n  提醒（不阻断）：层级表里这 ${unused.length} 个令牌暂时没有使用者：${unused.join(', ')}`);
  }

  if (r.blocking.length) {
    console.error(`\n\u2717 ${r.blocking.length} 处 z-index 没走令牌：`);
    for (const v of r.blocking) {
      console.error(`    ${v.file}:${v.line}  ${v.selector}  →  z-index: ${v.value}  [${v.kind}] ${v.detail}`);
    }
    console.error('\n  改法：从 tokens.css 的「层级表」挑一层，写成 z-index: var(--z-xxx)；');
    console.error('  确实需要新的一层，先把它加进层级表（并写清「压谁 / 被谁压」）。');
    console.error('  历史遗留无法迁移的，用就地注释 /* z-index-allow: 理由 */ 或脚本 ALLOW 白名单，理由必填。');
    return false;
  }
  console.log('\n\u2713 没有 z-index 字面量（全部走 tokens.css 的层级表）');
  return true;
}

function selfTest() {
  const T = { file: 'tokens.css', text: ':root { --z-a: 1; --z-b: 2; }' };
  const cases = [
    {
      name: '数字字面量必须被抓到',
      files: [T, { file: 'x.css', text: '.a { position: relative; z-index: 50; }' }],
      want: ['literal'],
    },
    {
      name: '负数字面量也要抓到',
      files: [T, { file: 'x.css', text: '.a { z-index: -1; }' }],
      want: ['literal'],
    },
    {
      name: '走令牌不报',
      files: [T, { file: 'x.css', text: '.a { position: relative; z-index: var(--z-a); }' }],
      want: [],
    },
    {
      name: 'auto 不报',
      files: [T, { file: 'x.css', text: '.a { z-index: auto; }' }],
      want: [],
    },
    {
      name: '注释里的字面量不算（postcss 天然剥离）',
      files: [T, { file: 'x.css', text: '/* z-index: 99 */ .a { z-index: var(--z-b); }' }],
      want: [],
    },
    {
      name: '未定义的令牌要报（静默掉层）',
      files: [T, { file: 'x.css', text: '.a { z-index: var(--z-nope); }' }],
      want: ['undefined-token'],
    },
    {
      name: '别的变量体系也要报',
      files: [T, { file: 'x.css', text: '.a { z-index: var(--layer-3); }' }],
      want: ['not-a-layer-token'],
    },
    {
      name: '带理由的就地注解可以放行',
      files: [T, { file: 'x.css', text: '/* z-index-allow: 第三方注入的浮层，样式表管不到 */\n.a { z-index: 40; }' }],
      want: [],
    },
    {
      name: '理由太短的就地注解不放行',
      files: [T, { file: 'x.css', text: '/* z-index-allow: 嗯 */\n.a { z-index: 40; }' }],
      want: ['literal'],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    let r;
    try {
      r = analyze(c.files, { skipAllowValidation: true });
    } catch (e) {
      console.error(`\u2717 ${c.name}：扫描抛错 ${e.message}`);
      failed += 1;
      continue;
    }
    // 看「实际阻断」的条数（allowedBy 的已放行，不阻断）
    const got = r.blocking.map((v) => v.kind).sort();
    const want = [...c.want].sort();
    const ok = got.length === want.length && got.every((k, i) => k === want[i]);
    if (ok) console.log(`\u2713 ${c.name}`);
    else {
      failed += 1;
      console.error(`\u2717 ${c.name}：期望 [${want.join(',') || '无'}]，实得 [${got.join(',') || '无'}]`);
    }
  }

  // 白名单理由校验本身也要自证：空理由必须抛错
  try {
    const saved = ALLOW.slice();
    ALLOW.push({ file: 'x.css', selector: '.a', reason: '' });
    let threw = false;
    try {
      validateAllowList();
    } catch {
      threw = true;
    }
    ALLOW.length = 0;
    ALLOW.push(...saved);
    if (threw) console.log('\u2713 白名单缺理由会被拒绝');
    else {
      failed += 1;
      console.error('\u2717 白名单缺理由居然通过了');
    }
  } catch (e) {
    failed += 1;
    console.error(`\u2717 白名单校验自测异常：${e.message}`);
  }

  console.log(`\n自测 ${cases.length + 1} 项，失败 ${failed} 项`);
  if (failed) {
    console.error('\u2717 门禁自测失败：脚本抓不到该抓的问题，修好它再看别的');
    return false;
  }
  console.log('\u2713 门禁自测通过（能抓到字面量 / 未定义令牌 / 别的变量体系，不误报令牌写法）');
  return true;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 2);
  }
  const allowPatterns = argv
    .filter((a) => a.startsWith('--allow=') || a === '--allow')
    .flatMap((a) => (a.includes('=') ? a.slice(8).split(',') : []))
    .filter(Boolean);
  const only = argv.find((a) => a.startsWith('--file='));
  if (argv.includes('--file') || only) {
    const target = only ? only.slice(7) : argv[argv.indexOf('--file') + 1];
    if (!target) {
      console.error('用法：node scripts/check-z-index.js --file <css>');
      process.exit(1);
    }
    const entries = [{ file: target, text: fs.readFileSync(target, 'utf8') }];
    const r = analyze(entries, { allowPatterns, skipAllowValidation: true });
    process.exit(report(r, { fileCount: 1 }) ? 0 : 1);
  }
  const entries = readCss();
  let r;
  try {
    r = analyze(entries, { allowPatterns });
  } catch (e) {
    console.error(`\u2717 ${e.message}`);
    process.exit(1);
  }
  process.exit(report(r, { fileCount: entries.length }) ? 0 : 1);
}

module.exports = { analyze, readCss, selfTest, ALLOW };
