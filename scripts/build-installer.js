/**
 * build-installer.js — 全自动构建安装包
 * 1. 清理旧缓存
 * 2. 构建 renderer（Vite）
 * 3. 打包 Electron 应用
 * 4. 修复 EXE 图标（rcedit 绕过中文路径问题）
 * 5. 生成 NSIS 安装程序
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
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

// 0. Clean
console.log(`${CYAN}═══════════════════════════════════════${RESET}`);
const _pkgForTitle = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
console.log(`${CYAN}  ${(_pkgForTitle.build && _pkgForTitle.build.productName) || '测试中台'} - 自动化构建${RESET}`);

// 0. 质量门禁（CI 也跑这个脚本，所以门禁对 CI 与本地同时生效）：
//    typecheck 或单测挂了就不出包，避免「带病发版」。
//    跳过：SKIP_PREFLIGHT=1（只用于排查构建本身的问题，正式发版不要跳）。
if (process.env.SKIP_PREFLIGHT === '1') {
  console.log(`${YELLOW}⚠ SKIP_PREFLIGHT=1，已跳过类型检查与单元测试${RESET}`);
} else {
  step('质量门禁：类型检查', 'npx tsc --noEmit');
  step('质量门禁：单元测试', 'npx vitest run');
}
console.log(`${CYAN}═══════════════════════════════════════${RESET}`);

['dist', 'dist-tdg', 'release', path.join('node_modules', '.cache')].forEach(d => {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
});
console.log(`${GREEN}✓ 清理旧缓存${RESET}`);

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

// 0.5. Set electronDist if local binary exists (EPERM workaround for local env)
patchElectronDist('add');

// 1. Build renderer
step('构建 Renderer (Vite)', 'npx vite build');

// 2. Build sub-app (test-data-generator)
//    用 node 脚本而不是 `cd ... && (test -d node_modules || npm install)`：
//    后者是 bash 语法，Windows 的 cmd.exe 没有 test，会被判成缺依赖 → 每次重装 → 卡在联网。
step('构建子应用 (test-data-generator)', 'node scripts/build-subapp.js');

// 3. Pack Electron app
step('打包 Electron 应用', 'npx electron-builder --dir --publish never');

// 3. Icon: electron-builder already embeds buildResources/icon.ico via rcedit during
//    the `--dir` step, so no post-processing is needed. The old fix-icon.js step is
//    kept for reference but disabled: it targeted `password-manager-temp.exe`, a file
//    electron-builder no longer leaves behind, so it always failed with
//    "Fatal error: Unable to load file".
console.log(`\n${CYAN}▶ EXE 图标${RESET}`);
console.log(`${GREEN}✓ 图标已由 electron-builder 内置写入，跳过额外处理${RESET}`);

// 4. Build NSIS installer
step('生成 NSIS 安装程序', 'npx electron-builder --prepackaged "release/win-unpacked" --win nsis --publish never');

// 4.5 Integrity labels — a "Low Mandatory Level" label breaks the Chromium sandbox
//     and makes the exe exit silently on double click (0x80000003).
console.log(`\n${CYAN}▶ 完整性级别自检${RESET}`);
try {
  execSync('node scripts/check-integrity.js --fix', { cwd: ROOT, shell: true, stdio: 'inherit', timeout: 900000 });
  console.log(`${GREEN}✓ 完整性级别正常${RESET}`);
} catch {
  console.log(`${YELLOW}⚠ 完整性自检未通过，请手动执行：icacls "<目录>" /setintegritylevel (OI)(CI)Medium /T${RESET}`);
}

// 5. Verify
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
// 产品名从 package.json 读（1.8.0 改名「测试中台」，别写死）
const productName = pkg.build && pkg.build.productName ? pkg.build.productName : (pkg.productName || '测试中台');
const installerName = `${productName} Setup ${pkg.version}.exe`;
const installer = path.join(ROOT, 'release', installerName);
if (fs.existsSync(installer)) {
  const size = (fs.statSync(installer).size / 1024 / 1024).toFixed(1);
  console.log(`\n${GREEN}═══════════════════════════════════════${RESET}`);
  console.log(`${GREEN}  构建成功！${RESET}`);
  console.log(`${GREEN}  安装包: release\\${installerName} (${size} MB)${RESET}`);
  console.log(`${GREEN}═══════════════════════════════════════${RESET}`);
} else {
  console.error(`${RED}✗ 未找到安装包！${RESET}`);
  patchElectronDist('remove');
  process.exit(1);
}

// Cleanup: remove electronDist if it was added
patchElectronDist('remove');
