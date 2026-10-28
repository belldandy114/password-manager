/**
 * preflight.js —— 提交/发版前的质量门禁（本地版 CI gate）
 *
 * 顺序：typecheck → 单元测试 → 打包后 CSV 专项（可选）。
 * 之所以有「本地版」：本机 gh token 只有 gist/read:org/repo，
 * 没有 workflow scope，推不动 .github/workflows/build.yml（服务端直接拒绝），
 * 所以 CI 里的门禁步骤暂时只能靠这个脚本兜住。
 *
 * 用法：
 *   node scripts/preflight.js          # 类型检查 + 单测
 *   node scripts/preflight.js --pack   # 再加打包后 CSV 专项（需要先 npm run dist）
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const withPack = process.argv.includes('--pack');

function step(name, cmd, args) {
  process.stdout.write(`\n▶ ${name}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n✗ ${name} 失败（exit ${r.status}），已中止`);
    process.exit(r.status || 1);
  }
  console.log(`✓ ${name}`);
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

step('类型检查 (tsc --noEmit)', npx, ['tsc', '--noEmit']);
step('单元测试 (vitest run)', npx, ['vitest', 'run']);
if (withPack) step('打包后 CSV 专项', process.execPath, ['scripts/verify-packaged-csv.js']);

console.log('\n全部门禁通过');