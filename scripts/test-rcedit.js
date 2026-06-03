// Check app-builder icon details and test setting on exe
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

const appBuilder = path.resolve('node_modules/app-builder-bin/win/x64/app-builder.exe');
const ico = path.resolve('图标.ico');
const exe = path.resolve('release/win-unpacked/网址管理器.exe');

console.log('=== Step 1: app-builder icon resolution ===');
const outDir = path.resolve('.icon-test');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

try {
  const cmd = `"${appBuilder}" icon --format ico --root . --out "${outDir}" --input "${ico}"`;
  const r = execSync(cmd, { shell: true, timeout: 30000 });
  console.log('Result:', r.toString().trim());
} catch (e) {
  console.error('FAIL:', (e.stderr || e.message).toString().slice(0, 500));
}

console.log('\n=== Step 2: app-builder rcedit on exe ===');
if (fs.existsSync(exe)) {
  try {
    const cmd = `"${appBuilder}" rcedit --args "${JSON.stringify(['--set-icon', ico, '--set-version-string', 'FileDescription', '网址管理器']).replace(/"/g,'\\"')}" --exec "${exe}"`;
    console.log('Running rcedit via app-builder...');
    const r = execSync(cmd, { shell: true, timeout: 30000 });
    console.log('OK:', r.toString().slice(0, 500));
  } catch (e) {
    console.log('FAIL:', (e.stderr || e.message).toString().slice(0, 500));
  }
}

// Clean up
try { fs.rmSync(outDir, { recursive: true }); } catch(e) {}
