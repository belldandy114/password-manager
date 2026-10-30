'use strict';

/**
 * 把刚构建好的安装包装到本机当前版本的位置（覆盖安装），不用发 Release 也能验证。
 *
 * 为什么需要：这个项目踩过两次「源码改好了，但装的还是旧版」，用户以为没修（1.7.7 那次）。
 * 发版验证要 25 分钟；本地覆盖安装只要 30 秒。
 *
 * 用法：
 *   node scripts/install-local.js            # 用 release 下最新安装包，静默覆盖安装
 *   node scripts/install-local.js --dry-run  # 只打印将执行什么
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const productName = (pkg.build && pkg.build.productName) || pkg.productName || '测试中台';
const version = pkg.version;
const dryRun = process.argv.includes('--dry-run');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** 找安装包：优先精确版本，其次 release 下最新的 Setup exe */
function findInstaller() {
  const releaseDir = path.join(ROOT, 'release');
  const exact = path.join(releaseDir, `${productName} Setup ${version}.exe`);
  if (fs.existsSync(exact)) return exact;
  if (!fs.existsSync(releaseDir)) fail('release 目录不存在，先跑 npm run dist');
  const candidates = fs.readdirSync(releaseDir)
    .filter((f) => /Setup .+\.exe$/i.test(f))
    .map((f) => path.join(releaseDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) fail(`没有找到安装包（期望 ${path.basename(exact)}）`);
  return candidates[0];
}

/** 当前已安装目录：默认是「当前用户安装」路径；存在才用它，否则交给 NSIS 默认 */
function installedDir() {
  const perUser = path.join(process.env.LOCALAPPDATA || '', 'Programs', productName);
  if (process.env.LOCALAPPDATA && fs.existsSync(perUser)) return perUser;
  const progFiles = path.join(process.env.ProgramFiles || 'C:\\Program Files', productName);
  if (fs.existsSync(progFiles)) return progFiles;
  return '';
}

const installer = findInstaller();
const targetDir = installedDir();
const args = ['/S'];
if (targetDir) args.push(`/D=${targetDir}`);

console.log(`安装包：${installer}`);
console.log(`目标目录：${targetDir || '（NSIS 默认位置）'}`);
console.log(`命令：${path.basename(installer)} ${args.join(' ')}`);

if (dryRun) {
  console.log('\n--dry-run：未执行');
  process.exit(0);
}

try {
  execFileSync(installer, args, { stdio: 'inherit', windowsHide: true });
} catch (e) {
  fail(`安装失败：${e.message}`);
}

// NSIS /S 是异步退出的，给它一点时间落盘
const exe = path.join(targetDir || '', `${productName}.exe`);
const started = Date.now();
while (Date.now() - started < 15000) {
  try {
    const st = fs.statSync(exe);
    console.log(`✓ 已覆盖安装：${exe}（${new Date(st.mtimeMs).toLocaleString()}）`);
    process.exit(0);
  } catch { /* 等它落盘 */ }
}

if (targetDir) {
  console.log(`⚠ 安装器已执行，但没在 15 秒内看到 ${exe}。请手动确认。`);
} else {
  console.log('✓ 安装器已执行（未指定目标目录时无法自动校验，请从开始菜单启动确认版本号）');
}
