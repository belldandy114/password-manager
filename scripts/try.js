/**
 * try.js —— 把构建产物复制到 run/ 再启动
 *
 * 为什么要多这一步：
 * Windows 上只要运行过 `release\win-unpacked\测试中台.exe`，那个目录里的
 * app.asar 就会被句柄占住（进程退出后还会被 Defender/索引器再咬一会儿）。
 * 而 electron-builder 打包的第一步就是清空输出目录 → 直接 EBUSY 失败。
 * 结果就是「打包 → 运行验证 → 不能再打包」，只能换个目录名重来（目录越堆越多）。
 *
 * 把「运行」和「构建输出」分开：构建永远输出到 release/，运行永远在 run/，
 * 两边互不影响，可以反复 npm run dist。
 *
 * 环境变量：
 *   PM_RELEASE_DIR  源构建目录（默认 release）
 *   PM_NO_LAUNCH=1  只复制不启动（自动化验证用）
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR_NAME = process.env.PM_RELEASE_DIR || 'release';
const SRC = path.join(ROOT, OUT_DIR_NAME, 'win-unpacked');
const RUN = path.join(ROOT, 'run');
const EXE = '测试中台.exe';

/** robocopy 的退出码 0-7 都算成功，>=8 才是真失败 */
function mirror(from, to, label) {
  if (process.platform === 'win32') {
    try {
      execFileSync('robocopy', [from, to, '/MIR', '/NFL', '/NDL', '/NJH', '/NP'], { stdio: 'inherit' });
    } catch (e) {
      if (typeof e.status === 'number' && e.status >= 8) {
        console.error(`${label}失败（robocopy exit=${e.status}）`);
        process.exit(1);
      }
    }
  } else {
    fs.cpSync(from, to, { recursive: true });
  }
}

if (!fs.existsSync(path.join(SRC, EXE))) {
  console.error(`找不到 ${OUT_DIR_NAME}\\win-unpacked\\${EXE}，先跑 npm run dist`);
  process.exit(1);
}

if (fs.existsSync(RUN)) {
  try {
    fs.rmSync(RUN, { recursive: true, force: true });
  } catch {
    // 有残留句柄时整目录删不掉（退出后的 exe / Defender 扫描），
    // 不该因此直接罢工：/MIR 会就地补齐，实在删不掉的旧文件留着也不影响启动。
    console.warn('⚠ run/ 有文件被占用，改为就地镜像覆盖');
  }
}

console.log('复制构建产物到 run/ …');
mirror(SRC, RUN, '复制');

if (process.env.PM_NO_LAUNCH === '1') {
  console.log('已准备好 run/，按 PM_NO_LAUNCH 跳过启动');
  process.exit(0);
}

const exe = path.join(RUN, EXE);
console.log('启动:', exe);
spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
console.log('已启动（关闭窗口不影响本命令）');
