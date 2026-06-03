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

// 0. Clean
console.log(`${CYAN}═══════════════════════════════════════${RESET}`);
console.log(`${CYAN}  网址管理器 - 自动化构建${RESET}`);
console.log(`${CYAN}═══════════════════════════════════════${RESET}`);

['dist', 'release', path.join('node_modules', '.cache')].forEach(d => {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
});
console.log(`${GREEN}✓ 清理旧缓存${RESET}`);

// 1. Build renderer
step('构建 Renderer (Vite)', 'npx vite build');

// 2. Pack Electron app
step('打包 Electron 应用', 'npx electron-builder --dir --publish never');

// 3. Fix icon (rcedit workaround for Chinese path)
step('修复 EXE 图标', 'node scripts/fix-icon.js');

// 4. Build NSIS installer
step('生成 NSIS 安装程序', 'npx electron-builder --prepackaged release\\win-unpacked --win nsis --publish never');

// 5. Verify
const installer = path.join(ROOT, 'release', '网址管理器 Setup 1.0.1.exe');
if (fs.existsSync(installer)) {
  const size = (fs.statSync(installer).size / 1024 / 1024).toFixed(1);
  console.log(`\n${GREEN}═══════════════════════════════════════${RESET}`);
  console.log(`${GREEN}  构建成功！${RESET}`);
  console.log(`${GREEN}  安装包: release\\网址管理器 Setup 1.0.1.exe (${size} MB)${RESET}`);
  console.log(`${GREEN}═══════════════════════════════════════${RESET}`);
} else {
  console.error(`${RED}✗ 未找到安装包！${RESET}`);
  process.exit(1);
}
