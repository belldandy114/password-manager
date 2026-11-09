/**
 * build-installer.js — 全自动构建安装包
 * 1. 质量门禁（ci-gate：隐私 / 类型 / 单测 / IPC 契约 / CSS 报告）
 * 2. 清理编译产物
 * 3. 构建 renderer / 子应用
 * 4. 打包到系统临时目录，再就地覆盖回 <OUT_DIR>/win-unpacked
 * 5. 从 win-unpacked 生成 NSIS 安装程序
 * 6. 完整性级别自检
 *
 * 为什么不再「清空输出目录后直接打包」：
 * 这台机器上 `resources/app.asar` 一旦生成就删不掉也改不了名（unlink / rename 都是 EBUSY），
 * electron-builder --dir 的第一步是清空输出目录，于是必然失败 —— 历史上只能换 PM_RELEASE_DIR
 * 重来，堆出 release-1.21.2b / c / build / latest 一堆目录。
 * 现在改成「打到全新的临时目录 + robocopy 就地覆盖」，不需要删任何被锁的文件。
 */
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { applyUnpacked } = require('./lib/apply-unpacked');
const { runGate } = require('./ci-gate');

const ROOT = path.resolve(__dirname, '..');
// 输出目录可用 PM_RELEASE_DIR 覆盖。默认 release。
const OUT_DIR_NAME = process.env.PM_RELEASE_DIR || 'release';
const OUT_DIR = path.join(ROOT, OUT_DIR_NAME);
const STAGE_ROOT = path.join(os.tmpdir(), 'pm-dist-stage');
const STAGE = path.join(STAGE_ROOT, 'win-unpacked');
const NSIS_OUT = path.join(os.tmpdir(), 'pm-nsis-stage');
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';

function step(label, cmd) {
  console.log(`\n${CYAN}▶ ${label}${RESET}`);
  try {
    execSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit', timeout: 600000 });
    console.log(`${GREEN}✓ ${label}${RESET}`);
  } catch (e) {
    console.error(`${RED}✗ ${label} 失败: ${e.message}${RESET}`);
    process.exit(1);
  }
}

/** 删不掉就跳过：临时目录偶尔会被索引器/杀软咬住，没必要为它中断构建 */
function cleanDir(p, label) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`${GREEN}✓ 清理 ${label}${RESET}`);
  } catch {
    console.log(`${YELLOW}⚠ ${label} 清理失败，继续（会被覆盖写）${RESET}`);
  }
}

// 0. Electron-builder 的下载缓存：不指定时它会去 GitHub 拉 nsis/winCodeSign，
//    公司网络下会卡到超时（1.5.0 构建卡住的第二个诱因）。本机缓存默认在这里。
if (!process.env.ELECTRON_BUILDER_CACHE) {
  const cache = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'electron-builder', 'Cache');
  if (fs.existsSync(cache)) {
    process.env.ELECTRON_BUILDER_CACHE = cache;
    console.log(`${GREEN}✓ 使用本机 electron-builder 缓存：${cache}${RESET}`);
  } else {
    console.log(`${YELLOW}⚠ 未找到 electron-builder 缓存，NSIS 阶段可能需要联网下载${RESET}`);
  }
}

console.log(`${CYAN}═══════════════════════════════════════${RESET}`);
const _pkgForTitle = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
console.log(`${CYAN}  ${(_pkgForTitle.build && _pkgForTitle.build.productName) || '测试中台'} - 自动化构建${RESET}`);

// 0. 质量门禁（CI 也跑这个脚本，所以门禁对 CI 与本地同时生效）：
//    统一走 ci-gate：隐私扫描 → 类型检查 → 单测 → IPC 契约 → CSS 重复报告。
//    以前这里只跑 tsc + vitest，隐私与 IPC 契约只有本地手动跑，容易漏。
//    跳过：SKIP_PREFLIGHT=1（只用于排查构建本身的问题，正式发版不要跳）。
if (process.env.SKIP_PREFLIGHT === '1') {
  console.log(`${YELLOW}⚠ SKIP_PREFLIGHT=1，已跳过全部门禁${RESET}`);
} else {
  runGate();
}
console.log(`${CYAN}═══════════════════════════════════════${RESET}`);

