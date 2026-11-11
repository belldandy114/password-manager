'use strict';

/**
 * check-css-dup.js —— 报告跨样式表重复定义的选择器（只报告，不阻断）。
 *
 * 背景：global.css / pages.css / redesign.css 共 1.4 万行，靠 import 顺序决定谁生效
 * （global → pages → redesign）。2026-11-09 的按钮变形就是后加载的 redesign.css
 * 覆盖了 global.css 的规则。
 *
 * 输出分两类，意义完全不同：
 *   1. 冲突：同选择器、声明不同 —— 谁生效只取决于加载顺序，改样式最容易踩；
 *   2. 完全重复：同选择器、声明逐字相同 —— 删掉靠前的那些没有任何影响，
 *      是唯一可以「机械清理」的部分（脚本给出可直接删的行号与可省字节）。
 *
 * 只报告：历史债不该阻断发版。新样式请写在最后加载的 redesign.css 末尾。
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'styles');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.css')).sort();

/** 去掉注释，但保留换行以便行号准确 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * 逐字符扫描出所有「选择器 + 声明块」，支持 @media / @supports 嵌套。
 * 返回 [{ sel, body, file, line, media }]
 */
function parseRules(text, file) {
  const src = stripComments(text);
  const out = [];
  const stack = [];      // 当前所在的 at-rule 列表（"@media (...) "）
  let line = 1;
  let i = 0;
  let preludeStart = 0;
  let preludeLine = 1;

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line += 1; i += 1; continue; }

    if (ch === '{') {
      const prelude = src.slice(preludeStart, i).trim();
      const pl = preludeLine;
      if (prelude.startsWith('@')) {
        // at-rule：进入块内继续扫
        stack.push(prelude.replace(/\s+/g, ' '));
        i += 1;
        preludeStart = i;
        // 跳过 { 之后的空白/换行，供下一个 prelude 定位
        while (i < src.length && /\s/.test(src[i])) { if (src[i] === '\n') line += 1; i += 1; }
        preludeStart = i;
        preludeLine = line;
        continue;
      }
      // 普通规则：找配对的 }
      let depth = 1;
      let j = i + 1;
      let l2 = line;
      while (j < src.length && depth > 0) {
        if (src[j] === '\n') l2 += 1;
        else if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      const body = src.slice(i + 1, j - 1);
      if (prelude) {
        out.push({
          sel: prelude.replace(/\s+/g, ' '),
          body: body.trim().replace(/\s+/g, ' ').replace(/;\s*$/, ''),
          file,
          line: pl,
          media: stack.join(' '),
        });
      }
      line = l2;
      i = j;
      while (i < src.length && /\s/.test(src[i])) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      preludeStart = i;
      preludeLine = line;
      continue;
    }

    if (ch === '}') {
      stack.pop();
      i += 1;
      while (i < src.length && /\s/.test(src[i])) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      preludeStart = i;
      preludeLine = line;
      continue;
    }

    i += 1;
  }
  return out;
}

const rules = [];
let totalLines = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  totalLines += text.split(/\r?\n/).length;
  rules.push(...parseRules(text, f));
}

// 选择器（含所在 at-rule）→ 出现过的所有规则
const bySel = new Map();
for (const r of rules) {
  const key = (r.media ? `${r.media} ` : '') + r.sel;
  if (!bySel.has(key)) bySel.set(key, []);
  bySel.get(key).push(r);
}

const dupGroups = [...bySel.entries()].filter(([, v]) => v.length > 1);
const identical = [];   // 声明逐字相同（靠前的可安全删除）
const conflicting = []; // 声明不同（胜负取决于加载顺序）
let savable = 0;

for (const [sel, list] of dupGroups) {
  const bodies = new Set(list.map(r => r.body));
  if (bodies.size === 1) {
    // 保留最后一条（最后加载的那份），其余可删
    const removableChars = list.slice(0, -1).reduce((n, r) => n + r.body.length + r.sel.length + 4, 0);
    savable += removableChars;
    identical.push([sel, list, removableChars]);
  } else {
    conflicting.push([sel, list, bodies.size]);
  }
}

console.log(`样式表 ${files.length} 份 / ${totalLines} 行，规则 ${rules.length} 条，选择器 ${bySel.size} 个`);
console.log(`重复定义 ${dupGroups.length} 个：声明完全相同 ${identical.length} 个（可机械清理），声明冲突 ${conflicting.length} 个`);

identical.sort((a, b) => b[2] - a[2]);
if (identical.length) {
  console.log('\n  可直接删除的「完全重复」规则（保留最后加载的那条）：');
  for (const [sel, list, chars] of identical.slice(0, 8)) {
    const where = list.map(r => `${r.file}:${r.line}`).join(', ');
    console.log(`    ${sel}  →  ${where}   可省 ${chars} 字符`);
  }
  console.log(`    合计可省约 ${savable} 字符（${identical.length} 个选择器）`);
}

conflicting.sort((a, b) => b[1].length - a[1].length);
if (conflicting.length) {
  console.log('\n  冲突最多的选择器（同名但声明不同，谁生效只看加载顺序）：');
  for (const [sel, list, n] of conflicting.slice(0, 8)) {
    const where = list.slice(0, 4).map(r => `${r.file}:${r.line}`).join(', ');
    console.log(`    ${sel}  →  ${where}${list.length > 4 ? ` …共 ${list.length} 处` : ''}（${n} 种写法）`);
  }
}

if (dupGroups.length > 200) {
  console.log('\n  ⚠ 历史重复较多。新样式请写在最后加载的 redesign.css 末尾，')
  console.log('    需要动老规则时优先删「完全重复」那批（上面的清单），冲突类要逐个人工确认。');
}

// 「声明完全相同」是可机械清理的历史债，已经清零：以后谁再写出这种重复就拦住。
// 「声明冲突」不拦 —— global → pages → redesign 的顺序覆盖本就是本项目的换肤手段。
if (identical.length > 0) {
  console.error(`\n\u2717 出现 ${identical.length} 个「声明完全相同」的重复规则：`);
  for (const [sel, list] of identical) {
    console.error(`    ${sel}  →  ${list.map(r => `${r.file}:${r.line}`).join(', ')}`);
  }
  console.error('  删掉靠前那份（保留最后加载的），别用加载顺序去表达同一条声明。');
  process.exitCode = 1;
} else {
  console.log('\n\u2713 没有「声明完全相同」的重复规则');
}
