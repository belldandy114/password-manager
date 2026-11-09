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
const { spawnSync } = require('child_process');
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

function runGate() {
  // 公开仓库：先扫真实姓名 / 账号 / 内网地址，最便宜也最该先过
  step('敏感信息检查 (check-privacy)', process.execPath, ['scripts/check-privacy.js']);
  step('类型检查 (tsc --noEmit)', npx, ['tsc', '--noEmit']);
  step('单元测试 (vitest run)', npx, ['vitest', 'run']);
  step('IPC 契约 (check:ipc)', process.execPath, ['scripts/check-ipc-contract.js']);
  // 只报告不阻断：三份 CSS 有历史重复规则，目的是让新增重复可见
  step('CSS 重复选择器报告', process.execPath, ['scripts/check-css-dup.js']);
  console.log('\n静态门禁全部通过');
}

if (require.main === module) runGate();

module.exports = { runGate, step };