// 1. 清理编译产物。
//    注意：**不能删 OUT_DIR**，里面的 resources/app.asar 被系统句柄占住（EBUSY），
//    删它会直接让整个构建挂掉 —— 这是历史上目录越堆越多的根因。
cleanDir(path.join(ROOT, 'dist'), 'dist');
cleanDir(path.join(ROOT, 'dist-tdg'), 'dist-tdg');
cleanDir(path.join(ROOT, 'node_modules', '.cache'), 'node_modules/.cache');
cleanDir(STAGE_ROOT, '打包临时目录');
cleanDir(NSIS_OUT, '安装包临时目录');

// Helper: temporarily set electronDist if local electron dist exists (EPERM workaround)
function patchElectronDist(action) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const localDist = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (action === 'add' && fs.existsSync(localDist)) {
    pkg.build.electronDist = 'node_modules/electron/dist';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`${GREEN}✓ electronDist 已设置 (本地构建)${RESET}`);
  } else if (action === 'remove') {
    delete pkg.build.electronDist;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`${GREEN}✓ electronDist 已清理${RESET}`);
  }
}

// 2. Build renderer
step('构建 Renderer (Vite)', 'npx vite build');

// 3. Build sub-app (test-data-generator)
//    用 node 脚本而不是 `cd ... && (test -d node_modules || npm install)`：
//    后者是 bash 语法，Windows 的 cmd.exe 没有 test，会被判成缺依赖 → 每次重装 → 卡在联网。
step('构建子应用 (test-data-generator)', 'node scripts/build-subapp.js');

// 4. Pack Electron app 到临时目录
patchElectronDist('add');
try {
  step('打包 Electron 应用', `npx electron-builder --dir --publish never -c.directories.output="${STAGE_ROOT.replace(/\\/g, '/')}"`);

  if (!fs.existsSync(path.join(STAGE, '测试中台.exe'))) {
    throw new Error('临时产物里没有 exe，打包未完成');
  }

  console.log(`\n${CYAN}▶ 覆盖到 ${OUT_DIR_NAME}/win-unpacked${RESET}`);
  const r = applyUnpacked(STAGE, path.join(OUT_DIR, 'win-unpacked'));
  console.log(`  robocopy exit=${r.robocopyCode}`);
  console.log(r.patched.length ? `  asar 就地覆盖: ${r.patched.join(', ')}` : '  asar 无需覆盖');
  console.log(`${GREEN}✓ 覆盖完成${RESET}`);
} catch (e) {
  console.error(`${RED}✗ 打包失败: ${e.message}${RESET}`);
  patchElectronDist('remove');
  process.exit(1);
}

