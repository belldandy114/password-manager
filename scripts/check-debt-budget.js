'use strict';

/**
 * check-debt-budget.js —— 三项「只许下降」的静态债预算。
 *
 * 为什么是预算而不是清零：
 *   - !important：三份样式表顺序加载（global → pages → redesign），历史规则里有一部分必须用
 *     !important 才压得住更早的特异度更高的选择器，批量删会直接改掉视觉。所以只能逐个判断。
 *   - 色值字面量：剩下的多是「白字压彩色底」「终端配色」「阴影/遮罩」，本身合法，
 *     真正与主题相关的那批（环境徽标、环境色点）已经提成 --env-* 令牌。
 *   - eslint-disable：仓库没有 ESLint（也就没有 npm run lint），这些指令目前是纯注释；
 *     有用的信息是「抑制了哪条规则」，所以至少要写全规则名。
 *
 * 于是这里的规则是：数字不许变大。真的需要加，就改下面的 BUDGET 并在提交说明里写理由。
 *
 * 直接运行：node scripts/check-debt-budget.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 2026-11 的实测值（PR 里改小它可以，改大必须说明）
const BUDGET = {
  important: 64,
  colorLiterals: 207,
  eslintDisable: 15,
};

const SHEETS = ['src/styles/tokens.css', 'src/styles/global.css', 'src/styles/pages.css', 'src/styles/redesign.css'];

// 令牌块里本来就该写字面量，先摘掉再数
function stripTokenBlocks(css) {
  return css.replace(/(:root|\[data-theme[^\]]*\])\s*\{[^}]*\}/g, '');
}

function scanCss() {
  const perFile = {};
  let important = 0;
  let colorLiterals = 0;
  for (const rel of SHEETS) {
    const css = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const n = (css.match(/!important/g) || []).length;
    const c = (stripTokenBlocks(css).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || []).length;
    perFile[rel] = { important: n, colorLiterals: c };
    important += n;
    colorLiterals += c;
  }
  return { perFile, important, colorLiterals };
}

function scanSuppressions(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue;
      scanSuppressions(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/eslint-disable/.test(line)) return;
        // 允许 eslint-disable-next-line / eslint-disable-line / eslint-disable
        const named = /\beslint-disable[a-z-]*\s+[^\s]/.test(line) && !/eslint-disable[a-z-]*\s*$/.test(line);
        out.push({ at: `${path.relative(ROOT, p)}:${i + 1}`, line: line.trim(), named });
      });
    }
  }
  return out;
}

const css = scanCss();
const supp = scanSuppressions(path.join(ROOT, 'src'), []);

console.log('静态债预算（只许下降）');
console.log('─'.repeat(60));
for (const rel of SHEETS) {
  const v = css.perFile[rel];
  console.log(`  ${rel.padEnd(26)} !important ${String(v.important).padStart(3)}   色值 ${String(v.colorLiterals).padStart(3)}`);
}

const rows = [
  ['CSS !important', css.important, BUDGET.important],
  ['令牌之外的色值字面量', css.colorLiterals, BUDGET.colorLiterals],
  ['eslint-disable 指令', supp.length, BUDGET.eslintDisable],
];

let failed = false;
console.log('');
for (const [name, now, budget] of rows) {
  const over = now > budget;
  if (over) failed = true;
  const diff = now - budget;
  const tail = diff === 0 ? '与预算持平' : diff < 0 ? `比预算少 ${-diff}` : `超出预算 ${diff}`;
  console.log(`  ${over ? '\u2717' : '\u2713'} ${name.padEnd(22)} ${String(now).padStart(4)} / ${String(budget).padStart(4)}  ${tail}`);
}

const unnamed = supp.filter((s) => !s.named);
if (unnamed.length) {
  failed = true;
  console.error('\n\u2717 有 eslint-disable 没写规则名，以后接了 ESLint 也不知道压的是什么：');
  unnamed.forEach((s) => console.error(`    ${s.at}  ${s.line}`));
}

if (failed) {
  console.error('\n预算超了：要么把数字降回去，要么在 scripts/check-debt-budget.js 的 BUDGET 里改大并写明理由。');
  process.exitCode = 1;
} else {
  console.log('\n\u2713 三项静态债都在预算内');
}
