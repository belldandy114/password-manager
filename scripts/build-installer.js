/**
 * build-installer.js — 全自动构建安装包
 * 1. 质量门禁（ci-gate：隐私 / 类型 / 单测 / IPC 契约 / CSS 报告）
 * 2. 结束残留进程（t72：见「为什么必须结束残留进程」）
 * 3. 清理编译产物
 * 4. 构建 renderer
 * 5. 打包到系统临时目录，再就地覆盖回 <OUT_DIR>/win-unpacked
 * 6. 生成 NSIS 安装程序（并把 latest.yml 一起搬到 <OUT_DIR>）
 * 7. 完整性级别自检
 *
 * 为什么不再「清空输出目录后直接打包」：
 * 这台机器上 `resources/app.asar` 一旦生成就删不掉也改不了名（unlink / rename 都是 EBUSY），
 * electron-builder --dir 的第一步是清空输出目录，于是必然失败 —— 历史上只能换 PM_RELEASE_DIR
 * 重来，堆出 release-1.21.2b / c / build / latest 一堆目录。
 * 现在改成「打到全新的临时目录 + robocopy 就地覆盖」，不需要删任何被锁的文件。
 *
 * ## 为什么必须结束残留进程 + 判 robocopy 失败 + 验 FileVersion（t72，1.33.0 事故）
 *
 * 1.33.0 第一次构建：`ui-startup-test.js` 跑完**留下 4 个 `测试中台.exe` 进程** →
 * robocopy **跳过被占用的 exe**（exit=9，失败位 8）→ 脚本只打印不判失败 →
 * `Setup 1.33.0` 里的主程序其实是 **1.32.2**。**所有检查都是绿的，包却是混合版本。**
 *
 * 三道闸现在都补上了，而且**盯结果不盯过程**：
 *   - 打包前结束残留进程（并打印结束了几个）——根治「文件被占用」；
 *   - robocopy exit ≥ 8 直接失败并打印失败位——过程失败不再被吞；
 *   - **`win-unpacked\<产品名>.exe` 的 FileVersion 必须 == package.json 的 version** ——
 *     这条是根本：就算将来换成别的复制方式，只要产物版本不对就当场失败。
 */
const { execSync, execFileSync, spawnSync } = require('child_process');
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

const readPkg = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const Pkg = readPkg();
const PRODUCT_NAME = (Pkg.build && Pkg.build.productName) || Pkg.productName || '测试中台';
const MAIN_EXE = `${PRODUCT_NAME}.exe`;

// ---------------------------------------------------------------------------
// 0. 进程与产物的三道闸（可单独 require 做自测，见 scripts/lib 不用，直接 require 本文件）
// ---------------------------------------------------------------------------

/** 同步 sleep（不能 await：后面的构建流程全是同步的，且不能阻塞太久） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 列出正在运行的主程序 pid。
 * 用 `tasklist` + CSV 而不是 PowerShell `Get-Process -Name`：产品名是中文，
 * 走 -Command 传参会撞上控制台编码；作为**参数**传给 tasklist 则是 UTF-16，稳。
 * @returns {string[]} pid 列表（空数组 = 没有在跑）
 */
