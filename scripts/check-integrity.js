/**
 * check-integrity.js — 打包产物完整性级别自检
 *
 * 背景：如果 exe 或所在目录带了「低完整性级别（Low Mandatory Level）」标签，
 * Chromium 的沙箱初始化会失败，表现为双击 exe 后一闪就退出（退出码 0x80000003），
 * 且没有任何日志。产物目录被设成 Low IL 的继承标签时，构建出来的文件会全部继承它。
 *
 * 用法：node scripts/check-integrity.js [--fix]
 *   --fix  发现问题时自动把目标（及其后代）改回 Medium
 */
const fs = require('fs');
const { pickExe } = require('./pick-exe');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const UNPACKED = path.join(RELEASE, 'win-unpacked');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const installer = path.join(RELEASE, `测试工具 Setup ${pkg.version}.exe`);

// 关键路径（不必扫描几千个文件：关键路径没问题，其余同目录文件继承同一标签）
const targets = [
  { path: ROOT, label: '源码目录' },
  { path: RELEASE, label: 'release 目录' },
  { path: UNPACKED, label: 'win-unpacked 目录' },
  { path: pickExe(UNPACKED), label: '主程序' },
  { path: path.join(UNPACKED, 'resources', 'app.asar'), label: 'app.asar' },
  { path: path.join(UNPACKED, 'resources', 'elevate.exe'), label: 'elevate.exe' },
  { path: installer, label: '安装包' },
].filter(t => fs.existsSync(t.path));

function readLabel(p) {
  try {
    const out = execFileSync('icacls', [p], { encoding: 'latin1', windowsHide: true });
    if (/Low Mandatory Level/.test(out)) return 'Low';
    if (/Medium Mandatory Level/.test(out)) return 'Medium';
    if (/High Mandatory Level/.test(out)) return 'High';
    return 'None';
  } catch (e) {
    return 'Unknown';
  }
}

function fix(p) {
  try {
    execFileSync('icacls', [p, '/setintegritylevel', '(OI)(CI)Medium', '/T'],
      { encoding: 'latin1', windowsHide: true, stdio: 'ignore', timeout: 300000 });
    return true;
  } catch (e) {
    return false;
  }
}

const doFix = process.argv.includes('--fix');
let bad = [];

console.log('完整性级别检查（Low = 会导致双击闪退）');
console.log('─'.repeat(60));

for (const t of targets) {
  const label = readLabel(t.path);
  const mark = label === 'Low' ? '✗' : label === 'Unknown' ? '?' : '✓';
  console.log(`${mark} ${label.padEnd(7)} ${t.label}  ${path.relative(ROOT, t.path) || '.'}`);
  if (label === 'Low') bad.push(t);
}

if (bad.length === 0) {
  console.log('─'.repeat(60));
  console.log('全部正常');
  process.exit(0);
}

console.log('─'.repeat(60));
console.log(`发现 ${bad.length} 处低完整性级别标签。`);

if (!doFix) {
  console.log('处理方法：node scripts/check-integrity.js --fix');
  process.exit(1);
}

let failed = [];
for (const t of bad) {
  process.stdout.write(`修复 ${t.label} … `);
  const ok = fix(t.path);
  const after = ok ? readLabel(t.path) : 'Unknown';
  console.log(ok && after !== 'Low' ? 'ok' : `失败（当前 ${after}）`);
  if (!ok || after === 'Low') failed.push(t);
}

if (failed.length > 0) {
  console.error('仍有未修复的项，请用管理员权限执行：');
  console.error('  icacls "<目录>" /setintegritylevel (OI)(CI)Medium /T');
  process.exit(1);
}
console.log('修复完成');
process.exit(0);
