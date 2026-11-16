'use strict';

/**
 * ci-gate.js —— 可复用的静态质量门禁（不需要打包产物，也不需要 GUI）。
 *
 * 之前 .github/workflows/build.yml 只构建、不跑任何测试；本地 release.js 才有 7 项回归。
 * 现在 CI 与 npm run check / npm run regress 共用这一份，避免「改了没人测」。
 *
 * 直接运行：node scripts/ci-gate.js
 * 被引用：const { runGate } = require('./ci-gate'); runGate();
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function step(name, cmd, args) {
  process.stdout.write(`\n\u25b6 ${name}\n`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error(`\n\u2717 ${name} 失败（exit ${r.status}），已中止`);
    process.exit(r.status || 1);
  }
  console.log(`\u2713 ${name}`);
}

/**
 * 主进程语法检查：electron/*.js 逐个 `node --check`。
 *
 * 为什么需要：tsc 只覆盖 src/（tsconfig 只 include src），vitest 也只测 src/utils 的纯函数，
 * 所以 electron/ 下 40+ 个主进程模块**一行都没被门禁碰过**。拆分 IPC 时踩过：
 * 边界切错导致函数提前闭合，`node --check` 能查出来，但当时没有任何门禁在跑它，
 * 结果是运行时才报 `xxxResolve is not defined`（表现为「点按钮没反应」）。
 *
 * 成本：44 个文件约 1 秒，比一次 tsc 便宜得多。
 * 一次跑完所有文件再报错（不要第一个失败就退出），否则修一个跑一次很折磨。
 */
function checkElectronSyntax() {
  process.stdout.write('\n\u25b6 主进程语法检查 (electron/*.js node --check)\n');
  const dir = path.join(ROOT, 'electron');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const failed = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' });
    } catch (e) {
      const detail = (e.stderr || e.stdout || Buffer.from('')).toString().trim();
      failed.push({ file: f, detail });
    }
  }
  if (failed.length) {
    console.error(`\u2717 主进程语法检查失败（${failed.length}/${files.length} 个文件）`);
    for (const { file, detail } of failed) {
      console.error(`\n  electron/${file}`);
      for (const line of detail.split(/\r?\n/).slice(0, 8)) console.error(`    ${line}`);
    }
    console.error('\n  语法错误会让整个主进程起不来（双击无窗口 / 弹 "A JavaScript error occurred"）。');
    process.exit(1);
  }
  console.log(`\u2713 主进程语法检查（${files.length} 个文件）`);
}

function runGate() {
  // 公开仓库：先扫真实姓名 / 账号 / 内网地址，最便宜也最该先过。
  // --all：连未跟踪的新文件一起扫 —— 提交前最容易被忘掉的就是它们，
  //        只扫 git ls-files 会漏掉「刚写的新脚本里带了真实账号」这种情况。
  step('敏感信息检查 (check-privacy)', process.execPath, ['scripts/check-privacy.js', '--all']);
  step('类型检查 (tsc --noEmit)', npx, ['tsc', '--noEmit']);
  // tsc 只覆盖 src/，主进程靠这一步兜底（放在 tsc 之后、vitest 之前：最便宜的先跑）
  checkElectronSyntax();
  step('单元测试 (vitest run)', npx, ['vitest', 'run']);
  step('IPC 契约 (check:ipc)', process.execPath, ['scripts/check-ipc-contract.js']);
  // 拆分守卫的自测：真实文件恰好都合规时，坏掉的守卫跑真实检查永远是绿的，
  // 所以必须用内联 fixture 锁住「注入裸用要报、正确解构不报」。
  step('IPC 拆分守卫自测 (check:ipc --self-test)', process.execPath, ['scripts/check-ipc-contract.js', '--self-test']);
  // 只报告不阻断：三份 CSS 有历史重复规则，目的是让新增重复可见；
  // 但「声明完全相同」的重复已经清零，新增会失败（这是可机械清理的那一半）。
  step('CSS 重复选择器检查', process.execPath, ['scripts/check-css-dup.js']);
  // 2026-11-14 清完 926 条死声明后加的回归门禁：新增「被后面同名规则完全覆盖」的
  // 声明要拦住；同名但声明不同的冲突不拦（那本来就是本项目换肤手段，需人工确认）。
  step('CSS 级联死声明检查', process.execPath, ['scripts/css-cascade-audit.js', 'assert']);
  step('静态债预算 (check:debt)', process.execPath, ['scripts/check-debt-budget.js']);
  console.log('\n静态门禁全部通过');
}

if (require.main === module) runGate();

module.exports = { runGate, step, checkElectronSyntax };