function listResidualPids() {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${MAIN_EXE}`, '/FO', 'CSV', '/NH'], {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 30000,
  });
  const out = r && r.stdout ? r.stdout.toString('utf8') : '';
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"')) // 每个在跑的实例一行 CSV；"信息: 没有..." 之类不会以引号开头
    .map((l) => (l.split('","')[1] || '').replace(/"/g, ''))
    .filter((pid) => /^\d+$/.test(pid));
}

/**
 * 结束残留的主程序进程。
 *
 * 不结束的后果（1.33.0 事故）：exe 被占用 → robocopy 跳过它 → **产物是上一版**，
 * 而脚本、门禁、NSIS 全都「成功」。所以这里是**构建的前置条件**，不是可选的清理。
 *
 * @param {string} label 日志里用来说明「在哪一步之前清的」
 * @returns {number} 结束的进程数（0 = 本来就没有残留）
 */
function killResidual(label) {
  const pids = listResidualPids();
  if (pids.length === 0) {
    console.log(`${GREEN}✓ 无残留进程（${MAIN_EXE}）${RESET}`);
    return 0;
  }
  console.log(`${YELLOW}⚠ ${label}：发现 ${pids.length} 个残留进程（pid=${pids.join(',')}），强制结束${RESET}`);
  for (const pid of pids) {
    spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
  }
  // 等句柄真正释放：进程退了但文件锁可能还差几十毫秒（尤其是刚启动的实例）
  const deadline = Date.now() + 15000;
  let left = listResidualPids();
  while (left.length > 0 && Date.now() < deadline) {
    sleepSync(300);
    left = listResidualPids();
  }
  if (left.length > 0) {
    throw new Error(`残留进程杀不掉（还剩 pid=${left.join(',')}）：请手动结束 ${MAIN_EXE} 后重试`);
  }
  console.log(`${GREEN}✓ 已结束 ${pids.length} 个残留进程${RESET}`);
  return pids.length;
}

/**
 * robocopy 退出码判据：**≥ 8 是失败**（位 8 = 有文件复制失败，位 16 = 致命）。
 * 低于 8 的位（1 复制成功 / 2 目标多余 / 4 不一致）都是正常覆盖行为。
 *
 * 判据放这里而不是 apply-unpacked 里：那边是把退出码**报**出来，这边是决定**要不要停**。
 * @param {number} code robocopy 退出码
 * @returns {{ ok: boolean, message: string }}
 */
function checkRobocopy(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n < 8) {
    return { ok: true, message: `robocopy exit=${n}（< 8，属正常覆盖：1/2/4 位是正常位）` };
  }
  const bits = [];
  if (n & 1) bits.push('有文件已复制');
  if (n & 2) bits.push('目标目录有多余文件');
  if (n & 4) bits.push('存在不一致文件');
  if (n & 8) bits.push('**有文件复制失败**（通常是被占用）');
  if (n & 16) bits.push('**致命错误**');
  if (!(n & 24)) bits.push('未知失败位');
  return {
    ok: false,
    message: `robocopy exit=${n}（≥ 8 判失败）—— ${bits.join('；')}。产物很可能是**上一版**，绝不能继续打安装包。`,
  };
}

/**
 * 读 exe 的 FileVersion（Windows 资源里的版本号）。
 * 用 `$env:PM_EXE` 传路径：产品名与路径都是中文，直接拼进 -Command 会被控制台编码搞坏。
 * @param {string} exePath
 * @returns {string} 形如 `1.33.0` / `1.33.0.0`；读不到返回空串
 */
function readFileVersion(exePath) {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:PM_EXE).VersionInfo.FileVersion'],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PM_EXE: exePath } }
  );
  if (!r || r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

/** 把 `1.33.0` 与 `1.33.0.0` 视作同一版本（Windows 常补一个 .0） */
function sameVersion(a, b) {
  const norm = (v) => String(v || '').trim().split('.').filter((x) => x !== '').map((x) => Number(x) || 0);
  const A = norm(a);
  const B = norm(b);
  if (!A.length || !B.length) return false;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i += 1) {
    if ((A[i] || 0) !== (B[i] || 0)) return false;
  }
  return true;
}

/**
 * **结果断言**：覆盖到输出目录后，主程序的 FileVersion 必须等于 package.json 的 version。
 *
 * 这条是三道闸里最关键的一道：robocopy 退出码是「过程」，FileVersion 是「结果」。
 * 1.33.0 那次事故里过程被判绿、结果却是 1.32.2；只要有了这条断言，无论复制方式怎么变都跑不掉。
 *
 * @param {string} exePath 产物主程序路径
 * @param {string} expected package.json 的 version
 * @throws {Error} 读不到版本或版本不一致
 */
function assertFileVersion(exePath, expected) {
  if (!fs.existsSync(exePath)) throw new Error(`产物不存在：${exePath}`);
  const actual = readFileVersion(exePath);
  if (!actual) throw new Error(`读不到 FileVersion：${exePath}（可能被占用或文件损坏）`);
  if (!sameVersion(actual, expected)) {
    throw new Error(
      `产物版本不对：${MAIN_EXE} 的 FileVersion=${actual}，而 package.json version=${expected}。\n` +
        '  这几乎一定是「exe 被占用 → 复制被跳过 → 包内还是上一版」（1.33.0 事故）。\n' +
        '  处理：结束残留进程后重跑（本脚本会在打包前自动尝试结束并报告数量）。'
    );
  }
  return actual;
}

/**
 * 把 latest.yml 也搬到输出目录。
 *
 * 以前只搬 `Setup x.y.z.exe`，latest.yml 一直停在 1.21.2 —— 谁看它都会以为当前版本是 1.21.2。
 * 虽然应用内更新**不读** latest.yml（读 GitHub 的 `releases/latest`），但它会随 Release 一起发布，
 * 留着旧版本号就是误导。缺失直接失败：静默跳过等于把这个坑留着。
 * @param {string} fromDir electron-builder 的 nsis 输出目录
 * @param {string} toDir 目标（release）
 */
function copyLatestYml(fromDir, toDir) {
  const from = path.join(fromDir, 'latest.yml');
  if (!fs.existsSync(from)) {
    throw new Error(`nsis 输出里没有 latest.yml：${from}（安装包已生成但不完整，不能发布）`);
  }
  const to = path.join(toDir, 'latest.yml');
  fs.copyFileSync(from, to);
  return to;
}

// ---------------------------------------------------------------------------

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

/**
 * 清空目录。
 *
 * ⚠️ 默认「删不掉就跳过」只适用于**临时目录**（偶尔被索引器/杀软咬住，覆盖写就行）。
 * `dist` 不能用这个策略：它一旦没清干净，旧构建产物会**原样打进安装包**。
 * 2026-11-21 实测过一次——`vite build` 的 emptyOutDir 在这台机器上没生效（Vite 8），
 * dist 累积到 860 个文件 / 46.2 MB，asar 从 43.2 MB 涨到 86.6 MB。
 * 所以 dist 传 strict:true，清不掉直接中止构建，不产出脏包。
 *
 * @param {string} p 目录
 * @param {string} label 日志名
 * @param {{strict?: boolean}} [opts] strict=true 时清理失败即 exit 1
 */
function cleanDir(p, label, opts = {}) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`${GREEN}✓ 清理 ${label}${RESET}`);
  } catch (e) {
    if (opts.strict) {
      console.error(`${RED}✗ ${label} 清理失败，中止构建：${e.message}${RESET}`);
      console.error('  继续打会把旧产物原样打进安装包（历史事故：dist 累积 860 个文件 / 46 MB 全进了 asar）。');
      console.error('  先把占用它的进程（electron / 编辑器索引）关掉再重试。');
      process.exit(1);
    }
    console.log(`${YELLOW}⚠ ${label} 清理失败，继续（会被覆盖写）${RESET}`);
  }
}

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

function main() {
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
  console.log(`${CYAN}  ${PRODUCT_NAME} - 自动化构建${RESET}`);

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

  // 1. 结束残留进程（t72）。
  //    必须在**任何**复制/清理之前：exe 被占用时 robocopy 会跳过它，产物就是上一版。
  //    跳过：SKIP_KILL_RESIDUAL=1 只用于「反向验证」（故意留进程看构建会不会失败）。
  try {
    if (process.env.SKIP_KILL_RESIDUAL === '1') {
      console.log(`${YELLOW}⚠ SKIP_KILL_RESIDUAL=1，跳过结束残留进程（反向验证用）${RESET}`);
    } else {
      killResidual('打包前');
    }
  } catch (e) {
    console.error(`${RED}✗ 残留进程处理失败：${e.message}${RESET}`);
    process.exit(1);
  }

  // 2. 清理编译产物。
  //    注意：**不能删 OUT_DIR**，里面的 resources/app.asar 被系统句柄占住（EBUSY），
  //    删它会直接让整个构建挂掉 —— 这是历史上目录越堆越多的根因。
  cleanDir(path.join(ROOT, 'dist'), 'dist', { strict: true });
  cleanDir(path.join(ROOT, 'node_modules', '.cache'), 'node_modules/.cache');
  cleanDir(STAGE_ROOT, '打包临时目录');
  cleanDir(NSIS_OUT, '安装包临时目录');

  // 3. Build renderer
  step('构建 Renderer (Vite)', 'npx vite build');

  // 4. Pack Electron app 到临时目录
  patchElectronDist('add');
  try {
    step('打包 Electron 应用', `npx electron-builder --dir --publish never -c.directories.output="${STAGE_ROOT.replace(/\\/g, '/')}"`);

    if (!fs.existsSync(path.join(STAGE, MAIN_EXE))) {
      throw new Error(`临时产物里没有 ${MAIN_EXE}，打包未完成`);
    }

    console.log(`\n${CYAN}▶ 覆盖到 ${OUT_DIR_NAME}/win-unpacked${RESET}`);
    const r = applyUnpacked(STAGE, path.join(OUT_DIR, 'win-unpacked'));
    // t72：robocopy 退出码 ≥8 判致命（1.33.0 事故的直接成因就是「只打印不判失败」）
    const rc = checkRobocopy(r.robocopyCode);
    if (!rc.ok) throw new Error(rc.message);
    console.log(`  ${rc.message}`);
    console.log(r.patched.length ? `  asar 就地覆盖: ${r.patched.join(', ')}` : '  asar 无需覆盖');
    console.log(`${GREEN}✓ 覆盖完成${RESET}`);
  } catch (e) {
    console.error(`${RED}✗ 打包失败: ${e.message}${RESET}`);
    patchElectronDist('remove');
    process.exit(1);
  }

  // 4.1 结果断言：产物主程序的 FileVersion 必须等于 package.json 的 version（t72，最关键的一道）
  console.log(`\n${CYAN}▶ 产物版本断言${RESET}`);
  try {
    const exePath = path.join(OUT_DIR, 'win-unpacked', MAIN_EXE);
    const v = assertFileVersion(exePath, Pkg.version);
    console.log(`${GREEN}✓ ${MAIN_EXE} FileVersion=${v} == package.json version=${Pkg.version}${RESET}`);
  } catch (e) {
    console.error(`${RED}✗ 产物版本断言失败：${e.message}${RESET}`);
    patchElectronDist('remove');
    process.exit(1);
  }

  // 4.2 打包产物自检：防「asar 里是旧 CSS」「又混进废弃的子应用产物」这两类历史事故
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
    // 1.24.2 起测试数据生成器是主应用里的 React 页面，dist-tdg 不再进包。
    // 这里反向断言：一旦哪天又把旧子应用产物打回来，构建当场失败。
    if (entries.some(p => p.includes('dist-tdg/'))) throw new Error('asar 里仍含已废弃的 dist-tdg');
    console.log(`${GREEN}✓ CSS hash 一致 / 无废弃子应用产物${RESET}`);
  } catch (e) {
    console.error(`${RED}✗ 打包产物自检失败: ${e.message}${RESET}`);
    patchElectronDist('remove');
    process.exit(1);
  }

  // 4.3 打包版端到端冒烟：真实 IPC 走一遍核心流程（解锁 → 增删改查 → 回收站 → 设置 → 锁定）。
  //     CI 与本地共用这一步；排查构建问题时可用 SKIP_SMOKE=1 跳过（正式发版不要跳）。
  if (process.env.SKIP_SMOKE === '1') {
    console.log(`\n${CYAN}▶ 打包版冒烟（SKIP_SMOKE=1，已跳过）${RESET}`);
  } else {
    console.log(`\n${CYAN}▶ 打包版冒烟${RESET}`);
    const smoke = spawnSync(process.execPath, [
      path.join(__dirname, 'smoke-test.js'),
      path.join(OUT_DIR, 'win-unpacked'),
    ], { cwd: ROOT, stdio: 'inherit' });
    if (smoke.status !== 0) {
      console.error(`${RED}✗ 打包版冒烟失败（exit ${smoke.status}），已中止${RESET}`);
      patchElectronDist('remove');
      process.exit(smoke.status || 1);
    }
    console.log(`${GREEN}✓ 打包版冒烟通过${RESET}`);
    // 冒烟会真的把应用拉起来；不结束的话，下一步 NSIS 打包会读到被占用的文件
    try {
      if (process.env.SKIP_KILL_RESIDUAL !== '1') killResidual('冒烟后');
    } catch (e) {
      console.error(`${RED}✗ 冒烟后残留进程处理失败：${e.message}${RESET}`);
      patchElectronDist('remove');
      process.exit(1);
    }
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
  const pkgAfter = readPkg();
  const builtInstallerName = `${PRODUCT_NAME} Setup ${pkgAfter.version}.exe`;
  const builtInstaller = path.join(NSIS_OUT, builtInstallerName);
  if (!fs.existsSync(builtInstaller)) {
    console.error(`${RED}✗ 临时目录里没有安装包：${builtInstaller}${RESET}`);
    patchElectronDist('remove');
    process.exit(1);
  }
  fs.copyFileSync(builtInstaller, path.join(OUT_DIR, builtInstallerName));
  console.log(`${GREEN}✓ 安装包已就位：${OUT_DIR_NAME}/${builtInstallerName}${RESET}`);

  // 5.2 latest.yml 一起搬（t72：以前只搬 .exe，latest.yml 停在 1.21.2 误导人）
  try {
    const yml = copyLatestYml(NSIS_OUT, OUT_DIR);
    console.log(`${GREEN}✓ latest.yml 已同步：${OUT_DIR_NAME}/${path.basename(yml)}${RESET}`);
  } catch (e) {
    console.error(`${RED}✗ latest.yml 搬运失败：${e.message}${RESET}`);
    patchElectronDist('remove');
    process.exit(1);
  }

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
  const pkg = readPkg();
  const installerName = `${PRODUCT_NAME} Setup ${pkg.version}.exe`;
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
}

if (require.main === module) {
  main();
}

// 导出给自测脚本用（require 本文件不会触发构建）
module.exports = {
  MAIN_EXE,
  PRODUCT_NAME,
  listResidualPids,
  killResidual,
  checkRobocopy,
  readFileVersion,
  sameVersion,
  assertFileVersion,
  copyLatestYml,
};