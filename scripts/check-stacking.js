'use strict';

/**
 * check-stacking.js —— 「容器别自带层叠上下文」门禁（层叠体系第 2 条保险）
 *
 * 为什么需要：本轮三个 bug 的病根是同一个 —— **不起眼的属性改变了层叠/布局关系**，
 * 而改的人完全不知道：
 *   1. `.skip-link` 被写成 position:relative，从 fixed 变成 flex 项，占 93×900，
 *      把整个侧栏从 x=0 推到 x=93（「上传背景图后左侧宽了一节」）；
 *   2. `.toolbar` 上加了 backdrop-filter，工具栏成了 stacking context，
 *      里面搜索下拉的 z-index 只在上下文里有效，整个工具栏被后面内容盖住
 *      （「下拉嵌进表格里、上半截被表头切掉」）；
 *   3. 工具栏层级比吸顶表头还低，下拉被表头盖掉。
 * 前两件的共同点：`backdrop-filter / filter / transform / contain` 会**新建层叠上下文**，
 * 而写的人以为那只是「加个模糊」。一旦容器自己又带 z-index，容器内所有浮层的
 * 层级都被关进这个上下文的天花板里 —— 从代码上看 z-index 明明更高。
 *
 * 判定（同一规则块内同时出现才算，任一命中即失败）：
 *   规则的选择器里有一个「容器类 class」（名字含 toolbar / sidebar / panel /
 *   card / section / header …），且同一块里既有 z-index（含 var(--z-*)），
 *   又有  backdrop-filter | filter | transform | contain。
 *
 * 为什么是「同一块」而不是「同一元素」：跨规则块时无法静态确定是否作用在同一元素上；
 * 同一块是**确定命中**的形态，宁可少报也不制造噪声（跨块的情形由 CSS 审查人工看）。
 *
 * 放行机制（两道，都要写理由）：
 *   - 就地注释：规则前一行写 `/* stacking-allow: <理由> *\/`；
 *   - 脚本白名单：下面 ALLOW 数组加 { file, selector, reason }，reason 必填。
 *   - 临时 `--allow <子串>` 仅供调试，不落盘。
 *
 * 用法：
 *   node scripts/check-stacking.js                 # 门禁用
 *   node scripts/check-stacking.js --self-test     # 自证能抓到问题（CI 也跑）
 *   node scripts/check-stacking.js --file a.css    # 单文件体检
 */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const DIR = path.join(__dirname, '..', 'src', 'styles');

/** 会新建层叠上下文 / 改变布局参与方式的属性（任务书点名的四件套 = 阻断项） */
const BLOCKING = ['backdrop-filter', 'filter', 'transform', 'contain'];
/** 同样是「新建上下文」但本轮不作为阻断项，只提示（避免一次性把历史写法全判死） */
const ADVISORY = ['isolation', 'perspective', 'will-change', 'mix-blend-mode', 'content-visibility'];

/** 「容器类」class 关键词：这类元素内部一般会有浮层，最怕被关进自己的上下文 */
const CONTAINER_WORDS = ['toolbar', 'sidebar', 'panel', 'card', 'section', 'header', 'rail', 'shell'];

/**
 * 白名单：确实需要「容器 + 上下文 + z-index」三者共存的写法。
 * ⚠️ reason 必填（脚本会校验）。
 */
const ALLOW = [
  // { file: 'redesign.css', selector: '.some-container', reason: '内部无浮层，模糊只作用于自身背景' },
];

const CLASS_RE = /\.[A-Za-z0-9_-]+/g;

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
  files.sort((a, b) => a.localeCompare(b));
  return files.map((p) => ({
    file: path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/'),
    text: fs.readFileSync(p, 'utf8'),
  }));
}

/** 选择器里出现的 class 名里，哪些是「容器」 */
function containerClasses(selector) {
  const names = (selector.match(CLASS_RE) || []).map((s) => s.slice(1).toLowerCase());
  return names.filter((n) => CONTAINER_WORDS.some((w) => n.includes(w)));
}