// 4.1 打包产物自检：防「asar 里是旧 CSS」「漏了 dist-tdg / unpacked」这两类历史事故
console.log(`\n${CYAN}▶ 打包产物自检${RESET}`);
try {
  const asar = require('@electron/asar');
  const asarPath = path.join(OUT_DIR, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) throw new Error('app.asar 不存在');
  const entries = asar.listPackage(asarPath).map(p => String(p).replace(/\\/g, '/'));
  const distCss = fs.readdirSync(path.join(ROOT, 'dist', 'assets')).filter(f => f.endsWith('.css')).sort();
  const packedCss = entries
    .filter(p => p.includes('dist/assets/') && p.endsWith('.css'))
    .map(p => path.basename(p)).sort();
  if (JSON.stringify(distCss) !== JSON.stringify(packedCss)) {
    throw new Error(`CSS 不一致：dist=[${distCss}] asar=[${packedCss}]`);
  }
  if (!entries.some(p => p.includes('dist-tdg/'))) throw new Error('asar 缺少 dist-tdg');
  const unp = path.join(OUT_DIR, 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist-tdg', 'index.html');
  if (!fs.existsSync(unp)) throw new Error('app.asar.unpacked/dist-tdg 缺失（测试数据页会报 ERR_FILE_NOT_FOUND）');
  console.log(`${GREEN}✓ CSS hash / 子应用 / unpacked 项齐全${RESET}`);
} catch (e) {
  console.error(`${RED}✗ 打包产物自检失败: ${e.message}${RESET}`);
  patchElectronDist('remove');
  process.exit(1);
}

// 5. Build NSIS installer
//    从已经打好的 win-unpacked 出安装包，输出到临时目录再拷回来：
//    直接在 release/ 出包会撞上「清空 output 目录」那一步的 EBUSY。
console.log(`\n${CYAN}▶ 生成 NSIS 安装程序${RESET}`);
try {
  execFileSync(
    'npx',
    ['electron-builder', '--prepackaged', path.join(OUT_DIR, 'win-unpacked'), '--win', 'nsis', '--publish', 'never', `-c.directories.output=${NSIS_OUT.replace(/\\/g, '/')}`],
    { cwd: ROOT, shell: true, stdio: 'inherit', timeout: 900000 }
  );
  console.log(`${GREEN}✓ 生成 NSIS 安装程序${RESET}`);
} catch (e) {
  console.error(`${RED}✗ 生成 NSIS 安装程序失败: ${e.message}${RESET}`);
  patchElectronDist('remove');
  process.exit(1);
}

// 5.1 把安装包从临时目录拷到输出目录
const pkgAfter = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const productNameEarly = (pkgAfter.build && pkgAfter.build.productName) || pkgAfter.productName || '测试中台';
const builtInstallerName = `${productNameEarly} Setup ${pkgAfter.version}.exe`;
const builtInstaller = path.join(NSIS_OUT, builtInstallerName);
if (!fs.existsSync(builtInstaller)) {
  console.error(`${RED}✗ 临时目录里没有安装包：${builtInstaller}${RESET}`);
  patchElectronDist('remove');
  process.exit(1);
}
fs.copyFileSync(builtInstaller, path.join(OUT_DIR, builtInstallerName));
console.log(`${GREEN}✓ 安装包已就位：${OUT_DIR_NAME}/${builtInstallerName}${RESET}`);

// 6. Integrity labels — a "Low Mandatory Level" label breaks the Chromium sandbox
//     and makes the exe exit silently on double click (0x80000003).
console.log(`\n${CYAN}▶ 完整性级别自检${RESET}`);
try {
  execSync('node scripts/check-integrity.js --fix', { cwd: ROOT, shell: true, stdio: 'inherit', timeout: 900000 });
  console.log(`${GREEN}✓ 完整性级别正常${RESET}`);
} catch {
  console.log(`${YELLOW}⚠ 完整性自检未通过，请手动执行：icacls "<目录>" /setintegritylevel (OI)(CI)Medium /T${RESET}`);
}

// 7. Verify
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
// 产品名从 package.json 读（1.8.0 改名「测试中台」，别写死）
const productName = pkg.build && pkg.build.productName ? pkg.build.productName : (pkg.productName || '测试中台');
const installerName = `${productName} Setup ${pkg.version}.exe`;
const installer = path.join(OUT_DIR, installerName);
if (fs.existsSync(installer)) {
  const size = (fs.statSync(installer).size / 1024 / 1024).toFixed(1);
  console.log(`\n${GREEN}═══════════════════════════════════════${RESET}`);
  console.log(`${GREEN}  构建成功！${RESET}`);
  console.log(`${GREEN}  安装包: ${OUT_DIR_NAME}\\${installerName} (${size} MB)${RESET}`);
  console.log(`${GREEN}═══════════════════════════════════════${RESET}`);
} else {
  console.error(`${RED}✗ 未找到安装包！${RESET}`);
  patchElectronDist('remove');
  process.exit(1);
}

// Cleanup: remove electronDist if it was added
patchElectronDist('remove');
