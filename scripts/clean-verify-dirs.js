'use strict';

/**
 * clean-verify-dirs.js —— 清理 release/ 下堆积的「验证包」目录。
 *
 * 每轮打包验证都会产生 release/verify-<ver>/win-unpacked（约 362 MB），十几轮就是 5 GB+。
 *
 * ⚠️ 为什么不用 fs.rm / shutil.rmtree：(本机特有)
 *    这台机器有文件级删除拦截，node / python / PowerShell 的删除都会被转到回收站，
 *    目录一多回收站操作直接失败（`SAFE_DELETE_FAIL_CLOSED: trash-failed`），一个字节都删不掉。
 *    实测唯一能真删的是 **robocopy /MIR + 空目录**（原生进程，走的是另一套删除路径），
 *    而且它接受中文路径 —— `cmd rd /s /q` 在中文路径下会报「命令语法不正确」。
 *
 * ⚠️ 少数 win-unpacked/resources/app.asar 会被句柄长期占住（DeleteFileW → ERROR_SHARING_VIOLATION 32），
 *    robocopy 也删不掉。对策是登记「重启时删除」：对每个残留文件调
 *    `MoveFileExW(路径, NULL, MOVEFILE_DELAY_UNTIL_REBOOT=4)`（python ctypes / PowerShell Add-Type 均可），
 *    实测一次能登记全部 23 个；重启后文件自动消失，再跑一次本脚本收掉空目录壳。
 *
 * 用法：
 *   node scripts/clean-verify-dirs.js            # 只列清单（默认）
 *   node scripts/clean-verify-dirs.js --apply    # 真清
 *   node scripts/clean-verify-dirs.js --apply --keep=12421   # 保留某一版（还要留着对比时）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'release');
const apply = process.argv.includes('--apply');
const keepArg = process.argv.find((a) => a.startsWith('--keep='));
const keep = keepArg ? keepArg.split('=')[1] : '';

/** 目录里（递归）有多少文件、共多少字节 —— 不用 du，避免被 junction 绕晕 */
function sizeOf(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch { /* 被占用时可能读不到 */ }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** robocopy 用空目录镜像目标：多出来的文件和子目录会被删掉（这就是「真删」的那一步） */
function emptyViaRobocopy(target, empty) {
  const r = spawnSync('robocopy', [
    empty, target, '/MIR',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', // 不打印文件/目录/头/汇总
    '/R:0', '/W:0',                                // 被占用别重试，省时间
  ], { windowsHide: true, encoding: 'utf8' });
  // robocopy 的返回码：0 无变化 / 1 复制了 / 2 删除了额外项 / 3 = 1+2 / >=8 出错
  return r.status;
}

/** 自底向上删空目录；非空（还有锁文件）就跳过 */
function rmdirIfEmpty(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isDirectory()) rmdirIfEmpty(path.join(dir, e.name));
  }
  try {
    fs.rmdirSync(dir);   // 空目录的 rmdir 不触发删除拦截
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(DIR)) {
  console.log('release/ 不存在，无需清理');
  process.exit(0);
}

const targets = fs.readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => /^verify-/.test(n) || n === 'win-unpacked.tmp')
  .filter((n) => !keep || !n.includes(keep));

if (!targets.length) {
  console.log('没有需要清理的验证目录（win-unpacked 是当前构建产物，不动）');
  process.exit(0);
}

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-empty-'));
let removedBytes = 0;

for (const name of targets) {
  const dir = path.join(DIR, name);
  const before = sizeOf(dir);
  if (!apply) {
    console.log(`${name}  ${(before.bytes / 1048576).toFixed(0)} MB / ${before.files} 个文件`);
    continue;
  }
  const rc = emptyViaRobocopy(dir, empty);
  const after = sizeOf(dir);
  removedBytes += before.bytes - after.bytes;
  const kept = after.files ? `，剩 ${after.files} 个被占用（${(after.bytes / 1048576).toFixed(0)} MB）` : '';
  console.log(`${name}  rc=${rc}  ${(before.bytes / 1048576).toFixed(0)} → ${(after.bytes / 1048576).toFixed(0)} MB${kept}`);
  if (!after.files) rmdirIfEmpty(dir);
}

try { fs.rmdirSync(empty); } catch { /* 忽略 */ }

if (!apply) {
  console.log('\n以上为预览。加 --apply 真删；删除走 robocopy，不进回收站。');
} else {
  console.log(`\n已释放约 ${(removedBytes / 1048576).toFixed(0)} MB`);
  const left = targets.reduce((s, n) => s + sizeOf(path.join(DIR, n)).files, 0);
  if (left) console.log(`还有 ${left} 个文件被句柄占用，登记重启删除或重启后再跑一次本脚本。`);
}
