'use strict';

/**
 * css-cascade-audit.js —— 同名选择器「声明冲突」的分类与可证明安全的清理。
 *
 * 背景（AGENTS.md）：4 份样式表按 tokens → global → pages → redesign 顺序加载，
 * 同名选择器有 309 组声明冲突，0 组完全相同。`check-css-dup.js` 只报告，不清理，
 * 因为「整条删掉靠前的规则」会改级联：中间可能有同特异性的其它选择器插入。
 *
 * 本脚本只做一件被证明安全的事：**删掉被后面同名规则覆盖的单条声明**。
 * 同组里两条规则的选择器文本相同 ⇒ 特异性相同、命中的元素集合相同；
 * 对任意元素，靠后那条声明压过中间所有同/低特异性规则，高特异性规则又同时压过两者，
 * 因此删掉靠前那条声明不会改变任何元素的最终取值。
 *
 * 守卫：跳过 @keyframes、涉及 !important 的声明、以及「旧值作新 CSS 函数回退」的写法。
 * 写入前用 AGENTS.md 的方法做等价断言：按「同选择器 + 同 at-rule 的声明合并
 * （后者覆盖）」求值，断言所有组的最终声明 0 差异。
 *
 * 用法：
 *   node scripts/css-cascade-audit.js                 报告
 *   node scripts/css-cascade-audit.js fix            清理并写入（含等价断言）
 *   node scripts/css-cascade-audit.js verify <dir>   与旧版 CSS 目录比较最终声明
 *   node scripts/css-cascade-audit.js clean-text     输出清理后的 CSS 文本(JSON)，不改文件
 */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const DIR = path.join(__dirname, '..', 'src', 'styles');
