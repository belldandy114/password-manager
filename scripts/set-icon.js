/**
 * Check and fix icon on the built .exe
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const exe = path.join(ROOT, 'release', 'win-unpacked', '网址管理器.exe');
const rcedit = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const icoPath = path.join(ROOT, '图标.ico');

if (!fs.existsSync(exe)) {
  console.log('EXE not found at:', exe);
  process.exit(1);
}
if (!fs.existsSync(rcedit)) {
  console.log('rcedit not found at:', rcedit);
  process.exit(1);
}

console.log('EXE:', exe);
console.log('ICO:', icoPath, '(' + fs.statSync(icoPath).size + ' bytes)');

// Check current icon in the exe
try {
  const result = execSync(`"${rcedit}" "${exe}" --show-icon`, { shell: true, timeout: 10000 });
  console.log('Current icon info:', result.toString().trim());
} catch (e) {
  console.log('--show-icon not supported. Trying to set icon directly...');
}

// Set icon using rcedit
try {
  console.log('\nSetting icon...');
  execSync(`"${rcedit}" "${exe}" --set-icon "${icoPath}"`, { shell: true, timeout: 15000 });
  console.log('Icon set successfully!');
} catch (e) {
  console.error('Failed to set icon:', e.message);
  process.exit(1);
}

// Verify
console.log('\nVerifying...');
try {
  const result = execSync(`"${rcedit}" "${exe}" --show-icon`, { shell: true, timeout: 10000 });
  console.log('Updated icon info:', result.toString().trim());
} catch (e) {
  console.log('Verification not available');
}