/** 最近的上一条注释里有没有 `stacking-allow: 理由` */
function inlineAllow(rule) {
  let node = rule.prev();
  let hops = 0;
  while (node && hops < 3) {
    if (node.type === 'comment') {
      const m = /stacking-allow\s*[:：]\s*([^\n*]*)/.exec(node.text);
      if (m) return m[1].trim();
    } else if (node.type === 'rule' || node.type === 'decl') {
      break;
    }
    node = node.prev();
    hops += 1;
  }
  return null;
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

function analyze(entries, opts = {}) {
  if (!opts.skipAllowValidation) validateAllowList();
  const violations = [];
  const advisories = [];
  const files = new Set();
  let rules = 0;
  let scanned = 0;

  for (const { file, text } of entries) {
    files.add(file);
    const root = postcss.parse(text, { from: file });
    root.walkRules((rule) => {
      rules += 1;
      const selector = rule.selector.replace(/\s+/g, ' ').trim();
      const containers = containerClasses(selector);
      if (!containers.length) return;
      scanned += 1;

      const decls = [];
      rule.walkDecls((d) => decls.push(d));
      const zDecl = decls.find((d) => /^z-index$/i.test(d.prop));
      if (!zDecl) return;

      const hitBlocking = decls.filter((d) => BLOCKING.includes(d.prop.toLowerCase()));
      const hitAdvisory = decls.filter((d) => ADVISORY.includes(d.prop.toLowerCase()));

      if (hitBlocking.length) {
        violations.push({
          file,
          line: zDecl.source.start.line,
          selector,
          container: containers.join(','),
          zIndex: zDecl.value.trim(),
          props: hitBlocking.map((d) => `${d.prop}: ${d.value.trim()}`),
          rule,
        });
      } else if (hitAdvisory.length) {
        advisories.push({
          file,
          line: zDecl.source.start.line,
          selector,
          props: hitAdvisory.map((d) => `${d.prop}: ${d.value.trim()}`),
        });
      }

      const reasons = [];
      const inline = inlineAllow(rule);
      // ⚠️ 理由太短 = 没写理由 = 不放行（白名单不许「裸放行」）
      if (inline !== null && inline.length >= 4) reasons.push(`就地注解：${inline}`);
      const hit = ALLOW.find((a) => sameFile(a.file, file) && selector.includes(a.selector));
      if (hit) reasons.push(`脚本白名单：${hit.reason}`);
      if (reasons.length) {
        const v = violations[violations.length - 1];
        if (v && v.file === file && v.selector === selector) v.allowedBy = reasons.join(' / ');
      }
    });
  }

  for (const v of violations) {
    const p = (opts.allowPatterns || []).find((pat) => `${v.file}:${v.selector}`.includes(pat));
    if (p && !v.allowedBy) v.allowedBy = `--allow 临时放行：${p}（不落盘、无理由，仅供调试）`;
  }

  return {
    violations,
    blocking: violations.filter((v) => !v.allowedBy),
    allowed: violations.filter((v) => v.allowedBy),
    advisories,
    files: files.size,
    rules,
    scanned,
  };
}

function sameFile(a, b) {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/') || b.endsWith('/' + a) || a.endsWith('/' + b.split('/').pop());
}

function report(r) {
  console.log(`扫描 ${r.files} 份样式表 / ${r.rules} 条规则，其中容器类规则 ${r.scanned} 条`);
  console.log(`「容器 + 层叠上下文属性 + z-index」违规 ${r.violations.length} 条`);

  if (r.allowed.length) {
    console.log(`\n  放行 ${r.allowed.length} 条（白名单必须带理由，逐条可见）：`);
    for (const v of r.allowed) console.log(`    ${v.file}:${v.line}  ${v.selector}  →  ${v.allowedBy}`);
  }
  if (r.advisories.length) {
    console.log(`\n  提醒（不阻断）：${r.advisories.length} 条容器规则带了 isolation/perspective/will-change：`);
    for (const a of r.advisories.slice(0, 8)) console.log(`    ${a.file}:${a.line}  ${a.selector}  (${a.props.join('; ')})`);
  }

  if (r.blocking.length) {
    console.error(`\n\u2717 ${r.blocking.length} 处「容器自带层叠上下文 + z-index」：`);
    for (const v of r.blocking) {
      console.error(`    ${v.file}:${v.line}: ${v.selector}`);
      console.error(`        容器 class：${v.container}   z-index: ${v.zIndex}   上下文属性：${v.props.join('; ')}`);
    }
    console.error('\n  为什么是错的：上面这些属性会新建层叠上下文，容器里的浮层再写更高的');
    console.error('  z-index 也只在容器内部有效；容器整体又按自己的 z-index 与兄弟比较，');
    console.error('  于是「下拉明明层级更高，却被后面的表头/内容盖住」。');
    console.error('  改法：把 backdrop-filter / filter / transform / contain 从容器上拿掉，');
    console.error('  用半透明背景（var(--glass-*)）实现层次；确实需要时把浮层挂到 body 上，');
    console.error('  或者用就地注释 /* stacking-allow: 理由 */ 说明为什么内部没有浮层。');
    return false;
  }
  console.log('\n\u2713 没有「容器自带层叠上下文 + z-index」的写法');
  return true;
}

function selfTest() {
  const cases = [
    {
      name: '容器 + backdrop-filter + z-index 必须被抓到',
      files: [{ file: 'x.css', text: '.toolbar { position: relative; backdrop-filter: blur(8px); z-index: 20; }' }],
      want: 1,
    },
    {
      name: '容器 + transform + z-index 也要抓到',
      files: [{ file: 'x.css', text: '.sidebar { transform: translateX(0); z-index: var(--z-base-raise); }' }],
      want: 1,
    },
    {
      name: ':is() 里的容器类名同样要识别',
      files: [{ file: 'x.css', text: "html[data-bg='image'] :is(.pnl-card, .x) { contain: paint; z-index: 3; }" }],
      want: 1,
    },
    {
      name: '容器只有上下文、没有 z-index 不报',
      files: [{ file: 'x.css', text: '.card2 { backdrop-filter: blur(12px); }' }],
      want: 0,
    },
    {
      name: '容器只有 z-index、没有上下文属性不报',
      files: [{ file: 'x.css', text: '.toolbar { position: relative; z-index: var(--z-toolbar); }' }],
      want: 0,
    },
    {
      name: '非容器元素（浮层/表头）不报',
      files: [{ file: 'x.css', text: '.modal-overlay { backdrop-filter: blur(4px); z-index: var(--z-overlay); }' }],
      want: 0,
    },
    {
      name: '带理由的就地注解可以放行',
      files: [
        {
          file: 'x.css',
          text: '/* stacking-allow: 内部没有浮层，模糊只作用于自身 */\n.card2 { backdrop-filter: blur(8px); z-index: 2; }',
        },
      ],
      want: 0,
    },
    {
      name: '理由太短的就地注解不放行',
      files: [{ file: 'x.css', text: '/* stacking-allow: 嗯 */\n.card2 { backdrop-filter: blur(8px); z-index: 2; }' }],
      want: 1,
    },
    {
      name: '注释掉的坏写法不算（postcss 天然剥离）',
      files: [{ file: 'x.css', text: '/* .toolbar { backdrop-filter: blur(8px); z-index: 20; } */\n.a { color: red; }' }],
      want: 0,
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
    if (r.blocking.length === c.want) console.log(`\u2713 ${c.name}`);
    else {
      failed += 1;
      console.error(`\u2717 ${c.name}：期望 ${c.want} 条，实得 ${r.blocking.length} 条`);
    }
  }

  // 白名单理由校验本身也要自证
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

  console.log(`\n自测 ${cases.length + 1} 项，失败 ${failed} 项`);
  if (failed) {
    console.error('\u2717 门禁自测失败：脚本抓不到该抓的问题，修好它再看别的');
    return false;
  }
  console.log('\u2713 门禁自测通过（能抓到容器自带上下文 + z-index，不误报纯浮层与纯容器）');
  return true;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(selfTest() ? 0 : 2);

  const allowPatterns = argv
    .filter((a) => a.startsWith('--allow='))
    .flatMap((a) => a.slice(8).split(','))
    .filter(Boolean);

  // 支持 `--file=a.css` 与 `--file a.css` 两种写法（与 check-z-index.js 一致）
  const eq = argv.find((a) => a.startsWith('--file='));
  const idx = argv.indexOf('--file');
  const target = eq ? eq.slice(7) : idx >= 0 ? argv[idx + 1] : null;
  if (target) {
    const entries = [{ file: target, text: fs.readFileSync(target, 'utf8') }];
    process.exit(report(analyze(entries, { allowPatterns, skipAllowValidation: true })) ? 0 : 1);
  }

  let r;
  try {
    r = analyze(readCss(), { allowPatterns });
  } catch (e) {
    console.error(`\u2717 ${e.message}`);
    process.exit(1);
  }
  process.exit(report(r) ? 0 : 1);
}

module.exports = { analyze, readCss, selfTest, containerClasses, ALLOW };
