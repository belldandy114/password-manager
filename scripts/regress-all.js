'use strict';

/**
 * regress-all.js —— npm run regress 的入口（之前 package.json 指的文件并不存在）。
 *
 * 默认跑静态门禁（快，随时可跑）；加 --pack 再跑打包版 7 项回归（需要先 npm run dist）。
 * 发布请继续用 node scripts/release.js <version>：它还会升版本、传附件、等 CI。
 */
const { runGate, step } = require('./ci-gate');

runGate();

if (process.argv.includes('--pack')) {
  const suites = [
    ['冒烟', 'npm run smoke'],
    ['完整性', 'npm run check:integrity'],
    ['CSV 打包校验', 'node scripts/verify-packaged-csv.js'],
    ['综合回归 r9', 'node scripts/ui-round9-test.js'],
    ['快速搜索缓存', 'node scripts/ui-palette-cache-test.js'],
    ['周报跨公司生成', 'node scripts/ui-digest-test.js'],
    ['压力测试 r10', 'node scripts/ui-round10-test.js'],
    ['启动期回归', 'node scripts/ui-startup-test.js'],
    ['下载时间回归', 'node scripts/ui-dl-time-test.js'],
  ];
  for (const [name, cmd] of suites) {
    console.log(`\n──── 打包版回归 · ${name}`);
    const parts = cmd.split(' ');
    step(name, parts[0], parts.slice(1));
  }
  console.log('\n打包版回归全部通过');
} else {
  console.log('\n提示：需要打包版回归时执行 npm run regress -- --pack（先 npm run dist）');
}
