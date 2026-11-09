/**
 * preflight.js —— npm run check 的入口（提交/发版前的静态质量门禁）。
 *
 * 检查项统一放在 ci-gate.js，CI、npm run check、npm run regress 共用一份，
 * 避免「CI 只构建不测试、本地才测」的落差。
 * 工作流模板见 scripts/ci-build.yml.recommended（本机 gh token 无 workflow scope，
 * 需要手动在 GitHub 网页应用）。
 *
 * 用法：
 *   node scripts/preflight.js          # 静态门禁
 *   node scripts/preflight.js --pack   # 再加打包后 CSV 专项（需要先 npm run dist）
 */
const { runGate, step } = require('./ci-gate');

const withPack = process.argv.includes('--pack');

runGate();
if (withPack) step('打包后 CSV 专项', process.execPath, ['scripts/verify-packaged-csv.js']);

console.log('\n全部门禁通过');