// 必须与 src/main.tsx 的 import 顺序一致（check-css-dup.js 按字母序排，tokens 会被排到最后）
const FILES = ['tokens.css', 'global.css', 'pages.css', 'redesign.css'];
// 这些新函数若出现在「胜出」值里，靠前的旧值可能是给老浏览器的回退，保守保留
const RISKY = /color-mix\(|clamp\(|light-dark\(|oklch\(|env\(|min\(|max\(/;

function parseSet(dir = DIR) {
  return FILES.map(file => ({
    file,
    root: postcss.parse(fs.readFileSync(path.join(dir, file), 'utf8'), { from: path.join(dir, file) }),
  }));
}

/** 按「at-rule 栈 + 选择器文本」分组，保留跨文件真实源码顺序 */
function collect(set) {
  const groups = new Map();
  for (const { file, root } of set) {
    const walk = (container, stack) => container.each(node => {
      if (node.type === 'atrule') {
        if (node.nodes) walk(node, stack.concat(`@${node.name} ${String(node.params).replace(/\s+/g, ' ').trim()}`));
      } else if (node.type === 'rule') {
        const sel = node.selector.replace(/\s+/g, ' ').trim();
        const key = stack.join(' | ') + '||' + sel;
        if (!groups.has(key)) groups.set(key, { key, sel, stack, rules: [] });
        groups.get(key).rules.push({
          file, node, line: node.source.start.line,
          decls: node.nodes.filter(n => n.type === 'decl').map(d => ({
            prop: d.prop, value: d.value.replace(/\s+/g, ' ').trim(), important: !!d.important, node: d,
          })),
        });
      }
    });
    walk(root, []);
  }
  return groups;
}

/** 每条声明是否被「后面同组的同名声明」压过 */
function deadDecls(group) {
  const dead = [];
  const winner = new Map(); // prop -> 更靠后声明中的胜出者
  for (let i = group.rules.length - 1; i >= 0; i--) {
    const r = group.rules[i];
    for (const d of r.decls) {
      const w = winner.get(d.prop);
      if (!w) continue;
      // w 在 d 之后：w 胜出当且仅当 w 是 !important 或 d 不是 !important
      if (!(w.important || !d.important)) continue;
      if (d.important || w.important) continue;
      if (group.stack.some(s => s.startsWith('@keyframes'))) continue;
      if (RISKY.test(w.value) && !RISKY.test(d.value)) continue;
      dead.push({ decl: d, rule: r, winner: w });
    }
    for (const d of r.decls) {
      const w = winner.get(d.prop);
      // w 更靠后，只有 d 是 important 而 w 不是时才反过来压过 w
      if (!w || (d.important && !w.important)) winner.set(d.prop, d);
    }
  }
  return dead;
}

/** AGENTS.md 的等价模型：同组声明按源码顺序合并，后者覆盖（!important 优先） */
function finalMap(groups) {
  const out = new Map();
  for (const [key, g] of groups) {
    const m = new Map();
    for (const r of g.rules) for (const d of r.decls) {
      const cur = m.get(d.prop);
      if (cur && cur.important && !d.important) continue;
      m.set(d.prop, { value: d.value, important: d.important });
    }
    out.set(key, m);
  }
  return out;
}
// 外层也要排序：删掉整条规则会改变分组的插入顺序，但那不是级联结果的变化
const serialize = maps => JSON.stringify([...maps.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, m]) => [k, [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))]));

/** 就地清理一份 parsed CSS，返回统计 */
function clean(set) {
  const before = serialize(finalMap(collect(set)));
  const groups = collect(set);
  let removed = 0;
  const touched = new Set();
  for (const g of groups.values()) {
    if (g.rules.length < 2) continue;
    for (const d of deadDecls(g)) { d.decl.node.remove(); touched.add(d.rule.node); removed++; }
  }
  let emptyRules = 0;
  for (const r of touched) {
    if (r.parent && r.nodes.length === 0) { r.remove(); emptyRules++; }
  }
  const after = serialize(finalMap(collect(set)));
  if (before !== after) throw new Error('等价断言失败：最终声明发生变化，拒绝写入');
  return { removed, emptyRules, groups: groups.size, equivalent: true };
}

function report(set) {
  const groups = collect(set);
  const dup = [...groups.values()].filter(g => g.rules.length > 1);
  let dead = 0, fullyDead = 0;
  const byFile = {};
  for (const g of dup) {
    const ds = deadDecls(g);
    dead += ds.length;
    const per = new Map();
    for (const d of ds) {
      byFile[d.rule.file] = (byFile[d.rule.file] || 0) + 1;
      per.set(d.rule, (per.get(d.rule) || 0) + 1);
    }
    for (const r of g.rules) if (r.decls.length && per.get(r) === r.decls.length) fullyDead++;
  }
  return { conflictGroups: dup.length, deadDeclarations: dead, fullyDeadRules: fullyDead, byFile };
}

if (require.main === module) {
  const mode = process.argv[2] || 'report';
  const set = parseSet();
  if (mode === 'report') {
    const r = report(set);
    console.log(`同名选择器冲突组 ${r.conflictGroups} 个`);
    console.log(`可证明被覆盖的死声明 ${r.deadDeclarations} 条，其中整条规则失效 ${r.fullyDeadRules} 条`);
    console.log('按文件：', JSON.stringify(r.byFile));
    console.log('执行 `node scripts/css-cascade-audit.js fix` 清理（写入前会做级联等价断言）。');
  } else if (mode === 'fix') {
    const r = clean(set);
    console.log(`✓ 等价断言通过（${r.groups} 组选择器最终声明 0 差异）`);
    for (const { file, root } of set) fs.writeFileSync(path.join(DIR, file), root.toString());
    console.log(`✓ 已删除 ${r.removed} 条死声明 / ${r.emptyRules} 条空规则`);
  } else if (mode === 'verify') {
    const dir = process.argv[3];
    if (!dir) { console.error('用法：verify <旧 CSS 目录>'); process.exit(1); }
    const a = serialize(finalMap(collect(parseSet(dir))));
    const b = serialize(finalMap(collect(set)));
    if (a !== b) { console.error('✗ 与旧版相比最终声明不同'); process.exit(1); }
    console.log('✓ 与旧版相比：所有选择器组最终声明完全一致（0 差异）');
  } else if (mode === 'assert') {
    const r = report(set);
    if (r.deadDeclarations > 0) {
      console.error(`✗ 发现 ${r.deadDeclarations} 条被后面同名规则完全覆盖的死声明`);
      console.error('  执行 `node scripts/css-cascade-audit.js fix` 清理（含级联等价断言）。');
      process.exit(1);
    }
    console.log(`✓ 无死声明（${r.conflictGroups} 组同名选择器冲突均需人工确认，不阻断）`);
  } else if (mode === 'clean-text') {
    clean(set);
    process.stdout.write(JSON.stringify(set.map(({ file, root }) => ({ file, css: root.toString() }))));
  } else {
    console.error(`未知模式：${mode}`); process.exit(1);
  }
}

module.exports = { FILES, DIR, parseSet, collect, deadDecls, finalMap, serialize, clean, report };
