/**
 * repack.js — 重新打包（不新建发布目录，也不受 app.asar 锁影响）
 *
 * 和 `npm run dist` 的区别：
 * dist 会先清空输出目录，而本机的 `resources/app.asar` 一旦生成就删不掉
 * （unlink / rename 均 EBUSY），于是打包第一步就失败，历史上只能换个目录名重来，
 * 堆出一堆 release-1.21.2b / c / build / latest。
 *
 * 这里改成：
 *   1. 构建 renderer + 子应用
 *   2. electron-builder 打到系统临时目录（全新的，可以随便清）
 *   3. 用 scripts/lib/apply-unpacked.js 覆盖回 release/win-unpacked
 *      —— 覆盖用的是 robocopy 的「就地写」，不需要删文件，因此绕过那把锁
 *
 * 只出 --dir 产物（win-unpacked），不生成 NSIS 安装程序；
 * 需要安装包时再跑 `npm run dist`（前提是先重启把锁释放掉）。
 *
 * 用法：
 *   npm run repack                  # 输出到 release/win-unpacked
 *   PM_RELEASE_DIR=run npm run repack
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { applyUnpacked } = require('./lib/apply-unpacked');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR_NAME = process.env.PM_RELEASE_DIR || 'release';
const TARGET = path.join(ROOT, OUT_DIR_NAME, 'win-unpacked');
const STAGE_ROOT = path.join(os.tmpdir(), 'pm-repack-stage');
const STAGE = path.join(STAGE_ROOT, 'win-unpacked');

function run(label, cmd, opts = {}) {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
  try {
    execFileSync(cmd, {
      cwd: ROOT,
      shell: true,
      stdio: 'inherit',
      timeout: 600000,
      ...opts,
    });
    console.log(`\x1b[32m✓ ${label}\x1b[0m`);
  } catch (e) {
    console.error(`\x1b[31m✗ ${label} 失败: ${e.message}\x1b[0m`);
    process.exit(1);
  }
}

// 临时把 build.electronDist 指向本地 electron，规避本机 EPERM（和 build-installer 同款处理）
function patchElectronDist(add) {
  const p = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (add && fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
    pkg.build.electronDist = 'node_modules/electron/dist';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  } else if (!add) {
    delete pkg.build.electronDist;
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  }
}

function main() {
  if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';
  }

  run('构建 Renderer', 'npx vite build');

  // 临时目录通常可以正常清理；清不掉就让 electron-builder 自己处理
  try {
    fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  } catch {
    console.warn('⚠ 临时目录清理失败，继续（electron-builder 会覆盖写）');
  }

  patchElectronDist(true);
  try {
    run('打包 (--dir)', `npx electron-builder --dir --publish never -c.directories.output="${STAGE_ROOT.replace(/\\/g, '/')}"`);
  } finally {
    patchElectronDist(false);
  }

  if (!fs.existsSync(path.join(STAGE, '测试中台.exe'))) {
    console.error('✗ 临时产物里没有 exe，打包未完成');
    process.exit(1);
  }

  console.log(`\n\x1b[36m▶ 覆盖到 ${OUT_DIR_NAME}/win-unpacked\x1b[0m`);
  const r = applyUnpacked(STAGE, TARGET);
  console.log(`  robocopy exit=${r.robocopyCode}`);
  console.log(r.patched.length ? `  asar 就地覆盖: ${r.patched.join(', ')}` : '  asar 无需覆盖');
  console.log(`\x1b[32m✓ 完成：${path.join(TARGET, '测试中台.exe')}\x1b[0m`);
}

main();
