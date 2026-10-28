/**
 * build-subapp.js — 构建测试数据子应用（webview 里加载的那份）
 *
 * 为什么单独一个脚本：package.json 里原来写的是
 *   cd sub-apps/test-data-generator && (test -d node_modules || npm install) && npx vite build
 * 这是 bash 语法，Windows 的 npm 用 cmd.exe 执行，cmd 没有 `test` 命令 →
 * 每次都误判成「没有 node_modules」→ 触发一次 npm install（公司网络下会长时间卡住），
 * 1.5.0 的 exe 构建就是卡在这一步。改成 node 判断 + 直接调用本地 vite，跨平台且不联网。
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'sub-apps', 'test-data-generator');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

function run(label, cmd, cwd) {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
  execSync(cmd, { cwd, shell: true, stdio: 'inherit', timeout: 600000 });
  console.log(`\x1b[32m✓ ${label}\x1b[0m`);
}

function main() {
  if (!fs.existsSync(DIR)) throw new Error(`子应用目录不存在：${DIR}`);

  if (!fs.existsSync(path.join(DIR, 'node_modules'))) {
    console.log('\x1b[33m⚠ 子应用缺少依赖，先装一次\x1b[0m');
    run('安装子应用依赖', 'npm install', DIR);
  }

  const viteBin = fs.existsSync(path.join(DIR, 'node_modules', 'vite'))
    ? path.join(DIR, 'node_modules', 'vite', 'bin', 'vite.js')
    : VITE;
  if (!fs.existsSync(viteBin)) throw new Error('找不到 vite，请先在项目根或子应用里 npm install');

  run('构建子应用', `"${process.execPath}" "${viteBin}" build`, DIR);

  // vite.config.ts 里 outDir 指向项目根的 dist-tdg（主应用 electron/main.js 从那里加载）
  const out = path.join(ROOT, 'dist-tdg');
  if (!fs.existsSync(out)) throw new Error(`子应用产物目录不存在：${out}`);
  console.log(`\x1b[32m✓ 子应用产物：${out}\x1b[0m`);
}

try {
  main();
} catch (e) {
  console.error(`\x1b[31m✗ 子应用构建失败：${e.message}\x1b[0m`);
  process.exit(1);
}
