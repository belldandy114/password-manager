'use strict';

/**
 * 一键发布（A1）。
 *
 * 这个脚本把我之前手工做的 8 步固定下来，减少「漏一步」的风险：
 *   1. 升版本（package.json + lock）
 *   2. 构建（npm run dist，内置类型检查 + 单测门禁）
 *   3. 打包版回归（冒烟 / r9 / r10 / 启动 / CSV / 完整性 / IPC 契约）
 *   4. 改英文资产名（GitHub 会把中文名改写）
 *   5. 提交 + 推送
 *   6. 建 Release（--latest，用本地 notes）
 *   7. 等 tag 触发的 CI 跑完
 *   8. 删掉 CI 多传的 `Setup.x.y.z.exe`，并用本地 notes 覆盖 CI 写死的模板说明
 *
 * 用法：
 *   node scripts/release.js 1.9.0            # 指定版本
 *   node scripts/release.js patch            # 在现有版本上 +1（1.8.0 → 1.9.0? 不，patch 是 1.8.1）
 *   node scripts/release.js 1.9.0 --dry-run  # 只打印计划
 *   node scripts/release.js 1.9.0 --skip-tests   # 跳过回归（仅排查构建问题时用）
 *
 * 前置：release-notes-<version>.md 必须已存在（发布说明要人来写，脚本不编）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipTests = argv.includes('--skip-tests');
const versionArg = argv.find((a) => !a.startsWith('--'));

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: opts.stdio || 'pipe', ...opts }).trim();
}

function shInherit(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function step(n, title) {
  console.log(`\n──── ${n}. ${title}`);
}

function run(cmd, { optional = false } = {}) {
  if (dryRun) {
    console.log(`   [dry-run] ${cmd}`);
    return '';
  }
  try {
    return sh(cmd);
  } catch (e) {
    if (optional) {
      console.log(`   ! 失败但继续：${e.message.split('\n')[0]}`);
      return '';
    }
    fail(`命令失败：${cmd}\n${e.stdout || ''}${e.stderr || ''}`);
  }
}

// ---------------- 0. 参数与前置检查 ----------------
const pkgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const productName = (pkgRaw.build && pkgRaw.build.productName) || pkgRaw.productName || '测试中台';
const current = pkgRaw.version;

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`当前版本号不是 x.y.z：${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

let next = versionArg || '';
if (next === 'patch') next = bumpPatch(current);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  fail(`请给出目标版本号（x.y.z / patch），收到：${versionArg || '(空)'}\n  当前版本：${current}`);
}
if (next === current) fail(`目标版本与当前一致：${next}`);

const notesFile = path.join(ROOT, `release-notes-${next}.md`);
if (!fs.existsSync(notesFile)) {
  fail(`缺少发布说明：release-notes-${next}.md（请先写好再发）`);
}
if (fs.readFileSync(notesFile, 'utf8').trim().length < 50) {
  fail('发布说明太短（< 50 字符），请写清楚改了什么');
}

console.log(`发布：${productName} ${current} → ${next}`);
console.log(`说明：${path.basename(notesFile)}`);
if (dryRun) console.log('模式：dry-run（只打印，不执行）');

// 工作区必须干净（否则不知道这次发的是什么）
if (!dryRun) {
  const dirty = sh('git status --porcelain');
  if (dirty) fail(`工作区有未提交改动，先提交或清理：\n${dirty}`);
}

// ---------------- 1. 升版本 ----------------
step(1, '升版本号');
if (!dryRun) {
  const pj = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(`"version": "${current}"`, `"version": "${next}"`);
  fs.writeFileSync(path.join(ROOT, 'package.json'), pj);
}
run('npm install --package-lock-only --ignore-scripts');

// ---------------- 2. 构建 ----------------
step(2, '构建安装包（含类型检查 + 单测门禁）');
if (!dryRun) process.env.ELECTRON_BUILDER_CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
if (dryRun) console.log('   [dry-run] npm run dist');
else shInherit('npm run dist');

// ---------------- 3. 打包版回归 ----------------
if (skipTests) {
  step(3, '打包版回归（已跳过）');
} else {
  step(3, '打包版回归');
  const suites = [
    ['冒烟', 'npm run smoke'],
    ['IPC 契约', 'npm run check:ipc'],
    ['完整性', 'npm run check:integrity'],
    ['CSV 打包校验', 'node scripts/verify-packaged-csv.js'],
    ['综合回归 r9', 'node scripts/ui-round9-test.js'],
    ['压力测试 r10', 'node scripts/ui-round10-test.js'],
    ['启动期回归', 'node scripts/ui-startup-test.js'],
  ];
  for (const [name, cmd] of suites) {
    console.log(`   · ${name}`);
    run(cmd);
  }
}

// ---------------- 4. 英文资产名 ----------------
step(4, '准备发布资产（英文名，避免 GitHub 改名）');
const installer = path.join(ROOT, 'release', `${productName} Setup ${next}.exe`);
const asset = path.join(ROOT, 'release', `PasswordManager-Setup-${next}.exe`);
if (dryRun) {
  console.log(`   [dry-run] copy ${path.basename(installer)} → ${path.basename(asset)}`);
} else {
  if (!fs.existsSync(installer)) fail(`没找到安装包：${installer}`);
  fs.copyFileSync(installer, asset);
  console.log(`   ${path.basename(asset)}  ${(fs.statSync(asset).size / 1024 / 1024).toFixed(1)} MB`);
}

// ---------------- 5. 提交 + 推送 ----------------
step(5, '提交并推送 master');
const msg = `chore: ${next}（${productName}）`;
run(`git add -A`);
run(`git commit -q -m "${msg}"`);
// push 一次失败多半是代理抖动（SSL_ERROR_SYSCALL），重试几次通常就过
let pushedOk = false;
for (let i = 1; i <= 4; i++) {
  try {
    sh('git push origin master');
    pushedOk = true;
    console.log(`   已推送（第 ${i} 次）`);
    break;
  } catch (e) {
    const last = String(e.stderr || e.message || '').split('\n').filter(Boolean).pop() || '';
    console.log(`   第 ${i} 次推送失败：${last}`);
    if (i === 4) break;
    execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'timeout /t 5 >nul'] : ['-c', 'sleep 5']);
  }
}
if (!pushedOk) fail('推送失败（检查代理 http.proxy，公司网络常见 SSL_ERROR_SYSCALL）');
const head = dryRun ? '(dry-run)' : sh('git rev-parse --short HEAD');
console.log(`   HEAD ${head}`);

// ---------------- 6. 建 Release ----------------
step(6, '创建 GitHub Release');
if (dryRun) {
  console.log(`   [dry-run] gh release create v${next} ${path.basename(asset)} --title ... --notes-file ... --latest --target master`);
} else {
  const out = sh(`gh release create v${next} "${asset}" --title "${productName} v${next}" --notes-file "${notesFile}" --latest --target master`);
  console.log(`   ${out}`);
}

// ---------------- 7. 等 CI ----------------
step(7, '等待 tag 触发的 CI');
if (dryRun) {
  console.log('   [dry-run] 轮询 gh run list 直到完成');
} else {
  let runId = '';
  for (let i = 0; i < 30 && !runId; i++) {
    try {
      const j = JSON.parse(sh('gh run list --limit 5 --json databaseId,headBranch,status'));
      const hit = j.find((r) => r.headBranch === `v${next}`);
      if (hit) runId = String(hit.databaseId);
    } catch { /* 稍后再试 */ }
    if (!runId) execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'timeout /t 5 >nul'] : ['-c', 'sleep 5']);
  }
  if (!runId) fail('没找到 tag 对应的 CI run，请手动检查 Actions');
  console.log(`   run ${runId}`);
  for (let i = 0; i < 120; i++) {
    const st = JSON.parse(sh(`gh run view ${runId} --json status,conclusion`));
    if (st.status === 'completed') {
      if (st.conclusion !== 'success') fail(`CI 失败（${st.conclusion}），先修再发`);
      console.log('   CI 成功');
      break;
    }
    execFileSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', 'timeout /t 10 >nul'] : ['-c', 'sleep 10']);
  }
}

// ---------------- 8. 清理 CI 覆盖 ----------------
step(8, '清理 CI 多传的附件 + 回填说明');
if (dryRun) {
  console.log(`   [dry-run] gh release delete-asset v${next} Setup.${next}.exe -y`);
  console.log(`   [dry-run] gh release edit v${next} --notes-file ${path.basename(notesFile)}`);
} else {
  run(`gh release delete-asset v${next} Setup.${next}.exe -y`, { optional: true });
  run(`gh release edit v${next} --notes-file "${notesFile}"`);
  const info = JSON.parse(sh(`gh release view v${next} --json assets,isLatest,tagName`));
  console.log(`   附件：${info.assets.map((a) => a.name).join(', ')}`);
  console.log(`   Latest：${info.isLatest}`);
}

console.log(`\n✓ 完成：v${next}`);
console.log('   建议再核对一次 digest：gh api repos/.../releases/latest --jq ".assets[0].digest"');
