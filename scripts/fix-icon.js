/**
 * fix-icon.js — Workaround for rcedit not supporting Chinese-named EXE files.
 * Runs after electron-builder --dir, applies the icon via rcedit on a temp copy.
 *
 * Usage: node scripts/fix-icon.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked');
const RCEDIT = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const ICO = path.join(ROOT, 'buildResources', 'icon.ico');

// Find the main exe (productName + .exe)
const exeName = '网址管理器.exe';
const exePath = path.join(UNPACKED, exeName);

if (!fs.existsSync(exePath)) {
  console.error('EXE not found:', exePath);
  process.exit(1);
}
if (!fs.existsSync(RCEDIT)) {
  console.error('rcedit not found:', RCEDIT);
  process.exit(1);
}

const tempExe = path.join(UNPACKED, 'password-manager-temp.exe');

try {
  // Copy to temp (ASCII path for rcedit compat)
  fs.copyFileSync(exePath, tempExe);

  // Set icon via rcedit
  const cmd = `"${RCEDIT}" "${tempExe}" --set-icon "${ICO}"`;
  execSync(cmd, { shell: true, timeout: 30000 });
  console.log('Icon set on temp exe');

  // Replace original
  fs.copyFileSync(tempExe, exePath);
  fs.unlinkSync(tempExe);
  console.log('Icon applied to:', exeName);
} catch (e) {
  console.error('Failed to set icon:', e.message);
  process.exit(1);
}
