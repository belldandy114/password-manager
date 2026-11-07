/**
 * apply-unpacked.js — 把一份 win-unpacked 覆盖到目标目录
 *
 * 为什么不用「先删再复制」：
 * 这台机器上 `resources/app.asar` 一旦生成就删不掉也改不了名（unlink / rename 都是 EBUSY，
 * ACL 和句柄都查过，删不掉的原因是文件带删除保护）。electron-builder 打包第一步就是清空
 * 输出目录，于是每次都失败 —— 这就是历史上 release、release-1.21.2、release-1.21.2b/c、
 * release-build、latest 一路堆下来的真正原因。
 *
 * 绕法：asar 的格式是「4 字节头长度 + JSON 头 + 文件体」，读取方只看头部声明的范围，
 * 尾部多出来的字节会被忽略。所以可以直接在**原文件上按字节覆盖**，不需要 unlink。
 *
 * 用法：
 *   const { applyUnpacked } = require('./lib/apply-unpacked');
 *   const result = applyUnpacked(stageWinUnpacked, targetWinUnpacked);
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** robocopy 退出码 0-7 是成功（含「有文件被跳过」），>=8 才是失败 */
function robocopy(src, dest) {
  try {
    execFileSync('robocopy', [src, dest, '/MIR', '/NFL', '/NDL', '/NJH', '/NP', '/R:2', '/W:1'], {
      stdio: 'ignore',
    });
    return { code: 0 };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 99 };
  }
}

/** 就地覆盖（不 unlink）：先写内容，再尽量截断；截断失败也无所谓，asar 会忽略尾部 */
function overwriteInPlace(src, dest) {
  const srcSize = fs.statSync(src).size;
  const buf = fs.readFileSync(src);
  let fd;
  try {
    fd = fs.openSync(dest, 'r+');
  } catch {
    // 连写都写不进去：退化成整文件覆盖（新文件不存在时可用）
    fs.writeFileSync(dest, buf);
    return 'rewritten';
  }
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    try {
      fs.ftruncateSync(fd, srcSize);
    } catch {
      /* 截断被拒：尾部残留字节对 asar 无害 */
    }
    return 'in-place';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} src  stage 里的 win-unpacked
 * @param {string} dest 目标 win-unpacked
 */
function applyUnpacked(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`源目录不存在：${src}`);
  fs.mkdirSync(dest, { recursive: true });

  const { code } = robocopy(src, dest);

  // robocopy 跳过的文件（被锁的 asar）逐个就地覆盖
  const patched = [];
  const asarDir = path.join('resources');
  for (const name of ['app.asar', 'default_app.asar']) {
    const from = path.join(src, asarDir, name);
    const to = path.join(dest, asarDir, name);
    if (!fs.existsSync(from)) continue;
    const same =
      fs.existsSync(to) &&
      fs.statSync(to).size === fs.statSync(from).size &&
      fs.readFileSync(to).equals(fs.readFileSync(from));
    if (same) continue;
    patched.push(`${name}:${overwriteInPlace(from, to)}`);
  }

  return { robocopyCode: code, patched };
}

module.exports = { applyUnpacked };

// 直接执行：node scripts/lib/apply-unpacked.js <src> <dest>
if (require.main === module) {
  const [, , src, dest] = process.argv;
  if (!src || !dest) {
    console.error('用法: node scripts/lib/apply-unpacked.js <stage/win-unpacked> <target/win-unpacked>');
    process.exit(1);
  }
  const r = applyUnpacked(path.resolve(src), path.resolve(dest));
  console.log(`robocopy exit=${r.robocopyCode}${r.robocopyCode >= 8 ? '（有文件被跳过，已就地覆盖）' : ''}`);
  if (r.patched.length) console.log('就地覆盖:', r.patched.join(', '));
  else console.log('asar 无需覆盖');
}
